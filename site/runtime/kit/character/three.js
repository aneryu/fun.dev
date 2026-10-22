// Generated characters in three.js (docs/character-generator.md#in-a-game): the skinned mesh, clips
// as AnimationClips, and a walker that runs the gait with planted feet.
//
//   const character = generateCharacter({ seed: 7 });                 // THREE: the game's three.js
//   const object = characterObject(THREE, character);                 // a SkinnedMesh, standing at the origin
//   await applyTextures(THREE, object, character, DEFAULT_DATA, load); // load(url, colorSpace) → THREE.Texture
//   const mixer = new THREE.AnimationMixer(object);
//   mixer.clipAction(clipToThree(THREE, character, roleClip)).play(); // a clip by role (kit/character/clips) or by bone
//   const walker = createWalker(THREE, object, character, [idle, walk, jog, sprint]);   // role or bone clips
//   walker.update(dt, { speed: 1.5, turn: 0, look: 0 });              // each frame; moves the object forward

import { armClearance, clearArms } from "./clear.js";
import { bodyPoints, characterSoles, createFootLock, groundFeet, raiseBody, shiftBody } from "./feet.js";
import { createGait, sample } from "./gait.js";
import { transitionProgress } from "./locomotion.js";
import { clipTracks, retargetClip } from "./motion.js";
import { bankAngle, bankPose, lookPose, pitchPose } from "./steer.js";

// Default colours by island: the body's parts, the eyes, then garments by slot.
const COLOURS = { body: "#e9dcc4", joints: "#5c5133", head: "#e3b48f", upper: "#e3b48f", lower: "#e3b48f", feet: "#e3b48f", eyes: "#fff7d6" };
const SLOT_COLOURS = { top: "#064f67", bottom: "#211f17", shoes: "#9c3a12", hair: "#3b2a1a" };

/**
 * A THREE.SkinnedMesh for a generated character: one material (MeshStandardMaterial) per island,
 * named after it and coloured by `colours` (island → colour) or the defaults; garments by slot.
 * `data` is the character's data set, for its garments' slots.
 */
export function characterObject(THREE, character, { colours = {}, data = null } = {}) {
  const { mesh, skeleton } = character;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(mesh.joints, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(mesh.weights, 4));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  mesh.groups.forEach((g, i) => geometry.addGroup(g.start, g.count, i));
  geometry.computeBoundingSphere();

  const bones = skeleton.bones.map((b) => Object.assign(new THREE.Bone(), { name: b.id }));
  const world = skeleton.bones.map((b) => ({ p: new THREE.Vector3(...b.position), q: new THREE.Quaternion(...b.rotation) }));
  skeleton.bones.forEach((b, i) => {
    const bone = bones[i];
    if (b.parentIndex < 0) { bone.position.copy(world[i].p); bone.quaternion.copy(world[i].q); return; }
    const parent = world[b.parentIndex], inv = parent.q.clone().invert();
    bone.position.copy(world[i].p).sub(parent.p).applyQuaternion(inv);
    bone.quaternion.copy(inv).multiply(world[i].q);
    bones[b.parentIndex].add(bone);
  });
  const slotOf = (island) => data?.garments?.[character.semantic.body]?.[island]?.slot;
  const materials = mesh.groups.map((g) => {
    const slot = slotOf(g.island);
    return new THREE.MeshStandardMaterial({
      name: g.island, roughness: 0.85,
      color: colours[g.island] ?? COLOURS[g.island] ?? SLOT_COLOURS[slot] ?? "#e9dcc4",
      // Hair is cards, seen from both sides.
      side: slot === "hair" ? THREE.DoubleSide : THREE.FrontSide,
    });
  });
  const object = new THREE.SkinnedMesh(geometry, materials);
  object.name = `character ${character.seed}`;
  object.add(bones[0]);
  object.updateMatrixWorld(true);
  object.bind(new THREE.Skeleton(bones));
  object.userData.rest = bones.map((b) => b.quaternion.clone());
  object.userData.character = { seed: character.seed, data: character.data, semantic: character.semantic };
  return object;
}

