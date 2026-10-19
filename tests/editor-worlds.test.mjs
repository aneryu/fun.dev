import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import * as THREE from "three";
import { openWorkshop } from "../scripts/workshop-node.mjs";
import { createFun3d } from "../site/runtime/kit/fun3d.js";
import { worldData, createWorld } from "../site/runtime/kit/world.js";
import { createModels } from "../site/runtime/kit/models.js";
import { decodePNG } from "../scripts/png.mjs";
import { heightAt } from "../site/runtime/kit/terrain.js";

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
  // One tile, no far file (nothing 8 m across), the data file, the source, the model.
  assert.deepEqual(world.files.map((f) => f.path), ["world.json", "tiles/0_0.fun3d", "world.fun3d", "world.funmodel.glb", "models/test_lamp_01@v001.fun3d"]);
  assert.equal(world.manifest.models["test_lamp_01@v001"].sha256, lampDerived.sha256);
  assert.equal(sha(Buffer.from(world.files[4].data, "base64")), lampDerived.sha256);
  assert.equal(sha(Buffer.from(world.files[1].data, "base64")), world.manifest.tiles[0].sha256);
  assert.equal(sha(Buffer.from(world.files[2].data, "base64")), world.manifest.data.sha256);
  assert.deepEqual(world.manifest.tiles[0].far, undefined);
  const tile00 = await fun3d.load(Buffer.from(world.files[1].data, "base64"), { resolve: () => fun3d.load(lampFun3d) });
  assert.deepEqual(tile00.extensions["fun3d.tile"], { world: "diorama", x: 0, z: 0, bounds: tile00.extensions["fun3d.tile"].bounds, size: [10, 10] });
  assert.equal(tile00.extensions["fun3d.zones"], undefined, "zones are the data file's");
  assert.equal(worldData(tile00).markers("spawn").length, 0, "pure markers are the data file's");
  const data00 = worldData(await fun3d.load(Buffer.from(world.files[2].data, "base64")));
  assert.equal(data00.markers("spawn").length, 2);
  assert.ok(data00.zone("safe") && data00.path("lap"));
  await api.place({ model: "test_stool_01", id: "stool_2" }, { ifRevision: api.inspect().revision });
  await assert.rejects(api.exportWorld(), /No \.fun3d yet for test_stool_01@v001/);
  api.apply([{ op: "delete", id: "stool_2" }]);
});

test("scatter rules derive many copies of a placed model, go stale, and leave with their rule", async () => {
  fresh("avenue", { size: [60, 30] });
  api.apply([
    { op: "create", id: "road", kind: "path", tags: ["road"], path: { points: [[-25, 0, 0], [25, 0, 0]] } },
    { op: "create", id: "verge", kind: "zone", area: { polygon: [[-25, 3], [25, 3], [25, 12], [-25, 12]], y: [0, 3] } },
    { op: "create", id: "kiosk", kind: "box", material: "wood", position: [0, 1, 7], options: { size: [4, 2, 4] } },
  ]);
  const lamps = { id: "lamps", kind: "scatter", target: "lamp_row", tags: ["lamp"], on: { path: "road", spacing: 10, offset: 2, sides: "both" }, candidates: [{ model: "test_lamp_01" }] };
  const bushes = { id: "bushes", kind: "scatter", seed: "spring", parent: null, on: { zone: "verge", spacing: 2, jitter: 0.5, margin: 0.5 }, yaw: "random", scale: [0.9, 1.1], avoid: [{ nodes: ["kiosk"] }], candidates: [{ model: "test_lamp_01", weight: 1, tints: [[1, 0.8, 0.8], [0.8, 1, 0.8]] }] };
  const added = api.apply([{ op: "rule", definition: lamps }, { op: "rule", definition: bushes }]);
  assert.equal(api.inspect().rules.length, 2);
  assert.deepEqual(api.inspect().rules[0].on, { path: "road", spacing: 10, offset: 2, sides: "both", start: 0, end: null, jitter: 0 });
  assert.deepEqual(api.audit().findings.map((f) => f.code), ["underived-rule", "underived-rule"]);
  const derived = await api.derive({}, { ifRevision: added.revision });
  assert.deepEqual(derived.derived.map((d) => [d.rule, d.nodes, d.copies]), [["lamps", ["lamp_row"], 12], ["bushes", ["bushes"], derived.derived[1].copies]]);
  assert.ok(derived.derived[1].copies > 40, `bushes fill the verge (${derived.derived[1].copies})`);
  const row = api.inspect({ id: "lamp_row" });
  assert.equal(row.node.copies.length, 12);
  assert.deepEqual(row.node.copies[0], [-25, 0, 2, 0, 90, 0, 1]);
  assert.deepEqual(row.node.tags, ["lamp"]);
  assert.equal(row.node.derived.rule, "lamps");
  assert.deepEqual(row.bounds.min.map((v) => Math.round(v * 100) / 100), [-25.15, 0, -2.15]);
  const bushNode = api.inspect({ id: "bushes" }).node;
  assert.equal(bushNode.tints.length, bushNode.copies.length);
  assert.ok(bushNode.copies.every(([x, , z]) => !(x >= -2 && x <= 2 && z >= 5 && z <= 9)), "no bush in the kiosk's footprint");
  assert.ok(bushNode.copies.some(([x, , z]) => Math.abs(x) < 4 && z > 4 && z < 10), "bushes do stand around the kiosk");
  assert.equal(api.inspect().stats.copies, 12 + bushNode.copies.length);
  assert.equal(api.inspect().stats.placedTriangles, 40 * (12 + bushNode.copies.length));
  assert.deepEqual(api.audit().findings.filter((f) => /rule/.test(f.code)), [], "derived rules are current");
  // Copies draw instanced; ids shading colours them; the map covers them.
  const shot = api.renderViews(["perspective"], { size: 160, shading: "ids" })[0];
  assert.ok(shot.observation.nodeColors.lamp_row && shot.observation.nodeColors.bushes);
  assert.ok(brightness(api.map({ size: 160 }).dataUrl).colours > 6);
  // The rule goes stale when its path moves, and current again after deriving.
  api.apply([{ op: "set", id: "road", path: { points: [[-25, 0, 1], [25, 0, 1]] } }]);
  assert.deepEqual(api.audit().findings.filter((f) => /rule/.test(f.code)).map((f) => f.rule), ["lamps"]);
  await api.derive({ id: "lamps" }, { ifRevision: api.inspect().revision });
  assert.deepEqual(api.inspect({ id: "lamp_row" }).node.copies[0], [-25, 0, 3, 0, 90, 0, 1]);
  assert.deepEqual(api.audit().findings.filter((f) => /rule/.test(f.code)), []);
  // A copy made by hand leaves the rule; removing the rule removes what it derived.
  api.apply([{ op: "duplicate", id: "lamp_row", newId: "lamp_row_b", offset: [0, 0, 20] }]);
  assert.equal(api.inspect({ id: "lamp_row_b" }).node.derived, undefined);
  api.apply([{ op: "removeRule", id: "bushes" }]);
  assert.equal(api.inspect().rules.length, 1);
  assert.ok(!api.getProject().nodes.some((n) => n.id === "bushes"));
  assert.throws(() => api.apply([{ op: "rule", definition: { id: "x", kind: "scatter", on: { path: "road", zone: "verge" }, candidates: [{ model: "a" }] } }]), /one of path, zone or grid/);
  // A grid rule: its spacing may sit on the grid itself.
  api.apply([{ op: "rule", definition: { id: "tiles", kind: "scatter", target: "tiles", on: { grid: { cells: [4, 2], spacing: 6, origin: [0, 0, 20] } }, yaw: 0, candidates: [{ model: "test_lamp_01" }] } }]);
  await api.derive({ id: "tiles" }, { ifRevision: api.inspect().revision });
  const tiles = api.inspect({ id: "tiles" }).node.copies;
  assert.equal(tiles.length, 8);
  assert.deepEqual(tiles[0], [-9, 0, 17, 0, 0, 0, 1]);
  assert.deepEqual(tiles.at(-1), [9, 0, 23, 0, 0, 0, 1]);
  await assert.rejects(api.derive({ id: "nope" }), /Unknown rule/);
  // The tile carries the copies as placements; the runtime instances them and knows each lamp.
  const tile = await api.exportTile({ encoding: "buffer" });
  assert.deepEqual(await fun3d.validate(tile), []);
  const model = await fun3d.load(tile, { resolve: () => fun3d.load(lampFun3d) });
  const rowNode = model.node("lamp_row");
  assert.ok(rowNode.children.some((c) => c.isInstancedMesh && c.count === 12), "an instanced mesh per part of the lamp");
  assert.equal(model.placements.get("lamp_row").count, 12);
  const data = worldData(model);
  assert.equal(data.markers("lamp").length, 12 + 12, "every copy of both rows is a marker");
  assert.deepEqual(data.markers("lamp")[0].position.map((v) => Math.round(v * 100) / 100), [-25, 0, 3]);
  const project = await api.exportProject();
  api.importGLB({ data: project.data, mode: "replace" });
  assert.equal(api.inspect().rules.length, 2, "rules ride in the project file");
  assert.equal(api.inspect({ id: "lamp_row" }).node.copies.length, 12);
});

