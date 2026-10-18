// Clips of a loaded or placed .fun3d model through one AnimationMixer (docs/model-format.md §4.6).
// Release 1 plays node channels; events, masks, additive blending and retargeting come with
// release 2.
//
//   const animator = createAnimator({ THREE }, model);     // model = fun3d.load(...) or models.place(...)
//   animator.play("walk", { fade: 0.2 });
//   animator.update(dt);

export function createAnimator({ THREE }, model) {
  const mixer = new THREE.AnimationMixer(model.root);
  const clips = new Map((model.animations ?? model.file?.animations ?? []).map((clip) => [clip.name, clip]));
  const actions = new Map();
  let current = null;
  const loopModes = { repeat: THREE.LoopRepeat, once: THREE.LoopOnce };

  function action(id) {
    if (actions.has(id)) return actions.get(id);
    const clip = clips.get(id);
    if (!clip) throw new Error(`no clip "${id}"`);
    const a = mixer.clipAction(clip);
    const loop = clip.userData?.loop ?? "repeat";
    a.setLoop(loopModes[loop] ?? THREE.LoopRepeat, Infinity);
    if (loop === "once") a.clampWhenFinished = true;
    actions.set(id, a);
    return a;
  }

  return {
    mixer,
    clips: () => [...clips.keys()],
    /** Plays a clip by id, cross-fading from the current one over `fade` seconds. */
    play(id, { fade = 0.2, timeScale = 1, weight = 1, reset = true } = {}) {
      const next = action(id);
      next.timeScale = timeScale;
      next.enabled = true;
      if (reset) next.reset();
      next.setEffectiveWeight(weight);
      if (current && current !== next) { next.crossFadeFrom(current, fade, true); }
      else next.fadeIn(fade);
      next.play();
      current = next;
      return next;
    },
    stop({ fade = 0.2 } = {}) { if (current) { current.fadeOut(fade); current = null; } },
    get current() { return current ? current.getClip().name : null; },
    update(dt) { mixer.update(dt); },
    dispose() { mixer.stopAllAction(); mixer.uncacheRoot(model.root); },
  };
}
