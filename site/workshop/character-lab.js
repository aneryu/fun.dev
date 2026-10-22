// The character workshop (docs/character-generator.md#lab): the procedural generator with a seed,
// its parameters by section, inspection views, test poses, clips, gait and a crowd. It runs on the
// repository's CC0 data; in local development it also offers the reference data set and its
// textures and clips from the dev server's /local/ (FUNDEV_LOCAL_ASSETS), never published.
import "./character-i18n.js";
import * as THREE from "/runtime/three.js";
import { OrbitControls } from "/runtime/addons/OrbitControls.js";
import { initLocale, onLocaleChange, t } from "../i18n.js";
import { applyTextures, characterObject, clipToThree, createWalker, DEFAULT_DATA, faceTint, FEATURES, generateCharacter, parametersFor, SLOTS } from "/runtime/kit/character.js";

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
const scene = new THREE.Scene();
scene.background = new THREE.Color("#ffd43b");
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 80);
camera.position.set(1.6, 1.3, 3.6);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.9, 0);
controls.update();
scene.add(new THREE.HemisphereLight("#fff7d6", "#5c5133", 1.6));
const sun = new THREE.DirectionalLight("#ffffff", 2.2);
sun.position.set(2, 4, 3);
scene.add(sun);
const floor = new THREE.Mesh(new THREE.CircleGeometry(0.9, 48), new THREE.MeshBasicMaterial({ color: "#211f17", transparent: true, opacity: 0.12 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
// A ground grid for gait, so feet that slide show against it.
const grid = new THREE.GridHelper(40, 80, "#9c3a12", "#c99a2e");
grid.visible = false;
scene.add(grid);

// ── Data sets: the repository's, and the reference set when the dev server serves one. ──
const sets = new Map([["cc0", DEFAULT_DATA]]);
const reference = await import("/local/character/index.js").then((m) => m.REFERENCE).catch(() => null);
if (reference) { sets.set("reference", reference); $("data").add(new Option(t("chDataReference"), "reference")); }
const local = reference !== null;   // its textures and clips come with it
const wanted = new URLSearchParams(location.search).get("data");

const state = { seed: "1", lod: 0, view: "textured", pose: "rest", params: {}, weightBone: "l_forearm", data: sets.has(wanted) ? wanted : local ? "reference" : "cc0" };
const data = () => sets.get(state.data);
let current = null, helper = null, parameters = [];

// ── The panel: the data set's parameters by section, labelled in the page's language. ──
const SLOT_IDS = new Set(SLOTS);
const FEATURE_IDS = new Set(FEATURES.map(([id]) => id));
const label = (id) => t(`p_${id}`) ?? id;
const optionLabel = (p, value) => (value === "none" ? t("chNone") : p.id === "eyes" ? t(`e_${value}`) ?? value : p.id === "body" ? t(`b_${value}`) ?? value
  : p.id === "face" || p.id === "face2" ? t(`f_${value}`) ?? value : value);

function control(p) {
  const input = p.options ? document.createElement("select") : Object.assign(document.createElement("input"), { type: "range", min: p.range[0], max: p.range[1], step: 0.01 });
  input.id = `p-${p.id}`;
  if (p.options) for (const o of p.options) input.add(new Option(optionLabel(p, o), o));
  input.addEventListener(p.options ? "change" : "input", () => {
    // Garments and faces are fitted per body: a new body starts from its own; a new garment from its own colour.
    if (p.id === "body") state.params = {};
    if (SLOT_IDS.has(p.id)) delete state.params[`${p.id}Colour`];
    state.params[p.id] = p.options ? input.value : Number(input.value);
    schedule();
  });
  return input;
}

function buildPanel() {
  parameters = parametersFor(data());
  const byId = new Map(parameters.map((p) => [p.id, p]));
  const look = $("look-fields"), features = $("feature-fields"), clothes = $("clothes-fields");
  look.replaceChildren(); features.replaceChildren(); clothes.replaceChildren();
  const field = (p, into, { slider = !p.options } = {}) => {
    const row = document.createElement("div");
    row.className = slider ? "field slider" : "field";
    const l = document.createElement("label");
    l.htmlFor = `p-${p.id}`;
    l.append(label(p.id));
    if (slider) l.append(Object.assign(document.createElement("output"), { id: `o-${p.id}` }));
    row.append(l, control(p));
    into.append(row);
  };
  for (const id of ["body", "eyes", "face", "face2", "faceMix"]) if (byId.has(id)) field(byId.get(id), look);
  for (const p of parameters) if (FEATURE_IDS.has(p.id)) field(p, features);
  $("features").hidden = !parameters.some((p) => FEATURE_IDS.has(p.id));
  // Clothes: a garment and its colour per slot, on one row.
  let anyGarment = false;
  for (const slot of SLOTS) {
    const p = byId.get(slot), colour = byId.get(`${slot}Colour`);
    if (!p || p.options.length < 2) continue;
    anyGarment = true;
    const row = document.createElement("div");
    row.className = "field";
    const l = document.createElement("label");
    l.htmlFor = `p-${slot}`; l.append(label(slot));
    const pair = document.createElement("div");
    pair.className = "pair";
    pair.append(control(p), control(colour));
    row.append(l, pair);
    clothes.append(row);
  }
  $("clothes-empty").hidden = anyGarment;
}

function syncPanel(semantic) {
  const garments = data().garments[semantic.body] ?? {};
  for (const p of parameters) {
    const input = $(`p-${p.id}`), value = semantic[p.id];
    if (!input) continue;
    if (p.options && SLOT_IDS.has(p.id)) for (const option of input.options) option.disabled = option.value !== "none" && !garments[option.value];
    if (p.id.endsWith("Colour")) {
      const colours = garments[semantic[p.id.slice(0, -"Colour".length)]]?.colours ?? [];
      for (const option of input.options) option.disabled = !colours.includes(option.value);
      input.disabled = !colours.length;
    }
    if (document.activeElement !== input && value !== undefined) input.value = value;
    const out = $(`o-${p.id}`);
    if (out) out.value = Number(value ?? 0).toFixed(2);
  }
}

// ── Inspection views and local textures. ──
const ISLAND_COLORS = ["#f28c28", "#4ba3c7", "#064f67", "#9c3a12", "#5c5133", "#fff7d6", "#c99a2e", "#7fb36b", "#b07ab8", "#e06666", "#6fa8dc", "#93c47d", "#ffd966"];
const checker = (() => {
  const size = 256, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) pixels.set(((x >> 4) + (y >> 4)) & 1 ? [33, 31, 23, 255] : [255, 247, 214, 255], (y * size + x) * 4);
  const tex = new THREE.DataTexture(pixels, size, size);
  tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true; tex.magFilter = THREE.NearestFilter;
  return tex;
})();
// The reference set's textures: /local/tex/<body>/<island>_diff.png and _normal.png (a garment's
// island is its id, its colour a letter; a head is its face's).
const textures = new Map();
function texture(url, colorSpace) {
  if (!textures.has(url)) textures.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.blob(); })
    .then((blob) => createImageBitmap(blob, { imageOrientation: "none" }))
    .then((bitmap) => { const tex = new THREE.Texture(bitmap); tex.flipY = false; tex.colorSpace = colorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 4; tex.needsUpdate = true; return tex; }));
  return textures.get(url);
}
const SKIN = new Set(["upper", "lower", "feet"]);   // the reference body's own skin, tinted to its face

