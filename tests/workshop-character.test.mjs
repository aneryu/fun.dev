import test from "node:test";
import assert from "node:assert/strict";
import { createStore, emptyProject, evaluateProject } from "../site/workshop/document.js";
import { toolInvocation } from "../site/workshop/agent-tools.js";
import { openWorkshop } from "../scripts/workshop-node.mjs";
import { parseModelFile } from "../site/workshop/glb.js";
import { createConverter } from "../scripts/fun3d-convert.mjs";
import { AnimationMixer } from "three";
import { mergeProjects } from "../site/workshop/import-glb.js";

test("binding attenuation uses resolved inputs, persists and remaps dependencies", () => {
  const s = setup();
  s.apply([{ op: "characterControl", id: "close", bindings: [
    { node: "head", channel: "position", delta: [0, 0, 0] },
  ] }, { op: "characterControl", id: "expression", bindings: [
    { node: "head", channel: "morph", target: "wide", gain: 1, attenuateBy: "close" },
    { node: "head", channel: "rotation", delta: [0, 30, 0], attenuateBy: "close" },
  ] }, { op: "characterValues", values: { expression: .8, close: .5 } }]);
  const p = s.snapshot();
  assert.equal(p.character.version, 2);
  assert.equal(p.nodes[0].morph.weights.wide, .4);
  assert.equal(p.nodes[0].rotation[1], 12);
  assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(p))), p);
  assert.throws(() => s.apply([{ op: "characterRemove", kind: "control", id: "close" }]), /attenuation control close/);
  assert.deepEqual(s.snapshot(), p);
  const merged = createStore(mergeProjects(p, p).project).snapshot();
  const other = merged.character.controls.find(c => c.id !== "expression" && c.bindings.some(b => b.attenuateBy));
  assert.notEqual(other.bindings[0].attenuateBy, "close");
  assert.equal(merged.character.version, 2);
  const old = structuredClone(p); old.character.version = 1;
  assert.throws(() => createStore(old), /version 2/);
});

