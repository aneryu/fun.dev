// Every synthesized sound shares one key, D major pentatonic, so knocks, bowls, bells and
// chimes ring together. All samples are synthesized locally, except the recorded chant voice.
const D5 = 587.33;
const D6 = 1174.66;

// Scales a buffer to a peak, leaving headroom for overlapping strikes.
function normalize(samples, peak) {
  let max = 0;
  for (const sample of samples) max = Math.max(max, Math.abs(sample));
  if (max > 0) for (let i = 0; i < samples.length; i++) samples[i] *= peak / max;
  return samples;
}

// A hollow wooden strike tuned to D5: a bright mallet click, then the cavity's main mode,
// which settles from slightly sharp as a struck hollow body does, over damped, inharmonic
// wood modes. Higher modes die faster; a short high "tick" gives the knock its crispness.
const knockModes = [[1, 0.6, 19], [1.59, 0.24, 30], [2.41, 0.12, 46], [3.73, 0.06, 75], [6.1, 0.09, 240]];

export function synthesizeKnock(sampleRate, random = Math.random) {
  const samples = new Float32Array(Math.ceil(sampleRate * 0.35));
  // Each call detunes the modes a little, so a handful of variants never sound mechanical.
  const modes = knockModes.map(([ratio, amplitude, damping]) => ({ step: 2 * Math.PI * D5 * ratio * (1 + (random() - 0.5) * 0.012) / sampleRate, amplitude, damping, phase: 0 }));
  let previousNoise = 0;
  for (let i = 0; i < samples.length; i++) {
    const time = i / sampleRate;
    const glide = 1 + 0.03 * Math.exp(-time * 280);
    let sample = 0;
    for (const mode of modes) {
      mode.phase += mode.step * glide;
      sample += mode.amplitude * Math.sin(mode.phase) * Math.exp(-mode.damping * time);
    }
    // The click: about a millisecond of high-passed noise.
    const noise = random() * 2 - 1;
    sample += (noise - previousNoise) * Math.exp(-time * 1100) * 0.3;
    previousNoise = noise;
    // Smooth both boundaries.
    const attack = 1 - Math.exp(-time * 20000);
    const release = Math.min(1, (samples.length - 1 - i) / (sampleRate * 0.01));
    samples[i] = sample * attack * release;
  }
  return normalize(samples, 0.75);
}

// Struck metal: inharmonic partials, each a slightly detuned pair that beats slowly, after a
// brief bright strike. strike sets how much click comes before the ring.
export const bells = {
  // 铜磬: a small bowl on D6, with a bowl's partial ratios 1 : 2.76 : 5.4 : 8.9.
  bowl: { duration: 2.6, strike: 0.2, partials: [[D6, 0.5, 1.4], [D6 * 2.76, 0.22, 2.6], [D6 * 5.4, 0.08, 4.5], [D6 * 8.9, 0.03, 8]] },
  // 古钟: a temple bell on A3: hum, prime, minor tierce, quint, nominal and the upper partials.
  temple: { duration: 4.5, strike: 0.06, partials: [[110, 0.3, 0.45], [220, 0.4, 0.7], [264, 0.2, 0.9], [330, 0.14, 1.1], [440, 0.22, 1.3], [660, 0.08, 2], [880, 0.05, 2.8]] },
  // 风铃: a thin tube on D6, with a free bar's partial ratios 1 : 2.76 : 5.4.
  chime: { duration: 2.4, strike: 0.08, partials: [[D6, 0.45, 1.8], [D6 * 2.76, 0.16, 3.2], [D6 * 5.4, 0.05, 6]] },
};

export function synthesizeBell(sampleRate, { duration, strike, partials }, random = Math.random) {
  const samples = new Float32Array(Math.ceil(sampleRate * duration));
  let previousNoise = 0;
  for (let i = 0; i < samples.length; i++) {
    const time = i / sampleRate;
    let sample = 0;
    for (const [frequency, amplitude, damping] of partials) {
      // The beat between two close partials gives the shimmer of real bells.
      sample += amplitude * Math.exp(-damping * time) * (Math.sin(2 * Math.PI * frequency * time) + 0.3 * Math.sin(2 * Math.PI * frequency * 1.003 * time));
    }
    const noise = random() * 2 - 1;
    sample += (noise - previousNoise) * Math.exp(-time * 600) * strike;
    previousNoise = noise;
    const attack = 1 - Math.exp(-time * 6000);
    const release = Math.min(1, (samples.length - 1 - i) / (sampleRate * 0.05));
    samples[i] = sample * attack * release;
  }
  return normalize(samples, 0.8);
}

