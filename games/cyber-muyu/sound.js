// A wooden strike: an impact transient exciting several damped, inharmonic modes.
// All samples are synthesized locally, except the recorded chant voice in assets/.
export function synthesizeKnock(sampleRate) {
  const samples = new Float32Array(Math.ceil(sampleRate * 0.3));
  const modes = [[510, 0.48, 23], [863, 0.27, 29], [1427, 0.13, 42], [2311, 0.07, 65]];
  let previousNoise = 0;
  for (let i = 0; i < samples.length; i++) {
    const time = i / sampleRate;
    let sample = 0;
    for (const [frequency, amplitude, damping] of modes) {
      sample += amplitude * Math.sin(2 * Math.PI * frequency * time) * Math.exp(-damping * time);
    }
    const noise = Math.random() * 2 - 1;
    sample += (noise - previousNoise * 0.65) * Math.exp(-time * 210) * 0.2;
    previousNoise = noise;
    // Smooth both boundaries and leave headroom for overlapping strikes.
    const attack = 1 - Math.exp(-time * 16000);
    const release = Math.min(1, (samples.length - 1 - i) / (sampleRate * 0.01));
    samples[i] = Math.tanh(sample * attack) * 0.8 * release;
  }
  return samples;
}

// Struck metal: slowly decaying inharmonic partials. Presets for the 磬 and the temple bell.
export const bells = {
  bowl: { duration: 2.4, partials: [[1180, 0.5, 1.6], [2920, 0.25, 2.4], [5210, 0.1, 4], [7900, 0.04, 6]] },
  temple: { duration: 4, partials: [[98, 0.45, 0.7], [196, 0.3, 0.9], [233, 0.2, 1.1], [392, 0.12, 1.6], [587, 0.06, 2.4]] },
  chime: { duration: 2.2, partials: [[2093, 0.4, 2.2], [3140, 0.15, 3], [5260, 0.1, 4.5]] },
};

export function synthesizeBell(sampleRate, { duration, partials }) {
  const samples = new Float32Array(Math.ceil(sampleRate * duration));
  for (let i = 0; i < samples.length; i++) {
    const time = i / sampleRate;
    let sample = 0;
    for (const [frequency, amplitude, damping] of partials) {
      // A slight beat between two close partials gives the shimmer of real bells.
      sample += amplitude * Math.exp(-damping * time) * (Math.sin(2 * Math.PI * frequency * time) + 0.3 * Math.sin(2 * Math.PI * frequency * 1.003 * time));
    }
    const attack = 1 - Math.exp(-time * 3000);
    const release = Math.min(1, (samples.length - 1 - i) / (sampleRate * 0.05));
    samples[i] = Math.tanh(sample * attack * 0.8) * release;
  }
  return samples;
}

// A short stereo hall: decaying noise, used as a convolution impulse response.
function synthesizeHall(sampleRate, seconds = 1.8) {
  const length = Math.ceil(sampleRate * seconds);
  return [0, 1].map(() => {
    const samples = new Float32Array(length);
    for (let i = 0; i < length; i++) samples[i] = (Math.random() * 2 - 1) * Math.exp(-3.2 * i / length * seconds);
    return samples;
  });
}

function makeBuffer(context, channels) {
  const buffer = context.createBuffer(channels.length, channels[0].length, context.sampleRate);
  channels.forEach((samples, index) => buffer.copyToChannel(samples, index));
  return buffer;
}

// Knock timbre per fish skin: playback rate (pitch), loudness, and an optional metallic ring.
const tones = {
  wood: { rate: 1, gain: 1 },
  lacquer: { rate: 1.08, gain: 1 },
  rosewood: { rate: 0.86, gain: 1.1 },
  bronze: { rate: 0.97, gain: 0.95, metal: 0.06 },
  jade: { rate: 1.3, gain: 0.9 },
  gold: { rate: 0.92, gain: 1.1, metal: 0.09 },
};

// Plays through the platform's shared AudioContext; the host unlocks, suspends, mutes and closes it.
// strike({ zen, strength, soft, deep }): deeper zen sends more of each knock into the hall.
export function createKnockAudio(audio, onUnavailable) {
  let buffers;
  let hall;
  let closed = false;
  const voices = new Set();

  function setup() {
    const { context, destination } = audio;
    buffers = {
      knock: makeBuffer(context, [synthesizeKnock(context.sampleRate)]),
      bowl: makeBuffer(context, [synthesizeBell(context.sampleRate, bells.bowl)]),
      temple: makeBuffer(context, [synthesizeBell(context.sampleRate, bells.temple)]),
      chime: makeBuffer(context, [synthesizeBell(context.sampleRate, bells.chime)]),
    };
    const convolver = context.createConvolver();
    convolver.buffer = makeBuffer(context, synthesizeHall(context.sampleRate));
    convolver.connect(destination);
    hall = convolver;
  }

  function end(voice) {
    try { voice.source.stop(); } catch { /* Already stopped. */ }
    for (const node of voice.nodes) node.disconnect();
    voices.delete(voice);
  }

  function play(name, { gain = 0.3, rate = 1, send = 0, limit = 6, lowpass = 0 } = {}) {
    if (closed) return;
    if (!audio) { onUnavailable(); return; }
    try {
      if (!buffers) setup();
      const { context, destination } = audio;
      if (voices.size >= limit) end(voices.values().next().value);
      const source = context.createBufferSource();
      const level = context.createGain();
      source.buffer = buffers[name];
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
      level.connect(destination);
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
      const gain = 0.3 * tone.gain * (deep ? 1.15 : 1) * Math.min(1.3, 0.55 + 0.45 * strength);
      const rate = (0.97 + Math.random() * 0.06) * tone.rate * (deep ? 0.82 : 1) - zen * 0.04;
      play("knock", { gain, rate, send: 0.08 + zen * 0.45, lowpass: soft ? 1300 : 0 });
      // Metal skins add a short, quiet ring above the knock.
      if (tone.metal) play("bowl", { gain: tone.metal * Math.min(1.3, strength), rate: 1.6 * rate, send: 0.3 });
    },
    // One wind chime, on a random note of a pentatonic scale.
    chime(gain = 0.07) {
      const steps = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2];
      play("chime", { gain, rate: steps[Math.floor(Math.random() * steps.length)], send: 0.6 });
    },
    bell(name, gain = 0.25) { play(name, { gain, send: 0.5 }); },
    pause() { for (const voice of [...voices]) end(voice); },
    dispose() {
      closed = true;
      for (const voice of [...voices]) end(voice);
      hall?.disconnect();
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
