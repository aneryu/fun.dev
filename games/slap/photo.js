// Turning a picked photo into a face for the head: landmarks (MediaPipe, or five points
// placed by hand), a square crop around the face, and a skin-tone gain for the rest of the
// head. The crop and its landmarks can be remembered in deviceStorage; nothing leaves the device.
import { LANDMARKS } from "./face.js";

const CROP = 512;
// Five anchor landmarks: eye centres (corner pairs), nose tip, mouth corners.
const ANCHORS = [[33, 133], [362, 263], [1], [61], [291]];
// Cheek and forehead patches for skin tone.
const SKIN = [50, 280, 151, 118, 347];

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

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

// Crops a square around the landmarks (image 0..1) and returns { canvas, landmarks (crop 0..1) }.
export function cropFace(image, landmarks) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < LANDMARKS; i++) {
    const x = landmarks[i * 2] * image.width, y = landmarks[i * 2 + 1] * image.height;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const size = Math.max(maxX - minX, maxY - minY) * 1.3;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const sx = cx - size / 2, sy = cy - size / 2;
  const out = canvas(CROP, CROP);
  const g = out.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#808080";
  g.fillRect(0, 0, CROP, CROP);
  g.drawImage(image, sx, sy, size, size, 0, 0, CROP, CROP);
  const local = new Float32Array(LANDMARKS * 2);
  for (let i = 0; i < LANDMARKS; i++) {
    local[i * 2] = (landmarks[i * 2] * image.width - sx) / size;
    local[i * 2 + 1] = (landmarks[i * 2 + 1] * image.height - sy) / size;
  }
  return { canvas: out, landmarks: local };
}

// Mean linear colour of small patches around skin landmarks.
export function skinTone(source, landmarks) {
  const g = source.getContext("2d", { willReadFrequently: true });
  const sum = [0, 0, 0];
  let n = 0;
  for (const id of SKIN) {
    const x = Math.round(landmarks[id * 2] * source.width), y = Math.round(landmarks[id * 2 + 1] * source.height);
    const r = Math.max(2, Math.round(source.width * 0.012));
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

export async function encode(face) {
  const blob = await face.canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  return { image: blob, points: new Blob([JSON.stringify([...face.landmarks].map((v) => Math.round(v * 1e5) / 1e5))], { type: "application/json" }) };
}

export async function decode(image, points) {
  const bitmap = await createImageBitmap(image);
  const out = canvas(bitmap.width, bitmap.height);
  out.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  const landmarks = Float32Array.from(JSON.parse(await points.text()));
  if (landmarks.length !== LANDMARKS * 2 || landmarks.some((v) => !Number.isFinite(v))) throw new Error("Saved face is damaged.");
  return { canvas: out, landmarks };
}
