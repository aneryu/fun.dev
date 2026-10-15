import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createSoftBody, edgesFromTriangles } from "../softbody.js";
import { anchorsOf, defaultAnchors, extendLandmarks, landmarksFromAnchors } from "../photo.js";
import { align, fitShape, mirrors } from "../shape.js";
import { delaunay, register } from "./pack.mjs";

const root = new URL("../", import.meta.url);
const kinds = { float32: Float32Array, uint16: Uint16Array, int16: Int16Array, uint32: Uint32Array };
async function pack(name) {
  const meta = JSON.parse(await readFile(new URL(`assets/${name}.json`, root), "utf8"));
  const bin = await readFile(new URL(`assets/${name}.bin`, root));
  const arrays = {};
  for (const [key, { offset, length, type }] of Object.entries(meta.arrays)) arrays[key] = new kinds[type](bin.buffer, bin.byteOffset + offset, length);
  return { meta, arrays };
}

test("runtime files are listed in game.json, stay in the bundle and avoid the DOM", async () => {
  const manifest = JSON.parse(await readFile(new URL("game.json", root), "utf8"));
  const listed = new Set(manifest.files);
  const seen = new Set();
  async function visit(path) {
    if (seen.has(path)) return;
    seen.add(path);
    assert.ok(listed.has(path), `Not listed in game.json files: ${path}`);
    assert.ok((await stat(new URL(path, root))).isFile(), `Missing: ${path}`);
    // Vendored MediaPipe is loaded as-is; only our own modules are checked.
    if (!path.endsWith(".js") || path.startsWith("assets/lazy/mediapipe/")) return;
    const source = await readFile(new URL(path, root), "utf8");
    assert.doesNotMatch(source, /\b(?:document|window)\b|\.innerHTML|\.style\b/, `${path} must not touch the DOM`);
    for (const match of source.matchAll(/\b(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)) await visit(new URL(match[1], new URL(path, root)).href.slice(root.href.length));
    for (const match of source.matchAll(/asset\(\s*[`"']([^`"'$]+)[`"']\s*\)/g)) await visit(match[1]);
    for (const match of source.matchAll(/loadPack\(asset, "([a-z]+)"/g)) { await visit(`assets/${match[1]}.json`); await visit(`assets/${match[1]}.bin`); }
  }
  await visit("game.js");
  for (const path of listed) assert.ok(seen.has(path) || path.startsWith("assets/lazy/mediapipe/") || path === manifest.cover, `Listed but unused: ${path}`);
  assert.ok(seen.has("assets/lazy/mediapipe/vision_wasm_internal.wasm"), "MediaPipe is reachable from face.js");
});

test("head assets are consistent", async () => {
  const { meta, arrays } = await pack("head");
  const n = meta.vertices, r = arrays.renderSource.length;
  assert.equal(arrays.position.length, n * 3);
  assert.ok(arrays.renderSource.every((v) => v < n));
  assert.ok(arrays.index.every((i) => i < r));
  for (const name of meta.morphs) assert.equal(arrays[`morph_${name}`].length, n * 3);
  assert.equal(arrays.faceTriangles.length, meta.faceTriangles * 3);
  assert.ok(arrays.photoTri.every((t) => t >= -1 && t < meta.faceTriangles));
  assert.equal(arrays.landmarks3d.length, 468 * 3);
  for (let i = 0; i < n; i++) {
    if (arrays.photoTri[i] < 0) { assert.equal(arrays.photoWeight[i], 0); continue; }
    const u = arrays.photoBary[i * 2], v = arrays.photoBary[i * 2 + 1];
    assert.ok(u >= -1e-4 && v >= -1e-4 && u + v <= 1 + 1e-4);
  }
  const covered = arrays.photoWeight.filter((w) => w > 0.5).length;
  assert.ok(covered > 1500 && covered < n * 0.6, `photo covers the face and hair line only (${covered})`);
  assert.ok(arrays.cavity.some(Boolean) && arrays.cavity.filter(Boolean).length < 400);
  assert.equal(meta.skinTone.length, 3);
});

test("a slap wobbles and settles without blowing up", async () => {
  const { meta, arrays } = await pack("head");
  const n = meta.vertices;
  const triangles = Uint32Array.from(arrays.index, (i) => arrays.renderSource[i]);
  const body = createSoftBody({ rest: new Float32Array(arrays.position), triangles, stiffness: new Float32Array(n).fill(0.8), mobility: new Float32Array(n).fill(1) });
  const eye = meta.eyes[0];
  body.impulse([0.05, eye[1] - 0.05, eye[2] - 0.01], [-3, 0, -1], 0.045);
  const still = { a: [0, 0, 0], w: [0, 0, 0], al: [0, 0, 0] };
  const peak = (u) => { let m = 0; for (let i = 0; i < u.length; i += 3) m = Math.max(m, Math.hypot(u[i], u[i + 1], u[i + 2])); return m; };
  let max = 0, crossings = 0, previous = 0;
  for (let frame = 0; frame < 240; frame++) {
    body.advance(1 / 60, still);
    max = Math.max(max, peak(body.u));
    const x = body.u[arrays.position.length / 2 - (arrays.position.length / 2) % 3];
    if (Math.sign(x) !== Math.sign(previous) && previous !== 0) crossings++;
    previous = x;
  }
  assert.ok(body.u.every(Number.isFinite));
  assert.ok(max > 0.01 && max <= body.params.maxDisplacement * 1.25 + 1e-6, `peak ${max}`);
  assert.ok(peak(body.u) < 0.002, "settles within four seconds");
  assert.ok(body.energy < 1e-3);
});

test("edges are symmetric", () => {
  const { start, list } = edgesFromTriangles([0, 1, 2, 2, 1, 3], 4);
  const neighbours = (i) => [...list.slice(start[i], start[i + 1])].sort();
  assert.deepEqual(neighbours(1), [0, 2, 3]);
  assert.deepEqual(neighbours(3), [1, 2]);
});

test("five placed points recover an affine map of all landmarks", async () => {
  const { arrays } = await pack("head");
  const reference = arrays.defaultLandmarks;
  const map = ([x, y]) => [0.8 * x - 0.1 * y + 0.12, 0.05 * x + 0.7 * y + 0.2];
  const placed = anchorsOf(reference).map(map);
  const all = landmarksFromAnchors(reference, placed);
  for (let i = 0; i < 468; i++) {
    const [x, y] = map([reference[i * 2], reference[i * 2 + 1]]);
    assert.ok(Math.abs(all[i * 2] - x) < 1e-4 && Math.abs(all[i * 2 + 1] - y) < 1e-4);
  }
  for (const [x, y] of defaultAnchors(reference, [768, 1024], 1000, 600)) assert.ok(x > 0 && x < 1 && y > 0 && y < 1);
});

test("registration locates points inside the landmark triangulation", () => {
  const points = [0, 0, 1, 0, 0, 1, 1, 1, 0.5, 0.4];
  const triangles = delaunay(points);
  assert.equal(triangles.length, 4);
  const landmarks = new Float32Array(468 * 2).fill(0.5);
  landmarks.set(points);
  // Hull and face width use landmarks 234/454; place them on the square's sides.
  landmarks.set([0, 0.5], 234 * 2); landmarks.set([1, 0.5], 454 * 2);
  const { tri, bary, weight } = register(Float32Array.from([0.5, 0.45, 1, 2, 2, 1, 0.5, 0.5, 0]), landmarks, 1, triangles);
  assert.ok(tri[0] >= 0 && weight[0] > 0);
  assert.equal(tri[1], -1, "outside the face");
  assert.equal(tri[2], -1, "hidden in the frontal render");
  assert.ok(bary[0] >= 0 && bary[1] >= 0 && bary[0] + bary[1] <= 1);
});

test("photo shape: alignment recovers a similarity, mirrors pair up, a scaled photo leaves the head as is", async () => {
  const { meta, arrays } = await pack("head");
  const reference = arrays.landmarks3d;
  const angle = 0.3, scale = 4;
  const moved = new Float32Array(reference.length);
  for (let i = 0; i < 468; i++) {
    const [x, y, z] = reference.slice(i * 3, i * 3 + 3);
    moved.set([scale * (Math.cos(angle) * x + Math.sin(angle) * z) + 1, scale * y - 2, scale * (-Math.sin(angle) * x + Math.cos(angle) * z) + 3], i * 3);
  }
  const map = align(moved, reference);
  for (let i = 0; i < 468; i += 37) {
    const p = map([moved[i * 3], moved[i * 3 + 1], moved[i * 3 + 2]]);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(p[k] - reference[i * 3 + k]) < 1e-4);
  }
  const mirror = mirrors(reference);
  assert.equal(mirror[mirror[33]], 33);
  assert.ok(Math.abs(reference[mirror[33] * 3] + reference[33 * 3]) < 0.004, "left and right eye corners pair up");
  // A photo that is just a scaled copy of the reference face changes nothing.
  const landmarks = new Float32Array(468 * 2), depth = new Float32Array(468);
  for (let i = 0; i < 468; i++) { landmarks[i * 2] = reference[i * 3] * 3 + 0.5; landmarks[i * 2 + 1] = -reference[i * 3 + 1] * 3 + 0.5; depth[i] = -reference[i * 3 + 2] * 3; }
  const offsets = fitShape({ landmarks, depth, reference, vertices: arrays.position });
  assert.ok(offsets.every((v) => Math.abs(v) < 1e-4));
  assert.equal(fitShape({ landmarks, depth: null, reference, vertices: arrays.position }), null);
  assert.equal(extendLandmarks(landmarks).length, (468 + 36) * 2);
  assert.equal(meta.faceTriangles * 3, arrays.faceTriangles.length);
});
