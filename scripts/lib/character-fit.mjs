// Fitting a source body to the character generator's shapes (docs/character-generator.md#body-shapes):
// the steps every source shares. A source mesh is { p, w, f, uv, island, src? }: positions (metres),
// weights per vertex ([our bone id, weight] pairs), triangles, three UVs per triangle, an island per
// triangle, and optionally where each vertex comes from in the source's own vertices
// ([[index, weight], …]), so morphs of the source carry over to the simplified mesh exactly.
import { MeshoptSimplifier } from "meshoptimizer";

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
export const r5 = (x) => Math.round(x * 1e5) / 1e5;
export const roundAll = (x) => (typeof x === "number" ? r5(x) : Array.isArray(x) ? x.map(roundAll) : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, roundAll(v)])));

const mixWeights = (a, b, t) => {
  const w = new Map();
  for (const [id, x] of a) w.set(id, (w.get(id) ?? 0) + x * (1 - t));
  for (const [id, x] of b) w.set(id, (w.get(id) ?? 0) + x * t);
  return [...w];
};
const mixSource = (a, b, t) => {
  const s = new Map();
  for (const [i, x] of a) s.set(i, (s.get(i) ?? 0) + x * (1 - t));
  for (const [i, x] of b) s.set(i, (s.get(i) ?? 0) + x * t);
  return [...s];
};

/** The left half (x ≥ 0) of a mesh, clipped along the centre plane (faces in the plane go: the mirror pairs them). */
export function clipHalf(m) {
  const out = { p: [], w: [], f: [], uv: [], island: [], src: m.src ? [] : null }, kept = new Map(), cut = new Map();
  const keep = (i) => {
    if (!kept.has(i)) { kept.set(i, out.p.length); out.p.push(m.p[i]); out.w.push(m.w[i]); out.src?.push(m.src[i]); }
    return kept.get(i);
  };
  const mid = (a, b) => {
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    if (!cut.has(k)) {
      const t = m.p[a][0] / (m.p[a][0] - m.p[b][0]);
      cut.set(k, out.p.length);
      out.p.push([0, ...[1, 2].map((c) => m.p[a][c] + (m.p[b][c] - m.p[a][c]) * t)]);
      out.w.push(mixWeights(m.w[a], m.w[b], t));
      out.src?.push(mixSource(m.src[a], m.src[b], t));
    }
    return cut.get(k);
  };
  m.f.forEach((t, n) => {
    const poly = [];
    for (let c = 0; c < 3; c++) {
      const a = t[c], b = t[(c + 1) % 3], xa = m.p[a][0], xb = m.p[b][0], ua = m.uv[n][c], ub = m.uv[n][(c + 1) % 3];
      if (xa >= 0) poly.push([keep(a), ua]);
      if ((xa > 0 && xb < 0) || (xa < 0 && xb > 0)) { const s = xa / (xa - xb); poly.push([mid(a, b), [ua[0] + (ub[0] - ua[0]) * s, ua[1] + (ub[1] - ua[1]) * s]]); }
    }
    for (let c = 1; c + 1 < poly.length; c++) {
      const tri = [poly[0], poly[c], poly[c + 1]];
      if (new Set(tri.map((x) => x[0])).size < 3) continue;
      if (tri.every(([i]) => out.p[i][0] === 0)) continue;
      out.f.push(tri.map((x) => x[0])); out.uv.push(tri.map((x) => x[1])); out.island.push(m.island[n]);
    }
  });
  return out;
}

/**
 * A simplified copy with about `target` triangles: vertices on the centre line (and `locked` ones)
 * stay; faces squashed onto three shared corners cancel out. Vertices keep their weights and source.
 */
