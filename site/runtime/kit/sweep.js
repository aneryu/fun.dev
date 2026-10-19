// Sweeps (docs/worlds.md §5): a cross-section profile carried along a path becomes road,
// track, rail, river or footpath geometry. Pure: points in, vertices and faces out, so the
// workshop bakes with it and a game could run it. Profiles are strips side by side from left
// to right (each with a width, a material and a height offset; a step between offsets makes a
// kerb face) plus marks laid over them (lines, kerbs, sleepers, dashed by length), optionally
// a slab below. The ribbon follows the path's heights or a height function (terrain), mitres
// its corners, and banks on curvature when asked.

const UP = [0, 1, 0];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a) => { const l = length(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const round = (v) => Math.round(v * 1000) / 1000;

/** Materials the presets use; the workshop creates the missing ones on the project. */
export const SWEEP_MATERIALS = {
  mat_asphalt: { name: "Asphalt", color: "#3b3b3e", roughness: 0.95 },
  mat_line_white: { name: "Road line", color: "#e8e6df", roughness: 0.8 },
  mat_line_yellow: { name: "Road line yellow", color: "#e3b53a", roughness: 0.8 },
  mat_kerb: { name: "Kerb", color: "#b9b4a8", roughness: 0.9 },
  mat_kerb_red: { name: "Kerb red", color: "#c8372d", roughness: 0.85 },
  mat_sidewalk: { name: "Sidewalk", color: "#a9a49a", roughness: 0.95 },
  mat_gravel: { name: "Gravel", color: "#8d867a", roughness: 1 },
  mat_rail: { name: "Rail", color: "#6e6a64", roughness: 0.5, metalness: 0.6 },
  mat_sleeper: { name: "Sleeper", color: "#5b4a36", roughness: 0.95 },
  mat_water: { name: "Water", color: "#4ba3c7", roughness: 0.2 },
  mat_dirt: { name: "Dirt path", color: "#8a7a5e", roughness: 1 },
};

/** Preset profiles; each takes the options an agent may vary. */
export const SWEEP_PRESETS = {
  road({ lanes = 2, laneWidth = 3.5, sidewalks = false, sidewalkWidth = 2, lines = true } = {}) {
    const width = lanes * laneWidth, strips = [], marks = [];
    if (sidewalks) strips.push({ width: sidewalkWidth, material: "mat_sidewalk", offset: 0.15 });
    strips.push({ width, material: "mat_asphalt", offset: 0 });
    if (sidewalks) strips.push({ width: sidewalkWidth, material: "mat_sidewalk", offset: 0.15 });
    if (lines) {
      marks.push({ at: -width / 2 + 0.2, width: 0.15, material: "mat_line_white" }, { at: width / 2 - 0.2, width: 0.15, material: "mat_line_white" });
      if (lanes >= 2) marks.push({ at: 0, width: 0.15, material: lanes === 2 ? "mat_line_yellow" : "mat_line_white", dash: lanes === 2 ? null : [3, 6] });
      for (let i = 1; i < lanes; i++) if (lanes > 2 && i !== lanes / 2) marks.push({ at: -width / 2 + i * laneWidth, width: 0.12, material: "mat_line_white", dash: [3, 6] });
    }
    return { strips, marks, lanes, kind: "road" };
  },
  track({ width = 12, kerbs = true, lanes = 2 } = {}) {
    const marks = [{ at: -width / 2 + 0.3, width: 0.15, material: "mat_line_white" }, { at: width / 2 - 0.3, width: 0.15, material: "mat_line_white" }];
    const strips = [{ width, material: "mat_asphalt", offset: 0 }];
    if (kerbs) {
      strips.unshift({ width: 1, material: "mat_kerb", offset: 0.04 });
      strips.push({ width: 1, material: "mat_kerb", offset: 0.04 });
      marks.push({ at: -width / 2 - 0.5, width: 1, materials: ["mat_kerb_red", "mat_kerb"], dash: [2, 2] }, { at: width / 2 + 0.5, width: 1, materials: ["mat_kerb_red", "mat_kerb"], dash: [2, 2] });
    }
    return { strips, marks, lanes, kind: "track", bank: { max: 8, radius: 40 } };
  },
  rail({ gauge = 1.435, bed = 4 } = {}) {
    const side = (bed - gauge - 0.16) / 2;
    return {
      strips: [
        { width: side, material: "mat_gravel", offset: 0 },
        { width: 0.08, material: "mat_rail", offset: 0.18 },
        { width: gauge, material: "mat_gravel", offset: 0 },
        { width: 0.08, material: "mat_rail", offset: 0.18 },
        { width: side, material: "mat_gravel", offset: 0 },
      ],
      marks: [{ at: 0, width: gauge + 1, material: "mat_sleeper", dash: [0.25, 0.4], offset: 0.06 }],
      lanes: 1, kind: "rail",
    };
  },
  river({ width = 8 } = {}) { return { strips: [{ width, material: "mat_water", offset: 0 }], marks: [], lanes: 1, kind: "river" }; },
  walk({ width = 2 } = {}) { return { strips: [{ width, material: "mat_dirt", offset: 0 }], marks: [], lanes: 1, kind: "walk" }; },
};

/** A profile as the sweep reads it: a preset name, { preset, …options } or explicit strips. */
export function resolveProfile(profile) {
  let out;
  if (typeof profile === "string") {
    if (!SWEEP_PRESETS[profile]) throw new Error(`unknown profile preset "${profile}"`);
    out = SWEEP_PRESETS[profile]();
  } else if (profile && typeof profile === "object" && profile.preset) {
    const { preset, ...options } = profile;
    if (!SWEEP_PRESETS[preset]) throw new Error(`unknown profile preset "${preset}"`);
    out = { ...SWEEP_PRESETS[preset](options), ...(options.bank !== undefined ? { bank: options.bank } : {}), ...(options.thickness !== undefined ? { thickness: options.thickness } : {}) };
  } else if (profile && typeof profile === "object" && Array.isArray(profile.strips)) {
    out = { strips: profile.strips.map((s) => ({ width: s.width, material: s.material, offset: s.offset ?? 0 })), marks: (profile.marks ?? []).map((m) => ({ ...m })), lanes: profile.lanes ?? 1, kind: profile.kind ?? "road", ...(profile.bank ? { bank: profile.bank } : {}), ...(profile.thickness ? { thickness: profile.thickness } : {}), ...(profile.junction ? { junction: profile.junction } : {}) };
  } else throw new Error("a profile is a preset name, { preset, …options } or { strips, marks }");
  out.width = out.strips.reduce((sum, s) => sum + s.width, 0);
  return out;
}

/** Points along a Catmull-Rom curve through the path's points, about `spacing` apart. */
export function resamplePath(points, { closed = false, spacing = 2, smooth = true } = {}) {
  const n = points.length;
  if (n < 2) return points.map((p) => [...p]);
  let dense = [];
  if (smooth && n >= 3) {
    const at = (i) => points[closed ? ((i % n) + n) % n : Math.min(n - 1, Math.max(0, i))];
    const spans = closed ? n : n - 1;
    for (let i = 0; i < spans; i++) {
      // Centripetal Catmull-Rom: no cusps or overshoot at uneven spacing.
      const p0 = closed || i > 0 ? at(i - 1) : sub(mul(points[0], 2), points[1]);
      const p1 = at(i), p2 = at(i + 1);
      const p3 = closed || i + 2 < n ? at(i + 2) : sub(mul(points[n - 1], 2), points[n - 2]);
      const t = [0];
      for (const [a, b] of [[p0, p1], [p1, p2], [p2, p3]]) t.push(t[t.length - 1] + Math.sqrt(Math.max(1e-9, length(sub(b, a)))));
      const steps = Math.max(2, Math.ceil(length(sub(p2, p1)) / spacing) * 4);
      for (let k = 0; k < steps; k++) {
        const u = t[1] + ((t[2] - t[1]) * k) / steps;
        const l = (a, b, ta, tb) => (tb - ta < 1e-9 ? a : add(mul(a, (tb - u) / (tb - ta)), mul(b, (u - ta) / (tb - ta))));
        const a1 = l(p0, p1, t[0], t[1]), a2 = l(p1, p2, t[1], t[2]), a3 = l(p2, p3, t[2], t[3]);
        const b1 = l(a1, a2, t[0], t[2]), b2 = l(a2, a3, t[1], t[3]);
        dense.push(l(b1, b2, t[1], t[2]));
      }
    }
    if (!closed) dense.push([...points[n - 1]]);
  } else dense = points.map((p) => [...p]);
  // Walk the dense polyline at even distances.
  const out = [dense[0].map(round)];
  let carry = 0;
  const last = closed ? dense.length : dense.length - 1;
  for (let i = 0; i < last; i++) {
    const a = dense[i], b = dense[(i + 1) % dense.length], seg = length(sub(b, a));
    let d = spacing - carry;
    while (d <= seg) {
      out.push(lerp(a, b, d / seg).map(round));
      d += spacing;
    }
    carry = seg - (d - spacing);
  }
  const tail = dense[dense.length - 1].map(round);
  if (!closed) { if (length(sub(tail, out[out.length - 1])) > 1e-6) out.push(tail); }
  else if (out.length > 1 && length(sub(out[out.length - 1], out[0])) < spacing * 0.5) out.pop();
  return out;
}

/** Samples at most `step` apart along the polyline, the path's own points kept. */
function subdivide(points, closed, step) {
  const n = points.length, count = closed ? n : n - 1, out = [];
  for (let i = 0; i < count; i++) {
    const a = points[i], b = points[(i + 1) % n], parts = Math.max(1, Math.ceil(length(sub(b, a)) / step));
    for (let k = 0; k < parts; k++) out.push(lerp(a, b, k / parts));
  }
  if (!closed) out.push([...points[n - 1]]);
  return out;
}

/** The part of an open polyline between two distances along it, its ends interpolated. */
export function cutPolyline(points, from, to) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + length(sub(points[i], points[i - 1])));
  const total = lengths[lengths.length - 1], a = Math.max(0, from), b = Math.min(total, to);
  if (b - a < 1e-6) return [];
  const at = (d) => {
    let i = 1;
    while (i < points.length - 1 && lengths[i] < d) i++;
    const span = lengths[i] - lengths[i - 1] || 1;
    return lerp(points[i - 1], points[i], (d - lengths[i - 1]) / span);
  };
  const out = [at(a)];
  for (let i = 1; i < points.length - 1; i++) if (lengths[i] > a + 1e-9 && lengths[i] < b - 1e-9) out.push([...points[i]]);
  out.push(at(b));
  return out;
}

