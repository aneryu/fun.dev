// The body: segments lofted through rings along the skeleton and joined at seam rings
// (docs/character-generator.md#geometry). Built for the left half and the centre line, then
// mirrored. Rings turn counter-clockwise about their axis and start at their front (`w`).

import { createBuilder, exportMesh } from "./mesh.js";
import { ankleStation, direction, FOOT, footStations, frameOf, headStation, headStationAt, limbStation, sampleMap, trunkStation, trunkStationAt } from "./stations.js";
import { add, cross, dot, length, lerp, madd, mix, normalize, perpendicular, scale, smoothstep, sub } from "./vec.js";

// Vertex counts per LOD. Seam rings follow the specification's table; the arm hole in the
// torso is `holeCols × holeRings` cells, so its boundary has as many vertices as an arm ring.
export const LODS = [
  { torso: 24, neck: 16, head: 24, arm: 12, leg: 16, ankle: 16, crotch: 3, holeCols: [5, 8], holeRings: 3, thumb: [[-1, 1], 1], smooth: 0 },
  { torso: 12, neck: 8, head: 12, arm: 8, leg: 8, ankle: 8, crotch: 1, holeCols: [2, 4], holeRings: 2, thumb: [[0, 1], 1], smooth: 0 },
  { torso: 8, neck: 8, head: 8, arm: 4, leg: 6, ankle: 4, crotch: 1, holeCols: [2, 3], holeRings: 1, thumb: null, smooth: 0 },
];

// Islands of a body taken from a reference mesh: each part keeps its own texture (and UVs).
export const MESH_ATLAS = { head: [0, 0, 1, 1], upper: [0, 0, 1, 1], lower: [0, 0, 1, 1], feet: [0, 0, 1, 1] };

// Eye colours: cells of the first row of an 8 × 4 eye texture, in its order.
export const EYE_COLOURS = ["hazel", "green", "light_blue", "blue", "brown", "dark_brown", "amber", "grey"];
const eyeRect = (colour) => [Math.max(0, EYE_COLOURS.indexOf(colour)) / 8, 0, 1 / 8, 1 / 4];

export const ATLAS = {
  torso: [0, 0.5, 0.5, 0.5], head: [0.5, 0.5, 0.5, 0.5], hips: [0, 0.36, 0.5, 0.14],
  "leg.l": [0, 0, 0.125, 0.36], "leg.r": [0.125, 0, 0.125, 0.36],
  "arm.l": [0.25, 0, 0.125, 0.36], "arm.r": [0.375, 0, 0.125, 0.36],
  "hand.l": [0.5, 0.25, 0.125, 0.25], "hand.r": [0.625, 0.25, 0.125, 0.25],
  "thumb.l": [0.75, 0.375, 0.0625, 0.125], "thumb.r": [0.8125, 0.375, 0.0625, 0.125],
  "foot.l": [0.5, 0, 0.125, 0.25], "foot.r": [0.625, 0, 0.125, 0.25],
};

const TAU = 2 * Math.PI;
const Z = [0, 0, 1], Y = [0, 1, 0], X = [1, 0, 0];

/** Island u for a ring angle: the front at 0.5, the left side from 0.5 to 1, the seam at the back. */
function uOf(theta) {
  const t = ((theta % TAU) + TAU) % TAU;
  return t <= Math.PI ? 0.5 + t / TAU : t / TAU - 0.5;
}

/**
 * A profile point at angle θ: [along u, along w]. `side` is the half-width, `front` and `back`
 * the half-depths, `power` the superellipse exponent (2 = ellipse), `bumps` radial additions.
 */
function profilePoint(profile, theta) {
  const c = Math.cos(theta), s = Math.sin(theta), e = 2 / (profile.power ?? 2);
  const f = Math.sign(c) * Math.abs(c) ** e * (c >= 0 ? profile.front : profile.back);
  const g = Math.sign(s) * Math.abs(s) ** e * (s >= 0 ? profile.side : profile.side2 ?? profile.side);
  let r = 0;
  for (const bump of profile.bumps ?? []) {
    const d = Math.atan2(Math.sin(theta - bump.at), Math.cos(theta - bump.at));
    r += bump.amount * Math.exp(-((d / bump.width) ** 2));
  }
  const len = Math.hypot(f, g) || 1;
  return [g + (g / len) * r, f + (f / len) * r + (profile.shift ?? 0)];
}

