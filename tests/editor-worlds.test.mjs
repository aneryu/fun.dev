import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import * as THREE from "three";
import { openWorkshop } from "../scripts/workshop-node.mjs";
import { createFun3d } from "../site/runtime/kit/fun3d.js";
import { worldData } from "../site/runtime/kit/world.js";
import { decodePNG } from "../scripts/png.mjs";

// Scenes in the workshop (docs/worlds.md, step 1): library models placed by reference,
// markers, zones and paths, the audit, the map, the tile and the one-tile world, against a
// stand-in for cdn.fun.dev.
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
const fun3d = createFun3d({ THREE });

// A lamp made in the workshop (its model.glb) and its runtime file, written from Three.js
// objects the way the library's converter would.
api.loadProject(
  { format: "fun.dev/model", version: 1, name: "lamp", materials: [{ id: "wood", name: "wood", color: "#c9a27a", roughness: 0.6 }], nodes: [] },
  { ifRevision: api.inspect().revision },
);
api.apply([
  { op: "create", id: "lamp", kind: "group" },
  { op: "create", id: "lamp_pole", kind: "cylinder", parent: "lamp", material: "wood", position: [0, 0.75, 0], options: { radius: 0.04, height: 1.5 } },
  { op: "create", id: "lamp_head", kind: "box", parent: "lamp", material: "wood", position: [0, 1.55, 0], options: { size: [0.3, 0.1, 0.3] } },
]);
const lampGLB = Buffer.from((await api.exportGLB({ encoding: "base64", origin: "ground-center" })).data, "base64");
const lampRoot = new THREE.Group();
lampRoot.name = "test_lamp_01";
const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.5, 12).translate(0, 0.75, 0), new THREE.MeshStandardMaterial({ name: "mat_wood", color: "#c9a27a" }));
pole.name = "lamp_pole";
lampRoot.add(pole);
const lampFun3d = Buffer.from(await fun3d.write(lampRoot));
const lamp = { "model.glb": blob("model.glb", lampGLB) };
const lampDerived = blob("model.fun3d", lampFun3d);
const stoolGLB = lampGLB; // a second model without a converted file
const stool = { "model.glb": blob("model.glb", Buffer.concat([stoolGLB, Buffer.from([0])])) };
const thumbnail = blob("thumbnail.png", Buffer.from("png"));
const stats = { size: [0.3, 1.6, 0.3], min: [-0.15, 0, -0.15], max: [0.15, 1.6, 0.15], triangles: 40, bytes: 1000 };
const row = (id, name, description, tags) => [id, name, description, "prop", "", tags, stats.size, "v001", thumbnail.sha256];
const index = (rows) =>
  Buffer.from(JSON.stringify({ licence: "CC0-1.0", fields: ["id", "name", "description", "type", "kit", "tags", "size", "version", "thumbnail"], kits: {}, models: rows }));
files.set("/library/index.en.json", index([row("test_lamp_01", "Floor lamp", "A tall lamp.", "lighting"), row("test_stool_01", "Stool", "A stool.", "furniture")]));
files.set("/library/index.zh.json", files.get("/library/index.en.json"));
const page = (id, versionFiles, derived) =>
  Buffer.from(
    JSON.stringify({
      licence: "CC0-1.0", id, name: { zh: id, en: id === "test_lamp_01" ? "Floor lamp" : "Stool" }, description: { zh: "", en: "" }, type: "prop", kit: null, tags: [], listed: true,
      versions: [{ version: "v001", files: { ...versionFiles, "thumbnail.png": thumbnail }, stats, approved: 1, ...(derived ? { derived: { ...derived, converter: "sha256:test", profile: "fundev-library@1" } } : {}) }],
    }),
  );
files.set("/library/test_lamp_01.json", page("test_lamp_01", lamp, lampDerived));
files.set("/library/test_stool_01.json", page("test_stool_01", stool, null));

const fresh = (name, tile) =>
  api.loadProject(
    { format: "fun.dev/model", version: 1, name, ...(tile ? { tile } : {}), materials: [{ id: "wood", name: "wood", color: "#c9a27a", roughness: 0.6 }], nodes: [] },
    { ifRevision: api.inspect().revision },
  );
