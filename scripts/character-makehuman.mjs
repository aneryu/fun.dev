// The repository's people (docs/character-generator.md#data): bodies, faces, garments and hair from
// MakeHuman's CC0 assets, fitted to our skeleton and LODs. Only assets whose own files say CC0 are
// used. The sources stay outside the repository; this writes the fitted data set and its textures.
//
//   node scripts/character-makehuman.mjs [SOURCE]
//     SOURCE: default ~/cc0-sources/makehuman (repo/ = makehuman's makehuman/data, packs/ = asset packs).
//   → site/runtime/kit/character/data/makehuman.js, data/textures/*.webp
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { bodyMeasures, clipHalf, cornerUVs, coveredFaces, levelsOf, liftedOff, r5, roundAll, simplify, topWeights, tuckedSkin } from "./lib/character-fit.mjs";
import { applyTargets, fitProxy, isCC0, readMhclo, readMhmat, readObj, readTarget } from "./lib/makehuman.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = process.argv[2] ?? join(homedir(), "cc0-sources/makehuman");
const DATA = join(SOURCE, "repo/makehuman/data"), PACKS = join(SOURCE, "packs");
const OUT = join(ROOT, "site/runtime/kit/character/data/makehuman.js"), TEXTURES = join(ROOT, "site/runtime/kit/character/data/textures");
const TARGETS = [3500, 1200, 400];   // triangles of the left half per LOD
const ETHNIC = ["african", "asian", "caucasian"];
const DM = 0.1;   // MakeHuman's units are decimetres

const base = readObj(join(DATA, "3dobjs/base.obj"));
const rig = JSON.parse(readFileSync(join(DATA, "rigs/default.mhskel"), "utf8"));
const skinWeights = JSON.parse(readFileSync(join(DATA, "rigs/default_weights.mhw"), "utf8")).weights;
const targets = new Map();
const target = (name) => { if (!targets.has(name)) targets.set(name, readTarget(join(DATA, "targets", `${name}.target`))); return targets.get(name); };

/** A body's pose of the base mesh: the ethnic mix's targets for a gender and age (MakeHuman's macro modifiers). */
const pose = (gender, mix = { african: 1 / 3, asian: 1 / 3, caucasian: 1 / 3 }, age = "young", extra = proportions[gender] ?? []) =>
  applyTargets(base.v, [...ETHNIC.filter((e) => mix[e]).map((e) => [target(`macrodetails/${e}-${gender}-${age}`), mix[e]]), ...extra]);
const proportions = {};   // gender → the proportion targets the fit chose (below)

// ── Bones: MakeHuman's default rig → our ids (its left side ".L" is our "l_", at +x). ──
const BONES = { root: "pelvis", spine05: "spine_root", spine04: "spine0", spine03: "spine1", spine02: "spine2", spine01: "spine3",
  neck01: "neck", neck02: "neck_roll", neck03: "neck_roll", head: "head", jaw: "jaw", "breast.L": "spine2", "breast.R": "spine2" };
for (const [S, s] of [["L", "l"], ["R", "r"]]) {
  Object.assign(BONES, {
    [`pelvis.${S}`]: "pelvis", [`upperleg01.${S}`]: `${s}_thigh_roll`, [`upperleg02.${S}`]: `${s}_thigh`, [`lowerleg01.${S}`]: `${s}_calf`, [`lowerleg02.${S}`]: `${s}_calf`,
    [`foot.${S}`]: `${s}_foot`, [`clavicle.${S}`]: `${s}_clavicle`, [`shoulder01.${S}`]: `${s}_upperarm_roll`, [`upperarm01.${S}`]: `${s}_upperarm_roll`,
    [`upperarm02.${S}`]: `${s}_upperarm`, [`lowerarm01.${S}`]: `${s}_forearm`, [`lowerarm02.${S}`]: `${s}_forearm_roll`, [`wrist.${S}`]: `${s}_hand`, [`eye.${S}`]: `${s}_eye`,
  });
  for (let m = 1; m <= 4; m++) BONES[`metacarpal${m}.${S}`] = `${s}_hand`;
  for (let f = 1; f <= 5; f++) for (let j = 1; j <= 3; j++) BONES[`finger${f}-${j}.${S}`] = `${s}_finger${f - 1}${j - 1}`;
  for (let t = 1; t <= 5; t++) for (let j = 1; j <= 3; j++) BONES[`toe${t}-${j}.${S}`] = `${s}_toe`;
}
/** Our bone for one of MakeHuman's: mapped, or its nearest mapped ancestor (the face's muscles go to the head or jaw). */
const ourBone = (name) => { for (let n = name; n; n = rig.bones[n]?.parent) if (BONES[n]) return BONES[n]; return "hips"; };
const vertexWeights = base.v.map(() => new Map());
for (const [bone, list] of Object.entries(skinWeights)) {
  const id = ourBone(bone);
  for (const [v, w] of list) vertexWeights[v].set(id, (vertexWeights[v].get(id) ?? 0) + w);
}

// ── One body: the left half of its skin, its joints, eye and landmarks. ──
const bodyFaces = base.faces.filter((f) => f.group === "body");
const groupVerts = (group) => [...new Set(base.faces.filter((f) => f.group === group).flatMap((f) => f.v))];
/** A pose's skin: the body's vertices in metres with the feet on y = 0, triangles with corner UVs, weights and sources. */
function skinOf(posed) {
  const bodyVerts = [...new Set(bodyFaces.flatMap((f) => f.v))];
  const floor = Math.min(...bodyVerts.map((i) => posed[i][1]));
  const M = (q) => [q[0] * DM, (q[1] - floor) * DM, q[2] * DM];
  const index = new Map(bodyVerts.map((v, k) => [v, k]));
  const mesh = { p: bodyVerts.map((v) => M(posed[v])), w: bodyVerts.map((v) => [...vertexWeights[v]]), src: bodyVerts.map((v) => [[v, 1]]), f: [], uv: [], island: [] };
  for (const f of bodyFaces) {
    // A quad as two triangles; UVs with v flipped (textures load top row first).
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      mesh.f.push(tri.map((c) => index.get(f.v[c])));
      mesh.uv.push(tri.map((c) => { const t = base.vt[f.vt[c]]; return [t[0], 1 - t[1]]; }));
      mesh.island.push("skin");
    }
  }
  for (const p of mesh.p) if (Math.abs(p[0]) < 1e-4) p[0] = 0;
  return { M, mesh };
}

