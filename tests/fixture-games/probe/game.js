// The platform's test game (scripts/browser/*.mjs): every tap adds merit, which the canvas label
// and announcements report, progress saves and share text carry. One setting, one cheat and one
// debug option exercise the options panel. Not published: release refuses this directory.
export const options = [
  { id: "rings", section: "settings", type: "toggle", default: true, label: { zh: "显示圆环", en: "Show the ring" } },
  { id: "merit-1000", section: "cheats", type: "action", label: { zh: "功德 +1000", en: "Merit +1000" } },
  { id: "auto-strike", section: "cheats", audience: "debug", type: "toggle", label: { zh: "自动点击", en: "Tap automatically" } },
];

const copy = {
  zh: { merit: "功德", strike: "点击画面或按空格点一下探针", keys: "空格或回车点击", share: (n) => `我在 fun.dev 点了探针 ${n} 下`, cheats: "（开了秘籍）" },
  en: { merit: "MERIT", strike: "Tap anywhere or press Space to tap the probe", keys: "Space or Enter taps", share: (n) => `${n} merit on Probe at fun.dev`, cheats: " (with cheats)" },
};

export async function createGame(context) {
  const { THREE, scene, camera, canvas, track, signal } = context;
  const progress = context.progress?.version === 1 ? context.progress : null;
  const saved = progress ? await progress.load() : { kind: "empty" };
  signal.throwIfAborted();
  if (saved.kind === "unavailable") throw new Error("Progress is unavailable.");
  if (saved.kind === "saved" && saved.snapshot?.schemaVersion !== 1) throw new Error("Unsupported save.");
  let merit = saved.kind === "saved" ? saved.snapshot.data.merit : 0;
  const words = () => copy[context.locale === "zh" ? "zh" : "en"];

  scene.background = new THREE.Color(0xfff7d6);
  camera.position.set(0, 0, 4);
  const probe = new THREE.Mesh(track(new THREE.BoxGeometry(1, 1, 1)), track(new THREE.MeshBasicMaterial({ color: 0xf28c28 })));
  const ring = new THREE.Mesh(track(new THREE.TorusGeometry(1.2, 0.05, 8, 48)), track(new THREE.MeshBasicMaterial({ color: 0x211f17 })));
  ring.visible = context.options?.rings !== false;
  scene.add(probe, ring);

  const label = () => canvas.setAttribute("aria-label", [words().strike, `${words().merit} ${merit}`, words().keys].join(". "));
  function tap() {
    merit++;
    probe.rotation.y += 0.3;
    if (progress) void progress.save({ schemaVersion: 1, data: { merit } }).catch(() => {});
    label();
    context.announce(`${words().merit} ${merit}`);
    context.invalidate();
  }
  canvas.addEventListener("pointerdown", tap, { signal });
  canvas.addEventListener("keydown", (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    tap();
  }, { signal });
  let auto = null;
  const setAuto = (on) => {
    clearInterval(auto);
    auto = on ? setInterval(tap, 200) : null;
  };
  setAuto(context.options?.["auto-strike"] === true);
  label();

  return {
    renderMode: "on-demand",
    resize({ width, height }) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
    localeChanged() { label(); },
    optionChanged(id, value) {
      if (id === "merit-1000") {
        merit += 1000;
        if (progress) void progress.save({ schemaVersion: 1, data: { merit } }).catch(() => {});
      }
      if (id === "rings") ring.visible = value;
      if (id === "auto-strike") setAuto(value);
      label();
      context.invalidate();
    },
    shareText(target) {
      const text = copy[target] || copy.en;
      return text.share(merit) + (context.cheatsUsed ? text.cheats : "");
    },
    dispose() {
      setAuto(false);
      scene.remove(probe, ring);
    },
  };
}
