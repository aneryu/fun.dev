import { deflateSync, inflateSync } from "node:zlib";

// Minimal decoder for the 8-bit, non-interlaced RGB/RGBA PNGs produced by browser screenshots.
export function decodePNG(buffer) {
  if (buffer.toString("latin1", 1, 4) !== "PNG") throw new Error("Not a PNG image.");
  let offset = 8, width, height, bitDepth, colorType, interlace;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      [bitDepth, colorType, , , interlace] = chunk.subarray(8);
    } else if (type === "IDAT") data.push(chunk);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = { 2: 3, 6: 4 }[colorType];
  if (bitDepth !== 8 || !channels || interlace) throw new Error("Unsupported PNG format.");
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y ? pixels[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - corner;
        const [a, b, c] = [left, up, corner].map((value) => Math.abs(estimate - value));
        predictor = a <= b && a <= c ? left : b <= c ? up : corner;
      } else if (filter !== 0) throw new Error("Invalid PNG filter.");
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

// Share of pixels with the most common colour, quantized to tolerate antialiasing noise.
export function dominantColorShare({ channels, pixels }) {
  const counts = new Map();
  let total = 0, top = 0;
  for (let i = 0; i < pixels.length; i += channels) {
    const key = (pixels[i] >> 4) << 8 | (pixels[i + 1] >> 4) << 4 | pixels[i + 2] >> 4;
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    if (count > top) top = count;
    total++;
  }
  return total ? top / total : 1;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes) {
  let c = -1;
  for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Minimal encoder for 8-bit RGBA pixels (row-major, no padding).
export function encodePNG({ width, height, pixels }) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