function applyView(object, character) {
  const set = data(), { semantic } = character, garments = set.garments[semantic.body] ?? {};
  object.material.forEach((m, i) => {
    m.userData.colour ??= m.color.clone();   // the kit's colour for the island
    m.map = null; m.normalMap = null; m.alphaTest = 0; m.vertexColors = false; m.wireframe = $("wire").checked;
    m.color.copy(m.userData.colour);
    if (state.view === "islands") m.color.set(ISLAND_COLORS[i % ISLAND_COLORS.length]);
    if (state.view === "clay") m.color.set("#e9dcc4");
    if (state.view === "checker") { m.map = checker; m.color.set("#ffffff"); }
    if (state.view === "weights") { m.vertexColors = true; m.color.set("#ffffff"); }
    m.needsUpdate = true;
  });
  if (state.view === "weights") {
    const bone = character.skeleton.bones.findIndex((b) => b.id === state.weightBone);
    const { joints, weights } = character.mesh, n = weights.length / 4;
    const colors = new Float32Array(n * 3), hot = new THREE.Color("#9c3a12"), cold = new THREE.Color("#fff7d6"), c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (joints[i * 4 + k] === bone) w += weights[i * 4 + k];
      c.copy(cold).lerp(hot, w).toArray(colors, i * 3);
    }
    object.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }
  if (state.view !== "textured") return;
  // A repository set names its own textures; the reference set's are in /local/tex/.
  if (state.data !== "reference") { applyTextures(THREE, object, character, set, texture).catch((error) => showError(error.message)); return; }
  const body = semantic.body, tint = faceTint(body, semantic, set.faces);
  const head = semantic.face === undefined ? "head" : `head_${semantic.faceMix < 0.5 ? semantic.face : semantic.face2}`;
  character.mesh.groups.forEach((g, i) => {
    const m = object.material[i], garment = garments[g.island], colour = garment && semantic[`${garment.slot}Colour`];
    if (SKIN.has(g.island)) m.color.setRGB(...tint, THREE.SRGBColorSpace); else m.color.set("#ffffff");
    const name = g.island === "head" ? head : g.island, diffuse = colour && colour !== "none" ? `${name}_${colour}` : name;
    // A normal map is optional (the eyes have none).
    Promise.all([texture(`/local/tex/${body}/${diffuse}_diff.png`, THREE.SRGBColorSpace), texture(`/local/tex/${body}/${name}_normal.png`, THREE.NoColorSpace).catch(() => null)])
      .then(([diff, normal]) => {
        m.map = diff; m.normalMap = normal; m.normalScale.set(1, -1);
        if (garment?.slot === "hair") m.alphaTest = 0.5;
        m.needsUpdate = true;
      })
      .catch(() => showError(t("chTextureError")));
  });
}

