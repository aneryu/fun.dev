import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createZen, SENTENCE_GAIN, STEADY_GAIN } from "../zen.js";

import { ZEN } from "../economy.js";
const params = () => ZEN;
const syllables = (zen, times) => times.map((time) => zen.strike(time).syllable);
const beats = (start, count, gap) => Array.from({ length: count }, (_, i) => start + i * gap);

test("three warm-up knocks, then one syllable per strike from 南", () => {
  const zen = createZen(params);
  assert.deepEqual(syllables(zen, beats(0, 11, 0.5)), [null, null, null, 0, 1, 2, 3, 4, 5, 0, 1]);
});

test("a slow warm-up knock starts the warm-up over", () => {
  const zen = createZen(params);
  assert.deepEqual(syllables(zen, [0, 0.5, 2, 2.5, 3, 3.5]), [null, null, null, null, null, 0]);
});

test("once chanting, slower strikes keep the chant until a pause breaks it", () => {
  const zen = createZen(params);
  assert.deepEqual(syllables(zen, [0, 0.5, 1, 1.5, 2.9, 3.4]), [null, null, null, 0, 1, 2]);
  assert.deepEqual(syllables(zen, [5.5, 6, 6.5, 7]), [null, null, null, 0]);
});

test("steady beats deepen zen; a steady sentence adds a bonus and 入定 is reached", () => {
  const zen = createZen(params);
  const results = beats(0, 10, 0.45).map((time) => zen.strike(time));
  assert.ok(results.slice(3).every((result) => result.steady));
  assert.ok(results[8].steadySentence);
  assert.equal(Math.round(zen.level * 100), Math.round((6 * STEADY_GAIN + SENTENCE_GAIN + STEADY_GAIN) * 100));
  const more = beats(4.5, 30, 0.45).map((time) => zen.strike(time));
  assert.equal(zen.level, 1);
  assert.equal(more.filter((result) => result.samadhi).length, 1);
});

test("mashing gains much less zen per second than a steady beat", () => {
  const steady = createZen(params);
  beats(0, 44, 0.45).forEach((time) => steady.strike(time));
  const mash = createZen(params);
  beats(0, 100, 0.2).forEach((time) => mash.strike(time));
  assert.ok(mash.level < steady.level / 2, `${mash.level} vs ${steady.level}`);
});

test("after the grace period zen ebbs and 入定 ends", () => {
  const zen = createZen(params);
  beats(0, 40, 0.45).forEach((time) => zen.strike(time));
  const last = 39 * 0.45;
  assert.equal(zen.update(last + 1, 1), 0);
  assert.equal(zen.level, 1);
  assert.ok(zen.update(last + 3, 1) > 0);
  assert.ok(Math.abs(zen.level - 0.9) < 1e-9);
  assert.equal(zen.chanting, false);
});

test("reset (pause or restart) requires a new warm-up", () => {
  const zen = createZen(params);
  syllables(zen, [0, 0.5, 1, 1.5]);
  zen.reset();
  assert.deepEqual(syllables(zen, [1.6, 1.7, 1.8, 1.9]), [null, null, null, 0]);
});

test("chant.json has a voice slice for each syllable", async () => {
  const data = JSON.parse(await readFile(new URL("../assets/chant.json", import.meta.url), "utf8"));
  assert.equal(data.text, "南无阿弥陀佛");
  assert.equal(data.slices.length, 6);
  for (const [start, duration] of data.slices) assert.ok(start >= 0 && duration > 0.1 && duration <= 0.6);
});
