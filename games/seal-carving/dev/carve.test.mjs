import { test } from "node:test";
import assert from "node:assert/strict";
import { seals, layoutSeal, FACE } from "../seals.js";
import { createCarving, createMaskPainter, AXES, FINISH } from "../carve.js";

const WIDTHS = [FACE.bevel, FACE.frameWidth, FACE.glyphWidth];
const CODE = { bevel: 0, border: 1, cross: 1, glyphs: 2 };
const axisOf = (cut) => AXES.findIndex(([dx, dy]) => dx * cut.direction[0] + dy * cut.direction[1] > 0.98);

// Carves a cut the way the knife does: one stroke from its start along its axis.
function cutAlong(carving, cut, offset = 0) {
  const stroke = carving.beginStroke(cut.a[0], cut.a[1], axisOf(cut), CODE[cut.stage], ["bevel", "border", "cross", "glyphs"].indexOf(cut.stage));
  const { cuts } = carving.extend(stroke, cut.length, offset);
  carving.settle(cuts);
  return stroke;
}

test("a stroke along a draft line covers it; off the line it does not", () => {
  const carving = createCarving(layoutSeal(seals[0]), WIDTHS);
  const [first, second] = carving.cuts;
  cutAlong(carving, first);
  assert.equal(first.done, true);
  assert.equal(second.carved, 0);
  // A groove well beside a line leaves it uncut.
  const stray = carving.beginStroke(second.a[0] - 0.1, second.a[1], axisOf(second), 0);
  carving.settle(carving.extend(stray, second.length, 0).cuts);
  assert.equal(second.carved, 0);
});

test("a nearly finished cut can be finished; the stages run in order", () => {
  const carving = createCarving(layoutSeal(seals[0]), WIDTHS);
  assert.equal(carving.stage(), "bevel");
  const cut = carving.cuts[0];
  const stroke = carving.beginStroke(cut.a[0], cut.a[1], axisOf(cut), 0);
  carving.extend(stroke, cut.length * 0.93, 0);
  assert.ok(carving.coverage(cut) >= FINISH && !cut.done);
  carving.finish(cut, 0);
  assert.equal(cut.done, true);
  for (const other of carving.cuts.filter((entry) => entry.stage === "bevel" && !entry.done)) cutAlong(carving, other);
  assert.equal(carving.stage(), "border");
});

test("every seal carves completely, saves and restores exactly, within the snapshot budget", () => {
  let total = 0;
  for (const seal of seals) {
    const carving = createCarving(layoutSeal(seal), WIDTHS);
    carving.cuts.forEach((cut, index) => cutAlong(carving, cut, ((index % 5) - 2) / 16384 * 20));
    assert.equal(carving.stage(), "dust", seal.id);
    const saved = carving.serialize();
    total += saved.length;
    const again = createCarving(layoutSeal(seal), WIDTHS);
    again.restore(saved);
    assert.equal(again.stage(), "dust");
    assert.deepEqual(again.strokes.map((stroke) => stroke.offsets), carving.strokes.map((stroke) => stroke.offsets));
    assert.equal(again.serialize(), saved);
  }
  // All six finished seals together stay far below the 64 KiB progress limit.
  assert.ok(total < 40000, `saved carvings take ${total} bytes`);
});

test("malformed carvings are rejected", () => {
  const carving = createCarving(layoutSeal(seals[0]), WIDTHS);
  assert.throws(() => carving.restore(btoa("\u0001\u0002\u0003")));
  assert.throws(() => carving.restore(btoa("\u0000\u0000\u0000\u0000ÿ\u0000\u0001\u0000")));
});

test("the painter fills the groove for every carved point", () => {
  const carving = createCarving(layoutSeal(seals[0]), WIDTHS);
  const stroke = cutAlong(carving, carving.cuts[5]);
  let fills = 0;
  const context = new Proxy({}, { get: (target, key) => key in target ? target[key] : key === "fill" ? () => { fills++; } : () => {}, set: (target, key, value) => { target[key] = value; return true; } });
  createMaskPainter(carving, context, 256).paint(stroke, stroke.offsets.map((_, k) => k));
  assert.ok(fills >= stroke.offsets.length);
});

test("undo rewinds strokes and coverage; a step can be redone alone", () => {
  const carving = createCarving(layoutSeal(seals[0]), WIDTHS);
  const bevel = carving.cuts.filter((cut) => cut.stage === "bevel");
  for (const cut of bevel) {
    const stroke = carving.beginStroke(cut.a[0], cut.a[1], axisOf(cut), 0, 0);
    carving.settle(carving.extend(stroke, cut.length, 0).cuts);
  }
  assert.equal(carving.stage(), "border");
  const border = carving.cuts.find((cut) => cut.stage === "border");
  const stroke = carving.beginStroke(border.a[0], border.a[1], axisOf(border), 1, 1);
  carving.settle(carving.extend(stroke, border.length, 0).cuts);
  assert.equal(border.done, true);
  carving.rewind(carving.strokes.length - 1);
  assert.equal(border.carved, 0);
  assert.equal(carving.stage(), "border");
  carving.rewind(carving.strokes.length - 1);
  assert.equal(carving.stage(), "bevel", "undoing into a finished step reopens it");
  carving.removeStage("bevel");
  assert.equal(carving.strokes.length, 0);
  // The step travels with the save.
  const again = createCarving(layoutSeal(seals[0]), WIDTHS);
  const kept = again.beginStroke(border.a[0], border.a[1], axisOf(border), 1, 1);
  again.extend(kept, 0.1, 0);
  const restored = createCarving(layoutSeal(seals[0]), WIDTHS);
  restored.restore(again.serialize());
  assert.equal(restored.strokes[0].stage, 1);
});

test("the ground clears around the strokes, saves and restores", async () => {
  const { layoutRelief } = await import("../seals.js");
  const { CLEAR } = await import("../carve.js");
  const carving = createCarving(layoutSeal(seals[0]), WIDTHS, layoutRelief(seals[0]));
  for (const cut of carving.cuts) { cutAlong(carving, cut); }
  assert.equal(carving.stage(), "clear");
  // Scraping everywhere never clears a stroke's cell.
  for (let v = -0.5; v <= 0.5; v += 0.02) for (let u = -0.5; u <= 0.5; u += 0.02) carving.scrape(u, v, 0.03);
  assert.ok(carving.clearCoverage() > 0.95);
  for (let index = 0; index < CLEAR * CLEAR; index++) if (carving.cleared[index]) assert.equal(carving.clearable[index], 1);
  const saved = carving.serializeClear();
  const again = createCarving(layoutSeal(seals[0]), WIDTHS, layoutRelief(seals[0]));
  again.restoreClear(saved);
  assert.equal(again.clearCoverage(), carving.clearCoverage());
  carving.finishClear();
  assert.equal(carving.stage(), "dust");
  carving.removeStage("clear");
  assert.equal(carving.stage(), "clear");
});