/** A pose's skeleton: joints (our ids), tips, landmarks and the eyeball, from the rig's joint helpers and the skin. */
function skeletonOf(posed, M, points) {
  const joint = (name) => { const vs = rig.joints[name]; return M([0, 1, 2].map((k) => vs.reduce((s, i) => s + posed[i][k], 0) / vs.length)); };
  const head = (bone) => joint(rig.bones[bone].head), tail = (bone) => joint(rig.bones[bone].tail);
  const lerp = (a, b, t) => a.map((x, k) => x + (b[k] - x) * t), centre = (p) => [0, p[1], p[2]];
  const eyeVerts = groupVerts("helper-l-eye").map((i) => M(posed[i]));
  const eye = [0, 1, 2].map((k) => eyeVerts.reduce((s, p) => s + p[k], 0) / eyeVerts.length);
  const eyeRadius = Math.max(...eyeVerts.map((p) => Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2])));
  const crownY = Math.max(...points.map((p) => p[1]));
  const hip = head("upperleg01.L"), headBone = centre(head("head"));
  // The face's minor joints by the proportions of its own head (its bone to the crown, the front of the face).
  const s = crownY - headBone[1];
  const faceFront = Math.max(...points.filter((p) => Math.abs(p[0]) < 0.02 && p[1] > headBone[1] + 0.2 * s && p[1] < headBone[1] + 0.6 * s).map((p) => p[2]));
  const F = (x, y, z) => [x * s, headBone[1] + y * s, faceFront + z * s];
  const joints = {
    // The hips at the hip joints' height; the pelvis a little above, so it points down to them.
    hips: [0, hip[1], hip[2]], pelvis: lerp([0, hip[1], hip[2]], centre(head("spine05")), 0.4), spine_root: centre(head("spine05")), spine0: centre(head("spine04")), spine1: centre(head("spine03")),
    spine2: centre(head("spine02")), spine3: centre(head("spine01")), neck: centre(head("neck01")), neck_roll: centre(head("neck02")), head: headBone,
    l_thigh: hip, l_thigh_roll: lerp(hip, head("lowerleg01.L"), 0.15), l_calf: head("lowerleg01.L"), l_foot: head("foot.L"), l_toe: head("toe3-1.L"),
    l_clavicle: head("clavicle.L"), l_upperarm: head("upperarm01.L"), l_upperarm_roll: lerp(head("upperarm01.L"), head("lowerarm01.L"), 0.1),
    l_forearm: head("lowerarm01.L"), l_forearm_roll: head("lowerarm02.L"), l_hand: head("wrist.L"),
    face_root: F(0, 0.15, -0.45), brow_centre: F(0, 0.55, -0.05), upperlip_root: F(0, 0.12, -0.08), upperlip: F(0, 0.12, -0.02),
    jaw: centre(head("jaw")), lowerlip_root: F(0, 0.04, -0.08), lowerlip: F(0, 0.04, -0.02), tongue: F(0, 0.08, -0.15),
    l_brow_out: F(0.2, 0.52, -0.12), l_lid_upper: [eye[0], eye[1] + eyeRadius * 0.8, eye[2] + eyeRadius * 0.3], l_eye: eye, l_cheekbone: F(0.2, 0.32, -0.12),
    l_lip_corner: F(0.08, 0.08, -0.06), l_lip_top: F(0.04, 0.13, -0.02), l_lip_bot: F(0.04, 0.03, -0.02),
  };
  for (let f = 0; f < 5; f++) for (let j = 0; j < 3; j++) joints[`l_finger${f}${j}`] = head(`finger${f + 1}-${j + 1}.L`);
  const tips = { crown: [0, crownY, headBone[2]] };
  for (let f = 0; f < 5; f++) tips[`finger${f}Tip`] = tail(`finger${f + 1}-3.L`);
  const footPts = points.filter((p) => p[0] > 0.02 && p[1] < joints.l_foot[1] + 0.02);
  const toe = footPts.reduce((a, p) => (p[2] > a[2] ? p : a));
  tips.toeTip = [toe[0], Math.max(0.02, toe[1]), toe[2]];
  const trunk = points.filter((p) => Math.abs(p[0]) < 0.01 && p[1] > 0.5 && p[1] < joints.hips[1]);
  const landmarks = { crotchY: Math.min(...trunk.map((p) => p[1])), crownY, headCenterZ: headBone[2], heelZ: Math.min(...footPts.map((p) => p[2])), toeZ: toe[2], toeX: toe[0], legTop: 0.1 };
  return { joints, tips, landmarks, eye, eyeRadius, crownY };
}

