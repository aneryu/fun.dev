import { test } from "node:test";
import assert from "node:assert/strict";
import { seals, layoutSeal, layoutRelief, glyphMask, STAGES, isGlyph } from "../seals.js";
import { GLYPH_SIZE } from "../glyphs.js";
import { stones } from "../stone.js";

test("every seal has four characters, each with a seal-script glyph", () => {
  assert.equal(new Set(seals.map((seal) => seal.id)).size, seals.length);
  for (const seal of seals) {
    assert.equal([...seal.text.zh].length, 4, seal.id);
    assert.equal([...seal.glyphs].length, 4, seal.id);
    assert.ok(stones[seal.stone], `${seal.id} has no stone ${seal.stone}`);
    for (const character of seal.glyphs) {
      const mask = glyphMask(character);
      assert.equal(mask.length, GLYPH_SIZE * GLYPH_SIZE);
      const ink = mask.reduce((sum, bit) => sum + bit, 0) / mask.length;
      assert.ok(ink > 0.08 && ink < 0.6, `${character} has ${Math.round(ink * 100)}% ink`);
    }
  }
});

test("every cut is straight, across, upright or diagonal, inside the face, in a known stage", () => {
  for (const seal of seals) {
    for (const cut of layoutSeal(seal)) {
      const dx = cut.b[0] - cut.a[0], dy = cut.b[1] - cut.a[1];
      assert.ok(dx === 0 || dy === 0 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-9, `${seal.id}: a cut must run across, upright or at 45°`);
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

test("character guides run over the ground, never through a stroke", () => {
  for (const seal of seals) {
    const { isStroke } = layoutRelief(seal);
    for (const cut of layoutSeal(seal).filter((entry) => isGlyph(entry.stage))) {
      for (let t = 0; t <= 1; t += 0.05) {
        const u = cut.a[0] + (cut.b[0] - cut.a[0]) * t, v = cut.a[1] + (cut.b[1] - cut.a[1]) * t;
        assert.ok(!isStroke(u, v), `${seal.id}: a guide runs through a stroke`);
      }
    }
  }
});