// A stereo hall used as a convolution impulse response: noise after a short pre-delay,
// two-pole low-passed ever more as it decays, since walls and air absorb the highs first.
export function synthesizeHall(sampleRate, seconds = 1.8, random = Math.random) {
  const length = Math.ceil(sampleRate * seconds);
  const preDelay = Math.floor(sampleRate * 0.012);
  return [0, 1].map(() => {
    const samples = new Float32Array(length);
    let first = 0;
    let second = 0;
    for (let i = preDelay; i < length; i++) {
      const time = (i - preDelay) / sampleRate;
      const cutoff = 400 + 9600 * Math.exp(-time * 2.5);
      const coefficient = 1 - Math.exp(-2 * Math.PI * cutoff / sampleRate);
      first += (random() * 2 - 1 - first) * coefficient;
      second += (first - second) * coefficient;
      samples[i] = second * Math.exp(-3.2 * time);
    }
    return samples;
  });
}

function makeBuffer(context, channels) {
  const buffer = context.createBuffer(channels.length, channels[0].length, context.sampleRate);
  channels.forEach((samples, index) => buffer.copyToChannel(samples, index));
  return buffer;
}

// Knock timbre per fish skin: playback rate (pitch, on a note of the key), loudness and an
// optional ring above the knock: [sound, gain, rate] for metal and jade.
const tones = {
  wood: { rate: 1, gain: 1 },
  lacquer: { rate: 9 / 8, gain: 1 },
  rosewood: { rate: 5 / 6, gain: 1.1 },
  bronze: { rate: 1, gain: 0.95, ring: ["bowl", 0.06, 1.5] },
  jade: { rate: 5 / 4, gain: 0.9, ring: ["chime", 0.05, 1] },
  gold: { rate: 8 / 9, gain: 1.1, ring: ["bowl", 0.09, 1.5] },
};

// Chime notes: D major pentatonic over an octave.
const chimeSteps = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2];
const knockVariants = 4;

// Plays through the platform's shared AudioContext; the host unlocks, suspends, mutes and closes it.
// strike({ zen, strength, soft, deep }): deeper zen sends more of each knock into the hall.
// A gentle compressor keeps overlapping knocks and bells from clipping.
export function createKnockAudio(audio, onUnavailable) {
  let buffers;
  let hall;
  let bus;
  let closed = false;
  let lastKnock = -1;
  let lastChime = -1;
  const voices = new Set();

  function setup() {
    const { context, destination } = audio;
    buffers = {
      knock: Array.from({ length: knockVariants }, () => makeBuffer(context, [synthesizeKnock(context.sampleRate)])),
      bowl: makeBuffer(context, [synthesizeBell(context.sampleRate, bells.bowl)]),
      temple: makeBuffer(context, [synthesizeBell(context.sampleRate, bells.temple)]),
      chime: makeBuffer(context, [synthesizeBell(context.sampleRate, bells.chime)]),
    };
    bus = context.createDynamicsCompressor();
    bus.threshold.value = -12;
    bus.knee.value = 12;
    bus.ratio.value = 4;
    bus.attack.value = 0.003;
    bus.release.value = 0.25;
    bus.connect(destination);
    hall = context.createConvolver();
    hall.buffer = makeBuffer(context, synthesizeHall(context.sampleRate));
    hall.connect(bus);
  }

  function end(voice) {
    try { voice.source.stop(); } catch { /* Already stopped. */ }
    for (const node of voice.nodes) node.disconnect();
    voices.delete(voice);
  }

  // A random index that differs from the previous one.
  function pick(count, previous) {
    if (previous < 0) return Math.floor(Math.random() * count);
    const index = Math.floor(Math.random() * (count - 1));
    return index >= previous ? index + 1 : index;
  }

  function play(buffer, { gain = 0.3, rate = 1, send = 0, limit = 6, lowpass = 0 } = {}) {
    if (closed) return;
    if (!audio) { onUnavailable(); return; }
    try {
      if (!buffers) setup();
      const { context } = audio;
      if (voices.size >= limit) end(voices.values().next().value);
      const source = context.createBufferSource();
      const level = context.createGain();
      source.buffer = typeof buffer === "string" ? buffers[buffer] : buffer(buffers);
      source.playbackRate.value = rate;
      level.gain.value = gain;
      const nodes = [source, level];
      if (lowpass) {
        const filter = context.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = lowpass;
        source.connect(filter).connect(level);
        nodes.push(filter);
      } else source.connect(level);
      level.connect(bus);
      if (send > 0) {
        const wet = context.createGain();
        wet.gain.value = send;
        level.connect(wet).connect(hall);
        nodes.push(wet);
      }
      const voice = { source, nodes };
      voices.add(voice);
      source.onended = () => end(voice);
      source.start();
    } catch { onUnavailable(); }
  }

  return {
    // strength (about 0.5–1.5) comes from the mallet's speed at contact. The fish's skin sets
    // the timbre; the mallet wrap softens the knock and the rosewood mallet makes it deeper.
    strike({ zen = 0, strength = 1, soft = false, deep = false, skin = "wood" } = {}) {
      const tone = tones[skin] ?? tones.wood;
      const gain = 0.32 * tone.gain * (deep ? 1.15 : 1) * Math.min(1.3, 0.55 + 0.45 * strength);
      const rate = (0.99 + Math.random() * 0.02) * tone.rate * (deep ? 5 / 6 : 1) * (1 - zen * 0.04);
      lastKnock = pick(knockVariants, lastKnock);
      const variant = lastKnock;
      play((all) => all.knock[variant], { gain, rate, send: 0.08 + zen * 0.45, lowpass: soft ? 1300 : 0 });
      if (tone.ring) {
        const [name, ringGain, ringRate] = tone.ring;
        play(name, { gain: ringGain * Math.min(1.3, strength), rate: ringRate * rate, send: 0.3, lowpass: soft ? 2500 : 0 });
      }
    },
    // One wind chime, on a note of the pentatonic scale that differs from the last one.
    chime(gain = 0.07) {
      lastChime = pick(chimeSteps.length, lastChime);
      play("chime", { gain: gain * (0.8 + Math.random() * 0.4), rate: chimeSteps[lastChime], send: 0.6 });
    },
    bell(name, gain = 0.25) { play(name, { gain, send: 0.5 }); },
    pause() { for (const voice of [...voices]) end(voice); },
    dispose() {
      closed = true;
      for (const voice of [...voices]) end(voice);
      hall?.disconnect();
      bus?.disconnect();
    },
  };
}

