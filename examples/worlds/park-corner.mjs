// A park corner from library models (docs/worlds.md, step 1): placed by reference on a
// grass tile, with a spawn marker, a play zone and a stroll path for a game to read.
//   node scripts/editor-agent.mjs --run examples/worlds/park-corner.mjs
//   npx -y fundev-workshop --run park-corner.mjs
export default async function (ws) {
  await ws.load({ name: "Park corner", tile: { size: [12, 12] }, materials: [{ id: "mat_path", color: "#b9a98e", roughness: 0.95 }] });
  // Ground: two library grass tiles, a paved strip of our own.
  await ws.place({ id: "grass_a", model: "city_grass_tile_6x6_01", position: [-3, 0, -3] });
  await ws.place({ id: "grass_b", model: "city_grass_tile_6x6_01", position: [3, 0, -3] });
  await ws.place({ id: "paving", model: "city_ground_fill_6x6_01", position: [-3, 0, 3] });
  await ws.place({ id: "paving_b", model: "city_ground_fill_6x6_01", position: [3, 0, 3] });
  // Street furniture along the paving's edge.
  await ws.place({ id: "lamp_1", model: "street_lamp_01", position: [-5, 0.35, 0.5], rotation: [0, 90, 0], tags: ["lamp"] });
  await ws.place({ id: "bench_1", model: "bus_stop_bench_01", position: [-1.5, 0.35, 1.2], rotation: [0, 180, 0], tags: ["seat"], params: { seats: 3 } });
  await ws.place({ id: "bench_2", model: "bus_stop_bench_01", position: [2.5, 0.35, 1.2], rotation: [0, 180, 0], tags: ["seat"], params: { seats: 3 } });
  await ws.place({ id: "mailbox", model: "street_mailbox_01", position: [5, 0.35, 1], rotation: [0, -90, 0], tags: ["interact"], params: { action: "post" } });
  await ws.place({ id: "hydrant", model: "fire_hydrant_01", position: [4.2, 0.35, 4.5] });
  await ws.place({ id: "planter_1", model: "raised_planter_01", position: [0.5, 0.35, 4.8], rotation: [0, 90, 0] });
  // Green: a cherry tree and shrubs on the grass.
  await ws.place({ id: "tree_1", model: "flowering_cherry_tree_01", position: [-2.5, 0.35, -3] });
  await ws.place({ id: "shrub_1", model: "garden_shrub_01", position: [2, 0.35, -4.5] });
  await ws.place({ id: "shrub_2", model: "garden_shrub_01", position: [4, 0.35, -2] });
  await ws.place({ id: "shrub_3", model: "garden_shrub_01", position: [4.8, 0.35, -4.8] });
  await ws.place({ id: "fence_1", model: "picket_fence_01", position: [-4, 0.35, -5.9] });
  await ws.place({ id: "fence_2", model: "picket_fence_01", position: [-2, 0.35, -5.9] });
  await ws.place({ id: "fence_3", model: "picket_fence_01", position: [2, 0.35, -5.9] });
  await ws.place({ id: "fence_4", model: "picket_fence_01", position: [4, 0.35, -5.9] });
  // Data for the game: where the player appears, the lawn it may picnic on, a stroll.
  await ws.apply([
    { op: "create", id: "spawn", kind: "marker", position: [0, 0.35, 5], rotation: [0, 180, 0], tags: ["spawn"], params: { facing: "north" } },
    { op: "create", id: "lawn", kind: "zone", tags: ["picnic"], area: { polygon: [[-6, -6], [6, -6], [6, 0], [-6, 0]], y: [0.35, 3] } },
    { op: "create", id: "stroll", kind: "path", tags: ["stroll"], path: { points: [[-5, 0.4, 5], [-3, 0.4, 2.5], [0, 0.4, 2.2], [3, 0.4, 2.6], [5, 0.4, 5]], closed: false } },
  ]);
  const audit = await ws.audit();
  await ws.map({ file: "park-map.png", size: 512 });
  await ws.observe(["perspective"], { file: "park-view.png", size: 768 });
  await ws.observe(["perspective"], { file: "park-view-plain.png", size: 768, overlays: { data: false } });
  await ws.exportTile({ file: "park.fun3d" });
  await ws.exportWorld({ dir: "park-world", name: "Park corner" });
  return audit;
}
