import { test } from "node:test";
import assert from "node:assert/strict";
import { createRandom, dailySeed, hashString } from "../site/runtime/kit/random.js";
import { createFixedStep, lerp } from "../site/runtime/kit/loop.js";

test("seeded random streams are reproducible and bounded", () => {
  const a = createRandom(42), b = createRandom(42);
  const draws = Array.from({ length: 50 }, () => a.next());
  assert.deepEqual(draws, Array.from({ length: 50 }, () => b.next()));
  assert.ok(draws.every((value) => value >= 0 && value < 1));
  const random = createRandom("level-1");
  for (let i = 0; i < 200; i++) {
    const value = random.int(3, 5);
    assert.ok(Number.isInteger(value) && value >= 3 && value <= 5);
  }
  assert.deepEqual(createRandom(7).shuffle([1, 2, 3, 4, 5]).sort(), [1, 2, 3, 4, 5]);
  assert.equal(createRandom(9).fork("x").next(), createRandom(9).fork("x").next());
  assert.notEqual(hashString("a"), hashString("b"));
});

test("daily seeds follow the calendar day of the chosen time zone", () => {
  const date = new Date("2026-10-14T20:00:00Z");
  assert.equal(dailySeed({ date }).key, "2026-10-14");
  assert.equal(dailySeed({ date, timeZone: "Asia/Shanghai" }).key, "2026-10-15");
  assert.equal(dailySeed({ date }).seed, dailySeed({ date: new Date("2026-10-14T01:00:00Z") }).seed);
  assert.notEqual(dailySeed({ date, salt: "a" }).seed, dailySeed({ date, salt: "b" }).seed);
});

test("fixed step runs whole steps, caps catch-up, and reports interpolation", () => {
  const loop = createFixedStep({ step: 0.01, maxSteps: 3 });
  let steps = 0;
  const first = loop.advance(0.025, () => steps++);
  assert.equal(first.steps, 2);
  assert.ok(Math.abs(first.alpha - 0.5) < 1e-6);
  assert.equal(loop.advance(1, () => steps++).steps, 3);
  assert.equal(steps, 5);
  // 120 Hz and 60 Hz frame times reach the same number of simulation steps.
  const fast = createFixedStep(), slow = createFixedStep();
  let fastSteps = 0, slowSteps = 0;
  for (let i = 0; i < 120; i++) fast.advance(1 / 120, () => fastSteps++);
  for (let i = 0; i < 60; i++) slow.advance(1 / 60, () => slowSteps++);
  assert.ok(Math.abs(fastSteps - slowSteps) <= 1);
  assert.equal(lerp(0, 10, 0.25), 2.5);
});