/**
 * Sweeps a profile along a path. `height(x, z)` (a terrain) replaces the path's heights
 * (the surface always sits `rise` above its line); `bank: { max, radius }` tilts the section by curvature (full bank at the
 * radius); `chunk` metres splits the result into meshes (shared seam vertices, no cracks);
 * `trim: [start, end]` leaves out that much of an open path's ends (junctions).
 * Returns { chunks: [{ vertices, faces, from, to }], length, width, samples }.
 */
export function sweepPath(points, { closed = false, profile, step = 4, height = null, rise = 0.05, bank = null, chunk = Infinity, trim = null } = {}) {
  const p = resolveProfile(profile);
  if (points.length < 2) throw new Error("a sweep needs a path of at least two points");
  if (trim && !closed) {
    const total = points.reduce((sum, pt, i) => (i ? sum + length(sub(pt, points[i - 1])) : 0), 0);
    points = cutPolyline(points, trim[0] ?? 0, total - (trim[1] ?? 0));
    if (points.length < 2) return { chunks: [], length: 0, width: p.width, lanes: p.lanes, kind: p.kind, samples: 0 };
  }
  const samples = subdivide(points, closed, step);
  const n = samples.length, segs = closed ? n : n - 1;
  // The surface sits `rise` above the path (or the ground under it), clear of a floor at
  // the path's own height.
  for (const s of samples) {
    const h = height ? height(s[0], s[2]) : null;
    s[1] = (h === null || h === undefined ? s[1] : h) + rise;
  }
  // Segment directions (horizontal) and lengths; a frame per sample with the mitre at corners.
  const dirs = [], lens = [];
  for (let i = 0; i < segs; i++) {
    const d = sub(samples[(i + 1) % n], samples[i]);
    lens.push(length(d));
    d[1] = 0;
    dirs.push(length(d) > 1e-9 ? normalize(d) : dirs[i - 1] ?? [0, 0, 1]);
  }
  const cumulative = [0];
  for (let i = 0; i < segs; i++) cumulative.push(cumulative[i] + lens[i]);
  const total = cumulative[segs];
  const frames = [];
  for (let i = 0; i < n; i++) {
    const prev = closed ? dirs[(i - 1 + segs) % segs] : dirs[Math.max(0, i - 1)], next = closed ? dirs[i % segs] : dirs[Math.min(segs - 1, i)];
    let tangent = add(prev, next);
    tangent = length(tangent) > 1e-6 ? normalize(tangent) : next;
    const right = [-tangent[2], 0, tangent[0]];
    const cosHalf = Math.max(0.5, dot(tangent, next));
    const turn = Math.atan2(prev[2] * next[0] - prev[0] * next[2], dot(prev, next));
    const around = (closed ? lens[(i - 1 + segs) % segs] + lens[i % segs] : (i > 0 ? lens[i - 1] : 0) + (i < segs ? lens[i] : 0)) / 2 || 1;
    frames.push({ tangent, right, mitre: 1 / cosHalf, curvature: turn / around });
  }
  // Banking from curvature smoothed over about 12 m.
  const banks = new Array(n).fill(0);
  const banking = bank ?? p.bank ?? null;
  if (banking && banking.max) {
    const radius = banking.radius ?? 40, window = Math.max(1, Math.round(12 / Math.max(step, 0.5)));
    for (let i = 0; i < n; i++) {
      let sum = 0, count = 0;
      for (let k = -window; k <= window; k++) {
        const j = closed ? ((i + k) % n + n) % n : i + k;
        if (j < 0 || j >= n) continue;
        sum += frames[j].curvature;
        count++;
      }
      const k = count ? sum / count : 0;
      banks[i] = (banking.max * Math.max(-1, Math.min(1, k * radius)) * Math.PI) / 180;
    }
  }
  // Vertex positions by (sample, lateral, offset).
  const at = (i, lateral, offset) => {
    const f = frames[i], c = Math.cos(banks[i]), s = Math.sin(banks[i]);
    const lat = add(mul(f.right, c), mul(UP, s)), up = sub(mul(UP, c), mul(f.right, s));
    return add(add(samples[i], mul(lat, lateral * f.mitre)), mul(up, offset));
  };
  // Boundaries of the strips from the left edge.
  const bounds = [-p.width / 2];
  for (const s of p.strips) bounds.push(bounds[bounds.length - 1] + s.width);
  const stripAt = (lateral) => { let j = 0; while (j < p.strips.length - 1 && lateral > bounds[j + 1]) j++; return p.strips[j]; };
  const lowest = Math.min(...p.strips.map((s) => s.offset));
  // Chunks by length: a segment belongs to the chunk of its first sample; seam samples repeat.
  const chunkOf = (i) => (Number.isFinite(chunk) && chunk > 0 ? Math.min(Math.floor(cumulative[Math.min(i, segs)] / chunk), Math.max(0, Math.ceil(total / chunk) - 1)) : 0);
  const chunks = new Map();
  const chunkFor = (c) => {
    if (!chunks.has(c)) chunks.set(c, { vertices: [], faces: [], keys: new Map(), from: Infinity, to: -Infinity });
    return chunks.get(c);
  };
  const vertex = (ch, i, key, position) => {
    const k = `${i}|${key}`;
    if (!ch.keys.has(k)) { ch.keys.set(k, ch.vertices.length); ch.vertices.push(position.map(round)); }
    return ch.keys.get(k);
  };
  const quad = (ch, a, b, c, d, material) => { ch.faces.push({ vertices: [a, b, c], material }, { vertices: [a, c, d], material }); };
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n, ch = chunkFor(chunkOf(i));
    ch.from = Math.min(ch.from, cumulative[i]);
    ch.to = Math.max(ch.to, cumulative[i + 1]);
    // Strips, with kerb faces where neighbouring offsets differ.
    p.strips.forEach((strip, s) => {
      const l = bounds[s], r = bounds[s + 1], o = strip.offset;
      const li = vertex(ch, i, `b${s}:${o}`, at(i, l, o)), ri = vertex(ch, i, `b${s + 1}:${o}`, at(i, r, o));
      const lj = vertex(ch, j, `b${s}:${o}`, at(j, l, o)), rj = vertex(ch, j, `b${s + 1}:${o}`, at(j, r, o));
      quad(ch, li, ri, rj, lj, strip.material);
      if (s > 0 && p.strips[s - 1].offset !== o) {
        const a = p.strips[s - 1].offset, high = a > o ? p.strips[s - 1] : strip;
        const ai = vertex(ch, i, `b${s}:${a}`, at(i, l, a)), aj = vertex(ch, j, `b${s}:${a}`, at(j, l, a));
        quad(ch, ai, li, lj, aj, high.material);
      }
    });
    // Marks over the strips: dashed by length, alternating materials when two are given.
    p.marks.forEach((mark, m) => {
      const base = stripAt(mark.at).offset + (mark.offset ?? 0.01), l = mark.at - mark.width / 2, r = mark.at + mark.width / 2;
      let material = mark.material;
      if (mark.dash) {
        const mid = (cumulative[i] + cumulative[i + 1]) / 2, period = mark.dash[0] + mark.dash[1], phase = mid - Math.floor(mid / period) * period;
        if (mark.materials) material = phase < mark.dash[0] ? mark.materials[0] : mark.materials[1];
        else if (phase >= mark.dash[0]) return;
      }
      const li = vertex(ch, i, `m${m}L`, at(i, l, base)), ri = vertex(ch, i, `m${m}R`, at(i, r, base));
      const lj = vertex(ch, j, `m${m}L`, at(j, l, base)), rj = vertex(ch, j, `m${m}R`, at(j, r, base));
      quad(ch, li, ri, rj, lj, material);
    });
    // A slab below: walls at both edges and a bottom facing down.
    if (p.thickness > 0) {
      const below = p.below ?? p.strips[0].material, bottom = lowest - p.thickness, L = bounds[0], R = bounds[bounds.length - 1];
      const tl = p.strips[0].offset, tr = p.strips[p.strips.length - 1].offset;
      const tli = vertex(ch, i, `b0:${tl}`, at(i, L, tl)), tlj = vertex(ch, j, `b0:${tl}`, at(j, L, tl));
      const tri = vertex(ch, i, `b${p.strips.length}:${tr}`, at(i, R, tr)), trj = vertex(ch, j, `b${p.strips.length}:${tr}`, at(j, R, tr));
      const bli = vertex(ch, i, "sl", at(i, L, bottom)), blj = vertex(ch, j, "sl", at(j, L, bottom));
      const bri = vertex(ch, i, "sr", at(i, R, bottom)), brj = vertex(ch, j, "sr", at(j, R, bottom));
      quad(ch, bli, tli, tlj, blj, below);
      quad(ch, tri, bri, brj, trj, below);
      quad(ch, bri, bli, blj, brj, below);
    }
  }
  const list = [...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, ch]) => ({ vertices: ch.vertices, faces: ch.faces, from: round(ch.from), to: round(ch.to) }));
  return { chunks: list, length: round(total), width: p.width, lanes: p.lanes, kind: p.kind, samples: n };
}

