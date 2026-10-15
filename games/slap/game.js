// Slap (扇耳光): swipe across the face to slap it; the flesh goes duang-duang.
// Any face works: the player can swap in a photo, which never leaves the device.
import { createHead } from "./head.js";
import { createHands } from "./hand.js";
import { createSound } from "./sound.js";
import { createHud } from "./hud.js";
import { clearHandprints, createDaze, paintHandprint } from "./effects.js";
import { cropFace, decode, defaultAnchors, encode, evenLighting, extendLandmarks, gainFor, landmarksFromAnchors, skinTone } from "./photo.js";
import { fitShape } from "./shape.js";

export const options = [
  { id: "jelly", section: "settings", type: "range", min: 0.5, max: 2, step: 0.1, default: 1, label: { zh: "Q 弹程度", en: "Jiggle" } },
  { id: "use-photo", section: "settings", type: "toggle", default: true, label: { zh: "用 TA 的脸", en: "Use their face" } },
  { id: "forget-photo", section: "settings", type: "action", label: { zh: "删除照片", en: "Delete photo" } },
  { id: "anchor", section: "settings", audience: "debug", type: "range", min: 100, max: 2000, step: 50, default: 600, label: { zh: "回弹刚度", en: "Anchor stiffness" } },
  { id: "coupling", section: "settings", audience: "debug", type: "range", min: 1000, max: 30000, step: 500, default: 9000, label: { zh: "肉波传导", en: "Wave coupling" } },
  { id: "damping", section: "settings", audience: "debug", type: "range", min: 0.5, max: 20, step: 0.1, default: 3.2, label: { zh: "阻尼", en: "Damping" } },
  { id: "punch", section: "settings", audience: "debug", type: "range", min: 0.2, max: 3, step: 0.1, default: 1, label: { zh: "冲量", en: "Impulse" } },
  { id: "view", section: "cheats", audience: "debug", type: "choice", default: "normal", label: { zh: "调试视图", en: "Debug view" },
    choices: [{ value: "normal", label: { zh: "正常", en: "Normal" } }, { value: "cavity", label: { zh: "口腔", en: "Mouth" } }, { value: "photo", label: { zh: "照片权重", en: "Photo weight" } }, { value: "texture", label: { zh: "贴图", en: "Texture" } }] },
  { id: "shape", section: "settings", audience: "debug", type: "range", min: 0, max: 1, step: 0.1, default: 0.3, label: { zh: "照片脸型", en: "Photo face shape" } },
  { id: "slowmo", section: "cheats", audience: "debug", type: "range", min: 0.05, max: 1, step: 0.05, default: 1, label: { zh: "慢动作", en: "Slow motion" } },
  { id: "max-damage", section: "cheats", audience: "debug", type: "action", label: { zh: "直接打满", en: "Max damage" } },
];

const copy = {
  zh: {
    label: (today, total) => `扇耳光。在脸上快速划过就是一巴掌，左右方向键也能扇，F 换成 TA 的脸。今日 ${today} 下，累计 ${total} 下`,
    counts: (today, total) => `今日 ${today} · 累计 ${total}`,
    faceButton: "📷 换成 TA 的脸", faceAgain: "📷 换一张",
    detecting: "正在识别 TA 的脸…\n第一次要下载约 17 MB", stays: "照片只留在你的设备上", unreadable: "这张图读不出来，换一张试试",
    alignTitle: "没认出脸。把五个点拖到 TA 的眼睛、鼻尖和嘴角上", alignOk: "好了", alignCancel: "算了",
    alignKeys: (name) => `正在调整${name}。方向键移动，N 换下一个点，回车完成，Esc 取消`,
    replaced: "换好了，开扇", forgotten: "照片已删除",
    phrases: [[5, "啪啪啪"], [10, "大嘴巴子！"], [20, "左右开弓！"], [35, "停不下来"], [50, "打满了还打？"]],
    climax: "满级！", noSave: "当前容器不支持存档",
    share: (today) => `我今天在 fun.dev 扇了 TA ${today} 下，你也来`, cheats: "（开了秘籍）",
  },
  en: {
    label: (today, total) => `Slap. Swipe across the face to slap it, or use the left and right arrow keys. F uses their face. ${today} today, ${total} in total`,
    counts: (today, total) => `Today ${today} · Total ${total}`,
    faceButton: "📷 Use their face", faceAgain: "📷 Another face",
    detecting: "Finding the face…\nFirst time downloads about 17 MB", stays: "The photo stays on your device", unreadable: "Couldn't read that image. Try another",
    alignTitle: "No face found. Drag the five points onto the eyes, nose tip and mouth corners", alignOk: "Done", alignCancel: "Cancel",
    alignKeys: (name) => `Adjusting ${name}. Arrow keys move, N next point, Enter done, Escape cancel`,
    replaced: "Face swapped. Go ahead", forgotten: "Photo deleted",
    phrases: [[5, "Smack smack"], [10, "Big slap!"], [20, "Both cheeks!"], [35, "Can't stop"], [50, "Still going?"]],
    climax: "Maxed out!", noSave: "This host does not support saving",
    share: (today) => `I slapped them ${today} times today on fun.dev. Your turn`, cheats: " (with cheats)",
  },
};

