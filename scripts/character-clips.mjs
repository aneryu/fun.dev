// Role clips for generated characters from the Quaternius Universal Animation Library (CC0,
// sources/quaternius/ual): each clip sampled at 30 fps as world rotation changes from the rest
// pose by humanoid role, with the rest positions of the roles, the hips' offsets and the source's
// standing pose (its idle's mean change by role; docs/character-generator.md#animation). Its idle,
// walk, jog and sprint are no longer baked: the kit makes those from key poses. The formal walk
// bends the knees more than people do; its knee flexion is remapped to a natural walk's.
// `retargetClip` in kit/character/motion.js plays them on any generated character.
//
//   node scripts/character-clips.mjs        → site/runtime/kit/character/clips/<id>.json, index.json
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

import { twoBoneIK } from "../site/runtime/kit/character.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "sources/quaternius/ual/UAL1_Standard.fbx");
const OUT = join(ROOT, "site/runtime/kit/character/clips");
const FPS = 30;

// The source's clips: our id → its name (looping clips loop).
const CLIPS = {
  walk_formal: "Walk_Formal_Loop",
  talk: "Idle_Talking_Loop", dance: "Dance_Loop", crouch_idle: "Crouch_Idle_Loop", jump: "Jump_Loop",
  punch: "Punch_Jab", interact: "Interact",
};

// A natural walk, as the gait literature gives it (typical values, e.g. Perry & Burnfield, Gait
// Analysis: Normal and Pathological Function), and what the source's formal walk is changed by to
// meet it (see `natural`; the idle, walk, jog and sprint are kit/character/locomotion.js's now):
// - The source walks at 72 steps a minute (a slow motion) with the knees bent 25-35° through
//   stance and 88° in swing. Adults walk at 100-120 steps (115 here); the knee comes in near
//   straight, bends about 20° taking the weight, straightens to about 5° and bends about 40° before
//   swing, 60° in it: `knee` is that curve's 2nd, 25th, 50th, 75th and 98th percentiles. The hips
//   rise so that the lower ankle stays where it was. The formal walk keeps its held arms.
// - The hips' sway, `sway`: their roll and turn about their mean (ranges, degrees), made from the
//   legs, as the source's hips barely sway and turn the wrong way: the hips drop on the side of the
//   swinging leg and turn with the leg ahead, about ±4.5° each. (`natural` also takes `swing`,
//   `bob`, `lean`, `shoulders`, `arms` and `elbow`, and a "legs" ground, for faster gaits.)
const WALK = { steps: 115, knee: [3, 8, 18, 40, 62], sway: [9, 9], ground: "hips" };
const NATURAL = { walk_formal: WALK };
const KNEE_QUANTILES = [0.02, 0.25, 0.5, 0.75, 0.98];

// The source's bones (Unreal mannequin names) → humanoid roles.
const ROLES = { pelvis: "hips", spine_01: "spine", spine_02: "chest", spine_03: "upperChest", neck_01: "neck", Head: "head" };
for (const [s, side] of [["l", "left"], ["r", "right"]]) {
  Object.assign(ROLES, {
    [`clavicle_${s}`]: `${side}Shoulder`, [`upperarm_${s}`]: `${side}UpperArm`, [`lowerarm_${s}`]: `${side}LowerArm`, [`hand_${s}`]: `${side}Hand`,
    [`thigh_${s}`]: `${side}UpperLeg`, [`calf_${s}`]: `${side}LowerLeg`, [`foot_${s}`]: `${side}Foot`, [`ball_${s}`]: `${side}Toes`,
    [`thumb_01_${s}`]: `${side}ThumbMetacarpal`, [`thumb_02_${s}`]: `${side}ThumbProximal`, [`thumb_03_${s}`]: `${side}ThumbDistal`,
  });
  for (const [f, finger] of [["index", "Index"], ["middle", "Middle"], ["ring", "Ring"], ["pinky", "Little"]]) {
    Object.assign(ROLES, { [`${f}_01_${s}`]: `${side}${finger}Proximal`, [`${f}_02_${s}`]: `${side}${finger}Intermediate`, [`${f}_03_${s}`]: `${side}${finger}Distal` });
  }
}