const brightness = (dataUrl) => {
  const png = decodePNG(Buffer.from(dataUrl.split(",")[1], "base64"));
  const colours = new Set();
  for (let i = 0; i < png.pixels.length; i += png.channels) colours.add(png.pixels.slice(i, i + 3).join());
  return { png, colours: colours.size };
};

test("places a library model by reference, with its record from the library", async () => {
  fresh("diorama", { size: [10, 10] });
  const placed = await api.place({ model: "test_lamp_01", id: "lamp_1", position: [1, 0, 1], tags: ["lamp"], params: { watts: 60 } }, { ifRevision: api.inspect().revision });
  assert.deepEqual(placed.changed, ["lamp_1"]);
  assert.equal(placed.placed.model, "test_lamp_01@v001");
  assert.deepEqual(placed.warnings, []);
  const node = api.inspect({ id: "lamp_1" });
  assert.equal(node.node.place.model, "test_lamp_01@v001");
  assert.equal(node.node.place.derived, lampDerived.sha256);
  assert.equal(node.node.place.triangles, 40);
  assert.equal(node.node.name, "Floor lamp");
  assert.deepEqual(node.node.tags, ["lamp"]);
  assert.deepEqual(node.bounds.min, [0.85, 0, 0.85]);
  assert.deepEqual(node.bounds.max, [1.15, 1.6, 1.15]);
  // A pinned version, a tint and a variant.
  await api.place({ model: "test_lamp_01@v001", id: "lamp_2", position: [-1, 0, 1], tint: [1, 0.5, 0.5], variants: { style: "tall" } }, { ifRevision: api.inspect().revision });
  assert.deepEqual(api.inspect({ id: "lamp_2" }).node.place.variants, { style: "tall" });
  assert.equal(api.inspect().stats.placed, 2);
  assert.equal(api.inspect().stats.placedTriangles, 80);
  // The geometry is never copied: no mesh, no triangles of its own.
  assert.equal(api.inspect().stats.triangles, 0);
});

test("the viewport draws placed models and the data overlays; ids shading colours placed copies", () => {
  const empty = brightness(api.renderViews(["perspective"], { size: 160, ids: ["lamp_1"], overlays: { data: false } })[0].dataUrl);
  assert.ok(empty.colours > 30, "the placed lamp is drawn from its template");
  const ids = api.renderViews(["perspective"], { size: 160, shading: "ids" })[0];
  assert.ok(ids.observation.nodeColors.lamp_1, "placed copies get an id colour");
  assert.ok(ids.observation.visibleIds.includes("lamp_1"));
});

