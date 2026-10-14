import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { gameText } from "../site/catalog.js";
import { decodePNG, dominantColorShare } from "./png.mjs";
import { createPreviewServer, listen } from "./preview-server.mjs";

// Generic lifecycle smoke test for every catalog game; it cannot verify gameplay.
// Default: local games/ sources (use before publishing a contract upgrade).
// --remote: the production build against the live R2 catalog, proxied locally because
// R2 CORS only admits the public site origins. Leaves dist/ as the production artifact.
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--remote")) throw new Error("Usage: node scripts/smoke.mjs [--remote]");
const remote = args.includes("--remote");
const root = fileURLToPath(new URL("../", import.meta.url));
const dist = resolve(root, "dist");
const viewports = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 800 } },
};

execFileSync("npm", ["run", "--silent", remote ? "build:production" : "build"], {
  cwd: root, stdio: "inherit",
  env: { ...process.env, FUNDEV_NO_SW: "1", ...(remote ? {} : { FUNDEV_GAME_ORIGIN: "", FUNDEV_TRANSFER: "" }) },
});
const origin = JSON.parse((await readFile(resolve(dist, "game-source.js"), "utf8")).match(/gameOrigin = (".*");/)[1]);
if (remote !== Boolean(origin)) throw new Error("Unexpected game origin in the build.");
const server = createPreviewServer({ root: dist });
const { port } = await listen(server, 0, "127.0.0.1");
const base = `http://127.0.0.1:${port}`;

const cache = new Map();
async function proxy(route) {
  const url = route.request().url();
  if (!cache.has(url)) {
    const response = await fetch(url, { redirect: "error" });
    cache.set(url, { status: response.status, contentType: response.headers.get("content-type") || "application/octet-stream", body: Buffer.from(await response.arrayBuffer()) });
  }
  const { status, contentType, body } = cache.get(url);
  await route.fulfill({ status, body, headers: { "content-type": contentType, "access-control-allow-origin": base } });
}

const games = remote
  ? await (await fetch(`${origin}/games.json`, { cache: "no-store" })).json()
  : JSON.parse(await readFile(resolve(dist, "games.json"), "utf8"));
const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const failures = [];
await mkdir(resolve(root, "test-results"), { recursive: true });

async function check(game, name) {
  const context = await browser.newContext({ ...viewports[name], locale: "en-US" });
  if (remote) await context.route(`${origin}/**`, proxy);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("dialog", (dialog) => { errors.push(`Unexpected dialog: ${dialog.message()}`); void dialog.dismiss(); });
  const press = (selector) => name === "mobile" ? page.locator(selector).tap() : page.locator(selector).click();
  async function openMenu() {
    if (await page.locator("#menu-toggle").isVisible()) await press("#menu-toggle");
  }
  async function running(step) {
    const state = await page.waitForFunction(() => {
      if (!document.querySelector("#error-back").hidden) return "error";
      return document.querySelector("#player-message").hidden && document.querySelector(".game-surface canvas") ? "running" : false;
    }).then((handle) => handle.jsonValue());
    if (state !== "running") throw new Error(`${step}: ${await page.locator("#player-status").textContent()}`);
  }
  try {
    await page.goto(`${base}/play/?game=${encodeURIComponent(game.id)}&lang=en`);
    await running("open");

    await page.waitForTimeout(500);
    const share = dominantColorShare(decodePNG(await page.locator(".game-surface canvas").screenshot()));
    if (share > 0.98) throw new Error(`canvas looks blank (${(share * 100).toFixed(1)}% one colour)`);

    await openMenu();
    for (const locale of ["zh", "en"]) {
      await page.locator("#language-toggle").selectOption(locale);
      await page.waitForFunction((title) => document.querySelector("#game-title").textContent === title, gameText(game.title, locale));
    }
    if (await page.locator("#controls-dialog").evaluate((dialog) => dialog.open)) await press("#close-controls");
    await running("language switch");

    await openMenu();
    await press("#pause");
    await page.locator("#resume").waitFor({ state: "visible" });
    await press("#resume");
    await running("resume");

    const before = await page.locator(".game-surface canvas").elementHandle();
    await openMenu();
    await press("#restart");
    await page.waitForFunction((canvas) => !canvas.isConnected, before);
    await running("restart");

    await page.goto(`${base}/games/`);
    await page.waitForTimeout(300);
    if (errors.length) throw new Error(`console errors:\n    ${errors.join("\n    ")}`);
  } catch (error) {
    await page.screenshot({ path: resolve(root, `test-results/smoke-${game.id}-${name}.png`) }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}

try {
  for (const game of games) {
    for (const name of Object.keys(viewports)) {
      try {
        await check(game, name);
        console.log(`ok   ${game.id}@${game.version} ${name}`);
      } catch (error) {
        failures.push(game.id);
        console.error(`FAIL ${game.id}@${game.version} ${name}: ${error.message}`);
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`${remote ? `Remote catalog ${origin}` : "Local games/"}: ${games.length} games, ${failures.length} failed checks.`);
if (failures.length) process.exitCode = 1;