const bytes = readFileSync(SOURCE);
const scene = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
const bones = [];
scene.traverse((o) => { if (o.isBone && ROLES[o.name]) bones.push(o); });
// Each role with the roles below it.
const BELOW = Object.fromEntries(bones.map((b) => [ROLES[b.name], []]));
for (const b of bones) for (let p = b.parent; p; p = p.parent) if (p.isBone && ROLES[p.name]) BELOW[ROLES[p.name]].push(ROLES[b.name]);
scene.updateMatrixWorld(true);
const pose = () => bones.map((b) => ({ q: b.getWorldQuaternion(new THREE.Quaternion()), p: b.getWorldPosition(new THREE.Vector3()) }));
const rest = pose();
const round = (x) => Math.round(x * 1e4) / 1e4;

mkdirSync(OUT, { recursive: true });
const mixer = new THREE.AnimationMixer(scene);
const hipsIndex = bones.findIndex((b) => ROLES[b.name] === "hips");

/**
 * A source clip sampled: each role's world rotation changes and the hips' offsets, by frame; with
 * `steps`, played at that many steps per minute.
 */
function sampled(name, steps) {
  const clip = scene.animations.find((a) => a.name.replace(/^Armature\|/, "") === name);
  if (!clip) throw new Error(`no clip ${name}`);
  mixer.stopAllAction();
  const action = mixer.clipAction(clip).play();
  const rate = steps ? (steps * clip.duration) / 120 : 1;
  const frames = Math.max(1, Math.round((clip.duration * FPS) / rate));
  const rotations = Object.fromEntries(bones.map((b) => [ROLES[b.name], []])), hips = [];
  for (let f = 0; f < frames; f++) {
    action.time = steps ? (f * clip.duration) / frames : f / FPS;
    mixer.update(0);
    scene.updateMatrixWorld(true);
    pose().forEach(({ q, p }, i) => {
      const d = q.clone().multiply(rest[i].q.clone().invert());
      rotations[ROLES[bones[i].name]].push(...[d.x, d.y, d.z, d.w].map(round));
      if (i === hipsIndex) hips.push(...p.clone().sub(rest[i].p).toArray().map(round));
    });
  }
  return { frames, rotations, hips };
}

// The source's standing pose: its rest is a stiff T-pose, so each clip carries the change its
// idle makes on average (the spine's curve, the shoulders' set) for retargetClip to start from;
// the trunk's and shoulders' without the trunk's turn about the vertical (the idle stands a little turned).
const TRUNK = new Set(["hips", "spine", "chest", "upperChest", "neck", "head"]);
const idle = sampled("Idle_Loop");
const means = Object.fromEntries(Object.entries(idle.rotations).map(([role, q]) => {
  const sum = [0, 0, 0, 0];
  for (let f = 0; f < idle.frames; f++) {
    const s = q[f * 4 + 3] < 0 ? -1 : 1;
    for (let k = 0; k < 4; k++) sum[k] += q[f * 4 + k] * s;
  }
  return [role, new THREE.Quaternion(...sum).normalize()];
}));
const turn = (q) => new THREE.Quaternion(0, q.y, 0, q.w).normalize().invert();
const stand = Object.fromEntries(Object.entries(means).map(([role, mean]) => {
  const q = mean.clone();
  if (TRUNK.has(role)) q.multiply(turn(mean));
  else if (role.endsWith("Shoulder")) q.multiply(turn(means.upperChest));
  return [role, [q.x, q.y, q.z, q.w].map(round)];
}));

const restPositions = Object.fromEntries(bones.map((b, i) => [ROLES[b.name], rest[i].p.toArray().map(round)]));
const restOf = (role) => new THREE.Vector3(...restPositions[role]);