export async function simplify(m, target, { locked = () => false } = {}) {
  await MeshoptSimplifier.ready;
  const pos = Float32Array.from(m.p.flat()), idx = Uint32Array.from(m.f.flat());
  const lock = Uint8Array.from(m.p.map((p, i) => (p[0] === 0 || locked(i) ? 1 : 0)));
  const [out] = target >= m.f.length ? [idx] : MeshoptSimplifier.simplifyWithAttributes(idx, pos, 3, new Float32Array(m.p.length), 1, [0], lock, target * 3, 0.05, []);
  const map = new Map(), level = { p: [], w: [], f: [], src: m.src ? [] : null };
  const use = (i) => { if (!map.has(i)) { map.set(i, level.p.length); level.p.push(m.p[i]); level.w.push(m.w[i]); level.src?.push(m.src[i]); } return map.get(i); };
  for (let i = 0; i < out.length; i += 3) {
    const t = [use(out[i]), use(out[i + 1]), use(out[i + 2])];
    const n = cross(sub(level.p[t[1]], level.p[t[0]]), sub(level.p[t[2]], level.p[t[0]]));
    if (Math.hypot(...n) < 1e-10 || t.every((v) => level.p[v][0] === 0)) continue;
    level.f.push(t);
  }
  const seen = new Map();
  level.f.forEach((t, k) => { const key = [...t].sort((x, y) => x - y).join(","); (seen.get(key) ?? seen.set(key, []).get(key)).push(k); });
  const drop = new Set([...seen.values()].filter((list) => list.length > 1).flat());
  if (drop.size) level.f = level.f.filter((_, k) => !drop.has(k));
  return level;
}

/** Barycentric coordinates of the closest point of a triangle to q, and its distance (Ericson 5.1.5). */
export function closest(q, [a, b, c]) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(q, a), d1 = dot(ab, ap), d2 = dot(ac, ap), bp = sub(q, b), d3 = dot(ab, bp), d4 = dot(ac, bp), cp = sub(q, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  let w;
  if (d1 <= 0 && d2 <= 0) w = [1, 0, 0];
  else if (d3 >= 0 && d4 <= d3) w = [0, 1, 0];
  else if (d6 >= 0 && d5 <= d6) w = [0, 0, 1];
  else {
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); w = [1 - v, v, 0]; }
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const v = d2 / (d2 - d6); w = [1 - v, 0, v]; }
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const v = (d4 - d3) / (d4 - d3 + (d5 - d6)); w = [0, 1 - v, v]; }
    else { const den = 1 / (va + vb + vc); w = [1 - (vb + vc) * den, vb * den, vc * den]; }
  }
  const p = [0, 1, 2].map((k) => w[0] * a[k] + w[1] * b[k] + w[2] * c[k]);
  return { w, d: Math.hypot(...sub(q, p)) };
}

/**
 * UVs per face corner (and an island per face) for a simplified level, from the full mesh's charts:
 * each face takes the island and chart of the nearest full triangle facing its way, each corner the
 * nearest triangle of that chart, so a chart's shared corners agree and only real UV seams split.
 */
export function cornerUVs(full, level) {
  const parent = full.f.map((_, n) => n), find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const byCorner = new Map();
  full.f.forEach((t, n) => t.forEach((v, c) => { const k = `${v}|${full.uv[n][c].map((x) => x.toFixed(5)).join(",")}|${full.island[n]}`; if (byCorner.has(k)) parent[find(n)] = find(byCorner.get(k)); else byCorner.set(k, n); }));
  const tris = full.f.map((t, n) => ({ p: t.map((v) => full.p[v]), uv: full.uv[n], island: full.island[n], chart: find(n), n: unit(cross(sub(full.p[t[1]], full.p[t[0]]), sub(full.p[t[2]], full.p[t[0]]))) }));
  const CELL = 0.03, grid = new Map(), gk = (c) => c.join(",");
  tris.forEach((t, n) => { const c = [0, 1, 2].map((k) => Math.floor((t.p[0][k] + t.p[1][k] + t.p[2][k]) / 3 / CELL)); (grid.get(gk(c)) ?? grid.set(gk(c), []).get(gk(c))).push(n); });
  const nearest = (q, normal, chart = null) => {
    const c = q.map((x) => Math.floor(x / CELL));
    for (const facing of normal ? [0.3, -2] : [-2]) {
      let best = null;
      for (let r = 1; r <= 3 && !best; r++)
        for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++)
          for (const n of grid.get(gk([c[0] + i, c[1] + j, c[2] + k])) ?? []) {
            const t = tris[n];
            if ((chart !== null && t.chart !== chart) || (normal && dot(t.n, normal) < facing)) continue;
            const hit = closest(q, t.p);
            if (!best || hit.d < best.d) best = { ...hit, t };
          }
      if (best) return best;
    }
    return null;
  };
  const fuv = [], fisland = [];
  for (const t of level.f) {
    const ps = t.map((i) => level.p[i]), centre = [0, 1, 2].map((k) => (ps[0][k] + ps[1][k] + ps[2][k]) / 3);
    const o = nearest(centre, unit(cross(sub(ps[1], ps[0]), sub(ps[2], ps[0]))));
    fisland.push(o.t.island);
    fuv.push(ps.map((q) => { const h = nearest(q, null, o.t.chart) ?? o; return [0, 1].map((k) => r5(h.w[0] * h.t.uv[0][k] + h.w[1] * h.t.uv[1][k] + h.w[2] * h.t.uv[2][k])); }));
  }
  return { fuv, fisland };
}