/**
 * The textures of a character's islands from its data set (`data.textures`, `data.textureRoot`):
 * island → { diffuse, normal, alphaTest, tint } (URLs). The skin is its dominant face's when the set
 * has faces; a garment's colour picks its tint.
 */
export function characterTextures(character, data) {
  const root = data?.textureRoot;
  if (!root) return {};
  const t = data.textures ?? {}, { semantic } = character, body = semantic.body, url = (file) => (file ? new URL(file, root).href : null);
  const faces = data.faces?.[body], dominant = faces && (semantic.faceMix < 0.5 ? semantic.face : semantic.face2);
  const skin = faces?.skins?.[faces.faces.indexOf(dominant)] ?? t[`${body}/skin`];
  const out = {};
  for (const { island } of character.mesh.groups) {
    const garment = data.garments?.[body]?.[island];
    if (island === "skin") out.skin = { diffuse: url(skin), normal: url(t[`${body}/skin_normal`]) };
    else if (island === "eyes") out.eyes = { diffuse: url(t.eyes) };
    else if (garment) out[island] = { diffuse: url(garment.texture), normal: url(garment.normal), alphaTest: garment.alpha ? 0.5 : 0, tint: garment.tints?.[semantic[`${garment.slot}Colour`]] ?? null };
  }
  return out;
}

/**
 * Puts a character's textures on its object's materials: `load(url, colorSpace)` gives a
 * THREE.Texture (or its promise; with `flipY` off). Resolves when every texture is on.
 */
export function applyTextures(THREE, object, character, data, load) {
  const layers = characterTextures(character, data);
  return Promise.all(character.mesh.groups.map(async ({ island }, i) => {
    const layer = layers[island], m = object.material[i];
    if (!layer?.diffuse) return;
    m.color.set(layer.tint ?? "#ffffff");
    const [map, normal] = await Promise.all([load(layer.diffuse, THREE.SRGBColorSpace), layer.normal ? load(layer.normal, THREE.NoColorSpace) : null]);
    m.map = map; m.normalMap = normal; m.alphaTest = layer.alphaTest ?? 0;
    m.needsUpdate = true;
  }));
}

const soles = new WeakMap(), bodies = new WeakMap(), clearances = new WeakMap();
/** The lowest point of a frame's soles (feet and toes), metres above the ground. */
function soleHeight(skeleton, sole, tracks, f) {
  const { bones } = skeleton, world = [], pos = [];
  bones.forEach((b, i) => {
    const l = Array.from(tracks.rotations[b.id].subarray(f * 4, f * 4 + 4));
    if (b.parentIndex < 0) { world[i] = l; pos[i] = Array.from(tracks.hips.subarray(f * 3, f * 3 + 3)); return; }
    const p = bones[b.parentIndex];
    world[i] = qmul(world[b.parentIndex], l);
    pos[i] = vadd(pos[b.parentIndex], qrot(world[b.parentIndex], qrot(qinv(p.rotation), vsub(b.position, p.position))));
  });
  let low = Infinity;
  for (const [id, points] of Object.entries(sole)) {
    const i = bones.findIndex((b) => b.id === id);
    for (const o of points) low = Math.min(low, pos[i][1] + qrot(world[i], o)[1]);
  }
  return low;
}
const qmul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
const qinv = ([x, y, z, w]) => [-x, -y, -z, w];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function qrot([x, y, z, w], v) {
  const u = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]], t = [2 * u[0], 2 * u[1], 2 * u[2]];
  return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
}
const clearanceOf = (character) => { if (!clearances.has(character)) clearances.set(character, armClearance(character)); return clearances.get(character); };
const solesOf = (character) => { if (!soles.has(character)) soles.set(character, characterSoles(character)); return soles.get(character); };
const bodyOf = (character) => { if (!bodies.has(character)) bodies.set(character, bodyPoints(character)); return bodies.get(character); };

