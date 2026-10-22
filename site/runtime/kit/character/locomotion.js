// Locomotion made from key poses (docs/character-generator.md#locomotion): role clips made, not
// stored. The motions (clips/motions.json) hold, per body, a standing pose and per motion (idle,
// walk, run, sprint) at most five key poses: each of the 18 main joints' rotation from standing
// (degrees, in steps of 5) and the hips' offset (whole centimetres), at phases of a cycle, and the
// hips' rise and fall (`bob`, whole centimetres). Walk,
// run and sprint give the left step's poses from the heel strike; the right step is their mirror.
// Everything between is made here: a periodic spline through the poses, the idle's breath, the
// fingers' rest (characterTracks), and three gaits made from those (stroll, brisk walk, jog). A
// style scales the arms' swing, the hips' bounce and sway, the trunk's lean and the pace; a seed
// gives each character its own.
//
//   const model = await (await fetch(new URL("./clips/motions.json", kitUrl))).json();
//   const clips = locomotionClips(model, character.semantic.body, { style: locomotionStyle(character.seed) });
//   const walker = createWalker(THREE, object, character, clips);         // the idle is among them

/** The neutral style: each factor scales its part of the motion. */
export const STYLE = Object.freeze({ arms: 1, bounce: 1, sway: 1, lean: 1, pace: 1 });

// The rule for key poses taken from reference motion (checked by the tests): at most `keys` per
// motion and body, only `joints`, rotations in steps of `step` degrees, offsets in whole centimetres.
export const KEY_RULE = Object.freeze({
  keys: 5, step: 5,
  joints: ["hips", "spine", "chest", "upperChest", "neck", "head", ...["Shoulder", "UpperArm", "LowerArm", "UpperLeg", "LowerLeg", "Foot"].flatMap((r) => [`left${r}`, `right${r}`])],
});

const RAD = Math.PI / 180;
const TRUNK = new Set(["spine", "chest", "upperChest", "neck", "head"]);
// A stride scales the thighs' and upper arms' swing; the shin and the forearm keep their bend from
// them, so a shorter stride still lifts the foot and the elbows bend as they did; the feet keep
// their own turn (flat on the ground), and the hips sink or rise so the lower ankle is as high.
const LIMBS = { UpperLeg: ["LowerLeg"], UpperArm: ["LowerArm"] };
const CYCLES = new Set(["walk", "run", "sprint"]);

/** A character's own style from a seed: each factor within ±15 % (pace ±6 %), the same for the same seed. */
export function locomotionStyle(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const next = () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
  const around = (spread) => 1 + (next() * 2 - 1) * spread;
  return { arms: around(0.15), bounce: around(0.15), sway: around(0.15), lean: around(0.15), pace: around(0.06) };
}

// Gaits made from the model's, each one of its gaits at another stride and pace: a stroll, half the
// walk's stride at three quarters of its pace (people slowing down shorten their steps and take
// fewer), so slow walking does not blend walking with standing; a brisk walk at 1.3 times the
// walk's speed, and a jog, the run shortened to 1.6 times the walk's speed, so the walk turns
// into a run over a narrow band of speeds (as people's does, near 2 m/s).
const VARIANTS = {
  stroll: () => ({ from: "walk", stride: 0.5, pace: 0.75 }),
  brisk: () => ({ from: "walk", stride: Math.sqrt(1.3), pace: Math.sqrt(1.3) }),
  jog: (m) => { const r = Math.min(1, Math.sqrt((speedOf(m, "walk") * 1.6) / speedOf(m, "run"))); return { from: "run", stride: r, pace: r }; },
};
const bodyOf = (model, body) => model.bodies[body] ?? Object.values(model.bodies)[0];
const variantOf = (m, name) => (VARIANTS[name] && m.motions.walk && m.motions.run ? VARIANTS[name](m) : null);

/**
 * A cycle's speed on its own skeleton (m/s), as the gait measures one: the lower foot's backward
 * speed while it is down (within 3 cm of its lowest), over the cycle sampled at 60 phases.
 */
