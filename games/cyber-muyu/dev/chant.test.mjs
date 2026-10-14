import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createChant } from "../chant.js";

const strikes = (chant, times) => times.map((time) => chant.strike(time));

test("three warm-up knocks, then one syllable per strike from 南", () => {
  const chant = createChant();
  assert.deepEqual(strikes(chant, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]), [null, null, null, 0, 1, 2, 3, 4, 5, 0, 1]);
});

test("a slow warm-up knock starts the warm-up over", () => {
  const chant = createChant();
  assert.deepEqual(strikes(chant, [0, 0.5, 2, 2.5, 3, 3.5]), [null, null, null, null, null, 0]);
});

test("a pause breaks the chant; it warms up again and restarts at 南", () => {
  const chant = createChant();
  assert.deepEqual(strikes(chant, [0, 1, 2, 3, 4.4, 4.9]), [null, null, null, 0, 1, 2]);
  assert.deepEqual(strikes(chant, [6.5, 7, 7.5, 8]), [null, null, null, 0]);
});

test("reset (pause or restart) requires a new warm-up", () => {
  const chant = createChant();
  strikes(chant, [0, 0.5, 1, 1.5]);
  chant.reset();
  assert.deepEqual(strikes(chant, [1.6, 1.7, 1.8, 1.9]), [null, null, null, 0]);
});

test("chant.json has a voice slice for each syllable", async () => {
  const data = JSON.parse(await readFile(new URL("../assets/chant.json", import.meta.url), "utf8"));
  assert.equal(data.text, "南无阿弥陀佛");
  assert.equal(data.slices.length, 6);
  for (const [start, duration] of data.slices) assert.ok(start >= 0 && duration > 0.1 && duration <= 0.6);
});
