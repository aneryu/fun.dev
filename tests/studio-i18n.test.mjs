import test from "node:test";
import assert from "node:assert/strict";
import { TEXT, NAMES } from "../site/studio-i18n.js";
import { BATH_DUCK_BLOCKS } from "../site/scenes/bath-duck.js";
import { SDF_PRIMITIVE_TYPES, SDF_COLOR_SWATCHES } from "../site/kernel/sdf-editor.js";

test("Studio text has the same keys and placeholders in Chinese and English", () => {
  assert.deepEqual(Object.keys(TEXT.en).sort(), Object.keys(TEXT.zh).sort());
  for (const key of Object.keys(TEXT.zh)) {
    const vars = (s) => (s.match(/\{\w+\}/g) || []).sort();
    assert.deepEqual(vars(TEXT.en[key]), vars(TEXT.zh[key]), key);
  }
});

test("every preset block, primitive and swatch has an English name", () => {
  for (const b of BATH_DUCK_BLOCKS) assert.ok(NAMES.en.block[b.id], b.id);
  for (const p of SDF_PRIMITIVE_TYPES) assert.ok(NAMES.en.prim[p.id], p.id);
  for (const s of SDF_COLOR_SWATCHES) assert.ok(NAMES.en.swatch[s.id], s.id);
});
