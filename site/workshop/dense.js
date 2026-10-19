// Dense meshes (docs/model-editor.md "Dense meshes and sculpting"): the workshop's polygon
// mesh held in typed arrays, for parts with many faces (sculpted heads, rocks, imported scans).
// It is the same mesh as { vertices, faces }: face IDs are f0, f1, … in order, every face keeps
// its corners and material, coordinates stay doubles, so packing and unpacking lose nothing.
//
//   dense: {
//     positions: Float64Array(3 · V)    x, y, z per vertex
//     offsets: Uint32Array(F + 1)        face f has corners indices[offsets[f] … offsets[f+1])
//     indices: Uint32Array               vertex index per corner
//     materials: [id, …]                 the materials faces use
//     faceMaterials: Uint8Array(F)       index into materials per face
//   }
//
// A dense mesh is a DenseMesh: its typed arrays are never changed in place (an edit makes new
// arrays for what it changes and shares the rest), so copies, undo steps and caches share them.
// `vertices` and `faces` read a frozen polygon view, unpacked on first use and kept for a few
// meshes, so code written for polygon meshes reads dense ones unchanged (slowly); the hot paths
// (validation, counts, bounds, tokens, rendering, export, shape edits and sculpting) read the
// arrays. Writing through the view throws: an edit unpacks the mesh (unpackMesh) or makes a
// new DenseMesh. In JSON a dense mesh is { dense: { positions: "<base64>", … } }, little-endian.
import { fail, normal, triangulate } from "./mesh.js";

// Meshes are stored dense above this many faces or vertices when their face IDs run f0, f1, …
// in order; meshes beyond the polygon budget are always dense (their faces renumbered).
export const DENSE_FROM = 16384;

const VIEW_CACHE = 3;
const views = new Map(); // DenseMesh → frozen { vertices, faces }, least recently used first

export class DenseMesh {
  constructor(dense) {
    this.dense = dense;
  }
  get vertices() {
    return polygonView(this).vertices;
  }
  get faces() {
    return polygonView(this).faces;
  }
  toJSON() {
    return { dense: encodeDense(this.dense) };
  }
}
export const isDense = (mesh) => mesh instanceof DenseMesh || !!mesh?.dense;

function polygonView(mesh) {
  let view = views.get(mesh);
  if (view) {
    views.delete(mesh);
    views.set(mesh, view);
    return view;
  }
  view = unpackData(mesh.dense, true);
  views.set(mesh, view);
  while (views.size > VIEW_CACHE) views.delete(views.keys().next().value);
  return view;
}

const vertexCount = (d) => d.positions.length / 3;
const faceCount = (d) => d.offsets.length - 1;

