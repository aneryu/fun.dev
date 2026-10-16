import { seals, layoutSeal, layoutRelief, FACE, STAGES, isGlyph } from "./seals.js";
import { createCarving, createMaskPainter, FINISH, CLEAR_FINISH, CLEAR as CLEAR_GRID, AXES, ANGLES, angleIndex, STEP, hash } from "./carve.js";
import { createStone, stones, HEIGHT } from "./stone.js";
import { createKnife } from "./knife.js";
import { createSound } from "./sound.js";
import { createHud } from "./hud.js";
import { createEffects } from "./effects.js";
import * as saving from "./save.js";

export const options = [
  { id: "line-assist", section: "settings", type: "toggle", default: true, label: { zh: "对线辅助（落刀点靠近稿线时吸到线上）", en: "Line assist (the cutting point settles onto a nearby draft line)" } },
  { id: "finish-step", section: "cheats", type: "action", label: { zh: "完成当前工序", en: "Finish this step" } },
  { id: "unlock-all", section: "cheats", type: "action", label: { zh: "解锁全部印文", en: "Unlock every seal" } },
  { id: "auto-carve", section: "cheats", audience: "debug", type: "toggle", label: { zh: "自动刻（演示）", en: "Carve by itself (demo)" } },
  { id: "test-hook", section: "cheats", audience: "debug", type: "toggle", label: { zh: "测试接口（试玩脚本用）", en: "Test hook (for playtest scripts)" } },
];

const copy = {
  zh: {
    steps: { bevel: "倒边", border: "刻边框", cross: "分格", dust: "吹去石粉", done: "完成" },
    stepNames: { bevel: "倒边", border: "边框", cross: "十字", dust: "吹粉" },
    carveChar: (char) => `刻「${char}」`,
    hints: {
      bevel: "拖刀柄对准线的下端，按住握把往上推",
      border: "横线：在空白处划一圈，把印石转过来",
      cross: "刻一个十字，分成四格",
      glyph: "顺着红线往上推，铲掉字旁的空地；转石刻横线",
      dust: "点「吹」，把石粉吹干净",
      done: "刻好了",
    },
    stepDone: (name) => `${name}完成`, stepNext: (done, next) => `${done}完成 · 下一步：${next}`,
    intro: (n, title) => `${n} · 「${title}」`, introDetail: (stone) => `${stone} · 倒边 边框 十字 刻字 铲底 吹粉`, begin: "开始刻",
    offFace: "刀尖要在印面上才能下刀",
    nth: (n) => `第${["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"][n] ?? n + 1}方`,
    blow: "吹", album: "印谱", left: "‹", right: "›",
    finished: (title) => `「${title}」刻成`, cardDetail: (stone) => `${stone} · 已收入印谱`,
    next: "刻下一方", stay: "再看看", close: "关闭", back: "回去刻", view: "看印石", recarve: "重刻这一方", sure: "确定重刻？", restart: "重刻", undo: "撤销", proof: "试印", proofTitle: (title) => `试印「${title}」`, proofDetail: (pct) => `已刻 ${pct}%`, keepCarving: "继续刻",
    undone: "撤销了一刀", redoTitle: "重刻", redoDetail: "刀痕会清掉，石粉留着", redoStage: (name) => `重刻「${name}」`, redoSeal: "整方重来", cancel: "取消",
    redone: (name) => `「${name}」重新开始`, restarted: "这一方重新开始",
    albumTitle: (count, total) => `印谱 ${count}/${total}`, albumDetail: "点一方印：刻完的看印蜕，没刻完的接着刻", locked: "？",
    allDone: "全部刻完了！可以在印谱里挑一方重刻",
    viewing: (title) => `看「${title}」`,
    keys: "方向键移动刀尖；R 转刀；按住空格下刀，同时按刀口方向的方向键推、反方向往回拉，松开提刀；Z 撤销，Q 和 E 转动印石，B 吹石粉，A 打开印谱",
    canvas: (title, step, progress) => `刻一方印：${title}。${step}，已刻 ${progress}%`,
    noSave: "当前容器不支持存档", unavailable: "声音不可用",
    share: (count) => `我在 fun.dev 刻了 ${count} 方印`, cheats: "（开了秘籍）",
  },
  en: {
    steps: { bevel: "Chamfer", border: "Border", cross: "Divide", dust: "Blow", done: "Done" },
    stepNames: { bevel: "Edge", border: "Border", cross: "Cross", dust: "Blow" },
    carveChar: (char) => `Carve ${char}`,
    hints: {
      bevel: "Handle to a line's lower end; hold the grip, push up",
      border: "Lines across: circle the bare ground to turn the stone",
      cross: "Cut a cross into four cells",
      glyph: "Push up the red lines to cut away the ground; turn for the rest",
      dust: "Tap Blow to clear the powder",
      done: "Finished",
    },
    stepDone: (name) => `${name} done`, stepNext: (done, next) => `${done} done · next: ${next}`,
    intro: (n, title) => `${n} · ${title}`, introDetail: (stone) => `${stone} · six steps, edge to blow`, begin: "Start",
    offFace: "Aim at the face before pressing the knife in",
    nth: (n) => `Seal ${n + 1}`,
    blow: "Blow", album: "Seals", left: "‹", right: "›",
    finished: (title) => `“${title}” is carved`, cardDetail: (stone) => `${stone} · added to your seals`,
    next: "Next seal", stay: "Look again", close: "Close", back: "Carve", view: "See stone", recarve: "Carve again", sure: "Sure?", restart: "Redo", undo: "Undo", proof: "Proof", proofTitle: (title) => `Proof of ${title}`, proofDetail: (pct) => `${pct}% carved`, keepCarving: "Carry on",
    undone: "Undid a cut", redoTitle: "Redo", redoDetail: "The cuts go; the powder stays", redoStage: (name) => `Redo ${name}`, redoSeal: "Whole seal", cancel: "Cancel",
    redone: (name) => `${name} starts over`, restarted: "Starting this seal over",
    albumTitle: (count, total) => `Seals ${count}/${total}`, albumDetail: "Tap a seal: finished ones show their print", locked: "?",
    allDone: "All seals carved! Pick one in Seals to carve it again",
    viewing: (title) => `Viewing “${title}”`,
    keys: "Arrow keys move the knife tip; R turns the knife; hold Space to put it in, the arrow its edge points to pushes and the opposite one pulls back, let go to lift it; Z undoes, Q and E turn the stone, B blows the powder, A opens your seals",
    canvas: (title, step, progress) => `Carve a Seal: ${title}. ${step}, ${progress}% carved`,
    noSave: "This host does not support saving", unavailable: "Sound unavailable",
    share: (count) => `I've carved ${count} seals on fun.dev`, cheats: " (with cheats)",
  },
};