test("sockets on parts: set, snap, GLB round trip; placed models bring the library's sockets", async () => {
  fresh("sockets");
  api.apply([
    { op: "create", id: "block_a", kind: "box", material: "wood", position: [0, 0.5, 0], options: { size: [2, 1, 1] }, sockets: { e: { position: [1, 0, 0], rotation: [0, 90, 0], tags: ["joint"] } } },
    { op: "create", id: "block_b", kind: "box", material: "wood", position: [5, 0.5, 5], options: { size: [2, 1, 1] } },
    { op: "socket", id: "block_b", socket: "w", position: [-1, 0, 0], rotation: [0, -90, 0], tags: ["joint"] },
    { op: "snap", id: "block_b", socket: "w", target: { id: "block_a", socket: "e" } },
  ]);
  assert.deepEqual(api.inspect({ id: "block_b" }).node.position, [2, 0.5, 0], "block_b's west socket meets block_a's east socket");
  assert.deepEqual(api.inspect({ id: "block_b" }).node.sockets.w.tags, ["joint"]);
  api.apply([{ op: "set", id: "block_b", rotation: [0, 0, 0], position: [0, 0, 0] }, { op: "set", id: "block_b", scale: [2, 2, 2] }, { op: "snap", id: "block_b", socket: "w", target: { id: "block_a", socket: "e" } }]);
  assert.deepEqual(api.inspect({ id: "block_b" }).node.position.map((v) => Math.round(v * 1000) / 1000), [3, 0.5, 0], "a scaled part snaps by its scaled socket");
  assert.throws(() => api.apply([{ op: "snap", id: "block_b", socket: "nope", target: { id: "block_a", socket: "e" } }]), /no socket nope/);
  api.apply([{ op: "removeSocket", id: "block_b", socket: "w" }]);
  assert.equal(api.inspect({ id: "block_b" }).node.sockets, undefined);
  // The GLB carries sockets as socket_<name> empties with their tags, and reads them back.
  const glb = await api.exportGLB({ encoding: "base64" });
  const bytes = new Uint8Array(Buffer.from(glb.data, "base64"));
  const { json } = (await import("../site/workshop/glb.js")).parseModelFile(bytes);
  const empty = json.nodes.find((n) => n.name === "socket_e");
  assert.ok(empty && empty.mesh === undefined, "an empty per socket");
  assert.deepEqual(empty.extras?.tags, ["joint"]);
  api.importGLB({ data: glb.data, mode: "replace" });
  const back = api.inspect({ id: "block_a" }).node;
  assert.deepEqual(back.sockets.e.position, [1, 0, 0]);
  assert.deepEqual(back.sockets.e.rotation.map((v) => Math.round(v)), [0, 90, 0]);
  assert.deepEqual(back.sockets.e.tags, ["joint"]);
  assert.ok(!api.getProject().nodes.some((n) => /^socket_/.test(n.id)), "socket empties are not parts");
  // A library model with sockets places them on the record; a tile keeps authored sockets.
  const tile = await api.exportTile({ encoding: "buffer" });
  const model = await fun3d.load(tile);
  assert.deepEqual(Object.keys(model.node("block_a").userData.sockets), ["e"]);
});

test("an assembly rule grows a kit inside a zone from the library's pieces", async () => {
  fresh("kit", { size: [40, 40] });
  api.apply([{ op: "create", id: "lot", kind: "zone", area: { polygon: [[-9, -9], [9, -9], [9, 9], [-9, 9]], y: [0, 3] } }]);
  // The stand-in lamp stands in for 3 × 3 m tiles: a cross, a straight and an end cap.
  const tile = (sides, extra = {}) => ({ model: "test_lamp_01", sockets: sides, ...extra });
  api.apply([
    {
      op: "rule",
      definition: {
        id: "roads", kind: "assemble", seed: 3, target: "roads", tags: ["road"], bounds: "lot", count: 20,
        pieces: [tile({ n: "road", s: "road", e: "road", w: "road" }, { start: true }), tile({ n: "road", s: "road" }, { weight: 3 }), tile({ n: "road" }, { closer: true })],
      },
    },
  ]);
  const derived = await api.derive({ id: "roads" }, { ifRevision: api.inspect().revision });
  const result = derived.derived[0];
  // Growth stops at count; closers cap what stays open after that.
  assert.ok(result.copies >= 6 && result.copies <= 20 + 16, `pieces placed: ${result.copies}`);
  assert.ok(result.assembly.placed === result.copies && result.assembly.open <= 4, JSON.stringify(result.assembly));
  const parts = api.getProject().nodes.filter((n) => n.derived?.rule === "roads");
  assert.ok(parts.length >= 2 && parts.every((n) => n.copies.length), "one part per piece model that was used");
  const all = parts.flatMap((n) => n.copies);
  // The lamp record is 0.3 m wide: pieces mate edge to edge at 0.3 m steps, never overlapping.
  const cells = new Set(all.map(([x, , z]) => `${Math.round(x * 100)},${Math.round(z * 100)}`));
  assert.equal(cells.size, all.length);
  assert.ok(all.every(([x, , z]) => Math.abs(x) < 9 && Math.abs(z) < 9), "inside the lot");
  assert.deepEqual(api.audit().findings.filter((f) => /rule/.test(f.code)), []);
  assert.throws(() => api.apply([{ op: "rule", definition: { id: "bad", kind: "assemble", pieces: [{ model: "test_lamp_01", sockets: { x: "road" } }] } }]), /side shorthand/);
});