// ── Poses, clips and gait. ──
// Test poses: rotations in each bone's own frame (+X flexes; Y twists and Z abducts, by side).
const POSES = {
  rest: {},
  flex: { spine1: [0.15, 0, 0], spine2: [0.15, 0, 0], neck: [0.2, 0, 0], l_upperarm: [0.6, 0, 0], l_forearm: [1.4, 0, 0], l_hand: [0.6, 0, 0],
    l_thigh: [0.9, 0, 0], l_calf: [1.3, 0, 0], l_foot: [0.3, 0, 0], l_finger10: [0.8, 0, 0], l_finger11: [0.8, 0, 0], l_finger20: [0.8, 0, 0], l_finger21: [0.8, 0, 0] },
  reach: { l_clavicle: [0, 0, 0.3], l_upperarm: [0, 0, 1.2], l_forearm: [0.3, 0, 0], l_thigh: [0, 0, 0.5], spine2: [0, 0.3, 0] },
  twist: { l_forearm: [0, 1.2, 0], l_hand: [0, 0.6, 0], head: [0, 0.7, 0], spine2: [0, 0.4, 0], spine3: [0, 0.3, 0] },
};
// Clips: the repository's role clips (CC0, scripts/character-clips.mjs), "cc0:<id>"; with the
// reference set, its own clips by bone, "ref:<name>" (/local/anim/<body>/<name>.json); on other
// sets, when served locally, the reference clips by role, "refrole:<name>" (/local/anim/roles/).
const fetched = new Map();
const fetchJSON = (url) => { if (!fetched.has(url)) fetched.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); })); return fetched.get(url); };
const roleIndex = fetchJSON("/runtime/kit/character/clips/index.json").catch(() => ({}));
const localIndex = local ? fetchJSON("/local/anim/index.json").catch(() => ({})) : Promise.resolve({});
const localRoles = local ? fetchJSON("/local/anim/roles/index.json").catch(() => ({})) : Promise.resolve({});
const clipFor = (character, pose) => {
  const [kind, name] = pose.split(":"), body = character.semantic.body;
  if (kind === "ref") return fetchJSON(`/local/anim/${body}/${name}.json`);
  if (kind === "refrole") return fetchJSON(`/local/anim/roles/${body}/${name}.json`);
  return fetchJSON(`/runtime/kit/character/clips/${name}.json`);
};
async function listClips() {
  const select = $("pose");
  for (const option of [...select.options]) if (option.value.includes(":") || option.value === "gaitref") option.remove();
  const roles = await roleIndex, refs = await localIndex, refRoles = await localRoles;
  const refNames = (index) => [...new Set(Object.values(index).flat())];
  if (state.data !== "reference" && refNames(refRoles).length) select.add(new Option(t("chPoseGaitRef"), "gaitref"));
  for (const id of Object.keys(roles)) select.add(new Option(`${t("chClipCC0")} · ${id}`, `cc0:${id}`));
  if (state.data === "reference") for (const name of refNames(refs)) select.add(new Option(`${t("chClipLocal")} · ${name}`, `ref:${name}`));
  else for (const name of refNames(refRoles)) select.add(new Option(`${t("chClipLocal")} · ${name}`, `refrole:${name}`));
  if (![...select.options].some((o) => o.value === state.pose)) state.pose = "rest";
  select.value = state.pose;
}

