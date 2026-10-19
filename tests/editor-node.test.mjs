import test from "node:test";
import assert from "node:assert/strict";
import { openWorkshop } from "../scripts/workshop-node.mjs";
import { decodePNG } from "../scripts/png.mjs";
import { parseModelFile } from "../site/workshop/glb.js";

// The workshop in Node (scripts/workshop-node.mjs): the page's agent API over the same store,
// drafts and viewport, drawn by the software renderer.
const session = await openWorkshop({ width: 800, height: 600 });
const api = session.api;
test.after(() => session.dispose());

test("opens with the example duck and the software renderer", () => {
  const state = api.inspect();
  assert.equal(state.renderer.backend, "software");
  assert.ok(state.nodes.length > 3, "the duck's parts");
  assert.equal(state.persistence.backend, "memory");
});

test('observation sampling survives the old megapixel boundary, with explicit settings and atomic restoration', () => {
  const before = api.getProject(), revision = api.inspect().revision;
  const options = { helpers: false, shadows: false, lighting: 'studio' };
  const small = api.renderViews(['perspective'], { ...options, size: 1024 })[0];
  const large = api.renderViews(['perspective'], { ...options, size: 1056 })[0];
  for (const shot of [small, large]) {
    assert.equal(shot.quality.supersamplesPerPixel, 4);
    assert.equal(shot.quality.backend, 'software');
    assert.equal(decodePNG(Buffer.from(shot.dataUrl.split(',')[1], 'base64')).width, shot.width);
  }
  assert.deepEqual(small.quality.lightingSetup, large.quality.lightingSetup);
  const standard = api.renderViews(['perspective'], { size: 128 })[0];
  assert.notEqual(api.renderViews(['perspective'], { size: 128, shadows: false })[0].dataUrl, standard.dataUrl);
  const native = api.renderViews(['perspective'], { size: 128, antialias: 'native', shadows: false, exposure: 2 })[0];
  assert.equal(native.quality.supersamplesPerPixel, 1);
  assert.notEqual(native.dataUrl, standard.dataUrl);
  const high = api.renderViews(['perspective'], { size: 128, antialias: 'ssaa4' })[0];
  assert.equal(high.quality.supersamplesPerPixel, 16);
  assert.throws(() => api.renderViews(['front'], { size: 2048, antialias: 'ssaa4' }), /samples/);
  assert.throws(() => api.renderViews(['front'], { exposure: 0 }), /Exposure/);
  assert.throws(() => api.renderViews(['front'], { antialias: 'toString' }), /Antialias/);
  assert.throws(() => api.renderViews(['front'], { shadows: false, exposure: 2, camera: { position: [0,0,0], target: [0,0,0] } }), /Degenerate/);
  assert.equal(api.renderViews(['perspective'], { size: 128 })[0].dataUrl, standard.dataUrl);
  assert.equal(api.inspect().revision, revision);
  assert.deepEqual(api.getProject(), before);
});

test("builds, observes, exports and imports like the page", async () => {
  api.loadProject(
    { format: "fun.dev/model", version: 1, name: "node", materials: [{ id: "wood", name: "wood", color: "#c9a27a", roughness: 0.6 }], nodes: [] },
    { ifRevision: api.inspect().revision },
  );
  const applied = api.apply([
    { op: "create", id: "post", kind: "group" },
    { op: "create", id: "pole", kind: "cylinder", parent: "post", material: "wood", position: [0, 0.5, 0], options: { radius: 0.05, height: 1, segments: "auto" }, smooth: true },
    { op: "create", id: "ring", kind: "torus", parent: "post", material: "wood", position: [0, 1, 0], options: { radius: 0.2, tube: 0.03 } },
  ]);
  assert.deepEqual(applied.changed.sort(), ["pole", "post", "ring"]);
  const [shot] = api.renderViews(["perspective"], { size: 128 });
  const png = decodePNG(Buffer.from(shot.dataUrl.split(",")[1], "base64"));
  assert.equal(png.width, 128);
  const colours = new Set();
  for (let i = 0; i < png.pixels.length; i += png.channels) colours.add(png.pixels.slice(i, i + 3).join());
  assert.ok(colours.size > 20, "a picture, not a blank");
  const glb = await api.exportGLB({ encoding: "base64", origin: "ground-center", rootName: "post_ROOT", mergeStatic: "auto" });
  const { json } = parseModelFile(new Uint8Array(Buffer.from(glb.data, "base64")));
  assert.ok(json.nodes.some((n) => n.name === "post_ROOT"));
  const project = await api.exportProject();
  const before = api.getProject();
  const imported = api.importGLB({ data: project.data, mode: "replace" });
  assert.ok(imported.container, "a project file opens as its project");
  assert.deepEqual(api.getProject().nodes.map((n) => n.id), before.nodes.map((n) => n.id));
});

test("undo, checkpoints, selection and the session record", () => {
  const revision = api.inspect().revision;
  api.apply([{ op: "set", id: "ring", position: [0, 1.1, 0] }]);
  api.undo();
  assert.deepEqual(api.inspect({ id: "ring" }).node.position, [0, 1, 0]);
  assert.ok(api.inspect().revision > revision);
  const checkpoint = api.checkpoint({ name: "before paint" });
  assert.equal(api.checkpoints().length, 1);
  api.apply([{ op: "delete", id: "ring" }]);
  api.restoreCheckpoint(checkpoint.id);
  assert.ok(api.getProject().nodes.some((n) => n.id === "ring"));
  assert.equal(api.select("pole").id, "pole");
  const record = api.getSession();
  assert.equal(record.revision, api.inspect().revision);
  assert.ok(record.activity.length > 0 && record.checkpoints.length === 1);
});

test("sessions reopen where they were left", async () => {
  const record = api.getSession(),
    again = await openWorkshop({ record, width: 400, height: 300 });
  try {
    assert.deepEqual(again.api.getProject(), api.getProject());
    assert.equal(again.api.inspect().revision, record.revision);
    assert.equal(again.api.checkpoints().length, 1);
  } finally {
    again.dispose();
  }
});

test("re-exporting a library model's merged parts keeps their names", async () => {
  api.loadProject(
    {
      format: "fun.dev/model",
      version: 1,
      name: "fruit",
      materials: [{ id: "wood", name: "wood", color: "#c9a27a", roughness: 0.6 }, { id: "leaf", name: "leaf", color: "#3a7a3a", roughness: 0.6 }],
      nodes: [],
    },
    { ifRevision: api.inspect().revision },
  );
  api.apply([
    { op: "create", id: "fruit", kind: "group" },
    { op: "create", id: "static__wood", kind: "sphere", parent: "fruit", material: "wood", options: { radius: 0.1 } },
    { op: "create", id: "static__leaf", kind: "box", parent: "fruit", material: "leaf", position: [0, 0.12, 0], options: { size: [0.02, 0.04, 0.02] } },
  ]);
  const glb = await api.exportGLB({ encoding: "base64", rootName: "fruit_ROOT", mergeStatic: "auto" });
  const { json } = parseModelFile(new Uint8Array(Buffer.from(glb.data, "base64")));
  assert.deepEqual(json.nodes.map((n) => n.name).filter((n) => n.startsWith("static__")).sort(), ["static__leaf", "static__wood"]);
});