test("a rule with bake false rides in the tile and runs in the game with the tile's data", async () => {
  fresh("floor", { size: [20, 20] });
  api.apply([
    { op: "create", id: "lot", kind: "zone", area: { polygon: [[-6, -6], [6, -6], [6, 6], [-6, 6]], y: [0, 3] } },
    { op: "create", id: "lane", kind: "path", path: { points: [[-6, 0, 0], [6, 0, 0]] } },
    { op: "create", id: "kiosk", kind: "box", material: "wood", position: [3, 1, 3], options: { size: [2, 2, 2] } },
    { op: "rule", definition: { id: "props", kind: "scatter", bake: false, seed: 4, on: { zone: "lot", spacing: 2, jitter: 0.3 }, avoid: [{ path: "lane", width: 2 }, { nodes: ["kiosk"] }], candidates: [{ model: "test_lamp_01" }] } },
    { op: "rule", definition: { id: "tiles", kind: "assemble", bake: false, seed: 1, bounds: "lot", count: 12, pieces: [{ model: "test_lamp_01", sockets: { n: "a", s: "a", e: "a", w: "a" }, start: true }, { model: "test_lamp_01", sockets: { n: "a", s: "a" }, weight: 3 }] } },
    { op: "rule", definition: { id: "baked", kind: "scatter", on: { path: "lane", spacing: 3 }, candidates: [{ model: "test_lamp_01" }] } },
  ]);
  const derived = await api.derive({}, { ifRevision: api.inspect().revision });
  assert.deepEqual(derived.derived.map((d) => d.rule), ["baked"], "runtime rules are not baked");
  await assert.rejects(api.derive({ id: "props" }), /bake: false/);
  assert.deepEqual(api.audit().findings.filter((f) => /rule/.test(f.code)), [], "runtime rules are never stale");
  const exported = await api.exportTile();
  assert.equal(exported.report.rules, 2);
  const tile = await api.exportTile({ encoding: "buffer" });
  assert.deepEqual(await fun3d.validate(tile), []);
  const model = await fun3d.load(tile, { resolve: () => fun3d.load(lampFun3d) });
  const carried = model.extensions["fun3d.rules"];
  assert.deepEqual(carried.map((r) => r.id), ["props", "tiles"]);
  assert.equal(carried[0].candidates[0].model, "test_lamp_01@v001", "models are pinned");
  assert.equal(carried[0].avoid.boxes.length, 1, "keep-outs by solids become boxes");
  assert.ok(carried[1].pieces[0].sockets.n.position, "pieces carry their socket frames");
  const data = worldData(model);
  assert.deepEqual(data.rules().map((r) => [r.id, r.kind]), [["props", "scatter"], ["tiles", "assemble"]]);
  const props = data.run("props");
  assert.ok(props.placed[0].rows.length > 8, `rows at play time: ${props.placed[0].rows.length}`);
  assert.ok(props.placed[0].rows.every(([x, , z]) => Math.abs(z) > 1 && !(x >= 2 && x <= 4 && z >= 2 && z <= 4)), "off the lane and the kiosk");
  assert.deepEqual(data.run("props").placed, props.placed, "the rule's seed makes the same rows");
  assert.notDeepEqual(data.run("props", { seed: 9 }).placed, props.placed, "another seed, other rows");
  const tiles = data.run("tiles", { seed: 2 });
  assert.ok(tiles.placed.reduce((n, p) => n + p.rows.length, 0) >= 6 && tiles.placed.reduce((n, p) => n + p.rows.length, 0) <= 12, JSON.stringify(tiles.placed.map((p) => p.rows.length)));
  assert.ok(tiles.placed.every((p) => p.rows.every(([x, , z]) => Math.abs(x) < 6 && Math.abs(z) < 6)), "inside the lot");
  assert.throws(() => data.run("nope"), /no rule nope/);
  const world = await api.exportWorld({ name: "Floor" });
  assert.deepEqual(world.manifest.rules, { runtime: ["props", "tiles"] });
});