async function fitBody(id, posed) {
  const { M, mesh } = skinOf(posed);
  const half = clipHalf(mesh);
  console.log(`${id}: ${mesh.f.length} triangles, ${half.f.length} in the left half`);
  // The head keeps 40 % of each LOD's triangles: faces are what people look at.
  const neckY = M([0, Math.max(...rig.joints[rig.bones.neck02.head].map((i) => posed[i][1])), 0])[1];
  const levels = await levelsOf(half, TARGETS, { region: { inside: (p) => p[1] > neckY, share: 0.4 } });
  const { joints, tips, landmarks, eye, eyeRadius, crownY } = skeletonOf(posed, M, mesh.p);
  console.log(`  stature ${crownY.toFixed(3)} m, eye ${eye.map((x) => x.toFixed(3))} r ${(eyeRadius * 1000).toFixed(1)} mm`);
  return { shape: { id, rest: "A", eyeRadius: r5(eyeRadius), joints: roundAll(joints), tips: roundAll(tips), landmarks: roundAll(landmarks), mesh: levels.map(({ src, ...l }) => l) }, levels, M, posed };
}

// ── Proportions: MakeHuman's measurement targets weighted so the body's proportions (lengths and
// girths over its stature) meet a goal's, at a chosen stature; only the weights are kept. ──

// The goal: the median Chinese adult (18-70), from GB/T 10000-2023, Human dimensions of Chinese
// adults (tables 1 and 6, P50; stature, tibiale height, forearm length, chest, waist, hip and thigh
// circumferences), its stature also the bodies'. The standard has no standing cervicale, hip or
// ankle height, calf or neck circumference: those keep ANSUR's proportions (below) to the stature.
const CHINA = {
  m: { stature: 1.687, kneeY: 0.445, forearm: 0.235, chest: 0.927, waist: 0.849, hips: 0.938, thighGirth: 0.537 },
  f: { stature: 1.572, kneeY: 0.409, forearm: 0.219, chest: 0.895, waist: 0.781, hips: 0.921, thighGirth: 0.536 },
};
// ANSUR: the mean US Army soldier, from the 2012 Anthropometric Survey (ANSUR II; Gordon et al.,
// NATICK/TR-15/007, 2014, chapter IV; a US Government work, public domain), in metres, as the
// bodyMeasures each landmark stands for: cervicale height for the neck joint's, trochanterion for
// the hip joint's, tibiale for the knee's, lateral malleolus for the ankle's, radiale-stylion for
// the forearm; chest, waist (omphalion), buttock, thigh, calf and neck circumferences. Shoulder
// width and the upper arm are left out: the survey's acromion is not a joint.
const ANSUR = {
  m: { stature: 1.7562, neckY: 1.5173, hipY: 0.9009, kneeY: 0.4682, ankleY: 0.0729, forearm: 0.2679,
    chest: 1.0587, waist: 0.9406, hips: 1.0195, thighGirth: 0.6251, calfGirth: 0.3923, neckGirth: 0.3976 },
  f: { stature: 1.6285, neckY: 1.3957, hipY: 0.8454, kneeY: 0.4378, ankleY: 0.0627, forearm: 0.2413,
    chest: 0.9469, waist: 0.8609, hips: 1.0212, thighGirth: 0.6161, calfGirth: 0.3733, neckGirth: 0.3298 },
};
const PROPORTION_TARGETS = (g) => [
  ["height", `macrodetails/height/${g}-young-averagemuscle-averageweight-maxheight`, `macrodetails/height/${g}-young-averagemuscle-averageweight-minheight`],
  ["muscle", `macrodetails/universal-${g}-young-maxmuscle-averageweight`, `macrodetails/universal-${g}-young-minmuscle-averageweight`],
  ["weight", `macrodetails/universal-${g}-young-averagemuscle-maxweight`, `macrodetails/universal-${g}-young-averagemuscle-minweight`],
  ...["shoulder-dist", "upperarm-length", "lowerarm-length", "upperleg-height", "lowerleg-height", "neck-height", "napetowaist-dist", "waisttohip-dist",
    g === "female" ? "bust-circ" : "frontchest-dist", "underbust-circ", "waist-circ", "hips-circ", "thigh-circ", "calf-circ", "neck-circ", "upperarm-circ"]
    .map((m) => [m, `measure/measure-${m}-incr`, `measure/measure-${m}-decr`]),
];
const STATURE = { male: 1.687, female: 1.572 };
function measurePose(posed) {
  const { M, mesh } = skinOf(posed);
  return bodyMeasures(mesh.p, skeletonOf(posed, M, mesh.p).joints, mesh.f);
}
function fitProportions(gender, goal) {
  const vars = PROPORTION_TARGETS(gender).filter(([, up, down]) => existsSync(join(DATA, "targets", `${up}.target`)) && existsSync(join(DATA, "targets", `${down}.target`)));
  const keys = Object.keys(goal).filter((k) => k !== "stature" && goal[k] > 0);
  const extra = (x) => vars.flatMap(([, up, down], k) => (x[k] > 0 ? [[target(up), x[k]]] : x[k] < 0 ? [[target(down), -x[k]]] : []));
  const residuals = (x) => {
    const m = measurePose(pose(gender, undefined, "young", extra(x)));
    // Proportions in percent of stature, the stature itself in centimetres.
    return [...keys.map((k) => ((m[k] / m.stature) - goal[k] / goal.stature) * 100), (m.stature - STATURE[gender]) * 100];
  };
  let x = vars.map(() => 0), r = residuals(x);
  const cost = (v) => v.reduce((s, e) => s + e * e, 0);
  console.log(`${gender} proportions: start ${cost(r).toFixed(1)}`);
  for (let iteration = 0; iteration < 5; iteration++) {
    const h = 0.25, J = vars.map((_, k) => { const xp = [...x]; xp[k] = Math.min(1, x[k] + h); const rp = residuals(xp); return rp.map((v, i) => (v - r[i]) / (xp[k] - x[k] || h)); });
    // (JᵀJ + λI) dx = −Jᵀr, then clamped to [−1, 1].
    const n = vars.length, A = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0) + (a === b ? 2 : 0)));
    const g = J.map((col) => -col.reduce((s, v, i) => s + v * r[i], 0));
    const dx = solve(A, g), next = x.map((v, k) => Math.min(1, Math.max(-1, v + dx[k]))), rn = residuals(next);
    if (cost(rn) >= cost(r)) break;
    x = next; r = rn;
    console.log(`  iteration ${iteration + 1}: ${cost(r).toFixed(1)}`);
  }
  console.log(`  weights ${vars.map(([name], k) => `${name} ${x[k].toFixed(2)}`).filter((t) => !t.endsWith(" 0.00")).join(", ")}`);
  return { targets: extra(x), weights: Object.fromEntries(vars.map(([name], k) => [name, Math.round(x[k] * 1000) / 1000])) };
}
/** Gaussian elimination with partial pivoting. */
function solve(A, b) {
  const n = b.length, M2 = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r2 = c + 1; r2 < n; r2++) if (Math.abs(M2[r2][c]) > Math.abs(M2[p][c])) p = r2;
    [M2[c], M2[p]] = [M2[p], M2[c]];
    for (let r2 = c + 1; r2 < n; r2++) { const f = M2[r2][c] / M2[c][c]; for (let k = c; k <= n; k++) M2[r2][k] -= f * M2[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r2 = n - 1; r2 >= 0; r2--) { let v = M2[r2][n]; for (let k = r2 + 1; k < n; k++) v -= M2[r2][k] * x[k]; x[r2] = v / M2[r2][r2]; }
  return x;
}

