// Shared source copied into five independently runnable game bundles.
// App behavior lives here; source models, World and .fun3d contain only data.
export const options = [
  { id: 'activate', section: 'settings', type: 'action', label: { en: 'Play / interact', zh: '播放 / 互动' } },
  { id: 'pause', section: 'settings', type: 'action', label: { en: 'Pause', zh: '暂停' } },
  { id: 'reset', section: 'settings', type: 'action', label: { en: 'Reset', zh: '重置' } },
];

export async function createGame(context) {
  const { THREE, scene, camera, signal } = context;
  const json = async path => JSON.parse(new TextDecoder().decode(await context.readAsset(path)));
  const config = await json('assets/app.json'); signal.throwIfAborted();
  const [{ createFun3d }, { createMaterials }, { MeshoptDecoder }, { createPresentation }, { createTimeline }, { createAnimator }, { createFixedStep }] = await Promise.all([
    context.runtime('kit/fun3d.js'), context.runtime('kit/materials.js'), context.runtime('addons/MeshoptDecoder.js'),
    context.runtime('kit/presentation.js'), context.runtime('kit/timeline.js'), context.runtime('kit/animation.js'), context.runtime('kit/loop.js'),
  ]);
  const materials = createMaterials({ THREE, TSL: THREE.TSL });
  const extensions = {};
  if (config.kind === 'E') {
    const { createRippleExtension } = await context.runtime('kit/ripple.js');
    extensions['fun3d.ripple'] = createRippleExtension({ THREE, TSL: THREE.TSL, backend: context.graphics.backend });
  }
  const fun3d = createFun3d({ THREE, decoder: MeshoptDecoder, materials, decodeImage: context.decodeImage, extensions });
  const owned = [], own = item => { owned.push(item); return item; };
  let file, world, physics, ball, ballHandle, models, animator, action, timeline, presentation;
  let time = 0, playing = false, activated = false, disposed = false;
  const fixed = createFixedStep({ step: 1/60, maxSteps: 5 });
  const dispose = () => { if (disposed) return; disposed = true; for (const item of owned.reverse()) item.dispose?.(); };
  context.onCleanup(dispose);
  try {
    if (config.kind === 'C') {
      const [{ createWorld }, { createModels }, { createPhysics }] = await Promise.all([context.runtime('kit/world.js'), context.runtime('kit/models.js'), context.runtime('kit/physics.js')]);
      physics = own(await createPhysics({ THREE, scene }));
      models = own(createModels({ THREE, scene, materials }));
      world = own(await createWorld({ fun3d, models, physics, read: context.readAsset, json, warn: m => { throw new Error(m); } }, 'assets/world/world.json', { radius: 8, far: 28 }));
      world.focus([-20,0,0]); await world.settle();
      ball = own(await fun3d.load(await context.readAsset('assets/ball.fun3d'))); scene.add(ball.root);
      ballHandle = physics.add(ball); owned.push({ dispose() { ballHandle?.remove(); } });
      presentation = own(await createPresentation(context, world.manifest.presentation));
    } else {
      file = own(await fun3d.load(await context.readAsset('assets/model.fun3d'), { keepSources: true })); scene.add(file.root);
      presentation = own(await createPresentation(context, file.extensions['fun3d.presentation']));
      if (config.kind === 'B') { animator = own(createAnimator({ THREE }, file)); }
      if (config.kind === 'D') timeline = own(createTimeline(config.timeline, { lid: file.node('dome'), camera }));
    }
    signal.throwIfAborted();
    function reset() {
      playing = false; activated = false; time = 0; fixed.reset(); timeline?.reset();
      if (action) { animator.mixer.stopAllAction(); animator.mixer.update(0); action = null; }
      if (file && config.kind === 'A') file.root.rotation.y = 0;
      for (const effect of file?.effects.values() ?? []) effect.update(0);
      if (world) {
        world.focus([-20,0,0]); ballHandle.remove();
        ball.node('ball').position.set(-20,3,0); ball.node('ball').quaternion.identity(); ballHandle = physics.add(ball);
        camera.position.fromArray(presentation.config.camera.position);
        camera.lookAt(...presentation.config.camera.target);
      }
      context.invalidate();
    }
    function command(id) {
      if (id === 'reset') reset();
      if (id === 'pause') { playing = false; timeline?.pause(); }
      if (id === 'activate') {
        activated = true; playing = true; timeline?.play();
        if (animator) action = animator.play('wave', { fade: 0, reset: true });
        if (config.kind === 'A') file.root.rotation.y = Math.PI / 3;
      }
      context.announce?.(`${config.kind}: ${id}`); context.invalidate();
    }
    context.canvas.addEventListener('pointerdown', () => command('activate'), { signal });
    context.canvas.addEventListener('keydown', e => {
      const id = { Enter: 'activate', ' ': 'activate', p: 'pause', r: 'reset' }[e.key];
      if (id) { e.preventDefault(); command(id); }
    }, { signal });
    context.canvas.setAttribute?.('aria-label', 'Toy lab. Tap or Enter to play. P pauses. R resets.');
    const snapshot = () => ({ kind: config.kind, time, playing, activated, timeline: timeline?.snapshot() ?? null,
      camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() },
      angle: file?.root.rotation.y ?? 0,
      effectTime: file?.effects.get('fun3d.ripple')?.uniforms?.time.value ?? null,
      morph: file ? [...file.nodes.values()].filter(n=>n.isSkinnedMesh).flatMap(n=>n.morphTargetInfluences ?? []) : [],
      ball: ball?.node('ball').position.toArray() ?? null, bodies: physics?.system.GetNumBodies() ?? 0,
      tiles: world?.tiles().map(t=>({ x:t.x, z:t.z, state:t.state, error:t.error ?? null })) ?? [],
      resources: { textures: file?.textures.size ?? 0, geometries: file?.geometries.size ?? 0 },
    });
    return {
      renderMode: 'continuous', optionChanged: command, command, snapshot, settle: () => world?.settle(),
      // Physical exploration supports reset/replay; only the nonphysical timeline seeks.
      seek(value) { if (!timeline) throw new Error('Seek unsupported; reset and replay'); return timeline.seek(value); },
      update(dt) {
        if (disposed || !playing) return;
        fixed.advance(dt, step => {
          time += step; animator?.update(step); timeline?.update(step);
          for (const effect of file?.effects.values() ?? []) effect.update(time);
          if (world) {
            const x = -20 + 40 * (1 - Math.abs((time % 20)/10 - 1));
            world.focus([x,0,0]); camera.position.set(x,7,10); camera.lookAt(x,0,0); physics.step(step);
          }
        });
        presentation.update(dt);
      },
      resize({width,height}) {
        camera.aspect = width/height;
        // Keep the horizontal framing on narrow screens; the authored vertical
        // field of view is unchanged on landscape displays.
        const base = presentation.config.camera.fov;
        camera.fov = camera.aspect < 1 ? Math.min(110, 2*Math.atan(Math.tan(base*Math.PI/360)/camera.aspect)*180/Math.PI) : base;
        camera.updateProjectionMatrix();
      },
      shareText() { return JSON.stringify(snapshot()); }, dispose,
    };
  } catch (error) { dispose(); throw error; }
}
