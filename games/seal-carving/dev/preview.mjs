// Renders every seal, fully carved by the game's own carving and painter, to PNG:
//   node dev/preview.mjs [out-dir]
// Each image shows the print (red, read normally) beside the face (ink, mirrored).
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { seals } from "../seals.js";

const out = process.argv[2] ?? "/tmp/seal-preview";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
// Serve the game's modules to the page.
await page.route("http://preview.local/**", async (route) => {
  const path = new URL(route.request().url()).pathname.slice(1) || "index.html";
  if (path === "index.html") return route.fulfill({ contentType: "text/html", body: "<!doctype html>" });
  route.fulfill({ contentType: "text/javascript", body: await readFile(new URL(`../${path}`, import.meta.url)) });
});
await page.goto("http://preview.local/");
for (const seal of seals) {
  const data = await page.evaluate(async (id) => {
    const { seals, layoutSeal, layoutRelief, FACE, STAGES, isGlyph } = await import("/seals.js");
    const { createCarving, createMaskPainter, angleIndex } = await import("/carve.js");
    const seal = seals.find((entry) => entry.id === id);
    const carving = createCarving(layoutSeal(seal), [FACE.bevel, FACE.frameWidth, FACE.glyphWidth], layoutRelief(seal));
    // Every guide cut once, straight along its line.
    for (const cut of carving.cuts) {
      const code = isGlyph(cut.stage) ? 2 : cut.stage === "bevel" ? 0 : 1;
      const stroke = carving.beginStroke(cut.a[0], cut.a[1], angleIndex(cut.direction[0], cut.direction[1]), code, STAGES.indexOf(cut.stage));
      carving.settle(carving.extend(stroke, cut.length, 0).cuts);
    }
    carving.settleGround();
    const size = 600;
    const mask = Object.assign(document.createElement("canvas"), { width: size, height: size });
    const m = mask.getContext("2d");
    m.fillStyle = "#000";
    m.fillRect(0, 0, size, size);
    m.fillStyle = "#fff";
    createMaskPainter(carving, m, size).paintAll();
    const canvas = Object.assign(document.createElement("canvas"), { width: size * 2 + 60, height: size + 40 });
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff8ec";
    g.fillRect(0, 0, canvas.width, canvas.height);
    const pixels = m.getImageData(0, 0, size, size).data;
    const draw = (x0, mirror, stone, cut) => {
      const image = g.createImageData(size, size);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const from = (y * size + (mirror ? size - 1 - x : x)) * 4, to = (y * size + x) * 4;
        const t = pixels[from] / 255;
        for (let c = 0; c < 3; c++) image.data[to + c] = stone[c] * (1 - t) + cut[c] * t;
        image.data[to + 3] = 255;
      }
      g.putImageData(image, x0, 20);
    };
    draw(20, true, [184, 35, 29], [255, 248, 236]);
    draw(size + 40, false, [22, 19, 15], [233, 228, 218]);
    return canvas.toDataURL("image/png");
  }, seal.id);
  await writeFile(`${out}/${seal.id}.png`, Buffer.from(data.split(",")[1], "base64"));
  console.log(`${out}/${seal.id}.png`);
}
await browser.close();