// The chant voice: one recorded phrase played a syllable at a time. Monophonic: each
// syllable cuts the previous one with a short fade. Fast beats speed the voice up (up to 2×).
// A shared space gives it a soft, darkening echo and a hall; their tails outlast a cut syllable.
export function createChantVoice(audio, signal) {
  let buffer = null;
  let current = null;
  let space = null;

  function spaceInput() {
    if (space) return space;
    const { context, destination } = audio;
    const input = context.createGain();
    const delay = context.createDelay(1);
    delay.delayTime.value = 0.18;
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2500;
    const feedback = context.createGain();
    feedback.gain.value = 0.3;
    const echo = context.createGain();
    echo.gain.value = 0.22;
    const hall = context.createConvolver();
    hall.buffer = makeBuffer(context, synthesizeHall(context.sampleRate, 2.2));
    const wet = context.createGain();
    wet.gain.value = 0.25;
    input.connect(destination);
    input.connect(delay).connect(tone).connect(feedback).connect(delay);
    tone.connect(echo).connect(destination);
    input.connect(hall).connect(wet).connect(destination);
    const nodes = [input, delay, tone, feedback, echo, hall, wet];
    signal.addEventListener("abort", () => { for (const node of nodes) node.disconnect(); }, { once: true });
    space = input;
    return space;
  }

  function release(voice, at) {
    voice.gain.gain.cancelScheduledValues(at);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, at);
    voice.gain.gain.linearRampToValueAtTime(0, at + 0.03);
    voice.source.stop(at + 0.03);
  }

  return {
    // Resolves once decoded; a failure only leaves the chant silent.
    async load(response) {
      const data = await (await response).arrayBuffer();
      signal.throwIfAborted();
      buffer = await audio.context.decodeAudioData(data);
    },
    say([offset, duration], interval = Infinity) {
      if (!buffer || signal.aborted) return;
      const { context } = audio;
      const now = context.currentTime;
      if (current) release(current, now);
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      source.playbackRate.value = Math.min(2, Math.max(1, duration / interval));
      gain.gain.value = 0.55;
      source.connect(gain).connect(spaceInput());
      const voice = { source, gain };
      current = voice;
      source.onended = () => { source.disconnect(); gain.disconnect(); if (current === voice) current = null; };
      source.start(now, offset, duration);
    },
    stop() {
      if (current) release(current, audio.context.currentTime);
      current = null;
    },
  };
}
