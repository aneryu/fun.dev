import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { API_VERSION } from "../site/catalog.js";
import { dist, launch, proxy, root, serve } from "./browser/harness.mjs";
import { liveCheck } from "./browser/live.mjs";
import { smoke } from "./browser/smoke.mjs";
import { publishRelease } from "./game-release.mjs";
import { createWranglerStore } from "./r2-wrangler-store.mjs";
import { loadLocalGames } from "./local-games.mjs";

// One-command release: npm run release [-- --yes] | [-- --check]
// Reads the live state, prints a plan, then (after confirmation) runs it in a safe order:
// verify → D1 migrations → cleanup Worker → changed games → production build + smoke
// against the live catalog → Pages deploy → checks on fun.dev → git push.
const SITE = "https://fun.dev";
const GAME_ORIGIN = "https://games.fun.dev";
const PROJECT = "fundev";
const args = process.argv.slice(2);
if (args.some((arg) => !["--yes", "--check"].includes(arg))) {
  console.error("Usage: npm run release [-- --yes]   or   npm run release -- --check");
  process.exit(1);
}
const wranglerEnv = { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", WRANGLER_SEND_METRICS: "false", CI: "true" };
const wrangler = (...parameters) => spawnSync(process.execPath, [resolve(root, "node_modules/wrangler/bin/wrangler.js"), ...parameters], { cwd: root, env: wranglerEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const git = (...parameters) => execFileSync("git", parameters, { cwd: root, encoding: "utf8" }).trim();
const fail = (message) => { console.error(`\n✗ ${message}`); process.exit(1); };
function must(result, what) {
  if (result.status !== 0) fail(`${what} failed:\n${(result.stderr || result.stdout || "").trim().split("\n").slice(-8).join("\n")}`);
  return result.stdout;
}
const catalogNow = async () => (await (await fetch(`${GAME_ORIGIN}/games.json`, { cache: "no-store" })).json());

if (args.includes("--check")) {
  const browser = await launch();
  try { await liveCheck({ browser, site: SITE, games: (await catalogNow()).filter((game) => game.apiVersion === API_VERSION) }); }
  finally { await browser.close(); }
  console.log("\n✓ fun.dev passes the live checks.");
  process.exit(0);
}

// ── Plan (read-only) ─────────────────────────────────────────────────────────
if (git("status", "--porcelain")) fail("Commit or stash your changes first: a release deploys exactly one commit.");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") fail(`Releases ship the main branch (current: ${branch}). Merge into main first.`);
const head = git("rev-parse", "HEAD");
console.log("Reading the live state…");

const deployments = JSON.parse(must(wrangler("pages", "deployment", "list", "--project-name", PROJECT, "--environment", "production", "--json"), "Listing Pages deployments"));
const deployed = deployments[0]?.Source;
const known = deployed && spawnSync("git", ["cat-file", "-e", `${deployed}^{commit}`], { cwd: root }).status === 0;
const changed = known ? git("diff", "--name-only", deployed, head).split("\n").filter(Boolean) : null;
const touches = (pattern) => !changed || changed.some((file) => pattern.test(file));
const siteChanged = touches(/^(?:site|skills|functions|server|migrations)\/|^scripts\/(?:build|check|csp|share-pages|local-games|game-release)\.mjs$|^package(?:-lock)?\.json$|^wrangler\.jsonc$/);
const transferChanged = touches(/^(?:site\/progress|site\/play|server|functions|migrations)\//);

const migrations = must(wrangler("d1", "migrations", "list", "DB", "--remote", "--env", "production", "--env-file", "/dev/null"), "Listing D1 migrations");
const pendingMigrations = !/No migrations to apply/i.test(migrations);
const workerMissing = /does not exist/i.test(wrangler("deployments", "list", "--config", "wrangler.cleanup.jsonc", "--env", "production", "--env-file", "/dev/null").stderr ?? "");
const workerChanged = workerMissing || touches(/^server\/|^wrangler\.cleanup\.jsonc$/);

const remoteCatalog = await catalogNow();
const local = await loadLocalGames();
const publish = local.filter(({ game }) => remoteCatalog.find((entry) => entry.id === game.id)?.release !== game.release);
const remoteOnly = remoteCatalog.filter((entry) => !local.some(({ game }) => game.id === entry.id));
const apiChange = publish.some(({ game }) => remoteCatalog.find((entry) => entry.id === game.id)?.apiVersion !== game.apiVersion && remoteCatalog.some((entry) => entry.id === game.id));
const deploySite = siteChanged || publish.length > 0; // new releases also refresh the share pages

console.log(`
Release plan for ${head.slice(0, 7)} (live site: ${deployed ?? "unknown"})
  1. verify locally            unit tests + browser checks${transferChanged ? " + account transfer" : ""}
  2. D1 migrations             ${pendingMigrations ? "apply pending migrations" : "none pending"}
  3. cleanup Worker            ${workerChanged ? (workerMissing ? "deploy (not deployed yet)" : "redeploy (server code changed)") : "unchanged"}
  4. games                     ${publish.length ? publish.map(({ game }) => `publish ${game.id}@${game.version}`).join(", ") : "no changes"}
  5. production build + smoke  against the live catalog
  6. website                   ${deploySite ? `deploy to Pages (${changed ? `${changed.length} files changed` : "first tracked release"})` : "unchanged, skip deploy"}
  7. live checks on ${SITE}, then git push`);
if (remoteOnly.length) console.log(`  note: in the live catalog but not in games/: ${remoteOnly.map((game) => game.id).join(", ")} (left untouched; npm run game:remove -- <id>)`);
if (apiChange) console.log(`  note: games change API version: the live lobby cannot read the catalog from step 4 until step 6 (a few minutes).`);
if (!publish.length && !deploySite && !workerChanged && !pendingMigrations) {
  console.log("\nNothing to release. Run npm run release -- --check to re-check fun.dev.");
  process.exit(0);
}
if (!args.includes("--yes")) {
  if (!process.stdin.isTTY) fail("Confirm interactively, or pass --yes.");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question("\nProceed? [y/N] ");
  prompt.close();
  if (!/^y(es)?$/i.test(answer.trim())) fail("Cancelled; nothing changed.");
}

// ── Execute ──────────────────────────────────────────────────────────────────
const step = (title) => console.log(`\n▶ ${title}`);
step("Verify locally");
if (spawnSync(process.execPath, ["scripts/verify.mjs", ...(transferChanged ? ["--transfer"] : [])], { cwd: root, stdio: "inherit" }).status !== 0) fail("Local verification failed; nothing was changed remotely.");

if (pendingMigrations) {
  step("Apply D1 migrations");
  console.log(must(wrangler("d1", "migrations", "apply", "DB", "--remote", "--env", "production", "--env-file", "/dev/null"), "Applying D1 migrations").trim().split("\n").slice(-3).join("\n"));
}
if (workerChanged) {
  step("Deploy cleanup Worker");
  console.log(must(wrangler("deploy", "--config", "wrangler.cleanup.jsonc", "--env", "production", "--env-file", "/dev/null"), "Deploying the cleanup Worker").split("\n").filter((line) => /schedule|Deployed|Version/.test(line)).join("\n"));
}

let gameStore = null;
let previousCatalog = null;
// Before the website is deployed, any failure puts the previous game catalog back.
async function restoreCatalog() {
  if (!gameStore || !previousCatalog) return;
  const current = await gameStore.get("games.json");
  await gameStore.put("games.json", previousCatalog.body, { type: "application/json", cache: "no-store", ifMatch: current.etag });
  console.error("  Restored the previous game catalog.");
}
if (publish.length) {
  step("Publish games");
  gameStore = createWranglerStore();
  try {
    previousCatalog = await gameStore.get("games.json");
    for (const release of publish) {
      await publishRelease(gameStore, release);
      console.log(`  published ${release.game.id}@${release.game.version}`);
    }
  } catch (error) {
    await restoreCatalog().catch(() => {});
    gameStore.close();
    fail(`Publishing failed: ${error.message}`);
  }
}

step("Production build + smoke test against the live catalog");
try {
  execFileSync("npm", ["run", "--silent", "build:production"], { cwd: root, stdio: "inherit", env: { ...process.env, FUNDEV_NO_SW: "" } });
  const server = await serve();
  const browser = await launch();
  try { await smoke({ browser, base: server.base, games: (await catalogNow()).filter((game) => game.apiVersion === API_VERSION), gameOrigin: GAME_ORIGIN }); }
  finally { await browser.close(); server.close(); }
} catch (error) {
  await restoreCatalog().catch((restore) => console.error(`  Could not restore the catalog: ${restore.message}`));
  gameStore?.close();
  fail(`Production checks failed: ${error.message}`);
}

if (deploySite) {
  step("Deploy website");
  const subject = git("log", "-1", "--format=%s");
  // "production" is the Pages production environment, not a Git branch.
  const result = wrangler("pages", "deploy", "dist", "--project-name", PROJECT, "--branch", "production", "--commit-hash", head, "--commit-message", subject, "--commit-dirty=false");
  if (result.status !== 0) { await restoreCatalog().catch(() => {}); gameStore?.close(); }
  const output = must(result, "Deploying to Pages");
  console.log(`  ${output.match(/https:\/\/\S+\.pages\.dev/)?.[0] ?? "deployed"}`);
}
gameStore?.close();
gameStore = null;

step(`Live checks on ${SITE}`);
const version = (await readFile(resolve(dist, "sw.js"), "utf8")).match(/"version":"([0-9a-f]+)"/)[1];
const browser = await launch();
try { await liveCheck({ browser, site: SITE, games: (await catalogNow()).filter((game) => game.apiVersion === API_VERSION), version: deploySite ? version : null }); }
catch (error) { fail(`fun.dev failed a live check: ${error.message}. Investigate, fix forward, and release again.`); }
finally { await browser.close(); }

step("Push");
const push = spawnSync("git", ["push", "origin", "main"], { cwd: root, encoding: "utf8" });
console.log(push.status === 0 ? "  pushed main to origin" : `  push failed (release is live): ${push.stderr.trim()}`);
console.log(`\n✓ Released ${head.slice(0, 7)}.`);
