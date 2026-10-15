// Opens the game in Chromium at phone or desktop size and takes screenshots, optionally after
// a few scripted touch drags:  node dev/playtest.mjs <url> <out-dir> [mobile|desktop] [script.json]
// script.json: [{ "drag": [[x, y], [x, y], ...], "ms": 600 }, { "wait": 500 }, { "shot": "name" }, { "key": "Space", "hold": 1500 }]
import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";

const [url, out = "/tmp/seal-shots", size = "mobile", scriptPath] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const viewports = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 800 } },
  cover: { viewport: { width: 1240, height: 740 }, deviceScaleFactor: 2 },
};
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ ...viewports[size], locale: "zh-CN", serviceWorkers: "block" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (["error", "warning"].includes(message.type())) errors.push(`${message.type()}: ${message.text()}`); });
await page.goto(url);
await page.waitForFunction(() => document.querySelector("#player-message")?.hidden && document.querySelector(".game-surface canvas"), null, { timeout: 60000 });
await page.waitForTimeout(1500);
const canvas = page.locator(".game-surface canvas");
const box = await canvas.boundingBox();
console.log("canvas", JSON.stringify(box));
await page.screenshot({ path: `${out}/${size}-start.png` });

const session = size === "mobile" ? await context.newCDPSession(page) : null;
async function touch(type, x, y) {
  await session.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: box.x + x, y: box.y + y, id: 1 }] });
}
// Two thumbs: one held at `hold`, the other sliding along `path`.
async function thumbs(hold, path, ms) {
  const point = (id, [x, y]) => ({ x: box.x + x, y: box.y + y, id });
  const send = (type, points) => session.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  const frames = Math.max(2, Math.round(ms / 16));
  if (hold) await send("touchStart", [point(1, hold)]);
  await send("touchStart", [...(hold ? [point(1, hold)] : []), point(2, path[0])]);
  for (let i = 1; i <= frames; i++) {
    const f = i / frames * (path.length - 1), j = Math.min(path.length - 2, Math.floor(f)), t = f - j;
    const p = [path[j][0] + (path[j + 1][0] - path[j][0]) * t, path[j][1] + (path[j + 1][1] - path[j][1]) * t];
    await send("touchMove", [...(hold ? [point(1, hold)] : []), point(2, p)]);
    await page.waitForTimeout(16);
  }
  await send("touchEnd", hold ? [point(1, hold)] : []);
  if (hold) await send("touchEnd", []);
}
// One finger along waypoints [x, y, ms]: it glides to each point over ms (rests when unmoved).
async function finger(points, shotAt) {
  const send = (type, p) => session.send("Input.dispatchTouchEvent", { type, touchPoints: p ? [{ x: box.x + p[0], y: box.y + p[1], id: 3 }] : [] });
  let [x, y] = points[0];
  await send("touchStart", [x, y]);
  for (const [tx, ty, ms] of points.slice(1)) {
    const frames = Math.max(1, Math.round(ms / 16));
    for (let i = 1; i <= frames; i++) {
      await send("touchMove", [x + (tx - x) * i / frames, y + (ty - y) * i / frames]);
      await page.waitForTimeout(16);
    }
    x = tx; y = ty;
  }
  if (shotAt) await page.screenshot({ path: `${out}/${size}-${shotAt}.png` });
  await send("touchEnd", null);
}
const steps = scriptPath ? JSON.parse(await readFile(scriptPath, "utf8")) : [];
for (const step of steps) {
  if (step.drag) {
    const points = step.drag, ms = step.ms ?? 600, frames = Math.max(2, Math.round(ms / 16));
    if (session) await touch("touchStart", ...points[0]); else { await page.mouse.move(box.x + points[0][0], box.y + points[0][1]); await page.mouse.down(); }
    for (let i = 1; i <= frames; i++) {
      const f = i / frames * (points.length - 1), j = Math.min(points.length - 2, Math.floor(f)), t = f - j;
      const x = points[j][0] + (points[j + 1][0] - points[j][0]) * t, y = points[j][1] + (points[j + 1][1] - points[j][1]) * t;
      if (session) await touch("touchMove", x, y); else await page.mouse.move(box.x + x, box.y + y);
      await page.waitForTimeout(16);
    }
    if (session) await touch("touchEnd", 0, 0); else await page.mouse.up();
  }
  if (step.finger) await finger(step.finger, step.shotDuring);
  if (step.thumbs) await thumbs(step.thumbs.hold, step.thumbs.path, step.thumbs.ms ?? 600);
  if (step.demo !== undefined) {
    const tap = (locator) => size === "mobile" ? locator.tap() : locator.click();
    if (await page.locator("#menu-toggle").isVisible()) await tap(page.locator("#menu-toggle"));
    await tap(page.locator("#open-options"));
    const input = page.locator("#options-debug .option-row").filter({ hasText: "自动刻" }).locator("input");
    if (step.demo) await input.check(); else await input.uncheck();
    await tap(page.locator("#close-options"));
  }
  if (step.cheat) {
    const tap = (locator) => size === "mobile" ? locator.tap() : locator.click();
    if (await page.locator("#menu-toggle").isVisible()) await tap(page.locator("#menu-toggle"));
    await tap(page.locator("#open-options"));
    await tap(page.locator("#options-cheats button, #options-debug button").filter({ hasText: step.cheat }).first());
    await tap(page.locator("#close-options"));
  }
  if (step.tap) {
    if (session) { await touch("touchStart", ...step.tap); await page.waitForTimeout(40); await touch("touchEnd", 0, 0); }
    else await page.mouse.click(box.x + step.tap[0], box.y + step.tap[1]);
  }
  if (step.wait) await page.waitForTimeout(step.wait);
  if (step.key) {
    await canvas.focus();
    await page.keyboard.down(step.key);
    await page.waitForTimeout(step.hold ?? 50);
    await page.keyboard.up(step.key);
  }
  if (step.eval) await page.evaluate(step.eval);
  if (step.mouse) await page.mouse.move(box.x + step.mouse[0], box.y + step.mouse[1], { steps: 8 });
  if (step.canvasShot) await canvas.screenshot({ path: `${out}/${step.canvasShot}.png` });
  if (step.shot) await page.screenshot({ path: `${out}/${size}-${step.shot}.png` });
}
console.log(errors.length ? `console:\n  ${errors.join("\n  ")}` : "no console errors");
await browser.close();
