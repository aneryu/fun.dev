// Packs dev/out (Blender export + default-face landmarks) into the game's runtime assets.
//
// Photo registration: every head/eye vertex visible in the frontal render is located in a
// Delaunay triangle of the default face's landmarks. A player's photo then maps onto the
// head by reusing those barycentric weights with the photo's own landmarks.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const game = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(game, "dev/out");
const FEATHER = 0.09; // Photo fades in over this fraction of the face width from the face outline.

function readBlob(meta, bin) {
  const arrays = {};
  const kinds = { float32: Float32Array, uint16: Uint16Array, int16: Int16Array, uint32: Uint32Array };
  for (const [name, { offset, length, type }] of Object.entries(meta.arrays)) {
    arrays[name] = new kinds[type](bin.buffer, bin.byteOffset + offset, length);
  }
  return arrays;
}

export function delaunay(points) {
  const n = points.length / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, points[i * 2]); maxX = Math.max(maxX, points[i * 2]);
    minY = Math.min(minY, points[i * 2 + 1]); maxY = Math.max(maxY, points[i * 2 + 1]);
  }
  const size = Math.max(maxX - minX, maxY - minY) * 20;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const px = [...Array.from({ length: n }, (_, i) => points[i * 2]), cx - size, cx, cx + size];
  const py = [...Array.from({ length: n }, (_, i) => points[i * 2 + 1]), cy - size, cy + size, cy - size];
  const circum = (a, b, c) => {
    const ax = px[a], ay = py[a], bx = px[b], by = py[b], cx2 = px[c], cy2 = py[c];
    const d = 2 * (ax * (by - cy2) + bx * (cy2 - ay) + cx2 * (ay - by));
    const ux = ((ax * ax + ay * ay) * (by - cy2) + (bx * bx + by * by) * (cy2 - ay) + (cx2 * cx2 + cy2 * cy2) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx2 - bx) + (bx * bx + by * by) * (ax - cx2) + (cx2 * cx2 + cy2 * cy2) * (bx - ax)) / d;
    return { a, b, c, x: ux, y: uy, r: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris = [circum(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const bad = tris.filter((t) => (px[i] - t.x) ** 2 + (py[i] - t.y) ** 2 < t.r);
    const edges = new Map();
    for (const t of bad) {
      for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        edges.set(key, edges.has(key) ? null : [u, v]);
      }
    }
    tris = tris.filter((t) => !bad.includes(t));
    for (const edge of edges.values()) if (edge) tris.push(circum(edge[0], edge[1], i));
  }
  return tris.filter((t) => t.a < n && t.b < n && t.c < n).map((t) => [t.a, t.b, t.c]);
}

function barycentric(x, y, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
  const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
  return [u, v, 1 - u - v];
}

function segmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