test("a terrain is shaped by ops, classified into surfaces, scattered on, audited against and exported with its field", async () => {
  fresh("hill", { size: [40, 40] });
  api.apply([
    { op: "create", id: "ground", kind: "terrain", position: [-16, 0, -16], terrain: { cell: 2, samples: [17, 17], surfaceTable: [{ id: "sand", color: "#d9c58a" }, { id: "grass", color: "#6b8f3a" }, { id: "rock", color: "#7a746c" }] } },
    { op: "create", id: "track", kind: "path", path: { points: [[-16, 1, 0], [16, 1, 0]] } },
    { op: "create", id: "pad", kind: "zone", area: { polygon: [[6, 6], [14, 6], [14, 14], [6, 14]], y: [0, 10] } },
    { op: "create", id: "all", kind: "zone", area: { polygon: [[-16, -16], [16, -16], [16, 16], [-16, 16]], y: [-5, 30] } },
    { op: "terrain", id: "ground", seed: 3, ops: [{ noise: { amplitude: 4, scale: 12 } }, { stamp: { shape: "circle", center: [-6, -6], radius: 4, height: 6, falloff: 3 } }, { flatten: { path: "track", width: 4, blend: 2 } }, { level: { zone: "pad", height: 2.5, blend: 1 } }],
      surfaces: [{ surface: "sand", height: [-100, 0.5] }, { surface: "grass", height: [0.5, 100] }, { surface: "rock", slope: [35, 90] }], water: { level: -0.5 } },
  ]);
  assert.throws(() => api.apply([{ op: "set", id: "ground", rotation: [0, 45, 0] }]), /never rotated/);
  const ground = api.inspect({ id: "ground" });
  const t = ground.node.terrain;
  assert.equal(t.heights.length, 289);
  assert.ok(t.heights.slice(8 * 17 + 2, 8 * 17 + 15).every((h) => Math.abs(h - 1) < 1e-6), "the track's row is flat at the path's height");
  assert.ok(Math.abs(t.heights[13 * 17 + 13] - 2.5) < 1e-6, "the pad is levelled");
  assert.ok(t.heights[5 * 17 + 5] > 4, "the hill stands");
  assert.equal(t.surfaces.length, 256);
  assert.ok(new Set(t.surfaces).size >= 2, "more than one surface");
  assert.equal(t.ops.length, 4);
  assert.deepEqual(ground.bounds.min.slice(0, 1), [-16]);
  assert.equal(api.inspect().stats.terrainTriangles, 512);
  // Scatter on the ground, grass only; a box on the hill floats; a box on the pad rests.
  api.apply([
    { op: "rule", definition: { id: "shrubs", kind: "scatter", seed: 1, on: { zone: "all", spacing: 2, jitter: 0.3 }, ground: true, where: { surfaces: ["grass"] }, candidates: [{ model: "test_lamp_01" }] } },
    { op: "create", id: "hut", kind: "box", material: "wood", position: [10, 3, 10], options: { size: [2, 1, 2] } },
    { op: "create", id: "balloon", kind: "box", material: "wood", position: [-6, 12, -6], options: { size: [1, 1, 1] } },
  ]);
  await api.derive({}, { ifRevision: api.inspect().revision });
  const shrubs = api.inspect({ id: "shrubs" }).node;
  assert.ok(shrubs.copies.length > 20, `shrubs on the grass: ${shrubs.copies.length}`);
  for (const [x, y, z] of shrubs.copies.slice(0, 10)) {
    const i = Math.round((x + 16) / 2), k = Math.round((z + 16) / 2);
    assert.ok(Math.abs(y - t.heights[k * 17 + i]) < 2.5, `a shrub at ${x}, ${z} sits near the field (${y})`);
  }
  const findings = api.audit().findings;
  assert.ok(findings.some((f) => f.code === "floating" && f.node === "balloon"), JSON.stringify(findings));
  assert.ok(!findings.some((f) => f.node === "hut" || f.node === "ground"), "the hut rests on the pad, the terrain is the ground");
  // The tile: a mesh, the field as data, a static body; the runtime answers heights.
  const tile = await api.exportTile({ encoding: "buffer" });
  assert.deepEqual(await fun3d.validate(tile), []);
  const model = await fun3d.load(tile, { resolve: () => fun3d.load(lampFun3d) });
  assert.ok(model.node("ground").userData.mesh?.isMesh, "the terrain mesh is the node's own");
  assert.equal(model.manifest.physics.bodies[0].node, "ground");
  assert.equal(model.manifest.physics.shapes[0].type, "mesh");
  const data = worldData(model);
  assert.equal(data.terrains().length, 1);
  assert.ok(Math.abs(data.height(0, 0) - 1) < 1e-5, `the road height at the origin: ${data.height(0, 0)}`);
  assert.ok(Math.abs(data.height(10, 10) - 2.5) < 1e-5, "the pad's height");
  assert.equal(data.height(100, 100), null);
  assert.equal(data.surface(10, 10).id, "grass");
  const runtime = model.extensions["fun3d.terrain"][0];
  assert.deepEqual(runtime.origin, [-16, 0, -16]);
  assert.equal(runtime.water[0].level, -0.5);
  // A runtime rule on the ground gets the tile's heights.
  api.apply([{ op: "rule", definition: { id: "live", kind: "scatter", bake: false, seed: 5, on: { zone: "all", spacing: 3 }, ground: true, where: { surfaces: ["grass"] }, candidates: [{ model: "test_lamp_01" }] } }]);
  const live = worldData(await fun3d.load(await api.exportTile({ encoding: "buffer" }), { resolve: () => fun3d.load(lampFun3d) })).run("live");
  assert.ok(live.placed[0].rows.length > 10);
  assert.ok(live.placed[0].rows.every(([x, y, z]) => Math.abs(y - data.height(x, z)) < 1e-5), "rows sit on the terrain");
});

test("unknown models and stale revisions are refused", async () => {
  await assert.rejects(api.place({ model: "no_such_model", id: "x" }), /not in the model library/);
  await assert.rejects(api.place({ model: "test_lamp_01", id: "x" }, { ifRevision: 1 }), /Project changed/);
  await assert.rejects(api.place({ model: "test_lamp_01@v009", id: "x" }), /no version v009/);
});