export function buildBody(shape, skeleton, lodIndex, { worn = [], eyes = EYE_COLOURS[0], face = null } = {}) {
  const lod = LODS[lodIndex];
  if (!lod) throw new Error(`lod must be 0–${LODS.length - 1}`);
  if (shape.mesh) return buildFromMesh(shape, skeleton, lodIndex, worn, eyes, face);
  if (worn.length) throw new Error("garments need a body from a reference mesh");
  const b = createBuilder();
  const pos = (id) => skeleton.bones[skeleton.index.get(id)].position;
  const f = frameOf(skeleton, shape.landmarks);
  const M = shape.maps;
  const J = { shoulder: pos("l_upperarm"), elbow: pos("l_forearm"), wrist: pos("l_hand"), hip: pos("l_thigh"), knee: pos("l_calf"), ankle: pos("l_foot") };
  const seams = {};
  const pinned = new Set();   // vertices smoothing leaves in place (tips, crown)

  /** Makes ring vertices. `angles` default to uniform from the front; centre rings make the left half. */
  function ring({ center, t, w, profile, radius, n, half = false, angles, weights, v, clampFloor = false }) {
    const u = cross(t, w);
    const ids = new Array(n), us = new Array(n), points = new Array(n);
    const last = half ? n / 2 : n - 1;
    for (let i = 0; i <= last; i++) {
      const theta = angles ? angles[i] : Math.PI * ((2 * i) / n);
      let q;
      if (radius) q = madd(center, direction({ t, w }, theta), radius(theta));
      else { const [gu, fw] = profilePoint(profile, theta); q = add(add(center, scale(w, fw)), scale(u, gu)); }
      if (half && (i === 0 || i === n / 2)) q = [0, q[1], q[2]];
      if (clampFloor && q[1] < 0.008) q = [q[0], 0, q[2]];   // the sole is flat on the floor
      points[i] = q;
      ids[i] = b.vertex(q, weights(q, i));
      us[i] = uOf(theta);
    }
    return { ids, u: us, v, points, n, t, w, center };
  }

  /**
   * Orders a port loop so the faces built on it run each boundary edge opposite to the faces
   * already there (the surface stays oriented), from the vertex closest to `w`; returns its
   * angles about `t` too.
   */
  function orientLoop(ids, t, w) {
    const ps = ids.map((id) => b.vertices[id].p);
    const c = scale(ps.reduce((s, q) => add(s, q), [0, 0, 0]), 1 / ps.length);
    const u = cross(t, w);
    const ang = (q) => { const d = sub(q, c); return Math.atan2(dot(d, u), dot(d, w)); };
    const runs = (a, c) => b.faces.some((f) => f.v.some((v, k) => v === a && f.v[(k + 1) % 3] === c));
    let reverse = null;
    for (let i = 0; i < ids.length && reverse === null; i++) {
      const a = ids[i], c = ids[(i + 1) % ids.length];
      if (runs(a, c)) reverse = true; else if (runs(c, a)) reverse = false;
    }
    if (reverse === null) {   // a free loop: counter-clockwise about t
      let turn = 0;
      for (let i = 0; i < ps.length; i++) { const d = ang(ps[(i + 1) % ps.length]) - ang(ps[i]); turn += Math.atan2(Math.sin(d), Math.cos(d)); }
      reverse = turn < 0;
    }
    let order = reverse ? [...ids].reverse() : [...ids];
    const front = (id) => { const d = normalize(sub(b.vertices[id].p, c)); return dot(d, w); };
    let start = 0;
    order.forEach((id, i) => { if (front(id) > front(order[start]) + 1e-12) start = i; });
    order = [...order.slice(start), ...order.slice(0, start)];
    const angles = [];
    let prev = ang(b.vertices[order[0]].p);
    if (prev > Math.PI / 2) prev -= TAU;
    angles.push(prev);
    for (let i = 1; i < order.length; i++) {
      let a = ang(b.vertices[order[i]].p);
      while (a < prev) a += TAU;
      angles.push(a); prev = a;
    }
    return { ids: order, angles, center: c };
  }
  const portRing = (loop, v) => ({ ids: loop.ids, u: loop.angles.map(uOf), v, n: loop.ids.length });
  const aligned = (loop, n, blend) => Array.from({ length: n }, (_, i) => mix(loop.angles[i], Math.PI * ((2 * i) / n), blend));

  // Weights.
  const trunk = [
    ["pelvis", (pos("hips")[1] + J.hip[1]) / 2], ["spine_root", mid("spine_root", "spine0")], ["spine0", mid("spine0", "spine1")],
    ["spine1", mid("spine1", "spine2")], ["spine2", mid("spine2", "spine3")], ["spine3", mid("spine3", "neck")],
    ["neck", mid("neck", "head")], ["head", pos("head")[1]],
  ];
  function mid(a, c) { return (pos(a)[1] + pos(c)[1]) / 2; }
  const chain = (list, x) => {
    if (x <= list[0][1]) return [[list[0][0], 1]];
    for (let i = 0; i < list.length - 1; i++) {
      const [a, xa] = list[i], [c, xc] = list[i + 1];
      if (x <= xc) { const t = (x - xa) / (xc - xa); return [[a, 1 - t], [c, t]]; }
    }
    return [[list.at(-1)[0], 1]];
  };
  const blend = (wa, wb, t) => [...wa.map(([n, w]) => [n, w * (1 - t)]), ...wb.map(([n, w]) => [n, w * t])];

  const meanRadius = (map, st) => { const r = map.r[Math.round(st * (map.r.length - 1))]; return r.reduce((a, c) => a + c, 0) / r.length; };
  const rArm = meanRadius(M.arm, 0.3), rThigh = meanRadius(M.leg, 0.1);
  const shoulderWeights = (q, base) => {
    if (q[0] <= 0) return base;
    const k = 1 - smoothstep(0.8 * rArm, 2.6 * rArm, length(sub(q, J.shoulder)));
    return k > 0 ? blend(base, [["l_clavicle", 0.5], ["l_upperarm", 0.5]], k) : base;
  };
  const torsoWeights = (q) => shoulderWeights(q, chain(trunk, q[1]));

  // ── Shapes: radii sampled from the body shape's maps at each ring's station. ──
  const trunkAt = (y) => { const st = trunkStation(f, trunkStationAt(f, y)); return { ...st, center: [0, y, 0], radius: (th) => sampleMap(M.trunk, trunkStationAt(f, y), th) }; };
  const headAt = (y) => { const s = headStationAt(f, y); const st = headStation(f, s); return { ...st, radius: (th) => sampleMap(M.head, s, th) }; };
  const armAt = (s) => { const st = limbStation(f.arm, s); return { ...st, radius: (th) => sampleMap(M.arm, s, th) }; };
  const legAt = (s) => { const st = limbStation(f.leg, s); return { ...st, radius: (th) => sampleMap(M.leg, s, th) }; };

  // ── Torso: waist up to the shoulders, with the left arm hole, then the neck seam. ──
  const nT = lod.torso;
  const sy = J.shoulder[1], hipX = J.hip[0];
  const crotchY = shape.landmarks.crotchY, crotchRingY = f.trunkLow;
  const yW = pos("spine1")[1], yAp = sy - 1.7 * rArm, ySh = sy + 0.35 * rArm, yTop = f.neckSeam[1];
  const below = [[0, 0.2, 0.4, 0.55, 0.7, 0.85], [0, 0.5], [0]][lodIndex].map((k) => mix(yW, yAp, k));
  const above = [[0.15, 0.32, 0.52, 0.76], [0.25, 0.6], [0.5]][lodIndex].map((k) => mix(ySh, yTop, k));
  const levels = below.map((y) => ({ y }));
  const hole0 = levels.length;
  for (let k = 0; k <= lod.holeRings; k++) levels.push({ y: mix(yAp, ySh, k / lod.holeRings) });
  const hole1 = levels.length - 1;
  levels.push(...above.map((y) => ({ y })));
  const torsoLength = yTop - yW;
  const torsoRings = levels.map((l) => ring({ ...trunkAt(l.y), n: nT, half: true, weights: torsoWeights, v: (l.y - yW) / torsoLength * 0.85 }));
  const [c0, c1] = lod.holeCols;
  for (let r = 0; r < torsoRings.length - 1; r++) {
    for (let c = 0; c < nT / 2; c++) {
      if (r >= hole0 && r < hole1 && c >= c0 && c < c1) continue;
      const A = torsoRings[r], B = torsoRings[r + 1];
      b.quad(A.ids[c], A.ids[c + 1], B.ids[c + 1], B.ids[c], "torso",
        [[A.u[c], A.v], [A.u[c + 1], A.v], [B.u[c + 1], B.v], [B.u[c], B.v]]);
    }
  }
  seams.waist = torsoRings[0];

  // Neck seam ring, shared with the head.
  const nN = lod.neck;
  const neckR = meanRadius(M.head, 0);
  const neckAt = (t) => lerp(pos("neck"), pos("head"), t);
  const neckSeam = ring({ ...trunkAt(yTop), n: nN, half: true, weights: (q) => chain(trunk, q[1]), v: 1 });
  b.bridge(torsoRings.at(-1), neckSeam, "torso", { half: true });
  seams.neck = neckSeam;

  // ── Left arm from the hole. ──
  const hole = [];
  const TR = (r, c) => torsoRings[r].ids[c];
  for (let c = c0; c <= c1; c++) hole.push(TR(hole0, c));
  for (let r = hole0 + 1; r <= hole1; r++) hole.push(TR(r, c1));
  for (let c = c1 - 1; c >= c0; c--) hole.push(TR(hole1, c));
  for (let r = hole1 - 1; r > hole0; r--) hole.push(TR(r, c0));
  const armStart = armAt(0.12);
  const armPort = orientLoop(hole, armStart.t, armStart.w);
  // Each hole vertex moves to where the arm's surface, followed in from its first ring at the
  // vertex's own angle, enters the torso: the hole becomes the arm's line of attachment.
  const insideTorso = (q) => {
    const st = trunkStationAt(f, q[1]);
    if (st < 0 || st > 1) return false;
    return Math.hypot(q[0], q[2]) < sampleMap(M.trunk, st, Math.atan2(q[0], q[2]));
  };
  const armSurface = (s, th) => { const st = armAt(Math.max(s, M.arm.stations[0])); const c = limbStation(f.arm, s); return madd(c.center, direction(st, th), st.radius(th)); };
  const capRow = new Set(torsoRings[hole1].ids);   // the top of the hole keeps the shoulder's cap
  armPort.ids.forEach((id, i) => {
    if (capRow.has(id)) return;
    const th = armPort.angles[i];
    // Where the arm already lies against the torso at its first ring (the armpit), the vertex stays.
    if (insideTorso(armSurface(0.12, th))) return;
    let hi = 0.12, lo = hi;
    while (lo > -0.25 && !insideTorso(armSurface(lo, th))) lo -= 0.01;
    if (!insideTorso(armSurface(lo, th))) return;
    for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2; if (insideTorso(armSurface(m, th))) lo = m; else hi = m; }
    b.vertices[id].p = armSurface(Math.min((lo + hi) / 2, 0.1), th);
  });
  const nA = lod.arm;
  const eS = limbStation(f.arm, 0).knee, sW = 0.985;
  const fore = (t) => eS + t * (1 - eS);
  const armWeights = (s) => s < eS
    ? ((t) => [["l_upperarm", 1], ["l_clavicle", 0.3 * (1 - smoothstep(0, 0.4, t))], ["l_forearm", smoothstep(0.75, 1, t)]])(s / eS)
    : ((t) => [["l_forearm", 1], ["l_upperarm", 1 - smoothstep(0, 0.25, t)], ["l_hand", smoothstep(0.75, 1, t)]])((s - eS) / (1 - eS));
  const armStations = [[0.12, 0.3 * eS, 0.55 * eS, 0.8 * eS, eS, fore(0.25), fore(0.5), fore(0.75)], [0.4 * eS, eS, fore(0.45)], [eS]][lodIndex];
  let prev = portRing(armPort, 0);
  armStations.forEach((st, k) => {
    const next = ring({ ...armAt(st), n: nA, v: st / sW, angles: aligned(armPort, nA, [0.5, 0.85][k] ?? 1), weights: () => armWeights(st) });
    b.stitch(prev, next, "arm.l");
    prev = next;
  });
  const wristSeam = ring({ ...armAt(sW), n: nA, v: 1, weights: () => armWeights(sW) });
  b.stitch(prev, wristSeam, "arm.l");
  seams.wrist = wristSeam;

  // ── Hips: from the waist seam down to the crotch. ──
  const thighBlend = (q) => {
    const k = Math.min(1, Math.max(0, (pos("hips")[1] - q[1]) / (pos("hips")[1] - crotchY))) * Math.min(1, Math.max(0, q[0] / (hipX + rThigh))) * 0.6;
    return blend(chain(trunk, q[1]), [["l_thigh", 1]], k);
  };
  const pelvisHeights = [[0.25, 0.5, 0.75, 1], [0.5, 1], [1]][lodIndex].map((k) => mix(yW, crotchRingY, k));
  const hipSpan = yW - crotchY;
  let upper = seams.waist;
  for (const y of pelvisHeights) {
    const lower = ring({ ...trunkAt(y), n: nT, half: true, weights: thighBlend, v: (y - crotchY) / hipSpan });
    b.stitch(lower, { ...upper, v: upper === seams.waist ? 1 : upper.v }, "hips", { half: true });
    upper = lower;
  }
  const crotchRing = upper;
  const crotch = [];
  for (let k = 1; k <= lod.crotch; k++) {
    const t = k / (lod.crotch + 1);
    const zf = crotchRing.points[0][2], zb = crotchRing.points[nT / 2][2];
    crotch.push(b.vertex([0, mix(crotchRingY, crotchY, Math.sin(Math.PI * t)), mix(zf, zb, t)], [["pelvis", 1]]));
  }
  const legLoop = [crotchRing.ids[0], ...crotch, crotchRing.ids[nT / 2]];
  for (let c = nT / 2 - 1; c >= 1; c--) legLoop.push(crotchRing.ids[c]);
  const legStart = legAt(shape.landmarks.legTop);
  const legPort = orientLoop(legLoop, legStart.t, legStart.w);
  const nL = lod.leg;
  if (legPort.ids.length !== nL) throw new Error(`leg port has ${legPort.ids.length} vertices, not ${nL}`);

  // ── Left leg. ──
  const kS = limbStation(f.leg, 0).knee, sTop = shape.landmarks.legTop, sA = ankleStation(f);
  const shin = (t) => kS + t * (1 - kS);
  const legWeights = (st) => st < kS
    ? ((t) => [["l_thigh", 1], ["pelvis", 0.3 * (1 - smoothstep(0, 0.3, t))], ["l_calf", smoothstep(0.8, 1, t)]])(st / kS)
    : ((t) => [["l_calf", 1], ["l_thigh", 1 - smoothstep(0, 0.2, t)], ["l_foot", smoothstep(0.8, 1, t)]])((st - kS) / (1 - kS));
  const legStations = [[sTop, mix(sTop, kS, 0.3), mix(sTop, kS, 0.6), mix(sTop, kS, 0.85), kS, shin(0.25), shin(0.5), shin(0.75)],
    [mix(sTop, kS, 0.4), kS, shin(0.4)], [kS]][lodIndex];
  prev = portRing(legPort, 0);
  legStations.forEach((st, k) => {
    const next = ring({ ...legAt(st), n: nL, v: st / sA, angles: aligned(legPort, nL, [0.5, 0.85][k] ?? 1), weights: () => legWeights(st) });
    b.stitch(prev, next, "leg.l");
    prev = next;
  });
  const nAnk = lod.ankle;
  const ankleSeam = ring({ ...legAt(sA), n: nAnk, v: 1, weights: () => legWeights(sA) });
  if (nAnk === nL) b.stitch(prev, ankleSeam, "leg.l"); else b.bridge(prev, ankleSeam, "leg.l");
  seams.ankle = ankleSeam;
  const rWrist = meanRadius(M.arm, 1), rAnkle = meanRadius(M.leg, 1);

  // ── Extremities: head (left half), left hand and left foot from the shape's pieces, stitched
  // to their seam rings by angle. ──
  const pieceLevel = (key) => shape.extremities[key][Math.min(lodIndex, shape.extremities[key].length - 1)];
  function insertPiece(piece, island) {
    const ids = piece.p.map((p, i) => b.vertex(p, piece.w[i]));
    for (const [x, y, z] of piece.f) b.tri(ids[x], ids[y], ids[z], island, [piece.uv[x], piece.uv[y], piece.uv[z]]);
    return ids;
  }
  /** Angles of points about a seam ring's centre in its frame, unwrapped to increase from about 0. */
  function anglesAbout(ringFrame, points, { half = false } = {}) {
    const u = cross(ringFrame.t, ringFrame.w);
    const raw = points.map((q) => { const d = sub(q, ringFrame.center); return Math.atan2(dot(d, u), dot(d, ringFrame.w)); });
    const out = [];
    let prev = half ? Math.max(0, raw[0]) : raw[0] > Math.PI / 2 ? raw[0] - TAU : raw[0];
    out.push(half ? 0 : prev);
    for (let i = 1; i < raw.length; i++) { let a = raw[i]; while (a < prev) a += TAU; out.push(a); prev = a; }
    if (half) out[out.length - 1] = Math.PI;
    return out;
  }
  /** Triangles between a seam ring and a piece's cut chain, merged by angle. */
  function zip(ring, ringAngles, chain, chainAngles, island, { half = false } = {}) {
    const A = half ? ring.ids.slice(0, ring.n / 2 + 1) : [...ring.ids, ring.ids[0]];
    const aa = half ? ringAngles.slice(0, ring.n / 2 + 1) : [...ringAngles, ringAngles[0] + TAU];
    const B = half ? chain : [...chain, chain[0]];
    const ba = half ? chainAngles : [...chainAngles, chainAngles[0] + TAU];
    const uvA = (i) => [uOf(aa[i]), 0], uvB = (j) => [uOf(ba[j]), 0.04];
    let i = 0, j = 0;
    while (i < A.length - 1 || j < B.length - 1) {
      if (j >= B.length - 1 || (i < A.length - 1 && aa[i + 1] <= ba[j + 1])) { b.tri(A[i], A[i + 1], B[j], island, [uvA(i), uvA(i + 1), uvB(j)]); i++; }
      else { b.tri(A[i], B[j + 1], B[j], island, [uvA(i), uvB(j + 1), uvB(j)]); j++; }
    }
  }
  const ringAngles = (r) => r.ids.map((id, i) => anglesAbout({ ...r, center: r.center }, [b.vertices[id].p])[0]);
  for (const [key, ring, island, half] of [["head", neckSeam, "head", true], ["hand", seams.wrist, "hand.l", false], ["foot", ankleSeam, "foot.l", false]]) {
    const piece = pieceLevel(key);
    const ids = insertPiece(piece, island);
    const frame = { center: ring.center, t: ring.t, w: ring.w };
    const ringIds = half ? ring.ids.slice(0, ring.n / 2 + 1) : ring.ids;
    const ra = anglesAbout(frame, ringIds.map((id) => b.vertices[id].p), { half });
    const chain = piece.chain.map((k) => ids[k]);
    const ca = anglesAbout(frame, chain.map((id) => b.vertices[id].p), { half });
    zip(ring, half ? ra : ra, chain, ca, island, { half });
  }

  // Eyeballs: a small sphere about each eye bone (the reference keeps them as separate meshes).
  {
    const centre = pos("l_eye"), r = 0.0118, [rings, segments] = [[6, 10], [4, 8], [3, 6]][lodIndex];
    const top = b.vertex([centre[0], centre[1] + r, centre[2]], [["l_eye", 1]]), bottom = b.vertex([centre[0], centre[1] - r, centre[2]], [["l_eye", 1]]);
    const grid = [];
    for (let i = 1; i < rings; i++) {
      const phi = (Math.PI * i) / rings, row = [];
      for (let j = 0; j < segments; j++) {
        const th = (TAU * j) / segments;
        row.push(b.vertex([centre[0] + r * Math.sin(phi) * Math.sin(th), centre[1] + r * Math.cos(phi), centre[2] + r * Math.sin(phi) * Math.cos(th)], [["l_eye", 1]]));
      }
      grid.push(row);
    }
    const uv = (i, j) => [0.02 + (0.06 * j) / segments, 0.02 + (0.06 * i) / rings];
    for (let j = 0; j < segments; j++) {
      const k = (j + 1) % segments;
      b.tri(top, grid[0][j], grid[0][k], "head", [uv(0, j), uv(1, j), uv(1, j + 1)]);
      b.tri(bottom, grid.at(-1)[k], grid.at(-1)[j], "head", [uv(rings, j), uv(rings - 1, j + 1), uv(rings - 1, j)]);
      for (let i = 0; i < grid.length - 1; i++) b.quad(grid[i][j], grid[i + 1][j], grid[i + 1][k], grid[i][k], "head", [uv(i + 1, j), uv(i + 2, j), uv(i + 2, j + 1), uv(i + 1, j + 1)]);
    }
  }

  // Per-vertex corrections fitted by projecting this exact topology onto the reference surface
  // (the shape's `corrections[lod]`, for the left half and centre line, in builder order).
  const leftCount = b.vertices.length;
  const correction = shape.corrections?.[lodIndex];
  if (correction) {
    if (correction.length !== leftCount * 3) throw new Error(`shape corrections for LOD${lodIndex} fit ${correction.length / 3} vertices, not ${leftCount}: refit the shape`);
    b.vertices.forEach((v, i) => {
      const q = [v.p[0] + correction[i * 3], v.p[1] + correction[i * 3 + 1], v.p[2] + correction[i * 3 + 2]];
      v.p = v.p[0] === 0 ? [0, q[1], q[2]] : q;
    });
  }

  const mirrorMap = b.mirror();
  // Smooth the joins. Faces and hands keep most of their shape; tips, the crown and soles stay.
  const region = (v) => {
    const top = v.w.reduce((a, c) => (c[1] > a[1] ? c : a), ["", 0])[0].replace(/^r_/, "l_");
    return /^(head|face|.*lip|.*brow|.*eye|.*cheek|jaw|tongue)/.test(top) ? 0.25 : /hand|finger/.test(top) ? 0.35 : /foot|toe/.test(top) ? 0.45 : 1;
  };
  const pins = new Set([...pinned].flatMap((i) => [i, mirrorMap[i]]));
  const joins = [[J.shoulder, 2.6 * rArm], [J.hip, 1.6 * rThigh], [[0, crotchY, 0], 1.4 * rThigh], [neckAt(0.3), 2.2 * neckR],
    [J.wrist, 2 * rWrist], [J.ankle, 2.2 * rAnkle]];
  const near = (q) => {
    const x = Math.abs(q[0]);
    return Math.max(0, ...joins.map(([c, r]) => 1 - Math.min(1, length(sub([x, q[1], q[2]], [Math.abs(c[0]), c[1], c[2]])) / r)));
  };
  b.smooth({ iterations: lod.smooth, strength: (v, i) => (pins.has(i) || v.p[1] <= 1e-9 ? 0 : region(v) * mix(0.3, 1, smoothstep(0, 0.6, near(v.p)))) });
  mirrorMap.forEach((m, i) => { if (m !== i) b.vertices[m].p = [-b.vertices[i].p[0], b.vertices[i].p[1], b.vertices[i].p[2]]; });
  for (const v of b.vertices) if (v.p[1] < 0) v.p = [v.p[0], 0, v.p[2]];
  const mesh = exportMesh(b, skeleton.index, ATLAS);
  mesh.leftCount = leftCount;
  const seamIds = (r, half) => {
    const left = r.ids.slice(0, half ? r.n / 2 + 1 : r.n);
    if (half) return [...left, ...Array.from({ length: r.n / 2 - 1 }, (_, k) => mirrorMap[r.ids[r.n / 2 - 1 - k]])].map((v) => mesh.topology.vertexOf[v]);
    return left.map((v) => mesh.topology.vertexOf[v]);
  };
  mesh.seams = {
    neck: seamIds(seams.neck, true), waist: seamIds(seams.waist, true),
    l_wrist: seamIds(seams.wrist), r_wrist: seams.wrist.ids.map((v, i, a) => mesh.topology.vertexOf[mirrorMap[a[(a.length - i) % a.length]]]),
    l_ankle: seamIds(seams.ankle), r_ankle: seams.ankle.ids.map((v, i, a) => mesh.topology.vertexOf[mirrorMap[a[(a.length - i) % a.length]]]),
  };
  return mesh;
}

