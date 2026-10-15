import { seals, layoutSeal, FACE } from "./seals.js";
import { createCarving, createMaskPainter, FINISH, AXES, STEP, hash } from "./carve.js";
import { createStone, stones, HEIGHT } from "./stone.js";
import { createKnife } from "./knife.js";
import { createSound } from "./sound.js";
import { createHud } from "./hud.js";
import { createEffects } from "./effects.js";
import * as saving from "./save.js";

export const options = [
  { id: "finish-step", section: "cheats", type: "action", label: { zh: "完成当前工序", en: "Finish this step" } },
  { id: "unlock-all", section: "cheats", type: "action", label: { zh: "解锁全部印文", en: "Unlock every seal" } },
  { id: "auto-carve", section: "cheats", audience: "debug", type: "toggle", label: { zh: "自动刻（演示）", en: "Carve by itself (demo)" } },
];

const copy = {
  zh: {
    steps: { bevel: "倒边", border: "刻边框", cross: "分格", glyphs: "刻字", dust: "吹去石粉", done: "完成" },
    stepNames: { bevel: "倒边", border: "边框", cross: "十字", glyphs: "刻字", dust: "吹粉" },
    hints: {
      bevel: "拖动移刀到边的一端，按住红色握点顺着边推",
      border: "移刀到线的一端，按住握点往上或往左右推",
      cross: "刻一个十字，分成四格",
      glyphs: "按住握点顺着线推：竖线往上，横线往左右",
      dust: "按「吹」或在屏幕上划一下",
      done: "刻好了",
    },
    stepDone: (name) => `${name}完成`,
    offFace: "刀尖要在印面上才能下刀",
    nth: (n) => `第${["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"][n] ?? n + 1}方`,
    blow: "吹", album: "印谱", left: "‹", right: "›",
    finished: (title) => `「${title}」刻成`, cardDetail: (stone) => `${stone} · 已收入印谱`,
    next: "刻下一方", stay: "再看看", close: "关闭", back: "回去刻", view: "看印石", recarve: "重刻这一方", sure: "确定重刻？",
    albumTitle: (count, total) => `印谱 ${count}/${total}`, albumDetail: "点一方印：刻完的看印蜕，没刻完的接着刻", locked: "？",
    allDone: "全部刻完了！可以在印谱里挑一方重刻",
    viewing: (title) => `看「${title}」`,
    keys: "方向键移动刀尖；按住空格下刀，再按上或左右方向键顺着线推，反方向往回拉；Q 和 E 转动印石，B 吹石粉，A 打开印谱",
    canvas: (title, step, progress) => `刻一方印：${title}。${step}，已刻 ${progress}%`,
    noSave: "当前容器不支持存档", unavailable: "声音不可用",
    share: (count) => `我在 fun.dev 刻了 ${count} 方印`, cheats: "（开了秘籍）",
  },
  en: {
    steps: { bevel: "Chamfer", border: "Border", cross: "Divide", glyphs: "Characters", dust: "Blow", done: "Done" },
    stepNames: { bevel: "Edge", border: "Border", cross: "Cross", glyphs: "Glyphs", dust: "Blow" },
    hints: {
      bevel: "Move the knife to an edge's end; hold the grip, push along it",
      border: "At a line's end, hold the grip, push up or sideways",
      cross: "Cut a cross into four cells",
      glyphs: "Hold the grip, push along: up or sideways",
      dust: "Press Blow or swipe the screen",
      done: "Finished",
    },
    stepDone: (name) => `${name} done`,
    offFace: "Aim at the face before pressing the knife in",
    nth: (n) => `Seal ${n + 1}`,
    blow: "Blow", album: "Seals", left: "‹", right: "›",
    finished: (title) => `“${title}” is carved`, cardDetail: (stone) => `${stone} · added to your seals`,
    next: "Next seal", stay: "Look again", close: "Close", back: "Carve", view: "See stone", recarve: "Carve again", sure: "Sure?",
    albumTitle: (count, total) => `Seals ${count}/${total}`, albumDetail: "Tap a seal: finished ones show their print", locked: "?",
    allDone: "All seals carved! Pick one in Seals to carve it again",
    viewing: (title) => `Viewing “${title}”`,
    keys: "Arrow keys move the knife tip; hold Space to press it in, then Up, Left or Right pushes along a line and the opposite key pulls back; Q and E turn the stone, B blows the powder, A opens your seals",
    canvas: (title, step, progress) => `Carve a Seal: ${title}. ${step}, ${progress}% carved`,
    noSave: "This host does not support saving", unavailable: "Sound unavailable",
    share: (count) => `I've carved ${count} seals on fun.dev`, cheats: " (with cheats)",
  },
};

const GRIP_HIT_PX = 34; // the grip answers a finger at least this far from its centre
const DIRECTION_PX = 8; // the first push this long picks the cut's direction
const NEAR_EDGE_AT = 0.72; // where the face's near edge sits, as a fraction down the stage
const QUARTER = Math.PI / 2;
const STAGE_WIDTH = { bevel: 0, border: 1, cross: 1, glyphs: 2 }; // blade per step
const WIDTHS = [FACE.bevel, FACE.frameWidth, FACE.glyphWidth];

