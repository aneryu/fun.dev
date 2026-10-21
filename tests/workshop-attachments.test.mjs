import test from "node:test";
import assert from "node:assert/strict";
import { createStore, emptyProject, evaluateProject } from "../site/workshop/document.js";
import { worldMatrix, point } from "../site/workshop/spatial.js";
import { toolInvocation } from "../site/workshop/agent-tools.js";
import { mergeProjects } from "../site/workshop/import-glb.js";
import { openWorkshop } from "../scripts/workshop-node.mjs";
import { createConverter } from "../scripts/fun3d-convert.mjs";
import { AnimationMixer, Vector3 } from "three";
import { presetFromObservation } from "../site/workshop/view-presets.js";

function setup() {
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "head", kind: "box" },
    { op: "create", id: "eye", kind: "box", options: { size: [0.1, 0.1, 0.1] }, position: [0, 0, 0.6] },
    { op: "create", id: "glint", kind: "box", options: { size: [0.02, 0.02, 0.02] }, position: [0, 0, 0.7] },
  ]);
  return s;
}
const origin = (s, id) => point(worldMatrix(s.snapshot(), id), [0, 0, 0]);
const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-8, `${a} != ${b}`));

test("deform attachment follows triangle stretch without cumulative edits and rejects conflicting drivers", () => {
  const s = setup();
  s.apply([{ op: "attachSurface", id: "eye", targetId: "head", at: [0, 0, .5], mode: "deform" },
    { op: "attachSurface", id: "glint", targetId: "eye", mode: "position" }]);
  const before = s.snapshot(), eye = before.nodes.find(n => n.id === "eye");
  assert.equal(eye.attachment.version, 2);
  assert.equal(eye.attachment.coordinates.length, eye.mesh.vertices.length);
  s.apply([{ op: "transform", id: "head", scale: [1.5, 1, 1], pivot: [0, 0, 0] }]);
  const after = s.snapshot(), changed = after.nodes.find(n => n.id === "eye");
  const width = n => Math.max(...n.mesh.vertices.map(v => v[0])) - Math.min(...n.mesh.vertices.map(v => v[0]));
  assert.ok(Math.abs(width(changed) - width(eye) * 1.5) < 1e-9);
  assert.equal(JSON.stringify(evaluateProject(JSON.parse(JSON.stringify(after)))), JSON.stringify(after));
  assert.throws(() => s.apply([{ op: "displace", id: "eye", amount: .1 }]), /Detach or rebind/);
  assert.throws(() => s.apply([{ op: "characterControl", id: "eye_rotation", bindings: [
    { node: "eye", channel: "rotation", delta: [0, 10, 0] },
  ] }]), /surface attachment/);
  assert.deepEqual(s.snapshot(), after);
  s.undo(); assert.deepEqual(s.snapshot(), before);
  s.redo(); s.apply([{ op: "detachSurface", id: "eye" }]);
  assert.deepEqual(s.snapshot().nodes.find(n => n.id === "eye").mesh.vertices, changed.mesh.vertices);
});

