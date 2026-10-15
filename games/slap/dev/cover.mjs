// Captures assets/cover.jpg (1200×630) from the real game: the tenth slap of a combo, at contact.
// Usage: node games/slap/dev/cover.mjs [out=/tmp/slap-cover.jpg] [base=http://127.0.0.1:8031]
// Writing straight into games/ would make a running dev server reload mid-capture.
import { chromium } from "playwright";

const out = process.argv[2] ?? "/tmp/slap-cover.jpg";
const base = process.argv[3] ?? "http://127.0.0.1:8031";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 701 }, deviceScaleFactor: 1 });
await page.goto(`${base}/games/slap?lang=zh&debug=1`);
await page.waitForFunction(() => document.querySelector("#player-message")?.hidden && document.querySelector(".game-surface canvas"));
await page.evaluate(() => { document.querySelector("#debug-panel").style.visibility = "hidden"; });
await page.waitForTimeout(600);
const canvas = page.locator(".game-surface canvas");
await canvas.focus();
for (let i = 0; i < 9; i++) {
  await page.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowRight");
  await page.waitForTimeout(260);
}
// The last slap in slow motion, so the hand is caught at the cheek.
await page.locator("#menu-toggle").click(); await page.locator("#open-options").click();
await page.locator("#option-slowmo").fill("0.1");
await page.locator("#close-options").click();
await page.waitForFunction(() => document.querySelector("#player-message")?.hidden);
await canvas.focus();
await page.keyboard.press("ArrowLeft");
await page.waitForTimeout(Number(process.env.DELAY ?? 700));
const box = await canvas.boundingBox();
await page.screenshot({
  path: out, type: "jpeg", quality: 84,
  clip: { x: box.x, y: box.y + box.height - 630, width: 1200, height: 630 },
});
await browser.close();