/** At most four influences per vertex, normalised, rounded. */
export const topWeights = (list) => { const top = [...list].sort((a, b) => b[1] - a[1]).slice(0, 4), sum = top.reduce((s, x) => s + x[1], 0); return top.map(([id, x]) => [id, r5(x / sum)]); };

/**
 * A simplified copy where a region (`inside(position)`, the head say) keeps `share` of the
 * triangles: the rest is simplified first with the region locked, then the region with the rest
 * locked, so the border between them stays where it is.
 */
export async function simplifyRegions(m, target, { inside, share }) {
  const isIn = m.p.map((p) => inside(p));
  const faceIn = m.f.map((t) => t.every((i) => isIn[i]));
  const regionFaces = faceIn.filter(Boolean).length, restFaces = m.f.length - regionFaces;
  const wantIn = Math.min(regionFaces, Math.round(target * share)), wantRest = Math.max(1, target - wantIn);
  // A vertex of a face in the region counts as the region's (its border with the rest included).
  const regionVerts = new Set(m.f.flatMap((t, k) => (faceIn[k] ? t : [])));
  const first = await simplify(m, wantRest + regionFaces, { locked: (i) => regionVerts.has(i) });
  const firstIn = first.p.map((p) => inside(p));
  const restVerts = new Set(first.f.flatMap((t) => (t.every((i) => firstIn[i]) ? [] : t)));
  return simplify(first, wantIn + (first.f.length - first.f.filter((t) => t.every((i) => firstIn[i])).length), { locked: (i) => restVerts.has(i) });
}

/**
 * Whether a half mesh folds: a directed edge used by more than one face, or an edge on the centre
 * line with more than one face (the mirror gives the other).
 */
export function folded(m) {
  const seen = new Set(), onPlane = new Map();
  for (const [a, b, c] of m.f) for (const [x, y] of [[a, b], [b, c], [c, a]]) {
    const k = `${x},${y}`;
    if (seen.has(k)) return true;
    seen.add(k);
    if (m.p[x][0] === 0 && m.p[y][0] === 0) { const u = x < y ? k : `${y},${x}`; onPlane.set(u, (onPlane.get(u) ?? 0) + 1); }
  }
  return [...onPlane.values()].some((n) => n > 1);
}

/** A shape's levels: the half simplified to each target (raised until it does not fold), with corner UVs, islands, weights and (when given) sources. */
export async function levelsOf(half, targets, options = {}) {
  const out = [];
  for (const target of targets) {
    let level, aim = target;
    do {
      level = options.region ? await simplifyRegions(half, aim, options.region) : await simplify(half, aim, options);
      aim = Math.ceil(aim * 1.15);
    } while (folded(level) && aim < half.f.length);
    const { fuv, fisland } = cornerUVs(half, level);
    out.push({ p: level.p.map((p) => p.map(r5)), f: level.f, fisland, fuv, w: level.w.map(topWeights), src: level.src });
    console.log(`  LOD: ${level.f.length} triangles (half), ${level.p.length} vertices`);
  }
  return out;
}

// ── Garments over a body (its levels: the left half, { p, f } per LOD). ──

/** A uniform grid over triangles by their bounding boxes; `near(p)` lists those in p's cell and around. */
function triangleGrid(tris, cell = 0.06) {
  const g = new Map(), key = (i, j, k) => `${i},${j},${k}`;
  tris.forEach((t, n) => {
    const lo = [0, 1, 2].map((k) => Math.floor(Math.min(t[0][k], t[1][k], t[2][k]) / cell)), hi = [0, 1, 2].map((k) => Math.floor(Math.max(t[0][k], t[1][k], t[2][k]) / cell));
    for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) (g.get(key(i, j, k)) ?? g.set(key(i, j, k), []).get(key(i, j, k))).push(n);
  });
  return (p) => {
    const c = p.map((x) => Math.floor(x / cell)), out = new Set();
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) for (const n of g.get(key(c[0] + i, c[1] + j, c[2] + k)) ?? []) out.add(n);
    return [...out];
  };
}

