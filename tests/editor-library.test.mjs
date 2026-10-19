import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { openWorkshop } from "../scripts/workshop-node.mjs";
import { normalizeProject } from "../site/editor/document.js";

// The workshop's model library methods (docs/library-api.md) against a stand-in for
// cdn.fun.dev: librarySearch, libraryModel and openLibraryModel, and the sources they record.
const files = new Map();
const server = createServer((request, response) => {
  const body = files.get(new URL(request.url, "http://x").pathname);
  response.writeHead(body ? 200 : 404, { "content-type": "application/octet-stream" });
  response.end(body ?? "");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
process.env.FUNDEV_LIBRARY_ORIGIN = origin;
const session = await openWorkshop({ width: 400, height: 300 });
const api = session.api;
test.after(() => {
  session.dispose();
  server.close();
});

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blob = (name, bytes) => {
  const hash = sha(bytes);
  files.set(`/blobs/${hash}.${name.split(".").pop()}`, bytes);
  return { sha256: hash, size: bytes.length };
};
const stats = { size: [0.4, 1.5, 0.4], min: [-0.2, 0, -0.2], max: [0.2, 1.5, 0.2], triangles: 100, bytes: 1000 };

// Two models made in the workshop: a lamp with its project file, a stool with only a GLB.
api.loadProject(
  { format: "fun.dev/model", version: 1, name: "lamp", materials: [{ id: "wood", name: "wood", color: "#c9a27a", roughness: 0.6 }], nodes: [] },
  { ifRevision: api.inspect().revision },
);
api.apply([
  { op: "create", id: "lamp", kind: "group" },
  { op: "create", id: "lamp_pole", kind: "cylinder", parent: "lamp", material: "wood", position: [0, 0.75, 0], options: { radius: 0.03, height: 1.5 } },
]);
const lampProject = Buffer.from((await api.exportProject()).data, "base64");
const lampGLB = Buffer.from((await api.exportGLB({ encoding: "base64" })).data, "base64");
api.apply([{ op: "delete", id: "lamp" }, { op: "create", id: "stool", kind: "box", material: "wood", position: [0, 0.225, 0], options: { size: [0.35, 0.45, 0.35] } }]);
const stoolGLB = Buffer.from((await api.exportGLB({ encoding: "base64" })).data, "base64");
const lamp = { "model.glb": blob("model.glb", lampGLB), "source.funmodel.glb": blob("source.funmodel.glb", lampProject) };
const stool = { "model.glb": blob("model.glb", stoolGLB) };
const thumbnail = blob("thumbnail.png", Buffer.from("png"));
const row = (id, name, description, tags, kit = "") => [id, name, description, "prop", kit, tags, [0.4, 1.5, 0.4], "v001", thumbnail.sha256];
const index = (rows, kits = {}) =>
  Buffer.from(JSON.stringify({ licence: "CC0-1.0", fields: ["id", "name", "description", "type", "kit", "tags", "size", "version", "thumbnail"], kits, models: rows }));
files.set("/library/index.en.json", index([
  row("test_lamp_01", "Floor lamp", "A tall wooden lamp.", "lighting wood"),
  row("test_stool_01", "Stool", "Sits beside a lamp.", "furniture wood", "home_kit"),
], { home_kit: "Pieces on a 0.5 m grid." }));
files.set("/library/index.zh.json", index([row("test_lamp_01", "落地灯", "高木灯。", "lighting wood"), row("test_stool_01", "凳子", "放在灯旁。", "furniture wood")]));
const page = (id, versionFiles) =>
  Buffer.from(JSON.stringify({ licence: "CC0-1.0", id, name: { zh: id, en: id }, description: { zh: "", en: "" }, type: "prop", kit: null, tags: [], listed: true,
    versions: [{ version: "v001", files: { ...versionFiles, "thumbnail.png": thumbnail }, stats, approved: 1, derived: { sha256: "a".repeat(64), size: 10, converter: "sha256:test", profile: "fundev-library@1" } }] }));
files.set("/library/test_lamp_01.json", page("test_lamp_01", lamp));
files.set("/library/test_stool_01.json", page("test_stool_01", stool));

test("search matches every word, ranks names first and filters", async () => {
  const lamps = await api.librarySearch({ query: "lamp" });
  assert.deepEqual(lamps.models.map((m) => m.id), ["test_lamp_01", "test_stool_01"], "name before description");
  assert.equal(lamps.licence, "CC0-1.0");
  assert.equal(lamps.models[0].thumbnail, `${origin}/blobs/${thumbnail.sha256}.png`);
  assert.equal(lamps.models[0].page, "https://fun.dev/models/test_lamp_01");
  assert.deepEqual(lamps.kits, { home_kit: "Pieces on a 0.5 m grid." });
  assert.equal((await api.librarySearch({ query: "wooden lamp" })).total, 1);
  assert.equal((await api.librarySearch({ tags: ["furniture"] })).models[0].id, "test_stool_01");
  assert.equal((await api.librarySearch({ kit: "home_kit" })).total, 1);
  assert.equal((await api.librarySearch({ query: "lamp", limit: 1, offset: 1 })).models[0].id, "test_stool_01");
  assert.equal((await api.librarySearch({ query: "落地" })).models[0].name, "落地灯", "Chinese queries read the Chinese index");
});

test("a model lists its versions and file addresses", async () => {
  const model = await api.libraryModel({ id: "test_lamp_01" });
  assert.equal(model.versions[0].editable, true);
  assert.equal(model.versions[0].files["source.funmodel.glb"].url, `${origin}/blobs/${lamp["source.funmodel.glb"].sha256}.glb`);
  assert.equal(model.versions[0].derived.url, `${origin}/blobs/${"a".repeat(64)}.fun3d`);
  assert.equal((await api.libraryModel({ id: "test_stool_01" })).versions[0].editable, false);
  await assert.rejects(api.libraryModel({ id: "no_such_model" }), (e) => e.code === "not_found");
});

test("opening records the source, edits keep it, adding appends", async () => {
  const opened = await api.openLibraryModel({ id: "test_lamp_01" }, { ifRevision: api.inspect().revision });
  assert.ok(opened.container, "the project file opens as its project");
  assert.deepEqual(opened.source, { kind: "library", id: "test_lamp_01", version: "v001", file: "source.funmodel.glb", sha256: lamp["source.funmodel.glb"].sha256 });
  assert.ok(api.getProject().nodes.some((n) => n.id === "lamp_pole"));
  api.apply([{ op: "set", id: "lamp_pole", position: [0, 0.8, 0] }]);
  assert.equal(api.getProject().sources.length, 1, "edits keep the sources");
  const added = await api.openLibraryModel({ id: "test_stool_01", mode: "add" }, { ifRevision: api.inspect().revision });
  assert.ok(added.nodes.length > 0 && !added.container);
  assert.deepEqual(api.getProject().sources.map((s) => [s.id, s.file]), [["test_lamp_01", "source.funmodel.glb"], ["test_stool_01", "model.glb"]]);
  api.undo();
  assert.deepEqual(api.getProject().sources.map((s) => s.id), ["test_lamp_01"]);
  const file = await api.exportProject();
  api.importGLB({ data: file.data, mode: "replace" });
  assert.deepEqual(api.getProject().sources.map((s) => s.id), ["test_lamp_01"], "project files keep the sources");
});

test("stale revisions and unknown versions are refused", async () => {
  await assert.rejects(api.openLibraryModel({ id: "test_lamp_01" }, { ifRevision: api.inspect().revision - 1 }), (e) => e.code === "conflict");
  await assert.rejects(api.openLibraryModel({ id: "test_lamp_01", version: "v009" }, { ifRevision: api.inspect().revision }), (e) => e.code === "not_found");
});

test("sources of kinds this version does not know are dropped; broken ones refused", () => {
  const project = { format: "fun.dev/model", version: 1, name: "s", materials: [{ id: "m", name: "m", color: "#ffffff", roughness: 1 }], nodes: [] };
  assert.equal(normalizeProject(project).sources, undefined, "no field without sources");
  assert.deepEqual(normalizeProject({ ...project, sources: [{ kind: "url", href: "https://example.com/a.glb" }] }).sources, undefined);
  assert.throws(() => normalizeProject({ ...project, sources: [{ kind: "library", id: "Bad Id", version: "v001", file: "model.glb", sha256: "0".repeat(64) }] }));
});
