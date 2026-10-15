import { test } from "node:test";
import assert from "node:assert/strict";
import { seals, layoutSeal, layoutRelief, parseGlyph, GRID, STAGES, isGlyph } from "../seals.js";
import { stones } from "../stone.js";

test("every seal has four characters with glyphs that stay on their grid", () => {
  assert.equal(new Set(seals.map((seal) => seal.id)).size, seals.length);
  for (const seal of seals) {
    assert.equal([...seal.text.zh].length, 4, seal.id);
    assert.ok(stones[seal.stone], `${seal.id} has no stone ${seal.stone}`);
    for (const character of seal.text.zh) {
      const strokes = parseGlyph(seal.glyphs[character]);
      for (const point of strokes.flat()) assert.ok(point.every((value) => value >= 0 && value <= GRID), `${character} leaves its grid`);
    }
  }
});

test("every cut is straight along the face's axes, inside the face, in a known stage", () => {
  for (const seal of seals) {
    for (const cut of layoutSeal(seal)) {
      const dx = cut.b[0] - cut.a[0], dy = cut.b[1] - cut.a[1];
      assert.ok((dx === 0) !== (dy === 0), `${seal.id}: a cut must be horizontal or vertical`);
      for (const value of [...cut.a, ...cut.b]) assert.ok(Math.abs(value) <= 0.5, `${seal.id}: a cut leaves the face`);
      assert.ok(STAGES.includes(cut.stage));
    }
  }
});

test("the face is carved mirrored: the first character sits on the face's left", () => {
  const cuts = layoutSeal(seals[0]).filter((cut) => cut.stage === "glyph0");
  assert.ok(cuts.every((cut) => cut.a[0] < 0.02 && cut.a[1] < 0.02), "the first character is carved top-left so it prints top-right");
});

test("the first seal is the easiest to carve", () => {
  const glyphCuts = (seal) => layoutSeal(seal).filter((cut) => isGlyph(cut.stage)).length;
  const first = glyphCuts(seals[0]);
  for (const seal of seals.slice(1)) assert.ok(glyphCuts(seal) > first, `${seal.id} is easier than the first`);
});

test("strokes lie on even grid lines, so most gaps are a single groove", () => {
  for (const seal of seals) for (const character of seal.text.zh) {
    for (const point of parseGlyph(seal.glyphs[character]).flat()) assert.ok(point.every((value) => value % 2 === 0), `${character} strays off the lattice`);
  }
});

test("character guides run over the ground, never through a stroke", () => {
  for (const seal of seals) {
    const { keep } = layoutRelief(seal);
    for (const cut of layoutSeal(seal).filter((entry) => isGlyph(entry.stage))) {
      const middle = [(cut.a[0] + cut.b[0]) / 2, (cut.a[1] + cut.b[1]) / 2];
      assert.ok(!keep.some(([u0, v0, u1, v1]) => middle[0] > u0 + 1e-6 && middle[0] < u1 - 1e-6 && middle[1] > v0 + 1e-6 && middle[1] < v1 - 1e-6), `${seal.id}: a guide runs through a stroke`);
    }
  }
});
