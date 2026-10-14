// Optional starter for games/<id>/game.js (API v2): a cube that turns on tap or Space,
// with a HUD counter drawn by the platform kit. Replace the gameplay freely.
export const options = [
  { id: "speed", section: "settings", type: "choice", default: "normal", label: { zh: "转速", en: "Speed" },
    choices: [{ value: "slow", label: { zh: "慢", en: "Slow" } }, { value: "normal", label: { zh: "正常", en: "Normal" } }] },
  { id: "spin-ten", section: "cheats", type: "action", label: { zh: "直接转 10 次", en: "Add 10 turns" } },
];

export async function createGame(context) {
  const { THREE, scene, camera, canvas, signal, track, invalidate, reducedMotion } = context;
  const { createText, createHudLayer } = await context.runtime("kit/text.js");
  signal.throwIfAborted();
  const geometry = track(new THREE.BoxGeometry(1.4, 1.4, 1.4));
  const material = track(new THREE.MeshStandardMaterial({ color: 0x9c3a12, roughness: 0.7 }));
  const cube = new THREE.Mesh(geometry, material);
  const light = new THREE.HemisphereLight(0xffffff, 0x5c5133, 3);
  scene.background = new THREE.Color(0xffd43b);
  scene.add(cube, light, camera);
  const hud = createHudLayer(camera);
  const counter = track(createText({ text: "0", size: 28, weight: 700, hud: true, anchorX: 0, anchorY: 1 }));
  let turns = 0, paused = true, locale = context.locale;

  function labels() {
    counter.setText(String(turns));
    canvas.setAttribute("aria-label", locale === "zh" ? `点击或按空格旋转。已旋转 ${turns} 次` : `Click or press Space to rotate. ${turns} turns`);
  }
  function turn(count = 1) {
    if (paused && count === 1) return;
    turns += count;
    labels();
    context.announce(locale === "zh" ? `${turns} 次` : `${turns} turns`);
    context.haptics.vibrate("tap");
    invalidate();
  }
  canvas.addEventListener("click", () => turn(), { signal });
  canvas.addEventListener("keydown", (event) => {
    if ((event.code === "Space" || event.code === "Enter") && !event.repeat) { event.preventDefault(); turn(); }
  }, { signal });
  labels();

  return {
    renderMode: "on-demand",
    update(delta) {
      const target = turns * Math.PI / 2;
      const rate = context.options.speed === "slow" ? 4 : 12;
      cube.rotation.x = 0.4;
      cube.rotation.y = reducedMotion ? target : THREE.MathUtils.damp(cube.rotation.y, target, rate, delta);
      const moving = Math.abs(cube.rotation.y - target) > 0.001;
      if (!moving) cube.rotation.y = target;
      return moving;
    },
    resize(viewport) {
      camera.position.z = 4 / Math.min(1, viewport.width / viewport.height);
      hud.resize(viewport);
      hud.place(counter.object, { x: 20, y: 20 });
    },
    pause() { paused = true; },
    resume() { paused = false; },
    localeChanged(value) { locale = value; labels(); },
    optionChanged(id) { if (id === "spin-ten") turn(10); },
    shareText(value) { return value === "zh" ? `我在 fun.dev 转了 ${turns} 次方块` : `I turned the cube ${turns} times on fun.dev`; },
    dispose() { hud.dispose(); scene.remove(cube, light, camera); },
  };
}