test("a world of several tiles: cut by tile.size, terrain split at its cells, copies by row, data in world.fun3d, far files, streamed back", async () => {
  fresh("valley", { size: [20, 20], span: [3, 3] });
  api.apply([
    { op: "create", id: "ground", kind: "terrain", position: [-30, 0, -30], tags: ["ground"], terrain: { cell: 2, samples: [31, 31], surfaceTable: [{ id: "grass", color: "#6b8f3a" }, { id: "rock", color: "#7a746c" }] } },
    { op: "terrain", id: "ground", seed: 3, ops: [{ noise: { amplitude: 3, scale: 15 } }], surfaces: [{ surface: "grass" }, { surface: "rock", slope: [30, 90] }] },
    { op: "create", id: "tower", kind: "box", material: "wood", position: [15, 5, 15], options: { size: [4, 10, 4] } },
    { op: "create", id: "crate", kind: "box", material: "wood", position: [-15, 0.5, -15], options: { size: [1, 1, 1] } },
    { op: "create", id: "spawn", kind: "marker", position: [0, 0, 0], tags: ["spawn"], params: { facing: "north" } },
    { op: "create", id: "whole", kind: "zone", tags: ["all"], area: { polygon: [[-30, -30], [30, -30], [30, 30], [-30, 30]], y: [-10, 40] } },
    { op: "create", id: "road", kind: "path", tags: ["road"], path: { points: [[-30, 0, 0], [30, 0, 0]] } },
  ]);
  await api.place({ model: "test_lamp_01", id: "lamps", tags: ["lamp"] }, { ifRevision: api.inspect().revision });
  api.apply([{ op: "set", id: "lamps", copies: [-25, -15, -5, 5, 15, 25].map((x) => [x, 0, 0, 0, 0, 0, 1]) }]);
  assert.equal(api.inspect({ id: "lamps" }).node.copies.length, 6);
  // The audit judges budgets per tile and the extent by tile.span.
  const tight = api.audit({ budget: { triangles: 100 } });
  assert.ok(tight.findings.some((f) => f.code === "tile-budget" && f.tile.join() === "0,0"), JSON.stringify(tight.findings.map((f) => f.code)));
  assert.ok(!tight.findings.some((f) => f.code === "budget"), "no whole-scene budget once the scene cuts into tiles");
  assert.equal(tight.tiles.length, 9);
  assert.ok(!api.audit().findings.some((f) => f.code === "out-of-bounds"), "span 3 × 3 holds the whole valley");
  api.loadProject({ ...api.getProject(), tile: { size: [20, 20] } }, { ifRevision: api.inspect().revision });
  assert.ok(api.audit().findings.some((f) => f.code === "out-of-bounds" && f.node === "tower"), "without span the tower leaves the one tile");
  api.loadProject({ ...api.getProject(), tile: { size: [20, 20], span: [3, 3] } }, { ifRevision: api.inspect().revision });

  const world = await api.exportWorld({ name: "Valley" });
  const m = world.manifest;
  assert.deepEqual(m.tile, { size: [20, 20], span: [3, 3] });
  assert.equal(m.tiles.length, 9, "the terrain covers nine tiles");
  assert.deepEqual(m.tiles.slice(0, 3).map((t) => [t.x, t.z]), [[-1, -1], [0, -1], [1, -1]], "tiles sorted by z, then x");
  assert.equal(m.data.file, "world.fun3d");
  assert.equal(m.source.file, "world.funmodel.glb");
  assert.ok(m.bounds.min[0] <= -30 && m.bounds.max[0] >= 30);
  const bytes = (path) => Buffer.from(world.files.find((f) => f.path === path).data, "base64");
  const resolve = () => fun3d.load(lampFun3d);
  const tileFile = async (path) => { const b = bytes(path); assert.deepEqual(await fun3d.validate(b), [], path); return fun3d.load(b, { resolve }); };
  // Tile 1_1: the tower, the terrain's sub-field, no data tables, a static body for the field.
  const t11 = await tileFile("tiles/1_1.fun3d");
  assert.ok(t11.node("tower") && t11.node("ground__1_1") && !t11.node("crate") && !t11.node("spawn"));
  assert.deepEqual(t11.extensions["fun3d.tile"], { world: "valley", x: 1, z: 1, bounds: t11.extensions["fun3d.tile"].bounds, size: [20, 20], far: "tiles/1_1.far.fun3d" });
  assert.equal(t11.extensions["fun3d.zones"], undefined);
  assert.equal(t11.manifest.physics.bodies.length, 1);
  const field11 = t11.extensions["fun3d.terrain"][0];
  assert.deepEqual([field11.origin, field11.samples], [[10, 0, 10], [11, 11]], "the sub-field starts at the tile's edge with the cells whose centres fall inside");
  // Tile 1_0 holds the two lamps standing in it, as placements.
  const t10 = await tileFile("tiles/1_0.fun3d");
  assert.equal(t10.manifest.nodes.find((n) => n.id === "lamps").placements.count, 2);
  assert.deepEqual(worldData(t10).markers("lamp").map((mk) => mk.position[0]), [15, 25]);
  // Heights agree where two sub-fields meet.
  const t00 = await tileFile("tiles/0_0.fun3d");
  const d00 = worldData(t00), d10 = worldData(t10);
  for (const z of [-9, -3, 0, 4, 9]) assert.ok(Math.abs(d00.height(10, z) - d10.height(10, z)) < 1e-5, `seam at x = 10, z = ${z}`);
  assert.equal(d00.height(10.5, 0), null, "a cell past the seam belongs to the neighbour");
  assert.ok(d10.height(10.5, 0) !== null);
  // Far files: the terrain coarsened and the tower; the crate's tile has only the field.
  const f11 = await tileFile("tiles/1_1.far.fun3d");
  assert.ok(f11.node("tower") && f11.node("ground__1_1"));
  assert.equal(f11.extensions["fun3d.tile"].level, "far");
  assert.equal(f11.manifest.physics?.bodies?.length ?? 0, 0, "no bodies at a distance");
  assert.deepEqual(f11.extensions["fun3d.terrain"][0].samples, [3, 3], "every fifth sample of ten cells");
  const fm1 = await tileFile("tiles/-1_-1.far.fun3d");
  assert.ok(!fm1.node("crate") && fm1.node("ground__m1_m1"));
  const f10 = await tileFile("tiles/1_0.far.fun3d");
  assert.equal(f10.manifest.nodes.find((n) => n.id === "lamps"), undefined, "small copies stay out of the far file");
  // The data file: markers with their parameters, the zone, the path, the world record.
  const data = worldData(await tileFile("world.fun3d"));
  assert.deepEqual(data.markers("spawn").map((mk) => [mk.id, mk.params.facing]), [["spawn", "north"]]);
  assert.ok(data.zone("whole").contains([25, 1, 25]));
  assert.equal(data.path("road").length, 60);
  assert.deepEqual(data.tile.size, [20, 20]);
  assert.equal(data.tile.world, "valley");
  assert.equal(data.tile.x, undefined);
  assert.equal(world.report.tiles.length, 9);
  assert.ok(world.report.tiles.every((t) => t.far > 0), "every tile has a far file: the terrain is in each");
  assert.ok(world.report.bytes > 0 && world.report.data.markers === 1);

  // Streamed back: the near tile answers exactly, far ones coarsely, markers from the data file.
  const files = new Map(world.files.map((f) => [`valley/${f.path}`, new Uint8Array(Buffer.from(f.data, "base64"))]));
  const read = async (path) => { const b = files.get(path); if (!b) throw new Error(`missing ${path}`); return b; };
  const scene = new THREE.Scene(), models = createModels({ THREE, scene });
  const live = await createWorld({ fun3d, models, read, json: async (path) => JSON.parse(new TextDecoder().decode(await read(path))) }, "valley/world.json", { radius: 5 });
  live.focus([0, 0, 0]);
  await live.settle();
  const states = Object.fromEntries(live.tiles().map((t) => [`${t.x}_${t.z}`, t.state]));
  assert.equal(states["0_0"], "near");
  assert.equal(states["1_1"], "far");
  assert.ok(Math.abs(live.height(3, 3) - d00.height(3, 3)) < 1e-5);
  assert.ok(live.height(25, 25) !== null, "the far field answers off the near tile");
  assert.equal(live.markers("spawn")[0].params.facing, "north");
  assert.equal(live.markers("lamp").length, 2, "the near tile's lamps (x = -5 and 5)");
  live.focus([25, 0, 25]);
  await live.settle();
  assert.equal(Object.fromEntries(live.tiles().map((t) => [`${t.x}_${t.z}`, t.state]))["1_1"], "near");
  assert.ok(scene.getObjectByName("tower"));
  live.dispose();
  models.dispose();
});

