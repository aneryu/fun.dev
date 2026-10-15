import { ACCENT, createHud } from "./hud.js";
import { createChantVoice, createKnockAudio } from "./sound.js";
import { createZen } from "./zen.js";
import { createAltar } from "./altar.js";
import { createEffects } from "./effects.js";
import { createRelics } from "./relics.js";
import * as economy from "./economy.js";
import { lots, lotTitle } from "./lots.js";
import { floats } from "./floats.js";

// Rendered by the platform's options panel; values arrive through context.options. Relics are
// switched on and off in the game's own 法物 panel, not here.
export const options = [
  { id: "rings", section: "settings", type: "toggle", default: true, label: { zh: "显示声波环", en: "Show sound rings" } },
  { id: "merit-1000", section: "cheats", type: "action", label: { zh: "功德 +1000", en: "Merit +1000" } },
  { id: "all-items", section: "cheats", type: "action", label: { zh: "结缘全部法物", en: "Collect every relic" } },
  { id: "all-skins", section: "cheats", type: "action", label: { zh: "解锁全部皮肤", en: "Unlock every skin" } },
  { id: "auto-strike", section: "cheats", audience: "debug", type: "toggle", label: { zh: "自动敲击（稳定节奏）", en: "Auto strike (steady beat)" } },
  { id: "drop-now", section: "cheats", audience: "debug", type: "action", label: { zh: "立即结缘一次", en: "Drop something now" } },
  { id: "lot-now", section: "cheats", audience: "debug", type: "action", label: { zh: "立即求签", en: "Draw a lot now" } },
];

export async function createGame(context) {
  const { THREE, scene, setCamera, canvas, viewport, track, signal, onCleanup, reducedMotion } = context;
  const progress = context.progress?.version === 1 ? context.progress : null;
  context.reportLoading(0.1);
  const saved = progress ? await progress.load() : { kind: "empty" };
  signal.throwIfAborted();
  if (saved.kind === "unavailable") throw new Error("Progress is unavailable. Retry or start a separate save.");
  // Throws on an unsupported save, which the player keeps untouched and exportable.
  const state = saved.kind === "saved" ? economy.deserialize(saved.snapshot) : economy.createState();
  const copy = {
    zh: {
      merit: "功德", zen: (value) => `入禅 ×${value}`, collection: (count) => `结缘 ${count}/12`,
      strike: "敲木鱼积功德。连敲三下开始念经；节奏稳定就会入禅，功德随之加倍。念经时偶尔会结缘法物，摆在木鱼前，可以拖动。每天第一次入定会求得一支签",
      keys: "空格或回车敲击，E 打开法物面板，面板里方向键选择、回车启用停用、换上皮肤或打开签、S 切换法物、皮肤和签谱，C 查看已结缘的法物",
      panel: (count) => `法物 ${count}/12`, unknown: "？", missing: "尚未结缘", turnedOn: (name) => `${name} 已启用`, turnedOff: (name) => `${name} 已停用`,
      panelButton: "法物", skins: "皮肤", lots: (count) => `签谱 ${count}/60`, lotMissing: "尚未求得", gloss: (text) => `解曰：${text}`,
      lotShare: (title, gloss) => `今日${title}，解曰：${gloss}`, part: { fish: "木鱼", cushion: "坐垫" }, needs: (value) => `累计功德 ${value} 解锁`, unlocked: (name) => `解锁皮肤：${name}`, unavailable: "声音不可用", noSave: "当前容器不支持存档",
      share: (value, count) => `我在 fun.dev 敲木鱼，功德 ${value}，结缘 ${count}/12`, cheats: "（开了秘籍）",
      found: (name) => `结缘 · ${name}`, gotLuck: (name, seconds) => `${name}降临，${seconds} 秒`,
      enter: "入定",
    },
    en: {
      merit: "MERIT", zen: (value) => `Zen ×${value}`, collection: (count) => `Relics ${count}/12`,
      strike: "Strike the wooden fish to earn merit. After three knocks it chants; a steady beat deepens zen, which multiplies merit. While chanting, strikes sometimes bring a relic that sits in front of the fish and can be dragged. The first samadhi of each day draws a fortune lot",
      keys: "Space or Enter to strike, E opens the relic panel, where arrow keys select, Enter switches a relic, wears a skin or opens a lot and S switches between relics, skins and lots, C reads the collected relics",
      panel: (count) => `Relics ${count}/12`, unknown: "?", missing: "Not found yet", turnedOn: (name) => `${name} on`, turnedOff: (name) => `${name} off`,
      panelButton: "Relics", skins: "Skins", lots: (count) => `Lots ${count}/60`, lotMissing: "Not drawn yet", gloss: (text) => text,
      lotShare: (title, gloss) => `Today: ${title}. ${gloss}`, part: { fish: "Fish", cushion: "Cushion" }, needs: (value) => `Unlocks at ${value} merit`, unlocked: (name) => `New skin: ${name}`, unavailable: "Sound unavailable", noSave: "This host does not support saving",
      share: (value, count) => `I've earned ${value} merit and ${count}/12 relics on Wooden Fish at fun.dev`, cheats: " (with cheats)",
      found: (name) => `New relic: ${name}`, gotLuck: (name, seconds) => `${name} for ${seconds}s`,
      enter: "Samadhi",
    },
  };
  const locale = () => context.locale === "zh" ? "zh" : "en";
  let words = copy[locale()];
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
  camera.position.set(0, 2.2, 8);
  camera.lookAt(0, 0, 0);
  setCamera(camera);
  scene.background = new THREE.Color(0xffd43b);
  scene.add(new THREE.HemisphereLight(0xfffaf0, 0x8a7053, 0.8));
  // A generated studio (warm walls, two softboxes) gives the lacquer soft reflections without an HDR file.
  const studio = new THREE.Scene();
  const studioParts = [
    new THREE.Mesh(new THREE.BoxGeometry(12, 8, 12), new THREE.MeshBasicMaterial({ color: 0x8a6a45, side: THREE.BackSide })),
    new THREE.Mesh(new THREE.PlaneGeometry(6, 3), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff4e0).multiplyScalar(6), side: THREE.DoubleSide })),
    new THREE.Mesh(new THREE.PlaneGeometry(3, 5), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd43b).multiplyScalar(2.5), side: THREE.DoubleSide })),
  ];
  studioParts[1].position.set(-1.5, 3.9, 1.5);
  studioParts[1].rotation.x = Math.PI / 2;
  studioParts[2].position.set(5.9, 0.5, 0);
  studioParts[2].rotation.y = Math.PI / 2;
  studio.add(...studioParts);
  const pmrem = new THREE.PMREMGenerator(context.renderer);
  scene.environment = track(pmrem.fromScene(studio, 0.04)).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
  for (const part of studioParts) { part.geometry.dispose(); part.material.dispose(); }
  const keyLight = new THREE.DirectionalLight(0xfffaf2, 2.2);
  keyLight.position.set(-3, 6, 4);
  scene.add(keyLight);
  // Soft shadows from the key light: fish, cushion and mallet shade the floor and each other.
  // The renderer is shared with the host, so its shadow settings are restored at teardown.
  const { shadowMap } = context.renderer;
  const previousShadows = { enabled: shadowMap.enabled, type: shadowMap.type };
  shadowMap.enabled = true;
  shadowMap.type = THREE.PCFShadowMap;
  onCleanup(() => Object.assign(shadowMap, previousShadows));
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.radius = 6;
  keyLight.shadow.bias = -0.0005;
  keyLight.shadow.normalBias = 0.03;
  Object.assign(keyLight.shadow.camera, { left: -3.5, right: 3.5, top: 3.5, bottom: -3.5, near: 1, far: 16 });
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.7);
  fillLight.position.set(3, 2, -4);
  scene.add(fillLight);

  const fish = new THREE.Group();
  scene.add(fish);
  // Warm gold from inside the carving, 0 at rest and rising with zen.
  const woodGlowUniforms = { woodGlow: { value: 0 }, woodGlowColor: { value: new THREE.Color(0xffa63d) } };
  const shellMaterial = track(new THREE.MeshPhysicalMaterial({ color: 0x9c5626, metalness: 0, roughness: 0.55, clearcoat: 0.2, clearcoatRoughness: 0.4, envMapIntensity: 0.6 }));
  // The model has no UVs, so the grain is procedural in model space: dense streaks that stay
  // horizontal on every side, like teak. Streak noise is stretched across the horizontal plane;
  // the finest fibres fade out once they get thinner than a pixel, to avoid moiré on phones.
  shellMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
