import { createWoodenFishHUD } from "./hud.js";
import { createKnockAudio } from "./sound.js";

// Rendered by the platform's options panel; values arrive through context.options.
export const options = [
  { id: "feedback", section: "settings", type: "toggle", default: true, label: { zh: "显示「+1」", en: "Show “+1”" } },
  { id: "merit-1000", section: "cheats", type: "action", label: { zh: "功德 +1000", en: "Merit +1000" } },
  { id: "auto-strike", section: "cheats", audience: "debug", type: "toggle", label: { zh: "自动敲击", en: "Auto strike" } },
];

export async function createGame(context) {
  const { THREE, scene, setCamera, canvas, viewport, track, signal, onCleanup, reducedMotion } = context;
  const progress = context.progress?.version === 1 ? context.progress : null;
  context.reportLoading(0.1);
  const saved = progress ? await progress.load() : { kind: "empty" };
  signal.throwIfAborted();
  if (saved.kind === "unavailable") throw new Error("Progress is unavailable. Retry or start a separate save.");
  let initialMerit = 0;
  if (saved.kind === "saved") {
    const value = saved.snapshot;
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.data?.merit) || value.data.merit < 0) throw new Error("Unsupported Wooden Fish save. Export it before resetting.");
    initialMerit = value.data.merit;
  }
  const copy = {
    zh: { merit: "功德", strike: "敲木鱼，功德加一", unavailable: "声音不可用", keys: "空格或回车敲击，左右方向键或拖动旋转", share: (n) => `我在 fun.dev 敲木鱼，功德 ${n}`, cheats: "（开了秘籍）" },
    en: { merit: "MERIT", strike: "Strike the wooden fish. Merit plus one", unavailable: "Sound unavailable", keys: "Space or Enter to strike, arrow keys or drag to rotate", share: (n) => `I've earned ${n} merit on Wooden Fish at fun.dev`, cheats: " (with cheats)" },
  };
  let words = copy[context.locale] || copy.en;
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
  const shellMaterial = track(new THREE.MeshPhysicalMaterial({ color: 0x9c5626, metalness: 0, roughness: 0.55, clearcoat: 0.2, clearcoatRoughness: 0.4, envMapIntensity: 0.6 }));
  // The model has no UVs, so the grain is procedural in model space: dense streaks that stay
  // horizontal on every side, like teak. Streak noise is stretched across the horizontal plane;
  // the finest fibres fade out once they get thinner than a pixel, to avoid moiré on phones.
  shellMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