test("a sweep rule turns paths into track and road meshes on the terrain, with bodies, profiles and a routable network", async () => {
  fresh("circuit", { size: [200, 200] });
  api.apply([
    { op: "create", id: "ground", kind: "terrain", position: [-100, 0, -100], tags: ["ground"], terrain: { cell: 4, samples: [51, 51] } },
    { op: "terrain", id: "ground", seed: 2, ops: [{ noise: { amplitude: 3, scale: 40 } }] },
    { op: "create", id: "lap", kind: "path", tags: ["lap"], path: { points: [[-60, 0, -40], [60, 0, -40], [60, 0, 40], [-60, 0, 40]], closed: true, kind: "track", lanes: 2 } },
    { op: "resample", id: "lap", spacing: 4 },
    { op: "create", id: "main", kind: "path", tags: ["road"], path: { points: [[-90, 1, 0], [0, 1, 0], [90, 1, 0]], kind: "road", lanes: 2, speed: 50 } },
    { op: "create", id: "side", kind: "path", tags: ["road"], path: { points: [[0, 1, 0], [0, 1, 80]], kind: "road", lanes: 1, oneway: true } },
  ]);
  const lap = api.inspect({ id: "lap" }).node.path;
  assert.ok(lap.points.length > 60 && lap.points.length < 130, `the lap resampled at 4 m: ${lap.points.length} points`);
  assert.equal(lap.kind, "track");
  // With ground, the resampled points take the terrain's heights.
  api.apply([{ op: "resample", id: "lap", spacing: 4, ground: true }]);
  const grounded = api.inspect({ id: "lap" }).node.path.points, terrain = { ...api.inspect({ id: "ground" }).node.terrain, origin: [-100, 0, -100] };
  assert.ok(grounded.every(([x, y, z]) => Math.abs(y - heightAt(terrain, x, z)) < 1e-3), "every point sits on the terrain");
  assert.ok(grounded.some(([, y]) => Math.abs(y) > 0.5), "the terrain is not flat there");
  assert.throws(() => api.apply([{ op: "create", id: "bad", kind: "path", path: { points: [[0, 0, 0], [1, 0, 0]], kind: "canal" } }]), /one of data, road/);
  assert.throws(() => api.apply([{ op: "rule", definition: { id: "x", kind: "sweep", on: { path: "lap" }, profile: "nope" } }]), /unknown profile preset/);
  assert.throws(() => api.apply([{ op: "rule", definition: { id: "x", kind: "sweep", bake: false, on: { path: "lap" } } }]), /bake in the workshop/);
  api.apply([
    { op: "rule", definition: { id: "track", kind: "sweep", on: { path: "lap" }, profile: { preset: "track", width: 10 }, ground: true, rise: 0.1, step: 4, chunk: 150 } },
    { op: "rule", definition: { id: "roads", kind: "sweep", on: { tag: "road" }, profile: { preset: "road", lanes: 2, sidewalks: true }, step: 10, bank: null } },
  ]);
  const derived = await api.derive({}, { ifRevision: api.inspect().revision });
  const track = derived.derived.find((d) => d.rule === "track");
  assert.ok(track.nodes.length >= 2 && track.nodes.length <= 4, `the 400 m lap in 150 m chunks: ${track.nodes}`);
  assert.ok(track.triangles > 100 && track.sweep.paths === 1);
  const chunk = api.getProject().nodes.find((n) => n.id === track.nodes[0]);
  assert.ok(chunk.mesh.faces.length > 10 && chunk.tags.includes("ground") && chunk.derived.rule === "track");
  const materials = api.getProject().materials.map((m) => m.id);
  assert.ok(materials.includes("mat_asphalt") && materials.includes("mat_kerb_red") && materials.includes("mat_sidewalk"), `preset materials were added: ${materials}`);
  // The track rides on the terrain: its asphalt sits about the rise above the field.
  const field = { ...api.inspect({ id: "ground" }).node.terrain, origin: [-100, 0, -100] };
  const asphalt = new Set(chunk.mesh.faces.filter((f) => f.material === "mat_asphalt").flatMap((f) => f.vertices));
  for (const i of [...asphalt].slice(0, 20)) {
    const [x, y, z] = chunk.mesh.vertices[i];
    assert.ok(Math.abs(y - (heightAt(field, x, z) + 0.1)) < 1.5, `vertex ${x}, ${z} at ${y} over ${heightAt(field, x, z)}`);
  }
  const roads = derived.derived.find((d) => d.rule === "roads");
  assert.deepEqual(roads.nodes, ["roads_1", "roads_2", "roads_3", "roads_j1"], "the side road ends on the main road: a T junction cuts the main road in two and adds a patch");
  const audit = api.audit();
  assert.ok(!audit.findings.some((f) => f.code === "stale-rule" || f.code === "floating"), JSON.stringify(audit.findings.map((f) => f.code)));
  // Moving a road leaves its sweep stale; deriving the rule alone replaces its meshes.
  api.apply([{ op: "set", id: "side", path: { points: [[0, 1, 0], [0, 1, 90]], kind: "road", lanes: 1, oneway: true } }]);
  assert.ok(api.audit().findings.some((f) => f.code === "stale-rule"), "a moved path makes the sweep stale");
  await api.derive({ id: "roads" }, { ifRevision: api.inspect().revision });
  assert.ok(!api.audit().findings.some((f) => f.code === "stale-rule"));
  assert.ok(api.inspect({ id: "roads_3" }).bounds.max[2] > 89, "the new side road reaches z = 90");
  // The tile: edges with kinds, lanes and the profiles that swept them; bodies for the swept
  // floors; a network over the roads that respects one-way edges.
  const tile = await api.exportTile({ encoding: "buffer" });
  assert.deepEqual(await fun3d.validate(tile), []);
  const model = await fun3d.load(tile);
  const data = worldData(model);
  const main = data.path("main");
  assert.equal(main.kind, "road");
  assert.equal(main.lanes, 2);
  assert.equal(main.speed, 50);
  assert.equal(main.profile.id, "roads");
  assert.equal(main.width, 11);
  assert.equal(data.path("side").oneway, true);
  assert.equal(data.path("lap").profile.id, "track");
  assert.equal(data.path("lap").width, 12);
  assert.deepEqual(data.profiles().map((p) => p.id).sort(), ["roads", "track"]);
  const bodies = model.manifest.physics.bodies.map((b) => b.node);
  assert.ok(bodies.includes("ground") && bodies.includes(track.nodes[0]) && bodies.includes("roads_1"), bodies.join());
  const net = data.network("road");
  assert.equal(net.edges.length, 2);
  const route = net.route([-90, 1, 0], [0, 1, 90]);
  assert.ok(route.found && Math.abs(route.length - 180) < 1e-6 && route.edges.join() === "main,side", JSON.stringify(route));
  assert.deepEqual(route.points[0], [-90, 1, 0]);
  assert.equal(net.route([0, 1, 90], [-90, 1, 0]).found, false, "the side road is one way");
  assert.equal(data.network().edges.length, 3, "every non-data path without a kind given");
  const frame = main.frame(0.5);
  assert.deepEqual(frame.tangent.map((v) => Math.round(v) + 0), [1, 0, 0]);
  assert.deepEqual(frame.right.map((v) => Math.round(v) + 0), [0, 0, 1]);
  // A world's data file carries the same edges and profiles.
  const world = await api.exportWorld({ name: "Circuit" });
  const dataFile = worldData(await fun3d.load(Buffer.from(world.files.find((f) => f.path === "world.fun3d").data, "base64")));
  assert.equal(dataFile.path("lap").profile.id, "track");
  assert.ok(dataFile.network("road").route([-90, 1, 0], [0, 1, 90]).found);
});