test("deform followers bake across multiple clips and play in actual fun3d", async () => {
  const s = setup();
  s.apply([{ op: "attachSurface", id: "eye", targetId: "head", mode: "deform" },
    ...[["wide", [1.5, 1, 1]], ["tall", [1, 1.5, 1]]].map(([name, scale]) => ({
      op: "characterClip", name, duration: 1, fps: 4, loop: false, tracks: [
        { node: "head", channel: "scale", keys: [{ time: 0, value: [1, 1, 1] }, { time: 1, value: scale }] },
      ],
    }))]);
  const project = s.snapshot();
  const session = await openWorkshop({ record: { project, revision: 0 }, width: 64, height: 64 });
  try {
    const preflight = session.api.exportReport();
    const exported = await session.api.exportGLB({ encoding: "base64" });
    assert.deepEqual(preflight.morphTargets, exported.report.morphTargets);
    assert.deepEqual(preflight.animations, exported.report.animations);
    assert.deepEqual(preflight.transfer, exported.report.transfer);
    assert.equal(preflight.transfer.editableSourceEmbedded, false);
    assert.equal(preflight.transfer.readbackChecked, false);
    assert.deepEqual(preflight.transfer.features.find(f => f.name === "surfaceAttachments").ids, ["eye"]);
    assert.equal(preflight.transfer.features.find(f => f.name === "surfaceAttachments").treatment, "baked");
    const followerTargets = preflight.morphTargets.find(n => n.node === "eye");
    assert.ok(followerTargets?.names.length > 0, "Report must include baked follower targets");
    assert.deepEqual(session.api.getProject(), project, "Reporting and exporting must preserve the editable source");
    const converter = createConverter();
    const converted = await converter.convert(Buffer.from(exported.data, "base64"), { type: "character", name: "deform-follower" });
    const model = await converter.fun3d.load(converted.bytes), mixer = new AnimationMixer(model.root);
    try {
      for (const name of ["wide", "tall", "wide"]) for (const time of [0, .375, .5, 1]) {
        mixer.stopAllAction();
        const action = mixer.clipAction(model.animations.find(c => c.name === name)); action.reset().play();
        action.time = time; mixer.update(0); model.root.updateMatrixWorld(true);
        let mesh; model.root.traverse(o => { if (o.isMesh && (o.name === "eye" || o.parent?.name === "eye")) mesh = o; });
        assert.ok(mesh?.morphTargetInfluences.length);
        assert.equal(mesh.morphTargetInfluences.length, followerTargets.names.length,
          "Reported baked target count must match the actual fun3d mesh");
        const input = structuredClone(project); input.character.pose = { clip: name, time };
        const pose = evaluateProject(input), n = pose.nodes.find(n => n.id === "eye");
        const expected = n.mesh.vertices.map(v => new Vector3(...point(worldMatrix(pose, "eye"), v)));
        for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
          const v = mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld);
          assert.ok(Math.min(...expected.map(p => p.distanceTo(v))) < .0002, `${name}@${time}:${i}`);
        }
      }
    } finally { mixer.stopAllAction(); mixer.uncacheRoot(model.root); model.dispose(); }
    const roundtrip = await session.api.workflow({ action: "verifyExport" });
    assert.deepEqual(roundtrip.editable.scope.changed, []);
  } finally { session.dispose(); }
});

test("scoped deform follower export ignores unrelated view presets and preserves runtime deformation", async () => {
  const s=setup();
  s.apply([{op:"attachSurface",id:"eye",targetId:"head",mode:"deform"},
    {op:"characterClip",name:"wide",duration:1,fps:4,loop:false,tracks:[
      {node:"head",channel:"scale",keys:[{time:0,value:[1,1,1]},{time:1,value:[1.5,1,1]}]},
    ]}]);
  const session=await openWorkshop({record:{project:s.snapshot(),revision:0},width:64,height:64});
  try {
    const shot=session.api.renderViews(["front"],{ids:["head"],size:64,helpers:false})[0];
    s.apply([{op:"viewPreset",id:"head-front",definition:presetFromObservation(shot,"head-front")}]);
    const project=s.snapshot();session.api.loadProject(project);
    const exported=await session.api.exportGLB({encoding:"base64",ids:["eye"]});
    assert.equal(exported.report.validation.ok,true);
    assert.deepEqual(session.api.getProject(),project);
    const targets=exported.report.morphTargets.find(n=>n.node==="eye");assert.ok(targets?.names.length);
    const converter=createConverter(),converted=await converter.convert(Buffer.from(exported.data,"base64"),{type:"character",name:"scoped-follower"});
    const model=await converter.fun3d.load(converted.bytes),mixer=new AnimationMixer(model.root);
    try {
      assert.equal([...model.nodes.values()].some(n=>n.name==="head"),false,"Do not export the external driver mesh");
      let mesh;model.root.traverse(o=>{if(o.isMesh)mesh=o;});assert.ok(mesh?.morphTargetInfluences?.length);
      const action=mixer.clipAction(model.animations.find(c=>c.name==="wide"));action.play();action.time=.375;mixer.update(0);model.root.updateMatrixWorld(true);
      const posed=structuredClone(project);posed.character.pose={clip:"wide",time:.375};
      const expected=evaluateProject(posed),node=expected.nodes.find(n=>n.id==="eye");
      const points=node.mesh.vertices.map(v=>new Vector3(...point(worldMatrix(expected,"eye"),v)));
      for(let i=0;i<mesh.geometry.attributes.position.count;i++){
        const actual=mesh.getVertexPosition(i,new Vector3()).applyMatrix4(mesh.matrixWorld);
        assert.ok(Math.min(...points.map(p=>p.distanceTo(actual)))<.0002,`scoped runtime vertex ${i}`);
      }
    }finally{mixer.stopAllAction();mixer.uncacheRoot(model.root);model.dispose();}
  }finally{session.dispose();}
});

test("surface command schema discovers and accepts precise binding fields", () => {
  assert.ok(toolInvocation("fun_editor_apply", { ifRevision: 0, commands: [
    { op: "attachSurface", id: "eye", targetId: "head", anchor: [0, 0, 0], at: [0, 0, 1], offset: 0.01, mode: "frame" },
  ] }));
  assert.ok(toolInvocation("fun_editor_apply", { ifRevision: 0, commands: [
    { op: "mirrorSurface", id: "left", sourceId: "right", axis: "x", plane: 0, tolerance: .00001 },
  ] }));
});

