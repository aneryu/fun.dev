import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { decodePNG, dominantColorShare } from "../scripts/png.mjs";

// Encodes each row with a different filter so the decoder's reconstruction is exercised.
function encodePNG(width, height, channels, pixels) {
  const stride = width * channels;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    const row = Buffer.alloc(stride + 1);
    row[0] = filter;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y ? pixels[(y - 1) * stride + x - channels] : 0;
      const estimate = left + up - corner;
      const [a, b, c] = [left, up, corner].map((value) => Math.abs(estimate - value));
      const predictor = [0, left, up, (left + up) >> 1, a <= b && a <= c ? left : b <= c ? up : corner][filter];
      row[x + 1] = (pixels[y * stride + x] - predictor) & 255;
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length);
    header.write(type, 4, "latin1");
    return Buffer.concat([header, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("decodes every PNG filter type for RGB and RGBA screenshots", () => {
  for (const channels of [3, 4]) {
    const [width, height] = [7, 10];
    const pixels = Buffer.from(Array.from({ length: width * height * channels }, (_, i) => (i * 37 + (i >> 3) * 11) & 255));
    const image = decodePNG(encodePNG(width, height, channels, pixels));
    assert.deepEqual({ ...image, pixels: undefined }, { width, height, channels, pixels: undefined });
    assert.ok(image.pixels.equals(pixels));
  }
});

test("dominant colour share separates blank and drawn frames", () => {
  const blank = Buffer.alloc(10 * 10 * 4, 200);
  assert.equal(dominantColorShare({ channels: 4, pixels: blank }), 1);
  const drawn = Buffer.from(blank);
  for (let i = 0; i < 30 * 4; i++) drawn[i] = 20;
  assert.equal(dominantColorShare({ channels: 4, pixels: drawn }), 0.7);
});