const speeds = new WeakMap();
function speedOf(m, name) {
  const g = m.motions[name];
  if (!g || !CYCLES.has(name)) return 0;
  if (speeds.get(g) != null) return speeds.get(g);
  const keys = [...g.keys, ...g.keys.map((k) => ({ phase: k.phase + 0.5, pose: mirror(k.pose) }))].sort((a, b) => a.phase - b.phase), n = 60;
  const feet = Array.from({ length: n }, (_, f) => {
    const pose = at(keys, f / n);
    return ["left", "right"].map((side) => add(pose.hipsOffset, ankleOf(m, side, (r) => mul(exp((pose[r] ?? [0, 0, 0]).map((x) => x * RAD)), exp((m.stand[r] ?? [0, 0, 0]).map((x) => x * RAD))))));
  });
  const low = [0, 1].map((k) => Math.min(...feet.map((f) => f[k][1]))), dt = g.cycle / n, v = [];
  for (let f = 0; f < n; f++) for (const k of [0, 1]) {
    const a = feet[f][k], b = feet[(f + 1) % n][k];
    if (a[1] <= feet[f][1 - k][1] && a[1] < low[k] + 0.03) v.push(-(b[2] - a[2]) / dt);
  }
  const speed = v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0;
  speeds.set(g, speed);
  return speed;
}

/** The motions for a body (its own, else the first), slowest first: [{ name, speed, cycle }]. */
export function locomotionGaits(model, body) {
  const m = bodyOf(model, body);
  const out = Object.entries(m.motions).filter(([, g]) => g.cycle).map(([name, g]) => ({ name, speed: speedOf(m, name), cycle: g.cycle }));
  for (const name of Object.keys(VARIANTS)) {
    const v = variantOf(m, name);
    if (v) out.push({ name, speed: speedOf(m, v.from) * v.stride * v.pace, cycle: m.motions[v.from].cycle / v.pace });
  }
  return out.sort((a, b) => a.speed - b.speed);
}

/**
 * One motion as a role clip (one cycle, looping; for retargetClip, createGait and createWalker),
 * at `fps`, in a style (STYLE's factors; a faster pace takes shorter cycles and so goes faster).
 */
export function locomotionClip(model, body, name, { fps = 30, style = {} } = {}) {
  const m = bodyOf(model, body), variant = variantOf(m, name), source = variant?.from ?? name, g = m.motions[source];
  if (!g) throw new Error(`no motion ${name}`);
  const stride = variant?.stride ?? 1, s = { ...STYLE, ...style };
  const frames = Math.max(8, Math.round((g.cycle / s.pace / (variant?.pace ?? 1)) * fps));
  const keys = (CYCLES.has(source) ? [...g.keys, ...g.keys.map((k) => ({ phase: k.phase + 0.5, pose: mirror(k.pose) }))] : [...g.keys]).sort((a, b) => a.phase - b.phase);
  const stand = Object.fromEntries(Object.entries(m.stand).map(([r, v]) => [r, exp(v.map((x) => x * RAD))]));
  const amountOf = (role) => (role === "hips" ? s.sway : TRUNK.has(role) ? s.lean : role.endsWith("UpperArm") ? stride * s.arms : role.endsWith("UpperLeg") ? stride : 1);
  const below = new Map();
  for (const side of ["left", "right"]) for (const [top, rest] of Object.entries(LIMBS)) for (const r of rest) below.set(`${side}${r}`, `${side}${top}`);
  const poses = Array.from({ length: frames }, (_, f) => at(keys, f / frames));
  const change = (role, f, amount = 1) => mul(exp((poses[f][role] ?? [0, 0, 0]).map((x) => x * RAD * amount)), stand[role] ?? [0, 0, 0, 1]);
  const rotations = {};
  for (const role of KEY_RULE.joints) {
    if (!stand[role]) continue;
    const out = new Float32Array(frames * 4), top = below.get(role), amount = amountOf(top ?? role);
    for (let f = 0; f < frames; f++) {
      let q = top && amount !== 1 ? mul(change(top, f, amount), mul(inv(change(top, f)), change(role, f))) : change(role, f, top ? 1 : amount);
      // The idle breathes: the chest rises and falls four times a loop, a degree and a half.
      if (source === "idle" && (role === "chest" || role === "upperChest")) q = mul(exp([Math.sin((2 * Math.PI * 4 * f) / frames) * 0.75 * RAD, 0, 0]), q);
      out.set(normalize(q), f * 4);
    }
    rotations[role] = out;
  }
  // The hips: their key offsets (bounce and sway scaled about the mean), sinking or rising with a
  // shorter stride so the lower ankle stays as high.
  const mean = [0, 1, 2].map((k) => poses.reduce((sum, p) => sum + p.hipsOffset[k], 0) / frames);
  // The rise and fall as the motion gives it (`bob`, metres): the spline through poses an eighth of
  // a cycle apart rounds a run's off.
  const ys = poses.map((p) => p.hipsOffset[1]), range = Math.max(...ys) - Math.min(...ys), rise = g.bob && range > 1e-4 ? g.bob / range : 1;
  const posed = (role, f) => [...rotations[role].slice(f * 4, f * 4 + 4)];
  const hips = new Float32Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    const p = poses[f].hipsOffset, sink = stride !== 1 ? lowestAnkle(m, (r) => change(r, f)) - lowestAnkle(m, (r) => posed(r, f)) : 0;
    hips.set([mean[0] + (p[0] - mean[0]) * s.sway, mean[1] + (p[1] - mean[1]) * rise * s.bounce + sink, mean[2] + (p[2] - mean[2]) * stride], f * 3);
  }
  return { name, source: "key poses", fps, frames, loop: true, rest: m.rest, stand, rotations, hips };
}