// Fingers for clips that leave them out: each bends about its own flexion axis (x) by its hand's
// shape, per finger (thumb, index, middle, ring, little) and joint, from the root. At rest a little,
// more toward the tip, the thumb less; a clip's `hands` ([{ side: "l" | "r", shape, from, to }],
// seconds) shapes a hand over a while, easing in and out over EASE_HAND.
const CURL = [0.2, 0.3, 0.25], THUMB = [0.05, 0.1, 0.1];
const RELAXED = [THUMB, CURL, CURL, CURL, CURL], FIST = [[0.4, 0.5, 0.5], ...Array(4).fill([1.4, 1.6, 1.1])];
export const HAND_SHAPES = {
  relaxed: RELAXED,
  open: [[0, 0.05, 0.05], ...Array(4).fill([0.05, 0.08, 0.05])],
  point: [[0.4, 0.5, 0.5], [0, 0.05, 0.05], ...Array(3).fill([1.4, 1.6, 1.1])],
  fist: FIST,
};
const EASE_HAND = 0.2;
function relaxFingers(skeleton, tracks, hands = []) {
  const n = tracks.times.length, step = tracks.duration / n;
  for (const b of skeleton.bones) {
    const m = b.id.match(/^([lr])_finger(\d)(\d)$/);
    if (!m) continue;
    const [, side, finger, joint] = m, q = tracks.rotations[b.id], own = hands.filter((h) => h.side === side);
    const bend = (shape) => (HAND_SHAPES[shape] ?? RELAXED)[Number(finger)]?.[Number(joint)] ?? 0;
    for (let f = 0; f < n; f++) {
      let a = bend("relaxed");
      for (const h of own) {
        const t = f * step, w = Math.min(1, Math.max(0, (t - h.from + EASE_HAND) / EASE_HAND), Math.max(0, (h.to + EASE_HAND - t) / EASE_HAND));
        if (w > 0) a += (bend(h.shape) - a) * w * w * (3 - 2 * w);
      }
      const turn = [Math.sin(a / 2), 0, 0, Math.cos(a / 2)], [x, y, z, w] = q.subarray(f * 4, f * 4 + 4);
      q.set([w * turn[0] + x * turn[3], y * turn[3] + z * turn[0], z * turn[3] - y * turn[0], w * turn[3] - x * turn[0]], f * 4);
    }
  }
}

/**
 * Tracks for a clip on this character: a role clip (with `rest`) is retargeted first; then each
 * frame the body is kept above the ground (raiseBody: lying down), the feet on it (groundFeet) and
 * the hands out of the thighs and hips (clearArms).
 */
export function characterTracks(character, clip) {
  const tracks = clipTracks(character.skeleton, clip.rest ? retargetClip(clip, character.skeleton, character.rig) : clip);
  if (clip.rest && !Object.keys(clip.rotations).some((r) => /Proximal|Intermediate|Distal|Metacarpal/.test(r))) relaxFingers(character.skeleton, tracks, clip.hands);
  const sole = solesOf(character), memory = {}, n = tracks.times.length, step = tracks.duration / n, ids = ["l_thigh", "l_calf", "l_foot", "l_thigh_roll", "r_thigh", "r_calf", "r_foot", "r_thigh_roll", "l_toe", "r_toe", "l_upperarm", "l_upperarm_roll", "r_upperarm", "r_upperarm_roll"];
  // A loop is gone through twice, so the toes' letting go carries across its seam; its second
  // time is kept.
  const raw = { rotations: Object.fromEntries(Object.entries(tracks.rotations).map(([id, q]) => [id, Float32Array.from(q)])), hips: Float32Array.from(tracks.hips) };
  // First the whole clip up by how far its soles go under at their lowest (the 10th percentile of
  // each frame's lowest), so a stance foot lands on the ground rather than through it, and the
  // feet's lift each frame (groundFeet) is left a few millimetres to mend.
  const under = Array.from({ length: n }, (_, f) => soleHeight(character.skeleton, sole, raw, f)).sort((a, b) => a - b)[Math.floor(n * 0.1)];
  if (under < 0) for (let f = 0; f < n; f++) raw.hips[f * 3 + 1] -= under;
  // Fitted to its surroundings (`fit`, an offset of the body from its feet: a seat's height, a
  // wall's distance; actionFit), the body moves and the feet stay: by as much as it is down, in a
  // clip that sits down or gets up (sitting), else throughout.
  const down = sitting(character, raw, n);
  if (clip.fit) for (let f = 0; f < n; f++) {
    const pose = { rotations: Object.fromEntries(Object.entries(raw.rotations).map(([id, q]) => [id, Array.from(q.subarray(f * 4, f * 4 + 4))])), hips: Array.from(raw.hips.subarray(f * 3, f * 3 + 3)) };
    shiftBody(character.skeleton, pose, clip.fit.map((v) => v * down[f]), { plant: clip.fit[1] !== 0 });
    for (const [id, q] of Object.entries(pose.rotations)) raw.rotations[id].set(q, f * 4);
    raw.hips.set(pose.hips, f * 3);
  }
  for (let k = clip.loop === false ? n : 0; k < 2 * n; k++) {
    const f = k % n;
    const pose = { rotations: Object.fromEntries(Object.entries(raw.rotations).map(([id, q]) => [id, Array.from(q.subarray(f * 4, f * 4 + 4))])), hips: Array.from(raw.hips.subarray(f * 3, f * 3 + 3)) };
    raiseBody(character.skeleton, bodyOf(character), pose);
    groundFeet(character.skeleton, sole, pose, { memory, dt: step });
    if (k < n) continue;
    clearArms(character.skeleton, clearanceOf(character), pose);
    for (const id of ids) tracks.rotations[id]?.set(pose.rotations[id], f * 4);
    tracks.hips.set(pose.hips, f * 3);
  }
  return tracks;
}