function setup() {
  const s = createStore(emptyProject());
  s.apply([{ op: "create", kind: "box", id: "head" }]);
  s.apply([{ op: "morphTarget", id: "head", name: "wide",
    changes: s.snapshot().nodes[0].mesh.vertices.map((p, index) =>
      ({ index, position: [p[0] * 2, p[1], p[2]] })) }]);
  s.apply([{ op: "characterControl", id: "expression", bindings: [
    { node: "head", channel: "morph", target: "wide", gain: 1 },
    { node: "head", channel: "rotation", delta: [0, 30, 0] },
  ] }]);
  return s;
}
test("persisted controls mix morph and transforms without accumulating across reload and edits", () => {
  const s = setup(), neutral = s.snapshot();
  s.apply([{ op: "characterValues", values: { expression: .5 } }]);
  const posed = s.snapshot();
  assert.equal(posed.nodes[0].rotation[1], 15);
  assert.equal(posed.nodes[0].morph.weights.wide, .5);
  for (let i = 0; i < 5; i++) assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(posed))), posed);
  s.undo(); assert.deepEqual(s.snapshot(), neutral);
  s.redo(); assert.deepEqual(s.snapshot(), posed);
  s.apply([{ op: "set", id: "head", position: [1, 0, 0] }]);
  assert.deepEqual(s.snapshot().nodes[0].position, [1, 0, 0]);
  assert.equal(s.snapshot().nodes[0].rotation[1], 15);
  s.apply([{ op: "characterValues", values: { expression: 0 } }]);
  assert.equal(s.snapshot().nodes[0].rotation[1], 0);
});
test("clips interpolate controls and local channels with explicit loop/step semantics", () => {
  const s = setup();
  const command = { op: "characterClip", name: "greet", duration: 2, loop: true, tracks: [
    { control: "expression", channel: "control", keys: [{ time: 0, value: 0 }, { time: 2, value: 1 }] },
    { node: "head", channel: "position", interpolation: "step", keys: [
      { time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 1, 0] },
    ] },
  ] };
  assert.ok(toolInvocation("fun_editor_apply", { ifRevision: s.revision, commands: [command] }));
  s.apply([command, { op: "characterPose", name: "greet", time: .5 }]);
  assert.equal(s.snapshot().nodes[0].rotation[1], 7.5);
  assert.equal(s.snapshot().nodes[0].position[1], 0);
  s.apply([{ op: "characterPose", name: "greet", time: 3 }]);
  assert.equal(s.snapshot().nodes[0].position[1], 1);
  assert.equal(s.snapshot().nodes[0].rotation[1], 15);
  s.apply([{ op: "characterPose" }]);
  assert.equal(s.snapshot().nodes[0].rotation[1], 0);
  assert.equal(Object.hasOwn(s.snapshot().character, "pose"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(s.snapshot().character)), s.snapshot().character);
});
test("invalid controller dependencies fail atomically and deleting clips permits control removal", () => {
  const s = setup(), before = s.snapshot();
  assert.throws(() => s.apply([{ op: "characterValues", values: { missing: 1 } }]), /Unknown control/);
  assert.throws(() => s.apply([{ op: "morphRemove", id: "head", name: "wide" }]), /Missing morph/);
  assert.deepEqual(s.snapshot(), before);
  s.apply([{ op: "characterRemove", kind: "control", id: "expression" }]);
  s.apply([{ op: "morphRemove", id: "head", name: "wide" }]);
});
test("frame attachments reject competing scale controls and clips; position attachments retain scale authoring", () => {
  const s = createStore(emptyProject());
  s.apply([{ op: "create", kind: "box", id: "head" },
    { op: "create", kind: "box", id: "eye", position: [0, 0, .6] },
    { op: "attachSurface", id: "eye", targetId: "head", mode: "frame" }]);
  const control = { op: "characterControl", id: "grow", bindings: [
    { node: "eye", channel: "scale", delta: [1, 0, 0] },
  ] };
  const clip = { op: "characterClip", name: "grow_clip", duration: 1, tracks: [
    { node: "eye", channel: "scale", keys: [{ time: 0, value: [1, 1, 1] }, { time: 1, value: [3, 1, 1] }] },
  ] };
  const before = s.snapshot(), revision = s.revision;
  for (const command of [control, clip]) {
    assert.throws(() => s.apply([command]), error =>
      error.message.includes("scale on eye") && error.message.includes("surface attachment") && error.path === "nodes.eye.attachment");
    assert.deepEqual(s.snapshot(), before); assert.equal(s.revision, revision);
  }
  s.apply([{ op: "detachSurface", id: "eye" }, { op: "attachSurface", id: "eye", targetId: "head", mode: "position" },
    control, { op: "characterValues", values: { grow: 1 } }]);
  assert.deepEqual(s.snapshot().nodes.find(n => n.id === "eye").scale, [2, 1, 1]);
  s.apply([clip, { op: "characterPose", name: "grow_clip", time: .75 }]);
  assert.deepEqual(s.snapshot().nodes.find(n => n.id === "eye").scale, [2.5, 1, 1]);
  assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(s.snapshot()))), s.snapshot());
});
test("authored clips export and play morph and transform channels in fun3d", async () => {
  const s = setup();
  s.apply([{ op: "characterClip", name: "expression_clip", duration: 1, fps: 4, loop: false, tracks: [
    { control: "expression", channel: "control", keys: [{ time: 0, value: 0 }, { time: 1, value: 1 }] },
  ] }, { op: "characterClip", name: "short_loop", duration: .1, fps: 30, loop: true, tracks: [
    { control: "expression", channel: "control", keys: [{ time: 0, value: 0 }, { time: .1, value: 1 }] },
  ] }]);
  const session = await openWorkshop({ record: { project: s.snapshot(), revision: 0 }, width: 128, height: 128 });
  try {
    const exported = await session.api.exportGLB({ encoding: "base64" });
    const bytes = Buffer.from(exported.data, "base64"), json = parseModelFile(bytes).json;
    assert.equal(json.animations[0].name, "expression_clip");
    const converter = createConverter(), converted = await converter.convert(bytes, { type: "character", name: "controls" });
    const model = await converter.fun3d.load(converted.bytes);
    try {
      assert.equal(model.animations.length, 2);
      assert.equal(model.animations[0].userData.loop, "once");
      const short = model.animations.find(c => c.name === "short_loop");
      assert.equal(short.tracks.find(t => t.name.includes("morphTargetInfluences")).values.at(-1), 1,
        "float32 rounding at the last key must not wrap a looping clip to its first pose");
      const mixer = new AnimationMixer(model.root);
      mixer.clipAction(model.animations[0]).play(); mixer.update(.5);
      const mesh = [...model.nodes.values()].map(n => n.userData.mesh ?? n).find(n => n.isMesh);
      assert.ok(Math.abs(mesh.morphTargetInfluences[0] - .5) < 1e-5);
      const head = [...model.nodes.values()].find(n => n.name === "head");
      assert.ok(Math.abs(head.rotation.y - Math.PI / 12) < 1e-5);
      mixer.stopAllAction(); mixer.uncacheRoot(model.root);
    } finally { model.dispose(); }
  } finally { session.dispose(); }
});
test("joint rest and rigid parenting survive poses and editable reload", () => {
  const s = createStore(emptyProject());
  s.apply([{ op: "create", kind: "group", id: "hip", position: [0, 1, 0] },
    { op: "joint", id: "hip" }, { op: "create", kind: "box", id: "foot" },
    { op: "set", id: "foot", parent: "hip", keepWorld: true },
    { op: "characterClip", name: "stride", duration: 1, tracks: [
      { node: "hip", channel: "rotation", keys: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [30, 0, 0] }] },
    ] }, { op: "characterPose", name: "stride", time: .5 }]);
  const p = s.snapshot();
  assert.deepEqual(p.nodes.find(n => n.id === "hip").joint.rest.rotation, [0, 0, 0]);
  assert.equal(p.nodes.find(n => n.id === "hip").rotation[0], 15);
  assert.deepEqual(p.nodes.find(n => n.id === "foot").position, [0, -1, 0]);
  assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(p))), p);
  assert.throws(() => s.apply([{ op: "joint", id: "foot" }]), /independent empty group/);
  assert.deepEqual(s.snapshot(), p);
});