/** The signed distance along d (either way) to the nearest of the triangles within [lo, hi], or NaN. */
function rayHit(tris, list, o, d, lo, hi, accept = () => true) {
  let best = NaN;
  for (const n of list) {
    if (!accept(n)) continue;
    const [a, b, c] = tris[n], e1 = sub(b, a), e2 = sub(c, a), p = cross(d, e2), det = dot(e1, p);
    if (Math.abs(det) < 1e-14) continue;
    const inv = 1 / det, s = sub(o, a), u = dot(s, p) * inv;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1), v = dot(d, q) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = dot(e2, q) * inv;
    if (t >= lo && t <= hi && !(Math.abs(t) >= Math.abs(best))) best = t;
  }
  return best;
}

/**
 * The body faces (per level, left half) a garment covers: rays along a face's normal from its
 * centre and corners, on both sides of the body, all meet the garment between 3 cm under the skin
 * and 6 cm outside.
 */
export function coveredFaces(gp, gf, levels, range = [-0.03, 0.06]) {
  const tris = gf.map((t) => t.map((i) => gp[i])), near = triangleGrid(tris);
  const lo = [0, 1, 2].map((k) => Math.min(...gp.map((q) => q[k])) - range[1]), hi = [0, 1, 2].map((k) => Math.max(...gp.map((q) => q[k])) + range[1]);
  const reaches = (q, n) => q.every((x, k) => x >= lo[k] && x <= hi[k]) && Number.isFinite(rayHit(tris, near(q), q, n, range[0], range[1]));
  const mirrorX = (v) => [-v[0], v[1], v[2]];
  return levels.map((level) => level.f.flatMap((t, k) => {
    const ps = t.map((i) => level.p[i]), n = unit(cross(sub(ps[1], ps[0]), sub(ps[2], ps[0])));
    const centre = ps.reduce((s, q) => s.map((v, j) => v + q[j] / 3), [0, 0, 0]);
    const samples = [centre, ...ps.map((q) => q.map((v, j) => v + (centre[j] - v) * 0.15))];
    return samples.every((q) => reaches(q, n) && reaches(mirrorX(q), mirrorX(n))) ? [k] : [];
  }));
}

/**
 * Skin tucked under a garment: per level, [vertex, dx, dy, dz, …] for the left half's vertices with
 * a garment surface (either layer) within 3 cm under them or less than 4 mm over them, each moved
 * along its normal to 4 mm under that surface.
 */
export function tuckedSkin(gp, gf, levels, [under, gap] = [0.03, 0.004]) {
  const tris = gf.map((t) => t.map((i) => gp[i])), normals = tris.map(([a, b, c]) => unit(cross(sub(b, a), sub(c, a)))), near = triangleGrid(tris);
  return levels.map((level) => {
    const n = level.p.map(() => [0, 0, 0]);
    for (const t of level.f) { const ps = t.map((i) => level.p[i]), fn = cross(sub(ps[1], ps[0]), sub(ps[2], ps[0])); for (const i of t) n[i] = n[i].map((v, k) => v + fn[k]); }
    const out = [];
    level.p.forEach((p, i) => {
      const d = unit(p[0] === 0 ? [0, n[i][1], n[i][2]] : n[i]);
      const s = rayHit(tris, near(p), p, d, -under, gap - 1e-9, (k) => Math.abs(dot(normals[k], d)) >= 0.3);
      if (!Number.isFinite(s)) return;
      const move = s - gap;
      out.push(i, ...[p[0] === 0 ? 0 : d[0] * move, d[1] * move, d[2] * move].map(r5));
    });
    return out;
  });
}

/**
 * A garment's outside lifted off the skin: vertices of faces turned outward that lie within 4 mm
 * over the body (both halves of its first level) or up to 2 cm under it move along the body's normal
 * to 4 mm over it. Returns the new positions and how many moved.
 */
