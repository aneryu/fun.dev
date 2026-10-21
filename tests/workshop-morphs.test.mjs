import test from "node:test";
import assert from "node:assert/strict";
import { createStore, emptyProject, evaluateProject, validateProject } from "../site/workshop/document.js";
import { openWorkshop } from "../scripts/workshop-node.mjs";
import { parseModelFile } from "../site/workshop/glb.js";
import { toolInvocation } from "../site/workshop/agent-tools.js";
import { createConverter } from "../scripts/fun3d-convert.mjs";
import { Vector3 } from "three";

function setup() {
  const s = createStore(emptyProject());
  s.apply([{ op: "create", kind: "box", id: "head" }]);
  const base = s.snapshot().nodes[0].mesh.vertices;
  s.apply([{ op: "morphTarget", id: "head", name: "wide",
    changes: base.map((p, index) => ({ index, position: [p[0] * 1.4, p[1], p[2]] })) },
  { op: "morphTarget", id: "head", name: "tall",
    changes: base.map((p, index) => ({ index, position: [p[0], p[1] * 1.2, p[2]] })) }]);
  return s;
}
test("morphEdit patches target positions without replacing other vertices or expression data", () => {
  const s = setup(), before = s.snapshot(), n = before.nodes[0];
  const position = n.morph.base[0].map((v, k) => v + n.morph.targets[0].deltas[0][k] + (k === 1 ? .03 : 0));
  const command = { op: "morphEdit", id: "head", name: "wide", changes: [{ index: 0, position }] };
  assert.ok(toolInvocation("fun_editor_apply", { ifRevision: 0, commands: [command] }));
  s.apply([command]);
  const after = s.snapshot().nodes[0];
  assert.deepEqual(after.morph.base, n.morph.base);
  assert.deepEqual(after.morph.weights, n.morph.weights);
  assert.deepEqual(after.morph.targets.map(t => t.name), n.morph.targets.map(t => t.name));
  assert.deepEqual(after.morph.targets.find(t => t.name === "tall"), n.morph.targets[1]);
  const wide = after.morph.targets.find(t => t.name === "wide");
  assert.deepEqual(wide.deltas.slice(1), n.morph.targets[0].deltas.slice(1));
  assert.ok(Math.abs(wide.deltas[0][1] - .03) < 1e-10);
  s.undo(); assert.deepEqual(s.snapshot(), before);
  assert.throws(() => s.apply([{ ...command, name: "missing" }]), /Unknown morph target/);
  assert.deepEqual(s.snapshot(), before);
});
test("named targets mix continuously without drift across evaluate/save/undo", () => {
  const s = setup(), before = s.snapshot();
  s.apply([{ op: "morphWeights", id: "head", values: { wide: 0.5, tall: 0.25 } }]);
  const mixed = s.snapshot();
  mixed.nodes[0].mesh.vertices.forEach((p, i) => {
    const base = mixed.nodes[0].morph.base[i];
    assert.ok(Math.abs(p[0] - base[0] * 1.2) < 1e-9);
    assert.ok(Math.abs(p[1] - base[1] * 1.05) < 1e-9);
  });
  let reopened = JSON.parse(JSON.stringify(mixed));
  for (let i = 0; i < 5; i++) reopened = evaluateProject(reopened);
  assert.deepEqual(reopened, mixed);
  assert.equal(validateProject(reopened).errors.length, 0);
  s.undo(); assert.deepEqual(s.snapshot(), before);
});
test("topology invalidation and invalid weights are atomic; base parameter edits preserve deltas", () => {
  const s = setup(), before = s.snapshot();
  assert.throws(() => s.apply([{ op: "triangulate", id: "head" }]), /topology/);
  assert.throws(() => s.apply([{ op: "morphWeights", id: "head", values: { wide: 2 } }]), /Weights/);
  assert.deepEqual(s.snapshot(), before);
  s.apply([{ op: "parameters", id: "head", options: { size: [2, 1, 1] } }]);
  const changed = s.snapshot().nodes[0];
  assert.deepEqual(changed.morph.targets, before.nodes[0].morph.targets);
  assert.equal(Math.max(...changed.morph.base.map(p => p[0])), 1);
});
test("mirror targets and removal are explicit and discoverable", () => {
  const s = setup();
  s.apply([{ op: "morphMirror", id: "head", name: "wide", newName: "wide_mirrored", axis: "x" }]);
  const m = s.snapshot().nodes[0].morph;
  assert.deepEqual(m.targets[0].deltas, m.targets[2].deltas);
  assert.ok(toolInvocation("fun_editor_apply", { ifRevision: s.revision, commands: [
    { op: "morphWeights", id: "head", values: { wide: 0.2 } },
  ] }));
  s.apply(m.targets.map(t => ({ op: "morphRemove", id: "head", name: t.name })));
  assert.equal(s.snapshot().nodes[0].morph, undefined);
});
test("GLB export keeps target names, split vertex correspondence and weights; editable roundtrip is exact", async () => {
  const session = await openWorkshop({ record: { project: setup().snapshot(), revision: 0 }, width: 128, height: 128 });
  try {
    session.api.apply([{ op: "morphWeights", id: "head", values: { wide: 0.5 } }]);
    const result = await session.api.exportGLB({ encoding: "base64" });
    const parsed = parseModelFile(Buffer.from(result.data, "base64"));
    const json = parsed.json;
    assert.deepEqual(json.meshes[0].extras.targetNames, ["wide", "tall"]);
    assert.equal(json.meshes[0].primitives[0].targets.length, 2);
    assert.ok(json.nodes.some(n => n.weights?.[0] === 0.5) || json.meshes.some(m => m.weights?.[0] === 0.5));
    const converter = createConverter();
    const converted = await converter.convert(Buffer.from(result.data, "base64"), { type: "character", name: "morph-check" });
    const model = await converter.fun3d.load(converted.bytes);
    try {
      assert.equal(model.manifest.geometries.reduce((s, g) => s + (g.morph?.targets.length ?? 0), 0), 2);
      const mesh = [...model.nodes.values()].map(n => n.userData.mesh ?? n).find(n => n.isMesh);
      assert.equal(mesh.morphTargetInfluences[mesh.morphTargetDictionary.wide], 0.5);
      const vertex = mesh.geometry.getAttribute("position");
      const original = vertex.getX(0);
      mesh.morphTargetInfluences[mesh.morphTargetDictionary.wide] = 1;
      const actual = mesh.getVertexPosition(0, new Vector3());
      assert.ok(Math.abs(actual.x - original * 1.4) < 1e-4);
    } finally { model.dispose(); }
    const check = await session.api.workflow({ action: "verifyExport" });
    assert.deepEqual(check.editable.scope.changed, []);
    assert.deepEqual(check.generic.nodes.find(n => n.morph).morph.targets, ["wide", "tall"]);
    assert.equal(check.generic.nodes.find(n => n.morph).morph.weights.wide, 0.5);
    assert.throws(() => session.api.exportReport({ mergeStatic: ["head"] }), /moving parts/);
  } finally { session.dispose(); }
});
