// A small character data set for tests, made from the repository's male body: a top cut from its
// own torso and offset 1 cm outward, and three faces and the feature morphs as smooth deltas on its
// head. It exercises the generator's garment and face machinery on known shapes.
import { DEFAULT_DATA, FEATURES } from "../../site/runtime/kit/character.js";

const base = DEFAULT_DATA.shapes.m;
const shape = base;
const TORSO = [1.05, 1.4];   // the top covers the trunk between these heights

const sub = (a, b) => a.map((v, k) => v - b[k]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const mirrorBone = (bone) => bone.replace(/^([lr])_/, (_, s) => (s === "l" ? "r_" : "l_"));

/** The top at one LOD: the body's trunk faces there (both halves), 1 cm out; and the left-half faces it hides. */
function top(level) {
  const trunk = level.f.map((t, k) => [t, k]).filter(([t]) => t.every((i) => { const [x, y] = level.p[i]; return y > TORSO[0] && y < TORSO[1] && x < 0.22; }));
  const normals = level.p.map(() => [0, 0, 0]);
  for (const [t] of trunk) { const n = cross(sub(level.p[t[1]], level.p[t[0]]), sub(level.p[t[2]], level.p[t[0]])); for (const i of t) normals[i] = normals[i].map((v, k) => v + n[k]); }
  const ids = new Map(), p = [], w = [];
  const vertex = (i, side) => {
    const key = `${i}|${level.p[i][0] === 0 ? 0 : side}`;
    if (!ids.has(key)) {
      let n = unit(normals[i]); if (level.p[i][0] === 0) n = unit([0, n[1], n[2]]);
      const q = level.p[i].map((v, k) => v + n[k] * 0.01);
      ids.set(key, p.length); p.push(side < 0 ? [-q[0], q[1], q[2]] : q);
      // A right-side copy takes the mirror bones (left ↔ right).
      w.push(side < 0 ? level.w[i].map(([bone, x]) => [mirrorBone(bone), x]) : level.w[i]);
    }
    return ids.get(key);
  };
  const f = [], fuv = [];
  for (const [t] of trunk) {
    f.push(t.map((i) => vertex(i, 1))); fuv.push(t.map((i) => [level.p[i][0], level.p[i][1]]));
    f.push([t[0], t[2], t[1]].map((i) => vertex(i, -1))); fuv.push([t[0], t[2], t[1]].map((i) => [level.p[i][0], level.p[i][1]]));
  }
  return { mesh: { p, f, fuv, w }, hides: trunk.map(([, k]) => k) };
}

const tops = base.mesh.map(top);
const garments = { body: { tube: { slot: "top", mesh: tops.map((t) => t.mesh), hides: tops.map((t) => t.hides), tucks: base.mesh.map(() => []), colours: ["a", "b"] } } };

/** Faces: three, each a smooth deformation of the head; each feature morph another (deltas in 0.1 mm, x = 0 kept on the centre line). */
const HEAD_Y = base.joints.neck[1] + 0.03;
const field = (k) => ([x, y, z]) => [Math.round(Math.sin(3 * y + k) * x * 300), Math.round(Math.cos(5 * z + k) * 20), Math.round(Math.sin(7 * x + 2 * k) * 15)];
const morphs = [...new Set(FEATURES.flatMap(([, minus, plus]) => [minus, plus]).filter(Boolean))].sort();
const lods = base.mesh.map((level) => {
  const v = level.p.map((p, i) => [p, i]).filter(([p]) => p[1] > HEAD_Y).map(([, i]) => i);
  const deltas = (k) => v.flatMap((i) => { const d = k < 0 ? [0, 0, 0] : field(k)(level.p[i]); if (level.p[i][0] === 0) d[0] = 0; return d; });
  return { v, heads: [deltas(-1), deltas(1), deltas(2)], morphs: Object.fromEntries(morphs.map((m, j) => [m, deltas(3 + j)])) };
});
const faces = { body: { faces: ["00", "01", "02"], tints: [[1, 1, 1], [0.8, 0.7, 0.6], [0.5, 0.4, 0.35]], morphs,
  eyes: { heads: [[0, 0, 0], [0, 10, 0], [0, -10, 5]], morphs: Object.fromEntries(morphs.map((m) => [m, [0, 5, 0]])) }, lods } };

export const TEST_DATA = { id: "test", shapes: { body: shape }, garments, faces };
