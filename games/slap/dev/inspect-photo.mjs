// Debug helper: swaps in a fixture photo and prints console output plus what deviceStorage kept.
// Usage: node games/slap/dev/inspect-photo.mjs [photo=dev/fixtures/stranger.jpg] [base=http://127.0.0.1:8031]
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const photo = process.argv[2] ?? new URL("./fixtures/stranger.jpg", import.meta.url).pathname;
const base = process.argv[3] ?? "http://127.0.0.1:8031";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
const page = await context.newPage();
page.on("console", (m) => { if (!/Permissions-Policy|W1015|XNNPACK|GL Driver|gl_context/.test(m.text())) console.log("console", m.type(), m.text().slice(0, 400)); });
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto(`${base}/games/slap?lang=zh`);
await page.waitForFunction(() => document.querySelector("#player-message")?.hidden && document.querySelector(".game-surface canvas"));
const box = await page.locator(".game-surface canvas").boundingBox();
const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.touchscreen.tap(box.x + box.width / 2, box.y + box.height - 62)]);
await chooser.setFiles(photo);
await page.waitForTimeout(6000);
const stored = await page.evaluate(() => new Promise((resolve) => {
  const open = indexedDB.open("fun.dev.device", 1);
  open.onsuccess = () => {
    const store = open.result.transaction("blobs").objectStore("blobs");
    const keys = store.getAllKeys();
    keys.onsuccess = () => {
      const face = store.get("slap/face");
      const points = store.get("slap/face-points");
      points.onsuccess = async () => resolve({
        keys: keys.result,
        face: face.result ? [...new Uint8Array(await face.result.arrayBuffer())] : null,
        points: points.result ? await points.result.text() : null,
      });
    };
  };
}));
console.log("keys", stored.keys);
if (stored.face) await writeFile("/tmp/slap/crop.jpg", Buffer.from(stored.face));
if (stored.points) await writeFile("/tmp/slap/points.json", stored.points);
await page.screenshot({ path: "/tmp/slap/inspect.png" });
await browser.close();