export function liftedOff(gp, gf, level, [under, gap] = [0.02, 0.004]) {
  const tris = [];
  for (const t of level.f) { const ps = t.map((i) => level.p[i]), mp = ps.map(([x, y, z]) => [-x, y, z]); tris.push(ps, [mp[0], mp[2], mp[1]]); }
  const near = triangleGrid(tris);
  const vn = gp.map(() => [0, 0, 0]);
  for (const t of gf) { const fn = cross(sub(gp[t[1]], gp[t[0]]), sub(gp[t[2]], gp[t[0]])); for (const i of t) vn[i] = vn[i].map((v, k) => v + fn[k]); }
  let moved = 0;
  const p = gp.map((q, i) => {
    let best = null, bd = Infinity;
    for (const n of near(q)) {
      const t = tris[n], { w } = closest(q, t), c = [0, 1, 2].map((k) => w[0] * t[0][k] + w[1] * t[1][k] + w[2] * t[2][k]), dist = Math.hypot(...sub(q, c));
      if (dist < bd) { bd = dist; best = [c, unit(cross(sub(t[1], t[0]), sub(t[2], t[0])))]; }
    }
    if (!best) return q;
    const [c, n] = best, s = dot(sub(q, c), n);
    if (dot(unit(vn[i]), n) < 0.3 || s < -under || s >= gap) return q;
    moved++;
    return q.map((x, k) => x + n[k] * (gap - s));
  });
  return { p, moved };
}

// ── Proportions: measurements of a body (facts: lengths and girths), to fit one body's to another's. ──

/** The perimeter of the convex hull of 2D points (Andrew's monotone chain). */
function hullPerimeter(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return 0;
  const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => { const h = []; for (const q of list) { while (h.length >= 2 && turn(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop(); h.push(q); } return h; };
  const lower = half(p), upper = half([...p].reverse()), hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return hull.reduce((s, q, i) => s + Math.hypot(...[0, 1].map((k) => hull[(i + 1) % hull.length][k] - q[k])), 0);
}

/**
 * A body's measurements (metres) from its points (the whole body, standing on y = 0, facing +z)
 * and joints (our ids, left side at +x): heights, widths, limb lengths, and girths as the convex
 * hull's perimeter of a thin slice (torso slices between the arms, limb slices of the left limb).
 */
export function bodyMeasures(points, joints, faces) {
  const J = joints, len = (a, b) => Math.hypot(...[0, 1, 2].map((k) => J[a][k] - J[b][k]));
  const crown = Math.max(...points.map((p) => p[1]));
  // A slice: where the triangles cross the plane y (their edges' crossings), the hull of those kept.
  const slice = (y, keep) => {
    const cut = [];
    for (const t of faces) for (let k = 0; k < 3; k++) {
      const a = points[t[k]], b = points[t[(k + 1) % 3]];
      if ((a[1] - y) * (b[1] - y) >= 0) continue;
      const s = (y - a[1]) / (b[1] - a[1]), q = [a[0] + (b[0] - a[0]) * s, y, a[2] + (b[2] - a[2]) * s];
      if (keep(q)) cut.push([q[0], q[2]]);
    }
    return hullPerimeter(cut);
  };
  const shoulderX = J.l_upperarm[0], hipY = J.l_thigh[1], shoulderY = J.l_upperarm[1], kneeY = J.l_calf[1], ankleY = J.l_foot[1];
  const lerp = (a, b, t) => a + (b - a) * t;
  return {
    stature: crown, neckY: J.neck[1], shoulderY, hipY, kneeY, ankleY,
    shoulderWidth: 2 * shoulderX, hipWidth: 2 * J.l_thigh[0],
    upperArm: len("l_upperarm", "l_forearm"), forearm: len("l_forearm", "l_hand"), thigh: len("l_thigh", "l_calf"), shin: len("l_calf", "l_foot"),
    chest: slice(lerp(shoulderY, hipY, 0.22), (p) => Math.abs(p[0]) < shoulderX * 0.8),
    waist: slice(lerp(shoulderY, hipY, 0.62), (p) => Math.abs(p[0]) < shoulderX * 0.8),
    hips: slice(hipY - 0.04, (p) => Math.abs(p[0]) < shoulderX * 1.1),
    thighGirth: slice(lerp(hipY, kneeY, 0.35), (p) => p[0] > 0.015),
    calfGirth: slice(lerp(kneeY, ankleY, 0.3), (p) => p[0] > 0.015),
    neckGirth: slice(lerp(J.neck[1], J.head[1], 0.4), (p) => Math.abs(p[0]) < 0.1),
  };
}

/** A shape's measurements (its first level is the left half: mirrored to the whole body). */
export function shapeMeasures(shape) {
  const half = shape.mesh[0], n = half.p.length;
  const points = [...half.p, ...half.p.map(([x, y, z]) => [-x, y, z])];
  const faces = [...half.f, ...half.f.map(([a, b, c]) => [a + n, c + n, b + n])];
  return bodyMeasures(points, shape.joints, faces);
}
