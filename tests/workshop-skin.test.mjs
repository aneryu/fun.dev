import test from "node:test";
import assert from "node:assert/strict";
import { createStore, emptyProject, evaluateProject } from "../site/workshop/document.js";
import { openWorkshop } from "../scripts/workshop-node.mjs";
import { createConverter } from "../scripts/fun3d-convert.mjs";
import { parseModelFile } from "../site/workshop/glb.js";
import { Vector3, AnimationMixer } from "three";
import { mergeProjects, importModel } from "../site/workshop/import-glb.js";
import { readSkinWeights } from "../site/workshop/import-skin.js";
import { worldMatrix, point } from "../site/workshop/spatial.js";
import { toolInvocation } from "../site/workshop/agent-tools.js";

test("generic GLB preserves skin seams, inverse binds and editable joint deformation", async () => {
  const s = setup();
  s.apply([{ op: "set", id: "body", position: [.3, .2, .1], rotation: [0, 20, 0] }]);
  const bound = s.snapshot().nodes.find(n => n.id === "body").skin;
  s.apply([{ op: "skinBind", id: "body", joints: bound.joints, weights: bound.weights.map((ws, index) => ({
    index, influences: ws.map(w => ({ joint: bound.joints[w.joint], weight: w.weight })),
  })) }, { op: "set", id: "tip", rotation: [0, 0, 17] }]);
  const session = await openWorkshop({ record: { project: s.snapshot(), revision: 0 }, width: 64, height: 64 });
  try {
    const exported = await session.api.exportGLB({ encoding: "base64" });
    const imported = importModel(Buffer.from(exported.data, "base64"));
    assert.equal(imported.warnings.some(w => w.code === "skins"), false);
    assert.ok(imported.processing.some(p => p.preservedSkinJoints?.length === 2 && p.vertexWelding === false));
    const reopened = createStore(imported.project);
    const n = reopened.snapshot().nodes.find(n => n.id === "body");
    assert.ok(n.skin && n.mesh.vertices.length > s.snapshot().nodes.find(n => n.id === "body").mesh.vertices.length);
    const compare = () => {
      const a = s.snapshot(), b = reopened.snapshot();
      const expected = a.nodes.find(n => n.id === "body").mesh.vertices.map(v => point(worldMatrix(a, "body"), v));
      for (const v of b.nodes.find(n => n.id === "body").mesh.vertices) {
        const actual = point(worldMatrix(b, "body"), v);
        assert.ok(Math.min(...expected.map(p => Math.hypot(...p.map((x, k) => x - actual[k])))) < 1e-6);
      }
    };
    compare();
    const command = { op: "set", id: "tip", rotation: [0, 0, 33] };
    s.apply([command]); reopened.apply([command]); compare();
    assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(reopened.snapshot()))), reopened.snapshot());
  } finally { session.dispose(); }
});

test("skin import validates attribute formats and refuses extra or invalid influences", () => {
  const json = { accessors: [{ type: "VEC4", componentType: 5121, count: 1 },
    { type: "VEC4", componentType: 5121, normalized: true, count: 1 }] };
  const primitive = { attributes: { JOINTS_0: 0, WEIGHTS_0: 1 } };
  const read = i => i ? [128 / 255, 127 / 255, 0, 0] : [0, 1, 0, 0];
  const weights = readSkinWeights(json, read, primitive, 1, "weights");
  assert.ok(Math.abs(weights[0].reduce((s, w) => s + w.weight, 0) - 1) < 1e-10);
  assert.throws(() => readSkinWeights(json, read, { attributes: { ...primitive.attributes, JOINTS_1: 0 } }, 1, "weights"), /four skin influences/);
  assert.throws(() => readSkinWeights(json, i => i ? [.1, .1, 0, 0] : read(0), primitive, 1, "weights"), /actual 0.2/);
});

