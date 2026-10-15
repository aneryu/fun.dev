import { test } from "node:test";
import assert from "node:assert/strict";
import { seals, layoutSeal, parseGlyph, GRID, STAGES } from "../seals.js";
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
  const cuts = layoutSeal(seals[0]).filter((cut) => cut.stage === "glyphs");
  const first = cuts.slice(0, 4);
  assert.ok(first.every((cut) => cut.a[0] < 0 && cut.a[1] < 0), "只 is carved top-left so it prints top-right");
});