// ── Textures: downscaled WebP files beside the data. ──
mkdirSync(TEXTURES, { recursive: true });
async function texture(file, name, { size = 1024, alpha = false } = {}) {
  if (!existsSync(file)) throw new Error(`no texture ${file}`);
  await sharp(file).resize(size, size, { fit: "fill" }).webp({ quality: 82, alphaQuality: 90, lossless: false, ...(alpha ? {} : {}) }).toFile(join(TEXTURES, `${name}.webp`));
  return `${name}.webp`;
}
/** The eye atlas: an 8 × 4 grid of 128-pixel cells, the first row the eye colours in our order, each the front view of one eyeball of MakeHuman's texture. */
const EYES = { hazel: "brownlight", green: "green", light_blue: "ice", blue: "blue", brown: "brown", dark_brown: "brown", amber: "brownlight", grey: "grey" };
async function eyeAtlas() {
  const cells = [];
  for (const [k, [ours, theirs]] of Object.entries(EYES).entries()) {
    // The upper right eyeball: its disc spans the cell's 0.47 radius (as the generator maps it).
    const file = join(PACKS, "makehuman_system_assets/eyes/materials", `${theirs}_eye.png`);
    const { width } = await sharp(file).metadata(), r = 0.285 * width, cx = 0.705 * width, cy = 0.3 * width;
    const side = Math.min(Math.round((2 * r) / 0.94), Math.floor(2 * cy), Math.floor(2 * (width - cx)));   // within the image
    const cell = await sharp(file).extract({ left: Math.round(cx - side / 2), top: Math.round(cy - side / 2), width: side, height: side }).resize(128, 128).png().toBuffer();
    // Two colours MakeHuman lacks: its brown darker, its light brown warmer, in the iris only.
    const tone = { dark_brown: { brightness: 0.55 }, amber: { hue: 15, saturation: 1.5 } }[ours];
    let input = cell;
    if (tone) {
      const iris = Buffer.from('<svg width="128" height="128"><circle cx="64" cy="64" r="27" fill="white"/></svg>');
      const toned = await sharp(cell).modulate(tone).composite([{ input: iris, blend: "dest-in" }]).png().toBuffer();
      input = await sharp(cell).composite([{ input: toned }]).png().toBuffer();
    }
    cells.push({ input, left: k * 128, top: 0 });
  }
  await sharp({ create: { width: 1024, height: 512, channels: 3, background: { r: 230, g: 225, b: 220 } } }).composite(cells).webp({ quality: 88 }).toFile(join(TEXTURES, "mh_eyes.webp"));
  return "mh_eyes.webp";
}