// The knife's two headings, as world x, z axes: its edge cuts along one of them either way;
// 转刀 switches between them. The handle leans back along the axis.
const HEADINGS = [[0, -1]]; // the knife pushes up the screen, away from the carver (冲刀)
const SPIN_MIN_PX = 40; // nearer the stone's centre than this, a sideways drag turns it
const SPIN_DRAG_PX = 160; // sideways CSS px per quarter turn near the centre
// 角度依附: the stone turns freely, settling softly every 15° and firmly at each quarter turn.
const NOTCH = Math.PI / 12; // 15°
const NOTCH_HOLD = 0.035; // radians either side of a 15° notch where it settles (~2°)
const DETENT = 0.1; // radians either side of a quarter turn where it settles (~6°)
const NOTCH_RELEASE = 0.07; // let go within ~4° of a notch and it settles onto it
const SNAP_PX = 16; // line assist: how near (CSS px) the cutting point must come to a draft line
const KNIFE_HIT_PX = 36; // a finger this close to the knife picks it up
const DIRECTION_PX = 8; // the first push this long picks the cut's direction
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
  // A carver's pad, a defined object on the yellow table, reaching toward the viewer where
  // the knife's handle rests.
  const mat = new THREE.Mesh(track(new THREE.BoxGeometry(1.5, 0.06, 2.3)), matMaterial);
  mat.position.set(0, -HEIGHT - 0.03, 0.45);
  mat.receiveShadow = true;
  scene.add(mat);

  const stoneRoot = new THREE.Group(); // turned by the player
  scene.add(stoneRoot);
  const knifeModel = createKnife({ THREE, track });
  // As large against the face as in the video, where the grip is about a quarter of its width.
  const KNIFE_SCALE = 1.1;
  knifeModel.group.scale.setScalar(KNIFE_SCALE);
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
    const carving = createCarving(layoutSeal(seal), WIDTHS, layoutRelief(seal));
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
    // The character being carved: its ground still standing, faintly; the strokes stay ink.
    if (isGlyph(stage)) {
      const { carving } = bench, char = Number(stage.slice(5)), cell = size / CLEAR_GRID;
      g.fillStyle = "rgb(40,0,0)";
      for (let index = 0; index < carving.cleared.length; index++) {
        if (carving.charOf[index] !== char || carving.cleared[index]) continue;
        const [u, v] = carving.clearCell(index);
        g.fillRect((u + 0.5) * size - cell / 2, (v + 0.5) * size - cell / 2, cell + 0.5, cell + 0.5);
      }
    }
    for (const cut of bench.carving.cuts) {
      if (cut.stage !== stage || cut.done) continue;
      // Bold enough to see at a glance on a phone.
      g.strokeStyle = "#ff0000";
      g.lineWidth = Math.max(4, cut.width * size * 0.6);
      g.beginPath();
      g.moveTo((cut.a[0] + 0.5) * size, (cut.a[1] + 0.5) * size);
      g.lineTo((cut.b[0] + 0.5) * size, (cut.b[1] + 0.5) * size);
      g.stroke();
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
    const carving = createCarving(layoutSeal(seal), WIDTHS, layoutRelief(seal));
    try { carving.restore(saved.cuts); } catch { return null; }
    const maskCanvas = new OffscreenCanvas(512, 512);
    createMaskPainter(carving, maskCanvas.getContext("2d"), 512).paintAll();
    const texture = makePrint(maskCanvas);
    prints.set(seal.id, texture);
    return texture;
  }
  function refreshPrint(seal) { prints.get(seal.id)?.dispose(); prints.delete(seal.id); }
  // The print a seal will make once carved: every cut finished and the ground cleared.
  const targets = new Map();
  onCleanup(() => { for (const texture of targets.values()) texture.dispose(); });
  function targetOf(seal) {
    if (targets.has(seal.id)) return targets.get(seal.id);
    const carving = createCarving(layoutSeal(seal), WIDTHS, layoutRelief(seal));
    for (const cut of carving.cuts) carving.finish(cut, widthCode(cut.stage));
    for (let char = 0; char < 4; char++) carving.finishCharacter(char);
    const maskCanvas = new OffscreenCanvas(256, 256);
    createMaskPainter(carving, maskCanvas.getContext("2d"), 256).paintAll();
    const texture = makePrint(maskCanvas);
    targets.set(seal.id, texture);
    return texture;
  }

  // Saving: whenever the knife lifts, a few kilobytes.
  function save() {
    if (!bench.viewOnly) state.seals[bench.seal.id] = { ...state.seals[bench.seal.id], cuts: bench.carving.serialize(), done: Boolean(state.seals[bench.seal.id]?.done) };
    if (progress) void progress.save(saving.serialize(state)).catch(() => { /* The player shows the failure and keeps an exportable snapshot. */ });
  }

  // Camera: looking down at the face from the front, steeply, so the face fills the stage and
  // a strip of the carved side shows below it.
  const ELEVATION = 1.5; // about 86°: the face square to the screen, the stone's sides out of sight
  const view = { elevation: ELEVATION, azimuth: 0, distance: 4, target: new THREE.Vector3(0, -0.08, 0) };
  let viewport = context.viewport;
  const cameraUp = new THREE.Vector3(), cameraRight = new THREE.Vector3();
  // Close-up: while a character is carved the camera closes in on its cell, as the video does,
  // so its grooves are far enough apart for a finger. focus eases toward the wanted framing.
  const FOCUS_SCALE = 0.42; // camera distance while carving a character, against the whole face
  const focus = { x: 0, z: 0, scale: 1 };
  const focusTarget = new THREE.Vector3();
  // The stone's turning centre, in its own coordinates: the character in the close-up.
  const pivot = { u: 0, v: 0 };
  function pivotFor() {
    const stage = bench && !bench.viewOnly && showcase <= 0 ? currentStage() : "";
    if (!isGlyph(stage)) return { u: 0, v: 0 };
    const [u0, v0, u1, v1] = bench.carving.relief.cells[Number(stage.slice(5))];
    return { u: (u0 + u1) / 2, v: (v0 + v1) / 2 };
  }
  function wantedFocus() {
    const stage = bench && !bench.viewOnly && showcase <= 0 ? currentStage() : "";
    if (!isGlyph(stage)) return { x: 0, z: 0, scale: 1 };
    // The pivot does not move as the stone turns, so the close-up holds still.
    const { u, v } = pivotFor();
    return { x: u, z: v, scale: FOCUS_SCALE };
  }
  // Eases the framing; returns true while it moves.
  function easeFocus(delta) {
    const want = wantedFocus();
    const rate = reducedMotion ? 1 : Math.min(1, delta * 4);
    const before = { ...focus };
    focus.x += (want.x - focus.x) * rate; focus.z += (want.z - focus.z) * rate; focus.scale += (want.scale - focus.scale) * rate;
    if (Math.abs(want.x - focus.x) + Math.abs(want.z - focus.z) + Math.abs(want.scale - focus.scale) < 1e-4) Object.assign(focus, want);
    // Each part on its own: a diagonal glide (x up, z down) leaves their sum unchanged.
    const moved = Math.abs(focus.x - before.x) + Math.abs(focus.z - before.z) + Math.abs(focus.scale - before.scale) > 1e-6;
    if (moved) placeCamera();
    // The knife keeps its size on screen however close the camera comes.
    knifeModel.group.scale.setScalar(KNIFE_SCALE * focus.scale);
    return moved;
  }

  function placeCamera() {
    const { width, height } = viewport;
    const stage = hud.stage;
    const stageWidth = stage.right - stage.left, stageHeight = stage.bottom - stage.top;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    // Visible height and width (world units at the target) needed for the face and some side.
    // As in the video, the face takes about two thirds of the width, with room around it.
    const needH = 1.8 / (2 * tan) * (height / stageHeight);
    const needW = 1.6 / (2 * tan * (width / height)) * (width / stageWidth);
    view.distance = Math.max(needH, needW, 2) * (view.zoom ?? 1) * focus.scale;
    const { elevation, azimuth, distance } = view;
    const target = focusTarget.set(view.target.x + focus.x, view.target.y, view.target.z + focus.z);
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
  // The stone sits square (and still) at a quarter turn: only then does the knife go in.
  // The stone is still: the knife may go in at whatever angle it rests.
  const settled = () => Math.abs(yawTarget - yaw) < 0.005;
  // A step's names: the line steps by name, each character step by its character.
  const charOf = (stage) => [...bench.seal.text.zh][Number(stage.slice(5))];
  const stageLabel = (stage) => isGlyph(stage) ? words.carveChar(charOf(stage)) : words.steps[stage];
  const stageShort = (stage) => isGlyph(stage) ? charOf(stage) : words.stepNames[stage];
  const stageHint = (stage) => words.hints[isGlyph(stage) ? "glyph" : stage];
  const widthCode = (stage) => isGlyph(stage) ? 2 : STAGE_WIDTH[stage];
  function currentStage() { return bench.viewOnly || state.seals[bench.seal.id]?.done ? "done" : bench.carving.stage(); }
  const carvable = () => bench && !bench.viewOnly && !["dust", "done"].includes(currentStage());

  // The knife's tracks: up, down, left or right on the screen. The first push after the knife
  // goes in picks one, and that cut keeps to it. Every draft line
  // lies along one of them while the stone sits square; turning is only for comfort.
  const trackDirection = new THREE.Vector3();
  function localTrack(sign = 1) {
    trackDirection.set(knife.dir[0] * sign, 0, knife.dir[1] * sign).applyAxisAngle(UP, -yaw);
    return [trackDirection.x, trackDirection.z];
  }
  function aligned(cut) {
    if (!settled()) return false;
    const [x, z] = localTrack();
    return Math.abs(cut.direction[0] * x + cut.direction[1] * z) > 0.98;
  }
  const strokeDirection = (stroke) => { const a = stroke.angle / ANGLES * Math.PI * 2; return [Math.cos(a), Math.sin(a)]; };
  function axisOf(sign = 1) {
    const [x, z] = localTrack(sign);
    return angleIndex(x, z);
  }

  // The knife, in world coordinates (it stays with the hand while the stone turns under it).
  const knife = {
    x: 0.1, z: 0.2, targetX: 0.1, targetZ: 0.2, lift: 0.05, // ready on the face
    plunged: false, origin: null, stroke: null, travel: 0, touched: new Set(), cut: false,
    wobble: 0, kick: 0, speed: 0, tension: 0, shake: 0, shakeVelocity: 0,
    dir: [0, 1], // world direction of this cut: the knife's heading
    heading: 0, // index in HEADINGS
    headingAngle: 0, // the handle's turn about the vertical, unwrapped so it turns the short way
    chosen: false, // whether the first push has picked the direction yet
    lean: 0, // how the handle tips into a sideways push
    at: 0, hand: 0, strength: 0.006, hard: false, refractory: 0,
  };
  const onFace = (x, z) => { const [u, v] = toLocal(x, z); return Math.abs(u) <= 0.5 && Math.abs(v) <= 0.5; };

  function plunge(quiet = false) {
    if (knife.plunged || !carvable() || !settled()) return false;
    if (!onFace(knife.x, knife.z)) { if (!quiet) hint(words.offFace); return false; }
    knife.plunged = true;
    knife.origin = { x: knife.x, z: knife.z };
    knife.strokes = [null, null]; // grooves ahead of the start (along the heading) and behind it
    knife.fwd = 0; knife.back = 0; // how far each has been cut
    knife.at = 0;
    knife.hand = 0;
    knife.touched = new Set();
    knife.cut = false;
    knife.wobble = 0;
    knife.kick = 0;
    knife.dir = HEADINGS[knife.heading];
    knife.chosen = true;
    if (checkpoints.at(-1) !== bench.carving.strokes.length) checkpoints.push(bench.carving.strokes.length);
    knife.refractory = 0;
    knife.tension = 0;
    nextStrength(stones[bench.seal.stone].carve);
    if (!quiet) {
      sound.tap();
      context.haptics.vibrate("tap");
      layoutButtons();
    }
    return true;
  }

  // Between strokes in the stone: finish what is nearly cut, save, and set the knife again where
  // it stands, so the next stroke starts there and may take a new track.
  // Undo: the stroke count at the start of each swipe in the stone, newest last (this session).
  const checkpoints = [];
  function reset() {
    lift(true);
    if (!plunge(true)) layoutButtons(); // off the face: back to moving
  }

  // Lifts the knife: cuts it covered nearly all of are finished off, and the work is saved.
  function lift(quiet = false) {
    if (!knife.plunged) return;
    knife.plunged = false;
    if (!quiet) { gripHint = 0; layoutButtons(); }
    // The knife stays where the cut ended.
    knife.targetX = knife.aimX = knife.x; knife.targetZ = knife.aimZ = knife.z;
    const finished = [];
    for (const cut of knife.touched) {
      if (cut.done || bench.carving.coverage(cut) < FINISH) continue;
      for (const { stroke, points } of bench.carving.finish(cut, widthCode(cut.stage))) bench.painter.paint(stroke, points);
      maskDirty = true;
      finished.push(cut);
    }
    if (finished.length) afterCuts();
    groundCheck();
    if (knife.cut) save();
    gripHint = 6;
  }

  // The knife in the stone is a stick-slip system, tuned to the carving video's sound (pushes
  // of 0.25–0.45 s, each a burst of cracks 15–40 ms apart). The hand pushes the tip along the
  // knife's axis, either way, through a spring: the tip stays stuck while the pull is below the
  // stone's strength there, then a flake breaks off and the tip jumps ahead by the flake's
  // length. Along the groove already cut it slides freely. Nothing of the push is lost: far
  // behind the hand, flakes break back to back until the tip catches up.
  const CATCH_UP = 2.5; // a pull this many times the stone's strength breaks flakes back to back
  const SUBSTEP = 0.004; // seconds per simulation step
  const SLIDE = 1.5; // face units per second the tip slides along an open groove
  let chipClock = 0, buzzClock = 0;
  function nextStrength(carve) {
    knife.hard = Math.random() < carve.hardSpots; // a sand grain (砂丁): the knife stalls, then a big flake
    knife.strength = carve.stretch * (0.6 + 0.8 * Math.random()) * (knife.hard ? 2.2 : 1);
  }
  // Moves the hand along the knife's axis by `distance` face units (along the heading positive).
  function push(distance) {
    knife.hand += distance;
  }
  function cutStep(delta) {
    const carve = stones[bench.seal.stone].carve;
    const cracks = [];
    for (let time = delta; time > 1e-6; time -= SUBSTEP) {
      const dt = Math.min(SUBSTEP, time);
      knife.refractory -= dt;
      // Within the groove already cut, the tip slides toward the hand.
      const lo = -knife.back, hi = knife.fwd;
      const goal = Math.max(lo, Math.min(hi, knife.hand));
      if (Math.abs(goal - knife.at) > 1e-6) {
        knife.at += Math.max(-SLIDE * dt, Math.min(SLIDE * dt, goal - knife.at));
        continue;
      }
      // It carves only pushed forward; drawn back it slides down its groove, no further.
      const sign = knife.hand > hi + 1e-6 ? 1 : 0;
      if (!sign) continue;
      const pull = Math.abs(knife.hand - knife.at);
      // Stuck, under tension, until the pull breaks a flake.
      if (pull < knife.strength || (knife.refractory > 0 && pull < knife.strength * CATCH_UP)) continue;
      const length = Math.min(pull, carve.chip * (0.5 + 1.3 * Math.random()) * (knife.hard ? 2.4 : 1));
      const next = knife.at + sign * length;
      // The face's edge stops the knife.
      if (!onFace(knife.origin.x + knife.dir[0] * next, knife.origin.z + knife.dir[1] * next)) { knife.hand = knife.at + sign * knife.strength * 0.95; break; }
      cracks.push({ size: Math.min(1, length / (carve.chip * 2.5)), force: Math.min(1, pull / (carve.stretch * 2)), sign });
      knife.at = next;
      if (sign > 0) knife.fwd = next; else knife.back = -next;
      knife.refractory = 0.01 + Math.random() * 0.016;
      // The flake nudges the blade sideways a little; it stays in the groove's wobble.
      knife.kick = (Math.random() - 0.5) * length * 0.12;
      nextStrength(carve);
    }
    // Along the axis, plus the wobble across it.
    knife.x = knife.origin.x + knife.dir[0] * knife.at - knife.dir[1] * knife.wobble;
    knife.z = knife.origin.z + knife.dir[1] * knife.at + knife.dir[0] * knife.wobble;
    const atEnd = knife.at >= knife.fwd - 1e-6 || knife.at <= -knife.back + 1e-6;
    knife.tension = atEnd ? Math.min(1.5, Math.abs(knife.hand - knife.at) / Math.max(knife.strength, 1e-4)) : 0;
    for (const sign of [1, -1]) {
      const own = cracks.filter((crack) => crack.sign === sign);
      if (own.length) carveTo(own, sign);
    }
    return knife.tension;
  }

  // Grows the groove on one side of the start to the tip after cracks, with everything the
  // cracks throw off.
  function carveTo(cracks, sign) {
    const reach = sign > 0 ? knife.fwd : knife.back;
    if (reach < STEP * 0.5) return;
    const { carving } = bench;
    const side = sign > 0 ? 0 : 1;
    // Cutting characters the knife has two edges, one each side of the stroke it follows,
    // so a pass along a stroke cuts both its outlines; otherwise a single edge.
    if (!knife.strokes[side]) {
      const [u, v] = toLocal(knife.origin.x, knife.origin.z);
      knife.strokes[side] = [carving.beginStroke(u, v, axisOf(sign), widthCode(currentStage()), STAGES.indexOf(currentStage()))];
    }
    let stroke = null, points = [];
    const cuts = [];
    for (const edge of knife.strokes[side]) {
      const [dx, dy] = strokeDirection(edge);
      scratch.set(-knife.dir[1] * (knife.wobble + knife.kick), 0, knife.dir[0] * (knife.wobble + knife.kick)).applyAxisAngle(UP, -yaw);
      const offset = scratch.x * -dy + scratch.z * dx;
      const grown = carving.extend(edge, reach, offset);
      cuts.push(...grown.cuts);
      if (grown.points.length) bench.painter.paint(edge, grown.points);
      if (!stroke) { stroke = edge; points = grown.points; }
    }
    const [dx, dy] = strokeDirection(stroke);
    if (points.length) {
      knife.cut = true;
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
      if (crack === cracks[0] || crack === cracks[cracks.length - 1]) sound.chip(crack.size, crack.force);
      if (buzzClock <= 0) { context.haptics.vibrate([Math.round(6 + crack.size * 18)]); buzzClock = 0.03; }
    }
    for (const cut of cuts) knife.touched.add(cut);
    if (carving.settle(cuts).length) afterCuts();
    groundCheck();
  }

  // A character whose ground is nearly cleared: the rest is cleared for the carver.
  function groundCheck() {
    const ground = bench.carving.settleGround();
    if (ground.cleared.length) { bench.painter.paintClear(ground.cleared); maskDirty = true; }
    if (ground.characters.length) { draftDirty = true; afterCuts(); }
  }

  // Rewrites the carving (undo, redo a step) with the knife out of the stone meanwhile.
  function rewrite(change) {
    const wasIn = knife.plunged;
    lift(true);
    change(bench.carving);
    while (checkpoints.length && checkpoints.at(-1) > bench.carving.strokes.length) checkpoints.pop();
    bench.painter.paintAll();
    maskDirty = draftDirty = true;
    lastStage = currentStage();
    save();
    if (wasIn) plunge(true);
    labels();
  }
  function undo() {
    const count = bench.carving.strokes.length;
    if (!count) return;
    // Back to the start of the last swipe; with no swipe this session, one stroke back.
    let target = checkpoints.at(-1) ?? count - 1;
    if (target >= count) { checkpoints.pop(); target = checkpoints.at(-1) ?? count - 1; }
    if (target >= count) target = count - 1;
    rewrite((carving) => carving.rewind(target));
    checkpoints.pop();
    hud.toast(words.undone);
  }
  // The step to redo: the current one if anything of it is cut, else the last step cut.
  function redoStage() {
    const stages = STAGES.slice(0, 7);
    const cut = new Set(bench.carving.strokes.map((stroke) => stages[stroke.stage]));
    const current = currentStage();
    if (cut.has(current)) return current;
    return stages.filter((name) => cut.has(name)).at(-1) ?? null;
  }

  let lastStage = null;
  let labelsDirty = false;
  function afterCuts() {
    sound.tap();
    draftDirty = true;
    const stage = currentStage();
    if (stage !== lastStage) {
      if (lastStage && lastStage !== "done") {
        const message = stage === "done" ? words.stepDone(stageLabel(lastStage)) : words.stepNext(stageLabel(lastStage), stageLabel(stage));
        hud.toast(message);
        context.announce(message);
        context.haptics.vibrate("success");
      }
      lastStage = stage;
      // A new character: the knife moves to the lower middle of its cell.
      if (isGlyph(stage)) knife.recentre = true; // once the stone has settled about the new pivot
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
      const width = WIDTHS[widthCode(currentStage())];
      for (const cut of snapLines()) {
        if (!aligned(cut)) continue;
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

  // A fresh seal opens with what it will become: its print, its stone and the six steps.
  function openIntro() {
    const seal = bench.seal;
    cardKind = "intro";
    cardSeal = seal;
    hud.setCard({
      title: words.intro(words.nth(seals.indexOf(seal)), text(seal.text)),
      detail: words.introDetail(text(stones[seal.stone].name)),
      picture: targetOf(seal),
      buttons: [{ id: "begin", label: words.begin }],
    });
    setFocusable();
  }
  const fresh = () => bench && !bench.viewOnly && !bench.carving.strokes.length && !state.seals[bench.seal.id]?.done;

  let cardKind = null; // "finished" | "seal" (opened from the album) | "intro" | "redo"
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
        return { id: seal.id, picture: done ? printOf(seal) : open ? targetOf(seal) : null, label: open ? text(seal.text) : words.locked, current, open, pending: open && !done };
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
    if (fresh()) openIntro();
  }

  function viewSeal(seal) {
    buildBench(seal, true);
    yaw = 0; yawTarget = reducedMotion ? 0 : Math.PI * 2;
    showcase = reducedMotion ? 0 : 4.2;
    layoutButtons();
  }

  // Where the handle leans: up the screen while the knife is upright; across, toward the
  // middle of the screen, so it never ends up off screen (the knife cuts either way, so the
  // side does not matter to the cut). Decided when the knife turns or is let go, never while
  // a finger holds it. The angle is unwrapped so the handle swings the short way round.
  function aimHandle() {
    knife.headingAngle = 0; // the knife always stands the same way; the stone turns under it
  }

  function turn(direction) {
    if (knife.plunged) return;
    yawTarget = Math.round(yawTarget / NOTCH) * NOTCH + direction * NOTCH;
    sound.tap();
    afterTurn();
  }
  // The stone came to rest at a new quarter: the knife's point may now lie on other lines.
  function afterTurn() {
    draftDirty = true;
    knife.aimX = knife.targetX; knife.aimZ = knife.targetZ;
  }

  // Controls live where the finger already is: the knife's handle moves it and its grip
  // carves; turn and undo badges sit either side just below the cutting point; in the
  // last step a Blow badge sits on the face. Only the rare actions (album, redo) wait in the
  // top corner.
  function layoutButtons() {
    hud.setButtons([]);
    if (bench?.viewOnly) hud.setCorner([{ id: "album", label: words.album }, { id: "back", label: words.back }]);
    else if (bench && currentStage() !== "done") hud.setCorner([{ id: "album", label: words.album }, { id: "proof", label: words.proof }, { id: "redo", label: words.restart, quiet: true }]);
    else hud.setCorner([{ id: "album", label: words.album }]);
    badgeKey = null; // redraw the badges on the next frame
  }

  // Badge positions follow the knife each frame; the HUD is only touched when they move.
  let badgeKey = null, lastMarker = "", shownBadges = [];
  const badgePoint = new THREE.Vector3();
  function placeBadges() {
    const list = [];
    const { width, height, safeArea } = viewport;
    const stage = hud.stage;
    const clamp = ([x, y], r) => [Math.max(safeArea.left + r + 6, Math.min(width - safeArea.right - r - 6, x)), Math.max(stage.top + r, Math.min(height - safeArea.bottom - r - 6, y))];
    if (bench && !bench.viewOnly && currentStage() === "dust") {
      const center = screenOf(...toWorld(0, 0));
      const below = screenOf(...toWorld(0, 0.5));
      list.push({ id: "blow", label: words.blow, x: center[0], y: Math.min(viewport.height - viewport.safeArea.bottom - 40, below[1] + 52), radius: 30, active: true });
    } else if (carvable() && !hud.modal) {
      // Undo, just beside and below the cutting point; the clearing has none.
      const tip = screenOf(knife.x, knife.z);
      // To the left of the point, clear of the handle, which leans down and to the right.
      const undoAt = clamp([tip[0] - 54, tip[1] - 10], 18);
      if (bench.carving.strokes.length) list.push({ id: "undo", label: "↶", x: undoAt[0], y: undoAt[1] });
    }
    shownBadges = list;
    const key = list.map((entry) => `${entry.id}${Math.round(entry.x)},${Math.round(entry.y)}`).join(";") || "none";
    if (key !== badgeKey) { badgeKey = key; hud.setBadges(list); }
    // The cutting point, where the groove will start, its width and its way.
    if (carvable()) {
      const tip = screenOf(knife.x, knife.z);
      const [hx, hz] = HEADINGS[knife.heading];
      const ahead = screenOf(knife.x + hx * 0.05, knife.z + hz * 0.05);
      const angle = Math.atan2(-(ahead[1] - tip[1]), ahead[0] - tip[0]);
      const edge = WIDTHS[widthCode(currentStage())] * pixelsPer().x;
      const markerKey = `${tip[0].toFixed(1)},${tip[1].toFixed(1)},${angle.toFixed(2)},${edge.toFixed(1)},${knife.plunged}`;
      if (markerKey !== lastMarker) { lastMarker = markerKey; hud.setMarker({ x: tip[0], y: tip[1], angle, edge, active: knife.plunged }); }
    } else if (lastMarker) { lastMarker = ""; hud.setMarker(null); }
  }

  // 试印: the seal pressed on paper as it stands now, to see the carving so far the right way
  // round. The print is made from the face's groove mask as it is.
  let proofTexture = null;
  onCleanup(() => proofTexture?.dispose());
  function openProof() {
    lift();
    proofTexture?.dispose();
    proofTexture = makePrint(bench.stone.mask.canvas);
    cardKind = "proof";
    cardSeal = bench.seal;
    sound.tap();
    hud.setCard({
      title: words.proofTitle(text(bench.seal.text)),
      detail: words.proofDetail(Math.round(bench.carving.progress() * 100)),
      picture: proofTexture,
      buttons: [{ id: "proof-close", label: words.keepCarving }],
    });
    setFocusable();
  }

  // The redo card: this step again, or the whole seal.
  function openRedo() {
    const stage = redoStage();
    cardKind = "redo";
    hud.setCard({
      title: words.redoTitle, detail: words.redoDetail, picture: null,
      buttons: [
        ...(stage ? [{ id: `redo-stage:${stage}`, label: words.redoStage(stageShort(stage)) }] : []),
        { id: "redo-seal", label: words.redoSeal },
        { id: "redo-cancel", label: words.cancel },
      ],
    });
    setFocusable();
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
      case "undo": undo(); break;
      case "redo": openRedo(); break;
      case "redo-cancel": closeCard(); break;
      case "proof": openProof(); break;
      case "proof-close": closeCard(); break;
      case "redo-seal":
        closeCard();
        lift(true);
        state.seals[bench.seal.id] = { cuts: null, done: false };
        refreshPrint(bench.seal);
        checkpoints.length = 0;
        carveSeal(bench.seal);
        hud.toast(words.restarted);
        break;
      case "album": openAlbum(); break;
      case "close-album": closeAlbum(); break;
      case "back": carveSeal(seals.find((seal) => seal.id === state.current)); break;
      case "begin": closeCard(); gripHint = 6; break;
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
        if (action.startsWith("redo-stage:")) {
          const stage = action.slice(11);
          closeCard();
          rewrite((carving) => carving.removeStage(stage));
          hud.toast(words.redone(stageShort(stage)));
        }
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
    const order = STAGES.slice(0, 8);
    const at = stage === "done" ? order.length : order.indexOf(stage);
    const steps = bench.viewOnly ? [] : order.map((name, index) => {
      const cuts = bench.carving.cuts.filter((cut) => cut.stage === name);
      const fill = isGlyph(name) ? Math.min(1, bench.carving.clearCoverage(Number(name.slice(5))) / CLEAR_FINISH) : cuts.length ? cuts.reduce((sum, cut) => sum + cut.carved / cut.count, 0) / cuts.length : 0;
      return { name: stageShort(name), state: index < at ? "done" : index === at ? "current" : "todo", fill };
    });
    hud.setStatus({ title, steps, hint: bench.viewOnly || stage === "done" ? "" : stageHint(stage) });
    const parts = [words.canvas(text(bench.seal.text), stageLabel(stage), Math.round(bench.carving.progress() * 100)), words.keys];
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
  // The knife stays where it can be seen and reached: its point within the stage on screen.
  const clampAim = () => {
    knife.targetX = Math.max(-0.7, Math.min(0.7, knife.targetX));
    knife.targetZ = Math.max(-0.7, Math.min(0.7, knife.targetZ));
    const [sx, sy] = screenOf(knife.targetX, knife.targetZ);
    const stage = hud.stage, margin = 24;
    const cx = Math.max(stage.left + margin, Math.min(stage.right - margin, sx)), cy = Math.max(stage.top + margin, Math.min(stage.bottom - margin * 4, sy));
    if (cx !== sx || cy !== sy) {
      const p = worldPoint(cx, cy);
      if (p) { knife.targetX = p[0]; knife.targetZ = p[1]; }
    }
  };
  const clampWobble = (value) => {
    const limit = WIDTHS[widthCode(currentStage()) ?? 2] * 0.3;
    return Math.max(-limit, Math.min(limit, value));
  };
  function aimAt(x, y) {
    const p = worldPoint(x, y);
    if (!p) return;
    knife.targetX = knife.aimX = p[0]; knife.targetZ = knife.aimZ = p[1];
    clampAim();
    snapAim();
  }
  // Line assist: when the cutting point comes within a few pixels of an open draft line of this
  // step that lies along the knife's axis, it settles onto the line, and onto its end when near
  // one. The marker shows where it settled, so what is shown is what will be cut.
  // What the cutting point settles onto: open lines (or character guides) of the step.
  function snapLines() {
    return bench.carving.cuts.filter((cut) => cut.stage === currentStage() && !cut.done);
  }
  function snapAim() {
    if (context.options["line-assist"] === false || knife.plunged || !carvable() || knife.aimX === undefined) return;
    knife.targetX = knife.aimX; knife.targetZ = knife.aimZ;
    const [u, v] = toLocal(knife.aimX, knife.aimZ);
    scratch.set(HEADINGS[knife.heading][0], 0, HEADINGS[knife.heading][1]).applyAxisAngle(UP, -yaw);
    const axis = [scratch.x, scratch.z];
    const scale = pixelsPer().x;
    let best = null, bestDistance = SNAP_PX;
    for (const cut of snapLines()) {
      if (Math.abs(cut.direction[0] * axis[0] + cut.direction[1] * axis[1]) < 0.98) continue;
      const { t, distance } = bench.carving.project(cut, u, v);
      const outside = Math.max(0, -t, t - 1) * cut.length * scale;
      const across = Math.abs(distance) * scale;
      if (outside > SNAP_PX || across > bestDistance) continue;
      best = { cut, t }; bestDistance = across;
    }
    if (!best) return;
    const { cut } = best;
    let t = Math.max(0, Math.min(1, best.t));
    // Onto the nearer end only, so a short line never sends the point to its far end.
    if (t < 0.5 && t * cut.length * scale < SNAP_PX) t = 0;
    else if (t >= 0.5 && (1 - t) * cut.length * scale < SNAP_PX) t = 1;
    const [x, z] = toWorld(...bench.carving.point(cut, t));
    knife.targetX = x; knife.targetZ = z;
  }

  // Touch: a finger on the knife (or resting just below its tip) drives it into the stone, and
  // pushing along a line carves; lifting it lifts the knife. A finger anywhere else brings the
  // knife to it, tip just above the fingertip, and drags it there.
  // With a mouse the tip follows the cursor; the button drives it in and dragging up carves.
  // Touching the knife's handle drags it about; touching its red grip (or the blade) drives it
  // into the stone, and the finger (or mouse) then pushes it one to one. The first clear
  // stroke picks the track, up, down, left or right; along it the knife
  // carves, back along it slides back down its groove, across it only wobbles. Lifting the
  // finger leaves the knife in the stone, ready for the next stroke.
  // The knife has two zones: the red grip and the blade below it cut ("cut"), the wrapped
  // handle above drags it ("move"). Returns the zone under a screen point, or null.
  const gripPoint = new THREE.Vector3(), topPoint = new THREE.Vector3();
  function segmentDistance(x, y, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1], length2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / length2));
    return Math.hypot(x - a[0] - vx * t, y - a[1] - vy * t);
  }
  function knifeZone(x, y) {
    gripPoint.copy(knifeModel.grip.center).applyMatrix4(knifeModel.group.matrixWorld);
    topPoint.copy(knifeModel.top).applyMatrix4(knifeModel.group.matrixWorld);
    const tip = screenOf(knife.x, knife.z, knife.lift);
    const grip = screenOf(gripPoint.x, gripPoint.z, gripPoint.y), top = screenOf(topPoint.x, topPoint.z, topPoint.y);
    // The grip's upper edge divides the zones.
    const split = [grip[0] + (top[0] - grip[0]) * 0.1, grip[1] + (top[1] - grip[1]) * 0.1];
    const cut = segmentDistance(x, y, tip, split), move = segmentDistance(x, y, split, top);
    if (Math.min(cut, move) > KNIFE_HIT_PX) return null;
    return cut <= move ? "cut" : "move";
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button > 0) return;
    const { x, y } = cssPoint(event);
    keyboardUsed = false;
    hud.setFocus(null);
    const mouse = event.pointerType === "mouse";
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers cannot be captured. */ }
    const action = hud.hit(x, y);
    const entry = { role: "none", x, y, startX: x, startY: y };
    pointers.set(event.pointerId, entry);
    // Undo sits beside the knife: it acts on a tap only, so a drag that starts on it (a finger
    // reaching for the knife) never undoes a cut.
    if (action === "undo") { entry.role = "badge"; entry.action = action; return; }
    if (action && action !== "none") { act(action); return; }
    if (hud.modal || pointers.size > 1) return;
    if (currentStage() === "dust") { entry.role = "dust"; return; }
    const zone = carvable() ? knifeZone(x, y) : null;
    if (zone === "cut") {
      // Pressing the grip drives the knife in; it carves while the finger swipes.
      entry.role = "cut";
      plunge();
    } else if (zone === "move") {
      // Picked up by the handle: the knife keeps that spot under the finger.
      entry.role = "move";
      const tip = screenOf(knife.x, knife.z);
      entry.grab = [tip[0] - x, tip[1] - y];
    } else if (!knife.plunged && bench && !bench.viewOnly && showcase <= 0) {
      // Anywhere else: the finger turns the stone about its centre, like a hand turning it.
      entry.role = "spin";
      const center = isGlyph(currentStage()) ? screenOf(focus.x, focus.z) : screenOf(...toWorld(0, 0));
      entry.center = center;
      entry.angle = Math.atan2(y - center[1], x - center[0]);
      entry.yawStart = yaw;
      entry.lastNotch = Math.round(yaw / NOTCH);
    }
    context.invalidate();
  }, { signal });

  canvas.addEventListener("pointermove", (event) => {
    const { x, y } = cssPoint(event);
    const entry = pointers.get(event.pointerId);
    if (!entry) return;
    const dx = x - entry.x, dy = y - entry.y;
    entry.x = x; entry.y = y;
    if (entry.role === "dust") {
      // In the powder step, a swipe is a breath.
      if (!entry.blew && Math.hypot(x - entry.startX, y - entry.startY) > 40) { entry.blew = true; blow(0.8); }
      return;
    }
    if (entry.role === "cut" && knife.plunged) {
      const scale = pixelsPer();
      const along = knife.dir[0] ? dx * knife.dir[0] / scale.x : dy * knife.dir[1] / scale.z;
      const across = knife.dir[0] ? dy / scale.z : dx / scale.x;
      push(along);
      knife.wobble = clampWobble(knife.wobble + across * 0.03);
    } else if (entry.role === "move") aimAt(x + entry.grab[0], y + entry.grab[1]);
    else if (entry.role === "spin") {
      // Near the centre the angle is unsteady: a sideways drag turns it instead.
      const r = Math.hypot(x - entry.center[0], y - entry.center[1]);
      let turned;
      if (r > SPIN_MIN_PX) {
        const angle = Math.atan2(y - entry.center[1], x - entry.center[0]);
        let delta = angle - entry.angle;
        delta -= Math.round(delta / (Math.PI * 2)) * Math.PI * 2;
        entry.turned = (entry.turned ?? 0) + delta;
        entry.angle = angle;
        turned = entry.turned;
      } else {
        entry.turned = (entry.turned ?? 0) + dx / SPIN_DRAG_PX * QUARTER;
        entry.angle = Math.atan2(y - entry.center[1], x - entry.center[0]);
        turned = entry.turned;
      }
      // Screen angles run clockwise; the stone turns with the finger.
      let next = entry.yawStart - turned;
      // 角度依附: near each 15° notch the stone settles onto it with a light click, and more
      // firmly (a wider catch and a stronger buzz) at each quarter turn.
      const notch = Math.round(next / NOTCH), quarter = notch % 6 === 0;
      if (Math.abs(next - notch * NOTCH) < (quarter ? DETENT : NOTCH_HOLD)) next = notch * NOTCH;
      if (next === notch * NOTCH && notch !== entry.lastNotch) {
        entry.lastNotch = notch;
        sound.tap();
        context.haptics.vibrate(quarter ? "tap" : [4]);
      }
      yaw = yawTarget = next;
      draftDirty = true;
    }
    context.invalidate();
  }, { signal });

  function release(event) {
    const entry = pointers.get(event.pointerId);
    if (!entry) return;
    pointers.delete(event.pointerId);
    // The stroke ends; the knife stays in, set for the next one (which may take a new track).
    if (entry.role === "badge" && Math.hypot(entry.x - entry.startX, entry.y - entry.startY) < 12) act(entry.action);
    if (entry.role === "cut") lift();
    if (entry.role === "cut" || entry.role === "move") aimHandle();
    if (entry.role === "spin") {
      // Let go: near a notch it settles there; otherwise it stays as it is.
      const notch = Math.round(yaw / NOTCH) * NOTCH;
      yawTarget = Math.abs(yaw - notch) < NOTCH_RELEASE ? notch : yaw;
      afterTurn();
    }
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
        if (albumOpen) closeAlbum(); else if (cardKind) act({ finished: "stay", redo: "redo-cancel", intro: "begin", proof: "proof-close" }[cardKind] ?? "view");
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
      if (!event.repeat) { if (currentStage() === "dust") blow(1); else plunge(); }
    } else if (code === "KeyB") { event.preventDefault(); if (!event.repeat) blow(1); }
    else if (code === "KeyQ") { event.preventDefault(); act("left"); }
    else if (code === "KeyE") { event.preventDefault(); act("right"); }
    else if (code === "KeyA") { event.preventDefault(); act("album"); }
    else if (code === "KeyZ") { event.preventDefault(); act("undo"); }
    context.invalidate();
  }, { signal });
  canvas.addEventListener("keyup", (event) => {
    held.delete(event.code);
    if (event.code.startsWith("Arrow")) held.delete("aim");
    if (event.code === "Space" || event.code === "Enter") lift();
    // In the stone, letting go of an arrow ends that stroke, as a lifted finger does.
    if (event.code.startsWith("Arrow") && knife.plunged && knife.chosen) reset();
  }, { signal });
  canvas.addEventListener("blur", () => { held.clear(); lift(); }, { signal });

  // The demo hand (debug): sets the knife at the start of an open line, presses in and pushes
  // until the line is cut, lets go.
  let demo = null; // { phase, start: [x, z], length }
  function demoStep() {
    if (!carvable() || !settled()) return;
    if (!demo) {
      const open = snapLines();
      const ready = open.filter(aligned);
      if (!ready.length) { if (open.length) turn(-1); return; }
      const cut = ready[0];
      const a = toWorld(...bench.carving.point(cut, 0)), b = toWorld(...bench.carving.point(cut, 1));
      // Across the screen push from the left end; up the screen from the near end.
      const across = Math.abs(a[0] - b[0]) > Math.abs(a[1] - b[1]);
      const start = across ? (a[0] < b[0] ? a : b) : (a[1] > b[1] ? a : b);
      demo = { phase: "aim", start, length: cut.length };
      // Which way along the knife's (upright) axis leads from the start to the other end.
      const [hx, hz] = HEADINGS[knife.heading];
      demo.sign = Math.sign((across ? (start === a ? b : a)[0] - start[0] : (start === a ? b : a)[1] - start[1]) * (across ? hx : hz)) || 1;
      knife.targetX = demo.start[0]; knife.targetZ = demo.start[1];
    } else if (demo.phase === "aim" && Math.hypot(knife.x - demo.start[0], knife.z - demo.start[1]) < 0.002) {
      plunge();
      demo.phase = "cut";
    } else if (demo.phase === "cut" && knife.plunged && Math.max(knife.fwd, knife.back) < demo.length) {
      push(0.004 * demo.sign); // a steady hand
    } else if (demo.phase === "cut") {
      lift();
      demo = null;
    }
  }

  // Knife pose, as in the video's 冲刀: the handle leans back toward the carver (down the
  // screen) and the hand pushes the edge up and away; the ground ahead stays in sight. The hand grips it firmly: the pull and cracks barely move it.
  let gripHint = 6; // seconds the grip breathes: at the start and after each lift
  const knifeTilt = new THREE.Euler(0.6, 0, -0.12, "YXZ"); // the handle leans back toward the carver
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
    knifeTilt.x += (0.6 + lean - knifeTilt.x) * Math.min(1, delta * 30);
    const turnTo = knife.headingAngle;
    knifeTilt.y = reducedMotion ? turnTo : knifeTilt.y + (turnTo - knifeTilt.y) * Math.min(1, delta * 14);
    // A crack is felt as the faintest tremor in the blade, settled at once by the grip.
    knife.shakeVelocity += (-900 * knife.shake - 28 * knife.shakeVelocity) * Math.min(delta, 0.02);
    knife.shake += knife.shakeVelocity * Math.min(delta, 0.02);
    knifeModel.group.rotation.copy(knifeTilt);
    knifeModel.group.rotation.x += knife.shake;
    knifeModel.group.updateMatrixWorld();
    // While cutting the knife is half see-through, so the groove under it shows.
    knifeModel.fade = knife.plunged ? 0.4 : 1;
    // The grip breathes while it waits to be pressed, and stays lit while the knife is in.
    gripHint = Math.max(0, gripHint - delta);
    const breathing = carvable() && !knife.plunged && gripHint > 0 && !reducedMotion;
    knifeModel.gripGlow = knife.plunged ? 1 : breathing ? 0.15 + 0.15 * Math.sin(elapsed * 3.5) : 0;
    // Fresh stone glows under the tip while cutting, then dulls.
    const fresh = bench.stone.uniforms.fresh.value;
    const [u, v] = toLocal(knife.x, knife.z);
    fresh.x = u + 0.5; fresh.y = 0.5 - v;
    fresh.z += ((knife.plunged ? 1 : 0) - fresh.z) * Math.min(1, delta * (knife.plunged ? 10 : 1.5));
    return breathing || Math.abs(knife.headingAngle - knifeTilt.y) > 0.001 || Math.abs(liftTarget - knife.lift) > 0.001 || Math.hypot(knife.targetX - knife.x, knife.targetZ - knife.z) > 0.0005 || Math.abs(knife.shake) > 1e-4 || fresh.z > 0.01;
  }

  function testView() {
    const point = (vector) => { badgePoint.copy(vector).applyMatrix4(knifeModel.group.matrixWorld); return screenOf(badgePoint.x, badgePoint.z, badgePoint.y); };
    const grip = point(knifeModel.grip.center);
    const top = point(knifeModel.top);
    return {
      stage: currentStage(), progress: bench.carving.progress(), heading: knife.heading, plunged: knife.plunged,
      yaw, center: isGlyph(currentStage()) ? screenOf(focus.x, focus.z) : screenOf(...toWorld(0, 0)),
      still: (() => { const want = wantedFocus(); const wantPivot = pivotFor(); return Math.abs(want.x - focus.x) + Math.abs(want.z - focus.z) + Math.abs(want.scale - focus.scale) < 1e-3 && Math.abs(wantPivot.u - pivot.u) + Math.abs(wantPivot.v - pivot.v) < 1e-4 && settled() && !knife.recentre && Math.hypot(knife.targetX - knife.x, knife.targetZ - knife.z) < 0.002; })(),
      tip: screenOf(knife.x, knife.z), grip, handle: [grip[0] + (top[0] - grip[0]) * 0.55, grip[1] + (top[1] - grip[1]) * 0.55],
      badges: shownBadges.map(({ id, x, y }) => ({ id, x, y })),
      cuts: bench.carving.cuts.filter((cut) => cut.stage === currentStage() && !cut.done).map((cut) => ({ index: cut.index, a: screenOf(...toWorld(...cut.a)), b: screenOf(...toWorld(...cut.b)), coverage: bench.carving.coverage(cut) })),
      ground: isGlyph(currentStage()) ? (() => {
        const points = [], { carving } = bench, char = Number(currentStage().slice(5));
        for (let index = 0; index < carving.cleared.length && points.length < 80; index += 7) {
          if (carving.charOf[index] === char && !carving.cleared[index]) points.push(screenOf(...toWorld(...carving.clearCell(index))));
        }
        return points;
      })() : [],
      clearCoverage: isGlyph(currentStage()) ? bench.carving.clearCoverage(Number(currentStage().slice(5))) : 0,
      viewport: { width: viewport.width, height: viewport.height }, stageTop: hud.stage.top, modal: hud.modal, snap: context.options["line-assist"] !== false,
    };
  }

  // Start.
  const startSeal = seals.find((seal) => seal.id === state.current) ?? seals[0];
  buildBench(startSeal);
  lastStage = currentStage();
  if (fresh()) openIntro();
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
      // Keyboard: Up pushes while Space holds the knife in, Down pulls back.
      if (knife.plunged && knife.chosen) {
        const keys = { "1,0": ["ArrowRight", "ArrowLeft"], "-1,0": ["ArrowLeft", "ArrowRight"], "0,-1": ["ArrowUp", "ArrowDown"], "0,1": ["ArrowDown", "ArrowUp"] };
        const [forward, back] = keys[knife.dir.join(",")];
        if (held.has(forward)) push(0.18 * delta);
        if (held.has(back)) push(-0.18 * delta);
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
      // In the close-up the stone turns about the character being carved, as a hand turns it,
      // so the character stays under the knife; the pivot glides to each new character.
      const wantPivot = pivotFor();
      const pivotRate = reducedMotion ? 1 : Math.min(1, delta * 4);
      pivot.u += (wantPivot.u - pivot.u) * pivotRate; pivot.v += (wantPivot.v - pivot.v) * pivotRate;
      if (Math.abs(wantPivot.u - pivot.u) + Math.abs(wantPivot.v - pivot.v) < 1e-5) Object.assign(pivot, wantPivot); else busy = true;
      const cos = Math.cos(yaw), sin = Math.sin(yaw);
      stoneRoot.position.set(pivot.u - (pivot.u * cos + pivot.v * sin), 0, pivot.v - (-pivot.u * sin + pivot.v * cos));
      stoneRoot.updateMatrixWorld();
      // The knife joins a new character once the stone has come round to it: just below its
      // middle, on screen whichever way the stone is turned.
      if (knife.recentre && !knife.plunged && pivot.u === wantPivot.u && pivot.v === wantPivot.v && isGlyph(currentStage())) {
        knife.recentre = false;
        const [u0, v0, u1, v1] = bench.carving.relief.cells[Number(currentStage().slice(5))];
        const below = screenOf(...toWorld((u0 + u1) / 2, (v0 + v1) / 2));
        const p = worldPoint(below[0], below[1] + (v1 - v0) * 0.35 * pixelsPer().z);
        if (p) { knife.targetX = knife.aimX = p[0]; knife.targetZ = knife.aimZ = p[1]; busy = true; }
      }
      // The showcase dips the camera to show the sides, then rises again.
      if (showcase > 0) {
        showcase = Math.max(0, showcase - delta);
        const phase = 1 - showcase / 4.2;
        view.elevation = ELEVATION - 0.5 * Math.sin(Math.PI * phase);
        view.zoom = 1 + 0.35 * Math.sin(Math.PI * phase);
        placeCamera();
        busy = true;
        if (showcase === 0) {
          yaw = yawTarget = 0;
          view.elevation = ELEVATION;
          view.zoom = 1;
          placeCamera();
          if (!bench.viewOnly) openCard();
        }
      }
      busy = easeFocus(delta) || busy;
      busy = poseKnife(delta) || busy;
      placeBadges();
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
      if (cardKind === "intro") openIntro(); else if (cardKind === "proof") openProof(); else if (cardKind === "redo") openRedo(); else if (cardKind) openCard(cardSeal, cardKind);
      if (albumOpen) openAlbum();
    },
    optionChanged(id) {
      // Debug: a read-only view of the bench in screen space, for playtest scripts.
      if (id === "test-hook") canvas.sealTest = context.options["test-hook"] ? testView : undefined;
      if (id === "finish-step" && bench && !bench.viewOnly) {
        lift();
        const stage = currentStage();
        if (stage === "dust") { blownOnce = true; blow(1); }
        else if (isGlyph(stage)) {
          const ground = bench.carving.finishCharacter(Number(stage.slice(5)));
          bench.painter.paintClear(ground.cleared);
          maskDirty = draftDirty = true;
          afterCuts();
          save();
        }
        else if (stage !== "done") {
          for (const cut of bench.carving.cuts) {
            if (cut.stage !== stage || cut.done) continue;
            for (const { stroke, points } of bench.carving.finish(cut, widthCode(cut.stage))) {
              bench.painter.paint(stroke, points);
              for (const k of points) if (k % 2 === 0) sprinkle(bench.carving.strokePoint(stroke, k), strokeDirection(stroke), WIDTHS[stroke.width], 1, 0.7);
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