varying vec3 vWoodPosition;
varying float vWoodOcclusion;
varying float vWoodGlow;
#ifdef WOOD_OCCLUSION
attribute vec4 color;
#endif`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
vWoodPosition = position;
#ifdef WOOD_OCCLUSION
// Open surfaces stay unshaded; grooves (red: baked AO) darken, and the recessed slit
// (green: depth below the convex hull) goes nearly black inside.
vWoodOcclusion = mix(0.35, 1.0, smoothstep(0.05, 0.6, color.r)) * mix(0.12, 1.0, smoothstep(0.45, 0.75, color.g));
// Zen lights the carving from within: the slit most, the grooves a little.
vWoodGlow = min(1.0, 0.8 * (1.0 - smoothstep(0.1, 0.7, color.r)) + (1.0 - smoothstep(0.4, 0.75, color.g)));
#else
vWoodOcclusion = 1.0;
vWoodGlow = 0.0;
#endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vWoodPosition;
varying float vWoodOcclusion;
varying float vWoodGlow;
uniform float woodGlow;
uniform vec3 woodGlowColor;
float woodHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float woodNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(woodHash(i), woodHash(i + vec3(1, 0, 0)), f.x), mix(woodHash(i + vec3(0, 1, 0)), woodHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(woodHash(i + vec3(0, 0, 1)), woodHash(i + vec3(1, 0, 1)), f.x), mix(woodHash(i + vec3(0, 1, 1)), woodHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
vec3 wp = vWoodPosition;
float y = wp.y + 0.025 * woodNoise(wp * vec3(3.0, 3.0, 1.5));
float bands = smoothstep(0.2, 0.8, woodNoise(vec3(wp.x * 3.0, y * 60.0, wp.z * 3.0)));
float fibres = woodNoise(vec3(wp.x * 14.0, y * 220.0, wp.z * 14.0));
fibres = mix(fibres, 0.5, smoothstep(0.4, 0.9, fwidth(y * 220.0)));
float tone = woodNoise(wp * 3.0);
diffuseColor.rgb *= mix(0.6, 1.15, 0.45 * bands + 0.4 * fibres + 0.15 * tone) * vWoodOcclusion;`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
totalEmissiveRadiance += woodGlowColor * woodGlow * vWoodGlow;`);
    shader.uniforms.woodGlow = woodGlowUniforms.woodGlow;
    shader.uniforms.woodGlowColor = woodGlowUniforms.woodGlowColor;
  };
  shellMaterial.customProgramCacheKey = () => "wooden-fish-grain";
  // Only the fish carries baked occlusion (its vertex colors); the mallet shares the wood without it.
  const malletMaterial = track(shellMaterial.clone());
  malletMaterial.onBeforeCompile = shellMaterial.onBeforeCompile;
  malletMaterial.customProgramCacheKey = shellMaterial.customProgramCacheKey;
  shellMaterial.defines = { WOOD_OCCLUSION: "" };
  const { createAssets } = await context.runtime("kit/assets.js");
  const assets = createAssets(context);
  // Both are Draco GLBs. The relics' models (altar.js clones them when collected) start loading
  // now, but only a save with relics waits for them before the first frame.
  const relicLibrary = assets.gltf("assets/relics.glb");
  relicLibrary.catch(() => {}); // a failure is reported where it is awaited
  const model = (await assets.gltf("assets/wooden-fish.glb")).scene;
  // Untextured meshes; materials are assigned here.
  const body = model.getObjectByName("Fish");
  const malletHead = model.getObjectByName("MalletHead");
  const malletHandle = model.getObjectByName("MalletHandle");
  // Red brocade: a row of gold five-petal flowers in scalloped frames around the cushion's wall,
  // small flowers between them along both edges, and a fine weave. Cylindrical coordinates
  // about the cushion's own axis stand in for the missing UVs.
  const cushion = model.getObjectByName("Cushion");
  cushion.geometry.computeBoundingBox();
  const cushionBox = cushion.geometry.boundingBox;
  const cushionMotifs = 20;
  // Treated as a torus: arc length around the tube's cross-section keeps motifs undistorted on the rounded wall.
  const cushionRadius = ((cushionBox.max.x - cushionBox.min.x) + (cushionBox.max.z - cushionBox.min.z)) / 4;
  const cushionTube = (cushionBox.max.y - cushionBox.min.y) / 2;
  const cushionUniforms = {
    cushionCenter: { value: cushionBox.getCenter(new THREE.Vector3()) },
    cushionTube: { value: new THREE.Vector2(cushionRadius - cushionTube, cushionTube) },
    cushionCell: { value: 2 * Math.PI * cushionRadius / cushionMotifs },
    cushionGold: { value: new THREE.Color(0xc99a45) },
    cushionMotif: { value: 1 }, // 0: plain cloth, 1: the brocade's flowers
    cushionWeave: { value: 0.07 }, // how strongly the weave shows
  };
  const cushionMaterial = track(new THREE.MeshStandardMaterial({ color: 0x8a1a14, roughness: 0.9, envMapIntensity: 0.5 }));
  cushionMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, cushionUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCushionPosition;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCushionPosition = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vCushionPosition;
