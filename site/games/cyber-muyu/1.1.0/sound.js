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

export function createKnockAudio(onUnavailable) {
  let context;
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
      try {
        if (!context) {
          context = new AudioContext();
          const samples = synthesizeKnock(context.sampleRate);
          buffer = context.createBuffer(1, samples.length, context.sampleRate);
          buffer.copyToChannel(samples, 0);
        }
        // Called directly by a click/key activation to meet autoplay requirements.
        context.resume().catch(onUnavailable);
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
        source.connect(gain).connect(context.destination);
        const voice = { source, gain };
        voices.add(voice);
        source.onended = () => { source.disconnect(); gain.disconnect(); voices.delete(voice); };
        source.start();
      } catch { onUnavailable(); }
    },
    pause() { stop(); context?.suspend().catch(() => {}); },
    dispose() {
      closed = true;
      stop();
      context?.close().catch(() => {});
    },
  };
}