const NECK = { stiffness: 190, damping: 3.8 };
const COMBO_GAP = 0.9, HEAL_DELAY = 2.5, HEAL_RATE = 0.05, HIT_STOP = 0.045;
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export async function createGame(context) {
  const { THREE, scene, camera, canvas, signal, track, invalidate, reducedMotion, asset } = context;
  const progress = context.progress?.version === 1 ? context.progress : null;
  const saved = progress ? await progress.load() : { kind: "empty" };
  signal.throwIfAborted();
  if (saved.kind === "unavailable") throw new Error("Progress is unavailable. Retry or start a separate save.");
  const record = { total: 0, today: 0, day: localDay() };
  if (saved.kind === "saved") {
    const data = saved.snapshot?.schemaVersion === 1 ? saved.snapshot.data : null;
    if (!data || !Number.isFinite(data.total) || !Number.isFinite(data.today) || typeof data.day !== "string") throw new Error("Unsupported save.");
    Object.assign(record, data);
  }

  const kit = await context.runtime("kit/text.js");
  const [head, hands] = await Promise.all([createHead(context, (f) => context.reportLoading(0.1 + f * 0.75)), createHands(context)]);
  signal.throwIfAborted();
  context.reportLoading(0.9);
  const sound = createSound(context.audio);
  context.onCleanup(() => sound.stop());

  scene.background = new THREE.Color(0x1d1d20);
  scene.add(head.object, hands.object, hands.lights, camera);
  camera.fov = 30;
  const lookAt = new THREE.Vector3();
  const cameraBase = new THREE.Vector3();
  const hud = createHud(context, kit);
  const daze = createDaze(context, kit, head);
  scene.add(daze.stars, daze.tears);

  let locale = context.locale === "zh" ? "zh" : "en";
  let words = copy[locale];

  // Head on a neck spring: pitch (x), yaw (y), roll (z) plus a little sway.
  const angle = new THREE.Vector3(), angularVelocity = new THREE.Vector3(), angularAcceleration = new THREE.Vector3();
  const offset = new THREE.Vector3(), velocity = new THREE.Vector3(), acceleration = new THREE.Vector3();
  const headMatrix = new THREE.Matrix4(), euler = new THREE.Euler(0, 0, 0, "YXZ"), quaternion = new THREE.Quaternion(), unit = new THREE.Vector3(1, 1, 1);
  const rigid = { a: [0, 0, 0], w: [0, 0, 0], al: [0, 0, 0] };

  let paused = true, elapsed = 0, hitStop = 0, shake = 0;
  let damage = 0, idle = 0, climaxReady = true, spin = -1;
  let combo = 0, comboTimer = 0, comboPhrase = null;
  let shock = 0, wince = 0;
  let photo = null; // { canvas, landmarks, texture }
  let landmarker = null, photoBusy = false, toastTimer = 0;

  function applyParams() {
    const jelly = context.options.jelly * (reducedMotion ? 0.6 : 1);
    const params = head.body.params;
    params.anchor = context.options.anchor / jelly;
    params.coupling = context.options.coupling;
    params.damping = context.options.damping / Math.sqrt(jelly);
    params.maxDisplacement = 0.02 * jelly;
  }
  applyParams();

  function rollDay() {
    const day = localDay();
    if (record.day !== day) { record.day = day; record.today = 0; }
  }
  let saveTimer = null;
  function save(now = false) {
    if (!progress) return;
    clearTimeout(saveTimer);
    const write = () => { void progress.save({ schemaVersion: 1, data: { ...record } }).catch(() => { /* The player shows save failures. */ }); };
    if (now) write(); else saveTimer = setTimeout(write, 800);
  }
  context.onCleanup(() => clearTimeout(saveTimer));

  function labels() {
    rollDay();
    const parts = [words.label(record.today, record.total)];
    if (!progress) parts.push(words.noSave);
    canvas.setAttribute("aria-label", parts.join(". "));
    hud.setCounts(words.counts(record.today, record.total));
    hud.setButton(photo ? words.faceAgain : words.faceButton);
  }

  function toast(message, seconds = 0) {
    hud.showToast(message);
    toastTimer = seconds;
    invalidate();
  }

  // --- Rigid head -------------------------------------------------------------------------
  function stepRigid(dt) {
    angularAcceleration.copy(angle).multiplyScalar(-NECK.stiffness).addScaledVector(angularVelocity, -NECK.damping);
    if (spin >= 0) angularAcceleration.y = 0;
    angularVelocity.addScaledVector(angularAcceleration, dt);
    angle.addScaledVector(angularVelocity, dt);
    if (spin >= 0) {
      // Climax: one full turn, eased, then the neck spring takes over again.
      spin += dt / 0.85;
      const t = Math.min(1, spin);
      angle.y = (1 - (1 - t) ** 3) * Math.PI * 2;
      angularVelocity.y = 0;
      if (t >= 1) { spin = -1; angle.y = 0; angularVelocity.y = -3; }
    } else angle.y = THREE.MathUtils.clamp(angle.y, -0.95, 0.95);
    angle.x = THREE.MathUtils.clamp(angle.x, -0.6, 0.6);
    angle.z = THREE.MathUtils.clamp(angle.z, -0.7, 0.7);
    acceleration.copy(offset).multiplyScalar(-260).addScaledVector(velocity, -9);
    velocity.addScaledVector(acceleration, dt);
    offset.addScaledVector(velocity, dt);
    euler.set(angle.x, angle.y, angle.z);
    quaternion.setFromEuler(euler);
    headMatrix.compose(offset, quaternion, unit);
    rigid.a = acceleration.toArray();
    rigid.w = spin >= 0 ? [0, 0, 0] : angularVelocity.toArray();
    rigid.al = angularAcceleration.toArray();
  }

  // --- Picking ----------------------------------------------------------------------------
  const hitMesh = new THREE.Mesh(track(new THREE.BufferGeometry()), track(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })));
  hitMesh.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(head.mesh.geometry.attributes.position.array), 3));
  hitMesh.geometry.setAttribute("uv", head.mesh.geometry.attributes.uv);
  hitMesh.geometry.setIndex(head.mesh.geometry.index);
  hitMesh.geometry.computeBoundingSphere();
  hitMesh.matrixAutoUpdate = false;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pick(x, y) {
    ndc.set((x / context.viewport.width) * 2 - 1, -(y / context.viewport.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    hitMesh.matrixWorld.copy(headMatrix);
    return raycaster.intersectObject(hitMesh, false)[0] ?? null;
  }

  // --- Slapping ---------------------------------------------------------------------------
  const toLocal = new THREE.Matrix4();
  const right = new THREE.Vector3(), up = new THREE.Vector3(), forward = new THREE.Vector3();
  function cameraAxes() {
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    up.setFromMatrixColumn(camera.matrixWorld, 1);
    forward.setFromMatrixColumn(camera.matrixWorld, 2).negate();
  }

  function phraseFor(count) {
    for (const [at, text] of words.phrases) if (count === at) return text;
    return null;
  }

  function contact(hit, dir, strength) {
    const jelly = context.options.jelly * (reducedMotion ? 0.6 : 1);
    const punch = context.options.punch;
    toLocal.copy(headMatrix).invert();
    const local = hit.point.clone().applyMatrix4(toLocal);
    const push = dir.clone().multiplyScalar(2.4).addScaledVector(forward, 0.9).multiplyScalar(strength * punch * jelly);
    const pushLocal = push.clone().transformDirection(toLocal).multiplyScalar(push.length());
    head.body.impulse(local.toArray(), pushLocal.toArray(), 0.045);
    // Torque about the neck, mostly a turn: real heads barely roll or nod from a slap.
    const torque = new THREE.Vector3().crossVectors(local, dir.clone().transformDirection(toLocal)).multiplyScalar(strength * punch * 70 * (reducedMotion ? 0.5 : 1));
    torque.x *= 0.45; torque.z *= 0.3;
    angularVelocity.add(torque);
    velocity.addScaledVector(dir, 0.12 * strength * punch);
    // Damage: handprint, swelling and faces.
    const sideLocal = dir.clone().transformDirection(toLocal);
    const upLocal = up.clone().transformDirection(toLocal);
    if (hit.face) paintHandprint(head, hit, upLocal, sideLocal, strength);
    head.swellAt(local.toArray(), 0.0014 * strength * (0.4 + damage), 0.034);
    damage = Math.min(1, damage + 0.03 + 0.045 * strength);
    idle = 0;
    shock = Math.max(shock, 0.5 + 0.4 * strength);
    wince = 1;
    if (!reducedMotion) { hitStop = HIT_STOP * strength; shake = 0.006 * strength; }
    sound.slap(strength);
    context.haptics.vibrate(strength > 0.6 ? [28, 20, 16] : [14]);
    rollDay();
    record.today++; record.total++;
    combo = comboTimer > 0 ? combo + 1 : 1;
    comboTimer = COMBO_GAP;
    const phrase = phraseFor(combo);
    if (phrase) { comboPhrase = phrase; context.announce(`×${combo} ${phrase}`); }
    if (combo === 1) comboPhrase = null;
    hud.setCombo(combo, comboPhrase);
    if (damage >= 1 && climaxReady) climax();
    labels();
    save();
    invalidate();
  }

  function climax() {
    climaxReady = false;
    if (!reducedMotion) spin = 0;
    sound.climax();
    context.haptics.vibrate("success");
    comboPhrase = words.climax;
    hud.setCombo(combo, comboPhrase);
    context.announce(words.climax);
  }

  function slap(hit, screenDir, strength) {
    cameraAxes();
    const dir = right.clone().multiplyScalar(screenDir.x).addScaledVector(up, -screenDir.y).normalize();
    const normal = hit.face ? hit.face.normal.clone().transformDirection(headMatrix) : null;
    hands.start(hit.point.clone(), dir, forward.clone().negate(), () => contact(hit, dir, strength), normal);
    invalidate();
  }

  function poke(hit) {
    toLocal.copy(headMatrix).invert();
    cameraAxes();
    const local = hit.point.clone().applyMatrix4(toLocal);
    head.body.impulse(local.toArray(), forward.clone().transformDirection(toLocal).multiplyScalar(0.9 * context.options.jelly).toArray(), 0.025);
    wince = Math.max(wince, 0.35);
    sound.poke();
    context.haptics.vibrate("tap");
    invalidate();
  }

  // --- Photos -----------------------------------------------------------------------------
  function applyFace(face) {
    const texture = new THREE.CanvasTexture(face.canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.anisotropy = 4;
    photo?.texture.dispose();
    photo = { ...face, texture, gain: gainFor(skinTone(face.canvas, face.landmarks), head.meta.skinTone) };
    reshape();
    showFace();
  }
  function reshape() {
    if (photo) photo.shape = fitShape({ landmarks: photo.landmarks, depth: photo.depth, reference: head.arrays.landmarks3d, vertices: head.base, strength: context.options.shape });
  }
  function showFace() {
    const on = photo && context.options["use-photo"];
    head.setPhoto(on ? { texture: photo.texture, landmarks: extendLandmarks(photo.landmarks), gain: photo.gain } : null);
    head.setShape(on ? photo.shape : null);
    // Picking follows the reshaped face.
    head.sync();
    hitMesh.geometry.attributes.position.array.set(head.mesh.geometry.attributes.position.array);
    hitMesh.geometry.attributes.position.needsUpdate = true;
    hitMesh.geometry.computeBoundingSphere();
    context.updateOption("use-photo", { disabled: !photo });
    context.updateOption("forget-photo", { disabled: !photo });
    labels();
    invalidate();
  }
  context.onCleanup(() => photo?.texture.dispose());

  function choosePhoto() {
    if (photoBusy || paused || !context.pickImage) return;
    // pickImage must start inside the gesture; everything after is asynchronous.
    const picking = context.pickImage({ maxSize: 1280 });
    photoBusy = true;
    picking.then(async (bitmap) => {
      if (!bitmap) return;
      const image = new OffscreenCanvas(bitmap.width, bitmap.height);
      image.getContext("2d").drawImage(bitmap, 0, 0);
      toast(words.detecting);
      let points = null, depth = null;
      try {
        if (!landmarker) {
          const face = await import("./face.js");
          landmarker = { detect: face.detect, instance: await face.createLandmarker(asset) };
          context.onCleanup(() => landmarker?.instance.close());
        }
        signal.throwIfAborted();
        // MediaPipe gets the decoded bitmap: every browser accepts it as an image source.
        ({ points, depth } = landmarker.detect(landmarker.instance, bitmap) ?? {});
      } catch (error) {
        if (signal.aborted) return;
        console.warn("Face detection unavailable:", error);
      } finally { bitmap.close(); }
      toast(null);
      if (!points) {
        const placed = await hud.align(image, defaultAnchors(head.arrays.defaultLandmarks, head.meta.frontSize, image.width, image.height));
        invalidate();
        if (!placed) return;
        points = landmarksFromAnchors(head.arrays.defaultLandmarks, placed);
      }
      const face = evenLighting(cropFace(image, points, depth));
      if (context.options["use-photo"] === false) context.updateOption("use-photo", { value: true });
      applyFace(face);
      toast(words.stays, 2.5);
      context.announce(words.replaced);
      if (context.deviceStorage) {
        const blobs = await encode(face);
        await context.deviceStorage.set("face", blobs.image);
        await context.deviceStorage.set("face-points", blobs.points);
      }
    }).catch((error) => {
      if (signal.aborted) return;
      console.warn("Photo failed:", error);
      toast(words.unreadable, 2.5);
    }).finally(() => { photoBusy = false; });
  }

  async function restoreFace() {
    if (!context.deviceStorage) return;
    try {
      const [image, points] = await Promise.all([context.deviceStorage.get("face"), context.deviceStorage.get("face-points")]);
      if (image && points && !signal.aborted) applyFace(await decode(image, points));
    } catch (error) { console.warn("Saved face unavailable:", error); }
  }

  async function forgetFace() {
    photo?.texture.dispose();
    photo = null;
    showFace();
    toast(words.forgotten, 2);
    context.announce(words.forgotten);
    if (context.deviceStorage) await Promise.all([context.deviceStorage.delete("face"), context.deviceStorage.delete("face-points")]).catch(() => {});
  }

  // --- Input ------------------------------------------------------------------------------
  const pointers = new Map();
  let buttonPointer = null;
  canvas.addEventListener("pointerdown", (event) => {
    if (paused) return;
    const x = event.offsetX, y = event.offsetY;
    if (hud.aligning) { hud.alignPointer("down", x, y); invalidate(); return; }
    // Touch only grants the user activation a file picker needs on pointerup, so the button
    // fires on release (keys and mouse could open it here, but one path keeps it simple).
    if (hud.hitButton(x, y)) { buttonPointer = event.pointerId; return; }
    pointers.set(event.pointerId, { x, y, t: event.timeStamp, start: event.timeStamp, inside: !!pick(x, y), lastSlap: -1e9, lastDir: 0, vx: 0, vy: 0, moved: 0 });
  }, { signal });
  canvas.addEventListener("pointermove", (event) => {
    const x = event.offsetX, y = event.offsetY;
    if (hud.aligning) { hud.alignPointer("move", x, y); invalidate(); return; }
    const p = pointers.get(event.pointerId);
    if (!p || paused) return;
    const dt = Math.max(1, event.timeStamp - p.t) / 1000;
    const dx = x - p.x, dy = y - p.y;
    p.vx = p.vx * 0.3 + (dx / dt) * 0.7; p.vy = p.vy * 0.3 + (dy / dt) * 0.7;
    p.moved += Math.hypot(dx, dy);
    let hit = null;
    for (let s = 1; s <= 3 && !hit; s++) hit = pick(p.x + (dx * s) / 3, p.y + (dy * s) / 3);
    const speed = Math.hypot(p.vx, p.vy);
    // A new slap needs the stroke to enter the face, or to turn around inside it.
    const reversed = hit && p.inside && p.lastDir && Math.sign(p.vx) !== p.lastDir && Math.abs(p.vx) > 250;
    // Even an unhurried stroke lands as a light pat; speed only sets how hard.
    if (hit && (!p.inside || reversed) && speed > 180 && event.timeStamp - p.lastSlap > 90) {
      p.lastSlap = event.timeStamp;
      p.lastDir = Math.sign(p.vx);
      slap(hit, { x: p.vx / speed, y: p.vy / speed }, THREE.MathUtils.clamp((speed - 250) / 2500, 0.12, 1));
    }
    p.inside = !!hit;
    p.x = x; p.y = y; p.t = event.timeStamp;
  }, { signal });
  const release = (event) => {
    if (hud.aligning) { hud.alignPointer("up", event.offsetX, event.offsetY); return; }
    if (buttonPointer === event.pointerId) {
      buttonPointer = null;
      if (event.type === "pointerup" && hud.hitButton(event.offsetX, event.offsetY)) choosePhoto();
      return;
    }
    const p = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (!p || paused || event.type === "pointercancel") return;
    if (p.moved < 12 && event.timeStamp - p.start < 350) {
      const hit = pick(event.offsetX, event.offsetY);
      if (hit) poke(hit);
    }
  };
  canvas.addEventListener("pointerup", release, { signal });
  canvas.addEventListener("pointercancel", release, { signal });
  canvas.addEventListener("keydown", (event) => {
    if (paused) return;
    if (hud.aligning) {
      if (event.code === "Tab") return;
      if (hud.alignKey(event.code)) {
        event.preventDefault();
        if (hud.aligning && event.code === "KeyN") context.announce(words.alignKeys(hud.alignFocusName(locale)));
        invalidate();
      }
      return;
    }
    if (event.code === "KeyF" && !event.repeat) { event.preventDefault(); choosePhoto(); return; }
    if ((event.code !== "ArrowLeft" && event.code !== "ArrowRight") || event.repeat) return;
    event.preventDefault();
    const sign = event.code === "ArrowRight" ? 1 : -1;
    // Arrow right swings left-to-right and lands on the cheek on the left of the screen.
    const cheek = new THREE.Vector3(-sign * 0.045, head.eyeMid.y - 0.05, head.eyeMid.z).applyMatrix4(headMatrix).project(camera);
    const x = (cheek.x + 1) / 2 * context.viewport.width, y = (1 - cheek.y) / 2 * context.viewport.height;
    const hit = pick(x, y);
    if (hit) slap(hit, { x: sign, y: 0 }, 0.7);
  }, { signal });

  hud.setLocale(locale, words);
  labels();
  await restoreFace();
  signal.throwIfAborted();
  if (!photo) for (const id of ["use-photo", "forget-photo"]) context.updateOption(id, { disabled: true });
  context.reportLoading(1);

  function heal(delta) {
    if (damage <= 0) return false;
    idle += delta;
    if (idle < HEAL_DELAY) return true;
    const before = damage;
    damage = Math.max(0, damage - HEAL_RATE * delta);
    head.heal((before - damage) * 1.2);
    if (damage < 0.75) climaxReady = true;
    if (damage === 0) { clearHandprints(head); head.clearSwelling(); }
    return true;
  }

  return {
    renderMode: "on-demand",
    adaptiveResolution: true,
    update(delta) {
      delta *= context.options.slowmo;
      elapsed += delta;
      let busy = false;
      if (hitStop > 0) { hitStop -= delta; return true; }
      busy = hands.update(delta) || busy;
      if (toastTimer > 0) { toastTimer -= delta; if (toastTimer <= 0) hud.showToast(null); busy = true; }
      if (comboTimer > 0) { comboTimer -= delta; if (comboTimer <= 0) { combo = 0; hud.setCombo(0, null); } busy = true; }
      busy = hud.update(delta) || busy;
      busy = heal(delta) || busy;
      // Expressions: shock and wince flash on hits; sadness grows with damage. Their sum stays ≤ 1.
      shock = Math.max(0, shock - delta * 1.3);
      wince = Math.max(0, wince - delta * 3.5);
      const sad = smoothstep(0.45, 0.85, damage);
      let weights = [shock * (1 - sad * 0.6), sad, wince * 0.8];
      const sum = weights.reduce((a, b) => a + b, 0);
      if (sum > 1) weights = weights.map((w) => w / sum);
      head.setMorph("shock", weights[0]); head.setMorph("sad", weights[1]); head.setMorph("wince", weights[2]);
      // The smug rest pose gives way to other expressions, and to a photo's own face.
      head.setMorph("neutral", photo && context.options["use-photo"] ? 1 : Math.min(1, weights[0] + weights[1] + weights[2]));
      head.setMarksAmount(damage > 0 ? Math.min(1, 0.55 + damage) : 0);
      busy = busy || shock > 0 || wince > 0;
      stepRigid(delta);
      head.body.advance(delta, rigid);
      head.setHeadMatrix(headMatrix);
      head.sync();
      busy = daze.update(delta, elapsed, { dazed: smoothstep(0.7, 0.9, damage), crying: smoothstep(0.82, 1, damage), headMatrix }) || busy;
      if (shake > 0) {
        shake = Math.max(0, shake - delta * 0.05);
        camera.position.copy(cameraBase).add(new THREE.Vector3((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0));
        busy = true;
      } else camera.position.copy(cameraBase);
      const moving = head.body.energy > 1e-6 || angularVelocity.lengthSq() > 1e-6 || angle.lengthSq() > 1e-6 || spin >= 0;
      return busy || moving;
    },
    resize(viewport) {
      const aspect = viewport.width / viewport.height;
      const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
      // Head and shoulders: at least 0.5 m tall and 0.3 m wide, the cut chest below the bottom edge.
      const distance = Math.max(0.5 / 2 / Math.tan(halfFov), 0.3 / 2 / (Math.tan(halfFov) * aspect));
      const halfHeight = distance * Math.tan(halfFov);
      lookAt.set(0, -0.135 + halfHeight, 0);
      cameraBase.set(0, lookAt.y, distance);
      camera.position.copy(cameraBase);
      camera.lookAt(lookAt);
      camera.updateMatrixWorld();
      hud.resize(viewport);
      invalidate();
    },
    pause() { paused = true; pointers.clear(); save(true); },
    resume() { paused = false; labels(); },
    localeChanged(value) {
      locale = value === "zh" ? "zh" : "en";
      words = copy[locale];
      hud.setLocale(locale, words);
      labels();
    },
    optionChanged(id, value) {
      if (id === "view") head.setView(["normal", "cavity", "photo", "texture"].indexOf(value));
      else if (id === "shape") { reshape(); showFace(); }
      else if (id === "use-photo") showFace();
      else if (id === "forget-photo") void forgetFace();
      else if (id === "max-damage") { damage = 0.98; climaxReady = true; idle = 0; }
      else applyParams();
      invalidate();
    },
    shareText(value) {
      const w = copy[value === "zh" ? "zh" : "en"];
      rollDay();
      return w.share(record.today) + (context.cheatsUsed ? w.cheats : "");
    },
    dispose() {
      hud.dispose();
      daze.dispose();
      hands.dispose();
      scene.remove(head.object, camera);
    },
  };
}