/** How far down a clip's body is at each frame, 0 (standing) to 1 (its lowest), if it goes 15 cm or more below standing; else 1 throughout. */
function sitting(character, raw, n) {
  const stand = character.skeleton.bones[0].position[1], ys = Array.from({ length: n }, (_, f) => raw.hips[f * 3 + 1]), low = Math.min(...ys);
  if (stand - low < 0.15) return ys.map(() => 1);
  return ys.map((y) => { const x = Math.min(1, Math.max(0, (stand - 0.05 - y) / (stand - 0.05 - low - 0.03))); return x * x * (3 - 2 * x); });
}

/**
 * Where an action rests on its surroundings, on this character (metres, in its frame): `seat`, the
 * height of the lowest point of its hips and thighs (what it sits on), and `back`, how far behind
 * its heels its back goes (what it leans on), at their mean over the clip (with `under`, how far
 * forward the seat's point is, and `heel`, the heels'); and the clip fitted
 * instead to a seat or a wall elsewhere (`{ seat, back }`: the body moves, the feet stay).
 */
export function actionFit(character, clip, { seat = null, back = null } = {}) {
  const tracks = characterTracks(character, clip), { bones } = character.skeleton, n = tracks.times.length;
  const points = bodyOf(character), hipsOf = points.filter((p) => /pelvis|thigh_roll/.test(bones[p.bone].id)), trunk = points.filter((p) => /pelvis|spine|neck|head|clavicle/.test(bones[p.bone].id));
  const ids = ["l_foot", "r_foot"], at = { seat: 0, back: 0, under: 0, heel: 0 }, down = sitting(character, tracks, n);
  // (Measured where it is down: all of a loop's, a sitting down's end.)
  const frames = Array.from({ length: n }, (_, f) => f).filter((f) => down[f] > 0.95), count = frames.length || 1;
  for (const f of frames.length ? frames : [n - 1]) {
    const world = [], pos = [];
    bones.forEach((b, i) => {
      const local = Array.from(tracks.rotations[b.id]?.subarray(f * 4, f * 4 + 4) ?? [0, 0, 0, 1]);
      if (b.parentIndex < 0) { world[i] = local; pos[i] = Array.from(tracks.hips.subarray(f * 3, f * 3 + 3)); return; }
      const parent = bones[b.parentIndex];
      world[i] = qmul(world[b.parentIndex], local);
      pos[i] = vadd(pos[b.parentIndex], qrot(world[b.parentIndex], qrot([-parent.rotation[0], -parent.rotation[1], -parent.rotation[2], parent.rotation[3]], vsub(b.position, parent.position))));
    });
    const point = (p) => vadd(pos[p.bone], qrot(world[p.bone], p.at)), heel = Math.min(...ids.map((id) => pos[bones.findIndex((b) => b.id === id)][2]));
    const low = hipsOf.map(point).reduce((a, b) => (b[1] < a[1] ? b : a));
    at.seat += low[1] / count; at.under += low[2] / count; at.heel += heel / count;
    at.back += (heel - Math.min(...trunk.map((p) => point(p)[2]))) / count;
  }
  const was = clip.fit ?? [0, 0, 0], fit = [0, was[1] + (seat == null ? 0 : seat - at.seat), was[2] + (back == null ? 0 : at.back - back)];
  return { ...at, clip: fit[1] || fit[2] ? { ...clip, fit } : clip };
}

