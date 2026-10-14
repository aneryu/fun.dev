import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dist, launch, root, serve } from "./browser/harness.mjs";
import { kitChecks } from "./browser/kit.mjs";
import { playerChecks } from "./browser/player.mjs";
import { siteChecks } from "./browser/site.mjs";
import { smoke } from "./browser/smoke.mjs";

// Everything checkable locally, with one build and one browser:
//   npm run verify                      unit tests + all browser suites
//   npm run verify -- smoke player      only the named browser suites (plus unit tests)
//   npm run verify -- --transfer        also the slower account-transfer test (wrangler pages dev)
//   npm run verify -- smoke --game=<id> smoke-test one game only (for parallel game work)
const args = process.argv.slice(2);
const only = args.find((arg) => arg.startsWith("--game="))?.slice("--game=".length);
const suites = { smoke: null, kit: kitChecks, player: playerChecks, site: siteChecks };
const selected = args.filter((arg) => !arg.startsWith("--"));
const unknown = [...selected.filter((name) => !(name in suites)), ...args.filter((arg) => arg.startsWith("--") && arg !== "--transfer" && !arg.startsWith("--game="))];
if (unknown.length) {
  console.error(`Unknown: ${unknown.join(", ")}. Usage: npm run verify [-- ${Object.keys(suites).join("|")} ...] [--game=<id>] [--transfer]`);
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

await step("unit tests", () => {
  if (spawnSync(process.execPath, ["--test"], { cwd: root, stdio: "inherit" }).status !== 0) throw new Error("Unit tests failed.");
});
await step("local build", () => {
  // Local games/ sources; the service worker stays on for the offline check (other suites block it).
  execFileSync("npm", ["run", "--silent", "build"], { cwd: root, stdio: "inherit", env: { ...process.env, FUNDEV_GAME_ORIGIN: "", FUNDEV_TRANSFER: "", FUNDEV_NO_SW: "" } });
});
if (results.every(([, status]) => status === "ok")) {
  const server = await serve();
  const browser = await launch();
  try {
    const games = JSON.parse(await readFile(resolve(dist, "games.json"), "utf8")).filter((game) => !only || game.id === only);
    if (only && !games.length) results.push([`no game "${only}" in games/`, "FAIL", 0]);
    else for (const [name, run] of Object.entries(suites)) {
      if (selected.length && !selected.includes(name)) continue;
      await step(`browser: ${name}`, () => name === "smoke" ? smoke({ browser, base: server.base, games }) : run({ browser, base: server.base, dist }));
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

console.log("\nSummary");
for (const [name, status, time] of results) console.log(`  ${status.padEnd(4)} ${name.padEnd(28)} ${(time / 1000).toFixed(1)}s`);
console.log("  Screenshots: test-results/");
if (results.some(([, status]) => status !== "ok")) process.exitCode = 1;