test("markers, zones and paths: create, set, duplicate, inspect bounds, round trip", async () => {
  api.apply([
    { op: "create", id: "spawn", kind: "marker", position: [-2, 0, -2], tags: ["spawn"], params: { team: 1 } },
    { op: "create", id: "safe", kind: "zone", tags: ["safe"], area: { polygon: [[-3, -3], [3, -3], [3, 0], [-3, 0]], y: [0, 2.5] } },
    { op: "create", id: "box_zone", kind: "zone", position: [2, 1, -2], area: { size: [2, 2, 2] } },
    { op: "create", id: "lap", kind: "path", tags: ["lap"], path: { points: [[-2, 0.1, 2], [2, 0.1, 2], [2, 0.1, -2]], closed: true } },
  ]);
  const state = api.inspect();
  assert.equal(state.stats.markers, 1);
  assert.equal(state.stats.zones, 2);
  assert.equal(state.stats.paths, 1);
  assert.deepEqual(api.inspect({ id: "safe" }).bounds.max, [3, 2.5, 0]);
  assert.deepEqual(api.inspect({ id: "box_zone" }).bounds.min, [1, 0, -3]);
  api.apply([
    { op: "set", id: "spawn", params: { team: 2, facing: "north" }, tags: ["spawn", "blue"] },
    { op: "duplicate", id: "spawn", newId: "spawn_2", offset: [4, 0, 0] },
    { op: "set", id: "lap", path: { points: [[-2, 0.1, 2], [2, 0.1, 2]], closed: false } },
  ]);
  assert.deepEqual(api.inspect({ id: "spawn_2" }).node.params, { team: 2, facing: "north" });
  assert.equal(api.inspect({ id: "lap" }).node.path.closed, false);
  assert.throws(() => api.apply([{ op: "extrude", id: "spawn", distance: 0.1 }]), /set, delete, duplicate and rename/);
  assert.throws(() => api.apply([{ op: "set", id: "spawn", area: { radius: 1 } }]), /belongs to zones/);
  assert.throws(() => api.apply([{ op: "create", id: "x", kind: "place" }]), /resolved record/);
  assert.throws(() => api.apply([{ op: "create", id: "y", kind: "marker", params: { f: "x".repeat(5000) } }]), /4 KB/);
  const project = await api.exportProject();
  api.importGLB({ data: project.data, mode: "replace" });
  const kinds = Object.fromEntries(api.getProject().nodes.map((n) => [n.id, n.place ? "place" : n.marker ? "marker" : n.zone ? "zone" : n.path ? "path" : "mesh"]));
  assert.deepEqual(kinds, { lamp_1: "place", lamp_2: "place", spawn: "marker", safe: "zone", box_zone: "zone", lap: "path", spawn_2: "marker" });
  assert.equal(api.getProject().nodes.find((n) => n.id === "lamp_1").place.sha256, lamp["model.glb"].sha256);
});

test("the audit finds overlaps, floating parts, the tile's edge and unconverted models", async () => {
  await api.place({ model: "test_lamp_01", id: "lamp_3", position: [1.05, 0, 1.05] }, { ifRevision: api.inspect().revision });
  await api.place({ model: "test_lamp_01", id: "lamp_4", position: [3, 0.5, 3] }, { ifRevision: api.inspect().revision });
  await api.place({ model: "test_stool_01", id: "stool_1", position: [6, 0, 0] }, { ifRevision: api.inspect().revision });
  const { findings, counts } = api.audit();
  const codes = Object.fromEntries(findings.map((f) => [f.code, f]));
  assert.deepEqual(codes.overlap.nodes, ["lamp_1", "lamp_3"]);
  assert.equal(codes.floating.node, "lamp_4");
  assert.equal(codes.floating.gap, 0.5);
  assert.equal(codes["out-of-bounds"].node, "stool_1");
  assert.equal(codes["unconverted-model"].node, "stool_1");
  assert.ok(findings.every((f) => f.suggestion));
  assert.equal(counts.errors, 0);
  const tight = api.audit({ budget: { triangles: 100 } });
  assert.ok(tight.findings.some((f) => f.code === "budget" && f.actual === 200));
  api.apply([{ op: "delete", id: "lamp_3" }, { op: "delete", id: "lamp_4" }, { op: "delete", id: "stool_1" }]);
  assert.deepEqual(api.audit().findings, []);
});

test("the map is a top view at a known scale with the overlays", () => {
  const map = api.map({ size: 200 });
  assert.equal(map.width, 200);
  assert.equal(map.view, "top");
  assert.ok(map.metresPerPixel > 0.02 && map.metresPerPixel < 0.1, `metres per pixel ${map.metresPerPixel}`);
  assert.ok(map.bounds.min[0] <= -3 && map.bounds.max[0] >= 3, "the zone bounds the map");
  const { colours } = brightness(map.dataUrl);
  assert.ok(colours > 6, `parts and overlays are drawn (${colours} colours)`);
  const plain = brightness(api.map({ size: 200, overlays: { data: false } }).dataUrl);
  assert.ok(plain.colours < colours, "without the data overlays the map has fewer colours");
});

