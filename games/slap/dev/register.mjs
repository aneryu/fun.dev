// Detects the 468 face landmarks in dev/out/front.png (the default face's frontal render)
// with the same face.js the game uses, in headless Chromium. Writes dev/out/landmarks.json.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const game = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = process.argv[2] ? resolve(process.argv[2]) : join(game, "dev/out/front.png");
const output = process.argv[3] ? resolve(process.argv[3]) : join(game, "dev/out/landmarks.json");
const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg" };

const browser = await chromium.launch();
const page = await browser.newPage();
await page.route("http://slap.local/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>register</title>" });
  const file = path === "/image" ? image : join(game, path);
  route.fulfill({ body: await readFile(file), contentType: types[extname(file)] ?? "application/octet-stream" });
});
page.on("console", (message) => { if (message.type() === "error") console.error(message.text()); });
await page.goto("http://slap.local/");
const result = await page.evaluate(async () => {
  const { createLandmarker, detect } = await import("/face.js");
  const landmarker = await createLandmarker((path) => new URL(path, location.origin + "/").href);
  const bitmap = await createImageBitmap(await (await fetch("/image")).blob());
  const found = detect(landmarker, bitmap);
  if (!found) return null;
  const points = found.points;
  const { skinTone } = await import("/photo.js");
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  return { width: bitmap.width, height: bitmap.height, points: [...points], tone: skinTone(canvas, points) };
});
await browser.close();
if (!result) throw new Error(`No face found in ${image}`);
await writeFile(output, JSON.stringify(result));
console.log(`landmarks: ${result.points.length / 2} points in ${result.width}x${result.height}`);
