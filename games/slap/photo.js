// Turning a picked photo into a face for the head: landmarks (MediaPipe, or five points
// placed by hand), a square crop around the face with its broad lighting evened out, and a
// skin-tone gain for the rest of the head. The crop and its landmarks can be remembered in deviceStorage; nothing leaves the device.
import { LANDMARKS } from "./face.js";

const CROP = 1024;
// Five anchor landmarks: eye centres (corner pairs), nose tip, mouth corners.
const ANCHORS = [[33, 133], [362, 263], [1], [61], [291]];
// The face outline, from the forehead clockwise (MediaPipe's FACE_OVAL).
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
// Skin tone is sampled just inside the outline from cheek to cheek, where the photo meets the head.
const RING = [234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454];

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// Synthetic landmarks outside the face outline, so a photo also covers the forehead up to the
// hair, the cheeks' sides and the jaw edge. Each outline point moves away from the outline's
// centre, furthest upwards. Works on [x, y, …] in units where x * aspect and y are
// isotropic; returns the 468 landmarks followed by the extra ring.
export const EXTRA = OVAL.length;
export function extendLandmarks(points, aspect = 1) {
  let cx = 0, cy = 0;
  for (const id of OVAL) { cx += points[id * 2] * aspect / OVAL.length; cy += points[id * 2 + 1] / OVAL.length; }
  const out = new Float32Array(LANDMARKS * 2 + OVAL.length * 2);
  out.set(points.subarray ? points.subarray(0, LANDMARKS * 2) : points.slice(0, LANDMARKS * 2));
  OVAL.forEach((id, k) => {
    const x = points[id * 2] * aspect, y = points[id * 2 + 1];
    // Mostly upwards (the hair), a little sideways, hardly down (the neck would stretch).
    const up = (cy - y) / Math.hypot(x - cx, y - cy);
    const f = up > 0 ? 1.1 + 0.3 * up : 1.1 + 0.07 * up;
    out[(LANDMARKS + k) * 2] = (cx + (x - cx) * f) / aspect;
    out[(LANDMARKS + k) * 2 + 1] = cy + (y - cy) * f;
  });
  return out;
}

export function anchorsOf(points) {
  return ANCHORS.map((ids) => {
    let x = 0, y = 0;
    for (const id of ids) { x += points[id * 2]; y += points[id * 2 + 1]; }
    return [x / ids.length, y / ids.length];
  });
}

// Least-squares affine map from five reference anchors to five placed anchors, applied to all landmarks.
export function landmarksFromAnchors(reference, placed) {
  const from = anchorsOf(reference);
  // Solve [x y 1] A = [x' y'] by normal equations (3×3).
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
  from.forEach(([x, y], i) => {
    const r = [x, y, 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) m[a][b] += r[a] * r[b];
      bx[a] += r[a] * placed[i][0]; by[a] += r[a] * placed[i][1];
    }
  });
  const solve = (rhs) => {
    const a = m.map((row, i) => [...row, rhs[i]]);
    for (let c = 0; c < 3; c++) {
      let p = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      [a[c], a[p]] = [a[p], a[c]];
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const f = a[r][c] / a[c][c];
        for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k];
      }
    }
    return a.map((row, i) => row[3] / row[i]);
  };
  const ax = solve(bx), ay = solve(by);
  const out = new Float32Array(LANDMARKS * 2);
  for (let i = 0; i < LANDMARKS; i++) {
    const x = reference[i * 2], y = reference[i * 2 + 1];
    out[i * 2] = ax[0] * x + ax[1] * y + ax[2];
    out[i * 2 + 1] = ay[0] * x + ay[1] * y + ay[2];
  }
  return out;
}

// Default five anchors for the alignment screen: the reference face (in a refWidth × refHeight
// render) centred in a width × height photo, eyes about a quarter of the shorter side apart.
export function defaultAnchors(reference, [refWidth, refHeight], width, height) {
  const anchors = anchorsOf(reference).map(([x, y]) => [x * refWidth, y * refHeight]);
  const cx = anchors.reduce((s, p) => s + p[0], 0) / 5, cy = anchors.reduce((s, p) => s + p[1], 0) / 5;
  const eyes = Math.hypot(anchors[0][0] - anchors[1][0], anchors[0][1] - anchors[1][1]);
  const scale = (0.25 * Math.min(width, height)) / eyes;
  return anchors.map(([x, y]) => [(width / 2 + (x - cx) * scale) / width, (height / 2 + (y - cy) * scale) / height]);
}

const canvas = (width, height) => new OffscreenCanvas(width, height);

// Crops a square around the landmarks (image 0..1) and returns { canvas, landmarks (crop 0..1),
// depth (crop-width units) }.
export function cropFace(image, landmarks, depth = null) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < LANDMARKS; i++) {
    const x = landmarks[i * 2] * image.width, y = landmarks[i * 2 + 1] * image.height;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  // Room for the extended ring around the face (extendLandmarks).
  const size = Math.max(maxX - minX, maxY - minY) * 1.7;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const sx = cx - size / 2, sy = cy - size / 2;
  const out = canvas(CROP, CROP);
  const g = out.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#808080";
  g.fillRect(0, 0, CROP, CROP);
  g.imageSmoothingQuality = "high";
  g.drawImage(image, sx, sy, size, size, 0, 0, CROP, CROP);
  const local = new Float32Array(LANDMARKS * 2);
  for (let i = 0; i < LANDMARKS; i++) {
    local[i * 2] = (landmarks[i * 2] * image.width - sx) / size;
    local[i * 2 + 1] = (landmarks[i * 2 + 1] * image.height - sy) / size;
  }
  return { canvas: out, landmarks: local, depth: depth && Float32Array.from(depth, (z) => (z * image.width) / size) };
}

