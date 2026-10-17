import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dist, launch, root, serve } from "./browser/harness.mjs";
import { kitChecks } from "./browser/kit.mjs";
import { playerChecks } from "./browser/player.mjs";
import { siteChecks } from "./browser/site.mjs";
import { smoke } from "./browser/smoke.mjs";
import { sync } from "./blobs.mjs";
import { loadLocalGames } from "./local-games.mjs";

// Everything checkable locally, with one build and one browser:
//   npm run verify                      unit tests + all browser suites
//   npm run verify -- smoke player      only the named browser suites (plus unit tests)
//   npm run verify -- --transfer        also the slower account-transfer test (wrangler pages dev)
//   npm run verify -- smoke --game=<id> smoke-test one game only (for parallel game work)
//   npm run verify -- --webgpu          browser suites on this machine's GPU, games forced to WebGPU
const args = process.argv.slice(2);
const only = args.find((arg) => arg.startsWith("--game="))?.slice("--game=".length);
const suites = { smoke: null, kit: kitChecks, player: playerChecks, site: siteChecks };
const selected = args.filter((arg) => !arg.startsWith("--"));
const webgpu = args.includes("--webgpu");
const unknown = [...selected.filter((name) => !(name in suites)), ...args.filter((arg) => arg.startsWith("--") && !["--transfer", "--webgpu"].includes(arg) && !arg.startsWith("--game="))];
if (unknown.length) {
  console.error(`Unknown: ${unknown.join(", ")}. Usage: npm run verify [-- ${Object.keys(suites).join("|")} ...] [--game=<id>] [--transfer] [--webgpu]`);
  process.exit(1);
}
const results = [];
async function step(name, task) {
  const started = Date.now();
  console.log(`\n▶ ${name}`);
  try {
    await task();
    results.push([name, "ok", Date.now() - started]);
  } catch (error) {
    results.push([name, "FAIL", Date.now() - started]);
    console.error(`  ${error.message}`);
  }
}

await step("assets match their locks", async () => {
  const { changes, problems } = await sync({ mode: "check", log: () => {} });
  if (problems.length || changes.length) throw new Error([...problems, ...changes, "Run npm run assets, then commit the locks."].join("\n  "));
});
await step("unit tests", () => {
  if (spawnSync(process.execPath, ["--test"], { cwd: root, stdio: "inherit" }).status !== 0) throw new Error("Unit tests failed.");
});
await step("local build", () => {
  // Local games/ sources; the service worker stays on for the offline check (other suites block it).
  execFileSync("npm", ["run", "--silent", "build"], { cwd: root, stdio: "inherit", env: { ...process.env, FUNDEV_GAME_ORIGIN: "", FUNDEV_TRANSFER: "", FUNDEV_NO_SW: "" } });
});
if (results.every(([, status]) => status === "ok")) {
  const server = await serve();
  const browser = await launch({ webgpu });
  try {
    const games = JSON.parse(await readFile(resolve(dist, "games.json"), "utf8")).filter((game) => !only || game.id === only);
    if (only && !games.length) results.push([`no game "${only}" in games/`, "FAIL", 0]);
    else for (const [name, run] of Object.entries(suites)) {
      if (selected.length && !selected.includes(name)) continue;
      await step(`browser: ${name}`, () => name === "smoke" ? smoke({ browser, base: server.base, games, renderer: webgpu ? "webgpu" : "" }) : run({ browser, base: server.base, dist }));
    }
  } finally {
    await browser.close();
    server.close();
  }
}
if (args.includes("--transfer")) {
  await step("browser: account transfer", () => {
    if (spawnSync(process.execPath, ["scripts/progress-browser.mjs"], { cwd: root, stdio: "inherit" }).status !== 0) throw new Error("Transfer browser test failed.");
  });
}

// Download sizes, for information only: first load (cached with the release) and lazy/ files.
const releases = await loadLocalGames().catch(() => []);
if (releases.length) {
  console.log("\nDownload sizes");
  const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
  for (const { game, assets } of releases.filter(({ game }) => !only || game.id === only)) {
    const lazy = assets.filter((asset) => /(?:^|\/)lazy\//.test(asset.path));
    const sum = (list) => list.reduce((total, asset) => total + asset.body.length, 0);
    const largest = [...assets].sort((a, b) => b.body.length - a.body.length).slice(0, 3).map((asset) => `${asset.path} ${mb(asset.body.length)}`);
    console.log(`  ${game.id.padEnd(14)} first load ${mb(sum(assets) - sum(lazy)).padStart(8)}${lazy.length ? `, lazy ${mb(sum(lazy))}` : ""}   largest: ${largest.join(", ")}`);
  }
}

console.log("\nSummary");
for (const [name, status, time] of results) console.log(`  ${status.padEnd(4)} ${name.padEnd(28)} ${(time / 1000).toFixed(1)}s`);
console.log("  Screenshots: test-results/");
if (results.some(([, status]) => status !== "ok")) process.exitCode = 1;
