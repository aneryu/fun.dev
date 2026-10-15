import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { results } from "./harness.mjs";

// Player features from API v2 with the Wooden Fish reference game.

export async function playerChecks({ browser, base, dist }) {
  const catalog = JSON.parse(await readFile(resolve(dist, "games.json"), "utf8"));
  const errors = [];
  async function open(context, query = "", entry = {}) {
    if (Object.keys(entry).length) {
      await context.route("**/games.json", (route) => route.fulfill({ json: catalog.map((game) => ({ ...game, ...entry })) }));
    }
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`${base}/games/muyu?lang=en${query}`);
    return page;
  }
  const running = (page) => page.waitForFunction(() => document.querySelector("#player-message").hidden && document.querySelector(".game-surface canvas"));
  const label = (page) => page.locator(".game-surface canvas").getAttribute("aria-label");
  const merit = async (page) => Number((await label(page)).match(/MERIT (\d+)/)[1]);
  const desktop = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
  const page = await open(desktop);
  await running(page);
  assert.equal(await page.locator("#player-loading").isHidden(), true, "loading bar hides once running");

  // A strike is announced through the coalescing live region.
  await page.locator(".game-surface canvas").focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector("#game-announcer").textContent.includes("MERIT 1"));

  // Options: how to play, platform sound/haptics, settings and player cheats; debug items hidden.
  await page.locator("#menu-toggle").click(); await page.locator("#open-options").click();
  assert.match(await page.locator("#how-to-play-text").textContent(), /strike the wooden fish/);
  assert.equal(await page.locator("#options-debug").isHidden(), true);
  assert.equal(await page.locator("#player-message").isVisible(), true, "opening options pauses the game");
  await page.locator("#option-merit-1000").click();
  await page.locator("#option-rings").uncheck();
  await page.locator("#pref-mute").check();
  await page.locator("#close-options").click();
  await running(page);
  assert.equal(await merit(page), 1001, "cheat action reaches the game");
  assert.deepEqual(await page.evaluate(() => [JSON.parse(localStorage.getItem("fun.dev.settings.muyu")).rings, JSON.parse(localStorage.getItem("fun.dev.audio")).muted]), [false, true]);

  // Share text comes from the game and notes cheats; without Web Share the link is copied.
  // The site's Permissions-Policy forbids clipboard reads, so record the write instead.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", { value: undefined });
    navigator.clipboard.writeText = async (text) => { window.__copied = text; };
  });
  await page.locator("#menu-toggle").click(); await page.locator("#share").click();
  await page.waitForFunction(() => document.querySelector("#action-status").textContent.includes("copied"));
  const shared = await page.evaluate(() => window.__copied);
  assert.match(shared, /1001 merit and 0\/12 relics on Wooden Fish at fun\.dev \(with cheats\) http:\/\/127\.0\.0\.1:\d+\/games\/muyu\?lang=en$/);

  // Restart keeps settings and saved merit, and starts a session without cheats.
  await page.locator("#menu-toggle").click(); await page.locator("#restart").click();
  await running(page);
  assert.equal(await merit(page), 1001);
  await page.locator("#menu-toggle").click(); await page.locator("#open-options").click();
  assert.equal(await page.locator("#option-rings").isChecked(), false, "settings persist across sessions");
  assert.equal(await page.locator("#pref-mute").isChecked(), true);
  await page.locator("#close-options").click();
  await page.screenshot({ path: resolve(results, "player-desktop.png") });

  // ?debug=1 reveals the stats panel and debug-only options. One tab owns a game's saves at a time.
  await page.close();
  const debug = await open(desktop, "&debug=1");
  await running(debug);
  await debug.waitForFunction(() => /fps \d+/.test(document.querySelector("#debug-panel").textContent));
  await debug.locator("#menu-toggle").click(); await debug.locator("#open-options").click();
  assert.equal(await debug.locator("#options-debug").isVisible(), true);
  await debug.locator("#option-auto-strike").check();
  await debug.locator("#close-options").click();
  const before = await merit(debug);
  await debug.waitForFunction((value) => Number(document.querySelector(".game-surface canvas").getAttribute("aria-label").match(/MERIT (\d+)/)[1]) >= value + 2, before);
  await debug.close();

  // Mobile: a landscape-only game waits for rotation; options live behind the menu.
  const mobile = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await open(mobile, "", { orientation: "landscape", keepAwake: true });
  await phone.waitForFunction(() => document.querySelector("#player-status").textContent.includes("landscape"));
  assert.equal(await phone.locator("#player-message").isVisible(), true);
  await phone.screenshot({ path: resolve(results, "player-rotate.png") });
  await phone.setViewportSize({ width: 844, height: 390 });
  await running(phone);
  await phone.locator("#menu-toggle").tap();
  await phone.locator("#open-options").tap();
  assert.equal(await phone.locator("#options-dialog").isVisible(), true);
  await phone.screenshot({ path: resolve(results, "player-options-mobile.png") });
  await phone.locator("#close-options").tap();
  await running(phone);
  await mobile.close();

  // pickImage: opened from a gesture, decoded upright and scaled; cancel resolves null.
  const picker = await browser.newContext({ serviceWorkers: "block" });
  await picker.route("**/pick-fixture/game.js", (route) => route.fulfill({ contentType: "text/javascript", body: `
    export function createGame(context) {
      window.__results = [];
      context.canvas.addEventListener("pointerdown", () => {
        context.pickImage({ maxSize: 64 }).then((image) => {
          window.__results.push(image && [image.width, image.height]);
          image?.close();
        });
      }, { signal: context.signal });
      return {};
    }` }));
  const pick = await picker.newPage();
  pick.on("pageerror", (error) => errors.push(error.message));
  await pick.goto(`${base}/`);
  await pick.evaluate(async () => {
    const { createGameHost } = await import("/runtime/core/host.js");
    const THREE = await import("/runtime/three.js");
    const stage = Object.assign(document.createElement("div"), { style: "position:fixed;inset:0;z-index:9" });
    document.body.append(stage);
    window.__host = createGameHost({ THREE, stage });
    await window.__host.load("/pick-fixture/game.js");
  });
  const png = Buffer.from(await pick.evaluate(async () => {
    const canvas = new OffscreenCanvas(200, 100);
    canvas.getContext("2d").fillRect(0, 0, 200, 100);
    return [...new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer())];
  }));
  const [chooser] = await Promise.all([pick.waitForEvent("filechooser"), pick.locator("canvas").click()]);
  await chooser.setFiles({ name: "face.png", mimeType: "image/png", buffer: png });
  await pick.waitForFunction(() => window.__results.length === 1);
  assert.deepEqual(await pick.evaluate(() => window.__results), [[64, 32]], "picked image is scaled to maxSize");
  assert.equal(await pick.locator("input[type=file]").count(), 0, "picker input is removed");
  await picker.close();

  // Catalog entries for another API version explain themselves instead of loading.
  for (const [apiVersion, text] of [[3, "has been updated"], [1, "being updated"]]) {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const mismatch = await open(context, "", { apiVersion });
    await mismatch.waitForFunction((expected) => document.querySelector("#player-status").textContent.includes(expected), text);
    assert.equal(await mismatch.locator(".game-surface canvas").count(), 0);
    await context.close();
  }
  assert.deepEqual(errors, []);
}