/** Every motion as clips (slowest first, the idle first), in one style. */
export function locomotionClips(model, body, options = {}) {
  return locomotionGaits(model, body).map(({ name }) => locomotionClip(model, body, name, options));
}

// ── Key poses: mirrored, and interpolated by a periodic Catmull-Rom spline of their vectors. ──
const mirrorRole = (r) => (r.startsWith("left") ? `right${r.slice(4)}` : r.startsWith("right") ? `left${r.slice(5)}` : r);
function mirror(pose) {
  const out = {};
  for (const [r, v] of Object.entries(pose)) out[r === "hipsOffset" || r === "root" ? r : mirrorRole(r)] = r === "hipsOffset" ? [-v[0], v[1], v[2]] : r === "root" ? [-v[0], v[1], -v[2]] : [v[0], -v[1], -v[2]];
  return out;
}
function at(keys, phase) {
  const n = keys.length, p = ((phase % 1) + 1) % 1, gap = (x, y) => (((y - x) % 1) + 1) % 1 || 1;
  let i = n - 1;
  for (let k = 0; k < n; k++) if (keys[k].phase <= p) i = k;
  const a = keys[(i - 1 + n) % n], b = keys[i], c = keys[(i + 1) % n], d = keys[(i + 2) % n];
  return hermite(a.pose, b.pose, c.pose, d.pose, gap(a.phase, b.phase), gap(b.phase, c.phase), gap(c.phase, d.phase), ((((p - b.phase) % 1) + 1) % 1) / gap(b.phase, c.phase));
}
/**
 * Between poses b and c of a Catmull-Rom spline through a, b, c, d whose keys are `ab`, `bc`, `cd`
 * apart (times or phases), at u (0 to 1): each key's slope the chord across its neighbours over
 * their time apart, so the motion's speed carries through a key however the keys are spaced.
 */
function hermite(a, b, c, d, ab, bc, cd, u) {
  const h00 = 2 * u ** 3 - 3 * u * u + 1, h10 = u ** 3 - 2 * u * u + u, h01 = -2 * u ** 3 + 3 * u * u, h11 = u ** 3 - u * u, out = {};
  for (const r of Object.keys(b)) {
    out[r] = [0, 1, 2].map((k) => {
      const p1 = b[r][k], p2 = c[r]?.[k] ?? p1, p0 = a[r]?.[k] ?? p1, p3 = d[r]?.[k] ?? p2;
      const m1 = ((p2 - p0) / (ab + bc)) * bc, m2 = ((p3 - p1) / (bc + cd)) * bc;
      return h00 * p1 + h10 * m1 + h01 * p2 + h11 * m2;
    });
  }
  return out;
}

// ── The legs on the motions' own skeleton. ──
function ankleOf(m, side, rotation) {
  let p = [0, 0, 0], prev = "hips";
  for (const r of ["UpperLeg", "LowerLeg", "Foot"].map((x) => side + x)) { p = add(p, rotate(rotation(prev), sub(m.rest[r], m.rest[prev]))); prev = r; }
  return p;
}
const lowestAnkle = (m, rotation) => Math.min(ankleOf(m, "left", rotation)[1], ankleOf(m, "right", rotation)[1]);

