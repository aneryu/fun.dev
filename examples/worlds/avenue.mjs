// An avenue by rules (docs/worlds.md, step 2): lamps every 12 m on both sides of the road,
// trees and shrubs scattered over the verges away from the road, paving and grass from kit
// tiles on a grid. Change the seed or the spacing and derive again.
//   node scripts/editor-agent.mjs --run examples/worlds/avenue.mjs
export default async function (ws) {
  await ws.load({ name: "Avenue", tile: { size: [72, 36] }, materials: [{ id: "mat_road", color: "#5b5d61", roughness: 0.95 }] });
  await ws.apply([
    // The road itself, a path for the game and the rules, and the verges as zones.
    { op: "create", id: "road_bed", kind: "box", material: "mat_road", position: [0, 0.1, 0], options: { size: [72, 0.2, 8] }, tags: ["ground"] },
    { op: "create", id: "road", kind: "path", tags: ["road"], path: { points: [[-36, 0.2, 0], [36, 0.2, 0]] } },
    { op: "create", id: "verge_n", kind: "zone", tags: ["verge"], area: { polygon: [[-33, -17], [33, -17], [33, -4], [-33, -4]], y: [0.35, 6] } },
    { op: "create", id: "verge_s", kind: "zone", tags: ["verge"], area: { polygon: [[-33, 4], [33, 4], [33, 17], [-33, 17]], y: [0.35, 6] } },
    { op: "create", id: "spawn", kind: "marker", position: [-30, 0.2, 0], tags: ["spawn"], params: { facing: "east" } },
  ]);
  // Ground tiles from the kit, on grids.
  await ws.rule({ id: "grass_n", kind: "scatter", target: "grass_n", on: { grid: { cells: [12, 2], spacing: 6, origin: [0, 0, -11] } }, yaw: 0, candidates: [{ model: "city_grass_tile_6x6_01" }] });
  await ws.rule({ id: "grass_s", kind: "scatter", target: "grass_s", on: { grid: { cells: [12, 2], spacing: 6, origin: [0, 0, 11] } }, yaw: 0, candidates: [{ model: "city_grass_tile_6x6_01" }] });
  // Street furniture along the road, both sides, facing the road.
  await ws.rule({ id: "lamps", kind: "scatter", target: "lamps", tags: ["lamp"], on: { path: "road", spacing: 12, offset: 5, sides: "both", start: 6 }, y: 0.35, candidates: [{ model: "street_lamp_01" }] });
  await ws.rule({ id: "benches", kind: "scatter", target: "benches", tags: ["seat"], on: { path: "road", spacing: 24, offset: 6.5, sides: "both", start: 12 }, y: 0.35, candidates: [{ model: "bus_stop_bench_01" }] });
  // Trees and shrubs over the verges, off the road; the margin keeps a turned tree inside the tile.
  await ws.rule({
    id: "green", kind: "scatter", seed: "avenue", target: "green", tags: ["tree"],
    on: { zone: "verge_n", spacing: 4, jitter: 0.6, margin: 3.5 }, y: 0.35, yaw: "random", scale: [0.85, 1.15],
    avoid: [{ path: "road", width: 14 }],
    candidates: [{ model: "flowering_cherry_tree_01", weight: 1 }, { model: "garden_shrub_01", weight: 3 }],
  });
  await ws.rule({
    id: "green_s", kind: "scatter", seed: "avenue-south", target: "green_s", tags: ["tree"],
    on: { zone: "verge_s", spacing: 4, jitter: 0.6, margin: 3.5 }, y: 0.35, yaw: "random", scale: [0.85, 1.15],
    avoid: [{ path: "road", width: 14 }],
    candidates: [{ model: "flowering_cherry_tree_01", weight: 1 }, { model: "garden_shrub_01", weight: 3 }],
  });
  const derived = await ws.derive();
  const audit = await ws.audit();
  await ws.map({ file: "avenue-map.png", size: 768 });
  await ws.observe(["perspective"], { file: "avenue-view.png", size: 900, camera: { position: [-30, 14, 34], target: [0, 1, 0] } });
  await ws.exportTile({ file: "avenue.fun3d" });
  await ws.exportWorld({ dir: "avenue-world", name: "Avenue" });
  return { derived, audit };
}