test("jointRest preserves base world geometry, child frames and weights while updating bind matrices", () => {
  const s = setup();
  s.apply([{ op: "set", id: "body", parent: "root_joint", keepWorld: true },
    { op: "characterClip", name: "swing", duration: 1, tracks: [
      { node: "root_joint", channel: "rotation", keys: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 0, 20] }] },
    ] }]);
  const before = s.snapshot(), old = before.nodes.find(n => n.id === "body");
  const command = { op: "jointRest", id: "root_joint", position: [.1, .05, 0], rotation: [0, 0, 5] };
  assert.ok(toolInvocation("fun_editor_apply", { ifRevision: 0, commands: [command] }));
  const result = s.apply([command]), after = s.snapshot(), mesh = after.nodes.find(n => n.id === "body");
  for (let i = 0; i < mesh.mesh.vertices.length; i++) {
    const a = point(worldMatrix(before, "body"), old.mesh.vertices[i]);
    const b = point(worldMatrix(after, "body"), mesh.mesh.vertices[i]);
    assert.ok(Math.hypot(...a.map((v, k) => v - b[k])) < 1e-9);
  }
  worldMatrix(before, "tip").forEach((v, i) => assert.ok(Math.abs(v - worldMatrix(after, "tip")[i]) < 1e-9));
  assert.deepEqual(mesh.skin.weights, old.skin.weights);
  assert.notDeepEqual(mesh.skin.inverseBind, old.skin.inverseBind);
  assert.deepEqual(after.character.clips, before.character.clips);
  assert.ok(JSON.stringify(result).includes("unchangedTracks"));
  assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(after))), after);
  s.undo(); assert.deepEqual(s.snapshot(), before);
  assert.throws(() => s.apply([{ op: "jointRest", id: "body" }]), /existing joint/);
  assert.deepEqual(s.snapshot(), before);
  s.apply([{ op: "set", id: "tip", rotation: [0, 0, 30] }]);
  const rotated = s.snapshot();
  assert.throws(() => s.apply([{ op: "jointRest", id: "root_joint", scale: [2, 1, 1] }]), /require shear/);
  assert.deepEqual(s.snapshot(), rotated);
});
test("skin within one attached frame follows its surface while preserving local joint deformation", () => {
  const s = setup();
  s.apply([{ op: "create", kind: "box", id: "support", position: [0, 0, -2] },
    { op: "create", kind: "group", id: "mount" },
    { op: "set", id: "body", parent: "mount", keepWorld: true },
    { op: "set", id: "root_joint", parent: "mount", keepWorld: true },
    { op: "attachSurface", id: "mount", targetId: "support", at: [0, 0, -1.5], mode: "frame" },
    { op: "set", id: "tip", rotation: [0, 0, 25] }]);
  const before = s.snapshot(), old = before.nodes.find(n => n.id === "body");
  s.apply([{ op: "set", id: "support", position: [1, 0, -2] }]);
  const after = s.snapshot(), mesh = after.nodes.find(n => n.id === "body");
  for (let i = 0; i < mesh.mesh.vertices.length; i++) {
    const a = point(worldMatrix(before, "body"), old.mesh.vertices[i]);
    const b = point(worldMatrix(after, "body"), mesh.mesh.vertices[i]);
    assert.ok(Math.hypot(b[0] - a[0] - 1, b[1] - a[1], b[2] - a[2]) < 1e-10);
  }
  assert.equal(JSON.stringify(evaluateProject(JSON.parse(JSON.stringify(after)))), JSON.stringify(after));
  assert.throws(() => s.apply([{ op: "set", id: "root_joint", parent: null, keepWorld: true }]), /same surface-attached frame/);
  assert.deepEqual(s.snapshot(), after);
});