test("a grid part: painted by rect, cells and zone, walls at level steps, the audit's ground, scatter by type, exported with a body, routed in the game, and walked through", async () => {
  fresh("keep", { size: [40, 40] });
  api.apply([
    { op: "create", id: "board", kind: "grid", position: [-16, 0, -16], tags: ["ground"], grid: {
      cell: 2, size: [16, 16], step: 0.5,
      types: [{ id: "plain", color: "#9fb66b" }, { id: "rock", color: "#6f6a62", walkable: false, buildable: false }, { id: "road", color: "#a9a49a", buildable: false, tags: ["lane"] }, { id: "water", color: "#4ba3c7", walkable: false }],
    } },
    { op: "create", id: "pond", kind: "zone", area: { polygon: [[2, 2], [10, 2], [10, 10], [2, 10]], y: [0, 2] } },
    { op: "grid", id: "board", paint: [
      { type: "rock", rect: [6, 0, 6, 10] },
      { type: "road", cells: [[0, 12], [1, 12], [2, 12], [3, 12], [4, 12], [5, 12], [6, 12], [7, 12]] },
      { type: "water", zone: "pond" },
      { level: 2, rect: [10, 12, 15, 15] },
    ] },
    { op: "create", id: "crate", kind: "box", material: "wood", position: [11, 1.5, 11], options: { size: [1, 1, 1] } },
    { op: "create", id: "lane", kind: "path", tags: ["lane"], path: { points: [[-15, 0.1, 9], [-1, 0.1, 9]] } },
  ]);
  assert.throws(() => api.apply([{ op: "set", id: "board", rotation: [0, 30, 0] }]), /never rotated/);
  assert.throws(() => api.apply([{ op: "grid", id: "board", paint: [{ type: "lava", all: true }] }]), /not a type/);
  const g = api.inspect({ id: "board" }).node.grid;
  assert.equal(g.cells[0 * 16 + 6], 1, "rock painted by rect");
  assert.equal(g.cells[12 * 16 + 3], 2, "road painted by cells");
  assert.equal(g.cells[(9 * 16) + 9], 3, "water painted inside the zone (cell centre 3, 3 → 2..10)");
  assert.equal(g.cells[(0 * 16) + 0], 0);
  assert.equal(g.levels[12 * 16 + 10], 2, "levels painted by rect");
  assert.equal(api.inspect().stats.grids, 1);
  assert.ok(api.inspect().stats.gridTriangles > 512, "walls add triangles");
  assert.deepEqual(api.inspect({ id: "board" }).bounds.max, [16, 1, 16]);
  // The grid is the ground: a crate on the raised corner rests at level 2 (1 m up).
  const audit = api.audit();
  assert.ok(!audit.findings.some((f) => f.code === "floating" || f.code === "overlap"), JSON.stringify(audit.findings));
  api.apply([{ op: "set", id: "crate", position: [11, 1.6, 11] }]);
  assert.ok(api.audit().findings.some((f) => f.code === "floating" && f.node === "crate"), "a crate above the raised cells floats");
  api.apply([{ op: "set", id: "crate", position: [11, 1.5, 11] }]);
  // Scatter on the grid by type, on the ground.
  api.apply([{ op: "rule", definition: { id: "props", kind: "scatter", seed: 1, on: { grid: { cells: [16, 16], spacing: 2, origin: [0, 0, 0] } }, ground: true, where: { types: ["plain"] }, candidates: [{ model: "test_lamp_01" }] } }]);
  await api.derive({}, { ifRevision: api.inspect().revision });
  const props = api.inspect({ id: "props" }).node;
  assert.ok(props.copies.length > 150 && props.copies.length < 256, `lamps on plain cells only: ${props.copies.length}`);
  assert.ok(props.copies.every(([x, , z]) => !(x > -4 && x < -2 && z < 6)), "none on the rock column");
  assert.ok(props.copies.filter(([x, y, z]) => x > 4 && z > 8).every(([, y]) => Math.abs(y - 1) < 1e-6), "copies on the raised corner sit a metre up");
  // The tile: the mesh with a body, the grid as data; the runtime answers cells and paths.
  const tile = await api.exportTile({ encoding: "buffer" });
  assert.deepEqual(await fun3d.validate(tile), []);
  const model = await fun3d.load(tile, { resolve: () => fun3d.load(lampFun3d) });
  assert.ok(model.node("board").userData.mesh?.isMesh);
  assert.ok(model.manifest.physics.bodies.some((b) => b.node === "board"));
  const data = worldData(model);
  assert.equal(data.grids().length, 1);
  assert.equal(data.cell(-15, -15).type.id, "plain");
  assert.equal(data.cell(-3, -15).type.id, "rock");
  assert.equal(data.cell(5, 9).level, 2);
  assert.equal(data.height(5, 9), 1);
  assert.equal(data.height(-15, -15), 0);
  assert.equal(data.cell(100, 0), null);
  const route = data.gridPath([-15, 0, -15], [15, 0, -15]);
  assert.ok(route.found && route.cells.some(([c, r]) => c === 6 && r > 10), "around the rock column through its gap");
  assert.ok(route.points.every(([, y]) => y === 0));
  assert.equal(data.gridPath([-15, 0, -15], [-3, 0, -15]).found, false, "rock is no goal");
  // A walkthrough along the lane: frames every 5 m, looking ahead.
  const walk = api.sample({ path: "lane", every: 5, height: 1.5, size: 96 });
  assert.equal(walk.frames.length, 3);
  assert.deepEqual(walk.frames.map((f) => f.distance), [0, 5, 10]);
  assert.ok(walk.frames.every((f) => f.dataUrl.startsWith("data:image/png") && f.view.startsWith("walk@")));
  assert.equal(api.renderViews(["perspective"], { size: 96, along: { path: "lane", every: 7, limit: 2 } }).length, 2, "observe with along walks the path and keeps to the limit");
  assert.throws(() => api.sample({ path: "crate" }), /not a path/);
  // Worlds cut a grid at its cells like a terrain.
  api.loadProject({ ...api.getProject(), tile: { size: [20, 20], span: [3, 3] } }, { ifRevision: api.inspect().revision });
  const world = await api.exportWorld({ name: "Keep" });
  assert.equal(world.manifest.tiles.length, 9, "the 32 m board reaches into the ring of 20 m tiles around 0_0");
  const t = await fun3d.load(Buffer.from(world.files.find((f) => f.path === "tiles/0_0.fun3d").data, "base64"), { resolve: () => fun3d.load(lampFun3d) });
  const cut = t.extensions["fun3d.grid"][0];
  assert.deepEqual([cut.origin, cut.size], [[-10, 0, -10], [10, 10]], "cells whose centres fall in the tile");
  assert.equal(worldData(t).cell(5, 9).level, 2);
});

