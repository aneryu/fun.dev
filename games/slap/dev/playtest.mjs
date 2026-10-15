// Self-playtest: opens Slap in the dev server, swipes across the face and captures frames.
// Usage: node games/slap/dev/playtest.mjs [base=http://127.0.0.1:8031] [outDir=/tmp/slap/shots] [scenario=slap]
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:8031";
const out = process.argv[3] ?? "/tmp/slap/shots";
const scenario = process.argv[4] ?? "slap";
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") errors.push(`${message.type()}: ${message.text()}`); });
await page.goto(`${base}/games/slap?lang=zh&debug=1`);
await page.waitForFunction(() => document.querySelector("#player-message")?.hidden && document.querySelector(".game-surface canvas"), null, { timeout: 30000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/00-rest.png` });

const canvas = page.locator(".game-surface canvas");
const slowmo = process.env.SLOWMO, view = process.env.VIEW, shape = process.env.SHAPE;
if (slowmo || view || shape) {
  await page.locator("#menu-toggle").tap(); await page.locator("#open-options").tap();
  if (slowmo) await page.locator("#option-slowmo").fill(slowmo);
  if (view) await page.locator("#option-view").selectOption(view);
  if (shape) await page.locator("#option-shape").fill(shape);
  await page.locator("#close-options").tap();
  await page.waitForFunction(() => document.querySelector("#player-message")?.hidden);
}
const box = await canvas.boundingBox();
async function swipe(fromX, toX, y, ms = 60, steps = 6) {
  const cdp = await context.newCDPSession(page);
  const point = (x) => [{ x: box.x + x, y: box.y + y, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(fromX) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(fromX + ((toX - fromX) * i) / steps) });
    await page.waitForTimeout(ms / steps);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const label = () => canvas.getAttribute("aria-label");
if (scenario === "slap") {
  await swipe(40, box.width - 40, box.height * 0.45, 70);
  for (let i = 1; i <= 12; i++) {
    await page.waitForTimeout(i < 6 ? 25 : 70);
    await page.screenshot({ path: `${out}/${String(i).padStart(2, "0")}-after.png` });
  }
  console.log(await label(), "|", await page.locator("#debug-panel").textContent());
} else if (scenario === "combo") {
  for (let i = 0; i < 12; i++) {
    await swipe(i % 2 ? box.width - 40 : 40, i % 2 ? 40 : box.width - 40, box.height * (0.44 + (i % 3) * 0.02), 50);
    if (i === 5) await page.screenshot({ path: `${out}/combo-6.png` });
  }
  await page.screenshot({ path: `${out}/combo-12.png` });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/combo-after.png` });
  console.log(await label());
} else if (scenario === "photo" || scenario === "noface") {
  const file = process.env.PHOTO ?? new URL(scenario === "photo" ? "./fixtures/stranger.jpg" : "./fixtures/no-face.png", import.meta.url).pathname;
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.touchscreen.tap(box.x + box.width / 2, box.y + box.height - 62)]);
  await chooser.setFiles(file);
  const started = Date.now();
  if (scenario === "photo") {
    await page.waitForFunction(() => /换一张|Another/.test(document.querySelector("#game-announcer")?.textContent + document.querySelector(".game-surface canvas").getAttribute("aria-label")) || document.querySelector("#game-announcer")?.textContent.includes("换好了"), null, { timeout: 60000 });
    console.log(`face ready in ${Date.now() - started} ms`);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${out}/photo-rest.png` });
    await swipe(box.width - 40, 40, box.height * 0.45, 60);
    for (let i = 1; i <= 4; i++) { await page.waitForTimeout(60); await page.screenshot({ path: `${out}/photo-${i}.png` }); }
  } else {
    await page.waitForTimeout(8000);
    await page.screenshot({ path: `${out}/noface-align.png` });
    await page.touchscreen.tap(box.x + box.width / 2 + 40, box.y + box.height - 50);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/noface-done.png` });
  }
} else if (scenario === "climax") {
  await page.locator("#menu-toggle").tap(); await page.locator("#open-options").tap();
  await page.locator("#option-max-damage").tap();
  await page.locator("#close-options").tap();
  await page.waitForFunction(() => document.querySelector("#player-message")?.hidden);
  await swipe(40, box.width - 40, box.height * 0.45, 50);
  for (let i = 1; i <= 8; i++) { await page.waitForTimeout(120); await page.screenshot({ path: `${out}/climax-${i}.png` }); }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/climax-after.png` });
}
console.log(errors.length ? errors.join("\n") : "no console errors");
await browser.close();
