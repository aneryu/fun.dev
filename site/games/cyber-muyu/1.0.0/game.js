import { createWoodenFishHUD } from "./hud.js";
import { createKnockAudio } from "./sound.js";

export async function createGame(context) {
  const { THREE, scene, setCamera, canvas, viewport, track, signal, onCleanup, asset, reducedMotion } = context;
  const copy = {
    zh: { merit: "功德", strike: "敲木鱼，功德加一", soundOn: "声音：开", soundOff: "声音：关", unavailable: "声音不可用", keys: "空格或回车敲击，M 切换声音" },
    en: { merit: "MERIT", strike: "Strike the wooden fish. Merit plus one", soundOn: "Sound on", soundOff: "Sound off", unavailable: "Sound unavailable", keys: "Space or Enter to strike, M to toggle sound" },
  };
  let words = copy[context.locale] || copy.en;
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
  camera.position.set(0, 2.2, 8);
  camera.lookAt(0, 0, 0);
  setCamera(camera);
  scene.background = new THREE.Color(0xffd43b);
  scene.add(new THREE.HemisphereLight(0xfffaf0, 0x8a7053, 1.7));
  const keyLight = new THREE.DirectionalLight(0xfffaf2, 2.6);
  keyLight.position.set(-3, 6, 4);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.7);
  fillLight.position.set(3, 2, -4);
  scene.add(fillLight);

  const fish = new THREE.Group();
  scene.add(fish);
  const shellMaterial = track(new THREE.MeshPhysicalMaterial({ color: 0xad703c, metalness: 0, roughness: 0.48, clearcoat: 0.12, clearcoatRoughness: 0.5 }));
  const endWood = track(new THREE.MeshStandardMaterial({ color: 0xd09a5b, roughness: 0.55 }));
  const response = await fetch(asset("assets/wooden-fish.json"), { signal });
  if (!response.ok) throw new Error("Wooden fish model unavailable.");
  const model = await response.json();
  signal.throwIfAborted();
  const geometry = track(new THREE.BufferGeometry());
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(model.positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(model.normals, 3));
  geometry.setIndex(model.indices);
  for (const group of model.groups) geometry.addGroup(...group);
  const cavityMaterial = track(new THREE.MeshLambertMaterial({ color: 0x492914 }));
  const body = new THREE.Mesh(geometry, [shellMaterial, cavityMaterial]);
  // Close-up reference: tapered end lower-left, crown upper-right, slit toward the viewer.
  body.rotation.y = -2.6;
  fish.add(body);

  // A tiny, generated contact shadow anchors the carving without a shadow-map pass.
  const shadowPixels = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const radius = Math.hypot(x - 31.5, y - 31.5) / 32;
    const offset = (y * 64 + x) * 4;
    shadowPixels.set([40, 20, 5, Math.round(90 * Math.max(0, 1 - radius) ** 1.5)], offset);
  }
  const shadowTexture = track(new THREE.DataTexture(shadowPixels, 64, 64));
  shadowTexture.magFilter = THREE.LinearFilter;
  shadowTexture.minFilter = THREE.LinearFilter;
  shadowTexture.needsUpdate = true;
  const shadow = new THREE.Mesh(track(new THREE.PlaneGeometry(4.5, 3.5)), track(new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false })));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0.1, -1.04, 0);
  scene.add(shadow);

  const mallet = new THREE.Group();
  const handle = new THREE.Mesh(track(new THREE.CylinderGeometry(0.055, 0.07, 1.65, 12)), shellMaterial);
  const head = new THREE.Mesh(track(new THREE.SphereGeometry(0.23, 16, 12)), endWood);
  head.scale.set(1.8, 1.6, 1.8);
  handle.position.y = 0.825;
  head.position.y = 1.85;
  mallet.add(handle, head);
  // Pivot at the grip: the raised head swings down onto the crown, then rebounds.
  mallet.position.set(2.15, 1.84, 0.55);
  const shaftAxis = new THREE.Vector3(0, 1, 0);
  const malletRest = new THREE.Quaternion().setFromUnitVectors(shaftAxis, new THREE.Vector3(-1.6, 0.75, -0.55).normalize());
  const malletContact = new THREE.Quaternion().setFromUnitVectors(shaftAxis, new THREE.Vector3(-1.8, 0, -0.55).normalize());
  mallet.quaternion.copy(malletRest);
  scene.add(mallet);

  const hud = createWoodenFishHUD({ THREE, camera, scene, track });
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  canvas.addEventListener("click", (event) => {
    if (paused || signal.aborted || event.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * viewport.width;
    const y = (event.clientY - rect.top) / rect.height * viewport.height;
    canvas.focus({ preventScroll: true });
    if (hud.hitsSound(x, y)) { toggleSound(); return; }
    pointer.set(x / viewport.width * 2 - 1, 1 - y / viewport.height * 2);
    raycaster.setFromCamera(pointer, camera);
    if (raycaster.intersectObject(body).length) { strike(); playKnock(); }
  }, { signal });
  canvas.addEventListener("keydown", (event) => {
    if (paused || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === "Space" || event.code === "Enter") {
      event.preventDefault(); strike(); playKnock();
    } else if (event.code === "KeyM") {
      event.preventDefault(); toggleSound();
    }
  }, { signal });

  function toggleSound() {
    if (!soundAvailable) return;
    soundEnabled = !soundEnabled;
    if (!soundEnabled) audio.pause();
    labels();
  }

  let merit = 0;
  let paused = false;
  let soundEnabled = true;
  let soundAvailable = true;
  let pulse = 0;
  let feedbackTime = 0;
  const audio = createKnockAudio(() => {
    if (signal.aborted) return;
    soundAvailable = false;
    labels();
  });
  onCleanup(() => audio.dispose());

  function labels() {
    hud.setScore(merit);
    hud.setSound(soundEnabled && soundAvailable);
    const soundLabel = !soundAvailable ? words.unavailable : soundEnabled ? words.soundOn : words.soundOff;
    canvas.setAttribute("aria-label", `${words.strike}. ${words.merit} ${merit}. ${soundLabel}. ${words.keys}`);
    context.invalidate();
  }

  function playKnock() {
    if (!paused && !signal.aborted && soundEnabled && soundAvailable) audio.strike();
  }

  function strike() {
    if (paused || signal.aborted) return;
    context.invalidate();
    merit++;
    pulse = 1;
    feedbackTime = 0.7;
    hud.showFeedback(1, 0);
    labels();
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
    hud.resize(viewport.width, viewport.height, centerX, Math.max(105, centerY - radius * 1.8));
  }

  labels();
  return {
    renderMode: "on-demand",
    update(delta) {
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
      return pulse > 0 || feedbackTime > 0;
    },
    resize,
    pause() { paused = true; audio.pause(); },
    resume() { paused = false; },
    localeChanged(locale) { words = copy[locale] || copy.en; labels(); },
    dispose() { scene.remove(fish, mallet, shadow, camera); },
  };
}
