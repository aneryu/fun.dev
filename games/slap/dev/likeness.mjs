// Likeness check for photo faces: detects landmarks in the photo and in a game screenshot of it,
// aligns them (similarity) and reports the mean residual in inter-ocular distances.
// Usage: node games/slap/dev/likeness.mjs photo.jpg render.png [more renders…]
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { align } from "../shape.js";

const game = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const images = process.argv.slice(2).map((path) => resolve(path));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.route("http://slap.local/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>likeness</title>" });
  const file = path.startsWith("/image/") ? images[Number(path.slice(7))] : join(game, path);
  const type = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" }[extname(file)] ?? "application/octet-stream";
  route.fulfill({ body: await readFile(file), contentType: type });
});
await page.goto("http://slap.local/");
const found = await page.evaluate(async (count) => {
  const { createLandmarker, detect } = await import("/face.js");
  const landmarker = await createLandmarker((path) => new URL(path, location.origin + "/").href);
  const out = [];
  for (let i = 0; i < count; i++) {
    const bitmap = await createImageBitmap(await (await fetch(`/image/${i}`)).blob());
    const face = detect(landmarker, bitmap);
    out.push(face && { points: [...face.points].map((v, k) => v * (k % 2 ? bitmap.height : bitmap.width)) });
  }
  return out;
}, images.length);
await browser.close();
const [photo, ...renders] = found;
const flat = (p) => Float64Array.from({ length: 468 * 3 }, (_, i) => (i % 3 === 2 ? 0 : p.points[Math.floor(i / 3) * 2 + (i % 3)]));
const target = flat(photo);
const eye = (p, a, b) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1]);
const ocular = eye(target, 33, 263);
renders.forEach((render, n) => {
  if (!render) return console.log(images[n + 1], "no face found");
  const source = flat(render), map = align(source, target);
  let sum = 0;
  for (let i = 0; i < 468; i++) { const p = map([source[i * 3], source[i * 3 + 1], 0]); sum += Math.hypot(p[0] - target[i * 3], p[1] - target[i * 3 + 1]); }
  console.log(`${images[n + 1]}: mean landmark error ${(sum / 468 / ocular * 100).toFixed(1)}% of the eye distance`);
});
