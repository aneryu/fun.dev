import { test } from "node:test";
import assert from "node:assert/strict";
import { bells, synthesizeBell, synthesizeHall, synthesizeKnock } from "../sound.js";

test("synthesized knocks are audible, bounded, and decay to silence at common sample rates", () => {
  for (const sampleRate of [44100, 48000]) {
    const samples = synthesizeKnock(sampleRate);
    assert.equal(samples.length, Math.ceil(sampleRate * 0.35));
    assert.equal(Math.abs(samples[0]), 0);
    assert.ok(Math.abs(samples.at(-1)) === 0);
    assert.ok(samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) < 1));
    const rms = (start, end) => Math.sqrt(samples.slice(start, end).reduce((sum, sample) => sum + sample * sample, 0) / (end - start));
    const attack = rms(0, Math.floor(sampleRate * 0.03));
    const tail = rms(Math.floor(sampleRate * 0.3), samples.length);
    assert.ok(attack > 0.05, "audible attack");
    assert.ok(tail < attack * 0.01, "resonance fades before ending");
  }
});

test("synthesized bells ring, stay bounded and fade out", () => {
  for (const preset of Object.values(bells)) {
    const samples = synthesizeBell(48000, preset);
    assert.equal(samples.length, Math.ceil(48000 * preset.duration));
    assert.ok(samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) < 1));
    assert.equal(Math.abs(samples.at(-1)), 0);
    assert.ok(samples.slice(0, 4800).some((sample) => Math.abs(sample) > 0.05), "audible strike");
  }
});

// The strongest frequency in a window, by a coarse scan of the spectrum.
function peakFrequency(samples, sampleRate, from, to) {
  let best = 0;
  let bestPower = 0;
  for (let frequency = from; frequency <= to; frequency += 2) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < samples.length; i++) {
      re += samples[i] * Math.cos(2 * Math.PI * frequency * i / sampleRate);
      im += samples[i] * Math.sin(2 * Math.PI * frequency * i / sampleRate);
    }
    if (re * re + im * im > bestPower) { bestPower = re * re + im * im; best = frequency; }
  }
  return best;
}

test("the knock and the bowl ring on D, the key every sound shares", () => {
  const knock = synthesizeKnock(48000).slice(480, 4800);
  assert.ok(Math.abs(peakFrequency(knock, 48000, 300, 3000) - 587) < 12, "knock on D5");
  const bowl = synthesizeBell(48000, bells.bowl).slice(4800, 14400);
  assert.ok(Math.abs(peakFrequency(bowl, 48000, 600, 3000) - 1175) < 12, "bowl on D6");
});

test("the hall starts after a pre-delay and darkens as it decays", () => {
  const [left, right] = synthesizeHall(48000);
  assert.equal(left[0], 0);
  assert.notDeepEqual(left.slice(1000, 1100), right.slice(1000, 1100));
  const roughness = (start) => {
    let difference = 0;
    let level = 0;
    for (let i = start; i < start + 4800; i++) { difference += Math.abs(left[i] - left[i - 1]); level += Math.abs(left[i]); }
    return difference / level;
  };
  assert.ok(roughness(48000) < roughness(1000) * 0.5, "the tail loses its highs");
});