function mul([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
const inv = ([x, y, z, w]) => [-x, -y, -z, w];
function normalize(q) { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); }
/** A rotation from its axis times its angle. */
function exp(v) {
  const a = Math.hypot(v[0], v[1], v[2]);
  if (a < 1e-9) return [0, 0, 0, 1];
  const s = Math.sin(a / 2) / a;
  return [v[0] * s, v[1] * s, v[2] * s, Math.cos(a / 2)];
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function rotate([x, y, z, w], v) {
  const u = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]], t = [2 * u[0], 2 * u[1], 2 * u[2]];
  return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
}

// ── Transitions: starts, stops and turns, from key poses at times (clamped Catmull-Rom). ──

/** The transitions a model has, by name; each made for either side (`right` mirrors the left). */
export const TRANSITIONS = ["turn90", "turn180", "walkStart", "walkStop", "walkTurn180", "runStart", "runStop", "runTurn180"];

/**
 * A transition as a role clip (not looping) with its root motion: `motion` { duration, end (where
 * it has settled: half a second after most of its turn or travel), turn (radians, + to the left),
 * travel (metres), window ([from, to] seconds, where most of either happens) }. Mirrored for
 * `side: "right"` (its turn the other way).
 */
export function transitionClip(model, body, name, { side = "left", fps = 30 } = {}) {
  const m = bodyOf(model, body), g = m.motions[name];
  if (!g || !g.duration) throw new Error(`no transition ${name}`);
  const right = side === "right", keys = g.keys.map((k) => ({ time: k.time, pose: right ? mirror(k.pose) : k.pose }));
  const end = Math.min(g.duration, g.window[1] + 0.5), frames = Math.max(2, Math.round(end * fps));
  const stand = Object.fromEntries(Object.entries(m.stand).map(([r, v]) => [r, exp(v.map((x) => x * RAD))]));
  const rotations = Object.fromEntries(KEY_RULE.joints.filter((r) => stand[r]).map((r) => [r, new Float32Array(frames * 4)]));
  const hips = new Float32Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    const pose = atTime(keys, f / fps);
    for (const [r, out] of Object.entries(rotations)) out.set(normalize(mul(exp((pose[r] ?? [0, 0, 0]).map((x) => x * RAD)), stand[r])), f * 4);
    hips.set(pose.hipsOffset, f * 3);
  }
  const motion = { duration: g.duration, end, turn: (right ? -g.turn : g.turn) * RAD, travel: g.travel, window: g.window };
  return { name: `${name}${right ? "Right" : "Left"}`, source: "key poses", fps, frames, loop: false, rest: m.rest, stand, rotations, hips, motion };
}

/** How far through a transition's turn or travel it is at time t: eased over its window. */
export function transitionProgress(motion, t) {
  const [a, b] = motion.window, x = Math.min(1, Math.max(0, (t - a) / Math.max(1e-3, b - a)));
  return x * x * (3 - 2 * x);
}

function atTime(keys, t) {
  if (keys.length === 1) return keys[0].pose;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].time <= t) i++;
  const a = keys[Math.max(0, i - 1)], b = keys[i], c = keys[i + 1], d = keys[Math.min(keys.length - 1, i + 2)];
  const bc = c.time - b.time || 1, u = Math.max(0, Math.min(1, (t - b.time) / bc));
  // Clamped at the ends: the first and last keys' neighbours are themselves (at their own time apart).
  return hermite(a.pose, b.pose, c.pose, d.pose, a === b ? bc : b.time - a.time, bc, d === c ? bc : d.time - c.time, u);
}

// ── Actions: idle, scenarios and reactions, from key poses at times. ──

/** The actions a model has (looping ones first), by name. */
export function actionNames(model, body) {
  const a = bodyOf(model, body).actions ?? {};
  return Object.keys(a).sort((x, y) => (a[y].loop ? 1 : 0) - (a[x].loop ? 1 : 0));
}

/**
 * An action as a role clip: looping (`loop`, a periodic spline through its key poses, breathing as
 * the idle does) or once (a clamped spline, holding its last pose), with `motion` { duration, loop,
 * travel ([x, y, z] metres, in the body's frame at the start), turn (radians, + to the left) }. A
 * one-shot that moves (its keys' `root`) carries its body there and round in the clip, or with
 * `root: false` plays in place for its caller to move it. Mirrored for `side: "right"`.
 */
