// Every sound is synthesized here: the knife's scrape follows the hand, flakes of stone tick
// as they break off, a breath blows the powder away. No music: the carving is the music.

// A deterministic noise buffer, so sounds are reproducible in tests.
function noise(length, seed = 1) {
  const samples = new Float32Array(length);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    samples[i] = ((state >>> 0) / 4294967296) * 2 - 1;
  }
  return samples;
}

// A flake breaking off, after the carving video's cracks: a broadband click (the fracture),
// a short ring of the stone at a few kHz, and a dull knock through the stone's body, the
// whole falling to half in about 30 ms. Bigger flakes (size 0..1) ring lower and knock more.
export function synthesizeChip(sampleRate, size = 0.5, random = Math.random) {
  const samples = new Float32Array(Math.ceil(sampleRate * (0.05 + 0.04 * size)));
  const source = noise(samples.length, Math.floor(random() * 1e9) + 1);
  const ring = (4200 - 2400 * size) * (0.85 + 0.3 * random());
  const body = (620 - 260 * size) * (0.9 + 0.2 * random());
  // Two-pole resonator for the ring, excited by the click.
  const r = Math.exp(-Math.PI * ring / 9 / sampleRate), w = 2 * Math.PI * ring / sampleRate;
  const a1 = 2 * r * Math.cos(w), a2 = -r * r;
  let y1 = 0, y2 = 0, phase = 0, low = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    const click = source[i] * Math.exp(-t * 1800);
    const y = click + a1 * y1 + a2 * y2;
    y2 = y1; y1 = y;
    phase += 2 * Math.PI * body / sampleRate;
    low += (source[i] - low) * 0.08;
    samples[i] = click * 0.9 + y * 0.12 * Math.exp(-t * (40 - 15 * size)) + Math.sin(phase) * (0.15 + 0.45 * size) * Math.exp(-t * 55) + low * 0.25 * Math.exp(-t * 25);
  }
  return samples;
}

// A breath: noise that swells and fades, its brightness following the breath's strength.
export function synthesizeBlow(sampleRate) {
  const length = Math.ceil(sampleRate * 0.75);
  const samples = new Float32Array(length);
  const source = noise(length, 7);
  let low = 0, lower = 0;
  for (let i = 0; i < length; i++) {
    const t = i / length;
    const envelope = Math.sin(Math.PI * Math.min(1, t * 1.6)) ** 1.5 * (1 - t) ** 0.6;
    const cutoff = 0.08 + 0.22 * envelope;
    low += (source[i] - low) * cutoff;
    lower += (low - lower) * 0.02;
    samples[i] = (low - lower * 0.9) * envelope;
  }
  return samples;
}

// A finished cut: a soft, dry tap of the knife lifting off.
export function synthesizeTap(sampleRate) {
  const samples = new Float32Array(Math.ceil(sampleRate * 0.08));
  const source = noise(samples.length, 3);
  let phase = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    phase += 2 * Math.PI * 1450 / sampleRate;
    samples[i] = Math.sin(phase) * Math.exp(-t * 70) * 0.5 + source[i] * Math.exp(-t * 400) * 0.3;
  }
  return samples;
}

const normalize = (samples, peak) => {
  let max = 0;
  for (const sample of samples) max = Math.max(max, Math.abs(sample));
  if (max > 0) for (let i = 0; i < samples.length; i++) samples[i] *= peak / max;
  return samples;
};

export function createSound(audio, onFailure) {
  if (!audio) return { scrape() {}, chip() {}, blow() {}, tap() {}, silence() {}, dispose() {} };
  const { context, destination } = audio;
  const buffer = (samples) => {
    const result = context.createBuffer(1, samples.length, context.sampleRate);
    result.copyToChannel(samples, 0);
    return result;
  };
  let scrape = null;
  let chips = [], blowBuffer = null, tapBuffer = null;
  try {
    // Three flake sizes, four variants each, so no two cracks in a row sound alike.
    chips = [0.15, 0.5, 0.9].map((size, group) => Array.from({ length: 4 }, (_, i) => {
      let seed = group * 10 + i + 1;
      const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      return buffer(normalize(synthesizeChip(context.sampleRate, size, random), 0.5));
    }));
    blowBuffer = buffer(normalize(synthesizeBlow(context.sampleRate), 0.6));
    tapBuffer = buffer(normalize(synthesizeTap(context.sampleRate), 0.35));
  } catch { onFailure(); }

  // The scrape: looping noise through a resonant band, louder and brighter with speed.
  function startScrape() {
    if (scrape) return scrape;
    try {
      const source = context.createBufferSource();
      source.buffer = buffer(noise(context.sampleRate * 2, 11));
      source.loop = true;
      const band = context.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 2200;
      band.Q.value = 1.4;
      const gain = context.createGain();
      gain.gain.value = 0;
      source.connect(band).connect(gain).connect(destination);
      source.start();
      scrape = { source, band, gain };
    } catch { onFailure(); }
    return scrape;
  }

  function oneShot(sound, volume, rate = 1) {
    if (!sound || context.state !== "running") return;
    try {
      const source = context.createBufferSource();
      source.buffer = sound;
      source.playbackRate.value = rate;
      const gain = context.createGain();
      gain.gain.value = volume;
      source.connect(gain).connect(destination);
      source.start();
    } catch { onFailure(); }
  }

  return {
    // force: 0 (resting) .. 1 (pulling hard); called every frame while the knife is in the stone.
    // A quiet grind under the blade: the cracks carry the sound.
    scrape(speed) {
      const node = speed > 0 ? startScrape() : scrape;
      if (!node) return;
      const now = context.currentTime;
      node.gain.gain.setTargetAtTime(Math.min(0.12, speed * 0.1), now, 0.02);
      node.band.frequency.setTargetAtTime(1800 + speed * 1600, now, 0.04);
    },
    // size 0..1 picks the flake, force 0..1 how hard it was pushed: louder when forced.
    chip(size = 0.5, force = 0.5) {
      const group = chips[size < 0.33 ? 0 : size < 0.66 ? 1 : 2];
      if (group) oneShot(group[Math.floor(Math.random() * group.length)], 0.2 + 0.45 * force, 0.92 + Math.random() * 0.16);
    },
    blow(strength = 1) { oneShot(blowBuffer, 0.4 + 0.5 * strength, 0.9 + 0.2 * strength); },
    tap() { oneShot(tapBuffer, 0.6); },
    silence() { if (scrape) scrape.gain.gain.setTargetAtTime(0, context.currentTime, 0.02); },
    dispose() {
      if (!scrape) return;
      try { scrape.source.stop(); } catch { /* already stopped */ }
      scrape.source.disconnect(); scrape.gain.disconnect();
      scrape = null;
    },
  };
}
