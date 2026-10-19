import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createFun3d } from "../site/runtime/kit/fun3d.js";
import { createModels } from "../site/runtime/kit/models.js";
import { createWorld } from "../site/runtime/kit/world.js";

// kit/world.js createWorld (docs/worlds.md §3.2, §7): a manifest, its data file, tiles
// streamed by distance from the focus, far files beyond, referenced models from the
// manifest's closure, and the queries that merge the data file with the near tiles.
const fun3d = createFun3d({ THREE });
const files = new Map();
const reads = [];
const read = async (path) => {
  reads.push(path);
  const bytes = files.get(path);
  if (!bytes) throw new Error(`missing ${path}`);
  return bytes;
};
const json = async (path) => JSON.parse(new TextDecoder().decode(await read(path)));
const material = new THREE.MeshStandardMaterial({ name: "mat_block", color: "#888888" });

function bench() {
  const root = new THREE.Group();
  root.name = "bench_01";
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.4).translate(0, 0.45, 0), material);
  seat.name = "seat";
  root.add(seat);
  return root;
}
// A flat field at `level` covering the tile centred on (cx, 0, cz), 10 m across.
const field = (node, cx, cz, level, samples, cell) => ({
  node, origin: [cx - 5, 0, cz - 5], cell, samples: [samples, samples],
  heights: { stream: Float32Array.from({ length: samples * samples }, () => level), format: "float32" },
  surfaceTable: [{ id: "grass", color: "#6b8f3a" }],
});
// A walkable raster over the tile (10 × 10 cells of 1 m), with a wall along x = 5 … 6 in
// tile 0_0 leaving a gap at the south end, so a walk east must go round through z > 3.
const navgridOf = (x, z, wall) => {
  const cells = new Uint8Array(100), heights = new Float32Array(100);
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) cells[r * 10 + c] = wall && c === 7 && r < 8 ? 0 : 1;
  return { cell: 1, origin: [x * 10 - 5, 0, z * 10 - 5], size: [10, 10], radius: 0.4, climb: 0.5, areas: [{ id: "ground", cost: 1 }], cells: { stream: cells, format: "uint8" }, heights: { stream: heights, format: "float32" } };
};
async function tile(x, z, { far = null, ref = false, terrain = null, level = null, nav = false } = {}) {
  const root = new THREE.Group();
  root.name = "scene";
  const block = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2), material);
  block.name = `block_${x}_${z}`;
  block.position.set(x * 10, 0.5, z * 10);
  root.add(block);
  if (!level) {
    const spot = new THREE.Object3D();
    spot.name = `spot_${x}_${z}`;
    spot.position.set(x * 10, 0, z * 10 + 2);
    spot.userData.tags = ["spot"];
    root.add(spot);
  }
  if (ref) {
    const node = new THREE.Object3D();
    node.name = "bench";
    node.position.set(x * 10 + 3, 0, z * 10);
    node.userData.fun3dModel = { ref: "m0" };
    root.add(node);
  }
  const extensions = { "fun3d.tile": { world: "w", x, z, size: [10, 10], bounds: { min: [x * 10 - 5, 0, z * 10 - 5], max: [x * 10 + 5, 3, z * 10 + 5] }, ...(far ? { far } : {}), ...(level ? { level } : {}) } };
  if (terrain) {
    const ground = new THREE.Object3D();
    ground.name = terrain.node;
    ground.position.fromArray(terrain.origin);
    root.add(ground);
    extensions["fun3d.terrain"] = [terrain];
  }
  if (nav) extensions["fun3d.navgrid"] = navgridOf(x, z, x === 0);
  return fun3d.write(root, { refs: ref ? [{ id: "m0", model: "bench_01@v002" }] : [], extensions });
}
async function data() {
  const root = new THREE.Group();
  root.name = "world";
  const spawn = new THREE.Object3D();
  spawn.name = "spawn";
  spawn.position.set(1, 0, 1);
  spawn.userData.tags = ["spawn"];
  spawn.userData.params = { facing: "east" };
  root.add(spawn);
  return fun3d.write(root, {
    extensions: {
      "fun3d.tile": { world: "w", size: [10, 10], bounds: { min: [-5, 0, -5], max: [35, 3, 5] } },
      "fun3d.zones": [{ id: "park", tags: ["green"], shape: { polygon: [[-5, -5], [15, -5], [15, 5], [-5, 5]], y: [0, 4] } }],
      "fun3d.paths": { points: { stream: Float32Array.from([0, 0, 0, 30, 0, 0]), format: "float32x3" }, edges: [{ id: "lap", points: [0, 1], kind: "data", tags: ["lap"] }] },
    },
  });
}
files.set("w/tiles/0_0.fun3d", await tile(0, 0, { nav: true }));
files.set("w/tiles/1_0.fun3d", await tile(1, 0, { far: "tiles/1_0.far.fun3d", terrain: field("ground", 10, 0, 3, 11, 1), nav: true }));
files.set("w/tiles/1_0.far.fun3d", await tile(1, 0, { level: "far", terrain: field("ground", 10, 0, 2.5, 3, 5) }));
files.set("w/tiles/3_0.fun3d", await tile(3, 0, { ref: true }));
files.set("w/world.fun3d", await data());
files.set("w/models/bench_01@v002.fun3d", await fun3d.write(bench()));
const manifest = {
  format: "fun.dev/world", version: 1, id: "w", name: "W", tile: { size: [10, 10] }, bounds: { min: [-5, 0, -5], max: [35, 3, 5] },
  tiles: [
    { x: 0, z: 0, file: "tiles/0_0.fun3d" },
    { x: 1, z: 0, file: "tiles/1_0.fun3d", far: { file: "tiles/1_0.far.fun3d" } },
    { x: 3, z: 0, file: "tiles/3_0.fun3d" },
    { x: 5, z: 0, file: "tiles/5_0.fun3d" },
  ],
  data: { file: "world.fun3d" },
  models: { "bench_01@v002": { file: "models/bench_01@v002.fun3d" } },
};
files.set("w/world.json", new TextEncoder().encode(JSON.stringify(manifest)));

