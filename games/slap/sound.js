// Synthesized sounds: no recordings, so nothing to license and nothing to download.
export function createSound(audio) {
  if (!audio) return { slap() {}, poke() {}, twinkle() {}, climax() {}, stop() {} };
  const { context: ctx, destination } = audio;
  const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.6), ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const live = new Set();

  function source(node, stopAt) {
    live.add(node);
    node.onended = () => live.delete(node);
    node.stop(stopAt);
    return node;
  }
  function noiseBurst(t, { rate = 1, filters, gain, attack = 0.001, decay }) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = rate;
    let node = src;
    for (const [type, frequency, q = 0.7] of filters) {
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = frequency; f.Q.value = q;
      node.connect(f); node = f;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g).connect(destination);
    src.start(t, Math.random() * 0.2);
    source(src, t + attack + decay + 0.05);
  }
  function tone(t, { type = "sine", from, to, gain, decay, vibrato = 0 }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + decay);
    if (vibrato) {
      const lfo = ctx.createOscillator(), depth = ctx.createGain();
      lfo.frequency.value = 11; depth.gain.value = vibrato;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t); source(lfo, t + decay + 0.05);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(g).connect(destination);
    osc.start(t);
    source(osc, t + decay + 0.05);
  }

  return {
    // strength 0..1: light pat, smack, crack, the big one.
    slap(strength, { duang = true } = {}) {
      const t = ctx.currentTime + 0.002;
      const tier = strength < 0.3 ? 0 : strength < 0.6 ? 1 : strength < 0.85 ? 2 : 3;
      const rate = 0.9 + Math.random() * 0.2;
      const loud = [0.35, 0.6, 0.85, 1][tier];
      noiseBurst(t, { rate, filters: [["highpass", 700], ["peaking", 2600, 1.2]], gain: loud, decay: [0.05, 0.07, 0.09, 0.12][tier] });
      noiseBurst(t, { rate: rate * 0.6, filters: [["lowpass", 520]], gain: loud * 0.9, attack: 0.002, decay: [0.07, 0.1, 0.13, 0.16][tier] });
      tone(t, { from: 170 + Math.random() * 30, to: 70, gain: loud * 0.35, decay: 0.09 });
      noiseBurst(t + 0.01, { filters: [["bandpass", 1400, 0.5]], gain: loud * 0.08, attack: 0.02, decay: 0.25 + tier * 0.08 });
      if (duang && tier >= 2) tone(t + 0.03, { type: "triangle", from: 330, to: 150, gain: 0.07 + 0.05 * (tier - 2), decay: 0.38, vibrato: 30 });
    },
    poke() {
      const t = ctx.currentTime + 0.002;
      tone(t, { type: "triangle", from: 520, to: 260, gain: 0.08, decay: 0.16, vibrato: 18 });
    },
    twinkle() {
      const t = ctx.currentTime + 0.01;
      [1568, 2093, 2637].forEach((f, i) => tone(t + i * 0.07, { from: f, to: f * 0.98, gain: 0.05, decay: 0.3 }));
    },
    climax() {
      const t = ctx.currentTime + 0.01;
      noiseBurst(t, { filters: [["bandpass", 900, 0.4]], gain: 0.25, attack: 0.25, decay: 0.5 });
      [523, 659, 784, 1047].forEach((f, i) => tone(t + 0.35 + i * 0.09, { type: "triangle", from: f, to: f, gain: 0.08, decay: 0.45 }));
    },
    stop() { for (const node of live) { try { node.stop(); } catch { /* already stopped */ } } live.clear(); },
  };
}