/** A THREE.AnimationClip for a clip on this character (bones by id; the hips move). */
export function clipToThree(THREE, character, clip) {
  const t = characterTracks(character, clip);
  const tracks = Object.entries(t.rotations).map(([id, q]) => new THREE.QuaternionKeyframeTrack(`${id}.quaternion`, t.times, q));
  tracks.push(new THREE.VectorKeyframeTrack(`${character.skeleton.bones[0].id}.position`, t.times, t.hips));
  const out = new THREE.AnimationClip(clip.name, t.duration, tracks);
  out.userData = { loop: t.loop };
  return out;
}

/**
 * A walker: the gait over locomotion clips (role or bone clips, any order, an idle among them)
 * with planted feet. `update(dt, { speed, turn, look, facing })` poses the object's bones and moves
 * the object forward (its +z) while turning at `turn` rad/s (+ to its left). The walker's own speed
 * eases toward `speed` m/s (`accel`, `decel` in m/s²; stopping at `stop`, quickly, from a run
 * braking at `brake`, the gait ending its stride under `settle` m/s and giving way to the idle over
 * 0.3 s), so it starts and stops rather than jumping;
 * it leans into turns as the speed and turn ask (`bank`), and its head and chest look into the turn,
 * or `look` radians aside, easing there. It leans forward as it speeds up and back as it slows
 * (`pitch` radians per m/s², eased). Given `facing` (a heading, radians, as the object's
 * rotation.y), it steers toward it instead of `turn`; standing, it turns toward one aside at up to
 * `spin` rad/s in a few long steps, about where its feet stand (createFootLock).
 * With `transitions` (clips from transitionClip, both sides), it plays those
 * instead where they belong: a start from standing, a stop from walking or running, a turn on the
 * spot toward a facing 45° or more aside (90 or 180), and a turn about while moving toward one
 * behind it. `feet: false` lets the feet slide.
 */
