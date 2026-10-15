import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { results, running, watch as watchErrors } from "./harness.mjs";

// Lobby covers, game pages and redirects, the 404 page, the manifest, and offline play through the
// service worker (the verify build keeps it enabled; other suites block it per context).

const { version } = JSON.parse(readFileSync(new URL("../../games/muyu/game.json", import.meta.url), "utf8"));

export async function siteChecks({ browser, base }) {
  const errors = [];
  const watch = (page) => watchErrors(page, errors);
  // Lobby rows show the cover thumbnail at desktop and phone widths.
  for (const [name, viewport] of [["desktop", { width: 1280, height: 800 }], ["mobile", { width: 375, height: 740 }]]) {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    const page = watch(await context.newPage());
    await page.goto(`${base}/games?lang=en`);
    await page.waitForFunction(() => document.querySelector(".game-cover")?.complete && document.querySelector(".game-cover").naturalWidth > 0);
    await page.screenshot({ path: resolve(results, `lobby-${name}.png`) });
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  // Game pages are share pages too: crawler-visible tags and a canonical address, then the game.
  const html = await (await fetch(`${base}/games/muyu`)).text();
  assert.match(html, /<meta property="og:title" content="敲木鱼">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/fun.dev\/games\/muyu">/);
  assert.match(html, /<meta property="og:image" content="[^"]+\/games\/muyu\/[\d.]+\/assets\/cover\.jpg">/);
  assert.match(await (await fetch(`${base}/sitemap.xml`)).text(), /<loc>https:\/\/fun.dev\/games\/muyu<\/loc>/);
  // Addresses have no trailing slash.
  for (const [from, to] of [["/games/", "/games"], ["/games/muyu/?lang=en", "/games/muyu?lang=en"]]) {
    const moved = await fetch(`${base}${from}`, { redirect: "manual" });
    assert.equal(moved.status, 301, from);
    assert.equal(new URL(moved.headers.get("location"), base).pathname + new URL(moved.headers.get("location"), base).search, to);
  }
  const share = watch(await context.newPage());
  await share.goto(`${base}/games/muyu?lang=en`);
  await running(share);
  assert.equal(await share.title(), "Wooden Fish — fun.dev");
  await share.close();
  assert.equal((await fetch(`${base}/games/not-built-yet`)).status, 404);
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
  await page.goto(`${base}/games?lang=en`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.goto(`${base}/games/muyu?lang=en`);
  await running(page);
  assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), "the worker controls the player");
  await page.locator(".game-surface canvas").focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector(".game-surface canvas").getAttribute("aria-label").includes("MERIT 1."));
  await page.waitForFunction(async (version) => {
    const cache = await caches.open("releases-v1");
    const cached = (await cache.keys()).map((request) => new URL(request.url).pathname);
    const list = await cache.match(`${location.origin}/games/muyu/${version}/files.json`);
    if (!list) return false;
    const { files } = await list.json();
    return files.every((file) => cached.includes(`/games/muyu/${version}/${file}`));
  }, version, { polling: 250 });
  await pwa.setOffline(true);
  await page.reload();
  await running(page);
  assert.ok((await page.locator(".game-surface canvas").getAttribute("aria-label")).includes("MERIT 1."), "progress survives offline reload");
  await page.goto(`${base}/games?lang=en`);
  await page.waitForFunction(() => document.querySelector(".game-item h3")?.textContent === "Wooden Fish");
  await page.screenshot({ path: resolve(results, "lobby-offline.png") });
  await pwa.close();

  // 504: offline, the lobby cannot show covers of games that were never opened.
  assert.deepEqual(errors.filter((error) => !/status of (?:404|504)/.test(error)), []);
}
