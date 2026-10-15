// Renders every seal's layout to PNG for checking glyph designs:
//   node dev/preview.mjs [out-dir]
// Each image shows the print (red, read normally) beside the face (ink, mirrored).
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { seals, layoutSeal } from "../seals.js";

const out = process.argv[2] ?? "/tmp/seal-preview";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const seal of seals) {
  const segments = layoutSeal(seal);
  const data = await page.evaluate((segments) => {
    const size = 600;
    const canvas = Object.assign(document.createElement("canvas"), { width: size * 2 + 60, height: size + 40 });
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff8ec";
    g.fillRect(0, 0, canvas.width, canvas.height);
    const draw = (x0, mirror, background, groove) => {
      g.save();
      g.translate(x0 + size / 2, 20 + size / 2);
      g.scale(mirror ? -size : size, size);
      g.fillStyle = background;
      g.fillRect(-0.5, -0.5, 1, 1);
      g.strokeStyle = groove;
      g.lineCap = "square";
      for (const segment of segments) {
        if (segment.stage === "bevel") continue;
        g.lineWidth = segment.width;
        g.beginPath();
        g.moveTo(...segment.a);
        g.lineTo(...segment.b);
        g.stroke();
      }
      g.restore();
    };
    draw(20, true, "#b8231d", "#fff8ec");
    draw(size + 40, false, "#16130f", "#e9e4da");
    return canvas.toDataURL("image/png");
  }, segments);
  await writeFile(`${out}/${seal.id}.png`, Buffer.from(data.split(",")[1], "base64"));
  console.log(`${out}/${seal.id}.png  ${segments.length} cuts`);
}
await browser.close();
