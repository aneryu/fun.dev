import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createFun3d } from "../site/runtime/kit/fun3d.js";
import { validateManifest } from "../site/runtime/kit/fun3d-schema.js";
import { createModels } from "../site/runtime/kit/models.js";
import { worldData } from "../site/runtime/kit/world.js";

// .fun3d 1.1 (docs/worlds.md): placed library models as references, parameters on nodes,
// zones and paths with their point stream, and the placer carrying the nested objects.
const fun3d = createFun3d({ THREE });

function prop() {
  const root = new THREE.Group();
  root.name = "bench_01";
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.4).translate(0, 0.45, 0), new THREE.MeshStandardMaterial({ name: "mat_wood", color: "#a07a52" }));
  seat.name = "seat";
  root.add(seat);
  const lamp = new THREE.PointLight("#ffe0b0", 8, 4, 2);
  lamp.name = "glow";
  lamp.position.set(0, 1, 0);
  lamp.userData.light = { importance: 0.7 };
  root.add(lamp);
  return root;
}
function tile() {
  const root = new THREE.Group();
  root.name = "scene";
  const floor = new THREE.Mesh(new THREE.BoxGeometry(6, 0.1, 6).translate(0, 0.05, 0), new THREE.MeshStandardMaterial({ name: "mat_floor", color: "#777777" }));
  floor.name = "floor";
  root.add(floor);
  const bench = new THREE.Object3D();
  bench.name = "bench_1";
  bench.position.set(1, 0.1, -1);
  bench.userData.fun3dModel = { ref: "m0", tint: [1, 0.8, 0.8], variants: { finish: "dark" } };
  bench.userData.tags = ["bench"];
  root.add(bench);
  const spawn = new THREE.Object3D();
  spawn.name = "spawn";
  spawn.position.set(-2, 0.1, 2);
  spawn.userData.tags = ["spawn"];
  spawn.userData.params = { team: 1 };
  root.add(spawn);
  return root;
}
const extensions = {
  "fun3d.zones": [{ id: "park", tags: ["green"], shape: { polygon: [[-3, -3], [3, -3], [3, 3], [-3, 3]], y: [0, 4] } }],
  "fun3d.paths": {
    points: { stream: Float32Array.from([-2, 0, 0, 2, 0, 0, 2, 0, 2]), format: "float32x3" },
    edges: [{ id: "walk", points: [0, 1, 2], kind: "data", tags: ["patrol"], params: { pause: 2 } }],
  },
  "fun3d.tile": { bounds: { min: [-3, 0, -3], max: [3, 0.6, 3] }, size: [6, 6] },
};

test("the writer carries references, placed nodes, parameters and streamed extensions; the validator checks them", async () => {
  const bytes = await fun3d.write(tile(), { refs: [{ id: "m0", model: "bench_01@v002" }], extensions });
  assert.deepEqual(await fun3d.validate(bytes), []);
  const { manifest } = await fun3d.read(bytes);
  assert.equal(manifest.fun3d, "1.1");
  assert.deepEqual(manifest.refs, [{ id: "m0", model: "bench_01@v002" }]);
  const bench = manifest.nodes.find((n) => n.id === "bench_1");
  assert.deepEqual(bench.model, { ref: "m0", variants: { finish: "dark" }, tint: [1, 0.8, 0.8] });
  assert.equal(bench.mesh, undefined);
  assert.deepEqual(manifest.nodes.find((n) => n.id === "spawn").extensions, { "fun3d.params": { team: 1 } });
  assert.equal(typeof manifest.extensions["fun3d.paths"].points.stream, "string");
  assert.deepEqual([...manifest.uses].sort(), ["fun3d.params", "fun3d.paths", "fun3d.tile", "fun3d.zones"]);
  // Problems the validator names.
  const broken = structuredClone(manifest);
  broken.nodes.find((n) => n.id === "bench_1").model.ref = "nope";
  assert.ok(validateManifest(broken).some((p) => /unknown ref "nope"/.test(p)));
  const unlisted = structuredClone(manifest);
  unlisted.uses = unlisted.uses.filter((u) => u !== "fun3d.zones");
  assert.ok(validateManifest(unlisted).some((p) => /"fun3d.zones" which uses does not list/.test(p)));
  const badZone = structuredClone(manifest);
  badZone.extensions["fun3d.zones"][0].shape = { polygon: [[0, 0]] };
  assert.ok(validateManifest(badZone).some((p) => /polygon is 3/.test(p)));
  const badEdge = structuredClone(manifest);
  badEdge.extensions["fun3d.paths"].edges[0].points = [0, 9];
  assert.ok(validateManifest(badEdge).some((p) => /indexes at least two/.test(p)));
  await assert.rejects(fun3d.write(tile(), { extensions }), /refs does not name/);
});