test("a world streams tiles by distance, swaps far files for near ones, and merges its data", async () => {
  const scene = new THREE.Scene();
  const models = createModels({ THREE, scene });
  const events = [], warnings = [];
  const world = await createWorld({ fun3d, models, read, json, warn: (m) => warnings.push(m) }, "w/world.json", { radius: 4, far: 25, concurrency: 1, onTile: (t) => events.push(`${t.x}_${t.z}:${t.state}`) });
  assert.deepEqual(reads.slice(0, 2), ["w/world.json", "w/world.fun3d"], "the manifest and the data file come first");
  assert.deepEqual(world.size, [10, 10]);
  assert.deepEqual(world.markers("spawn").map((m) => [m.id, m.params.facing, m.position]), [["spawn", "east", [1, 0, 1]]], "the data file answers before any tile");
  assert.equal(world.tiles().every((t) => t.state === "none"), true);

  world.focus([0, 0, 0]);
  await world.settle();
  const states = () => Object.fromEntries(world.tiles().map((t) => [`${t.x}_${t.z}`, t.state]));
  assert.deepEqual(states(), { "0_0": "near", "1_0": "far", "3_0": "none", "5_0": "none" }, "the focus tile is near, the next one far, the rest out of reach");
  assert.ok(scene.getObjectByName("block_0_0"), "the near tile is placed");
  assert.equal(world.markers("spot").map((m) => m.id).join(), "spot_0_0", "markers of the near tiles join the data file's");
  assert.equal(world.height(10, 0), 2.5, "the far file's coarse field answers");
  assert.ok(world.zone("park").contains([1, 1, 1]) && !world.zone("park").contains([20, 1, 1]));
  assert.equal(world.path("lap").length, 30);
  assert.deepEqual(world.rules(), []);

  world.focus([10, 0, 0]);
  await world.settle();
  assert.deepEqual(states(), { "0_0": "near", "1_0": "near", "3_0": "none", "5_0": "none" }, "hysteresis keeps 0_0 near at 5 m; 1_0 comes near");
  // A walk from tile 0_0 into tile 1_0 crosses the seam over the stitched rasters, round the
  // wall's south end; within one tile the tile's own raster answers.
  assert.equal(world.walkable(1.5, -4.5), true);
  assert.equal(world.walkable(2.5, 0.5), false, "the wall at x = 2 … 3");
  const across = world.walk([-4.5, 0, -4.5], [12.5, 0, -4.5]);
  assert.ok(across.found && across.points.some((p) => p[0] > 5) && across.points.some((p) => p[2] > 2.5), JSON.stringify(across));
  assert.ok(across.length > 20 && across.length < 32, `round the wall and across the seam: ${across.length}`);
  const within = world.walk([6.5, 0, -4.5], [12.5, 0, 3.5]);
  assert.ok(within.found && within.length < 12, "inside tile 1_0 alone");
  assert.equal(world.height(10, 0), 3, "the near tile's field replaces the far one");
  assert.equal(world.tile(1, 0).farCopy, null, "the far copy left once the near tile stood");
  assert.equal(world.markers("spot").length, 2);

  world.focus([30, 0, 0]);
  await world.settle();
  assert.deepEqual(states(), { "0_0": "none", "1_0": "far", "3_0": "near", "5_0": "none" });
  assert.ok(!scene.getObjectByName("block_0_0"), "a tile out of reach is removed");
  assert.equal(world.height(10, 0), 2.5);
  const near = world.tile(3, 0).near;
  assert.ok(near.copy.node("bench").children.some((c) => c.userData.nested && c.getObjectByName("seat")), "the referenced model came through the manifest's closure");
  assert.equal(reads.filter((p) => p.endsWith("bench_01@v002.fun3d")).length, 1, "a model loads once");
  assert.equal(world.marker("spawn").params.facing, "east");
  assert.ok(events.includes("1_0:far") && events.includes("1_0:near") && events.includes("0_0:none"), events.join(" "));

  // A tile whose file is missing is reported once and never blocks settle.
  world.focus([50, 0, 0]);
  await world.settle();
  assert.equal(states()["5_0"], "none");
  assert.ok(warnings.some((w) => /5_0/.test(w) && /missing/.test(w)), warnings.join("\n"));
  const attempts = reads.filter((p) => p.endsWith("5_0.fun3d")).length;
  world.update();
  await world.settle();
  assert.equal(reads.filter((p) => p.endsWith("5_0.fun3d")).length, attempts, "no retry while the tile stays wanted");

  world.dispose();
  assert.equal(world.tiles().every((t) => t.state === "none"), true);
  assert.equal(scene.children.filter((c) => c.name !== "").length, 0, "nothing of the world stays in the scene");
  models.dispose();
});

test("the manifest is checked and a world without a data file still streams", async () => {
  const scene = new THREE.Scene();
  const models = createModels({ THREE, scene });
  files.set("w/bad.json", new TextEncoder().encode(JSON.stringify({ format: "fun.dev/model" })));
  await assert.rejects(createWorld({ fun3d, models, read, json }, "w/bad.json"), /fun\.dev\/world/);
  const { data: _, ...plain } = manifest;
  files.set("w/plain.json", new TextEncoder().encode(JSON.stringify({ ...plain, tiles: plain.tiles.slice(0, 1) })));
  const world = await createWorld({ fun3d, models, read, json }, "w/plain.json");
  assert.equal(world.data, null);
  assert.deepEqual(world.markers("spawn"), []);
  assert.throws(() => world.run("x"), /no data file/);
  world.focus({ x: 0, y: 0, z: 0 });
  await world.settle();
  assert.equal(world.tiles()[0].state, "near");
  assert.equal(world.markers("spot").length, 1);
  world.dispose();
  models.dispose();
});