/**
 * A body from a shape's own mesh (the reference body, simplified per LOD): its left half and
 * centre line, mirrored, with eyeballs added. Weights are the shape's, already on our bones.
 */
/**
 * The body from the shape's own mesh (the left half) with its face's deltas, less the faces the
 * worn garments cover and
 * with the skin near their edges tucked under them; then each garment (whole, not mirrored) as an
 * island named by its id.
 */
function buildFromMesh(shape, skeleton, lodIndex, worn, eyes, face) {
  const level = shape.mesh[Math.min(lodIndex, shape.mesh.length - 1)];
  const hidden = new Set(worn.flatMap((g) => g.hides[Math.min(lodIndex, g.hides.length - 1)]));
  // Skin under a worn garment's surface is pushed below it (the deepest push where garments overlap).
  const tucked = new Map();
  for (const g of worn) {
    const list = g.tucks?.[Math.min(lodIndex, g.tucks.length - 1)] ?? [];
    for (let n = 0; n < list.length; n += 4) {
      const d = [list[n + 1], list[n + 2], list[n + 3]], was = tucked.get(list[n]);
      if (!was || Math.hypot(...d) > Math.hypot(...was)) tucked.set(list[n], d);
    }
  }
  const b = createBuilder();
  const ids = level.p.map((p, i) => {
    const f = face?.vertex(i), d = tucked.get(i);
    const q = f ? [p[0] + f[0], p[1] + f[1], p[2] + f[2]] : p;
    return b.vertex(d ? [q[0] + d[0], q[1] + d[1], q[2] + d[2]] : q, level.w[i]);
  });
  level.f.forEach(([x, y, z], k) => { if (!hidden.has(k)) b.tri(ids[x], ids[y], ids[z], level.fisland[k], level.fuv[k], { wrap: false }); });
  // Eyeballs, unless the shape has none (a mannequin).
  const eye = skeleton.bones[skeleton.index.get("l_eye")].position, de = face?.eyes ?? [0, 0, 0];
  if (shape.eyes !== false) addEyes(b, [eye[0] + de[0], eye[1] + de[1], eye[2] + de[2]], lodIndex, "eyes", shape.eyeRadius);
  b.mirror({ flipU: () => false });
  const atlas = { ...MESH_ATLAS, eyes: eyeRect(eyes) };
  for (const island of level.fisland) atlas[island] ??= [0, 0, 1, 1];   // a shape's own parts, each with its texture
  for (const g of worn) {
    const gl = g.mesh[Math.min(lodIndex, g.mesh.length - 1)];
    const gids = gl.p.map((p, i) => b.vertex(p, gl.w[i]));
    gl.f.forEach(([x, y, z], k) => b.tri(gids[x], gids[y], gids[z], g.id, gl.fuv[k], { wrap: false }));
    atlas[g.id] = null;
  }
  const mesh = exportMesh(b, skeleton.index, atlas);
  mesh.seams = null;
  return mesh;
}