const key3 = (p) => `${Math.round(p[0] * 1000)}|${Math.round(p[1] * 1000)}|${Math.round(p[2] * 1000)}`;
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
/** The parameter and point of the closest approach of p to the segment ab, in the x–z plane. */
function projectXZ(p, a, b) {
  const dx = b[0] - a[0], dz = b[2] - a[2], l2 = dx * dx + dz * dz;
  const u = l2 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / l2)) : 0;
  return { u, point: lerp(a, b, u) };
}
/** The crossing of two segments in the x–z plane, strictly inside both, or null. */
function crossingXZ(a, b, c, d) {
  const r = [b[0] - a[0], b[2] - a[2]], s = [d[0] - c[0], d[2] - c[2]], denominator = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denominator) < 1e-9) return null;
  const qp = [c[0] - a[0], c[2] - a[2]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / denominator, u = (qp[0] * r[1] - qp[1] * r[0]) / denominator;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return { t, u };
}

/**
 * Welds paths where they meet (docs/worlds.md §4): ends within `tolerance` of each other
 * snap together, an end within `tolerance` of another path moves onto it and that path gains
 * the point, and where two paths cross both gain the crossing. Paths then share points, so
 * sweeps make junctions there and the runtime's network routes across. Takes and returns
 * { id: { points, closed } }; `welds` lists what happened.
 */