// ── Faces: whole faces from MakeHuman's ethnic and age mixes, and the feature sliders' morphs. ──
// Each face: [id, ethnic mix, age, skin]; a mix's skin is its main ethnicity's.
const FACES = [
  ["african", { african: 1 }, "young"], ["asian", { asian: 1 }, "young"], ["caucasian", { caucasian: 1 }, "young"],
  ["afro_asian", { african: 0.5, asian: 0.5 }, "young"], ["afro_caucasian", { african: 0.5, caucasian: 0.5 }, "young"], ["eurasian", { asian: 0.5, caucasian: 0.5 }, "young"],
  ["african_old", { african: 1 }, "old"], ["asian_old", { asian: 1 }, "old"], ["caucasian_old", { caucasian: 1 }, "old"],
];
// Our feature morphs (kit/character/face.js FEATURES) → MakeHuman targets (both sides' where it has one per side).
const both = (name) => [`cheek/l-${name}`, `cheek/r-${name}`];
const eyesBoth = (name) => [`eyes/l-${name}`, `eyes/r-${name}`];
const MORPHS = {
  nose_thin: ["nose/nose-scale-horiz-decr"], nose_wide: ["nose/nose-scale-horiz-incr"], nose_down: ["nose/nose-trans-down"], nose_up: ["nose/nose-trans-up"],
  nose_short: ["nose/nose-scale-depth-decr"], nose_long: ["nose/nose-scale-depth-incr"], nose_profile_curved: ["nose/nose-curve-concave"], nose_profile_crooked: ["nose/nose-hump-incr"],
  nose_tip_down: ["nose/nose-point-down"], nose_tip_up: ["nose/nose-point-up"], brow_down: ["eyebrows/eyebrows-trans-down"], brow_up: ["eyebrows/eyebrows-trans-up"],
  brow_in: ["eyebrows/eyebrows-trans-backward"], brow_out: ["eyebrows/eyebrows-trans-forward"], cheek_down: both("cheek-trans-down"), cheek_up: both("cheek-trans-up"),
  cheek_in: both("cheek-bones-decr"), cheek_out: both("cheek-bones-incr"), cheek_gaunt: both("cheek-volume-decr"), cheek_puffed: both("cheek-volume-incr"),
  eyes_squinted: eyesBoth("eye-height2-decr"), eyes_wide: eyesBoth("eye-height2-incr"), lips_thin: ["mouth/mouth-upperlip-volume-decr", "mouth/mouth-lowerlip-volume-decr"],
  lips_fat: ["mouth/mouth-upperlip-volume-incr", "mouth/mouth-lowerlip-volume-incr"], jaw_narrow: ["chin/chin-width-decr"], jaw_wide: ["chin/chin-width-incr"],
  jaw_round: ["chin/chin-bones-decr"], jaw_square: ["chin/chin-bones-incr"], chin_down: ["chin/chin-height-incr"], chin_up: ["chin/chin-height-decr"],
  chin_in: ["chin/chin-prominent-decr"], chin_out: ["chin/chin-prominent-incr"], chin_pointed: ["chin/chin-triangle"], chin_square: ["chin/chin-prognathism-incr"],
  chin_bum: ["chin/chin-cleft-incr"], neck_male: ["neck/neck-scale-horiz-incr"],
};
const UNIT = 1e4;   // face deltas in 0.1 mm
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** A body's faces: per LOD, the deltas of its head vertices for each face and morph (from their sources), and the eyeball's. */
function facesOf(id, gender, fit) {
  const { levels, posed, M } = fit, neck = rig.joints[rig.bones.neck02.head];
  const neckY = M([0, Math.max(...neck.map((i) => posed[i][1])), 0])[1];
  const anchor = (p) => [0, 1, 2].map((k) => neck.reduce((s, i) => s + p[i][k], 0) / neck.length);
  const eyeVerts = groupVerts("helper-l-eye");
  // A face's delta at a base vertex: its pose less the body's, less how far its neck moved.
  const faceDelta = FACES.map(([, mix, age]) => {
    const p = pose(gender, mix, age), a0 = anchor(posed), a1 = anchor(p);
    return (i) => [0, 1, 2].map((k) => (p[i][k] - posed[i][k] - (a1[k] - a0[k])) * DM);
  });
  const morphNames = Object.keys(MORPHS).sort();
  const morphDelta = morphNames.map((m) => { const ts = MORPHS[m].map(target); return (i) => [0, 1, 2].map((k) => ts.reduce((s, t) => s + (t.get(i)?.[k] ?? 0), 0) * DM); });
  const pack = (d) => d.map((x) => Math.round(x * UNIT));
  const lods = levels.map((level) => {
    const v = level.p.map((p, i) => [p, i]).filter(([p]) => p[1] > neckY - 0.04).map(([, i]) => i);
    const at = (delta, i) => {
      const w = smoothstep(neckY - 0.04, neckY + 0.02, level.p[i][1]);
      const d = level.src[i].reduce((s, [j, x]) => { const dj = delta(j); return s.map((c, k) => c + dj[k] * x); }, [0, 0, 0]).map((c) => c * w);
      if (level.p[i][0] === 0) d[0] = 0;
      return pack(d);
    };
    return { v, heads: faceDelta.map((delta) => v.flatMap((i) => at(delta, i))), morphs: Object.fromEntries(morphNames.map((m, k) => [m, v.flatMap((i) => at(morphDelta[k], i))])) };
  });
  const eyeOffset = (delta) => pack([0, 1, 2].map((k) => eyeVerts.reduce((s, i) => s + delta(i)[k], 0) / eyeVerts.length));
  console.log(`  ${id}: ${FACES.length} faces, ${morphNames.length} morphs, ${lods.map((l) => l.v.length).join("/")} head vertices`);
  return {
    faces: FACES.map(([f]) => f), tints: FACES.map(() => [1, 1, 1]), morphs: morphNames,
    eyes: { heads: faceDelta.map(eyeOffset), morphs: Object.fromEntries(morphNames.map((m, k) => [m, eyeOffset(morphDelta[k])])) },
    lods,
  };
}

const SKINS = "makehuman_system_assets/skins";
const skinFile = (name) => { const dir = join(PACKS, SKINS, name); const png = readFileSync(join(dir, `${name}.mhmat`), "utf8").match(/^diffuseTexture\s+(\S+)/m)[1]; return join(dir, png.split("/").pop()); };