uniform vec3 cushionCenter;
uniform vec2 cushionTube;
uniform float cushionCell;
uniform vec3 cushionGold;
uniform float cushionMotif;
uniform float cushionWeave;
// Coverage of a line or disc edge at distance d, antialiased over one pixel.
float cushionInk(float d, float width) { float aa = fwidth(d); return 1.0 - smoothstep(width, width + aa, d); }
// Gold coverage of a five-petal flower of radius size at q, with red petal and centre lines.
float cushionFlower(vec2 q, float size) {
  float r = length(q);
  float petal = size * (0.55 + 0.45 * abs(cos(2.5 * atan(q.y, q.x))));
  float fill = cushionInk(r - petal, 0.0);
  float lines = max(cushionInk(abs(r - petal * 0.62), size * 0.05), cushionInk(abs(r - size * 0.22), size * 0.04));
  return fill * (1.0 - lines);
}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
vec3 cp = vCushionPosition - cushionCenter;
float around = atan(cp.z, cp.x) / 6.2831853 * ${cushionMotifs}.0;
// The camera sees the upper, outward-bulging side (tube angle about 0.6 rad), so the row is centred there.
float tubeAngle = atan(cp.y, length(cp.xz) - cushionTube.x);
float height = (tubeAngle - 0.6) * cushionTube.y / cushionCell;
vec2 q = vec2(fract(around) - 0.5, height);
float frame = cushionInk(abs(length(q) - 0.37 - 0.035 * cos(5.0 * atan(q.y, q.x))), 0.018);
float gold = max(frame * (1.0 - cushionInk(length(q) - 0.3, 0.0)), cushionFlower(q, 0.27));
gold = max(gold, cushionFlower(vec2(fract(around + 0.5) - 0.5, abs(height) - 0.42), 0.1));
float weaveScale = 70.0;
float weave = sin(around * weaveScale * 6.2831853 / ${cushionMotifs}.0 * 4.0) * sin(height * weaveScale);
weave *= 1.0 - smoothstep(0.3, 0.8, fwidth(height * weaveScale));
gold *= cushionMotif;
diffuseColor.rgb = mix(diffuseColor.rgb * (1.0 - cushionWeave + cushionWeave * weave), cushionGold, gold);`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.45, gold);")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.5, gold);");
  };
  cushionMaterial.customProgramCacheKey = () => "wooden-fish-brocade";
  cushion.material = cushionMaterial;
  body.material = shellMaterial;
  for (const mesh of [body, cushion, malletHead, malletHandle]) mesh.castShadow = mesh.receiveShadow = true;
  // The head has its own material so it can glow with zen while the handle stays plain.
  const malletHeadMaterial = track(malletMaterial.clone());
  malletHeadMaterial.onBeforeCompile = shellMaterial.onBeforeCompile;
  malletHeadMaterial.customProgramCacheKey = shellMaterial.customProgramCacheKey;
  malletHeadMaterial.emissive.setHex(0xffa63d);
  malletHeadMaterial.emissiveIntensity = 0;
  malletHead.material = malletHeadMaterial;
  malletHandle.material = malletMaterial;
  // The mallet lies along +Z in model space: grip at the far end, head at the near end.
  const handleBox = new THREE.Box3().setFromObject(malletHandle);
  const headBox = new THREE.Box3().setFromObject(malletHead);
  const grip = handleBox.getCenter(new THREE.Vector3()).setZ(handleBox.min.z);
  const headCenter = headBox.getCenter(new THREE.Vector3());
  const headRadius = (headBox.max.x - headBox.min.x) / 2;

  // Slit toward the viewer, cushion resting on the contact shadow.
  model.scale.setScalar(3.1);
  model.rotation.y = Math.PI * 0.75;
  fish.add(model);
  fish.updateMatrixWorld(true);
  const fishBox = new THREE.Box3().setFromObject(body);
  model.position.set(-(fishBox.min.x + fishBox.max.x) / 2, -1.04 - new THREE.Box3().setFromObject(model).min.y, -(fishBox.min.z + fishBox.max.z) / 2);
  fish.updateMatrixWorld(true);

  // A tiny, generated contact shadow anchors the carving without a shadow-map pass.
  const shadowPixels = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const radius = Math.hypot(x - 31.5, y - 31.5) / 32;
    const offset = (y * 64 + x) * 4;
    shadowPixels.set([40, 20, 5, Math.round(150 * Math.max(0, 1 - radius) ** 2)], offset);
  }
  const shadowTexture = track(new THREE.DataTexture(shadowPixels, 64, 64));
  shadowTexture.magFilter = THREE.LinearFilter;
  shadowTexture.minFilter = THREE.LinearFilter;
  shadowTexture.needsUpdate = true;
  const shadow = new THREE.Mesh(track(new THREE.PlaneGeometry(4.5, 3.5)), track(new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false })));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0.1, -1.04, 0);
  scene.add(shadow);
  // Cast shadows land on an otherwise invisible floor.
  const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(12, 12)), track(new THREE.ShadowMaterial({ color: 0x5a3a10, opacity: 0.3 })));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.04;
  floor.receiveShadow = true;
  scene.add(floor);

  // Pivot at the grip: the raised head swings down onto the crown, then rebounds.
  const mallet = new THREE.Group();
  mallet.position.set(2.15, 1.84, 0.55);
  // The highest point of the carving is where the head lands.
  const crown = new THREE.Vector3(0, -Infinity, 0);
  const vertex = new THREE.Vector3();
  const positions = body.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    vertex.fromBufferAttribute(positions, i).applyMatrix4(body.matrixWorld);
    if (vertex.y > crown.y) crown.copy(vertex);
  }
  // The slit's mouth: the centre of its deepest recess (the green vertex color, see
  // dev/clean-model.py), where the daily lot flies out.
  const mouth = new THREE.Vector3();
  const recess = body.geometry.attributes.color;
  let recessCount = 0;
  for (let i = 0; i < positions.count; i++) {
    if (recess.getY(i) > 0.3) continue;
    mouth.add(vertex.fromBufferAttribute(positions, i).applyMatrix4(body.matrixWorld));
    recessCount++;
  }
  if (recessCount) mouth.divideScalar(recessCount); else mouth.copy(crown);
  // Scale the mallet so its head center reaches the crown plus the head radius.
  const headDistance = headCenter.z - grip.z;
  let malletScale = crown.distanceTo(mallet.position) / headDistance;
  const contact = crown.clone().setY(crown.y + headRadius * malletScale).sub(mallet.position);
  malletScale = contact.length() / headDistance;
  // Re-axis the model mallet: grip at the pivot, shaft along +Y.
  const malletModel = new THREE.Group();
  malletModel.scale.setScalar(malletScale);
  malletModel.rotation.x = -Math.PI / 2;
  malletModel.position.copy(grip).applyEuler(malletModel.rotation).multiplyScalar(-malletScale);
  malletModel.add(malletHead, malletHandle);
  mallet.add(malletModel);
  const shaftAxis = new THREE.Vector3(0, 1, 0);
  const malletRest = new THREE.Quaternion().setFromUnitVectors(shaftAxis, new THREE.Vector3(-1.6, 0.75, -0.55).normalize());
  const malletContact = new THREE.Quaternion().setFromUnitVectors(shaftAxis, contact.normalize());
  mallet.quaternion.copy(malletRest);
  scene.add(mallet);


  // 每日一签: a bamboo stick with a red-lacquered end, shown while it flies out of the mouth.
  const stick = new THREE.Group();
  const stickBody = new THREE.Mesh(track(new THREE.CylinderGeometry(0.035, 0.03, 0.95, 10)), track(new THREE.MeshStandardMaterial({ color: 0xd8b26a, roughness: 0.6 })));
  const stickEnd = new THREE.Mesh(track(new THREE.CylinderGeometry(0.037, 0.037, 0.2, 10)), track(new THREE.MeshStandardMaterial({ color: 0xa3261b, roughness: 0.35 })));
  stickEnd.position.y = 0.38;
  stick.add(stickBody, stickEnd);
  stick.visible = false;
  scene.add(stick);

  // The contact shadow hugs the cushion's footprint.
  const footprint = new THREE.Box3().setFromObject(cushion);
  footprint.getCenter(shadow.position).setY(-1.035);
  shadow.scale.set((footprint.max.x - footprint.min.x) * 1.25 / 4.5, (footprint.max.z - footprint.min.z) * 1.25 / 3.5, 1);
  const woodColor = shellMaterial.color.getHex();
  // Skins: the fish's lacquer or metal (the wood grain shows through all of them), and the cushion's
  // cloth color, flower color, flowers on or off and weave strength.
  const fishLooks = {
    wood: { color: woodColor, metalness: 0, roughness: 0.55, clearcoat: 0.2 },
    lacquer: { color: 0xb3261b, metalness: 0, roughness: 0.25, clearcoat: 1 },
    rosewood: { color: 0x4a1f1a, metalness: 0, roughness: 0.45, clearcoat: 0.4 },
    bronze: { color: 0x5f7a5a, metalness: 0.75, roughness: 0.4, clearcoat: 0.1 },
    jade: { color: 0xe4ecd8, metalness: 0, roughness: 0.2, clearcoat: 1 },
    gold: { color: 0xc9a13b, metalness: 0.6, roughness: 0.3, clearcoat: 0.6 },
  };
  const cushionLooks = {
    red: { color: 0x8a1a14, motif: 0xc99a45, flowers: 1, weave: 0.07 },
    blue: { color: 0x1d3a5f, motif: 0xc99a45, flowers: 1, weave: 0.07 },
    linen: { color: 0x8a7f6e, motif: 0x8a7f6e, flowers: 0, weave: 0.14 },
    straw: { color: 0xc2a46a, motif: 0xc2a46a, flowers: 0, weave: 0.35 },
    lotus: { color: 0xe39aac, motif: 0xfff2f4, flowers: 1, weave: 0.05 },
    black: { color: 0x1f1c18, motif: 0xc99a45, flowers: 1, weave: 0.05 },
  };

  const kit = await context.runtime("kit/text.js");
  signal.throwIfAborted();
  context.reportLoading(0.8);
  const hud = createHud({ THREE, camera, scene, track, kit, reducedMotion });
  // The fish and its cushion, as a circle on the floor that relics stay out of.
  const footBox = new THREE.Box3().setFromObject(model);
  const fishSize = footBox.getSize(new THREE.Vector3());
  const fishCenter = footBox.getCenter(new THREE.Vector3());
  const fishRadius = Math.max(fishSize.x, fishSize.z) / 2;
  const altar = createAltar({ THREE, scene, reducedMotion, fish: { x: fishCenter.x, z: fishCenter.z, radius: fishRadius } });
  const effects = createEffects({ THREE, scene, camera, track, reducedMotion, center: new THREE.Vector3(crown.x, 0, crown.z) });
  const relics = createRelics({ THREE, scene, track, altar, createText: kit.createText, font: kit.systemFont, reducedMotion });

  let soundAvailable = true;
  const knock = createKnockAudio(context.audio, () => {
    if (signal.aborted) return;
    soundAvailable = false;
    labels();
  });
  onCleanup(() => knock.dispose());
  // The chant loads in the background: until it is ready (or if it fails) strikes only knock.
  const voice = context.audio ? createChantVoice(context.audio, signal) : null;
  let slices = null;
  const fetchAsset = async (path) => {
    const response = await fetch(context.asset(path), { signal });
    if (!response.ok) throw new Error(`Asset unavailable: ${path}`);
    return response;
  };
  if (voice) void fetchAsset("assets/chant.json").then((response) => response.json()).then((data) => {
    if (signal.aborted) return;
    return voice.load(fetchAsset("assets/chant.wav")).then(() => { slices = data.slices; });
  }).catch(() => { /* Optional: the knock and merit work without the chant. */ });

  const zen = createZen(() => economy.ZEN);
  // Seconds of play; strikes between frames read it through now().
  let clock = 0;
  let lastReal = null;
  const now = () => clock + (lastReal === null ? 0 : Math.min(1, performance.now() / 1000 - lastReal));

  let paused = false;
  // Saves are throttled on both edges: a change after a quiet spell saves at once, later ones within 5 s.
  let labelTimer = 0, autoTime = 0;
  let wakeTimer = null;
  let luck = null; // { id, until }
  let panelSelected = -1; // keyboard selection in the 法物 panel
  let drag = null; // { id, pointerId, x, y, moved }
  let focus = false;
  let infoIndex = -1;
  let bellTimer = 0; // distant temple bell during 入定
  let lotFlight = null; // { index, time } while the day's lot flies out of the fish
  let lotCard = null; // { index, fresh } while a lot card is open
  let lotOpenedAt = 0;
  let floatBag = []; // floats.js words, shuffled, drawn without repeats
  // Zen colors the whole scene: the yellow warms and deepens as zen grows, then eases back.
  const calmColor = scene.background.clone();
  const deepColor = new THREE.Color(0xe9a13a);
  let mood = 0;

  // The mallet is a damped spring between rest (0) and contact (1). A press kicks it down; at
  // contact it bounces and everything the strike earned is heard and seen at once. The wooden
  // fish itself stays rigid.
  const swing = { angle: 0, velocity: 0, queued: [] };

  // Every strike saves: a local write is cheap, and a tab closed right after a strike keeps it.
  function save() {
    if (progress) void progress.save(economy.serialize(state)).catch(() => { /* The player displays the save failure and retains an exportable snapshot. */ });
  }

  // Labels, announcements and share text keep exact merit below a million.
  const exact = (value, loc = locale()) => value < 1e6 ? String(Math.floor(value)) : economy.formatNumber(value, loc);
  const itemName = (item) => item.name[locale()] ?? item.name.en;
  const luckName = (id) => economy.lucks.find((entry) => entry.id === id).name[locale()];
  const activeLuck = () => (luck && clock < luck.until ? luck : null);
  const zenMultiplier = () => zen.multiplier(economy.ZEN.cap);

  function labels() {
    const parts = [words.strike, `${words.merit} ${exact(state.merit)}`, words.zen(Number(zenMultiplier().toFixed(2))), words.collection(economy.collectedCount(state)), ...(soundAvailable ? [] : [words.unavailable]), words.keys];
    if (!progress) parts.push(words.noSave);
    canvas.setAttribute("aria-label", parts.join(". "));
  }

  function refreshStatus() {
    hud.setStatus({ merit: `✦ ${economy.formatMerit(state.merit, locale())}`, gold: activeLuck()?.id === "fortune", panelButton: panelButton(), panelDot: freshSkin });
  }

  // A relic acts when it is collected and its display switch is on.
  const enabled = (id) => economy.has(state, id) && !state.relics[id]?.off;

  // Looks that follow the collection and the skins: the rosewood mallet, the fish's and the
  // cushion's skins, and the relic switches.
  function applyLooks() {
    for (const item of economy.items) altar.setActive(item.id, !state.relics[item.id]?.off);
    malletMaterial.color.setHex(enabled("rosewood") ? 0x4b1f1a : woodColor);
    malletHeadMaterial.color.copy(malletMaterial.color);
    const fishLook = fishLooks[state.skin.fish];
    shellMaterial.color.setHex(fishLook.color);
    Object.assign(shellMaterial, { metalness: fishLook.metalness, roughness: fishLook.roughness, clearcoat: fishLook.clearcoat });
    const cloth = cushionLooks[state.skin.cushion];
    cushionMaterial.color.setHex(cloth.color);
    cushionUniforms.cushionGold.value.setHex(cloth.motif);
    cushionUniforms.cushionMotif.value = cloth.flowers;
    cushionUniforms.cushionWeave.value = cloth.weave;
  }

  const crownPoint = () => new THREE.Vector3(crown.x, crown.y + 0.1, crown.z);
  // Sound rings: a knock is one thin ring, brighter and slower in deeper zen and gold under 福报;
  // bells ring slow and wide; luck sends three in a row.
  const ripple = (options) => { if (context.options.rings !== false) effects.ring(options); };
  const ripples = (count) => { for (let i = 0; i < count; i++) ripple({ delay: i * 0.16, duration: 0.7, to: 3.2, strength: 0.7 }); };
  const bellRing = () => ripple({ duration: 1.5, to: 4, strength: 0.5 });

  // Everything a strike earns is decided at the press; its sound and sight wait for contact.
  function strike() {
    if (paused || signal.aborted || hud.panelOpen || hud.cardOpen) return;
    const time = now();
    if (luck && time >= luck.until) luck = null;
    const beat = zen.strike(time);
    const before = state.merit;
    const result = economy.applyStrike(state, { zen: zenMultiplier(), luck: activeLuck(), interval: beat.interval, chanting: beat.syllable !== null });
    for (const skin of economy.newlyUnlocked(before, state.merit)) unlockedSkin(skin);
    if (beat.steadySentence) state.stats.sentences++;
    if (result.drop?.kind === "luck") luck = { id: result.drop.id, until: time + result.drop.seconds };
    swing.queued.push({ beat, result });
    if (reducedMotion) impact(1);
    else swing.velocity = Math.min(50, Math.max(swing.velocity, 0) + 36);
    save();
    labels();
    context.announce(`${words.merit} ${exact(state.merit)}`);
    context.invalidate();
  }

  function impact(strength) {
    const queued = swing.queued;
    swing.queued = [];
    if (!queued.length) return;
    const level = zen.level;
    const last = queued.at(-1).beat;
    const chanting = last.syllable !== null;
    if (soundAvailable) knock.strike({ zen: level, strength, soft: enabled("wrap"), deep: enabled("rosewood"), skin: state.skin.fish });
    // 录音机: the chant gets its voice, one syllable per strike.
    if (enabled("recorder") && chanting) {
      altar.hop("recorder");
      if (soundAvailable && slices) voice.say(slices[last.syllable], last.interval);
    }
    const fortune = activeLuck()?.id === "fortune";
    ripple({ duration: 0.4 + 0.3 * level, strength: 0.5 + 0.4 * level, color: fortune ? 0xf28c28 : 0xfff7d6 });
    context.haptics.vibrate("tap");
    hud.bump();
    // Now and then a word floats up from the fish, more often in deeper zen.
    if (Math.random() < 0.125 + 0.21 * level) floatWord(fortune);
    if (enabled("beads")) relics.bead();
    if (enabled("novice")) relics.nod();
    // 风铃: chimes answer a steady beat once zen has begun.
    if (enabled("chime") && last.steady && level > 0.3) { relics.chime(); if (soundAvailable) knock.chime(); }
    // 签筒: now and then a fortune stick pops out.
    if (enabled("sticks") && chanting && Math.random() < 0.04) relics.fortune();
    // Events speak through sound, rings and the scene; screen readers still hear them.
    for (const { beat, result } of queued) {
      // 铜磬: a steady phrase ends with the bowl.
      if (beat.steadySentence && enabled("bowl")) { if (soundAvailable) knock.bell("bowl", 0.2); bellRing(); }
      if (beat.samadhi) {
        context.announce(words.enter);
        // 每日一签: the day's first 入定 draws a lot.
        if (!economy.lotDrawnToday(state, economy.today()) && !lotFlight && !lotCard) drawLot();
        // 古钟: the bell tolls as samadhi begins.
        if (enabled("bell")) { if (soundAvailable) knock.bell("temple", 0.2); bellRing(); bellTimer = 8; }
      }
      if (result.drop) found(result.drop);
    }
    refreshStatus();
  }

  function found(drop) {
    if (drop.kind === "luck") {
      context.announce(words.gotLuck(luckName(drop.id), Math.round(drop.seconds)));
      if (soundAvailable) knock.bell("temple", 0.12);
      ripples(3);
      return;
    }
    const item = economy.items.find((entry) => entry.id === drop.id);
    context.announce(`${words.found(itemName(item))}. ${item.does[locale()]}`);
    if (soundAvailable) knock.bell("bowl", 0.14);
    altar.drop(drop.id, crownPoint());
    if (reducedMotion) landed();
    save();
  }

  function floatWord(fortune) {
    if (!floatBag.length) floatBag = [...floats[locale()]].sort(() => Math.random() - 0.5);
    const word = floatBag.pop();
    const at = crownPoint().project(camera);
    // Up and to the left of the crown, clear of the mallet on the right.
    hud.float(word, (at.x + 1) / 2 * viewport.width - 50, (1 - at.y) / 2 * viewport.height - 30, fortune ? ACCENT : "#211f17");
  }

  // 每日一签: the lot is drawn (and saved) at once; a stick flies out of the fish's mouth and
  // the card opens where it stops.
  function drawLot() {
    const index = economy.drawLot(state, economy.today());
    save();
    if (soundAvailable) knock.bell("bowl", 0.14);
    if (reducedMotion) { openLot(index, true); return; }
    lotFlight = { index, time: 0 };
    stick.visible = true;
  }
  function openLot(index, fresh) {
    lotFlight = null;
    stick.visible = false;
    lotCard = { index, fresh };
    lotOpenedAt = performance.now();
    const loc = locale();
    const entry = lots[index];
    const verse = loc === "zh" ? entry.zh : entry.en;
    let gloss = words.gloss(loc === "zh" ? entry.zhGloss : entry.enGloss);
    // A long 解曰 breaks after the comma nearest its middle, so no full stop is left on its own.
    if (loc === "zh" && [...gloss].length > 19) {
      const commas = [...gloss.matchAll(/[，：]/g)].map((match) => match.index).filter((index) => index > 3);
      const middle = gloss.length / 2;
      const at = commas.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0];
      if (at !== undefined) gloss = `${gloss.slice(0, at + 1)}\n${gloss.slice(at + 1)}`;
    }
    hud.setCard({ title: lotTitle(index, loc), verse, vertical: loc === "zh", gloss });
    context.announce(`${lotTitle(index, loc)}. ${verse.join(loc === "zh" ? "，" : " ")}. ${gloss.replace("\n", "")}`);
    context.invalidate();
  }
  // Putting the day's lot away brings 好运 for 30 s, whatever the lot said.
  function closeLot() {
    // A steady beat would put the card away at once: presses in its first moments are absorbed.
    if (performance.now() - lotOpenedAt < 1500) return;
    const fresh = lotCard?.fresh;
    lotCard = null;
    hud.setCard(null);
    zen.hold(now());
    if (fresh) {
      luck = { id: "chance", until: clock + economy.LUCK_TIME };
      context.announce(words.gotLuck(luckName("chance"), economy.LUCK_TIME));
      ripples(3);
    }
    refreshStatus();
    context.invalidate();
  }

  // A relic reached its place.
  function landed() {
    applyLooks();
    refreshPanel();
    save();
  }

  function showInfo(id) {
    const item = economy.items.find((entry) => entry.id === id);
    hud.info({ title: itemName(item), detail: item.does[locale()], on: enabled(id) });
    context.announce(`${itemName(item)}, ${item.does[locale()]}`);
    context.invalidate();
  }

  // 法物 panel: two tabs of twelve cells. 法物 switches relics on and off; 皮肤 wears a skin: the
  // first two rows are the fish's, the last two the cushion's.
  let panelOpen = false;
  let panelTab = "relics";
  let freshSkin = false; // a skin was unlocked since the 皮肤 tab was last seen
  const skinList = [...economy.skins.fish.map((skin) => ({ part: "fish", skin })), ...economy.skins.cushion.map((skin) => ({ part: "cushion", skin }))];
  const skinName = (skin) => skin.name[locale()] ?? skin.name.en;
  function panelModel() {
    const tabs = [
      { id: "relics", label: words.panel(economy.collectedCount(state)), selected: panelTab === "relics" },
      { id: "skins", label: words.skins, selected: panelTab === "skins" },
      { id: "lots", label: words.lots(state.lots.got.length), selected: panelTab === "lots" },
    ];
    // 签谱: sixty numbered cells; a drawn lot opens its card again.
    if (panelTab === "lots") {
      const got = (index) => state.lots.got.includes(index);
      return {
        tabs, selected: panelSelected, columns: 10, cellHeight: 34,
        detail: panelSelected < 0 ? "" : got(panelSelected) ? lotTitle(panelSelected, locale()) : `${words.lots(state.lots.got.length)} · ${words.lotMissing}`,
        cells: lots.map((_, index) => ({ id: `lot:${index}`, label: String(index + 1), state: got(index) ? "on" : "none" })),
      };
    }
    if (panelTab === "skins") {
      const chosen = skinList[panelSelected];
      return {
        tabs, selected: panelSelected, columns: 3, cellHeight: 50,
        detail: !chosen ? "" : economy.unlocked(state, chosen.skin) ? `${words.part[chosen.part]} · ${skinName(chosen.skin)}` : words.needs(exact(chosen.skin.at)),
        cells: skinList.map(({ part, skin }) => ({
          id: `${part}:${skin.id}`,
          label: economy.unlocked(state, skin) ? skinName(skin) : exact(skin.at),
          state: !economy.unlocked(state, skin) ? "none" : state.skin[part] === skin.id ? "on" : "off",
        })),
      };
    }
    const selected = economy.items[panelSelected];
    return {
      tabs, selected: panelSelected, columns: 3, cellHeight: 50,
      detail: !selected ? "" : economy.has(state, selected.id) ? selected.does[locale()] : words.missing,
      cells: economy.items.map((item) => ({
        id: item.id,
        label: economy.has(state, item.id) ? itemName(item) : words.unknown,
        state: !economy.has(state, item.id) ? "none" : enabled(item.id) ? "on" : "off",
      })),
    };
  }
  function refreshPanel() { if (panelOpen) hud.setPanel(panelModel()); }
  function toggle(id) {
    if (!economy.has(state, id)) return;
    const entry = { ...state.relics[id] };
    if (entry.off) delete entry.off; else entry.off = true;
    if (Object.keys(entry).length) state.relics[id] = entry; else delete state.relics[id];
    const item = economy.items.find((candidate) => candidate.id === id);
    context.announce(enabled(id) ? words.turnedOn(itemName(item)) : words.turnedOff(itemName(item)));
    applyLooks();
    save();
  }
  function wear(part, id) {
    const skin = economy.skins[part].find((entry) => entry.id === id);
    if (!skin || !economy.unlocked(state, skin)) return;
    state.skin[part] = id;
    context.announce(`${words.part[part]} · ${skinName(skin)}`);
    applyLooks();
    save();
  }
  // A strike crossed a skin's merit: a soft bell, and a dot on the panel button.
  function unlockedSkin(skin) {
    freshSkin = true;
    context.announce(words.unlocked(skinName(skin)));
    if (soundAvailable) knock.bell("bowl", 0.1);
  }
  const panelButton = () => (economy.collectedCount(state) || state.lots.got.length || state.merit >= Math.min(...skinList.slice(1).map(({ skin }) => skin.at)) ? words.panelButton : "");

  function setFocus(visible) {
    if (focus === visible) return;
    focus = visible;
    hud.setFocusVisible(visible);
  }

  function act(action) {
    if (action === "card") { closeLot(); return; }
    if (action === "panel") { panelOpen = true; if (panelSelected < 0) panelSelected = 0; if (freshSkin) panelTab = "skins"; }
    else if (action === "close") panelOpen = false;
    else if (action.startsWith("tab:")) { panelTab = action.slice(4); panelSelected = 0; }
    else if (action.startsWith("cell:")) {
      const id = action.slice(5);
      if (panelTab === "lots") {
        panelSelected = Number(id.slice(4));
        if (state.lots.got.includes(panelSelected)) openLot(panelSelected, false);
      } else if (panelTab === "skins") {
        const [part, skin] = id.split(":");
        panelSelected = skinList.findIndex((entry) => entry.part === part && entry.skin.id === skin);
        wear(part, skin);
      } else {
        panelSelected = economy.items.findIndex((item) => item.id === id);
        toggle(id);
      }
    }
    if (panelOpen && panelTab === "skins") freshSkin = false;
    hud.setPanel(panelOpen ? panelModel() : null);
    refreshStatus();
    context.invalidate();
  }

  // The whole stage is the wooden fish: a press strikes at once, unless it lands on the HUD or
  // on a relic. A relic follows the finger along the floor; a press that does not move shows
  // what it does.
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1.04);
  const onFloor = new THREE.Vector3();
  // Where a ray meets the near side of the fish's footprint cylinder, if it reaches the fish
  // before the floor (over its top too: the ray enters from above, but the near side is kept).
  function fishEntry(ray) {
    const ox = ray.origin.x - fishCenter.x, oz = ray.origin.z - fishCenter.z;
    const { x: dx, z: dz } = ray.direction;
    const a = dx * dx + dz * dz, b = 2 * (ox * dx + oz * dz), c = ox * ox + oz * oz - fishRadius * fishRadius;
    const disc = b * b - 4 * a * c;
    if (a < 1e-9 || disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t <= 0) return null;
    const point = ray.at(t, new THREE.Vector3());
    return point.y > -1.04 ? point : null;
  }
  const place = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * viewport.width, y: (event.clientY - rect.top) / rect.height * viewport.height };
  };
  const aim = ({ x, y }) => {
    pointer.set(x / viewport.width * 2 - 1, 1 - y / viewport.height * 2);
    raycaster.setFromCamera(pointer, camera);
  };
  canvas.addEventListener("pointerdown", (event) => {
    if (paused || event.button > 0) return;
    canvas.focus({ preventScroll: true });
    setFocus(false);
    const at = place(event);
    const action = hud.hit(at.x, at.y);
    if (action === "none") return;
    if (action) { act(action); return; }
    aim(at);
    const relic = altar.pick(raycaster);
    if (relic && !drag) {
      drag = { id: relic, pointerId: event.pointerId, ...at, moved: false };
      try { canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers cannot be captured. */ }
      return;
    }
    strike();
  }, { signal });
  canvas.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const at = place(event);
    if (!drag.moved && Math.hypot(at.x - drag.x, at.y - drag.y) < 8) return;
    drag.moved = true;
    aim(at);
    // Over the fish, the relic stops at the fish's near side instead of landing behind it; the
    // altar then keeps it out of the fish and the other relics.
    const target = fishEntry(raycaster.ray) ?? (raycaster.ray.intersectPlane(floorPlane, onFloor) && onFloor);
    if (target) altar.moveTo(drag.id, target.x, target.z);
    context.invalidate();
  }, { signal });
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { id, moved } = drag;
    drag = null;
    if (!moved) { showInfo(id); return; }
    const { x, z } = altar.position(id);
    state.relics[id] = { ...state.relics[id], x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 };
    save();
  };
  canvas.addEventListener("pointerup", endDrag, { signal });
  canvas.addEventListener("pointercancel", endDrag, { signal });
  canvas.addEventListener("keydown", (event) => {
    if (paused || event.ctrlKey || event.metaKey || event.altKey) return;
    if (hud.cardOpen) {
      if (["Enter", "Space", "Escape"].includes(event.code) && !event.repeat) { event.preventDefault(); closeLot(); }
      return;
    }
    if (event.code === "KeyE" && !event.repeat && panelButton()) {
      event.preventDefault(); setFocus(true); act(panelOpen ? "close" : "panel"); return;
    }
    if (panelOpen) {
      const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 };
      if (event.code in moves) {
        event.preventDefault(); setFocus(true);
        const { cells, columns } = panelModel();
        const step = Math.abs(moves[event.code]) === 3 ? Math.sign(moves[event.code]) * columns : moves[event.code];
        panelSelected = Math.min(cells.length - 1, Math.max(0, panelSelected + step));
        refreshPanel();
      } else if ((event.code === "Enter" || event.code === "Space") && !event.repeat) {
        event.preventDefault(); setFocus(true);
        act(`cell:${panelModel().cells[panelSelected].id}`);
      } else if (event.code === "KeyS" && !event.repeat) {
        event.preventDefault(); setFocus(true);
        act(`tab:${{ relics: "skins", skins: "lots", lots: "relics" }[panelTab]}`);
      } else if (event.code === "Escape") { act("close"); }
      return;
    }
    if (event.code === "KeyC" && !event.repeat) {
      const owned = economy.items.filter((item) => enabled(item.id));
      if (!owned.length) return;
      event.preventDefault();
      infoIndex = (infoIndex + 1) % owned.length;
      showInfo(owned[infoIndex].id);
      return;
    }
    if (event.repeat) return;
    if (event.code === "Space" || event.code === "Enter") { event.preventDefault(); setFocus(true); strike(); }
  }, { signal });

  // Frames run only while something moves; a timer wakes the game to count down luck.
  function scheduleWake(seconds) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
    if (paused || signal.aborted || !Number.isFinite(seconds)) return;
    wakeTimer = setTimeout(() => { wakeTimer = null; if (!paused && !signal.aborted) context.invalidate(); }, Math.max(16, seconds * 1000));
  }
  onCleanup(() => clearTimeout(wakeTimer));

  // Framing: the camera fits the fish, the mallet and the shown relics into the stage the HUD
  // leaves free (below the merit, above the 法物 panel). Without relics the fish fills it; as
  // relics arrive (or the panel opens) the camera eases back over about a second.
  // Points close to the silhouette (box corners would frame empty space): the cushion's rim on
  // the floor, the crown and the resting mallet's head and grip.
  mallet.updateMatrixWorld(true);
  const restHeadBox = new THREE.Box3().setFromObject(malletHead);
  const restHead = restHeadBox.getCenter(new THREE.Vector3());
  const restHeadRadius = (restHeadBox.max.y - restHeadBox.min.y) / 2;
  const fixedPoints = [
    ...Array.from({ length: 12 }, (_, i) => new THREE.Vector3(fishCenter.x + Math.cos(i * Math.PI / 6) * fishRadius, -1.04, fishCenter.z + Math.sin(i * Math.PI / 6) * fishRadius)),
    crown.clone(),
    restHead.clone().setY(restHead.y + restHeadRadius), restHead.clone().setX(restHead.x - restHeadRadius),
    mallet.position.clone(),
  ];
  const view = { distance: 0, x: 0, y: 0 };
  let snapView = true;
  const projected = new THREE.Vector3();
  function placeCamera(distance, x, y) {
    camera.position.set(0, distance * 0.55, distance * 0.835);
    camera.lookAt(0, 0, 0.3);
    camera.translateX(x);
    camera.translateY(y);
    camera.updateMatrixWorld();
  }
  // The points' box on screen in CSS pixels, seen from `distance`.
  function screenBox(points, distance) {
    placeCamera(distance, 0, 0);
    const box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    for (const point of points) {
      projected.copy(point).project(camera);
      const x = (projected.x + 1) / 2 * viewport.width, y = (1 - projected.y) / 2 * viewport.height;
      box.left = Math.min(box.left, x); box.right = Math.max(box.right, x);
      box.top = Math.min(box.top, y); box.bottom = Math.max(box.bottom, y);
    }
    return box;
  }
  function frameTarget() {
    const { top, bottom, right } = hud.stage;
    const points = [...fixedPoints, ...altar.extent()];
    let distance = view.distance || 12;
    let box = null;
    // Apparent size falls off about as 1 / distance; a few passes settle the perspective.
    for (let pass = 0; pass < 4; pass++) {
      box = screenBox(points, distance);
      // On wide screens the height limits: keep some air above and below the fish there.
      const stageHeight = Math.max(viewport.height * 0.25, bottom - top);
      const fill = Math.max((box.right - box.left) / (right * 0.88), (box.bottom - box.top) / (stageHeight * (viewport.width > viewport.height && viewport.height > 500 ? 0.66 : 0.8)));
      distance = THREE.MathUtils.clamp(distance * fill, 7, 60);
    }
    box = screenBox(points, distance);
    const worldPerPixel = 2 * camera.position.length() * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / viewport.height;
    return {
      distance,
      x: ((box.left + box.right) / 2 - right / 2) * worldPerPixel,
      y: ((top + bottom) / 2 - (box.top + box.bottom) / 2) * worldPerPixel,
    };
  }
  // Returns true while the camera is still easing. A drag holds the framing until it ends.
  function updateCamera(delta) {
    let moving = false;
    if (!drag?.moved || snapView) {
      const target = frameTarget();
      const ease = snapView || reducedMotion ? 1 : Math.min(1, delta * 3);
      for (const key of ["distance", "x", "y"]) {
        view[key] += (target[key] - view[key]) * ease;
        if (Math.abs(target[key] - view[key]) > 1e-3) moving = true;
      }
      snapView = false;
    }
    placeCamera(view.distance, view.x, view.y);
    return moving;
  }

  function resize() {
    hud.resize(viewport);
    snapView = true;
    updateCamera(0);
    refreshStatus();
  }

  applyLooks();
  altar.sync(state.collection, state.relics);
  const libraryLoaded = relicLibrary.then((gltf) => {
    if (signal.aborted) return;
    // The relics' wood (named in dev/build-relics.py) gets the fish's grain, in its own colors.
    const grained = new Map();
    const grain = (material) => {
      if (!["wood", "dark-wood", "rosewood"].includes(material.name)) return material;
      if (!grained.has(material.name)) {
        const wood = track(malletMaterial.clone());
        wood.onBeforeCompile = shellMaterial.onBeforeCompile;
        wood.customProgramCacheKey = shellMaterial.customProgramCacheKey;
        wood.color.copy(material.color);
        wood.roughness = material.roughness;
        wood.clearcoat = material.clearcoat ?? 0;
        grained.set(material.name, wood);
      }
      return grained.get(material.name);
    };
    gltf.scene.traverse((child) => { if (child.isMesh) child.material = grain(child.material); });
    altar.setLibrary(gltf.scene);
    context.invalidate();
  });
  // Without relics yet, the game starts at once; a failed load then leaves the altar empty.
  if (economy.items.some((item) => economy.has(state, item.id))) await libraryLoaded;
  else libraryLoaded.catch((error) => { if (!signal.aborted) console.warn("Relic models unavailable", error); });
  signal.throwIfAborted();
  refreshStatus();
  labels();
  context.reportLoading(1);
  return {
    renderMode: "on-demand",
    update() {
      const real = performance.now() / 1000;
      const delta = lastReal === null ? 0 : Math.min(0.1, real - lastReal);
      lastReal = real;
      clock += delta;
      if (delta > 0) state.stats.time += delta;
      const auto = context.options["auto-strike"] && !hud.panelOpen && !hud.cardOpen;
      if (auto) {
        autoTime += delta;
        if (autoTime >= 0.45) { autoTime -= 0.45; strike(); }
      }
      // An open lot card holds the beat: zen neither ebbs nor breaks while it is read.
      if (hud.cardOpen) zen.hold(clock);
      const ended = zen.update(clock, delta);
      state.stats.samadhi = Math.max(state.stats.samadhi, ended, zen.samadhiTime(clock));
      // Spring steps at 240 Hz keep the bounce stable at any frame rate.
      let moving = false;
      for (let left = delta; left > 1e-6; left -= 1 / 240) {
        const h = Math.min(1 / 240, left);
        swing.velocity += (-140 * swing.angle - 15 * swing.velocity) * h;
        swing.angle += swing.velocity * h;
        if (swing.angle >= 1 && swing.velocity > 0) {
          const strength = swing.velocity / 16; // about 1 for a press from rest
          swing.angle = 1;
          swing.velocity = -swing.velocity * 0.32;
          impact(strength);
        }
      }
      if (Math.abs(swing.angle) > 1e-3 || Math.abs(swing.velocity) > 1e-2) moving = true; else { swing.angle = 0; swing.velocity = 0; }
      mallet.quaternion.slerpQuaternions(malletRest, malletContact, Math.max(-0.3, swing.angle));
      if (luck && clock >= luck.until) { luck = null; refreshStatus(); }
      // 古钟: a distant bell every eight seconds while in samadhi.
      if (enabled("bell") && zen.samadhi) {
        bellTimer -= delta;
        if (bellTimer <= 0) { bellTimer = 8; if (soundAvailable) knock.bell("temple", 0.06); }
      }
      const target = zen.level;
      const moodMoving = Math.abs(target - mood) > 0.002;
      mood += (target - mood) * Math.min(1, delta * 1.5);
      scene.background.lerpColors(calmColor, deepColor, mood * 0.55);
      const relicsBusy = relics.update(delta, { zen: mood, samadhi: zen.samadhi, petals: activeLuck()?.id === "chance" });
      const flying = altar.update(delta, landed);
      const hudBusy = hud.update(delta);
      const cameraBusy = updateCamera(delta);
      // The lot flies up and toward the viewer out of the mouth, spinning, then opens as a card.
      if (lotFlight) {
        lotFlight.time += delta;
        const t = Math.min(1, lotFlight.time / 1.1);
        const out = 1 - (1 - t) ** 2;
        stick.position.set(mouth.x + out * 0.4, mouth.y + Math.sin(t * Math.PI * 0.8) * 1.6 + out * 0.3, mouth.z + out * 1.6);
        stick.rotation.set(t * Math.PI * 3, 0, 0.4 + t * Math.PI * 1.5);
        stick.scale.setScalar(0.4 + 0.6 * Math.min(1, t * 3));
        if (t >= 1) openLot(lotFlight.index, true);
      }
      // Zen lights the carving and the mallet head from within.
      woodGlowUniforms.woodGlow.value = 2.2 * mood;
      malletHeadMaterial.emissiveIntensity = 0.35 * mood;
      effects.setZen(zen.level, zen.samadhi, state.skin.fish === "gold");
      const effectsBusy = effects.update(delta);
      labelTimer -= delta;
      if (labelTimer <= 0) { labelTimer = 1; labels(); refreshStatus(); }
      const ebbing = zen.level > 0 && !zen.chanting;
      const busy = Boolean(auto) || moving || flying || hudBusy || cameraBusy || Boolean(lotFlight) || effectsBusy || relicsBusy || moodMoving || ebbing;
      scheduleWake(busy || !luck ? Infinity : 1);
      return busy;
    },
    resize,
    pause() {
      paused = true;
      lastReal = null;
      clearTimeout(wakeTimer);
      knock.pause();
      voice?.stop();
      zen.reset();
      swing.queued = [];
      save();
    },
    resume() { paused = false; context.invalidate(); },
    localeChanged() {
      words = copy[locale()];
      floatBag = [];
      if (lotCard) openLot(lotCard.index, lotCard.fresh);
      refreshStatus(); refreshPanel(); labels(); context.invalidate();
    },
    optionChanged(id) {
      // Merit cheats unlock skins on the way, like strikes do.
      const raise = (merit) => {
        const before = state.merit;
        state.merit = merit;
        for (const skin of economy.newlyUnlocked(before, merit)) unlockedSkin(skin);
        save();
      };
      if (id === "merit-1000") raise(state.merit + 1000);
      if (id === "all-skins") raise(Math.max(state.merit, Math.max(...skinList.map(({ skin }) => skin.at))));
      // Every missing relic hops out of the fish at once.
      if (id === "all-items") {
        for (const item of economy.items) {
          if (economy.has(state, item.id)) continue;
          state.collection[item.id] = 1;
          altar.drop(item.id, crownPoint());
        }
        if (reducedMotion) landed();
        save();
      }
      // Draws another lot even if today's is drawn, to test the ceremony.
      if (id === "lot-now" && !lotFlight && !lotCard) drawLot();
      if (id === "drop-now") {
        const drop = economy.rollDrop(state);
        state.stats.drops++;
        state.sinceDrop = 0;
        if (drop.kind === "item") state.collection[drop.id] = 1;
        else luck = { id: drop.id, until: clock + drop.seconds };
        found(drop);
      }
      refreshStatus();
      labels();
      context.invalidate();
    },
    shareText(target) {
      const text = copy[target] || copy.en;
      const loc = target === "zh" ? "zh" : "en";
      // The day's lot joins the share text once it is drawn.
      const index = economy.lotDrawnToday(state, economy.today()) ? state.lots.round.at(-1) : undefined;
      const lot = index === undefined ? "" : (loc === "zh" ? "。" : ". ") + text.lotShare(lotTitle(index, loc), loc === "zh" ? lots[index].zhGloss : lots[index].enGloss);
      return text.share(exact(state.merit, loc), economy.collectedCount(state)) + lot + (context.cheatsUsed ? text.cheats : "");
    },
    dispose() {
      altar.dispose();
      relics.dispose();
      effects.dispose();
      hud.dispose();
      scene.remove(fish, mallet, shadow, floor, stick, camera);
    },
  };
}