function setup() {
  const s = createStore(emptyProject());
  s.apply([{ op: "create", kind: "group", id: "root_joint" }, { op: "joint", id: "root_joint" },
    { op: "create", kind: "group", id: "tip", parent: "root_joint", position: [0, .5, 0] },
    { op: "joint", id: "tip" }, { op: "create", kind: "box", id: "body" }]);
  const n = s.snapshot().nodes.find(n => n.id === "body");
  s.apply([{ op: "skinBind", id: "body", joints: ["root_joint", "tip"],
    weights: n.mesh.vertices.map((p, index) => ({ index, influences: p[1] > 0
      ? [{ joint: "root_joint", weight: .25 }, { joint: "tip", weight: .75 }]
      : [{ joint: "root_joint", weight: 1 }] })) }]);
  return s;
}
test("skin rest, edited weights and poses persist without drift; invalid edits are atomic", () => {
  const s = setup(), before = s.snapshot();
  s.apply([{ op: "set", id: "tip", rotation: [0, 0, 40] }]);
  const posed = s.snapshot(), mesh = posed.nodes.find(n => n.id === "body");
  assert.notDeepEqual(mesh.mesh.vertices, mesh.skin.base);
  assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(posed))), posed);
  s.undo(); assert.deepEqual(s.snapshot(), before); s.redo();
  assert.throws(() => s.apply([{ op: "skinWeights", id: "body",
    weights: [{ index: 0, influences: [{ joint: "tip", weight: .3 }] }] }]), /sum to 1/);
  assert.throws(() => s.apply([{ op: "triangulate", id: "body" }]), /skin topology/i);
  assert.throws(() => s.apply([{ op: "joint", id: "tip", enabled: false }]), /Missing joint/);
  assert.deepEqual(s.snapshot(), posed);
});
test("morph then skin exports joints, inverse binds and animation to actual fun3d", async () => {
  const s = setup(), n = s.snapshot().nodes.find(n => n.id === "body");
  s.apply([{ op: "morphTarget", id: "body", name: "wide",
    changes: n.mesh.vertices.map((v, index) => ({ index, position: [v[0] * 1.1, v[1], v[2]] })) },
    { op: "characterClip", name: "bend", duration: 1, fps: 12, loop: false, tracks: [
      { node: "tip", channel: "rotation", keys: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 0, 40] }] },
      { node: "body", channel: "morph", target: "wide", keys: [{ time: 0, value: 0 }, { time: 1, value: 1 }] },
    ] }]);
  const session = await openWorkshop({ record: { project: s.snapshot(), revision: 0 }, width: 128, height: 128 });
  try {
    const result = await session.api.exportGLB({ encoding: "base64" }), bytes = Buffer.from(result.data, "base64");
    const json = parseModelFile(bytes).json;
    assert.equal(json.skins.length, 1); assert.equal(json.skins[0].joints.length, 2);
    const importedSession = await openWorkshop({ record: { project: importModel(bytes).project, revision: 0 }, width: 64, height: 64 });
    try {
      const repeated = await importedSession.api.workflow({ action: "verifyExport" });
      assert.equal(repeated.editable.integrity.exact, true, "float32 frame times remain unique on re-export");
    } finally { importedSession.dispose(); }
    const converter = createConverter(), converted = await converter.convert(bytes, { type: "character", name: "skin-check" });
    const model = await converter.fun3d.load(converted.bytes);
    try {
      assert.equal(model.skeletons.size, 1);
      const mixer = new AnimationMixer(model.root);
      mixer.clipAction(model.animations[0]).play(); mixer.update(.5);
      model.root.updateMatrixWorld(true);
      const actual = [...model.nodes.values()].find(n => n.isSkinnedMesh);
      actual.skeleton.update();
      const p = s.snapshot(); p.character.pose = { clip: "bend", time: .5 };
      const expected = evaluateProject(p).nodes.find(n => n.id === "body").mesh.vertices;
      for (let i = 0; i < actual.geometry.getAttribute("position").count; i++) {
        const v = actual.getVertexPosition(i, new Vector3());
        assert.ok(Math.min(...expected.map(p => v.distanceTo(new Vector3(...p)))) < 2e-4, `runtime vertex ${i}`);
      }
      mixer.stopAllAction(); mixer.uncacheRoot(model.root);
    } finally { model.dispose(); }
    const roundtrip = await session.api.workflow({ action: "verifyExport" });
    assert.deepEqual(roundtrip.editable.scope.changed, []);
  } finally { session.dispose(); }
});
test("renaming and merging editable rigs remap skin and clip dependencies", () => {
  const s = setup();
  s.apply([{ op: "characterControl", id: "bend", bindings: [
    { node: "tip", channel: "rotation", delta: [0, 0, 30] },
  ] }, { op: "characterClip", name: "move", duration: 1, tracks: [
    { control: "bend", channel: "control", keys: [{ time: 0, value: 0 }, { time: 1, value: 1 }] },
  ] }, { op: "rename", id: "tip", newId: "elbow" }]);
  const original = s.snapshot();
  assert.equal(original.nodes.find(n => n.id === "body").skin.joints[1], "elbow");
  assert.equal(original.character.controls[0].bindings[0].node, "elbow");
  const { project, nodes } = mergeProjects(original, original);
  const merged = createStore(project).snapshot(), incoming = merged.nodes.find(n => nodes.includes(n.id) && n.skin);
  assert.notEqual(incoming.skin.joints[1], "elbow");
  assert.ok(nodes.includes(incoming.skin.joints[1]));
  assert.equal(merged.character.clips.length, 2);
  assert.notEqual(merged.character.controls[0].id, merged.character.controls[1].id);
  assert.equal(merged.character.clips[1].tracks[0].control, merged.character.controls[1].id);
});
test("skin-only meshes with empty morph attributes export animated clips", async () => {
  const s = setup();
  s.apply([{ op: "characterClip", name: "bend", duration: 1, fps: 2, tracks: [
    { node: "tip", channel: "rotation", keys: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 0, 20] }] },
  ] }]);
  const session = await openWorkshop({ record: { project: s.snapshot(), revision: 0 }, width: 64, height: 64 });
  try {
    const exported = await session.api.exportGLB({ encoding: "base64" });
    const json = parseModelFile(Buffer.from(exported.data, "base64")).json;
    assert.equal(json.skins.length, 1); assert.equal(json.animations.length, 1);
  } finally { session.dispose(); }
});
test("surface followers update after skinning and partial weight edits retain other vertices", () => {
  const s = setup();
  s.apply([{ op: "create", kind: "group", id: "badge" },
    { op: "attachSurface", id: "badge", targetId: "body", at: [.3, .3, .5], mode: "position" }]);
  const before = s.snapshot(), original = before.nodes.find(n => n.id === "body").skin.weights;
  s.apply([{ op: "skinWeights", id: "body", weights: [
    { index: 0, influences: [{ joint: "tip", weight: 1 }] },
  ] }, { op: "set", id: "tip", rotation: [0, 0, 20] }]);
  const p = s.snapshot();
  assert.deepEqual(p.nodes.find(n => n.id === "body").skin.weights.slice(1), original.slice(1));
  assert.notDeepEqual(p.nodes.find(n => n.id === "badge").position, before.nodes.find(n => n.id === "badge").position);
  assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(p))), p);
});