test("lots line a street with models fitting and facing the road, as zones too; the map draws the tile grid", async () => {
  fresh("street", { size: [40, 40], span: [3, 3] });
  api.apply([
    { op: "create", id: "slab", kind: "box", material: "wood", position: [0, -0.05, 0], options: { size: [60, 0.1, 60] }, tags: ["ground"] },
    { op: "create", id: "main", kind: "path", tags: ["road"], path: { points: [[-25, 0, 0], [25, 0, 0]], kind: "road", lanes: 2 } },
    { op: "create", id: "block", kind: "zone", area: { polygon: [[-20, 2], [20, 2], [20, 30], [-20, 30]], y: [-1, 5] } },
  ]);
  // The lamp is 0.3 m across: lots 2 m wide with a metre's margin fit it exactly.
  api.apply([{ op: "rule", definition: { id: "houses", kind: "lots", seed: 2, on: { path: "main" }, width: [2.4, 2.4], depth: 3, offset: 4, gap: [1, 1], zones: true, bounds: "block", candidates: [{ model: "test_lamp_01", front: "-z" }] } }]);
  assert.throws(() => api.apply([{ op: "rule", definition: { id: "bad", kind: "lots", on: { path: "main" }, candidates: [{ model: "test_lamp_01", front: "up" }] } }]), /one of \+z/);
  const derived = await api.derive({}, { ifRevision: api.inspect().revision });
  const houses = derived.derived.find((d) => d.rule === "houses");
  assert.ok(houses.copies >= 10 && houses.copies <= 12, `lots inside the block on the right side only (bounds): ${houses.copies}`);
  const part = api.inspect({ id: "houses" }).node;
  assert.ok(part.copies.every(([x, y, z, , yaw]) => z > 4 && z < 5 && y === 0 && yaw === 0 && Math.abs(x) < 20), "the lamp's -z front sits on the front line at z = 4 (+ its half depth), facing the road without a turn");
  const zones = api.getProject().nodes.filter((n) => n.zone && n.derived?.rule === "houses");
  assert.equal(zones.length, houses.copies);
  assert.ok(zones.every((z) => z.tags.includes("lot") && z.params.side === "right" && z.params.width === 2.4 && z.params.model === "test_lamp_01@v001"));
  const data = worldData(await fun3d.load(await api.exportTile({ encoding: "buffer" }), { resolve: () => fun3d.load(lampFun3d) }));
  assert.ok(data.zones("lot").length === zones.length && data.zones("lot")[0].contains([data.zones("lot")[0].params.distance - 25, 1, 5.5]), "lot zones export with their parameters");
  // A sweep on the street widens the default offset to half its width plus 2 m.
  api.apply([{ op: "rule", definition: { id: "road", kind: "sweep", on: { path: "main" }, profile: { preset: "road", lanes: 2 }, step: 10 } }, { op: "rule", definition: { id: "shops", kind: "lots", seed: 2, on: { path: "main" }, sides: "left", width: [3, 3], depth: 3, candidates: [{ model: "test_lamp_01" }] } }]);
  const again = await api.derive({}, { ifRevision: api.inspect().revision });
  assert.equal(again.derived.find((d) => d.rule === "shops").lots.offset, 5.5, "7 m of asphalt: the front line sits 5.5 m out");
  const shops = api.inspect({ id: "shops" }).node;
  assert.ok(shops.copies.every(([, , z, , yaw]) => z < -5.5 && z > -7 && yaw === 0), "left side: behind the front line at z = -5.5, the +z front already facing the road");
  // Runtime lots: the rule rides in the tile and lays the same lots in the game.
  api.apply([{ op: "rule", definition: { id: "live", kind: "lots", bake: false, seed: 5, on: { tag: "road" }, sides: "right", width: [3, 3], depth: 4, start: 30, candidates: [{ model: "test_lamp_01" }] } }]);
  const live = worldData(await fun3d.load(await api.exportTile({ encoding: "buffer" }), { resolve: () => fun3d.load(lampFun3d) })).run("live");
  assert.ok(live.lots.length >= 5 && live.placed[0].rows.length === live.lots.length, `lots at play time: ${live.lots.length}`);
  assert.ok(live.placed[0].rows.every(([, , z]) => z > 5.5), "the runtime rule took the sweep's offset");
  // The map carries the tile grid of a tiled project.
  const withGrid = brightness(api.map({ size: 160 }).dataUrl), without = brightness(api.map({ size: 160, overlays: { tiles: false } }).dataUrl);
  assert.ok(withGrid.colours > without.colours, "tile lines add their colour to the map");
});

test("welded paths sweep as a network with junction patches, and the game routes across", async () => {
  fresh("crossroads", { size: [120, 120] });
  api.apply([
    { op: "create", id: "slab", kind: "box", material: "wood", position: [0, -0.05, 0], options: { size: [120, 0.1, 120] }, tags: ["ground"] },
    { op: "create", id: "ew", kind: "path", tags: ["road"], path: { points: [[-50, 0, 0], [50, 0, 0]], kind: "road", lanes: 2 } },
    { op: "create", id: "ns", kind: "path", tags: ["road"], path: { points: [[0, 0, -40], [0, 0, 40]], kind: "road", lanes: 2 } },
    { op: "create", id: "lane", kind: "path", tags: ["road"], path: { points: [[20, 0, 0.3], [20, 0, 30]], kind: "road", lanes: 1 } },
  ]);
  const before = worldData(await fun3d.load(await api.exportTile({ encoding: "buffer" })));
  assert.equal(before.network("road").route([-50, 0, 0], [0, 0, 40]).found, false, "unwelded roads do not connect");
  assert.throws(() => api.apply([{ op: "meet", ids: ["ew"] }]), /at least two paths/);
  api.apply([{ op: "meet", tag: "road", tolerance: 0.5 }]);
  const ew = api.inspect({ id: "ew" }).node.path.points;
  assert.deepEqual(ew, [[-50, 0, 0], [0, 0, 0], [20, 0, 0], [50, 0, 0]], "the crossing and the lane's foot joined the east-west road");
  assert.deepEqual(api.inspect({ id: "lane" }).node.path.points[0], [20, 0, 0]);
  api.apply([{ op: "rule", definition: { id: "roads", kind: "sweep", on: { tag: "road" }, profile: { preset: "road", lanes: 2, lines: false }, step: 5 } }]);
  const derived = await api.derive({}, { ifRevision: api.inspect().revision });
  const roads = derived.derived.find((d) => d.rule === "roads");
  assert.equal(roads.sweep.junctions, 2, "a crossroads and a T");
  const ids = roads.nodes;
  assert.ok(ids.includes("roads_j1") && ids.includes("roads_j2") && ids.filter((id) => /^roads_\d+$/.test(id)).length === 6, ids.join());
  const patch = api.getProject().nodes.find((n) => n.id === "roads_j1");
  assert.ok(patch.mesh.faces.every((f) => f.material === "mat_asphalt") && patch.tags.includes("ground"));
  const audit = api.audit();
  assert.ok(!audit.findings.some((f) => f.code === "overlap"), JSON.stringify(audit.findings.map((f) => f.code)));
  // Ribbons stop short of the crossroads; the runtime routes across the welded network.
  const chunks = api.getProject().nodes.filter((n) => /^roads_\d+$/.test(n.id));
  assert.ok(chunks.flatMap((n) => n.mesh.vertices).every((v) => !(Math.abs(v[0]) < 3.49 && Math.abs(v[2]) < 3.49)), "no ribbon inside the crossroads square");
  const data = worldData(await fun3d.load(await api.exportTile({ encoding: "buffer" })));
  const route = data.network("road").route([-50, 0, 0], [20, 0, 30]);
  assert.ok(route.found && route.edges.join() === "ew,lane" && Math.abs(route.length - 100) < 1e-6, JSON.stringify(route));
  api.apply([{ op: "rule", definition: { id: "roads", kind: "sweep", on: { tag: "road" }, profile: { preset: "road", lanes: 2, lines: false }, step: 5, junctions: false } }]);
  const plain = (await api.derive({}, { ifRevision: api.inspect().revision })).derived.find((d) => d.rule === "roads");
  assert.equal(plain.sweep.junctions, 0, "junctions off: every path on its own");
});