const SIDES = ["left", "right"];
const meanOf = (q, frames) => {
  const sum = [0, 0, 0, 0];
  for (let f = 0; f < frames; f++) { const s = q[f * 4 + 3] < 0 ? -1 : 1; for (let k = 0; k < 4; k++) sum[k] += q[f * 4 + k] * s; }
  return new THREE.Quaternion(...sum).normalize();
};

/**
 * A sampled clip changed toward a natural gait (`NATURAL`): the hips' and thighs' swings narrowed
 * about their mean (`swing`; shins and feet keep their bend, the arms their swing), the hips' rise
 * and fall scaled (`bob`), the trunk's and shoulders' change from standing scaled (`lean`), the
 * arms' swing and elbows' bend scaled to measures (`arms`, `elbow`), the hips' sway made from the
 * legs (`sway`), the
 * knee flexion remapped to percentiles (`knee`: each frame's angle through the piecewise-linear map
 * from the clip's own), knees bending about their hinge and the feet keeping their world rotation.
 * Then the ground (`ground`): "hips" moves the hips so that the lower ankle is where it was; "legs"
 * puts each foot down in the source back on its (narrowed) path by two-bone IK.
 */
function natural(sample, { swing = 1, bob = 1, lean = 1, shoulders = 1, knee = null, arms = null, elbow = null, sway = null, ground }) {
  const { frames, rotations, hips } = sample;
  const quat = (role, f) => new THREE.Quaternion().fromArray(rotations[role], f * 4);
  const set = (role, f, q) => q.normalize().toArray(rotations[role], f * 4);
  const dir = (role, child, f) => restOf(child).sub(restOf(role)).applyQuaternion(quat(role, f));
  const hip = (side, f) => restOf("hips").add(new THREE.Vector3().fromArray(hips, f * 3)).add(dir("hips", `${side}UpperLeg`, f));
  const ankle = (side, f) => hip(side, f).add(dir(`${side}UpperLeg`, `${side}LowerLeg`, f)).add(dir(`${side}LowerLeg`, `${side}Foot`, f));
  const kneeAngle = (side, f) => (dir(`${side}UpperLeg`, `${side}LowerLeg`, f).angleTo(dir(`${side}LowerLeg`, `${side}Foot`, f)) * 180) / Math.PI;
  const bend = (side, f, degrees) => {
    const thigh = dir(`${side}UpperLeg`, `${side}LowerLeg`, f), shin = dir(`${side}LowerLeg`, `${side}Foot`, f);
    // The hinge: across thigh and shin, or the thigh's own sideways axis when the leg is straight.
    const axis = new THREE.Vector3().crossVectors(thigh, shin);
    if (axis.length() < 1e-3 * thigh.length() * shin.length()) axis.set(1, 0, 0).applyQuaternion(quat(`${side}UpperLeg`, f));
    set(`${side}LowerLeg`, f, new THREE.Quaternion().setFromAxisAngle(axis.normalize(), (degrees * Math.PI) / 180).multiply(quat(`${side}LowerLeg`, f)));
  };
  const ankles = SIDES.map((side) => Array.from({ length: frames }, (_, f) => ankle(side, f)));
  const heights = ankles.map((a) => a.map((p) => p.y)), floor = Math.min(...heights.flat());
  // Where each foot goes while down: its source path, narrowed about its mean as the swings are.
  const paths = ankles.map((a) => {
    const mean = a.reduce((m, p) => m.add(p), new THREE.Vector3()).divideScalar(frames);
    return a.map((p) => new THREE.Vector3(mean.x + (p.x - mean.x) * swing, p.y, mean.z + (p.z - mean.z) * swing));
  });

  const means = Object.fromEntries(Object.entries(rotations).map(([role, q]) => [role, meanOf(q, frames)]));
  if (swing !== 1) {
    // The hips and thighs swing less; shins, feet and toes keep their bend from the thigh.
    for (let f = 0; f < frames; f++) {
      for (const side of SIDES) {
        const chain = ["UpperLeg", "LowerLeg", "Foot", "Toes"].map((r) => `${side}${r}`);
        const bends = chain.slice(1).map((r, k) => quat(chain[k], f).invert().multiply(quat(r, f)));
        set(chain[0], f, means[chain[0]].clone().slerp(quat(chain[0], f), swing));
        chain.slice(1).forEach((r, k) => set(r, f, quat(chain[k], f).multiply(bends[k])));
      }
      set("hips", f, means.hips.clone().slerp(quat("hips", f), swing));
    }
  }
  for (const [k, scale] of [[0, swing], [1, bob], [2, swing]]) {
    if (scale === 1) continue;
    let mean = 0;
    for (let f = 0; f < frames; f++) mean += hips[f * 3 + k] / frames;
    for (let f = 0; f < frames; f++) hips[f * 3 + k] = mean + (hips[f * 3 + k] - mean) * scale;
  }
  if (lean !== 1) {
    for (const role of [...TRUNK, "leftShoulder", "rightShoulder"]) {
      const s = new THREE.Quaternion(...stand[role]), none = new THREE.Quaternion(), k = role.endsWith("Shoulder") ? lean * shoulders : lean;
      for (let f = 0; f < frames; f++) set(role, f, none.clone().slerp(quat(role, f).multiply(s.clone().invert()), k).multiply(s));
    }
  }
  // A world turn of a role and the roles below it.
  const turnAll = (role, f, by) => { for (const r of [role, ...BELOW[role]]) set(r, f, by.clone().multiply(quat(r, f))); };
  const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const range = (xs) => { const sorted = [...xs].sort((a, b) => a - b), at = (p) => sorted[Math.round(p * (sorted.length - 1))]; return at(0.98) - at(0.02); };
  const all = (fn) => Array.from({ length: frames }, (_, f) => fn(f));
  if (arms) {
    const forward = (side, f) => { const d = dir(`${side}UpperArm`, `${side}LowerArm`, f); return (Math.atan2(d.z, -d.y) * 180) / Math.PI; };
    // A few rounds: the swing measured grows less than the turn scaled.
    for (let round = 0; round < 4; round++) {
      const k = arms / ((range(all((f) => forward("left", f))) + range(all((f) => forward("right", f)))) / 2);
      if (Math.abs(k - 1) < 0.01) break;
      for (const side of SIDES) {
        const role = `${side}UpperArm`, mean = meanOf(rotations[role], frames);
        for (let f = 0; f < frames; f++) turnAll(role, f, mean.clone().slerp(quat(role, f), k).multiply(quat(role, f).invert()));
      }
    }
  }
  if (elbow) {
    const bendOf = (side, f) => (dir(`${side}UpperArm`, `${side}LowerArm`, f).angleTo(dir(`${side}LowerArm`, `${side}Hand`, f)) * 180) / Math.PI;
    const k = elbow / median(SIDES.flatMap((side) => all((f) => bendOf(side, f))));
    for (let f = 0; f < frames; f++) for (const side of SIDES) {
      const upper = dir(`${side}UpperArm`, `${side}LowerArm`, f), fore = dir(`${side}LowerArm`, `${side}Hand`, f);
      const axis = new THREE.Vector3().crossVectors(upper, fore);
      if (axis.length() < 1e-6) continue;
      const a = bendOf(side, f);
      turnAll(`${side}LowerArm`, f, new THREE.Quaternion().setFromAxisAngle(axis.normalize(), ((Math.min(150, a * k) - a) * Math.PI) / 180));
    }
  }
  if (sway) {
    const inverse = meanOf(rotations.hips, frames).invert(), about = (f) => quat("hips", f).multiply(inverse);
    const roll = (f) => { const x = new THREE.Vector3(1, 0, 0).applyQuaternion(about(f)); return Math.atan2(x.y, x.x); };
    const yaw = (f) => { const z = new THREE.Vector3(0, 0, 1).applyQuaternion(about(f)); return Math.atan2(z.x, z.z); };
    const ahead = (side, f) => { const d = dir(`${side}UpperLeg`, `${side}LowerLeg`, f); return Math.atan2(d.z, -d.y); };
    // A signal about its mean, its range one.
    const unit = (xs) => { const mean = xs.reduce((a, b) => a + b) / xs.length, r = range(xs) || 1; return xs.map((x) => (x - mean) / r); };
    // The left side is at +x: rolled up as the right foot rises, turned back (−y) as the left leg is ahead.
    const rolls = unit(all((f) => heights[1][f] - heights[0][f])), turns = unit(all((f) => ahead("left", f) - ahead("right", f)));
    const own = all((f) => [roll(f), yaw(f)]), Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0), rad = Math.PI / 180;
    for (let f = 0; f < frames; f++) {
      const r = sway[0] * rad * rolls[f] - own[f][0], t = sway[1] == null ? 0 : -sway[1] * rad * turns[f] - own[f][1];
      set("hips", f, new THREE.Quaternion().setFromAxisAngle(Y, t).multiply(new THREE.Quaternion().setFromAxisAngle(Z, r)).multiply(quat("hips", f)));
    }
  }
  if (knee) {
    const sorted = Array.from({ length: frames * 2 }, (_, i) => kneeAngle(SIDES[i % 2], i >> 1)).sort((a, b) => a - b);
    const own = KNEE_QUANTILES.map((p) => sorted[Math.round(p * (sorted.length - 1))]);
    const map = (x) => {
      let k = 0;
      while (k < own.length - 2 && x > own[k + 1]) k++;
      return Math.max(1, knee[k] + ((x - own[k]) * (knee[k + 1] - knee[k])) / (own[k + 1] - own[k]));
    };
    for (let f = 0; f < frames; f++) for (const side of SIDES) { const a = kneeAngle(side, f); bend(side, f, map(a) - a); }
  }
  for (let f = 0; f < frames; f++) {
    if (ground === "hips") {
      hips[f * 3 + 1] += Math.min(heights[0][f], heights[1][f]) - Math.min(ankle("left", f).y, ankle("right", f).y);
      continue;
    }
    // The feet down in the source (the lower foot, within 6 cm of the floor) back on their paths;
    // none below the floor.
    let short = 0;
    SIDES.forEach((side, i) => {
      const down = heights[i][f] <= heights[1 - i][f] && heights[i][f] - floor < 0.06, end = ankle(side, f);
      if (!down && end.y >= floor) return;
      const want = down ? paths[i][f].clone() : end.clone().setY(floor);
      const a = hip(side, f), b = a.clone().add(dir(`${side}UpperLeg`, `${side}LowerLeg`, f));
      const [qa, qb] = twoBoneIK(a.toArray(), b.toArray(), end.toArray(), want.toArray()).map((q) => new THREE.Quaternion(...q));
      set(`${side}UpperLeg`, f, qa.clone().multiply(quat(`${side}UpperLeg`, f)));
      set(`${side}LowerLeg`, f, qb.clone().multiply(qa).multiply(quat(`${side}LowerLeg`, f)));
      short = Math.max(short, ankle(side, f).y - want.y);
    });
    hips[f * 3 + 1] -= short;
  }
  for (const role of Object.keys(rotations)) rotations[role] = rotations[role].map(round);
  for (let i = 0; i < hips.length; i++) hips[i] = round(hips[i]);
}

const index = {};
for (const [id, name] of Object.entries(CLIPS)) {
  const sample = sampled(name, NATURAL[id]?.steps);
  if (NATURAL[id]) natural(sample, NATURAL[id]);
  const { frames, rotations, hips } = sample;
  const loop = name.endsWith("_Loop");
  writeFileSync(join(OUT, `${id}.json`), JSON.stringify({ name: id, source: `Quaternius UAL ${name} (CC0)`, fps: FPS, frames, loop, rest: restPositions, stand, rotations, hips }));
  index[id] = { frames, loop };
  console.log(`${id}: ${name}, ${frames} frames`);
}
writeFileSync(join(OUT, "index.json"), JSON.stringify(index));
