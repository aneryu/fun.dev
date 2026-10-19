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
    out = { strips: profile.strips.map((s) => ({ width: s.width, material: s.material, offset: s.offset ?? 0 })), marks: (profile.marks ?? []).map((m) => ({ ...m })), lanes: profile.lanes ?? 1, kind: profile.kind ?? "road", ...(profile.bank ? { bank: profile.bank } : {}), ...(profile.thickness ? { thickness: profile.thickness } : {}) };
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

/**
 * Sweeps a profile along a path. `height(x, z)` (a terrain) replaces the path's heights
 * plus `rise`; `bank: { max, radius }` tilts the section by curvature (full bank at the
 * radius); `chunk` metres splits the result into meshes (shared seam vertices, no cracks).
 * Returns { chunks: [{ vertices, faces, from, to }], length, width, samples }.
 */
export function sweepPath(points, { closed = false, profile, step = 4, height = null, rise = 0.05, bank = null, chunk = Infinity } = {}) {
  const p = resolveProfile(profile);
  if (points.length < 2) throw new Error("a sweep needs a path of at least two points");
  const samples = subdivide(points, closed, step);
  const n = samples.length, segs = closed ? n : n - 1;
  if (height) for (const s of samples) { const h = height(s[0], s[2]); if (h !== null && h !== undefined) s[1] = h + rise; }
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