// Polygon form: { vertices: [[x, y, z]…], faces: [{ id: "f0", vertices, material }…] }.
function unpackData(d, frozen = false) {
  const V = vertexCount(d),
    F = faceCount(d),
    p = d.positions,
    vertices = new Array(V),
    faces = new Array(F);
  for (let i = 0; i < V; i++) {
    const v = [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
    vertices[i] = frozen ? Object.freeze(v) : v;
  }
  for (let f = 0; f < F; f++) {
    const corners = Array.from(d.indices.subarray(d.offsets[f], d.offsets[f + 1]));
    const face = { id: `f${f}`, vertices: frozen ? Object.freeze(corners) : corners, material: d.materials[d.faceMaterials[f]] };
    faces[f] = frozen ? Object.freeze(face) : face;
  }
  return frozen ? Object.freeze({ vertices: Object.freeze(vertices), faces: Object.freeze(faces) }) : { vertices, faces };
}
export const unpackMesh = (mesh) => (isDense(mesh) ? unpackData(denseData(mesh)) : mesh);
export const denseData = (mesh) => (mesh instanceof DenseMesh ? mesh.dense : mesh.dense);

// Face IDs f0, f1, … in order: the dense form keeps them as indices.
export function canonicalIds(faces) {
  for (let f = 0; f < faces.length; f++) if (faces[f].id !== `f${f}`) return false;
  return true;
}

// A polygon mesh as a DenseMesh; renumber gives its faces IDs f0, f1, … (else they must be).
export function packMesh(mesh, { renumber = false } = {}) {
  if (isDense(mesh)) return mesh instanceof DenseMesh ? mesh : new DenseMesh(mesh.dense);
  if (!renumber && !canonicalIds(mesh.faces)) fail("Dense meshes number their faces f0, f1, … in order");
  const V = mesh.vertices.length,
    F = mesh.faces.length,
    positions = new Float64Array(3 * V),
    offsets = new Uint32Array(F + 1);
  for (let i = 0; i < V; i++) positions.set(mesh.vertices[i], 3 * i);
  let corners = 0;
  for (let f = 0; f < F; f++) {
    corners += mesh.faces[f].vertices.length;
    offsets[f + 1] = corners;
  }
  const indices = new Uint32Array(corners),
    materials = [],
    slot = new Map(),
    faceMaterials = new Uint8Array(F);
  for (let f = 0; f < F; f++) {
    const face = mesh.faces[f];
    indices.set(face.vertices, offsets[f]);
    if (!slot.has(face.material)) {
      slot.set(face.material, materials.length);
      materials.push(face.material);
    }
    faceMaterials[f] = slot.get(face.material);
  }
  return new DenseMesh({ positions, offsets, indices, materials, faceMaterials });
}

// ---- Checks, counts and tokens: computed once per array (the arrays never change) ----
const checkedPositions = new WeakSet(),
  checkedTopology = new WeakMap(); // indices array → vertex count it was checked against
const triangleCounts = new WeakMap();

// Throws unless the arrays describe a valid mesh using materials from `materialIds`.
export function checkDense(d, materialIds, path = "mesh") {
  if (!(d.positions instanceof Float64Array) || d.positions.length % 3 || d.positions.length < 9)
    fail("A dense mesh needs at least three x, y, z positions (Float64)", `${path}.positions`);
  if (!(d.offsets instanceof Uint32Array) || d.offsets.length < 2 || d.offsets[0] !== 0)
    fail("A dense mesh needs face offsets starting at 0", `${path}.offsets`);
  if (!(d.indices instanceof Uint32Array) || d.indices.length !== d.offsets[d.offsets.length - 1])
    fail("Dense mesh corners and offsets disagree", `${path}.indices`);
  if (!(d.faceMaterials instanceof Uint8Array) || d.faceMaterials.length !== faceCount(d))
    fail("A dense mesh needs one material slot per face", `${path}.faceMaterials`);
  if (!Array.isArray(d.materials) || !d.materials.length || d.materials.length > 256)
    fail("A dense mesh lists its materials", `${path}.materials`);
  for (const m of d.materials) if (!materialIds.has(m)) fail(`Unknown material: ${m}`, `${path}.materials`);
  for (let f = 0; f < d.faceMaterials.length; f++)
    if (d.faceMaterials[f] >= d.materials.length) fail("A face's material slot is out of range", `${path}.faceMaterials`);
  if (!checkedPositions.has(d.positions)) {
    const p = d.positions;
    for (let i = 0; i < p.length; i++)
      if (!(Math.abs(p[i]) <= 10000)) fail("Expected three finite coordinates within ±10000", `${path}.positions`);
    checkedPositions.add(d.positions);
  }
  const V = vertexCount(d);
  if (checkedTopology.get(d.indices) !== V || !checkedTopology.has(d.offsets)) {
    const { offsets, indices } = d;
    for (let f = 0; f + 1 < offsets.length; f++) {
      const a = offsets[f],
        b = offsets[f + 1];
      if (b - a < 3 || b - a > 64) fail("Faces need 3–64 vertex indices", `${path}.offsets`);
      for (let k = a; k < b; k++) {
        if (indices[k] >= V) fail("Invalid face vertex index", `${path}.indices`);
        for (let j = a; j < k; j++) if (indices[j] === indices[k]) fail("Invalid face vertex index", `${path}.indices`);
      }
    }
    checkedTopology.set(d.indices, V);
    checkedTopology.set(d.offsets, V);
  }
}

export function denseCounts(mesh) {
  const d = denseData(mesh);
  let triangles = triangleCounts.get(d.offsets);
  if (triangles === undefined) {
    triangles = 0;
    for (let f = 0; f + 1 < d.offsets.length; f++) triangles += d.offsets[f + 1] - d.offsets[f] - 2;
    triangleCounts.set(d.offsets, triangles);
  }
  return { vertices: vertexCount(d), faces: faceCount(d), triangles };
}

// FNV-1a over the arrays' bytes, two lanes; cached per array.
const hashes = new WeakMap();
function hashArray(array) {
  let h = hashes.get(array);
  if (h) return h;
  const words = new Uint32Array(array.buffer, array.byteOffset, array.byteLength >> 2);
  let a = 2166136261,
    b = 5381;
  for (let i = 0; i < words.length; i++) {
    a = Math.imul(a ^ words[i], 16777619);
    b = (Math.imul(b, 33) ^ words[i]) | 0;
  }
  for (let i = words.length << 2; i < array.byteLength; i++) {
    const byte = new Uint8Array(array.buffer, array.byteOffset + i, 1)[0];
    a = Math.imul(a ^ byte, 16777619);
  }
  h = `${(a >>> 0).toString(16)}${((b >>> 0) % 65521).toString(16)}`;
  hashes.set(array, h);
  return h;
}
// The token of a dense mesh's geometry (positions and faces) and of its connectivity alone.
export const denseToken = (mesh) => {
  const d = denseData(mesh);
  return `d-${hashArray(d.positions)}-${hashArray(d.offsets)}-${hashArray(d.indices)}`;
};
export const denseConnectivity = (mesh) => {
  const d = denseData(mesh);
  return `c-${vertexCount(d)}-${hashArray(d.offsets)}-${hashArray(d.indices)}`;
};

export function denseBounds(positions, indices = null) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  const visit = (i) => {
    for (let k = 0; k < 3; k++) {
      const v = positions[3 * i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  };
  if (indices) for (const i of indices) visit(i);
  else for (let i = 0; i < positions.length / 3; i++) visit(i);
  if (min[0] === Infinity) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  return { min, max, size: [0, 1, 2].map((k) => max[k] - min[k]), center: [0, 1, 2].map((k) => (min[k] + max[k]) / 2) };
}

// ---- JSON and binary encodings ----
const KINDS = { positions: Float64Array, offsets: Uint32Array, indices: Uint32Array, faceMaterials: Uint8Array };
const bytesOf = (array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
export function toBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
function fromBase64(text, path) {
  if (typeof text !== "string") fail("Expected base64 data", path);
  if (typeof Buffer !== "undefined") {
    const b = Buffer.from(text, "base64");
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  let binary;
  try {
    binary = atob(text);
  } catch {
    fail("Invalid base64 data", path);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
if (!littleEndian) throw new Error("Dense meshes need a little-endian platform");

export function encodeDense(d) {
  return {
    positions: toBase64(bytesOf(d.positions)),
    offsets: toBase64(bytesOf(d.offsets)),
    indices: toBase64(bytesOf(d.indices)),
    materials: [...d.materials],
    faceMaterials: toBase64(bytesOf(d.faceMaterials)),
  };
}
// Typed arrays from base64 strings, typed arrays, plain number arrays or { bufferView } refs
// resolved by `resolve` (project files).
export function decodeDense(input, path = "mesh.dense", resolve = null) {
  if (!input || typeof input !== "object") fail("Invalid dense mesh", path);
  const out = { materials: input.materials };
  for (const [key, Kind] of Object.entries(KINDS)) {
    let value = input[key];
    if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !Array.isArray(value) && resolve) value = resolve(value, `${path}.${key}`);
    if (value instanceof Kind) out[key] = value;
    else if (typeof value === "string" || value instanceof Uint8Array) {
      const bytes = typeof value === "string" ? fromBase64(value, `${path}.${key}`) : value;
      if (bytes.byteLength % Kind.BYTES_PER_ELEMENT) fail("Dense mesh data has a partial element", `${path}.${key}`);
      // Copy into an aligned buffer of its own.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      out[key] = new Kind(copy.buffer);
    } else if (Array.isArray(value)) out[key] = Kind.from(value);
    else fail(`Dense mesh ${key} is missing`, `${path}.${key}`);
  }
  return out;
}
export const denseBytes = (d) => d.positions.byteLength + d.offsets.byteLength + d.indices.byteLength + d.faceMaterials.byteLength;

// ---- Geometry on the arrays ----
// Triangles for drawing and checks: triangles as they are, quads split along the shorter
// diagonal, larger faces by the polygon triangulation. Returns { triangles: Uint32Array(3T),
// faces: Uint32Array(T) } (the face of each triangle). Cached per topology and positions.
const triangleCache = new WeakMap();
export function denseTriangles(mesh) {
  const d = denseData(mesh);
  let entry = triangleCache.get(d.indices);
  if (entry && entry.positions === d.positions) return entry.result;
  const { positions: p, offsets, indices } = d,
    F = faceCount(d),
    { triangles: T } = denseCounts(mesh),
    triangles = new Uint32Array(3 * T),
    faces = new Uint32Array(T);
  let t = 0;
  const put = (f, a, b, c) => {
    triangles[3 * t] = a;
    triangles[3 * t + 1] = b;
    triangles[3 * t + 2] = c;
    faces[t++] = f;
  };
  const d2 = (a, b) => (p[3 * a] - p[3 * b]) ** 2 + (p[3 * a + 1] - p[3 * b + 1]) ** 2 + (p[3 * a + 2] - p[3 * b + 2]) ** 2;
  for (let f = 0; f < F; f++) {
    const a = offsets[f],
      n = offsets[f + 1] - a;
    if (n === 3) put(f, indices[a], indices[a + 1], indices[a + 2]);
    else if (n === 4) {
      const [i0, i1, i2, i3] = [indices[a], indices[a + 1], indices[a + 2], indices[a + 3]];
      if (d2(i0, i2) <= d2(i1, i3)) {
        put(f, i0, i1, i2);
        put(f, i0, i2, i3);
      } else {
        put(f, i0, i1, i3);
        put(f, i1, i2, i3);
      }
    } else {
      const corner = Array.from(indices.subarray(a, a + n)),
        local = corner.map((i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]]),
        ids = corner.map((_, k) => k);
      let tris;
      try {
        tris = triangulate(local, ids);
      } catch {
        tris = ids.slice(1, -1).map((k) => [0, k, k + 1]);
      }
      for (const [x, y, z] of tris) put(f, corner[x], corner[y], corner[z]);
    }
  }
  const result = { triangles: t === T ? triangles : triangles.subarray(0, 3 * t), faces: t === T ? faces : faces.subarray(0, t) };
  triangleCache.set(d.indices, { positions: d.positions, result });
  return result;
}

// Unit normal per face (Newell), and the face's area.
export function denseFaceNormals(mesh) {
  const { positions: p, offsets, indices } = denseData(mesh),
    F = offsets.length - 1,
    normals = new Float64Array(3 * F),
    areas = new Float64Array(F);
  for (let f = 0; f < F; f++) {
    let nx = 0,
      ny = 0,
      nz = 0;
    const a = offsets[f],
      b = offsets[f + 1];
    for (let k = a; k < b; k++) {
      const i = indices[k],
        j = indices[k + 1 < b ? k + 1 : a];
      nx += (p[3 * i + 1] - p[3 * j + 1]) * (p[3 * i + 2] + p[3 * j + 2]);
      ny += (p[3 * i + 2] - p[3 * j + 2]) * (p[3 * i] + p[3 * j]);
      nz += (p[3 * i] - p[3 * j]) * (p[3 * i + 1] + p[3 * j + 1]);
    }
    const l = Math.hypot(nx, ny, nz);
    areas[f] = l / 2;
    if (l > 0) {
      normals[3 * f] = nx / l;
      normals[3 * f + 1] = ny / l;
      normals[3 * f + 2] = nz / l;
    }
  }
  return { normals, areas };
}

// Faces around each vertex (CSR): faces of vertex v are around.faces[around.offsets[v] …].
const aroundCache = new WeakMap();
export function vertexFaces(mesh) {
  const d = denseData(mesh);
  let around = aroundCache.get(d.indices);
  if (around && around.V === vertexCount(d)) return around;
  const V = vertexCount(d),
    { offsets, indices } = d,
    counts = new Uint32Array(V + 1);
  for (let k = 0; k < indices.length; k++) counts[indices[k] + 1]++;
  for (let v = 0; v < V; v++) counts[v + 1] += counts[v];
  const faces = new Uint32Array(indices.length),
    fill = counts.slice(0, V);
  for (let f = 0; f + 1 < offsets.length; f++) for (let k = offsets[f]; k < offsets[f + 1]; k++) faces[fill[indices[k]]++] = f;
  around = { V, offsets: counts, faces };
  aroundCache.set(d.indices, around);
  return around;
}

// Neighbouring vertices of each vertex along face edges (CSR), each listed once.
const neighbourCache = new WeakMap();
export function vertexNeighbours(mesh) {
  const d = denseData(mesh);
  let result = neighbourCache.get(d.indices);
  if (result && result.V === vertexCount(d)) return result;
  const V = vertexCount(d),
    { offsets: fo, indices } = d,
    lists = Array.from({ length: V }, () => []);
  for (let f = 0; f + 1 < fo.length; f++) {
    const a = fo[f],
      b = fo[f + 1];
    for (let k = a; k < b; k++) {
      const i = indices[k],
        j = indices[k + 1 < b ? k + 1 : a];
      if (!lists[i].includes(j)) lists[i].push(j);
      if (!lists[j].includes(i)) lists[j].push(i);
    }
  }
  const offsets = new Uint32Array(V + 1);
  for (let v = 0; v < V; v++) offsets[v + 1] = offsets[v] + lists[v].length;
  const neighbours = new Uint32Array(offsets[V]);
  for (let v = 0; v < V; v++) neighbours.set(lists[v], offsets[v]);
  // Vertices on an open edge (one face) follow their rim neighbours only when smoothing.
  const edgeFaces = new Map(),
    rim = new Uint8Array(V);
  for (let f = 0; f + 1 < fo.length; f++) {
    const a = fo[f],
      b = fo[f + 1];
    for (let k = a; k < b; k++) {
      const i = indices[k],
        j = indices[k + 1 < b ? k + 1 : a],
        key = i < j ? i * V + j : j * V + i;
      edgeFaces.set(key, (edgeFaces.get(key) ?? 0) + 1);
    }
  }
  const rimLists = Array.from({ length: V }, () => null);
  for (const [key, count] of edgeFaces)
    if (count === 1) {
      const i = Math.floor(key / V),
        j = key - i * V;
      rim[i] = rim[j] = 1;
      (rimLists[i] ??= []).push(j);
      (rimLists[j] ??= []).push(i);
    }
  result = { V, offsets, neighbours, rim, rimLists, edges: edgeFaces.size, openEdges: [...edgeFaces.values()].filter((c) => c === 1).length, nonmanifoldEdges: [...edgeFaces.values()].filter((c) => c > 2).length };
  neighbourCache.set(d.indices, result);
  return result;
}

// Area-weighted vertex normals.
export function denseVertexNormals(mesh) {
  const d = denseData(mesh),
    { normals: fn, areas } = denseFaceNormals(mesh),
    V = vertexCount(d),
    out = new Float64Array(3 * V);
  const { offsets, indices } = d;
  for (let f = 0; f + 1 < offsets.length; f++)
    for (let k = offsets[f]; k < offsets[f + 1]; k++) {
      const v = indices[k];
      out[3 * v] += fn[3 * f] * areas[f];
      out[3 * v + 1] += fn[3 * f + 1] * areas[f];
      out[3 * v + 2] += fn[3 * f + 2] * areas[f];
    }
  for (let v = 0; v < V; v++) {
    const l = Math.hypot(out[3 * v], out[3 * v + 1], out[3 * v + 2]);
    if (l > 0) for (let k = 0; k < 3; k++) out[3 * v + k] /= l;
    else out[3 * v + 1] = 1;
  }
  return out;
}

// A new DenseMesh with new positions (the faces shared).
export const withPositions = (mesh, positions) => new DenseMesh({ ...denseData(mesh), positions });

// Normal of one face of a dense mesh, as the polygon code computes it (for checks).
export function denseFaceNormal(mesh, f) {
  const { positions: p, offsets, indices } = denseData(mesh),
    ids = Array.from(indices.subarray(offsets[f], offsets[f + 1]));
  return normal(
    ids.map((i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]]),
    ids.map((_, k) => k),
  );
}

// ---- Edits that make new meshes ----
// A dense mesh under an affine matrix (column-major 4×4): new positions, and faces turned
// round when the matrix mirrors (as transformMesh does for polygon meshes).
export function transformedDense(mesh, m) {
  const d = denseData(mesh),
    p = d.positions,
    out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i],
      y = p[i + 1],
      z = p[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det >= 0) return new DenseMesh({ ...d, positions: out });
  const indices = new Uint32Array(d.indices.length);
  for (let f = 0; f + 1 < d.offsets.length; f++) {
    const a = d.offsets[f],
      b = d.offsets[f + 1];
    for (let k = a; k < b; k++) indices[k] = d.indices[a + b - 1 - k];
  }
  return new DenseMesh({ ...d, positions: out, indices });
}

// A dense mesh with independent arrays (reads handed to agents never share the document's).
export const isolate = (mesh) => {
  const d = denseData(mesh);
  return new DenseMesh({
    positions: d.positions.slice(),
    offsets: d.offsets.slice(),
    indices: d.indices.slice(),
    materials: [...d.materials],
    faceMaterials: d.faceMaterials.slice(),
  });
};

// Materials the faces really use (draw calls), cached per face-material array.
const usedCache = new WeakMap();
export function usedMaterials(mesh) {
  const d = denseData(mesh);
  let used = usedCache.get(d.faceMaterials);
  if (!used) {
    const seen = new Set(d.faceMaterials);
    used = [...seen].sort((a, b) => a - b).map((slot) => d.materials[slot]);
    usedCache.set(d.faceMaterials, used);
  }
  return used;
}

// Edge census for validation: open edges (one face), non-manifold or inconsistently wound
// edges (more than two faces, or two faces running the same way). Cached per topology.
const edgeCache = new WeakMap();
export function denseEdges(mesh) {
  const d = denseData(mesh);
  let result = edgeCache.get(d.indices);
  if (result && result.V === vertexCount(d)) return result;
  const V = vertexCount(d),
    { offsets, indices } = d,
    count = new Map(),
    balance = new Map();
  for (let f = 0; f + 1 < offsets.length; f++) {
    const a = offsets[f],
      b = offsets[f + 1];
    for (let k = a; k < b; k++) {
      const i = indices[k],
        j = indices[k + 1 < b ? k + 1 : a],
        key = i < j ? i * V + j : j * V + i;
      count.set(key, (count.get(key) ?? 0) + 1);
      balance.set(key, (balance.get(key) ?? 0) + (i < j ? 1 : -1));
    }
  }
  let open = 0,
    nonmanifold = 0;
  for (const [key, c] of count) {
    if (c === 1) open++;
    else if (c > 2 || balance.get(key) !== 0) nonmanifold++;
  }
  result = { V, edges: count.size, open, nonmanifold };
  edgeCache.set(d.indices, result);
  return result;
}

// Positions as [x, y, z] arrays and back, for code written for polygon meshes.
export function positionArrays(positions) {
  const out = new Array(positions.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
  return out;
}
export function flatPositions(vertices) {
  const out = new Float64Array(3 * vertices.length);
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    out[3 * i] = v[0];
    out[3 * i + 1] = v[1];
    out[3 * i + 2] = v[2];
  }
  return out;
}
// Vertex indices of faces given by ID (f<index>), for selections on dense meshes.
export function denseFaceIndex(mesh, id) {
  const f = typeof id === "string" && /^f\d+$/.test(id) ? Number(id.slice(1)) : -1;
  if (!(f >= 0 && f < faceCount(denseData(mesh)))) fail(`Unknown face: ${id}`);
  return f;
}
export function denseFaceCorners(mesh, f) {
  const d = denseData(mesh);
  return Array.from(d.indices.subarray(d.offsets[f], d.offsets[f + 1]));
}

// transformedDense for mirrors and linked copies, which are rebuilt after every edit: the same
// source mesh under the same matrix gives the same result object, so unrelated edits share it.
const transformCache = new WeakMap();
export function transformedDenseCached(mesh, m) {
  const key = m.join(","),
    hit = transformCache.get(mesh);
  if (hit && hit.key === key) return hit.result;
  const result = transformedDense(mesh, m);
  transformCache.set(mesh, { key, result });
  return result;
}

// Drops material slots no face uses, renumbering the rest.
export function compactDenseMaterials(d) {
  const used = new Uint8Array(d.materials.length);
  for (let f = 0; f < d.faceMaterials.length; f++) used[d.faceMaterials[f]] = 1;
  if (used.every(Boolean)) return d;
  const remap = new Uint8Array(d.materials.length),
    materials = [];
  d.materials.forEach((m, slot) => {
    if (used[slot]) {
      remap[slot] = materials.length;
      materials.push(m);
    }
  });
  return { ...d, materials, faceMaterials: d.faceMaterials.map((slot) => remap[slot]) };
}
// Whether vertices a and b share a face edge (edge keys "a:b" of dense selections).
export function denseEdgeExists(mesh, a, b) {
  const d = denseData(mesh),
    around = vertexFaces(mesh);
  if (!(a < around.V && b < around.V)) return false;
  for (let k = around.offsets[a]; k < around.offsets[a + 1]; k++) {
    const f = around.faces[k],
      s = d.offsets[f],
      e = d.offsets[f + 1];
    for (let c = s; c < e; c++) {
      const i = d.indices[c],
        j = d.indices[c + 1 < e ? c + 1 : s];
      if ((i === a && j === b) || (i === b && j === a)) return true;
    }
  }
  return false;
}

// Face offsets and corner indices (CSR) of polygon faces, as packMesh lays them out.
export function topologyArrays(faces) {
  const offsets = new Uint32Array(faces.length + 1);
  for (let f = 0; f < faces.length; f++) offsets[f + 1] = offsets[f] + faces[f].vertices.length;
  const indices = new Uint32Array(offsets[faces.length]);
  for (let f = 0; f < faces.length; f++) indices.set(faces[f].vertices, offsets[f]);
  return { offsets, indices };
}
