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
  const cuts = layoutSeal(seals.find((seal) => seal.id === "just-for-fun")).filter((cut) => cut.stage === "glyphs");
  const first = cuts.slice(0, 4);
  assert.ok(first.every((cut) => cut.a[0] < 0 && cut.a[1] < 0), "只 is carved top-left so it prints top-right");
});

test("the first seal is the easiest to carve", () => {
  const glyphCuts = (seal) => layoutSeal(seal).filter((cut) => cut.stage === "glyphs").length;
  const first = glyphCuts(seals[0]);
  assert.ok(first <= 56, `the first seal has ${first} outline cuts`);
  for (const seal of seals.slice(1)) assert.ok(glyphCuts(seal) > first, `${seal.id} is easier than the first`);
});

test("the first seal's parallel strokes stand at least three grid units apart", () => {
  const segments = [];
  for (const character of seals[0].text.zh) {
    for (const points of parseGlyph(seals[0].glyphs[character])) {
      for (let i = 1; i < points.length; i++) segments.push({ character, a: points[i - 1], b: points[i] });
    }
  }
  for (const [i, p] of segments.entries()) {
    for (const q of segments.slice(i + 1)) {
      if (p.character !== q.character) continue;
      const horizontal = p.a[1] === p.b[1];
      if (horizontal !== (q.a[1] === q.b[1])) continue;
      const [axis, across] = horizontal ? [0, 1] : [1, 0];
      const overlap = Math.min(Math.max(p.a[axis], p.b[axis]), Math.max(q.a[axis], q.b[axis])) - Math.max(Math.min(p.a[axis], p.b[axis]), Math.min(q.a[axis], q.b[axis]));
      if (overlap <= 0 || p.a[across] === q.a[across]) continue;
      assert.ok(Math.abs(p.a[across] - q.a[across]) >= 3, `${p.character}: strokes at ${p.a[across]} and ${q.a[across]} are too close to aim between`);
    }
  }
});

test("raised characters: outlines run outside the strokes, which stay clear of the ground", async () => {
  const { layoutRelief } = await import("../seals.js");
  for (const seal of seals) {
    const { keep, cells } = layoutRelief(seal);
    assert.equal(cells.length, 4);
    for (const cut of layoutSeal(seal).filter((entry) => entry.stage === "glyphs")) {
      // The groove's centre line lies outside every stroke.
      const middle = [(cut.a[0] + cut.b[0]) / 2, (cut.a[1] + cut.b[1]) / 2];
      assert.ok(!keep.some(([u0, v0, u1, v1]) => middle[0] > u0 + 1e-6 && middle[0] < u1 - 1e-6 && middle[1] > v0 + 1e-6 && middle[1] < v1 - 1e-6), `${seal.id}: an outline runs through a stroke`);
    }
  }
});
