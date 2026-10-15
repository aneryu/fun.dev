import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeChip, synthesizeBlow, synthesizeTap } from "../sound.js";

test("synthesized sounds are finite, short and audible", () => {
  for (const samples of [synthesizeChip(44100, 0.1), synthesizeChip(44100, 0.9), synthesizeBlow(44100), synthesizeTap(44100)]) {
    assert.ok(samples.length > 100 && samples.length < 44100);
    assert.ok(samples.every(Number.isFinite));
    assert.ok(Math.max(...samples.map(Math.abs)) > 0.01);
  }
  // A crack falls to half within about 30 ms, as in the carving video.
  const chip = synthesizeChip(44100, 0.5, () => 0.5);
  const peak = (from, to) => Math.max(...chip.slice(from, to).map(Math.abs));
  assert.ok(peak(Math.round(44100 * 0.04), Math.round(44100 * 0.05)) < peak(0, 441) * 0.5);
});
