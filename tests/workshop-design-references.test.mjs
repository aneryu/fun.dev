import test from "node:test";
import assert from "node:assert/strict";
import { createStore, emptyProject, evaluateProject } from "../site/workshop/document.js";
import { mergeProjects, importModel } from "../site/workshop/import-glb.js";
import { openWorkshop } from "../scripts/workshop-node.mjs";
import { capabilities, validateSchema } from "../site/workshop/agent-contract.js";

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSfkAAAAASUVORK5CYII=";
function setup() {
  const s = createStore(emptyProject());
  const commands = [{ op: "create", kind: "box", id: "head" },
    { op: "referenceRecord", definition: { id: "front-v1", kind: "image", text: "Front", origin: "user", image } },
    { op: "referenceRecord", definition: { id: "shape", kind: "feature", text: "Flat crown", status: "accepted",
      references: ["front-v1"], evidence: "User requested a flat crown." } },
    { op: "referenceSelect", ids: ["front-v1"] }];
  for (const c of commands) validateSchema(c, capabilities({ command: c.op }).schema);
  s.apply(commands); return s;
}
test("reference versions and approval evidence persist; proposals cannot replace accepted direction", () => {
  const s = setup(), before = s.snapshot();
  assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(before))), before);
  assert.throws(() => s.apply([{ op: "referenceRecord", definition: { ...before.designReferences.records[0], text: "overwrite" } }]), /already exists/);
  assert.throws(() => s.apply([{ op: "referenceRecord", definition: { id: "sharp", kind: "feature", text: "Sharp crown",
    status: "proposed", references: [], supersedes: "shape", reason: "New generated image" } }]), /cannot replace an accepted/);
  assert.deepEqual(s.snapshot(), before);
  s.apply([{ op: "referenceRecord", definition: { id: "front-v2", kind: "image", text: "Alternative",
    origin: "generated", image, supersedes: "front-v1", reason: "Explore another perspective" } }]);
  assert.deepEqual(s.snapshot().designReferences.selected, ["front-v1"]);
  s.undo(); assert.deepEqual(s.snapshot(), before); s.redo();
  const merged = createStore(mergeProjects(before, s.snapshot()).project).snapshot().designReferences;
  assert.equal(new Set(merged.records.map(r => r.id)).size, merged.records.length);
  assert.equal(merged.records.at(-1).supersedes, "front-v1_1");
});
test("reference provenance accompanies rendered candidates and survives editable export", async () => {
  const s = setup(), session = await openWorkshop({ record: { project: s.snapshot(), revision: 0 }, width: 64, height: 64 });
  try {
    assert.deepEqual(session.api.inspect().designReferences.selected, ["front-v1"]);
    assert.deepEqual(session.api.renderViews(["front"], { size: 64 })[0].designReferences.selected, ["front-v1"]);
    const candidate = await session.api.workflow({ action: "prepare", views: ["front"], size: 64 });
    assert.deepEqual(candidate.observations[0].designReferences.selected, ["front-v1"]);
    assert.equal(candidate.observations[0].designReferences.records[0].image, undefined);
    const roundtrip = await session.api.workflow({ action: "verifyExport" });
    assert.deepEqual(roundtrip.editable.scope.changed, []);
    assert.ok(roundtrip.generic.scope.fields.some(c => c.path === "designReferences"));
    const exported = await session.api.exportProject();
    assert.deepEqual(importModel(Buffer.from(exported.data, "base64")).project.designReferences, s.snapshot().designReferences);
  } finally { session.dispose(); }
});