varying vec3 vWoodPosition;
varying float vWoodOcclusion;
#ifdef WOOD_OCCLUSION
attribute vec4 color;
#endif`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
vWoodPosition = position;
#ifdef WOOD_OCCLUSION
// Open surfaces stay unshaded; grooves (red: baked AO) darken, and the recessed slit
// (green: depth below the convex hull) goes nearly black inside.
vWoodOcclusion = mix(0.35, 1.0, smoothstep(0.05, 0.6, color.r)) * mix(0.12, 1.0, smoothstep(0.45, 0.75, color.g));
#else
vWoodOcclusion = 1.0;
#endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vWoodPosition;
varying float vWoodOcclusion;
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
diffuseColor.rgb *= mix(0.6, 1.15, 0.45 * bands + 0.4 * fibres + 0.15 * tone) * vWoodOcclusion;`);
  };
  shellMaterial.customProgramCacheKey = () => "wooden-fish-grain";
  // Only the fish carries baked occlusion (its vertex colors); the mallet shares the wood without it.
  const malletMaterial = track(shellMaterial.clone());
  malletMaterial.onBeforeCompile = shellMaterial.onBeforeCompile;
  malletMaterial.customProgramCacheKey = shellMaterial.customProgramCacheKey;
  shellMaterial.defines = { WOOD_OCCLUSION: "" };
  const { createAssets } = await context.runtime("kit/assets.js");
  const model = (await createAssets(context).gltf("assets/wooden-fish.glb")).scene;
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
diffuseColor.rgb = mix(diffuseColor.rgb * (0.93 + 0.07 * weave), cushionGold, gold);`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.45, gold);")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.5, gold);");
  };
  cushionMaterial.customProgramCacheKey = () => "wooden-fish-brocade";
  cushion.material = cushionMaterial;
  body.material = shellMaterial;
  for (const mesh of [body, cushion, malletHead, malletHandle]) mesh.castShadow = mesh.receiveShadow = true;
  malletHead.material = malletMaterial;
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

  // Drag or arrow keys spin the fish about the vertical line through its crown, so the mallet still lands.
  const turntable = new THREE.Group();
  turntable.position.set(crown.x, 0, crown.z);
  fish.add(turntable);
  turntable.attach(model);
  // The contact shadow hugs the cushion's footprint and turns with it.
  const footprint = new THREE.Box3().setFromObject(cushion);
  footprint.getCenter(shadow.position).setY(-1.035);
  shadow.scale.set((footprint.max.x - footprint.min.x) * 1.25 / 4.5, (footprint.max.z - footprint.min.z) * 1.25 / 3.5, 1);
  turntable.attach(shadow);
  // Taps land on a padded, invisible ellipsoid around the fish and cushion, not the exact mesh.
  const hitBox = new THREE.Box3().setFromObject(model);
  const hitArea = new THREE.Mesh(track(new THREE.SphereGeometry(1, 16, 12)), track(new THREE.MeshBasicMaterial()));
  hitArea.visible = false;
  hitBox.getCenter(hitArea.position);
  hitBox.getSize(hitArea.scale).multiplyScalar(0.5 * 1.3);
  turntable.attach(hitArea);
  let spinVelocity = 0;
  function spin(angle) {
    turntable.rotation.y += angle;
    context.invalidate();
  }

  const hud = createWoodenFishHUD({ THREE, camera, scene, track });
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  // A horizontal drag past the threshold spins instead of striking.
  let drag = null;
  let dragged = false;
  canvas.addEventListener("pointerdown", (event) => {
    if (paused || !event.isPrimary || event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, time: event.timeStamp, moved: false };
    dragged = false;
    spinVelocity = 0;
    canvas.setPointerCapture(event.pointerId);
  }, { signal });
  canvas.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 8) return;
    const angle = dx * 0.01;
    spinVelocity = angle / Math.max(0.008, (event.timeStamp - drag.time) / 1000);
    drag.moved = true;
    drag.x = event.clientX;
    drag.time = event.timeStamp;
    spin(angle);
  }, { signal });
  const endDrag = (event) => {
    if (event.pointerId !== drag?.id) return;
    dragged = drag.moved;
    // A pause before release means no fling.
    if (!dragged || reducedMotion || event.timeStamp - drag.time > 80) spinVelocity = 0;
    drag = null;
    context.invalidate();
  };
  canvas.addEventListener("pointerup", endDrag, { signal });
  canvas.addEventListener("pointercancel", endDrag, { signal });
  canvas.addEventListener("click", (event) => {
    if (paused || signal.aborted || event.button !== 0) return;
    if (dragged) { dragged = false; return; }
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * viewport.width;
    const y = (event.clientY - rect.top) / rect.height * viewport.height;
    canvas.focus({ preventScroll: true });
    pointer.set(x / viewport.width * 2 - 1, 1 - y / viewport.height * 2);
    raycaster.setFromCamera(pointer, camera);
    if (raycaster.intersectObject(hitArea).length) { strike(); playKnock(); }
  }, { signal });
  canvas.addEventListener("keydown", (event) => {
    if (paused || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
      event.preventDefault(); spin(event.code === "ArrowLeft" ? -Math.PI / 12 : Math.PI / 12);
      return;
    }
    if (event.repeat) return;
    if (event.code === "Space" || event.code === "Enter") {
      event.preventDefault(); strike(); playKnock();
    }
  }, { signal });

  let merit = initialMerit;
  let paused = false;
  let soundAvailable = true;
  let pulse = 0;
  let feedbackTime = 0;
  let autoTime = 0;
  const audio = createKnockAudio(context.audio, () => {
    if (signal.aborted) return;
    soundAvailable = false;
    labels();
  });
  onCleanup(() => audio.dispose());

  function labels() {
    hud.setScore(merit);
    const parts = [words.strike, `${words.merit} ${merit}`, ...(soundAvailable ? [] : [words.unavailable]), words.keys];
    if (!progress) parts.push(context.locale === "zh" ? "当前容器不支持存档" : "This host does not support saving");
    canvas.setAttribute("aria-label", parts.join(". "));
    context.invalidate();
  }

  function playKnock() {
    if (!paused && !signal.aborted && soundAvailable) audio.strike();
  }

  // Cheats save like normal play: the merit is the player's to keep.
  function addMerit(amount) {
    merit = Math.min(Number.MAX_SAFE_INTEGER, merit + amount);
    if (progress) void progress.save({ schemaVersion: 1, data: { merit } }).catch(() => { /* The player displays the save failure and retains an exportable snapshot. */ });
    context.announce(`${words.merit} ${merit}`);
    labels();
  }

  function strike() {
    if (paused || signal.aborted) return;
    context.invalidate();
    if (merit === Number.MAX_SAFE_INTEGER) return;
    context.haptics.vibrate("tap");
    addMerit(1);
    pulse = 1;
    if (context.options.feedback) {
      feedbackTime = 0.7;
      hud.showFeedback(1, 0);
    }
  }

  const projected = new THREE.Vector3();
  function resize() {
    const aspect = viewport.width / viewport.height;
    const distance = aspect < 1 ? 10.5 / aspect ** 0.7 : 10.5;
    camera.position.set(0, distance * 0.55, distance * 0.835);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    projected.set(0, 0, 0).project(camera);
    const centerX = (projected.x + 1) / 2 * viewport.width;
    const centerY = (1 - projected.y) / 2 * viewport.height;
    const radius = viewport.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / camera.position.length();
    hud.resize(viewport.width, viewport.height, centerX, Math.max(105, centerY - radius * 1.8), viewport.safeArea);
  }

  labels();
  context.reportLoading(1);
  return {
    renderMode: "on-demand",
    update(delta) {
      const auto = context.options["auto-strike"];
      if (auto) {
        autoTime += delta;
        if (autoTime >= 0.5) { autoTime = 0; strike(); playKnock(); }
      }
      if (!drag && spinVelocity) {
        turntable.rotation.y += spinVelocity * delta;
        spinVelocity *= Math.exp(-4 * delta);
        if (Math.abs(spinVelocity) < 0.05) spinVelocity = 0;
      }
      pulse = Math.max(0, pulse - delta * 5);
      const impact = Math.sin(pulse * Math.PI);
      if (!reducedMotion) {
        mallet.quaternion.slerpQuaternions(malletRest, malletContact, impact);
      }
      if (feedbackTime > 0) {
        feedbackTime = Math.max(0, feedbackTime - delta);
        if (!reducedMotion) {
          hud.showFeedback(Math.min(1, feedbackTime * 4), (0.7 - feedbackTime) * 40);
        }
        if (feedbackTime === 0) hud.showFeedback(0, 0);
      }
      return auto || pulse > 0 || feedbackTime > 0 || spinVelocity !== 0;
    },
    resize,
    pause() { paused = true; drag = null; spinVelocity = 0; audio.pause(); },
    resume() { paused = false; },
    localeChanged(locale) { words = copy[locale] || copy.en; labels(); },
    optionChanged(id) {
      if (id === "merit-1000") addMerit(1000);
      if (id === "feedback" && !context.options.feedback) { feedbackTime = 0; hud.showFeedback(0, 0); }
      context.invalidate();
    },
    shareText(locale) {
      const text = copy[locale] || copy.en;
      return text.share(merit) + (context.cheatsUsed ? text.cheats : "");
    },
    dispose() { scene.remove(fish, mallet, shadow, floor, camera); },
  };
}