// ── Garments, hair and eyebrows: MakeHuman's clothes (.mhclo), bound to the base mesh, so each fits
// any body; fitted once in topology and once per body in position. ──
const SYS = "makehuman_system_assets";
const WEAR = {
  m: {
    outfit: [`${SYS}/clothes/male_casualsuit01`, `${SYS}/clothes/male_casualsuit02`, `${SYS}/clothes/male_casualsuit04`, `${SYS}/clothes/male_casualsuit06`, `${SYS}/clothes/male_worksuit01`],
    top: ["shirts01/clothes/elvs_crude_t-shirt_male", "shirts01/clothes/namuhekam_male_polo_shirt", "shirts01/clothes/toigo_fisherman_sweater"],
    bottom: ["pants01/clothes/toigo_wool_pants"],
    shoes: [`${SYS}/clothes/shoes01`, `${SYS}/clothes/shoes02`, `${SYS}/clothes/shoes05`, `${SYS}/clothes/shoes06`, "shoes01/clothes/toigo_ankle_boots_male"],
    hair: [`${SYS}/hair/short01`, `${SYS}/hair/short02`, `${SYS}/hair/short03`, `${SYS}/hair/short04`, `${SYS}/hair/afro01`],
    brows: [`${SYS}/eyebrows/eyebrow001`, `${SYS}/eyebrows/eyebrow005`, `${SYS}/eyebrows/eyebrow009`],
  },
  f: {
    outfit: [`${SYS}/clothes/female_casualsuit01`, `${SYS}/clothes/female_casualsuit02`, `${SYS}/clothes/female_sportsuit01`, `${SYS}/clothes/female_elegantsuit01`],
    top: ["shirts01/clothes/joepal_crude_t-shirt_female", "shirts01/clothes/toigo_basic_tucked_t-shirt", "shirts01/clothes/toigo_camisole_top", "shirts01/clothes/toigo_keyhole_tank_top"],
    bottom: ["pants01/clothes/toigo_wool_pants", "pants01/clothes/toigo_harem_pants"],
    shoes: ["shoes01/clothes/toigo_ballet_flats", "shoes01/clothes/toigo_flats", "shoes01/clothes/toigo_ankle_boots_female", `${SYS}/clothes/shoes05`],
    hair: [`${SYS}/hair/bob01`, `${SYS}/hair/bob02`, `${SYS}/hair/ponytail01`, `${SYS}/hair/long01`, `${SYS}/hair/braid01`, "hair01/hair/toigo_blunt_bob", "hair01/hair/toigo_curled_under_bob", "hair01/hair/faydaen_hair_1"],
    brows: [`${SYS}/eyebrows/eyebrow002`, `${SYS}/eyebrows/eyebrow006`, `${SYS}/eyebrows/eyebrow010`],
  },
};
// Triangles per LOD (the asset's own count when fewer), texture size, colours as tints over the texture.
const SLOT = {
  outfit: { targets: [2000, 900, 350], size: 1024, tints: ["#ffffff", "#c8d2e0", "#d9c7ad", "#9aa596"] },
  top: { targets: [1000, 450, 200], size: 1024, tints: ["#ffffff", "#5b7fa6", "#a64b3c", "#3f5e3a"] },
  bottom: { targets: [1000, 450, 200], size: 512, tints: ["#ffffff", "#6b7c99", "#4a4038", "#8c8273"] },
  shoes: { targets: [500, 220, 80], size: 512, tints: ["#ffffff", "#8a6b4f", "#3a3a3a", "#a9b6c4"] },
  hair: { targets: [2000, 900, 400], size: 1024, tints: ["#ffffff", "#7a5236", "#2e2219", "#d9b878"] },
  brows: { targets: [150, 90, 50], size: 256, tints: ["#ffffff", "#6b4a33", "#2b1f17", "#c9a26b"] },
};
const COVERS = { outfit: ["top", "bottom"] };   // a whole outfit takes the top and bottom slots
const garmentId = (path) => path.split("/").pop().replace(/[^a-z0-9]+/gi, "_").toLowerCase();

/** One garment's topology (LODs: faces, corner UVs, weights, and which of its vertices each level keeps), texture, and per body its positions and the body faces it hides. */
async function fitGarment(path, slot, bodies) {
  const dir = join(PACKS, path), file = readFileSync(join(dir, `${path.split("/").pop()}.mhclo`)) && join(dir, `${path.split("/").pop()}.mhclo`);
  const clo = readMhclo(file);
  if (!isCC0(clo)) throw new Error(`${path}: not CC0 by its own file (${clo.license ?? "no licence"})`);
  const obj = readObj(clo.obj), material = readMhmat(clo.material), id = garmentId(path);
  if (obj.v.length !== clo.verts.length) throw new Error(`${path}: ${obj.v.length} vertices, ${clo.verts.length} bindings`);
  // Weights through the binding: the bound base vertices' weights, by the binding's weights.
  const weights = clo.verts.map(({ v, w }) => { const m = new Map(); v.forEach((bv, k) => { for (const [b, x] of vertexWeights[bv]) m.set(b, (m.get(b) ?? 0) + x * w[k]); }); return [...m]; });
  const tris = [], uvs = [];
  for (const f of obj.faces) for (const tri of f.v.length === 4 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]]) {
    tris.push(tri.map((c) => f.v[c]));
    uvs.push(tri.map((c) => { const t = obj.vt[f.vt[c]] ?? [0, 0]; return [t[0], 1 - t[1]]; }));
  }
  // Clothes (not hair, not eyebrows) lift off each body's skin where they lie too close.
  const cloth = slot !== "hair" && slot !== "brows";
  const at = (body) => { const p = fitProxy(clo, bodies[body].posed).map(bodies[body].M); return cloth ? liftedOff(p, tris, bodies[body].levels[0]).p : p; };
  const first = Object.keys(bodies)[0], positions = Object.fromEntries(Object.keys(bodies).map((b) => [b, at(b)]));
  const full = { p: positions[first], w: weights, src: weights.map((_, i) => [[i, 1]]), f: tris, uv: uvs, island: tris.map(() => id) };
  const lods = [];
  for (const target of SLOT[slot].targets) {
    const level = await simplify(full, target);
    const { fuv } = cornerUVs(full, level);
    lods.push({ f: level.f, fuv, w: level.w.map(topWeights), keep: level.src.map(([[i]]) => i) });
  }
  // The body faces it hides: those it deletes (every source vertex) and those it covers; and the skin it tucks under it.
  const hides = {}, tucks = {};
  for (const b of Object.keys(bodies)) {
    const levels = bodies[b].levels, cover = cloth ? coveredFaces(positions[b], tris, levels) : levels.map(() => []);
    hides[b] = levels.map((level, l) => [...new Set([...level.f.flatMap((t, k) => (t.every((i) => level.src[i].every(([j]) => clo.deleteVerts.has(j))) ? [k] : [])), ...cover[l]])].sort((x, y) => x - y));
    tucks[b] = cloth ? tuckedSkin(positions[b], tris, levels) : levels.map(() => []);
  }
  const textureName = `mh_${slot}_${id}`;
  const textureFile = material.diffuseTexture ? await texture(material.diffuseTexture, textureName, { size: SLOT[slot].size }) : null;
  const alpha = /true/i.test(material.transparent ?? "") || slot === "hair" || slot === "brows";
  console.log(`  ${slot} ${id}: ${tris.length} triangles → ${lods.map((l) => l.f.length).join("/")}, hides ${Object.entries(hides).map(([b, h]) => `${b} ${h[0].length}`).join(", ")}, tucks ${Object.entries(tucks).map(([b, t]) => `${b} ${t[0].length / 4}`).join(", ")}`);
  sources.push({ id, asset: path, author: clo.author ?? null, license: clo.released ? "CC0 (MakeHuman's 2020 release)" : clo.license });
  return { id, shared: { slot, ...(COVERS[slot] ? { covers: COVERS[slot] } : {}), texture: textureFile, alpha, colours: ["a", "b", "c", "d"], tints: Object.fromEntries(["a", "b", "c", "d"].map((c, k) => [c, SLOT[slot].tints[k]])), lods: lods.map(({ keep, ...l }) => l) },
    positions: Object.fromEntries(Object.entries(positions).map(([b, p]) => [b, lods.map((l) => l.keep.flatMap((i) => p[i].map((x) => Math.round(x * 1e4))))])), hides, tucks };
}

