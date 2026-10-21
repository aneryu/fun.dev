import test from "node:test";
import assert from "node:assert/strict";
import { createStore, emptyProject, evaluateProject } from "../site/workshop/document.js";
import { mergeProjects, importModel } from "../site/workshop/import-glb.js";
import { openWorkshop } from "../scripts/workshop-node.mjs";
import { presetFromObservation } from "../site/workshop/view-presets.js";
import { capabilities, validateSchema } from "../site/workshop/agent-contract.js";

test("saved non-square views reproduce pixels, camera and lighting after reload; dependency edits are guarded", async () => {
  const s = createStore(emptyProject()); s.apply([{ op: "create", id: "eye", kind: "box" }]);
  const session = await openWorkshop({ record: { project: s.snapshot(), revision: 0 }, width: 160, height: 100 });
  try {
    const shot = session.api.renderViews(["front"], { size: 128, height: 96, ids: ["eye"], helpers: false })[0];
    const definition = presetFromObservation(shot, "eye-front");
    const command = { op: "viewPreset", id: "eye-front", definition };
    validateSchema(command, capabilities({ command: "viewPreset" }).schema);
    s.apply([command]);
    const project = s.snapshot(); assert.deepEqual(evaluateProject(project), project);
    session.api.loadProject(project);
    const again = session.api.renderViews(undefined, { preset: "eye-front" })[0];
    assert.equal(again.width, 128); assert.equal(again.height, 96);
    assert.equal(again.dataUrl, shot.dataUrl);
    assert.deepEqual(again.camera, shot.camera);
    assert.deepEqual(again.quality, shot.quality);
    assert.equal(again.viewPreset.id, "eye-front");
    const candidate = await session.api.workflow({ action: "prepare", render: { preset: "eye-front" } });
    assert.equal(candidate.observations[0].dataUrl, shot.dataUrl);
    const exported = await session.api.exportProject();
    assert.deepEqual(importModel(Buffer.from(exported.data, "base64")).project.viewPresets, project.viewPresets);
    assert.throws(() => s.apply([{ op: "delete", id: "eye" }]), /missing.*dependencies/);
    assert.deepEqual(s.snapshot(), project);
    s.apply([{ op: "rename", id: "eye", newId: "iris" }]);
    assert.deepEqual(s.snapshot().viewPresets[0].ids, ["iris"]);
    const merged = createStore(mergeProjects(s.snapshot(), s.snapshot()).project).snapshot();
    assert.notEqual(merged.viewPresets[0].id, merged.viewPresets[1].id);
    assert.notEqual(merged.viewPresets[0].ids[0], merged.viewPresets[1].ids[0]);
    s.undo(); assert.deepEqual(s.snapshot(), project);
  } finally { session.dispose(); }
});
