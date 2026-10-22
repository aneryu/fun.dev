// Mesh assembly for the generator: shared vertices with skin weights, faces with per-corner UVs
// in named islands, mirroring of the left half, normals, and export to typed arrays.
//
// Pieces build the left half and the centre line (x = 0); `mirror()` adds the right half, so
// positions, topology and normals are exactly symmetric.

import { cross, normalize, sub } from "./vec.js";

const PLANE = 1e-9;

export function createBuilder() {
  const vertices = [];   // { p: [x, y, z], w: [[bone, weight], …] }
  const faces = [];      // { v: [a, b, c], island, uv: [[u, v] ×3] }

  function vertex(p, weights) {
    const q = Math.abs(p[0]) < PLANE ? [0, p[1], p[2]] : p;
    vertices.push({ p: q, w: weights });
    return vertices.length - 1;
  }

  // Outward when (b − a) × (c − a) points away from the body (counter-clockwise from outside).
  function tri(a, b, c, island, uvs, { wrap = true } = {}) { faces.push({ v: [a, b, c], island, uv: wrap ? fixWrap(uvs) : uvs }); }
  function quad(a, b, c, d, island, uvs) {
    const [ua, ub, uc, ud] = fixWrap(uvs);
    tri(a, b, c, island, [ua, ub, uc]);
    tri(a, c, d, island, [ua, uc, ud]);
  }

  /**
   * Quads between two rings of equal count, `next` further along the axis the rings turn
   * counter-clockwise about. `half` stitches only the left half of centre rings.
   */
  function stitch(ring, next, island, { half = false } = {}) {
    const n = ring.ids.length;
    if (next.ids.length !== n) throw new Error(`stitch: ${n} and ${next.ids.length} vertices`);
    const end = half ? n / 2 : n;
    for (let i = 0; i < end; i++) {
      const j = (i + 1) % n;
      quad(ring.ids[i], ring.ids[j], next.ids[j], next.ids[i], island,
        [[ring.u[i], ring.v], [ring.u[j], ring.v], [next.u[j], next.v], [next.u[i], next.v]]);
    }
  }

  /** Triangles between rings of different counts, both starting at the front. */
  function bridge(ring, next, island, { half = false } = {}) {
    const na = ring.ids.length, nb = next.ids.length;
    const ea = half ? na / 2 : na, eb = half ? nb / 2 : nb;
    let i = 0, j = 0;
    const A = (k) => ring.ids[k % na], B = (k) => next.ids[k % nb];
    const uA = (k) => [ring.u[k % na], ring.v], uB = (k) => [next.u[k % nb], next.v];
    while (i < ea || j < eb) {
      const advanceA = j >= eb || (i < ea && (i + 1) / na <= (j + 1) / nb);
      if (advanceA) { tri(A(i), A(i + 1), B(j), island, [uA(i), uA(i + 1), uB(j)]); i++; }
      else { tri(A(i), B(j + 1), B(j), island, [uA(i), uB(j + 1), uB(j)]); j++; }
    }
  }

  /** Closes a ring with a fan to `pole`, which lies further along the ring's axis. */
  function cap(ring, pole, poleV, island, { half = false } = {}) {
    const n = ring.ids.length, end = half ? n / 2 : n;
    for (let i = 0; i < end; i++) {
      const j = (i + 1) % n;
      let ui = ring.u[i], uj = ring.u[j];
      if (Math.abs(uj - ui) > 0.5) uj += uj < ui ? 1 : -1;
      tri(ring.ids[i], ring.ids[j], pole, island, [[ui, ring.v], [uj, ring.v], [(ui + uj) / 2, poleV]]);
    }
  }

  /** Adds the mirror image of every vertex off the centre plane and of every face. */
  function mirror({ flipU = () => true } = {}) {
    const map = vertices.map((v, i) => {
      if (v.p[0] === 0) return i;
      vertices.push({ p: [-v.p[0], v.p[1], v.p[2]], w: v.w.map(([b, w]) => [sideName(b), w]) });
      return vertices.length - 1;
    });
    const count = faces.length;
    for (let f = 0; f < count; f++) {
      const { v, island, uv } = faces[f];
      faces.push({ v: [map[v[0]], map[v[2]], map[v[1]]], island: sideName(island),
        uv: [uv[0], uv[2], uv[1]].map(([u, w]) => [flipU(island) ? 1 - u : u, w]) });
    }
    return map;
  }

  /**
   * Taubin smoothing (λ then μ, which keeps the volume) over the shared topology, so joins
   * between rings and segments blend instead of creasing. `strength(vertex)` scales each
   * vertex's step (0 pins it). Centre-line vertices stay on x = 0, so the mirror stays exact.
   */
  function smooth({ iterations = 8, lambda = 0.5, mu = -0.53, strength = () => 1 } = {}) {
    const neighbours = vertices.map(() => new Set());
    for (const { v } of faces) for (let k = 0; k < 3; k++) { neighbours[v[k]].add(v[(k + 1) % 3]); neighbours[v[(k + 1) % 3]].add(v[k]); }
    const lists = neighbours.map((s) => [...s].sort((a, b) => a - b));
    const s = vertices.map((v, i) => (lists[i].length ? strength(v, i) : 0));
    const step = (factor) => {
      const next = vertices.map((v, i) => {
        if (!s[i]) return v.p;
        const near = lists[i];
        const mean = [0, 0, 0];
        for (const j of near) { const q = vertices[j].p; mean[0] += q[0]; mean[1] += q[1]; mean[2] += q[2]; }
        const k = (factor * s[i]) / near.length;
        const p = v.p;
        return [p[0] === 0 ? 0 : p[0] + (mean[0] - p[0] * near.length) * k, p[1] + (mean[1] - p[1] * near.length) * k, p[2] + (mean[2] - p[2] * near.length) * k];
      });
      next.forEach((p, i) => { vertices[i].p = p; });
    };
    for (let n = 0; n < iterations; n++) { step(lambda); step(mu); }
  }

  return { vertices, faces, vertex, tri, quad, stitch, bridge, cap, mirror, smooth };
}

