import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { items } from "../economy.js";

// Reads a GLB's JSON chunk; Draco primitives keep their accessor counts, so no decoding is needed.
async function gltf(path) {
  const data = await readFile(new URL(`../${path}`, import.meta.url));
  return { size: data.length, json: JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString()) };
}
const triangles = (json) => json.meshes.flatMap((mesh) => mesh.primitives).reduce((sum, primitive) => sum + json.accessors[primitive.indices].count / 3, 0);
const SUPPORTED = ["KHR_draco_mesh_compression", "EXT_texture_webp", "KHR_materials_clearcoat", "KHR_materials_emissive_strength"];

test("relics.glb has every relic with the hooks altar.js and relics.js use", async () => {
  const { json } = await gltf("assets/relics.glb");
  const named = (name) => json.nodes.findIndex((node) => node.name === name);
  const hooks = { incense: ["tip"], sticks: ["mouth"], lotus: ["flame"], censer: ["vent"], novice: ["nod"], beads: ["loop"], chime: ["chimes"] };
  for (const item of items) {
    const root = named(item.id);
    assert.ok(root >= 0, `missing relic ${item.id}`);
    for (const hook of hooks[item.id] ?? []) {
      assert.ok(json.nodes[root].children?.includes(named(hook)), `${item.id} lacks its ${hook} node`);
    }
  }
});

test("models stay compressed and within the triangle budget", async () => {
  const relics = await gltf("assets/relics.glb");
  const fish = await gltf("assets/wooden-fish.glb");
  for (const { json } of [relics, fish]) {
    assert.ok(json.extensionsUsed.includes("KHR_draco_mesh_compression"));
    for (const extension of json.extensionsRequired ?? []) assert.ok(SUPPORTED.includes(extension), extension);
  }
  // The fish has ~23,000 triangles; everything is drawn again for the shadow.
  assert.ok(triangles(relics.json) <= 17000, `relics: ${triangles(relics.json)} triangles`);
  assert.ok(relics.size <= 250 * 1024, `relics.glb: ${relics.size} bytes`);
  assert.ok(fish.size <= 150 * 1024, `wooden-fish.glb: ${fish.size} bytes`);
  for (const name of ["Fish", "Cushion", "MalletHead", "MalletHandle"]) assert.ok(fish.json.nodes.some((node) => node.name === name), name);
});
