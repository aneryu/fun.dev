// One AudioContext for the page. Each game session gets its own gain node behind the
// platform master gain, so mute/volume apply everywhere and teardown cuts the session off.
export function createAudioHub() {
  let context = null;
  let master = null;
  let muted = false;
  let volume = 1;
  let unlocked = false;
  let active = false;

  function apply() {
    if (master) master.gain.value = muted ? 0 : volume;
  }

  function ensure() {
    if (!context) {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return null;
      context = new AudioContextClass();
      master = context.createGain();
      master.connect(context.destination);
      apply();
    }
    return context;
  }

  return {
    session() {
      try {
        if (!ensure()) return null;
        const destination = context.createGain();
        destination.connect(master);
        return { api: Object.freeze({ context, destination }), dispose() { destination.disconnect(); } };
      } catch { return null; }
    },
    // Called from a user gesture: browsers only start audio after one.
    unlock() {
      unlocked = true;
      if (active && context?.state === "suspended") context.resume().catch(() => {});
    },
    setActive(running) {
      active = running;
      if (!context) return;
      if (running && unlocked) context.resume().catch(() => {});
      else if (!running && context.state === "running") context.suspend().catch(() => {});
    },
    setPreferences(preferences) {
      muted = !!preferences.muted;
      volume = Math.min(1, Math.max(0, Number(preferences.volume ?? 1)));
      apply();
    },
  };
}