export function actionClip(model, body, name, { side = "left", fps = 30, root = true } = {}) {
  const m = bodyOf(model, body), g = m.actions?.[name];
  if (!g) throw new Error(`no action ${name}`);
  const right = side === "right", keys = g.keys.map((k) => ({ time: k.time, pose: right ? mirror(k.pose) : k.pose }));
  const frames = Math.max(2, Math.round(g.duration * fps) + (g.loop ? 0 : 1));
  const stand = Object.fromEntries(Object.entries(m.stand).map(([r, v]) => [r, exp(v.map((x) => x * RAD))]));
  const rotations = Object.fromEntries(KEY_RULE.joints.filter((r) => stand[r]).map((r) => [r, new Float32Array(frames * 4)]));
  const hips = new Float32Array(frames * 3);
  // A loop breathes: its chest rises and falls about every four seconds, a degree and a half.
  const breaths = Math.max(1, Math.round(g.duration / 4));
  for (let f = 0; f < frames; f++) {
    const t = f / fps, pose = g.loop ? at(keys.map((k) => ({ phase: k.time / g.duration, pose: k.pose })), t / g.duration) : atTime(keys, t);
    // The root: where the body has gone and how far round, carried (world rotations turn with it).
    const [rx, rz, yaw] = root && pose.root ? pose.root : [0, 0, 0], turn = exp([0, yaw * RAD, 0]);
    for (const [r, out] of Object.entries(rotations)) {
      let q = mul(exp((pose[r] ?? [0, 0, 0]).map((x) => x * RAD)), stand[r]);
      if (g.loop && (r === "chest" || r === "upperChest")) q = mul(exp([Math.sin((2 * Math.PI * breaths * f) / frames) * 0.75 * RAD, 0, 0]), q);
      out.set(normalize(yaw ? mul(turn, q) : q), f * 4);
    }
    hips.set(add(rotate(turn, pose.hipsOffset), [rx, 0, rz]), f * 3);
  }
  // The hands' shapes (ours, by action): a gesture's on the hand it raises, while it is up (its
  // wrist above halfway to its highest), or both hands' throughout.
  const hands = [], shape = HANDS[name];
  if (shape) {
    const wrist = (side, f) => handOf(m, side, (r) => [...(rotations[r] ?? new Float32Array(frames * 4).fill(0)).slice(f * 4, f * 4 + 4)].map((v, k) => (rotations[r] ? v : k === 3 ? 1 : 0)))[1] + hips[f * 3 + 1];
    for (const side of ["left", "right"]) {
      const ys = Array.from({ length: frames }, (_, f) => wrist(side, f)), low = ys[0], high = Math.max(...ys), raised = ys.map((y) => y > low + (high - low) / 2);
      const mine = shape.both || (high - low > 0.1 && high >= Math.max(...Array.from({ length: frames }, (_, f) => wrist(side === "left" ? "right" : "left", f))));
      if (!mine) continue;
      const from = shape.both ? 0 : raised.indexOf(true) / fps, to = shape.both ? frames / fps : (frames - 1 - [...raised].reverse().indexOf(true)) / fps;
      hands.push({ side: side[0], shape: shape.shape, from, to });
    }
  }
  const end = keys.at(-1).pose.root ?? [0, 0, 0];
  const motion = { duration: g.duration, loop: g.loop, travel: [end[0], 0, end[1]], turn: end[2] * RAD };
  return { name: right ? `${name}Right` : name, source: "key poses", fps, frames, loop: g.loop, rest: m.rest, stand, rotations, hips, motion, hands };
}

// Hand shapes by action (kit/character/three.js HAND_SHAPES): on the raised hand, or both.
const HANDS = {
  point: { shape: "point" }, wave: { shape: "open" }, comeHere: { shape: "open" }, shrug: { shape: "open", both: true },
  cheer: { shape: "fist", both: true }, startled: { shape: "open", both: true }, hit: { shape: "open", both: true }, knockedDown: { shape: "open", both: true },
};
function handOf(m, side, rotation) {
  let p = [0, 0, 0], prev = "hips";
  for (const r of ["spine", "chest", "upperChest", `${side}Shoulder`, `${side}UpperArm`, `${side}LowerArm`, `${side}Hand`]) { if (!m.rest[r]) continue; p = add(p, rotate(rotation(prev), sub(m.rest[r], m.rest[prev]))); prev = r; }
  return p;
}