const mixers = new Map(), walkers = new Map();   // object → its AnimationMixer / { walker, angle, radius, scale }
const clock = new THREE.Clock();
function playClip(object, character, pose, phase) {
  clipFor(character, pose).then((clip) => {
    if (!object.parent) return;   // replaced meanwhile
    const mixer = new THREE.AnimationMixer(object), three = clipToThree(THREE, character, clip);
    mixers.set(object, mixer);
    const action = mixer.clipAction(three);
    action.setLoop(three.userData.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = true;
    action.time = phase * three.duration;
    action.play();
  }).catch((error) => showError(error.message));
}
// Gait round a circle (crowd members a little faster or slower, on wider circles): the reference
// set's own locomotion clips, else the repository's, or ("gaitref") the reference clips by role.
const GAIT = { reference: ["ref:idle", "ref:walk", "ref:run", "ref:sprint"], cc0: ["cc0:idle", "cc0:walk", "cc0:jog", "cc0:sprint"],
  gaitref: ["refrole:idle", "refrole:walk", "refrole:run", "refrole:sprint"] };
const isGait = (pose) => pose === "gait" || pose === "gaitref";
async function startGait(object, character, k) {
  const clips = await Promise.all(GAIT[state.pose === "gaitref" ? "gaitref" : state.data].map((pose) => clipFor(character, pose)));
  if (!object.parent) return;
  const radius = 3 + (k % 4) * 0.9;
  walkers.set(object, { walker: createWalker(THREE, object, character, clips), radius, scale: 1 + ((k * 0.37) % 1 - 0.5) * 0.3 });
  object.position.set(0, 0, 0);
  object.rotation.y = k * 0.9;
}
function stepWalkers(dt) {
  const speed = Number($("speed").value);
  grid.visible = walkers.size > 0;
  for (const [object, w] of walkers) {
    const v = speed * w.scale, before = object.position.clone();
    w.walker.update(dt, { speed: v, turn: v / w.radius });
    // The camera follows the current character.
    if (object === current?.object) { const d = object.position.clone().sub(before); camera.position.add(d); controls.target.add(d); }
  }
}

function applyPose(object, character = current.character, phase = 0, k = 0) {
  mixers.get(object)?.stopAllAction();
  mixers.delete(object);
  walkers.delete(object);
  $("gait-row").hidden = $("plant-row").hidden = !isGait(state.pose);
  if (isGait(state.pose)) { startGait(object, character, k); return; }
  if (state.pose.includes(":")) { playClip(object, character, state.pose, phase); return; }
  const bones = object.skeleton.bones, pose = POSES[state.pose];
  bones.forEach((bone, i) => bone.quaternion.copy(object.userData.rest[i]));
  const e = new THREE.Euler(), q = new THREE.Quaternion();
  for (const [id, [x, y, z]] of Object.entries(pose)) {
    for (const [name, side] of id.startsWith("l_") ? [[id, 1], [id.replace(/^l_/, "r_"), -1]] : [[id, 1]]) {
      const bone = bones.find((b) => b.name === name);
      if (bone) bone.quaternion.multiply(q.setFromEuler(e.set(x, y * side, z * side, "XYZ")));
    }
  }
}

// ── Building characters. ──
const seedValue = (s) => (/^\d+$/.test(s) ? Number(s) : s);
function make(seed, params = {}) {
  const character = generateCharacter({ seed, lod: state.lod, params, data: data() });
  const object = characterObject(THREE, character, { data: data() });
  return { character, object };
}
function dispose(object) { scene.remove(object); mixers.delete(object); walkers.delete(object); object.geometry.dispose(); object.material.forEach((m) => m.dispose()); }

// The crowd: CROWD more characters from the seeds after the current one, on a grid behind it.
const CROWD = 23, crowd = [];
function buildCrowd(seed) {
  for (const { object } of crowd.splice(0)) dispose(object);
  if (!$("crowd").checked) return 0;
  let triangles = 0;
  for (let k = 1; k <= CROWD; k++) {
    const { character, object } = make(typeof seed === "number" ? seed + k : `${seed}-${k}`);
    object.position.set(((k % 6) - 2.5) * 0.9, 0, -Math.floor(k / 6) * 1.1);
    scene.add(object);
    applyView(object, character);
    crowd.push({ object, character });
    applyPose(object, character, (k * 0.37) % 1, k);
    triangles += character.mesh.indices.length / 3;
  }
  return triangles;
}

let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; rebuild(); });
}
function showError(message) { $("error").textContent = message; $("error").hidden = false; }
let lastStats = null;
function showStats() { if (lastStats) $("stats").textContent = t("chStats", lastStats); }

