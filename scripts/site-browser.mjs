import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createPreviewServer, listen } from "./preview-server.mjs";

// Lobby covers, share pages, the 404 fallback, the web app manifest, and offline play
// through the service worker (enabled in this build, unlike the other browser tests).
const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync("npm", ["run", "--silent", "build"], { cwd: root, stdio: "inherit", env: { ...process.env, FUNDEV_GAME_ORIGIN: "", FUNDEV_TRANSFER: "", FUNDEV_NO_SW: "" } });
const server = createPreviewServer({ root: resolve(root, "dist") });
const { port } = await listen(server, 0, "127.0.0.1");
const base = `http://127.0.0.1:${port}`;
await mkdir(resolve(root, "test-results"), { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const errors = [];
function watch(page) {
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${page.url()}: ${message.text()}`); });
  return page;
}
const running = (page) => page.waitForFunction(() => document.querySelector("#player-message").hidden && document.querySelector(".game-surface canvas"));

try {
  // Lobby rows show the cover thumbnail at desktop and phone widths.
  for (const [name, viewport] of [["desktop", { width: 1280, height: 800 }], ["mobile", { width: 375, height: 740 }]]) {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    const page = watch(await context.newPage());
    await page.goto(`${base}/games/?lang=en`);
    await page.waitForFunction(() => document.querySelector(".game-cover")?.complete && document.querySelector(".game-cover").naturalWidth > 0);
    await page.screenshot({ path: resolve(root, `test-results/lobby-${name}.png`) });
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  // Share pages: crawler-visible tags, then straight into the player.
  const html = await (await fetch(`${base}/s/cyber-muyu/en/`)).text();
  assert.match(html, /<meta property="og:title" content="Wooden Fish">/);
  assert.match(html, /<meta property="og:image" content="[^"]+\/games\/cyber-muyu\/[\d.]+\/assets\/cover\.jpg">/);
  const share = watch(await context.newPage());
  await share.goto(`${base}/s/cyber-muyu/en/`);
  await share.waitForURL(/\/play\/\?game=cyber-muyu&lang=en$/);
  await running(share);
  await share.close();

  // A share link without a generated page (e.g. a newer game) is forwarded by the 404 page.
  const missing = watch(await context.newPage());
  const response = await missing.goto(`${base}/s/not-built-yet/`);
  assert.equal(response.status(), 404);
  await missing.waitForURL(/\/play\/\?game=not-built-yet&lang=zh$/);
  await missing.waitForFunction(() => document.querySelector("#player-status").textContent.includes("游戏不存在"));
  const unknown = await fetch(`${base}/no-such-page`);
  assert.equal(unknown.status, 404);
  assert.match(await unknown.text(), /Nothing here/);
  await context.close();

  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifest.headers.get("content-type"), "application/manifest+json");
  const app = await manifest.json();
  assert.equal(app.display, "standalone");
  for (const icon of app.icons) assert.equal((await fetch(new URL(icon.src, base))).status, 200, icon.src);

  // Offline: open the lobby and a game online, then reload both without a network.
  const pwa = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = watch(await pwa.newPage());
  await page.goto(`${base}/games/?lang=en`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.goto(`${base}/play/?game=cyber-muyu&lang=en`);
  await running(page);
  assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), "the worker controls the player");
  await page.locator(".game-surface canvas").focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector(".game-surface canvas").getAttribute("aria-label").includes("MERIT 1."));
  await page.waitForFunction(async () => {
    const cache = await caches.open("releases-v1");
    const cached = (await cache.keys()).map((request) => new URL(request.url).pathname);
    const list = await cache.match(`${location.origin}/games/cyber-muyu/1.2.0/files.json`);
    if (!list) return false;
    const { files } = await list.json();
    return files.every((file) => cached.includes(`/games/cyber-muyu/1.2.0/${file}`));
  }, null, { polling: 250 });
  await pwa.setOffline(true);
  await page.reload();
  await running(page);
  assert.ok((await page.locator(".game-surface canvas").getAttribute("aria-label")).includes("MERIT 1."), "progress survives offline reload");
  await page.goto(`${base}/games/?lang=en`);
  await page.waitForFunction(() => document.querySelector(".game-item h3")?.textContent === "Wooden Fish");
  await page.screenshot({ path: resolve(root, "test-results/lobby-offline.png") });
  await pwa.close();

  assert.deepEqual(errors.filter((error) => !/status of 404/.test(error)), []);
  console.log("Site checks passed: lobby covers, share pages and 404 forwarding, manifest/icons, offline lobby and game after one online visit.");
} finally {
  await browser.close();
  server.close();
}