test("mirrored bindings use target-local axes, retain material points and remap source dependencies", () => {
  const s = setup();
  s.apply([{ op: "set", id: "head", rotation: [0, 30, 0] }]);
  const at = point(worldMatrix(s.snapshot(), "head"), [-.25, .1, .5]);
  s.apply([{ op: "attachSurface", id: "eye", targetId: "head", at, mode: "position" },
    { op: "mirrorSurface", id: "glint", sourceId: "eye", axis: "x", tolerance: 1e-7 }]);
  let p = s.snapshot();
  near(origin(s, "glint"), point(worldMatrix(p, "head"), [.25, .1, .5]));
  assert.equal(p.nodes.find(n => n.id === "glint").attachment.version, 3);
  assert.equal(p.nodes.find(n => n.id === "glint").attachment.mirror.source, "eye");
  s.apply([{ op: "attachSurface", id: "eye", targetId: "head", at, offset: .02, mode: "position" }]);
  assert.equal(s.snapshot().nodes.find(n => n.id === "glint").attachment.offset, .02);
  s.apply([{ op: "transform", id: "head", scale: [1.2, 1, 1], pivot: [0, 0, 0] }]);
  p = s.snapshot();
  assert.equal(JSON.stringify(evaluateProject(JSON.parse(JSON.stringify(p)))), JSON.stringify(p));
  const movedAt = point(worldMatrix(p, "head"), [-.1, .2, .5]);
  assert.throws(() => s.apply([{ op: "attachSurface", id: "eye", targetId: "head", at: movedAt }]),
    /Mirror source binding changed/);
  assert.throws(() => s.apply([{ op: "delete", id: "eye" }]), /Missing dependency|source binding/);
  assert.throws(() => s.apply([{ op: "mirrorSurface", id: "eye", sourceId: "glint" }]), /cycle/);
  assert.throws(() => s.apply([{ op: "mirrorSurface", id: "glint", sourceId: "eye", plane: 2 }]), /tolerance/);
  assert.deepEqual(s.snapshot(), p);
  s.apply([{ op: "rename", id: "eye", newId: "source_eye" }, { op: "rename", id: "head", newId: "skull" }]);
  assert.equal(s.snapshot().nodes.find(n => n.id === "glint").attachment.mirror.source, "source_eye");
  const merged = evaluateProject(mergeProjects(s.snapshot(), s.snapshot()).project);
  const pairs = merged.nodes.filter(n => n.attachment?.mirror);
  assert.equal(pairs.length, 2);
  assert.notEqual(pairs[0].attachment.mirror.source, pairs[1].attachment.mirror.source);
  s.apply([{ op: "group", ids: ["skull", "source_eye", "glint"], newId: "rig" },
    { op: "duplicate", id: "rig", newId: "rig2", offset: [3, 0, 0] }]);
  assert.equal(s.snapshot().nodes.filter(n => n.attachment?.mirror).length, 2);
  const recovery = setup();
  recovery.apply([{ op: "attachSurface", id: "eye", targetId: "head", at: [-.2, .1, .5] },
    { op: "mirrorSurface", id: "glint", sourceId: "eye" }]);
  recovery.apply([{ op: "detachSurface", id: "glint" },
    { op: "attachSurface", id: "eye", targetId: "head", at: [-.1, .2, .5] },
    { op: "mirrorSurface", id: "glint", sourceId: "eye" }]);
  near(origin(recovery, "glint"), [.1, .2, .5]);
});
test("mirror miss diagnostics retain target coordinates and locate the failed candidate without a commit", async () => {
  const s = setup();
  s.apply([{ op: "set", id: "head", position: [3, 2, 1], rotation: [0, 30, 0] },
    { op: "attachSurface", id: "eye", targetId: "head" }]);
  const before = s.snapshot();
  const session = await openWorkshop({ record: { project: before, revision: 0 }, width: 64, height: 64 });
  try {
    const result = await session.api.workflow({ action: "prepare", detail: "full", views: [],
      commands: [{ op: "mirrorSurface", id: "glint", sourceId: "eye", plane: 2 }] });
    assert.equal(result.ok, false);
    const issue = result.diagnostics.find(d => d.code === "mirror_surface_miss");
    assert.equal(issue.space, "target-local");
    near(issue.worldPoint, point(worldMatrix(before, "head"), issue.point));
    assert.ok(issue.actual > issue.threshold);
    assert.equal(result.error.retryable, false);
    assert.ok(result.candidateId && result.project);
    assert.deepEqual(session.api.getProject(), before);
  } finally { session.dispose(); }
});
test("binding follows topology-preserving deformation, chained targets, JSON reload and undo", () => {
  const s = setup();
  s.apply([{ op: "attachSurface", id: "eye", targetId: "head", offset: 0.1 },
    { op: "attachSurface", id: "glint", targetId: "eye", offset: 0.05 }]);
  const before = s.snapshot();
  s.apply([{ op: "transform", id: "head", scale: [1.2, 1, 2] }]);
  near(origin(s, "eye"), [0, 0, 1.1]);
  near(origin(s, "glint"), [0, 0, 1.2]);
  const reopened = evaluateProject(JSON.parse(JSON.stringify(s.snapshot())));
  assert.deepEqual(reopened, s.snapshot());
  s.undo(); assert.deepEqual(s.snapshot(), before);
});
test("frame mode follows target rotation, position mode retains orientation", () => {
  const s = setup();
  s.apply([{ op: "attachSurface", id: "eye", targetId: "head", offset: 0.1, mode: "frame" }]);
  s.apply([{ op: "set", id: "head", rotation: [0, 90, 0] }]);
  near(origin(s, "eye"), [0.6, 0, 0]);
  near(s.snapshot().nodes.find(n => n.id === "eye").rotation, [0, 90, 0]);
});
test("topology changes, target deletion, transform override and cycles reject atomically", () => {
  const s = setup();
  s.apply([{ op: "attachSurface", id: "eye", targetId: "head" }]);
  const before = s.snapshot(), revision = s.revision;
  for (const command of [
    { op: "delete", id: "head" },
    { op: "triangulate", id: "head" },
    { op: "attachSurface", id: "head", targetId: "eye" },
    { op: "transform", id: "eye", translation: [1, 0, 0] },
  ]) {
    assert.throws(() => s.apply([command]));
    assert.deepEqual(s.snapshot(), before); assert.equal(s.revision, revision);
  }
  s.apply([{ op: "detachSurface", id: "eye" }, { op: "triangulate", id: "head" },
    { op: "attachSurface", id: "eye", targetId: "head" }]);
  assert.ok(s.snapshot().nodes.find(n => n.id === "eye").attachment);
});
test("position-only attachments retain exact local rotation and scale under rotated parents", () => {
  const s = setup();
  s.apply([{ op: "group", ids: ["head", "eye", "glint"], newId: "rig" },
    { op: "set", id: "rig", rotation: [12, 0, 0] },
    { op: "attachSurface", id: "eye", targetId: "head", mode: "position" }]);
  let p = s.snapshot();
  const before = p.nodes.find(n => n.id === "eye");
  for (let i = 0; i < 10; i++) p = evaluateProject(JSON.parse(JSON.stringify(p)));
  const after = p.nodes.find(n => n.id === "eye");
  assert.deepEqual(after.rotation, before.rotation);
  assert.deepEqual(after.scale, before.scale);
});

