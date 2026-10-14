import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeKnock } from "../sound.js";

test("synthesized knocks are audible, bounded, and decay to silence at common sample rates", () => {
  for (const sampleRate of [44100, 48000]) {
    const samples = synthesizeKnock(sampleRate);
    assert.equal(samples.length, Math.ceil(sampleRate * 0.3));
    assert.equal(Math.abs(samples[0]), 0);
    assert.ok(Math.abs(samples.at(-1)) === 0);
    assert.ok(samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) < 1));
    const rms = (start, end) => Math.sqrt(samples.slice(start, end).reduce((sum, sample) => sum + sample * sample, 0) / (end - start));
    const attack = rms(0, Math.floor(sampleRate * 0.03));
    const tail = rms(Math.floor(sampleRate * 0.25), samples.length);
    assert.ok(attack > 0.05, "audible attack");
    assert.ok(tail < attack * 0.01, "resonance fades before ending");
  }
});