test("a tile carries references, markers with parameters, zones and paths; the runtime loads it", async () => {
  const tile = await api.exportTile({ encoding: "buffer" });
  assert.deepEqual(await fun3d.validate(tile), []);
  const exported = await api.exportTile();
  assert.equal(exported.filename, "diorama.fun3d");
  assert.equal(exported.report.refs, 1);
  assert.equal(exported.report.placed, 2);
  assert.equal(exported.report.zones, 2);
  assert.equal(exported.report.paths, 1);
  await assert.rejects(fun3d.load(tile), /resolve/);
  const loads = [];
  const model = await fun3d.load(tile, {
    resolve: async (ref) => {
      loads.push(ref);
      return fun3d.load(lampFun3d);
    },
  });
  assert.deepEqual(loads, ["test_lamp_01@v001"]);
  assert.equal(model.refs.size, 1);
  const copy = model.node("lamp_1");
  assert.ok(copy.children.some((c) => c.userData.nested && c.getObjectByName("lamp_pole")), "the placed model's objects hang under its node");
  assert.deepEqual(model.node("lamp_2").userData.model.tint, [1, 0.5, 0.5]);
  assert.deepEqual(model.node("lamp_2").userData.model.variants, { style: "tall" });
  assert.deepEqual(model.node("lamp_1").userData.params, { watts: 60 });
  const data = worldData(model);
  assert.deepEqual(data.markers("spawn").map((m) => [m.id, m.params.team, m.position]), [["spawn", 2, [-2, 0, -2]], ["spawn_2", 2, [2, 0, -2]]]);
  assert.deepEqual(data.markers("lamp").map((m) => m.id), ["lamp_1"]);
  assert.ok(data.zone("safe").contains([0, 1, -1]) && !data.zone("safe").contains([0, 1, 1]) && !data.zone("safe").contains([0, 3, -1]));
  assert.ok(data.zone("box_zone").contains([2.5, 1.5, -2.5]) && !data.zone("box_zone").contains([3.5, 1, -2]));
  assert.deepEqual(data.zonesAt([2, 1, -2]).map((z) => z.id), ["safe", "box_zone"]);
  const lap = data.path("lap");
  assert.equal(lap.closed, false);
  assert.ok(Math.abs(lap.length - 4) < 1e-6);
  assert.deepEqual(lap.at(0.5).position.map((v) => Math.round(v * 100) / 100), [0, 0.1, 2]);
  assert.ok(Math.abs(lap.nearest([0, 0.1, 3]).distance - 1) < 1e-6);
  assert.deepEqual(data.tile.size, [10, 10]);
  // The project rides along in the editing section.
  const { edit } = await fun3d.read(tile, { editing: true });
  assert.equal(edit.document.nodes.length, api.getProject().nodes.length);
});

test("a one-tile world bundles the manifest, the tile and the models' runtime files", async () => {
  const world = await api.exportWorld({ name: "Diorama" });
  assert.equal(world.manifest.format, "fun.dev/world");
  assert.equal(world.manifest.id, "diorama");
  assert.deepEqual(world.manifest.tile.size, [10, 10]);
  assert.equal(world.manifest.tiles.length, 1);
  assert.deepEqual(world.files.map((f) => f.path), ["world.json", "tiles/0_0.fun3d", "models/test_lamp_01@v001.fun3d"]);
  assert.equal(world.manifest.models["test_lamp_01@v001"].sha256, lampDerived.sha256);
  assert.equal(sha(Buffer.from(world.files[2].data, "base64")), lampDerived.sha256);
  assert.equal(sha(Buffer.from(world.files[1].data, "base64")), world.manifest.tiles[0].sha256);
  await api.place({ model: "test_stool_01", id: "stool_2" }, { ifRevision: api.inspect().revision });
  await assert.rejects(api.exportWorld(), /No \.fun3d yet for test_stool_01@v001/);
  api.apply([{ op: "delete", id: "stool_2" }]);
});

test("unknown models and stale revisions are refused", async () => {
  await assert.rejects(api.place({ model: "no_such_model", id: "x" }), /not in the model library/);
  await assert.rejects(api.place({ model: "test_lamp_01", id: "x" }, { ifRevision: 1 }), /Project changed/);
  await assert.rejects(api.place({ model: "test_lamp_01@v009", id: "x" }), /no version v009/);
});