const sources = [
  { id: "base", asset: "makehuman/data: 3dobjs/base.obj, targets, rigs/default.mhskel and default_weights.mhw", author: "MakeHuman team", license: "CC0 (MakeHuman's 2020 release)" },
  { id: "skins and eyes", asset: "makehuman_system_assets: skins, eyes", author: "MakeHuman team", license: "CC0 (MakeHuman's 2020 release)" },
];
const out = { shapes: {}, garments: {}, faces: {}, textures: {} };
const fitted = {};
const GOAL = Object.fromEntries(Object.entries(CHINA).map(([id, china]) => [id, {
  ...Object.fromEntries(Object.entries(ANSUR[id]).map(([k, v]) => [k, (v / ANSUR[id].stature) * china.stature])),
  ...china,
}]));
for (const [id, gender] of [["m", "male"], ["f", "female"]]) {
  let fit = null;
  if (GOAL?.[id]) { fit = fitProportions(gender, GOAL[id]); proportions[gender] = fit.targets; }
  fitted[id] = await fitBody(id, pose(gender));
  if (fit) fitted[id].shape.proportions = fit.weights;   // MakeHuman's measurement modifiers, as applied
  out.shapes[id] = fitted[id].shape;
  out.textures[`${id}/skin`] = await texture(skinFile(`young_caucasian_${gender}`), `mh_${id}_skin_young_caucasian`);
  out.faces[id] = facesOf(id, gender, fitted[id]);
  // Each face's skin: its main ethnicity's, at its age.
  out.faces[id].skins = [];
  for (const [, mix, age] of FACES) {
    const main = Object.entries(mix).sort((a, b) => b[1] - a[1])[0][0];
    out.faces[id].skins.push(await texture(skinFile(`${age}_${main}_${gender}`), `mh_${id}_skin_${age}_${main}`));
  }
}
out.textures.eyes = await eyeAtlas();

// Garments: each asset once (a body's list may share it with the other's).
const shared = {}, positions = {}, hides = {}, tucks = {}, wornBy = {};
for (const [body, slots] of Object.entries(WEAR)) for (const [slot, paths] of Object.entries(slots)) for (const path of paths) {
  const id = garmentId(path);
  if (!shared[id]) {
    const g = await fitGarment(path, slot, fitted);
    shared[id] = g.shared; positions[id] = g.positions; hides[id] = g.hides; tucks[id] = g.tucks;
  }
  (wornBy[body] ??= []).push(id);
}
delete out.garments;
out.sources = sources;   // where every asset comes from, with its author and licence

