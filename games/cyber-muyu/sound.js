// A wooden strike: an impact transient exciting several damped, inharmonic modes.
// All samples are synthesized locally. No recordings or audio downloads.
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

// Plays through the platform's shared AudioContext; the host unlocks, suspends, mutes and closes it.
export function createKnockAudio(audio, onUnavailable) {
  let buffer;
  let closed = false;
  const voices = new Set();

  function stop() {
    for (const voice of voices) {
      voice.source.stop();
      voice.source.disconnect();
      voice.gain.disconnect();
    }
    voices.clear();
  }

  return {
    strike() {
      if (closed) return;
      if (!audio) { onUnavailable(); return; }
      try {
        const { context, destination } = audio;
        if (!buffer) {
          const samples = synthesizeKnock(context.sampleRate);
          buffer = context.createBuffer(1, samples.length, context.sampleRate);
          buffer.copyToChannel(samples, 0);
        }
        if (voices.size >= 4) {
          const oldest = voices.values().next().value;
          oldest.source.stop();
          oldest.source.disconnect();
          oldest.gain.disconnect();
          voices.delete(oldest);
        }
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = buffer;
        source.playbackRate.value = 0.97 + Math.random() * 0.06;
        gain.gain.value = 0.3;
        source.connect(gain).connect(destination);
        const voice = { source, gain };
        voices.add(voice);
        source.onended = () => { source.disconnect(); gain.disconnect(); voices.delete(voice); };
        source.start();
      } catch { onUnavailable(); }
    },
    pause: stop,
    dispose() {
      closed = true;
      stop();
    },
  };
}

// The chant voice: one recorded phrase played a syllable at a time. Monophonic: each
// syllable cuts the previous one with a short fade, so fast strikes chant faster.
export function createChantVoice(audio, signal) {
  let buffer = null;
  let current = null;

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
    say([offset, duration]) {
      if (!buffer || signal.aborted) return;
      const { context, destination } = audio;
      const now = context.currentTime;
      if (current) release(current, now);
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.value = 0.55;
      source.connect(gain).connect(destination);
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
