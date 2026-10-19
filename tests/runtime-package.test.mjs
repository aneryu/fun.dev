import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildRuntime } from "../scripts/build-runtime.mjs";

// packages/fundev-runtime: the kit copied for npm resolves on its own and runs a world.
test("the runtime package builds from the kit and runs a tile end to end", async () => {
  const files = await buildRuntime();
  assert.ok(files.includes("world.js") && files.includes("nav.js") && !files.includes("text.js"), files.join());
  const runtime = await import("../packages/fundev-runtime/index.js");
  const fun3d = runtime.createFun3d({ THREE });
  const root = new THREE.Group();
  root.name = "scene";
  const floor = new THREE.Mesh(new THREE.BoxGeometry(6, 0.1, 6).translate(0, 0.05, 0), new THREE.MeshStandardMaterial({ name: "mat_floor", color: "#777777" }));
  floor.name = "floor";
  root.add(floor);
  const spawn = new THREE.Object3D();
  spawn.name = "spawn";
  spawn.position.set(-2, 0.1, 2);
  spawn.userData.tags = ["spawn"];
  root.add(spawn);
  const bytes = await fun3d.write(root, { extensions: { "fun3d.zones": [{ id: "park", shape: { polygon: [[-3, -3], [3, -3], [3, 3], [-3, 3]], y: [0, 4] } }] } });
  assert.deepEqual(await fun3d.validate(bytes), []);
  const tile = await fun3d.load(bytes);
  const data = runtime.worldData(tile);
  assert.deepEqual(data.markers("spawn")[0].position, [-2, 0.1, 2]);
  assert.ok(data.zone("park").contains([0, 1, 0]));
  const models = runtime.createModels({ THREE, scene: new THREE.Scene() });
  const copy = models.place(tile);
  assert.ok(copy.node("floor"));
  copy.remove();
  models.dispose();
  const { rows } = runtime.evaluateScatter({ seed: 1, on: { grid: { cells: [3, 3], spacing: 1, origin: [0, 0, 0] } }, candidates: [{ model: "x", weight: 1 }] }, {});
  assert.equal(rows[0].length, 9);
  const nav = { cell: 1, origin: [0, 0, 0], size: [4, 4], climb: 0.5, areas: [{ id: "ground" }], cells: Uint8Array.from({ length: 16 }, () => 1), heights: new Float32Array(16) };
  assert.ok(runtime.navPath(nav, [0.5, 0, 0.5], [3.5, 0, 3.5]).found);
  assert.equal(typeof runtime.createWorld, "function");
});