test("the loader resolves references into nested copies, and the placer carries them", async () => {
  const benchFile = await fun3d.load(await fun3d.write(prop()));
  const bytes = await fun3d.write(tile(), { refs: [{ id: "m0", model: "bench_01@v002" }], extensions });
  await assert.rejects(fun3d.load(bytes), /resolve/);
  const resolved = [];
  const scene = await fun3d.load(bytes, { resolve: (model) => (resolved.push(model), benchFile) });
  assert.deepEqual(resolved, ["bench_01@v002"]);
  const node = scene.node("bench_1");
  const nested = node.children.find((c) => c.userData.nested);
  assert.ok(nested && nested.getObjectByName("seat")?.userData.mesh?.isMesh, "the bench's objects are under the node");
  assert.equal(nested.getObjectByName("seat").userData.mesh.geometry, benchFile.node("seat").userData.mesh.geometry, "geometry is shared with the referenced file");
  assert.equal(typeof nested.getObjectByName("seat").userData.mesh.toJSON, "function", "a real mesh, not a serialised one");
  assert.deepEqual(node.userData.model, { ref: "m0", model: "bench_01@v002", variants: { finish: "dark" }, tint: [1, 0.8, 0.8] });
  assert.deepEqual(scene.node("spawn").userData.params, { team: 1 });
  const data = worldData(scene);
  assert.deepEqual(data.markers("spawn")[0].position, [-2, 0.1, 2]);
  assert.deepEqual(data.markers("bench")[0].id, "bench_1");
  assert.ok(data.zone("park").contains([0, 1, 0]) && !data.zone("park").contains([0, 5, 0]));
  const walk = data.path("walk");
  assert.equal(walk.length, 6);
  assert.deepEqual(walk.params, { pause: 2 });
  assert.deepEqual(walk.at(1 / 3).position, [0, 0, 0]);
  assert.deepEqual(walk.at(0.5).direction, [1, 0, 0]);
  // kit/models.js: the copy keeps the nested objects beside its own batched or single parts.
  const stage = new THREE.Scene();
  const models = createModels({ THREE, scene: stage });
  const copy = models.place(scene, { position: [10, 0, 0] });
  assert.ok(copy.node("bench_1").children.some((c) => c.userData.nested && c.getObjectByName("seat")), "placed copies carry the nested objects");
  copy.root.updateMatrixWorld(true);
  const seat = copy.node("bench_1").getObjectByName("seat");
  const at = new THREE.Vector3().setFromMatrixPosition(seat.matrixWorld);
  assert.ok(Math.abs(at.x - 11) < 1e-6 && Math.abs(at.z + 1) < 1e-6, `the bench stands where the scene put it: ${at.toArray()}`);
  copy.remove();
  models.dispose();
});

test("many copies of a placed model: placements on the model node, instanced parts, a lamp per copy", async () => {
  const benchFile = await fun3d.load(await fun3d.write(prop()));
  const root = new THREE.Group();
  root.name = "scene";
  const row = new THREE.Object3D();
  row.name = "benches";
  row.userData.tags = ["seat"];
  const copies = new Float32Array(3 * 16), m = new THREE.Matrix4();
  for (let i = 0; i < 3; i++) m.makeTranslation(i * 2, 0, 0).toArray(copies, i * 16);
  row.userData.fun3dModel = { ref: "m0", copies, tints: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
  root.add(row);
  const bytes = await fun3d.write(root, { refs: [{ id: "m0", model: "bench_01@v002" }] });
  assert.deepEqual(await fun3d.validate(bytes), []);
  const { manifest } = await fun3d.read(bytes);
  const node = manifest.nodes.find((n) => n.id === "benches");
  assert.equal(node.placements.count, 3);
  assert.equal(node.transform, undefined, "copies replace the node's own transform");
  const scene = await fun3d.load(bytes, { resolve: () => benchFile });
  const object = scene.node("benches");
  const instanced = object.children.find((c) => c.isInstancedMesh);
  assert.ok(instanced && instanced.count === 3 && instanced.userData.nested);
  const at = new THREE.Matrix4();
  instanced.getMatrixAt(2, at);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(at).toArray().map((v) => Math.round(v * 1000) / 1000), [4, 0.45, 0], "copy × the seat's own transform");
  assert.equal(instanced.instanceColor.getX(1), 0);
  assert.equal(scene.lights.filter((l) => l.node === "benches").length, 3, "the bench's lamp once per copy");
  assert.deepEqual(scene.lights.find((l) => l.copy === 2).matrix.slice(12, 15), [4, 1, 0]);
  assert.equal(worldData(scene).markers("seat").length, 3);
  // The placer carries the instanced parts and offers every copy's lamp to the light slots.
  let offered = [];
  const stage = new THREE.Scene();
  const models = createModels({ THREE, scene: stage, lights: { update(dt, at, list) { offered = list.map((c) => [c.x, c.y, c.z]); } } });
  const copy = models.place(scene, { position: [10, 0, 0] });
  assert.ok(copy.node("benches").children.some((c) => c.isInstancedMesh && c.count === 3));
  models.update(new THREE.PerspectiveCamera(), { height: 100, dt: 1 / 60, at: new THREE.Vector3() });
  assert.deepEqual(offered.map((p) => p.map((v) => Math.round(v * 1000) / 1000)), [[10, 1, 0], [12, 1, 0], [14, 1, 0]]);
  copy.remove();
  models.dispose();
});
