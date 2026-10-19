import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { results } from "./harness.mjs";

// Player features from API v2 with the platform's test game (tests/fixture-games/probe).

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
    await page.goto(`${base}/games/probe?lang=en${query}`);
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
  assert.match(await page.locator("#how-to-play-text").textContent(), /tap the probe/);
  assert.equal(await page.locator("#options-debug").isHidden(), true);
  assert.equal(await page.locator("#player-message").isVisible(), true, "opening options pauses the game");
  await page.locator("#option-merit-1000").click();
  await page.locator("#option-rings").uncheck();
  await page.locator("#pref-mute").check();
  await page.locator("#close-options").click();
  await running(page);
  assert.equal(await merit(page), 1001, "cheat action reaches the game");
  assert.deepEqual(await page.evaluate(() => [JSON.parse(localStorage.getItem("fun.dev.settings.probe")).rings, JSON.parse(localStorage.getItem("fun.dev.audio")).muted]), [false, true]);

  // Share text comes from the game and notes cheats; without Web Share the link is copied.
  // The site's Permissions-Policy forbids clipboard reads, so record the write instead.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", { value: undefined });
    navigator.clipboard.writeText = async (text) => { window.__copied = text; };
  });
  await page.locator("#menu-toggle").click(); await page.locator("#share").click();
  await page.waitForFunction(() => document.querySelector("#action-status").textContent.includes("copied"));
  const shared = await page.evaluate(() => window.__copied);
  assert.match(shared, /1001 merit on Probe at fun\.dev \(with cheats\) http:\/\/127\.0\.0\.1:\d+\/games\/probe\?lang=en$/);

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

  // Video recording: only for games whose manifest allows it; a 9:16 clip opens in a dialog.
  const recorderContext = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
  const plain = await open(recorderContext);
  await running(plain);
  await plain.locator("#menu-toggle").click();
  assert.equal(await plain.locator("#record").isHidden(), true, "no recording without the manifest field");
  await plain.close();
  await recorderContext.route("**/games.json", (route) => route.fulfill({ json: catalog.map((game) => ({ ...game, recording: true })) }));
  // A light stand-in game keeps software rendering fast: a red square above the middle, which the
  // recorder centres through recordingFocus(), on a blue ground; a green badge sits top left.
  await recorderContext.route("**/games/probe/*/game.js", (route) => route.fulfill({ contentType: "text/javascript", body: `
    export function createGame({ THREE, scene, camera, track }) {
      scene.background = new THREE.Color(0x2040ff);
      const square = new THREE.Mesh(track(new THREE.PlaneGeometry(0.6, 0.6)), track(new THREE.MeshBasicMaterial({ color: 0xff0000 })));
      square.position.set(0, 0.8, 0);
      scene.add(square);
      const focus = { x: 0, y: 0 };
      const badge = Object.assign(document.createElement("canvas"), { width: 100, height: 100 });
      Object.assign(badge.getContext("2d"), { fillStyle: "#00ff00" }).fillRect(0, 0, 100, 100);
      return {
        renderMode: "on-demand",
        resize({ width, height }) {
          camera.updateMatrixWorld();
          const point = square.position.clone().project(camera);
          Object.assign(focus, { x: (point.x + 1) / 2 * width, y: (1 - point.y) / 2 * height });
        },
        recordingFocus() { return focus; },
        recordingBadge() { return badge; },
      };
    }` }));
  // Playwright's Chromium can encode MP4 but not decode H.264, so check the WebM path here.
  await recorderContext.addInitScript(() => {
    const supported = MediaRecorder.isTypeSupported.bind(MediaRecorder);
    MediaRecorder.isTypeSupported = (type) => !type.startsWith("video/mp4") && supported(type);
  });
  const rec = await recorderContext.newPage();
  rec.setDefaultTimeout(20000);
  rec.on("pageerror", (error) => errors.push(error.message));
  rec.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await rec.goto(`${base}/games/probe?lang=en`);
  await running(rec);
  await rec.locator("#menu-toggle").click();
  assert.equal(await rec.locator("#record").textContent(), "Record video");
  await rec.locator("#record").click();
  await running(rec);
  await rec.waitForFunction(() => document.querySelector("#record-time").textContent === "0:01");
  assert.match(await rec.locator("#record-stop").getAttribute("aria-label"), /^Recording 0:01/);
  await rec.locator("#record-stop").click();
  await rec.waitForFunction(() => document.querySelector("#record-dialog").open);
  assert.equal(await rec.locator("#player-message").isVisible(), true, "the clip dialog pauses the game");
  assert.equal(await rec.locator("#record-stop").isHidden(), true);
  const clip = await rec.evaluate(async () => {
    const video = document.querySelector("#record-video");
    if (video.readyState < 1) await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error("clip did not load")); });
    video.currentTime = 0.5;
    await new Promise((resolve) => { video.onseeked = resolve; });
    const canvas = Object.assign(document.createElement("canvas"), { width: video.videoWidth, height: video.videoHeight });
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)];
    // A seeked WebM frame can reach the canvas a little after "seeked" under load: wait for one.
    for (let tries = 0; tries < 40; tries++) {
      context.drawImage(video, 0, 0);
      if (pixel(360, 1100).some((value) => value > 0)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const save = document.querySelector("#record-save");
    return { width: video.videoWidth, height: video.videoHeight, centre: pixel(360, 640), badge: pixel(100, 100), border: pixel(26, 100), below: pixel(360, 1100), src: video.src.slice(0, 5), file: save.download, note: document.querySelector("#record-note").textContent };
  });
  assert.equal(clip.width, 720);
  assert.equal(clip.height, 1280);
  const near = ([r, g, b], [er, eg, eb]) => Math.abs(r - er) + Math.abs(g - eg) + Math.abs(b - eb) < 90;
  assert.ok(near(clip.centre, [255, 0, 0]), `the focus is centred in the clip: ${clip.centre}`);
  assert.ok(near(clip.badge, [0, 255, 0]), `the badge is top left: ${clip.badge}`);
  assert.ok(near(clip.border, [33, 31, 23]), `the badge has an ink frame: ${clip.border}`);
  assert.ok(near(clip.below, [32, 64, 255]), `the game background surrounds it: ${clip.below}`);
  assert.equal(clip.src, "blob:");
  assert.match(clip.file, /^probe-\d{14}\.webm$/);
  assert.match(clip.note, /^0:0[12] · The video stays on this device/);
  await rec.screenshot({ path: resolve(results, "player-recording.png") });
  await rec.locator("#record-discard").click();
  await running(rec);
  assert.equal(await rec.evaluate(() => document.querySelector("#record-video").hasAttribute("src")), false, "discarding releases the clip");
  await recorderContext.close();

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
  await picker.route("**/pick-fixture/files.json", (route) => route.fulfill({ json: { files: ["game.js"], blobs: {} } }));
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

  // deviceStorage: per-game blobs on this device; validated keys, size and count limits.
  const device = await browser.newContext({ serviceWorkers: "block" });
  const store = await device.newPage();
  store.on("pageerror", (error) => errors.push(error.message));
  await store.goto(`${base}/`);
  const stored = await store.evaluate(async () => {
    const { createDeviceStorage } = await import("/runtime/core/device-storage.js");
    const a = createDeviceStorage("game-a"), b = createDeviceStorage("game-b");
    await a.set("face", new Blob(["hello"], { type: "text/plain" }));
    const text = await (await a.get("face")).text();
    const other = await b.get("face");
    const errors = [];
    for (const attempt of [() => a.set("Bad Key", new Blob([])), () => a.set("big", new Blob([new Uint8Array(2 * 1024 * 1024 + 1)])), () => a.set("text", "not a blob")]) {
      try { await attempt(); errors.push("accepted"); } catch (error) { errors.push(error.name); }
    }
    for (let i = 0; i < 7; i++) await a.set(`k${i}`, new Blob([String(i)]));
    try { await a.set("one-more", new Blob(["x"])); errors.push("accepted"); } catch (error) { errors.push(error.name); }
    await a.delete("face");
    return { text, other, errors, deleted: await a.get("face") };
  });
  assert.deepEqual(stored, { text: "hello", other: null, errors: ["TypeError", "RangeError", "TypeError", "RangeError"], deleted: null });
  await device.close();

  // Catalog entries for another API version explain themselves instead of loading.
  for (const [apiVersion, text] of [[4, "has been updated"], [2, "being updated"]]) {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const mismatch = await open(context, "", { apiVersion });
    await mismatch.waitForFunction((expected) => document.querySelector("#player-status").textContent.includes(expected), text);
    assert.equal(await mismatch.locator(".game-surface canvas").count(), 0);
    await context.close();
  }
  assert.deepEqual(errors, []);
}