test("rename and complete hierarchy duplication remap targets; partial copies fail explicitly", () => {
  const s = setup();
  s.apply([{ op: "attachSurface", id: "eye", targetId: "head" }]);
  s.apply([{ op: "rename", id: "head", newId: "skull" }]);
  assert.equal(s.snapshot().nodes.find(n => n.id === "eye").attachment.target, "skull");
  assert.throws(() => s.apply([{ op: "duplicate", id: "eye", newId: "copy" }]), /Duplicate the attachment target/);
  s.apply([{ op: "group", ids: ["skull", "eye", "glint"], newId: "character" },
    { op: "duplicate", id: "character", newId: "character_copy", offset: [2, 0, 0] }]);
  const cloned = s.snapshot().nodes.find(n => n.attachment && n.id !== "eye");
  assert.notEqual(cloned.attachment.target, "skull");
  assert.ok(s.snapshot().nodes.some(n => n.id === cloned.attachment.target));
});

test("adding an editable project remaps colliding attachment targets", () => {
  const s = setup();
  s.apply([{ op: "attachSurface", id: "eye", targetId: "head" }]);
  const original = s.snapshot();
  const merged = evaluateProject(mergeProjects(original, original).project);
  const added = merged.nodes.find(n => n.attachment && n.id !== "eye");
  assert.notEqual(added.attachment.target, "head");
  assert.ok(merged.nodes.some(n => n.id === added.attachment.target));
  assert.equal(merged.nodes.find(n => n.id === "eye").attachment.target, "head");
});