export async function createGame(context) {
  const { THREE, scene, setCamera, canvas, track, signal, onCleanup, reducedMotion } = context;
  const progress = context.progress?.version === 1 ? context.progress : null;
  context.reportLoading(0.1);
  const loaded = progress ? await progress.load() : { kind: "empty" };
  signal.throwIfAborted();
  if (loaded.kind === "unavailable") throw new Error("Progress is unavailable. Retry or start a separate save.");
  const state = loaded.kind === "saved" ? saving.deserialize(loaded.snapshot) : saving.createState();
  const locale = () => context.locale === "zh" ? "zh" : "en";
  let words = copy[locale()];
  const text = (entry) => entry[locale()] ?? entry.en;
  const UP = THREE.Object3D.DEFAULT_UP;

  // Scene: the yellow room, a dark ridged rubber mat, the stone standing on it.
  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 40);
  setCamera(camera);
  scene.background = new THREE.Color(0xffd43b);
  const studio = new THREE.Scene();
  const studioParts = [
    new THREE.Mesh(new THREE.BoxGeometry(12, 8, 12), new THREE.MeshBasicMaterial({ color: 0x8a7a55, side: THREE.BackSide })),
    new THREE.Mesh(new THREE.PlaneGeometry(5, 3), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff4e0).multiplyScalar(7), side: THREE.DoubleSide })),
    new THREE.Mesh(new THREE.PlaneGeometry(3, 5), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd43b).multiplyScalar(2.2), side: THREE.DoubleSide })),
  ];
  studioParts[1].position.set(-1.2, 3.9, 1.8);
  studioParts[1].rotation.x = Math.PI / 2;
  studioParts[2].position.set(5.9, 0.5, 0);
  studioParts[2].rotation.y = Math.PI / 2;
  studio.add(...studioParts);
  const pmrem = new THREE.PMREMGenerator(context.renderer);
  scene.environment = track(pmrem.fromScene(studio, 0.04)).texture;
  scene.environmentIntensity = 0.6;
  pmrem.dispose();
  for (const part of studioParts) { part.geometry.dispose(); part.material.dispose(); }
  scene.add(new THREE.HemisphereLight(0xfffaf0, 0x6a5a40, 0.7));
  const keyLight = new THREE.DirectionalLight(0xfff6ea, 2.4);
  keyLight.position.set(-2.2, 5, 3);
  scene.add(keyLight, keyLight.target);
  const { shadowMap } = context.renderer;
  const previousShadows = { enabled: shadowMap.enabled, type: shadowMap.type };
  shadowMap.enabled = true;
  shadowMap.type = THREE.PCFShadowMap;
  onCleanup(() => Object.assign(shadowMap, previousShadows));
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.radius = 4;
  keyLight.shadow.bias = -0.0004;
  keyLight.shadow.normalBias = 0.01;
  Object.assign(keyLight.shadow.camera, { left: -2.2, right: 2.2, top: 2.2, bottom: -2.2, near: 1, far: 12 });
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(3, 2, -2);
  scene.add(fill);

  // The mat: dark rubber with fine raised ridges, like a carver's bench pad.
  const matMaterial = track(new THREE.MeshStandardMaterial({ color: 0x2b2a28, roughness: 0.85 }));
  matMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vMatUv;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvMatUv = uv;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vMatUv;")
      .replace("#include <color_fragment>", `#include <color_fragment>
float ridge = sin(vMatUv.x * 6.2831853 * 90.0);
float fade = 1.0 - smoothstep(0.5, 1.0, fwidth(vMatUv.x * 90.0));
diffuseColor.rgb *= 1.0 + 0.22 * ridge * fade;`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
normal = normalize(normal + vec3(cos(vMatUv.x * 6.2831853 * 90.0) * 0.35 * (1.0 - smoothstep(0.5, 1.0, fwidth(vMatUv.x * 90.0))), 0.0, 0.0));`);
  };
  matMaterial.customProgramCacheKey = () => "seal-mat";
  const mat = new THREE.Mesh(track(new THREE.BoxGeometry(3.6, 0.06, 3.8)), matMaterial);
  mat.position.set(0, -HEIGHT - 0.03, 0.2);
  mat.receiveShadow = true;
  scene.add(mat);

  const stoneRoot = new THREE.Group(); // turned by the player
  scene.add(stoneRoot);
  const knifeModel = createKnife({ THREE, track });
  // As large against the face as in the video, where the grip is about a quarter of its width.
  knifeModel.group.scale.setScalar(1.1);
  scene.add(knifeModel.group);
  const anisotropy = Math.min(8, context.renderer.capabilities.getMaxAnisotropy());

  const kit = await context.runtime("kit/text.js");
  signal.throwIfAborted();
  context.reportLoading(0.5);
  const hud = createHud({ THREE, camera, scene, track, kit });

  let soundAvailable = true;
  const sound = createSound(context.audio, () => { if (!signal.aborted) { soundAvailable = false; labels(); } });
  onCleanup(() => sound.dispose());

  // The seal on the bench: its layout, carving, stone and powder.
  let bench = null; // { seal, carving, painter, stone, effects, viewOnly }
  let dustAmount = 0;
  let blownOnce = false; // since the last powder fell
  const dustSpots = []; // recent powder positions on the face, for the puff when blown
  let draftDirty = true, maskDirty = false, dustDirty = false;
  let aimed = null; // the draft cut the knife tip is on, lit as an aiming aid

  function buildBench(seal, viewOnly = false) {
    if (bench) {
      stoneRoot.remove(bench.stone.group, bench.effects.mesh);
      bench.dispose();
    }
    const disposables = [];
    const own = (resource) => { disposables.push(resource); return resource; };
    const look = stones[seal.stone];
    const stone = createStone({ THREE, track: own, look, seed: seals.indexOf(seal) * 7 + 3, anisotropy });
    const carving = createCarving(layoutSeal(seal), WIDTHS);
    const painter = createMaskPainter(carving, stone.mask, stone.maskSize);
    const saved = state.seals[seal.id];
    painter.clear();
    if (saved?.cuts) {
      try { carving.restore(saved.cuts); } catch { /* A layout change discards an old carving of this seal. */ }
      painter.paintAll();
    }
    const effects = createEffects({ THREE, track: own, color: look.groove, stoneColor: look.light, faceHalf: 0.5, floor: -HEIGHT, reducedMotion });
    stoneRoot.add(stone.group, effects.mesh);
    bench = {
      seal, carving, painter, stone, effects, viewOnly,
      dispose() { for (const resource of disposables) resource.dispose(); },
    };
    stone.dust.clearRect(0, 0, stone.layerSize, stone.layerSize);
    dustAmount = 0;
    dustSpots.length = 0;
    // A seal left before blowing still has its powder.
    if (!viewOnly && carving.stage() === "dust" && !saved?.done) {
      for (const cut of carving.cuts) for (let t = 0; t <= 1; t += 0.05) sprinkle(carving.point(cut, t), cut.direction, cut.width, 1, 0.5);
    }
    knife.plunged = false;
    aimed = null;
    draftDirty = true;
    maskDirty = dustDirty = true;
    labels();
  }
  onCleanup(() => bench?.dispose());

  // Powder, as in the video: mostly a fine white haze that builds up over the ground just cut
  // (soft, faint dabs), with a few crumbs on the groove's lips and ahead of the knife.
  function sprinkle(p, direction, width, sign, amount = 1) {
    const g = bench.stone.dust, size = bench.stone.layerSize;
    const dabs = Math.round((0.5 + Math.random()) * amount);
    for (let i = 0; i < dabs + 1; i++) {
      const crumb = i === dabs; // the last one is a crumb, the rest haze
      if (crumb && Math.random() > 0.15 * amount) continue;
      const ahead = (0.2 + 1.5 * Math.random()) * width * sign;
      const side = (Math.random() < 0.5 ? -1 : 1) * width * (crumb ? 0.6 + Math.random() : 0.3 + 3 * Math.random() ** 1.5);
      const u = p[0] + direction[0] * ahead - direction[1] * side;
      const v = p[1] + direction[1] * ahead + direction[0] * side;
      if (Math.abs(u) > 0.5 || Math.abs(v) > 0.5) continue;
      const x = (u + 0.5) * size, y = (v + 0.5) * size;
      if (crumb) {
        g.fillStyle = `rgba(255,255,255,${0.5 + 0.4 * Math.random()})`;
        g.beginPath(); g.arc(x, y, 0.4 + Math.random() * 0.6, 0, Math.PI * 2); g.fill();
      } else {
        const r = 2 + Math.random() * 5;
        const haze = g.createRadialGradient(x, y, 0, x, y, r);
        haze.addColorStop(0, `rgba(255,255,255,${0.05 + 0.06 * Math.random()})`);
        haze.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = haze;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      dustAmount += 1;
      blownOnce = false;
      if (dustSpots.length < 400) dustSpots.push([u, v]); else dustSpots[Math.floor(Math.random() * dustSpots.length)] = [u, v];
    }
    dustDirty = true;
  }

  // The draft for the current step, faint red: lines along the knife's track bright, the
  // rest dim until the stone turns; the line under the knife tip in yellow.
  function drawDraft() {
    const g = bench.stone.draft, size = bench.stone.layerSize;
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#000";
    g.fillRect(0, 0, size, size);
    if (bench.viewOnly) return;
    const stage = currentStage();
    g.lineCap = "square";
    g.globalCompositeOperation = "lighter";
    const line = (cut, color, scale) => {
      g.strokeStyle = color;
      g.lineWidth = Math.max(1, cut.width * size * scale);
      g.beginPath();
      g.moveTo((cut.a[0] + 0.5) * size, (cut.a[1] + 0.5) * size);
      g.lineTo((cut.b[0] + 0.5) * size, (cut.b[1] + 0.5) * size);
      g.stroke();
    };
    for (const cut of bench.carving.cuts) {
      if (cut.stage !== stage || cut.done) continue;
      line(cut, aligned(cut) ? "#ff0000" : "#4c0000", cut.stage === "bevel" ? 0.3 : 0.45);
    }
    if (aimed && !aimed.done) line(aimed, "#00ff00", 0.7);
    g.globalCompositeOperation = "source-over";
  }

  // The print (印蜕): what the seal stamps in red paste, read the right way round.
  function makePrint(source, size = 256) {
    const canvasPrint = new OffscreenCanvas(size, size);
    const g = canvasPrint.getContext("2d");
    g.fillStyle = "#b8231d";
    g.fillRect(0, 0, size, size);
    g.globalCompositeOperation = "screen";
    g.save();
    g.translate(size, 0);
    g.scale(-1, 1);
    g.drawImage(source, 0, 0, size, size);
    g.restore();
    // Paste never prints perfectly: a few pale flecks where the paper missed it.
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "rgba(255,247,214,0.55)";
    for (let i = 0; i < 90; i++) g.fillRect(hash(i, 1) * size, hash(i, 2) * size, 1 + hash(i, 3) * 2, 1 + hash(i, 4) * 2);
    const texture = new THREE.CanvasTexture(canvasPrint);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
  const prints = new Map(); // seal id → texture
  onCleanup(() => { for (const texture of prints.values()) texture.dispose(); });
  function printOf(seal) {
    if (prints.has(seal.id)) return prints.get(seal.id);
    const saved = state.seals[seal.id];
    if (!saved?.cuts) return null;
    const carving = createCarving(layoutSeal(seal), WIDTHS);
    try { carving.restore(saved.cuts); } catch { return null; }
    const maskCanvas = new OffscreenCanvas(512, 512);
    createMaskPainter(carving, maskCanvas.getContext("2d"), 512).paintAll();
    const texture = makePrint(maskCanvas);
    prints.set(seal.id, texture);
    return texture;
  }
  function refreshPrint(seal) { prints.get(seal.id)?.dispose(); prints.delete(seal.id); }

  // Saving: whenever the knife lifts, a few kilobytes.
  function save() {
    if (!bench.viewOnly) state.seals[bench.seal.id] = { ...state.seals[bench.seal.id], cuts: bench.carving.serialize(), done: Boolean(state.seals[bench.seal.id]?.done) };
    if (progress) void progress.save(saving.serialize(state)).catch(() => { /* The player shows the failure and keeps an exportable snapshot. */ });
  }

  // Camera: looking down at the face from the front, steeply, so the face fills the stage and
  // a strip of the carved side shows below it.
  const ELEVATION = 0.92; // about 53°, as in the video: the knife's handle leans toward the viewer
  const view = { elevation: ELEVATION, azimuth: 0, distance: 4, target: new THREE.Vector3(0, -0.08, 0) };
  let viewport = context.viewport;
  const cameraUp = new THREE.Vector3(), cameraRight = new THREE.Vector3();
  function placeCamera() {
    const { width, height } = viewport;
    const stage = hud.stage;
    const stageWidth = stage.right - stage.left, stageHeight = stage.bottom - stage.top;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    // Visible height and width (world units at the target) needed for the face and some side.
    // As in the video, the face takes about two thirds of the width, with room around it.
    const needH = 1.8 / (2 * tan) * (height / stageHeight);
    const needW = 1.6 / (2 * tan * (width / height)) * (width / stageWidth);
    view.distance = Math.max(needH, needW, 2);
    const { elevation, azimuth, distance, target } = view;
    camera.position.set(target.x + Math.sin(azimuth) * Math.cos(elevation) * distance, target.y + Math.sin(elevation) * distance, target.z + Math.cos(azimuth) * Math.cos(elevation) * distance);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    // Centre the stone in the stage between the title and the controls by sliding the camera
    // along its own up and right axes (the HUD rides on the camera, so the projection stays).
    const perPixel = 2 * distance * tan / height;
    const shiftY = (stage.top + stage.bottom) / 2 - height / 2, shiftX = (stage.left + stage.right) / 2 - width / 2;
    cameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(cameraUp, shiftY * perPixel).addScaledVector(cameraRight, -shiftX * perPixel);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    // Pushing the knife happens above the face: the grip sits up and to the left of the tip
    // and the hand pushes it on up, as far as the face is long. So the face sits low in the
    // stage, its near edge at about four fifths of the way down, leaving that room above.
    if (showcase <= 0) {
      const nearEdge = screenOf(0, 0.5)[1], farEdge = screenOf(0, -0.5)[1];
      const wanted = stage.top + (stage.bottom - stage.top) * NEAR_EDGE_AT;
      // Never so low that the near edge falls behind the buttons.
      const shift = Math.min(wanted, stage.bottom - 8) - nearEdge;
      if (farEdge + shift > stage.top) {
        camera.position.addScaledVector(cameraUp, shift * perPixel);
        camera.updateMatrixWorld();
      }
    }
  }

  // Screen (CSS pixels) to the world point on the face's plane, or null.
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  function worldPoint(x, y) {
    raycaster.setFromCamera(new THREE.Vector2(x / viewport.width * 2 - 1, -(y / viewport.height * 2 - 1)), camera);
    return raycaster.ray.intersectPlane(plane, hitPoint) ? [hitPoint.x, hitPoint.z] : null;
  }
  const scratch = new THREE.Vector3();
  function toLocal(x, z) { scratch.set(x, 0, z); stoneRoot.worldToLocal(scratch); return [scratch.x, scratch.z]; }
  function toWorld(u, v) { scratch.set(u, 0, v); stoneRoot.localToWorld(scratch); return [scratch.x, scratch.z]; }
  function screenOf(x, z, y = 0) {
    scratch.set(x, y, z).project(camera);
    return [(scratch.x + 1) / 2 * viewport.width, (1 - scratch.y) / 2 * viewport.height];
  }
  // CSS pixels per world unit across (x) and into (z) the screen near the face's centre.
  function pixelsPer() {
    const o = screenOf(0, 0), x = screenOf(0.1, 0), z = screenOf(0, 0.1);
    return { x: Math.hypot(x[0] - o[0], x[1] - o[1]) * 10, z: Math.hypot(z[0] - o[0], z[1] - o[1]) * 10 };
  }

  let yaw = 0, yawTarget = 0;
  const settled = () => Math.abs(yawTarget - yaw) < 0.02;
  function currentStage() { return bench.viewOnly || state.seals[bench.seal.id]?.done ? "done" : bench.carving.stage(); }
  const carvable = () => bench && !bench.viewOnly && !["dust", "done"].includes(currentStage());

  // The knife's tracks: up the screen (world −z), as in a 冲刀 push, or across it (world ±x).
  // The first push after the knife goes in picks one, and that cut keeps to it. Every draft line
  // lies along one of them while the stone sits square; turning is only for comfort.
  const trackDirection = new THREE.Vector3();
  function localTrack() {
    trackDirection.set(knife.dir[0], 0, knife.dir[1]).applyAxisAngle(UP, -yaw);
    return [trackDirection.x, trackDirection.z];
  }
  function aligned(cut) {
    if (!settled()) return false;
    const [x, z] = localTrack();
    return Math.abs(cut.direction[0] * x + cut.direction[1] * z) > 0.98 || Math.abs(cut.direction[0] * z - cut.direction[1] * x) > 0.98;
  }
  function axisOf() {
    const [x, z] = localTrack();
    let best = 0;
    AXES.forEach(([dx, dy], index) => { if (dx * x + dy * z > AXES[best][0] * x + AXES[best][1] * z) best = index; });
    return best;
  }

  // The knife, in world coordinates (it stays with the hand while the stone turns under it).
  const knife = {
    x: 0, z: 0.38, targetX: 0, targetZ: 0.38, lift: 0.05, // ready at the near edge, under the hand
    plunged: false, origin: null, stroke: null, travel: 0, touched: new Set(), cut: false,
    wobble: 0, kick: 0, speed: 0, tension: 0, shake: 0, shakeVelocity: 0,
    dir: [0, -1], // world direction of this cut: [0, -1] up the screen, [±1, 0] across
    chosen: false, // whether the first push has picked the direction yet
    lean: 0, // how the handle tips into a sideways push
    at: 0, hand: 0, strength: 0.006, hard: false, refractory: 0,
  };
  const onFace = (x, z) => { const [u, v] = toLocal(x, z); return Math.abs(u) <= 0.5 && Math.abs(v) <= 0.5; };

  function plunge() {
    if (knife.plunged || !carvable() || !settled()) return;
    if (!onFace(knife.x, knife.z)) { hint(words.offFace); return; }
    knife.plunged = true;
    knife.origin = { x: knife.x, z: knife.z };
    knife.stroke = null;
    knife.travel = 0;
    knife.at = 0;
    knife.hand = 0;
    knife.touched = new Set();
    knife.cut = false;
    knife.wobble = 0;
    knife.kick = 0;
    knife.dir = [0, -1];
    knife.chosen = false;
    knife.refractory = 0;
    knife.tension = 0;
    nextStrength(stones[bench.seal.stone].carve);
    sound.tap();
    context.haptics.vibrate("tap");
  }

  // Lifts the knife: cuts it covered nearly all of are finished off, and the work is saved.
  function lift() {
    if (!knife.plunged) return;
    knife.plunged = false;
    // The knife stays where the cut ended.
    knife.targetX = knife.x; knife.targetZ = knife.z;
    const finished = [];
    for (const cut of knife.touched) {
      if (cut.done || bench.carving.coverage(cut) < FINISH) continue;
      for (const { stroke, points } of bench.carving.finish(cut, STAGE_WIDTH[cut.stage])) bench.painter.paint(stroke, points);
      maskDirty = true;
      finished.push(cut);
    }
    if (finished.length) afterCuts();
    if (knife.cut) save();
    gripHint = 6;
  }

  // The knife in the stone is a stick-slip system, tuned to the carving video's sound (pushes
  // of 0.25–0.45 s, each a burst of cracks 15–40 ms apart). The hand on the grip pushes it
  // forward through a spring: the tip stays stuck while the pull is below the stone's strength
  // there, then a flake breaks off and the tip jumps ahead by the flake's length. A faster push
  // only packs the cracks closer; the knife never runs ahead on its own. Pulled back, the tip
  // slides freely down the groove it has cut, but no further.
  const MAX_STRETCH = 0.05; // the hand gets no further ahead of the tip than this
  const SUBSTEP = 0.004; // seconds per simulation step
  const SLIDE = 1.5; // face units per second the tip slides along an open groove
  let chipClock = 0, buzzClock = 0;
  function nextStrength(carve) {
    knife.hard = Math.random() < carve.hardSpots; // a sand grain (砂丁): the knife stalls, then a big flake
    knife.strength = carve.stretch * (0.6 + 0.8 * Math.random()) * (knife.hard ? 2.2 : 1);
  }
  // Moves the hand along the track by `distance` face units (forward positive).
  function push(distance) {
    knife.hand = Math.max(-0.02, Math.min(knife.at + MAX_STRETCH, knife.hand + distance));
  }
  function cutStep(delta) {
    const carve = stones[bench.seal.stone].carve;
    const cracks = [];
    for (let time = delta; time > 1e-6; time -= SUBSTEP) {
      const dt = Math.min(SUBSTEP, time);
      knife.refractory -= dt;
      const pull = knife.hand - knife.at;
      // Within the groove already cut (either way) the tip just slides.
      if (pull < 0 || knife.at < knife.travel) {
        const goal = Math.max(0, Math.min(knife.hand, pull < 0 ? knife.at : knife.travel));
        knife.at += Math.max(-SLIDE * dt, Math.min(SLIDE * dt, goal - knife.at));
        continue;
      }
      if (pull < knife.strength || knife.refractory > 0) continue; // stuck, under tension
      const length = Math.min(pull, carve.chip * (0.5 + 1.3 * Math.random()) * (knife.hard ? 2.4 : 1));
      // The far edge of the face stops the knife.
      if (!onFace(knife.origin.x + knife.dir[0] * (knife.at + length), knife.origin.z + knife.dir[1] * (knife.at + length))) { knife.hand = Math.min(knife.hand, knife.at + knife.strength * 0.95); break; }
      cracks.push({ size: Math.min(1, length / (carve.chip * 2.5)), force: Math.min(1, pull / (carve.stretch * 2)) });
      knife.at += length;
      knife.travel = knife.at;
      knife.refractory = 0.01 + Math.random() * 0.016;
      // The flake nudges the blade sideways a little; it stays in the groove's wobble.
      knife.kick = (Math.random() - 0.5) * length * 0.12;
      nextStrength(carve);
    }
    // Along the track, plus the wobble across it.
    knife.x = knife.origin.x + knife.dir[0] * knife.at - knife.dir[1] * knife.wobble;
    knife.z = knife.origin.z + knife.dir[1] * knife.at + knife.dir[0] * knife.wobble;
    knife.tension = knife.at < knife.travel ? 0 : Math.min(1.5, Math.max(0, knife.hand - knife.at) / Math.max(knife.strength, 1e-4));
    if (cracks.length) carveTo(cracks);
    return knife.tension;
  }

  // Grows the groove to the tip after cracks, with everything the cracks throw off.
  function carveTo(cracks) {
    if (knife.travel < STEP * 0.5) return;
    const { carving } = bench;
    let stroke = knife.stroke;
    if (!stroke) {
      const [u, v] = toLocal(knife.origin.x, knife.origin.z);
      stroke = knife.stroke = carving.beginStroke(u, v, axisOf(), STAGE_WIDTH[currentStage()]);
    }
    // The wobble across the track (world x), in the stroke's own sideways direction.
    const [dx, dy] = AXES[stroke.axis];
    scratch.set(-knife.dir[1] * (knife.wobble + knife.kick), 0, knife.dir[0] * (knife.wobble + knife.kick)).applyAxisAngle(UP, -yaw);
    const offset = scratch.x * -dy + scratch.z * dx;
    const { points, cuts } = carving.extend(stroke, knife.travel, offset);
    if (points.length) {
      knife.cut = true;
      bench.painter.paint(stroke, points);
      maskDirty = true;
      const width = WIDTHS[stroke.width];
      for (const k of points) sprinkle(carving.strokePoint(stroke, k), [dx, dy], width, 1, stroke.width === 0 ? 0.4 : 0.6);
      labelsDirty = true;
    }
    // Each crack: a flake flies, a puff of powder lands ahead, a click, a buzz.
    const tip = carving.strokePoint(stroke, Math.max(0, stroke.offsets.length - 1));
    const ahead = new THREE.Vector3(dx, 0, dy), sideways = new THREE.Vector3(-dy, 0, dx);
    for (const crack of cracks) {
      // Only some cracks throw a flake, and small: the video shows crumbs, not sprays.
      if (Math.random() < 0.25 + crack.size * 0.4) bench.effects.flake(new THREE.Vector3(tip[0], 0.003, tip[1]), sideways, ahead, 0.4 + crack.force * 0.4, 0.45 + crack.size * 0.6);
      sprinkle(tip, [dx, dy], WIDTHS[stroke.width], 1, 1 + crack.size * 2);
      // Powder heaps in front of the edge; the blade jolts as the flake lets go and picks up dust.
      for (let i = 0; i < 2; i++) bench.effects.crumb(new THREE.Vector3(tip[0] + dx * 0.004, 0.002, tip[1] + dy * 0.004), ahead);
      knife.shake += (0.5 + crack.force) * (0.0015 + crack.size * 0.002);
      knifeModel.dust = Math.min(1, knifeModel.dust + 0.004 + crack.size * 0.006);
      sound.chip(crack.size, crack.force);
      if (buzzClock <= 0) { context.haptics.vibrate([Math.round(6 + crack.size * 18)]); buzzClock = 0.03; }
    }
    for (const cut of cuts) knife.touched.add(cut);
    if (carving.settle(cuts).length) afterCuts();
  }

  let lastStage = null;
  let labelsDirty = false;
  function afterCuts() {
    sound.tap();
    draftDirty = true;
    const stage = currentStage();
    if (stage !== lastStage) {
      if (lastStage && lastStage !== "done") {
        hud.toast(words.stepDone(words.steps[lastStage]));
        context.announce(words.stepDone(words.steps[lastStage]));
        context.haptics.vibrate("success");
      }
      lastStage = stage;
      if (stage === "dust") lift();
    }
    labels();
  }

  // A hint, at most every few seconds.
  let hintClock = 0;
  function hint(message) {
    if (hintClock > 0) return;
    hintClock = 3;
    hud.toast(message);
    context.announce(message);
  }

  // The draft line under the knife tip, if the tip is on it: lit so the hand knows it is aimed.
  function updateAimed() {
    let next = null;
    if (carvable() && settled()) {
      const [u, v] = toLocal(knife.x, knife.z);
      const width = WIDTHS[STAGE_WIDTH[currentStage()]];
      for (const cut of bench.carving.cuts) {
        if (cut.stage !== currentStage() || cut.done || !aligned(cut)) continue;
        const { t, distance } = bench.carving.project(cut, u, v);
        if (Math.abs(distance) <= Math.max(width, cut.width) * 0.7 && t > -0.05 && t < 1.05) { next = cut; break; }
      }
    }
    if (next !== aimed) { aimed = next; draftDirty = true; }
  }

  // Blowing: the powder thins out and flies off, away from the viewer.
  let blowCooldown = 0;
  function blow(strength = 1) {
    if (!bench || bench.viewOnly || blowCooldown > 0) return;
    blowCooldown = 0.35;
    sound.blow(strength);
    const g = bench.stone.dust, size = bench.stone.layerSize;
    // The first breath carries most of the powder off, pushed away from the viewer; the
    // second clears the rest.
    if (blownOnce || dustAmount < 30) {
      g.clearRect(0, 0, size, size);
      dustAmount = 0;
    } else {
      g.globalCompositeOperation = "copy";
      g.globalAlpha = 0.22 * (1.2 - strength * 0.4);
      g.drawImage(g.canvas, 0, -size * 0.015 * strength);
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
      dustAmount *= 0.2;
      blownOnce = true;
    }
    dustDirty = true;
    const away = new THREE.Vector3(-Math.sin(view.azimuth - yaw), 0, -Math.cos(view.azimuth - yaw));
    const points = dustSpots.splice(0, Math.min(dustSpots.length, reducedMotion ? 0 : 70)).map(([u, v]) => new THREE.Vector3(u, 0.004, v));
    bench.effects.blow(away, points, strength);
    knifeModel.dust *= 0.4;
    if (currentStage() === "dust" && dustAmount === 0) completeSeal();
    context.invalidate();
  }

  // The finished seal: a slow turn to show it off, then its print.
  let showcase = 0; // seconds of the turn left
  function completeSeal() {
    const seal = bench.seal;
    state.seals[seal.id] = { cuts: bench.carving.serialize(), done: true };
    refreshPrint(seal);
    save();
    context.haptics.vibrate("success");
    context.announce(words.finished(text(seal.text)));
    if (reducedMotion) openCard(); else { showcase = 4.2; yawTarget = yaw + Math.PI * 2; }
    labels();
  }

  let cardKind = null; // "finished" | "seal" (opened from the album)
  let cardSeal = null;
  let confirmRecarve = false;
  function openCard(seal = bench.seal, kind = "finished") {
    cardKind = kind;
    cardSeal = seal;
    const look = stones[seal.stone];
    const next = seals[seals.indexOf(seal) + 1];
    const buttons = kind === "finished"
      ? [{ id: next ? "next" : "album", label: next ? words.next : words.album }, { id: "stay", label: words.stay }]
      : [{ id: "view", label: words.view }, { id: confirmRecarve ? "recarve-sure" : "recarve", label: confirmRecarve ? words.sure : words.recarve }];
    hud.setCard({
      title: kind === "finished" ? words.finished(text(seal.text)) : `「${text(seal.text)}」`,
      detail: words.cardDetail(text(look.name)),
      picture: printOf(seal), buttons,
    });
    setFocusable();
  }
  function closeCard() { hud.setCard(null); cardKind = null; confirmRecarve = false; setFocusable(); }

  let albumOpen = false;
  function openAlbum() {
    lift();
    albumOpen = true;
    if (bench && !bench.viewOnly) refreshPrint(bench.seal);
    hud.setAlbum({
      title: words.albumTitle(saving.finishedCount(state), seals.length),
      cells: seals.map((seal) => {
        const done = state.seals[seal.id]?.done;
        const current = seal.id === state.current && !done;
        const open = saving.unlocked(state, seal.id);
        return { id: seal.id, picture: done || current ? printOf(seal) : null, label: open ? text(seal.text) : words.locked, current, open };
      }),
      detail: saving.finishedCount(state) === seals.length ? words.allDone : words.albumDetail,
      buttons: [{ id: "close-album", label: words.close }],
    });
    setFocusable();
  }
  function closeAlbum() { albumOpen = false; hud.setAlbum(null); setFocusable(); }

  function carveSeal(seal) {
    state.current = seal.id;
    buildBench(seal);
    lastStage = currentStage();
    yaw = yawTarget = 0;
    save();
    layoutButtons();
  }

  function viewSeal(seal) {
    buildBench(seal, true);
    yaw = 0; yawTarget = reducedMotion ? 0 : Math.PI * 2;
    showcase = reducedMotion ? 0 : 4.2;
    layoutButtons();
  }

  function turn(direction) {
    if (knife.plunged) return;
    yawTarget = Math.round(yawTarget / QUARTER) * QUARTER + direction * QUARTER;
    sound.tap();
  }

  // Controls are one-handed: the stage takes the aiming finger (or the mouse), a row of three
  // buttons turns the stone and blows, the album sits in the corner.
  function layoutButtons() {
    const list = [{ id: "left", label: words.left }];
    if (bench?.viewOnly) list.push({ id: "back", label: words.back });
    else list.push({ id: "blow", label: words.blow, active: currentStage() === "dust" });
    list.push({ id: "right", label: words.right });
    hud.setButtons(list);
    hud.setCorner({ id: "album", label: words.album });
  }

  // Keyboard focus among the HUD's controls while a card or the album shows.
  let keyboardUsed = false;
  let focusIndex = -1;
  function setFocusable() {
    const ids = hud.focusable;
    focusIndex = hud.modal ? 0 : -1;
    hud.setFocus(hud.modal && keyboardUsed ? ids[0] ?? null : null);
    layoutButtons();
  }

  function act(action) {
    if (!action || action === "none") return;
    switch (action) {
      case "left": turn(1); break;
      case "right": turn(-1); break;
      case "blow": blow(1); break;
      case "album": openAlbum(); break;
      case "close-album": closeAlbum(); break;
      case "back": carveSeal(seals.find((seal) => seal.id === state.current)); break;
      case "next": {
        closeCard();
        const next = seals[seals.indexOf(bench.seal) + 1];
        if (next) carveSeal(next);
        break;
      }
      case "stay": closeCard(); viewSeal(bench.seal); break;
      case "view": closeCard(); closeAlbum(); viewSeal(cardSeal); break;
      case "recarve": confirmRecarve = true; openCard(cardSeal, "seal"); break;
      case "recarve-sure": {
        const seal = cardSeal;
        state.seals[seal.id] = { cuts: null, done: false };
        refreshPrint(seal);
        closeCard(); closeAlbum();
        carveSeal(seal);
        break;
      }
      default:
        if (action.startsWith("seal:")) {
          const seal = seals.find((entry) => entry.id === action.slice(5));
          if (state.seals[seal.id]?.done && state.seals[seal.id]?.cuts) { closeAlbum(); openCard(seal, "seal"); }
          else if (saving.unlocked(state, seal.id)) {
            // Any open seal can go on the bench; each keeps its own half-finished carving.
            closeAlbum();
            if (bench.viewOnly || bench.seal !== seal) { lift(); save(); carveSeal(seal); }
          }
        }
    }
    context.invalidate();
  }

  function labels() {
    if (!bench) return;
    const stage = currentStage();
    const title = bench.viewOnly ? words.viewing(text(bench.seal.text)) : `${text(bench.seal.text)} · ${words.nth(seals.indexOf(bench.seal))}`;
    // The five steps, the current one filled by how much of it is cut.
    const order = ["bevel", "border", "cross", "glyphs", "dust"];
    const at = stage === "done" ? order.length : order.indexOf(stage);
    const steps = bench.viewOnly ? [] : order.map((name, index) => {
      const cuts = bench.carving.cuts.filter((cut) => cut.stage === name);
      const fill = cuts.length ? cuts.reduce((sum, cut) => sum + cut.carved / cut.count, 0) / cuts.length : 0;
      return { name: words.stepNames[name], state: index < at ? "done" : index === at ? "current" : "todo", fill };
    });
    hud.setStatus({ title, steps, hint: bench.viewOnly || stage === "done" ? "" : words.hints[stage] });
    const parts = [words.canvas(text(bench.seal.text), words.steps[stage], Math.round(bench.carving.progress() * 100)), words.keys];
    if (!soundAvailable) parts.push(words.unavailable);
    if (!progress) parts.push(words.noSave);
    canvas.setAttribute("aria-label", parts.join("。"));
    layoutButtons();
  }

  // Pointer input. A pointer on a button acts; otherwise it holds the knife ("hand" on touch,
  // "mouse" with a mouse): see pointerdown.
  const pointers = new Map();
  let hovering = 9; // seconds since the mouse last moved over the stage
  const cssPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * viewport.width, y: (event.clientY - rect.top) / rect.height * viewport.height };
  };
  const clampAim = () => {
    knife.targetX = Math.max(-0.7, Math.min(0.7, knife.targetX));
    knife.targetZ = Math.max(-0.7, Math.min(0.7, knife.targetZ));
  };
  const clampWobble = (value) => {
    const limit = WIDTHS[STAGE_WIDTH[currentStage()] ?? 2] * 0.3;
    return Math.max(-limit, Math.min(limit, value));
  };
  function aimAt(x, y) {
    const p = worldPoint(x, y);
    if (!p) return;
    knife.targetX = p[0]; knife.targetZ = p[1];
    clampAim();
  }

  // Touch: pressing the red grip on the knife's handle drives the knife into the stone, and
  // pushing the finger forward (up the screen) carves; lifting it lifts the knife. Dragging
  // anywhere else moves the knife by the finger's own movement (it never jumps to the finger).
  // With a mouse the tip follows the cursor; the button drives it in and dragging up carves.
  const gripPoint = new THREE.Vector3(), gripEdge = new THREE.Vector3();
  function onGrip(x, y) {
    gripPoint.copy(knifeModel.grip.center).applyMatrix4(knifeModel.group.matrixWorld);
    gripEdge.set(knifeModel.grip.radius, 0, 0).add(knifeModel.grip.center).applyMatrix4(knifeModel.group.matrixWorld);
    const center = screenOf(gripPoint.x, gripPoint.z, gripPoint.y), edge = screenOf(gripEdge.x, gripEdge.z, gripEdge.y);
    const radius = Math.max(GRIP_HIT_PX, Math.hypot(edge[0] - center[0], edge[1] - center[1]) * 1.6);
    return Math.hypot(x - center[0], y - center[1]) <= radius;
  }
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button > 0) return;
    const { x, y } = cssPoint(event);
    keyboardUsed = false;
    hud.setFocus(null);
    const mouse = event.pointerType === "mouse";
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers cannot be captured. */ }
    // The grip comes before the HUD's text (not its buttons): the knife may stand under the title.
    const action = hud.hit(x, y);
    const grip = !mouse && !hud.modal && carvable() && onGrip(x, y);
    const entry = { role: "none", x, y, startX: x, startY: y };
    pointers.set(event.pointerId, entry);
    if (action && !(grip && action === "none")) { act(action); return; }
    if (hud.modal || pointers.size > 1) return;
    if (currentStage() === "dust") { entry.role = "dust"; return; }
    if (mouse) {
      entry.role = "mouse";
      aimAt(x, y);
      knife.x = knife.targetX; knife.z = knife.targetZ;
      plunge();
    } else if (grip) {
      entry.role = "grip";
      plunge();
    } else entry.role = "hand";
    context.invalidate();
  }, { signal });

  canvas.addEventListener("pointermove", (event) => {
    const { x, y } = cssPoint(event);
    const entry = pointers.get(event.pointerId);
    if (!entry) {
      // Hovering with a mouse: the tip follows the cursor.
      if (event.pointerType === "mouse" && !hud.modal && bench && !bench.viewOnly) {
        aimAt(x, y);
        hovering = 0;
        context.invalidate();
      }
      return;
    }
    const dx = x - entry.x, dy = y - entry.y;
    entry.x = x; entry.y = y;
    if (entry.role === "dust") {
      // In the powder step, a swipe is a breath.
      if (!entry.blew && Math.hypot(x - entry.startX, y - entry.startY) > 40) { entry.blew = true; blow(0.8); }
      return;
    }
    if ((entry.role === "mouse" || entry.role === "grip") && knife.plunged) {
      // In the stone: the first clear push picks the track, up the screen or across it (left or
      // right); then movement along the track pushes the knife, back along it pulls it back, and
      // movement across it is only a slight wobble.
      const scale = pixelsPer();
      if (!knife.chosen) {
        entry.aimX = (entry.aimX ?? 0) + dx; entry.aimY = (entry.aimY ?? 0) + dy;
        if (Math.hypot(entry.aimX, entry.aimY) < DIRECTION_PX) return;
        if (Math.abs(entry.aimX) > Math.abs(entry.aimY)) knife.dir = [Math.sign(entry.aimX), 0];
        else if (entry.aimY < 0) knife.dir = [0, -1];
        else { entry.aimX = entry.aimY = 0; return; } // pulling toward oneself cuts nothing
        knife.chosen = true;
      }
      const along = knife.dir[0] ? dx * knife.dir[0] / scale.x : -dy / scale.z;
      const across = knife.dir[0] ? dy / scale.z : dx / scale.x;
      push(along);
      knife.wobble = clampWobble(knife.wobble + across * 0.03);
    } else if (entry.role === "mouse") aimAt(x, y);
    else if (entry.role === "hand") {
      // Moving: the knife follows the finger's movement one to one, from where it is.
      const scale = pixelsPer();
      knife.targetX += dx / scale.x;
      knife.targetZ += dy / scale.z;
      clampAim();
    }
    context.invalidate();
  }, { signal });

  function release(event) {
    const entry = pointers.get(event.pointerId);
    if (!entry) return;
    pointers.delete(event.pointerId);
    if (entry.role === "grip" || entry.role === "mouse") lift();
    context.invalidate();
  }
  canvas.addEventListener("pointerup", release, { signal });
  canvas.addEventListener("pointercancel", release, { signal });

  // Keyboard: arrows move the tip; Space holds the knife in, and then left and right push it.
  const held = new Set();
  canvas.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    keyboardUsed = true;
    const code = event.code;
    if (hud.modal) {
      const ids = hud.focusable;
      if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(code)) {
        event.preventDefault();
        focusIndex = (focusIndex + (code === "ArrowRight" || code === "ArrowDown" ? 1 : -1) + ids.length) % ids.length;
        hud.setFocus(ids[focusIndex]);
      } else if (code === "Enter" || code === "Space") {
        event.preventDefault();
        if (!event.repeat) act(ids[focusIndex] ?? ids[0]);
      } else if (code === "Escape") {
        event.preventDefault();
        if (albumOpen) closeAlbum(); else if (cardKind) act(cardKind === "finished" ? "stay" : "view");
      } else if (code === "KeyA" && albumOpen) { event.preventDefault(); closeAlbum(); }
      context.invalidate();
      return;
    }
    if (code.startsWith("Arrow")) {
      event.preventDefault();
      if (knife.plunged) held.add(code);
      else {
        const step = event.shiftKey ? 0.03 : 0.004;
        if (code === "ArrowLeft") knife.targetX -= step;
        if (code === "ArrowRight") knife.targetX += step;
        if (code === "ArrowUp") knife.targetZ -= step;
        if (code === "ArrowDown") knife.targetZ += step;
        clampAim();
        held.add("aim");
      }
    } else if (code === "Space" || code === "Enter") {
      event.preventDefault();
      if (!event.repeat) { if (currentStage() === "dust") blow(1); else held.add("carve"); }
    } else if (code === "KeyB") { event.preventDefault(); if (!event.repeat) blow(1); }
    else if (code === "KeyQ") { event.preventDefault(); act("left"); }
    else if (code === "KeyE") { event.preventDefault(); act("right"); }
    else if (code === "KeyA") { event.preventDefault(); act("album"); }
    context.invalidate();
  }, { signal });
  canvas.addEventListener("keyup", (event) => {
    held.delete(event.code);
    if (event.code.startsWith("Arrow")) held.delete("aim");
    if (event.code === "Space" || event.code === "Enter") { held.delete("carve"); lift(); }
  }, { signal });
  canvas.addEventListener("blur", () => { held.clear(); lift(); }, { signal });

  // The demo hand (debug): sets the knife at the start of an open line, presses in and pushes
  // until the line is cut, lets go.
  let demo = null; // { phase, start: [x, z], length }
  function demoStep() {
    if (!carvable() || !settled()) return;
    if (!demo) {
      const open = bench.carving.cuts.filter((cut) => cut.stage === currentStage() && !cut.done);
      const ready = open.filter(aligned);
      if (!ready.length) { if (open.length) turn(-1); return; }
      const cut = ready[0];
      const a = toWorld(...bench.carving.point(cut, 0)), b = toWorld(...bench.carving.point(cut, 1));
      // Across the screen push from the left end; up the screen from the near end.
      const across = Math.abs(a[0] - b[0]) > Math.abs(a[1] - b[1]);
      const start = across ? (a[0] < b[0] ? a : b) : (a[1] > b[1] ? a : b);
      demo = { phase: "aim", start, dir: across ? [1, 0] : [0, -1], length: cut.length };
      knife.targetX = demo.start[0]; knife.targetZ = demo.start[1];
    } else if (demo.phase === "aim" && Math.hypot(knife.x - demo.start[0], knife.z - demo.start[1]) < 0.002) {
      plunge();
      knife.dir = demo.dir; knife.chosen = true;
      demo.phase = "cut";
    } else if (demo.phase === "cut" && knife.plunged && knife.travel < demo.length) {
      push(0.004); // a steady hand
    } else if (demo.phase === "cut") {
      lift();
      demo = null;
    }
  }

  // Knife pose, matched to the video's frames: the blade's face to the viewer, the handle's
  // top leaning toward the viewer and to the upper left, so the grip looms large and the
  // blade slants down to the tip. The hand grips it firmly: the pull and cracks barely move it.
  let gripHint = 6; // seconds the grip breathes: at the start and after each lift
  const knifeTilt = new THREE.Euler(0.2, 0, 0.14);
  function poseKnife(delta) {
    if (!knife.plunged) {
      knife.x += (knife.targetX - knife.x) * Math.min(1, delta * 22);
      knife.z += (knife.targetZ - knife.z) * Math.min(1, delta * 22);
    }
    const aiming = pointers.size > 0 || hovering < 1.5 || held.size > 0;
    // In the stone the corner sinks below the face (the face hides it, as the groove would).
    const liftTarget = knife.plunged ? -0.007 : aiming ? 0.025 : 0.06;
    knife.lift += (liftTarget - knife.lift) * Math.min(1, delta * 24);
    // The knife is put down once there is nothing left to cut.
    knifeModel.group.visible = carvable();
    knifeModel.group.position.set(knife.x, knife.lift, knife.z);
    const lean = knife.plunged ? Math.min(1, knife.tension) * 0.025 : 0;
    knifeTilt.x += (0.2 + lean - knifeTilt.x) * Math.min(1, delta * 30);
    // A crack is felt as the faintest tremor in the blade, settled at once by the grip.
    knife.shakeVelocity += (-900 * knife.shake - 28 * knife.shakeVelocity) * Math.min(delta, 0.02);
    knife.shake += knife.shakeVelocity * Math.min(delta, 0.02);
    knifeModel.group.rotation.copy(knifeTilt);
    // A sideways cut tips the handle a touch against the push, so the direction reads.
    knife.lean += ((knife.plunged && knife.chosen ? -knife.dir[0] * 0.06 : 0) - knife.lean) * Math.min(1, delta * 12);
    knifeModel.group.rotation.z += knife.lean;
    knifeModel.group.rotation.x += knife.shake;
    knifeModel.group.updateMatrixWorld();
    // The grip breathes while it waits to be pressed, and stays lit while the knife is in.
    gripHint = Math.max(0, gripHint - delta);
    const breathing = carvable() && !knife.plunged && gripHint > 0 && !reducedMotion;
    knifeModel.gripGlow = knife.plunged ? 1 : breathing ? 0.2 + 0.18 * Math.sin(elapsed * 3.5) : 0.15;
    // Fresh stone glows under the tip while cutting, then dulls.
    const fresh = bench.stone.uniforms.fresh.value;
    const [u, v] = toLocal(knife.x, knife.z);
    fresh.x = u + 0.5; fresh.y = 0.5 - v;
    fresh.z += ((knife.plunged ? 1 : 0) - fresh.z) * Math.min(1, delta * (knife.plunged ? 10 : 1.5));
    return breathing || Math.abs(liftTarget - knife.lift) > 0.001 || Math.hypot(knife.targetX - knife.x, knife.targetZ - knife.z) > 0.0005 || Math.abs(knife.shake) > 1e-4 || fresh.z > 0.01;
  }

  // Start.
  const startSeal = seals.find((seal) => seal.id === state.current) ?? seals[0];
  buildBench(startSeal);
  lastStage = currentStage();
  context.reportLoading(0.9);

  let paused = false;
  let elapsed = 0;
  return {
    renderMode: "on-demand",
    update(delta) {
      if (paused) return false;
      elapsed += delta;
      chipClock -= delta; buzzClock -= delta; hintClock -= delta; hovering += delta;
      blowCooldown = Math.max(0, blowCooldown - delta);
      let busy = false;
      if (context.options["auto-carve"] === true) { demoStep(); busy = true; }
      if (held.has("carve") && !knife.plunged) plunge();
      // Keyboard: Up pushes while Space holds the knife in, Down pulls back.
      if (knife.plunged && !knife.chosen) {
        const pick = held.has("ArrowUp") ? [0, -1] : held.has("ArrowLeft") ? [-1, 0] : held.has("ArrowRight") ? [1, 0] : null;
        if (pick) { knife.dir = pick; knife.chosen = true; }
      }
      if (knife.plunged && knife.chosen) {
        const forward = knife.dir[0] > 0 ? "ArrowRight" : knife.dir[0] < 0 ? "ArrowLeft" : "ArrowUp";
        const back = knife.dir[0] > 0 ? "ArrowLeft" : knife.dir[0] < 0 ? "ArrowRight" : "ArrowDown";
        if (held.has(forward)) push(0.18 * delta);
        if (held.has(back)) push(-0.5 * delta);
      }
      let tension = 0;
      if (knife.plunged) { tension = cutStep(delta); busy = true; }
      // The grinding under the blade follows how hard the hand pulls, not how fast it goes.
      knife.speed += (Math.min(1, tension) - knife.speed) * Math.min(1, delta * 20);
      if (knife.plunged && knife.speed > 0.05) sound.scrape(knife.speed); else sound.silence();

      // Turning the stone.
      if (Math.abs(yawTarget - yaw) > 0.0005) {
        yaw = reducedMotion ? yawTarget : THREE.MathUtils.damp(yaw, yawTarget, showcase > 0 ? 1.2 : 12, delta);
        busy = true;
        if (Math.abs(yawTarget - yaw) <= 0.0005) { yaw = yawTarget; draftDirty = true; }
      } else if (yaw !== yawTarget) { yaw = yawTarget; draftDirty = true; }
      stoneRoot.rotation.y = yaw;
      stoneRoot.updateMatrixWorld();
      // The showcase dips the camera to show the sides, then rises again.
      if (showcase > 0) {
        showcase = Math.max(0, showcase - delta);
        const phase = 1 - showcase / 4.2;
        view.elevation = ELEVATION - 0.85 * Math.sin(Math.PI * phase);
        placeCamera();
        busy = true;
        if (showcase === 0) {
          yaw = yawTarget = 0;
          view.elevation = ELEVATION;
          placeCamera();
          if (!bench.viewOnly) openCard();
        }
      }
      busy = poseKnife(delta) || busy;
      updateAimed();
      busy = bench.effects.update(delta) || busy;
      if (labelsDirty) { labelsDirty = false; labels(); }
      busy = hud.update(delta) || busy;
      if (aimed) {
        bench.stone.uniforms.highlightPulse.value = reducedMotion ? 0.6 : 0.45 + 0.25 * Math.sin(elapsed * 5);
        busy = true;
      }
      if (draftDirty) { drawDraft(); draftDirty = false; bench.stone.refresh({ draft: true }); }
      if (maskDirty || dustDirty) { bench.stone.refresh({ mask: maskDirty, dust: dustDirty }); maskDirty = dustDirty = false; }
      if (pointers.size || hovering < 1.5) busy = true;
      return busy;
    },
    resize(next) {
      viewport = next;
      hud.resize(next);
      placeCamera();
    },
    pause() { paused = true; held.clear(); lift(); pointers.clear(); sound.silence(); },
    resume() { paused = false; },
    localeChanged() {
      words = copy[locale()];
      labels();
      if (cardKind) openCard(cardSeal, cardKind);
      if (albumOpen) openAlbum();
    },
    optionChanged(id) {
      if (id === "finish-step" && bench && !bench.viewOnly) {
        lift();
        const stage = currentStage();
        if (stage === "dust") { blownOnce = true; blow(1); }
        else if (stage !== "done") {
          for (const cut of bench.carving.cuts) {
            if (cut.stage !== stage || cut.done) continue;
            for (const { stroke, points } of bench.carving.finish(cut, STAGE_WIDTH[cut.stage])) {
              bench.painter.paint(stroke, points);
              for (const k of points) if (k % 2 === 0) sprinkle(bench.carving.strokePoint(stroke, k), AXES[stroke.axis], WIDTHS[stroke.width], 1, 0.7);
            }
          }
          maskDirty = true;
          afterCuts();
          save();
        }
      }
      if (id === "unlock-all") {
        state.unlockAll = true;
        save();
        if (albumOpen) openAlbum();
      }
      context.invalidate();
    },
    shareText(value) {
      const phrases = copy[value === "zh" ? "zh" : "en"];
      return phrases.share(saving.finishedCount(state)) + (context.cheatsUsed ? phrases.cheats : "");
    },
    dispose() {
      hud.dispose();
      scene.remove(stoneRoot, knifeModel.group, mat, camera);
    },
  };
}