// Registers image-space points (x, y in 0..1, visibility) against the landmark triangulation.
export function register(front, landmarks, aspect, triangles, depth = null) {
  const P = (i) => [landmarks[i * 2] * aspect, landmarks[i * 2 + 1]];
  // Hull edges are triangle edges used once.
  const count = new Map();
  for (const t of triangles) for (const [u, v] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
    const key = u < v ? `${u},${v}` : `${v},${u}`;
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  const hull = [...count].filter(([, c]) => c === 1).map(([key]) => key.split(",").map(Number));
  const faceWidth = Math.hypot(P(234)[0] - P(454)[0], P(234)[1] - P(454)[1]);
  const vertices = front.length / 3;
  const tri = new Int16Array(vertices).fill(-1);
  const bary = new Float32Array(vertices * 2);
  const weight = new Float32Array(vertices);
  for (let v = 0; v < vertices; v++) {
    // Hidden in the frontal render: skip the back of the head, but keep folds and creases of the face.
    if (front[v * 3 + 2] < 0.5 && !(depth && depth[v] > 0)) continue;
    const x = front[v * 3] * aspect, y = front[v * 3 + 1];
    for (let t = 0; t < triangles.length; t++) {
      const [a, b, c] = triangles[t];
      const [u, w, z] = barycentric(x, y, ...P(a), ...P(b), ...P(c));
      if (u >= -1e-6 && w >= -1e-6 && z >= -1e-6) {
        tri[v] = t; bary[v * 2] = u; bary[v * 2 + 1] = w;
        let edge = Infinity;
        for (const [p, q] of hull) edge = Math.min(edge, segmentDistance(x, y, ...P(p), ...P(q)));
        const s = Math.min(1, edge / faceWidth / FEATHER);
        weight[v] = s * s * (3 - 2 * s);
        break;
      }
    }
  }
  return { tri, bary, weight };
}

class Writer {
  constructor() { this.parts = []; this.size = 0; this.arrays = {}; }
  add(name, array) {
    if (this.size % 4) { const pad = 4 - (this.size % 4); this.parts.push(Buffer.alloc(pad)); this.size += pad; }
    const type = { Float32Array: "float32", Uint16Array: "uint16", Int16Array: "int16", Uint32Array: "uint32" }[array.constructor.name];
    this.arrays[name] = { offset: this.size, length: array.length, type };
    const buffer = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    this.parts.push(buffer); this.size += buffer.length;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const meta = JSON.parse(await readFile(join(out, "head.json"), "utf8"));
  const arrays = readBlob(meta, await readFile(join(out, "head.bin")));
  const { width, height, points, tone } = JSON.parse(await readFile(join(out, "landmarks.json"), "utf8"));
  const aspect = width / height;
  const triangles = delaunay(points.map((value, i) => (i % 2 ? value : value * aspect)));
  const writer = new Writer();
  const skip = new Set(["front", "eyes_front", "brows_front", "lashes_front"]);
  for (const [name, array] of Object.entries(arrays)) if (!skip.has(name)) writer.add(name, array);
  writer.add("faceTriangles", Uint16Array.from(triangles.flat()));
  // Mouth cavity: hidden in the frontal render and close to the lips.
  const lips = arrays.group_lips, pos = arrays.position;
  const centre = [0, 0, 0]; let lipCount = 0;
  for (let i = 0; i < meta.vertices; i++) if (lips[i] > 0.5) { for (let k = 0; k < 3; k++) centre[k] += pos[i * 3 + k]; lipCount++; }
  centre.forEach((v, k) => { centre[k] = v / lipCount; });
  const cavity = new Float32Array(meta.vertices);
  for (let i = 0; i < meta.vertices; i++) {
    const d = Math.hypot(pos[i * 3] - centre[0], pos[i * 3 + 1] - centre[1], pos[i * 3 + 2] - centre[2]);
    if (arrays.front[i * 3 + 2] < 0.5 && d < 0.035) cavity[i] = 1;
  }
  // Front of the face: within 5 cm of the eyes' depth (game +Z faces the camera).
  const eyeZ = (meta.eyes[0][2] + meta.eyes[1][2]) / 2;
  const facing = Float32Array.from({ length: meta.vertices }, (_, i) => (arrays.position[i * 3 + 2] > eyeZ - 0.05 && cavity[i] !== 1 ? 1 : 0));
  const head = register(arrays.front, points, aspect, triangles, facing);
  writer.add("cavity", cavity);
  writer.add("photoTri", head.tri); writer.add("photoBary", head.bary); writer.add("photoWeight", head.weight);
  const eyes = register(arrays.eyes_front, points, aspect, triangles);
  // Visible eyeballs show the photo's eyes in full; the eyelids already blend at the lid edge.
  eyes.weight.forEach((w, i) => { eyes.weight[i] = eyes.tri[i] >= 0 ? 1 : 0; });
  writer.add("eyes_photoTri", eyes.tri); writer.add("eyes_photoBary", eyes.bary); writer.add("eyes_photoWeight", eyes.weight);
  // Skin-tone reference: the default face's landmarks, for sampling matching regions of a photo.
  writer.add("defaultLandmarks", Float32Array.from(points));
  const covered = [...head.weight].filter((w) => w > 0).length;
  await writeFile(join(game, "assets/head.bin"), Buffer.concat(writer.parts));
  await writeFile(join(game, "assets/head.json"), JSON.stringify({ ...meta, faceTriangles: triangles.length, frontSize: [width, height], skinTone: tone, arrays: writer.arrays }));
  const handMeta = JSON.parse(await readFile(join(out, "hand.json"), "utf8"));
  await writeFile(join(game, "assets/hand.bin"), await readFile(join(out, "hand.bin")));
  await writeFile(join(game, "assets/hand.json"), JSON.stringify(handMeta));
  console.log(`hand: ${handMeta.vertices} vertices`);
  console.log(`head: ${meta.vertices} vertices, ${covered} take the photo, ${cavity.filter((v) => v > 0.5).length} in the mouth, ${triangles.length} landmark triangles, ${(writer.size / 1024).toFixed(0)} KB`);
}