function rebuild() {
  const seed = seedValue(state.seed);
  try {
    const t0 = performance.now();
    const { character, object } = make(seed, state.params);
    const ms = performance.now() - t0;
    if (current) dispose(current.object);
    if (helper) { scene.remove(helper); helper = null; }
    scene.add(object);
    // Keep the camera's height and distance in proportion to the character.
    const tall = character.stature, before = current?.character.stature ?? 1.75;
    if (Math.abs(tall - before) > 1e-6 || !current) {
      camera.position.sub(controls.target).multiplyScalar(tall / before).add(controls.target.set(0, 0.52 * tall, 0));
      controls.update();
    }
    current = { object, character };
    $("error").hidden = true;
    applyView(object, character);
    applyPose(object);
    if ($("crowd").checked) object.position.set(-2.25, 0, 0);   // the grid's first place
    if ($("bones").checked) { helper = new THREE.SkeletonHelper(object); scene.add(helper); }
    syncPanel(character.semantic);
    const others = buildCrowd(seed), m = character.mesh;
    lastStats = { triangles: m.indices.length / 3, bones: character.skeleton.bones.length, ms: ms.toFixed(1), height: character.stature.toFixed(2), crowd: others ? others + m.indices.length / 3 : 0 };
    showStats();
    $("measurements").textContent = JSON.stringify({ data: character.data, seed: character.seed, ...character.semantic }, null, 1);
    if (!$("weight-bone").options.length) for (const b of character.skeleton.bones) $("weight-bone").add(new Option(b.id, b.id, b.id === state.weightBone, b.id === state.weightBone));
  } catch (error) {
    showError(String(error.message ?? error));
    console.error(error);
  }
}

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas.parentElement;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}

// ── Wiring. ──
$("data").value = state.data;
$("view").value = state.view;
$("data-note").hidden = !local;
$("data").addEventListener("change", (e) => { state.data = e.target.value; state.params = {}; buildPanel(); listClips().then(schedule); });
$("seed").addEventListener("input", (e) => { state.seed = e.target.value.trim() || "1"; state.params = {}; schedule(); });
$("reroll").addEventListener("click", () => { state.seed = String(Math.floor(Math.random() * 1e6)); state.params = {}; $("seed").value = state.seed; schedule(); });
$("lod").addEventListener("change", (e) => { state.lod = Number(e.target.value); schedule(); });
$("view").addEventListener("change", (e) => { state.view = e.target.value; $("weight-row").hidden = state.view !== "weights"; schedule(); });
$("weight-bone").addEventListener("change", (e) => { state.weightBone = e.target.value; schedule(); });
$("pose").addEventListener("change", (e) => {
  state.pose = e.target.value;
  if (current) { applyPose(current.object); if ($("crowd").checked) current.object.position.set(-2.25, 0, 0); }
  crowd.forEach(({ object, character }, k) => { if (!isGait(state.pose)) object.position.set((((k + 1) % 6) - 2.5) * 0.9, 0, -Math.floor((k + 1) / 6) * 1.1); applyPose(object, character, ((k + 1) * 0.37) % 1, k + 1); });
});
$("speed").addEventListener("input", (e) => { $("speed-out").value = `${Number(e.target.value).toFixed(1)} m/s`; });
for (const id of ["crowd", "wire", "bones"]) $(id).addEventListener("change", schedule);
onLocaleChange(() => { buildPanel(); if (current) syncPanel(current.character.semantic); listClips(); showStats(); });
initLocale();
buildPanel();
new ResizeObserver(resize).observe(canvas.parentElement);
await renderer.init();
resize();
await listClips();
rebuild();
// For page checks and agents: the scene, camera, state and the current character.
globalThis.characterLab = { scene, camera, controls, state, rebuild, applyPose: () => current && applyPose(current.object), current: () => current, mixers, walkers, sets };
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.1, clock.getDelta());
  for (const m of mixers.values()) m.update(dt);
  stepWalkers(dt);
  controls.update();
  renderer.render(scene, camera);
});