/**
 * A small sphere about the left eye bone (the reference keeps eyeballs as separate meshes), its
 * pole facing forward. UVs are the front view of the sphere in a [0, 1] cell with the eyeball's
 * disc of radius 0.47 at its centre, as eye textures are painted; the back is on the disc's rim.
 */
function addEyes(b, centre, lodIndex, island, r = 0.0118) {
  const [rings, segments] = [[6, 12], [4, 8], [3, 6]][lodIndex];
  const at = (phi, th) => [Math.sin(phi) * Math.cos(th), Math.sin(phi) * Math.sin(th), Math.cos(phi)];
  const uvOf = (phi, th) => { const rho = 0.47 * (phi <= Math.PI / 2 ? Math.sin(phi) : 1); return [0.5 + rho * Math.cos(th), 0.5 - rho * Math.sin(th)]; };
  const vertex = (d) => b.vertex([centre[0] + r * d[0], centre[1] + r * d[1], centre[2] + r * d[2]], [["l_eye", 1]]);
  const front = vertex([0, 0, 1]), back = vertex([0, 0, -1]);
  const grid = [];
  for (let i = 1; i < rings; i++) {
    const row = [];
    for (let j = 0; j < segments; j++) row.push(vertex(at((Math.PI * i) / rings, (TAU * j) / segments)));
    grid.push(row);
  }
  const phiOf = (i) => (Math.PI * i) / rings, thOf = (j) => (TAU * j) / segments;
  for (let j = 0; j < segments; j++) {
    const k = (j + 1) % segments;
    // Counter-clockwise seen from outside: from the front pole, θ turns from +x to +y.
    b.tri(front, grid[0][j], grid[0][k], island, [uvOf(0, thOf(j + 0.5)), uvOf(phiOf(1), thOf(j)), uvOf(phiOf(1), thOf(j + 1))], { wrap: false });
    b.tri(back, grid.at(-1)[k], grid.at(-1)[j], island, [uvOf(Math.PI, thOf(j + 0.5)), uvOf(phiOf(rings - 1), thOf(j + 1)), uvOf(phiOf(rings - 1), thOf(j))], { wrap: false });
    for (let i = 0; i < grid.length - 1; i++) {
      const uv = [uvOf(phiOf(i + 1), thOf(j)), uvOf(phiOf(i + 2), thOf(j)), uvOf(phiOf(i + 2), thOf(j + 1)), uvOf(phiOf(i + 1), thOf(j + 1))];
      b.tri(grid[i][j], grid[i + 1][j], grid[i + 1][k], island, [uv[0], uv[1], uv[2]], { wrap: false });
      b.tri(grid[i][j], grid[i + 1][k], grid[i][k], island, [uv[0], uv[2], uv[3]], { wrap: false });
    }
  }
}