/** A UV seam: when a face's corners span more than half the island, lift the small ones by 1. */
function fixWrap(uvs) {
  const us = uvs.map((t) => t[0]);
  if (Math.max(...us) - Math.min(...us) <= 0.5) return uvs;
  return uvs.map(([u, v]) => [u < 0.5 ? u + 1 : u, v]);
}

export const sideName = (name) => name.replace(/^([lr])_/, (_, side) => (side === "l" ? "r_" : "l_")).replace(/\.([lr])$/, (_, side) => (side === "l" ? ".r" : ".l"));

/** Area-weighted vertex normals over the shared (welded) topology. */
export function vertexNormals(positions, indices) {
  const normals = new Float64Array(positions.length);
  for (let f = 0; f < indices.length; f += 3) {
    const a = indices[f] * 3, b = indices[f + 1] * 3, c = indices[f + 2] * 3;
    const pa = [positions[a], positions[a + 1], positions[a + 2]];
    const n = cross(sub([positions[b], positions[b + 1], positions[b + 2]], pa), sub([positions[c], positions[c + 1], positions[c + 2]], pa));
    for (const k of [a, b, c]) { normals[k] += n[0]; normals[k + 1] += n[1]; normals[k + 2] += n[2]; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const n = normalize([normals[i], normals[i + 1], normals[i + 2]]);
    normals[i] = n[0]; normals[i + 1] = n[1]; normals[i + 2] = n[2];
  }
  return normals;
}

/** At most four influences, normalised, heaviest first. */
function topWeights(list, boneIndex) {
  const merged = new Map();
  for (const [bone, w] of list) if (w > 0) merged.set(bone, (merged.get(bone) ?? 0) + w);
  const top = [...merged].sort((a, b) => b[1] - a[1] || boneIndex.get(a[0]) - boneIndex.get(b[0])).slice(0, 4);
  const sum = top.reduce((s, [, w]) => s + w, 0);
  return top.map(([bone, w]) => [boneIndex.get(bone), w / sum]);
}

/**
 * The finished mesh: `topology` is the shared-vertex mesh (normals, checks); the render arrays
 * split vertices where islands or UVs differ. `atlas` maps island → [x, y, w, h], or null for an
 * island with a texture of its own, whose UVs stay as they are (they may repeat past 1).
 */
export function exportMesh(builder, boneIndex, atlas) {
  const { vertices, faces } = builder;
  const used = new Int32Array(vertices.length).fill(-1);
  const order = [];
  for (const f of faces) for (const v of f.v) if (used[v] < 0) { used[v] = order.length; order.push(v); }
  const positions = new Float64Array(order.length * 3);
  order.forEach((v, i) => positions.set(vertices[v].p, i * 3));
  const indices = new Uint32Array(faces.length * 3);
  faces.forEach((f, k) => f.v.forEach((v, c) => { indices[k * 3 + c] = used[v]; }));
  const normals = vertexNormals(positions, indices);
  const weights = order.map((v) => {
    for (const [bone] of vertices[v].w) if (!boneIndex.has(bone)) throw new Error(`unknown bone ${bone}`);
    return topWeights(vertices[v].w, boneIndex);
  });

  const keys = new Map(), source = [], uvs = [], islandOf = [];
  const render = new Uint32Array(faces.length * 3);
  const groups = [];
  const sorted = faces.map((f, k) => k).sort((a, b) => (faces[a].island < faces[b].island ? -1 : faces[a].island > faces[b].island ? 1 : a - b));
  sorted.forEach((k, slot) => {
    const f = faces[k];
    const rect = atlas[f.island];
    if (rect === undefined) throw new Error(`no atlas rect for island ${f.island}`);
    if (!groups.length || groups.at(-1).island !== f.island) groups.push({ island: f.island, start: slot * 3, count: 0 });
    groups.at(-1).count += 3;
    f.v.forEach((v, c) => {
      const [u, w] = f.uv[c];
      const uv = rect ? [rect[0] + Math.min(1, Math.max(0, u)) * rect[2], rect[1] + Math.min(1, Math.max(0, w)) * rect[3]] : [u, w];
      const key = `${used[v]}|${f.island}|${uv[0].toFixed(6)}|${uv[1].toFixed(6)}`;
      let index = keys.get(key);
      if (index === undefined) { index = source.length; keys.set(key, index); source.push(used[v]); uvs.push(uv); islandOf.push(f.island); }
      render[slot * 3 + c] = index;
    });
  });

  const n = source.length;
  const out = {
    positions: new Float32Array(n * 3), normals: new Float32Array(n * 3), uvs: new Float32Array(n * 2),
    joints: new Uint16Array(n * 4), weights: new Float32Array(n * 4), indices: render, groups,
    source: Uint32Array.from(source),
  };
  source.forEach((t, i) => {
    out.positions.set(positions.subarray(t * 3, t * 3 + 3), i * 3);
    out.normals.set(normals.subarray(t * 3, t * 3 + 3), i * 3);
    out.uvs.set(uvs[i], i * 2);
    weights[t].forEach(([bone, w], k) => { out.joints[i * 4 + k] = bone; out.weights[i * 4 + k] = w; });
  });
  return {
    ...out,
    topology: { positions, normals, indices, weights, islands: faces.map((f) => f.island), vertexOf: Int32Array.from(used) },
  };
}
