// A game bundle written only against docs/game-bundles.md, used to prove the fun host adapter:
// a .fun3d model through readAsset, a texture through assets.texture, kit text as a HUD label,
// pointer input, a sound through context.audio, options, and the lifecycle hooks.
export const options = [
  { id: "spin", section: "settings", type: "range", min: 0, max: 3, step: 0.5, default: 1, label: { zh: "转速", en: "Spin" } },
  { id: "tint", section: "cheats", type: "toggle", label: { zh: "染色", en: "Tint" } },
];

export async function createGame(context) {
  const { THREE, scene, camera } = context;
  const [{ createAssets }, { createText, createHudLayer }, { createPointer }, { createFun3d }, { createMaterials }, { createPhysics }] = await Promise.all([
    context.runtime("kit/assets.js"), context.runtime("kit/text.js"), context.runtime("kit/input.js"), context.runtime("kit/fun3d.js"), context.runtime("kit/materials.js"), context.runtime("kit/physics.js"),
  ]);
  scene.background = new THREE.Color("#dfe7f0");
  camera.position.set(4, 3, 7); camera.lookAt(0, 1.3, 0);
  scene.add(new THREE.HemisphereLight("#ffffff", "#6b7280", 1.2));
  const sun = new THREE.DirectionalLight("#fff4e0", 2.5); sun.position.set(3, 5, 2); scene.add(sun);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(4, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#9aa6b2" }));
  scene.add(ground);

  // Progress and device storage, as a game uses them: a launch counter and a kept blob.
  const progress = context.progress?.version === 1 ? context.progress : null;
  const saved = progress ? await progress.load() : { kind: "empty" };
  const launches = (saved.kind === "saved" ? saved.snapshot.data.launches : 0) + 1;
  if (progress) await progress.save({ schemaVersion: 1, data: { launches } });
  let kept = null;
  if (context.deviceStorage) {
    const previous = await context.deviceStorage.get("note");
    kept = previous ? new TextDecoder().decode(await previous.arrayBuffer()) : null;
    await context.deviceStorage.set("note", new Blob([new TextEncoder().encode(`launch ${launches}`)]));
  }
  context.announce(`launch ${launches}, kept ${kept ?? "nothing"}`);

  const assets = createAssets(context);
  ground.material.map = await assets.texture("assets/swatch.png");
  ground.material.needsUpdate = true;
  // A texture with alpha (straight on fun, premultiplied by browsers): the hosts must agree on it.
  try {
    const badge = await assets.texture("assets/badge.png");
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: badge, transparent: true }));
    plane.position.set(-1.8, 0.02, 1.2);
    scene.add(plane);
  } catch { /* no badge in this bundle */ }
  const fun3d = createFun3d({ THREE, materials: createMaterials({ THREE, TSL: THREE.TSL }), decodeImage: context.decodeImage });
  const model = await fun3d.load(await context.readAsset("assets/model.fun3d"));
  scene.add(model.root);
  context.onCleanup(() => model.dispose?.());
  // Physics as a game asks for it, with no host-specific loader: the model's bodies (if any) fall onto a ground.
  const physics = await createPhysics({ THREE, scene });
  physics.add(model);
  physics.addStatic({ type: "box", halfExtents: [20, 0.5, 20] }, { position: [0, -0.5, 0] });
  context.onCleanup(() => physics.dispose());
  context.announce(`physics ready, bodies ${physics.bodies?.size ?? "?"}`);

  const hud = createHudLayer(camera);
  scene.add(camera);
  const label = context.track(createText({ text: "fun 宿主适配器", size: 24, hud: true, color: "#1a1a1a", background: "#ffffffcc", padding: 6 }, { createCanvas2D: context.createCanvas2D }));
  const taps = context.track(createText({ text: `launch ${launches}, taps 0`, size: 20, hud: true, color: "#1a1a1a" }, { createCanvas2D: context.createCanvas2D }));
  let tapCount = 0;
  const pointer = createPointer(context.canvas, context.viewport, { signal: context.signal });
  pointer.on?.("tap", () => { tapCount++; taps.setText(`launch ${launches}, taps ${tapCount}`); });

  // A 0.2 s beep through the host's audio session, if the host has audio.
  if (context.audio) {
    const { context: ac, destination } = context.audio;
    const buffer = ac.createBuffer(1, Math.round(ac.sampleRate * 0.2), ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / ac.sampleRate * 440 * Math.PI * 2) * 0.2;
    const source = ac.createBufferSource(); source.buffer = buffer; source.connect(destination); source.start();
  }

  let spin = context.options.spin, elapsedSeen = 0;
  return {
    update(delta, elapsed) { model.root.rotation.y += delta * spin; physics.step(delta); elapsedSeen = elapsed; },
    resize(view) { hud.resize(view); hud.place(label.object, { x: 16 + label.width / 2, y: 16 + label.height / 2 }); hud.place(taps.object, { x: 16 + taps.width / 2, y: 24 + label.height + taps.height / 2 }); camera.aspect = view.width / view.height; camera.updateProjectionMatrix(); },
    optionChanged(id, value) { if (id === "spin") spin = value; if (id === "tint") model.root.traverse((o) => { o.material?.color?.set?.(value ? "#ff8080" : "#ffffff"); }); },
    localeChanged(locale) { label.setText(locale === "zh" ? "fun 宿主适配器" : "fun host adapter"); },
    shareText: () => `spun for ${elapsedSeen.toFixed(1)} s`,
    dispose() { hud.dispose(); },
  };
}
