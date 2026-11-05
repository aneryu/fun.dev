import test from "node:test";
import assert from "node:assert/strict";
import { bathDuckScene, BATH_DUCK_PRESET, BATH_DUCK_BLOCKS } from "../site/scenes/bath-duck.js";
import { SDFEditorEngine, SDF_EDITOR_PRESETS } from "../site/kernel/sdf-editor.js";

test("homepage bathDuckScene and studio SDF_EDITOR_PRESETS share a single unified source of truth", () => {
  assert.equal(SDF_EDITOR_PRESETS["bath-duck"], BATH_DUCK_PRESET);
  assert.equal(bathDuckScene.blocks, BATH_DUCK_BLOCKS);
  assert.equal(bathDuckScene.ground.y, -0.53);
  assert.deepEqual(bathDuckScene.camera.target, BATH_DUCK_PRESET.initialCamera.target);
  assert.equal(bathDuckScene.camera.distance, BATH_DUCK_PRESET.initialCamera.distance);
  assert.equal(BATH_DUCK_BLOCKS.length, 10);
});

test("SDFEditorEngine bakes smooth, lowpoly, and 36-instance crowd streams and supports live block edits", () => {
  const editor = new SDFEditorEngine();
  assert.equal(editor.blocks.length, 10);
  assert.equal(editor.shadingMode, "smooth");
  assert.equal(editor.showGizmo, false);

  // 1. Smooth mode stream (matId == 14 + 64x vec4f live uniform buffer)
  const smoothStream = editor.packRenderStream(0);
  assert.ok(smoothStream.indexCount > 3000);
  assert.equal(smoothStream.gizmoIndexCount, 0);
  assert.equal(smoothStream.blocksUniformData.length, 64 * 4);
  assert.equal(smoothStream.vData[3], 14.0);

  // 2. Low-poly mode stream (faceted triangles + baked SDF AO/shadow)
  editor.shadingMode = "lowpoly";
  editor.invalidateAll();
  const lowpolyStream = editor.packRenderStream(0);
  assert.ok(lowpolyStream.indexCount > 3000);
  assert.equal(lowpolyStream.vData[3], 0.0);

  // 3. 36-instance crowd stream
  editor.crowdMode = true;
  editor.invalidateAll();
  const crowdStream = editor.packRenderStream(0);
  assert.equal(crowdStream.instanceCount, 36);
  assert.ok(crowdStream.indexCount > lowpolyStream.indexCount * 30);

  // 4. Add & remove block
  editor.crowdMode = false;
  editor.shadingMode = "smooth";
  editor.invalidateAll();
  const added = editor.addBlock("sphere");
  assert.equal(editor.blocks.length, 11);
  assert.equal(editor.selectedBlockId, added.id);
  const removedOk = editor.removeBlock(added.id);
  assert.equal(removedOk, true);
  assert.equal(editor.blocks.length, 10);
});