// Evens out broad lighting (one side in shadow, a lit forehead) inside the face outline while
// keeping features: each pixel is scaled towards the face's mean brightness by a smooth field
// measured on a coarse grid, so the game's own light and shadow read on the face.
export function evenLighting(face, { grid = 6, strength = 0.9 } = {}) {
  const { canvas: source, landmarks } = face;
  const size = source.width;
  const mask = canvas(size, size).getContext("2d", { willReadFrequently: true });
  mask.beginPath();
  OVAL.forEach((id, i) => mask[i ? "lineTo" : "moveTo"](landmarks[id * 2] * size, landmarks[id * 2 + 1] * size));
  mask.fill();
  const inside = mask.getImageData(0, 0, size, size).data;
  const g = source.getContext("2d", { willReadFrequently: true });
  const image = g.getImageData(0, 0, size, size);
  const px = image.data;
  const sums = new Float64Array(grid * grid), counts = new Float64Array(grid * grid);
  let total = 0, all = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    if (inside[i + 3] < 128) continue;
    const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const cell = Math.floor((y * grid) / size) * grid + Math.floor((x * grid) / size);
    sums[cell] += l; counts[cell]++; total += l; all++;
  }
  if (!all) return face;
  const mean = total / all;
  const factor = new Float64Array(grid * grid);
  for (let c = 0; c < factor.length; c++) {
    factor[c] = counts[c] > (size / grid) ** 2 * 0.15 ? Math.min(1.6, Math.max(0.7, (mean / Math.max(1, sums[c] / counts[c])) ** strength)) : 1;
  }
  // Bilinear interpolation between cell centres.
  for (let y = 0; y < size; y++) {
    const gy = Math.min(grid - 1, Math.max(0, (y * grid) / size - 0.5)), y0 = Math.floor(gy), y1 = Math.min(grid - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < size; x++) {
      const gx = Math.min(grid - 1, Math.max(0, (x * grid) / size - 0.5)), x0 = Math.floor(gx), x1 = Math.min(grid - 1, x0 + 1), fx = gx - x0;
      const f = (factor[y0 * grid + x0] * (1 - fx) + factor[y0 * grid + x1] * fx) * (1 - fy) + (factor[y1 * grid + x0] * (1 - fx) + factor[y1 * grid + x1] * fx) * fy;
      const i = (y * size + x) * 4;
      px[i] = Math.min(255, px[i] * f); px[i + 1] = Math.min(255, px[i + 1] * f); px[i + 2] = Math.min(255, px[i + 2] * f);
    }
  }
  g.putImageData(image, 0, 0);
  return face;
}

// Mean linear colour of small patches just inside the face outline, from cheek to cheek.
export function skinTone(source, landmarks) {
  const g = source.getContext("2d", { willReadFrequently: true });
  let cx = 0, cy = 0;
  for (const id of OVAL) { cx += landmarks[id * 2] / OVAL.length; cy += landmarks[id * 2 + 1] / OVAL.length; }
  const sum = [0, 0, 0];
  let n = 0;
  for (const id of RING) {
    const x = Math.round((landmarks[id * 2] * 0.8 + cx * 0.2) * source.width), y = Math.round((landmarks[id * 2 + 1] * 0.8 + cy * 0.2) * source.height);
    const r = Math.max(2, Math.round(source.width * 0.01));
    if (x - r < 0 || y - r < 0 || x + r >= source.width || y + r >= source.height) continue;
    const { data } = g.getImageData(x - r, y - r, r * 2, r * 2);
    for (let i = 0; i < data.length; i += 4) {
      sum[0] += srgbToLinear(data[i] / 255); sum[1] += srgbToLinear(data[i + 1] / 255); sum[2] += srgbToLinear(data[i + 2] / 255);
      n++;
    }
  }
  return n ? sum.map((v) => v / n) : null;
}

export function gainFor(tone, reference) {
  if (!tone) return [1, 1, 1];
  return tone.map((v, i) => Math.min(1.8, Math.max(0.45, v / reference[i])));
}

const round = (values) => [...values].map((v) => Math.round(v * 1e5) / 1e5);

export async function encode(face) {
  const blob = await face.canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  const points = { points: round(face.landmarks), depth: face.depth ? round(face.depth) : null };
  return { image: blob, points: new Blob([JSON.stringify(points)], { type: "application/json" }) };
}

export async function decode(image, points) {
  const bitmap = await createImageBitmap(image);
  const out = canvas(bitmap.width, bitmap.height);
  out.getContext("2d", { willReadFrequently: true }).drawImage(bitmap, 0, 0);
  bitmap.close();
  const saved = JSON.parse(await points.text());
  // Earlier saves are a bare landmark array without depth.
  const landmarks = Float32Array.from(Array.isArray(saved) ? saved : saved.points);
  const depth = !Array.isArray(saved) && saved.depth ? Float32Array.from(saved.depth) : null;
  const finite = (values) => values.every((v) => Number.isFinite(v));
  if (landmarks.length !== LANDMARKS * 2 || !finite(landmarks) || (depth && (depth.length !== LANDMARKS || !finite(depth)))) throw new Error("Saved face is damaged.");
  return { canvas: out, landmarks, depth };
}