export function weldPaths(paths, { tolerance = 0.5 } = {}) {
  const out = Object.fromEntries(Object.entries(paths).map(([id, p]) => [id, { points: p.points.map((pt) => [...pt]), closed: !!p.closed }]));
  const ids = Object.keys(out), welds = [];
  const ends = (id) => (out[id].closed ? [] : [0, out[id].points.length - 1]);
  // Ends meeting ends.
  for (let i = 0; i < ids.length; i++)
    for (const ei of ends(ids[i]))
      for (let j = i + 1; j < ids.length; j++)
        for (const ej of ends(ids[j])) {
          const a = out[ids[i]].points[ei], b = out[ids[j]].points[ej];
          if (dist2(a, b) > 1e-6 && dist2(a, b) <= tolerance) {
            const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2].map(round);
            out[ids[i]].points[ei] = [...m];
            out[ids[j]].points[ej] = [...m];
            welds.push({ kind: "ends", at: m, paths: [ids[i], ids[j]] });
          }
        }
  // Ends touching another path: the end moves onto it, the other path gains the point.
  for (const id of ids)
    for (const e of ends(id)) {
      const p = out[id].points[e];
      let best = null;
      for (const other of ids) {
        if (other === id) continue;
        const pts = out[other].points, n = out[other].closed ? pts.length : pts.length - 1;
        for (let k = 0; k < n; k++) {
          const a = pts[k], b = pts[(k + 1) % pts.length], hit = projectXZ(p, a, b), d = dist2(p, hit.point);
          if (d <= tolerance && (!best || d < best.d)) best = { other, k, u: hit.u, point: hit.point, d };
        }
      }
      if (!best) continue;
      const m = best.point.map(round), pts = out[best.other].points;
      const a = pts[best.k], b = pts[(best.k + 1) % pts.length];
      // Onto a vertex: nothing to add unless the end was off it; inside a segment: a new point.
      if (dist2(m, a) < 1e-6 || dist2(m, b) < 1e-6) { if (best.d < 1e-6) continue; }
      else pts.splice(best.k + 1, 0, [...m]);
      out[id].points[e] = [...m];
      welds.push({ kind: "touch", at: m, paths: [id, best.other] });
    }
  // Crossings: both paths gain the point (its height the two heights' mean).
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const A = out[ids[i]], B = out[ids[j]], inserts = { a: [], b: [] };
      const na = A.closed ? A.points.length : A.points.length - 1, nb = B.closed ? B.points.length : B.points.length - 1;
      for (let k = 0; k < na; k++)
        for (let l = 0; l < nb; l++) {
          const a = A.points[k], b = A.points[(k + 1) % A.points.length], c = B.points[l], d = B.points[(l + 1) % B.points.length];
          const hit = crossingXZ(a, b, c, d);
          if (!hit) continue;
          const pa = lerp(a, b, hit.t), pb = lerp(c, d, hit.u), m = [pa[0], (pa[1] + pb[1]) / 2, pa[2]].map(round);
          inserts.a.push({ k, t: hit.t, m });
          inserts.b.push({ k: l, t: hit.u, m });
          welds.push({ kind: "cross", at: m, paths: [ids[i], ids[j]] });
        }
      for (const [list, path] of [[inserts.a, A], [inserts.b, B]])
        for (const ins of list.sort((x, y) => y.k - x.k || y.t - x.t)) path.points.splice(ins.k + 1, 0, [...ins.m]);
    }
  return { paths: out, welds };
}