export function createWalker(THREE, object, character, clips, { feet = true, ground = true, clear = true, accel = 2.5, decel = 4, stop = 10, brake = 3.5, settle = 1, bank = true, pitch = 0.05, spin = 3.5, transitions = [] } = {}) {
  const { skeleton, rig } = character;
  const gait = createGait(skeleton, clips.map((clip) => characterTracks(character, clip)));
  const lock = createFootLock(skeleton);
  const byName = new Map(object.skeleton.bones.map((b) => [b.name, b]));
  const forward = new THREE.Vector3();
  const ease = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));
  const state = { speed: 0, lean: 0, look: 0, pitch: 0, playing: null };
  let spinning = 0, about = null, round = 0;   // where it turns about, standing, and which way (+ left)
  const toes = {};   // the toes' bends, let go of over time
  const moves = transitions.map((clip) => {
    const kind = clip.name.replace(/(Left|Right)$/, "");
    return { clip, tracks: characterTracks(character, clip), kind, turn: clip.motion.turn, overlay: /Start$|Stop$/.test(kind) };
  });
  // The bones above the hips: the spine and all it carries.
  const upper = new Set(), spine = skeleton.bones.findIndex((b) => b.id === rig.roles.spine);
  skeleton.bones.forEach((b, i) => { for (let j = i; j >= 0; j = skeleton.bones[j].parentIndex) if (j === spine) { upper.add(b.id); break; } });
  const pick = (kind, sign = 0) => moves.filter((m) => m.kind === kind).sort((a, b) => (sign ? Math.sign(b.turn) * sign - Math.sign(a.turn) * sign : 0))[0] ?? null;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const walkSpeed = gait.clips.find((c) => c.name === "walk")?.speed ?? 1.4, runFrom = 2.5;
  let playing = null;   // { move, t, from (pose), done }
  const blendPose = (p, q, w) => {
    const rotations = {};
    for (const id of Object.keys(p.rotations)) {
      const a = p.rotations[id], b = q.rotations[id] ?? a, s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
      const v = a.map((x, k) => x + (s * b[k] - x) * w), l = Math.hypot(...v) || 1;
      rotations[id] = v.map((x) => x / l);
    }
    return { rotations, hips: p.hips.map((v, k) => v + (q.hips[k] - v) * w) };
  };
  return {
    gait,
    /** The walker's own speed (m/s), lean and look (radians) now, and the transition it plays. */
    get state() { return { ...state, playing: playing?.move.clip.name ?? null }; },
    update(dt, { speed = 0, turn = 0, look = null, facing = null } = {}) {
      const aside = facing == null ? 0 : wrap(facing - object.rotation.y);
      // A transition where one belongs.
      if (!playing && moves.length) {
        let move = null;
        if (state.speed < 0.05) {
          if (Math.abs(aside) > 2.4) move = pick("turn180", Math.sign(aside));
          else if (Math.abs(aside) > 0.8) move = pick("turn90", Math.sign(aside));
          else if (speed >= 0.3) move = pick(speed > runFrom ? "runStart" : "walkStart");
        } else if (state.speed > 0.5) {
          if (speed < 0.05) move = pick(state.speed > runFrom ? "runStop" : "walkStop");
          else if (Math.abs(aside) > 2.4) move = pick(state.speed > runFrom ? "runTurn180" : "walkTurn180", Math.sign(aside));
        }
        if (move) playing = { move, t: 0, progress: 0, from: gait.update(0, state.speed), done: false };
      }
      let pose, turned = 0;
      if (playing) {
        const { move } = playing, m = move.clip.motion;
        playing.t += dt;
        const t = Math.min(playing.t, m.end - 1e-3), progress = transitionProgress(m, t);
        turned = m.turn * (progress - playing.progress);
        playing.progress = progress;
        // Its speed: up to the asked one on a start, down to none on a stop or a turn on the spot,
        // the transition's own while it turns about.
        const want = move.kind.endsWith("Start") ? speed : move.kind.endsWith("Stop") || move.kind.startsWith("turn") ? 0 : t >= m.window[0] && t <= m.window[1] ? m.travel / Math.max(0.2, m.end) : speed;
        // A start or stop is over once the speed is there (its key poses ease out with the rest of it).
        if (move.overlay && Math.abs(want - state.speed) < 0.05 && playing.t < m.end - 0.3) playing.t = m.end - 0.3;
        const step = (want > state.speed ? accel : decel) * dt;
        state.speed = Math.abs(want - state.speed) <= step ? want : state.speed + Math.sign(want - state.speed) * step;
        const after = gait.update(dt, move.kind.startsWith("turn") ? 0 : state.speed);
        const rest = m.end - playing.t, into = Math.min(1, playing.t / 0.2), out = rest < 0.3 ? 1 - Math.max(0, rest) / 0.3 : 0;
        let own = sample(move.tracks, t);
        // A start or a stop: the gait (at the speed it is reaching) steps, the transition carries
        // the body above the hips (the lean into a start, the settling of a stop); five key poses
        // could not keep a start's or a stop's several steps.
        if (move.overlay) own = { rotations: { ...after.rotations, ...Object.fromEntries(Object.entries(own.rotations).filter(([id]) => upper.has(id))) }, hips: after.hips };
        pose = blendPose(blendPose(move.overlay ? after : playing.from, own, smooth(into)), after, smooth(out));
        if (playing.t >= m.end) playing = null;
      } else {
        // Stopping is quick (`stop`, m/s²): a body stops within a step; slowing otherwise eases.
        // A run brakes over a stride or two (its stride and cadence falling through jog and walk:
        // stopping it as quickly as a walk would leave its legs stepping short at a run's rate).
        const halt = speed < 0.05, before = state.speed, step = (speed > state.speed ? accel : halt ? (state.speed > 1.6 ? brake : stop) : decel) * dt;
        state.speed = Math.abs(speed - state.speed) <= step ? speed : state.speed + Math.sign(speed - state.speed) * step;
        // Toward a facing: steering while moving; standing, turning on the spot at up to `spin`,
        // easing in and out (the planted feet step round as the body turns over them; see feet.js).
        const onSpot = facing != null && state.speed < 0.3;
        spinning = ease(spinning, onSpot && Math.abs(aside) > 0.02 ? 1 : 0, 6, dt);
        turn = facing == null ? turn : Math.max(-spin, Math.min(spin, aside * (onSpot ? 6 : 3))) * (onSpot ? spinning : 1);
        pose = gait.update(dt, state.speed, { stop: halt && state.speed < settle });
        // Ending its step, the body goes as the gait's last step does.
        if (pose.travel != null) state.speed = pose.travel;
        turned = turn * dt;
        // Leaning with the change of speed.
        state.pitch = ease(state.pitch, Math.max(-0.15, Math.min(0.2, ((state.speed - before) / Math.max(dt, 1e-6)) * pitch)), 5, dt);
      }
      const v = state.speed;
      state.lean = ease(state.lean, bank && !playing ? bankAngle(v, turn) : 0, 6, dt);
      state.look = ease(state.look, look ?? Math.max(-0.6, Math.min(0.6, (playing ? 0 : turn) * 0.35)), 4, dt);
      bankPose(skeleton, pose, state.lean);
      lookPose(skeleton, rig, pose, state.look);
      pitchPose(skeleton, rig, pose, state.pitch);
      // Planted feet hold fully up to a brisk walk and let go by a run (a run's short stance would
      // jolt its knees in and out of the lock, and slides little at its pace).
      // Standing, it turns about where its feet stand (not its origin, ahead of the ankles: a foot
      // going round would come down by the other).
      const standing = v < 0.05 && !playing;
      // (Set as each turn begins, toward the foot on the side it turns to.)
      const side = facing != null && Math.abs(aside) > 0.05 ? Math.sign(aside) : 0;
      if (!feet || !standing) { about = null; round = 0; }
      else if (side && side !== round) { about = lock.stance(pose, side); round = side; }
      else if (!side && Math.abs(aside) < 0.01) round = 0;
      about ??= feet && standing ? lock.stance(pose) : null;
      if (feet) lock.apply(pose, { forward: v * dt, turn: turned, dt, strength: Math.min(1, Math.max(0, (3.5 - v) / 1.5)), step: standing, ahead: facing != null && !playing ? aside - turned : null, about });
      if (ground) groundFeet(skeleton, solesOf(character), pose, { memory: toes, dt });
      if (clear) clearArms(skeleton, clearanceOf(character), pose);
      for (const [id, q] of Object.entries(pose.rotations)) byName.get(id)?.quaternion.set(q[0], q[1], q[2], q[3]);
      object.skeleton.bones[0].position.set(...pose.hips);
      if (about && turned) {
        // The origin goes round the stance: by p - R(turned) p in the character's frame.
        const [x, z] = about, c = Math.cos(turned), s = Math.sin(turned), dx = x - (x * c + z * s), dz = z - (-x * s + z * c), y = object.rotation.y;
        object.position.x += dx * Math.cos(y) + dz * Math.sin(y); object.position.z += -dx * Math.sin(y) + dz * Math.cos(y);
      }
      object.rotation.y += turned;
      object.position.add(forward.set(Math.sin(object.rotation.y), 0, Math.cos(object.rotation.y)).multiplyScalar(v * dt));
      return pose;
    },
  };
}
const smooth = (x) => x * x * (3 - 2 * x);