// ── Packing: arrays as base64 of typed arrays (positions in 0.1 mm, UVs over [−1, 2] in 16 bits,
// weights as four bone indices and bytes), decoded by the module when first used. ──
const BONES_USED = [...new Set([...Object.values(fitted).flatMap((f) => f.levels.flatMap((l) => l.w.flat().map(([b]) => b))), ...Object.values(shared).flatMap((g) => g.lods.flatMap((l) => l.w.flat().map(([b]) => b)))])].sort();
const boneIndex = new Map(BONES_USED.map((b, i) => [b, i]));
const b64 = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString("base64");
const P16 = (points) => b64(Int16Array.from(points.flat(), (x) => Math.round(x * 1e4)));
const F16 = (faces) => b64(Uint16Array.from(faces.flat()));
const UV16 = (fuv) => b64(Uint16Array.from(fuv.flat(2), (u) => Math.round(((Math.min(2, Math.max(-1, u)) + 1) / 3) * 65535)));
// Weights in bytes summing to 255 (largest remainders), so none vanishes and every vertex keeps one.
const W8 = (weights) => {
  const a = new Uint8Array(weights.length * 8);
  weights.forEach((list, i) => {
    const top = list.length ? list.slice(0, 4) : [["hips", 1]], sum = top.reduce((s, [, x]) => s + x, 0) || 1;
    const raw = top.map(([, x]) => (x / sum) * 255), bytes = raw.map(Math.floor);
    let left = 255 - bytes.reduce((s, x) => s + x, 0);
    raw.map((x, k) => [x - bytes[k], k]).sort((p, q) => q[0] - p[0]).forEach(([, k]) => { if (left > 0) { bytes[k]++; left--; } });
    top.forEach(([b], k) => { a[i * 8 + k * 2] = boneIndex.get(b); a[i * 8 + k * 2 + 1] = bytes[k]; });
  });
  return b64(a);
};
const I16 = (ints) => b64(Int16Array.from(ints));
const U16 = (ints) => b64(Uint16Array.from(ints));
const T32 = (list) => b64(Int32Array.from(list, (x, k) => (k % 4 ? Math.round(x * 1e4) : x)));
for (const shape of Object.values(out.shapes)) {
  shape.mesh = shape.mesh.map((l) => { const islands = [...new Set(l.fisland)]; return { p: P16(l.p), f: F16(l.f), fuv: UV16(l.fuv), w: W8(l.w), islands, fisland: U16(l.fisland.map((x) => islands.indexOf(x))) }; });
}
for (const faces of Object.values(out.faces)) {
  faces.lods = faces.lods.map((l) => ({ v: U16(l.v), heads: l.heads.map(I16), morphs: Object.fromEntries(Object.entries(l.morphs).map(([m, d]) => [m, I16(d)])) }));
}
const packed = Object.fromEntries(Object.entries(shared).map(([id, g]) => [id, { ...g, lods: g.lods.map((l) => ({ f: F16(l.f), fuv: UV16(l.fuv), w: W8(l.w) })) }]));
const packedPositions = Object.fromEntries(Object.entries(positions).map(([id, byBody]) => [id, Object.fromEntries(Object.entries(byBody).map(([b, lods]) => [b, lods.map((ints) => b64(Int16Array.from(ints)))]))]));
const packedHides = Object.fromEntries(Object.entries(hides).map(([id, byBody]) => [id, Object.fromEntries(Object.entries(byBody).map(([b, lods]) => [b, lods.map(U16)]))]));
const packedTucks = Object.fromEntries(Object.entries(tucks).map(([id, byBody]) => [id, Object.fromEntries(Object.entries(byBody).map(([b, lods]) => [b, lods.map(T32)]))]));

writeFileSync(OUT, `// People fitted from MakeHuman's CC0 assets (makehumancommunity.org) by scripts/character-makehuman.mjs:
// bodies, faces, garments and hair on our skeleton, textures in ./textures. Generated; do not edit.
// Arrays are packed (base64 of typed arrays) and decoded when first read; a garment's topology is
// shared by the bodies, its positions, hidden body faces and tucked skin are each body's.
const DATA = ${JSON.stringify(out)};
const GARMENTS = ${JSON.stringify(packed)};
const POSITIONS = ${JSON.stringify(packedPositions)};
const HIDES = ${JSON.stringify(packedHides)};
const TUCKS = ${JSON.stringify(packedTucks)};
const WORN = ${JSON.stringify(wornBy)};
const BONES = ${JSON.stringify(BONES_USED)};

const bytes = (s) => { const bin = atob(s), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out.buffer; };
const typed = (s, T) => new T(bytes(s));
const triples = (a, scale = 1) => { const out = []; for (let i = 0; i < a.length; i += 3) out.push([a[i] * scale, a[i + 1] * scale, a[i + 2] * scale]); return out; };
const points = (s) => triples(typed(s, Int16Array), 1e-4);
const faces = (s) => triples(Array.from(typed(s, Uint16Array)));
const cornerUVs = (s) => { const a = typed(s, Uint16Array), out = []; for (let i = 0; i < a.length; i += 6) { const c = []; for (let k = 0; k < 6; k += 2) c.push([(a[i + k] / 65535) * 3 - 1, (a[i + k + 1] / 65535) * 3 - 1]); out.push(c); } return out; };
const weights = (s) => { const a = typed(s, Uint8Array), out = []; for (let i = 0; i < a.length; i += 8) { const w = []; for (let k = 0; k < 8; k += 2) if (a[i + k + 1]) w.push([BONES[a[i + k]], a[i + k + 1] / 255]); out.push(w); } return out; };
const list16 = (s) => Array.from(typed(s, Uint16Array));
const tucks = (s) => Array.from(typed(s, Int32Array), (x, k) => (k % 4 ? x * 1e-4 : x));
/** Defines obj[key] as make()'s value, made when first read. */
const lazy = (obj, key, make) => Object.defineProperty(obj, key, { configurable: true, enumerable: true, get() { const value = make(); Object.defineProperty(obj, key, { value, enumerable: true }); return value; } });

for (const shape of Object.values(DATA.shapes)) {
  const packedLevels = shape.mesh;
  lazy(shape, "mesh", () => packedLevels.map((l) => { const isl = list16(l.fisland); return { p: points(l.p), f: faces(l.f), fuv: cornerUVs(l.fuv), w: weights(l.w), fisland: isl.map((k) => l.islands[k]) }; }));
}
for (const set of Object.values(DATA.faces)) {
  const packedLods = set.lods;
  lazy(set, "lods", () => packedLods.map((l) => ({ v: list16(l.v), heads: l.heads.map((h) => typed(h, Int16Array)), morphs: Object.fromEntries(Object.entries(l.morphs).map(([m, d]) => [m, typed(d, Int16Array)])) })));
}
const garments = {};
for (const [body, ids] of Object.entries(WORN)) {
  garments[body] = {};
  for (const id of ids) {
    const g = GARMENTS[id], garment = { ...g };
    delete garment.lods;
    lazy(garment, "mesh", () => g.lods.map((l, k) => ({ f: faces(l.f), fuv: cornerUVs(l.fuv), w: weights(l.w), p: points(POSITIONS[id][body][k]) })));
    lazy(garment, "hides", () => HIDES[id][body].map(list16));
    lazy(garment, "tucks", () => TUCKS[id][body].map(tucks));
    garments[body][id] = garment;
  }
}
export const MAKEHUMAN = { ...DATA, garments };
`);
console.log(`wrote ${OUT} (${(readFileSync(OUT).length / 1e6).toFixed(2)} MB)`);