/**
 * Sweeps a set of paths that share points as one network: at every junction (a point where
 * three or more road ends or passes meet) the ribbons stop short of each other and a patch
 * of the junction material fills the crossing, so roads cross without overlapping. Paths
 * without junctions sweep as they are. Returns the chunks of every ribbon and a chunk per
 * junction (`junction: true`), with counts.
 */
export function sweepNetwork(paths, { profile, step = 4, height = null, rise = 0.05, bank = null, chunk = Infinity } = {}) {
  const p = resolveProfile(profile), half = p.width / 2;
  const material = p.junction ?? p.strips.reduce((best, s) => (s.width > best.width ? s : best), p.strips[0]).material;
  // Degree per point: ends count once, passes twice.
  const degree = new Map(), ids = Object.keys(paths);
  for (const id of ids) {
    const { points, closed } = paths[id];
    points.forEach((pt, i) => {
      const k = key3(pt), end = !closed && (i === 0 || i === points.length - 1);
      degree.set(k, (degree.get(k) ?? 0) + (end ? 1 : 2));
    });
  }
  const junction = (pt) => (degree.get(key3(pt)) ?? 0) >= 3;
  // Chains: each path cut at its junction points; a closed path with junctions opens there.
  const chains = [];
  for (const id of ids) {
    let { points, closed } = paths[id];
    const marks = points.map((pt, i) => (junction(pt) ? i : -1)).filter((i) => i >= 0);
    if (closed && marks.length) {
      points = [...points.slice(marks[0]), ...points.slice(0, marks[0] + 1)];
      closed = false;
    }
    if (closed || !marks.length) { chains.push({ id, points, closed, start: false, end: false }); continue; }
    const cuts = points.map((pt, i) => (junction(pt) && i > 0 && i < points.length - 1 ? i : -1)).filter((i) => i >= 0);
    let from = 0;
    for (const cut of [...cuts, points.length - 1]) {
      if (cut > from) chains.push({ id, points: points.slice(from, cut + 1), closed: false, start: junction(points[from]), end: junction(points[cut]) });
      from = cut;
    }
  }
  // Two chains meeting end to end at a plain point continue as one ribbon, the corner mitred.
  for (let merged = true; merged; ) {
    merged = false;
    const endsAt = new Map();
    for (const c of chains) {
      if (c.closed) continue;
      for (const side of ["start", "end"]) {
        const pt = side === "start" ? c.points[0] : c.points[c.points.length - 1], k = key3(pt);
        if ((degree.get(k) ?? 0) !== 2) continue;
        if (!endsAt.has(k)) endsAt.set(k, []);
        endsAt.get(k).push({ c, side });
      }
    }
    for (const list of endsAt.values()) {
      if (list.length !== 2 || list[0].c === list[1].c) continue;
      const [a, b] = list;
      const pa = a.side === "end" ? a.c.points : [...a.c.points].reverse(), pb = b.side === "start" ? b.c.points : [...b.c.points].reverse();
      chains.splice(chains.indexOf(a.c), 1);
      chains.splice(chains.indexOf(b.c), 1);
      chains.push({ id: `${a.c.id}+${b.c.id}`, points: [...pa, ...pb.slice(1)], closed: false, start: a.side === "end" ? a.c.start : a.c.end, end: b.side === "start" ? b.c.end : b.c.start });
      merged = true;
      break;
    }
  }
  // Every junction's arms: the chains leaving it and their directions.
  const arms = new Map();
  const arm = (chain, atStart) => {
    const pts = chain.points, node = atStart ? pts[0] : pts[pts.length - 1], next = atStart ? pts[1] : pts[pts.length - 2];
    const d = sub(next, node);
    d[1] = 0;
    const dir = normalize(d), k = key3(node);
    if (!arms.has(k)) arms.set(k, { node: [...node], list: [] });
    const entry = { chain, atStart, dir, trim: half };
    arms.get(k).list.push(entry);
    return entry;
  };
  for (const chain of chains) {
    if (chain.start) chain.trimStart = arm(chain, true);
    if (chain.end) chain.trimEnd = arm(chain, false);
  }
  // Each arm stops short by the others' half width over the sine of the angle between them
  // (a continuation straight through asks for nothing).
  for (const { list } of arms.values())
    for (const a of list) {
      let t = half;
      for (const b of list) {
        if (b === a) continue;
        const sine = Math.abs(a.dir[0] * b.dir[2] - a.dir[2] * b.dir[0]);
        if (sine > 0.2) t = Math.max(t, half / sine);
      }
      a.trim = Math.min(t, half * 4);
    }
  const chunks = [];
  let total = 0, samples = 0;
  for (const chain of chains) {
    const trim = [chain.trimStart?.trim ?? 0, chain.trimEnd?.trim ?? 0];
    const result = sweepPath(chain.points, { closed: chain.closed, profile, step, height, rise, bank, chunk, trim: trim[0] || trim[1] ? trim : null });
    for (const c of result.chunks) chunks.push({ ...c, path: chain.id });
    total += result.length;
    samples += result.samples;
  }
  // Patches: the arms' end corners in order around the node, fanned from its centre.
  let junctions = 0;
  for (const { node, list } of arms.values()) {
    if (list.length < 3) continue;
    const lift = (pt) => { const h = height ? height(pt[0], pt[2]) : null; return [pt[0], (h === null || h === undefined ? node[1] : h) + rise, pt[2]]; };
    const corners = [];
    for (const a of list) {
      const end = [node[0] + a.dir[0] * a.trim, 0, node[2] + a.dir[2] * a.trim], right = [-a.dir[2], 0, a.dir[0]];
      for (const side of [-1, 1]) corners.push(lift([end[0] + right[0] * half * side, 0, end[2] + right[2] * half * side]));
    }
    // Arms at right angles share corners (a T): each corner once, then in order around the node.
    const unique = [];
    for (const c of corners) if (!unique.some((u) => dist2(u, c) < 1e-6)) unique.push(c);
    corners.length = 0;
    corners.push(...unique.sort((u, v) => Math.atan2(u[2] - node[2], u[0] - node[0]) - Math.atan2(v[2] - node[2], v[0] - node[0])));
    const centre = lift(node), vertices = [centre.map(round), ...corners.map((c) => c.map(round))], faces = [];
    // Clockwise in x–z as sorted by atan2 means counter-clockwise seen from above (+y).
    for (let i = 0; i < corners.length; i++) faces.push({ vertices: [0, 1 + ((i + 1) % corners.length), 1 + i], material });
    chunks.push({ vertices, faces, from: 0, to: 0, junction: true });
    junctions++;
  }
  return { chunks, length: round(total), width: p.width, lanes: p.lanes, kind: p.kind, samples, chains: chains.length, junctions };
}
