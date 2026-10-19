// An island (docs/worlds.md step 3): a terrain shaped by noise, a hill and a lowered rim,
// a road flattened across it and swept as two lanes of asphalt, a plateau levelled for a
// village; surfaces by height and slope; shrubs and trees scattered on the grass; a spawn on
// the road. The world cuts into
// 3 × 3 tiles of 96 m: the terrain is split at its cells, the trees go by position, the
// road, the zones and the spawn are the world's data file, far files keep the ground coarse.
//   node scripts/editor-agent.mjs --run examples/worlds/island.mjs
export default async function (ws) {
  await ws.load({ name: "Island", tile: { size: [96, 96], span: [3, 3] } });
  await ws.apply([
    { op: "create", id: "ground", kind: "terrain", position: [-128, 0, -128], tags: ["ground"], terrain: {
      cell: 4, samples: [65, 65],
      surfaceTable: [{ id: "sand", color: "#d9c58a", friction: 0.6, tags: ["soft"] }, { id: "grass", color: "#6b8f3a", tags: ["green"] }, { id: "rock", color: "#7a746c", friction: 0.9, tags: ["hard"] }],
    } },
    // The road climbs over the island: the terrain's flatten follows the land along it, then
    // the path takes the ground's heights and the sweep follows the path.
    { op: "create", id: "road", kind: "path", tags: ["road"], path: { points: [[-110, 3, -30], [-40, 3, -10], [0, 3, 0], [50, 3, 20], [110, 3, 40]], kind: "road", lanes: 2, speed: 50 } },
    { op: "create", id: "village", kind: "zone", tags: ["village"], area: { polygon: [[30, -80], [80, -80], [80, -40], [30, -40]], y: [0, 20] } },
    { op: "create", id: "whole", kind: "zone", area: { polygon: [[-120, -120], [120, -120], [120, 120], [-120, 120]], y: [-20, 60] } },
    { op: "create", id: "spawn", kind: "marker", position: [-100, 3, -27], rotation: [0, 100, 0], tags: ["spawn"] },
    // Sea everywhere, then the island raised in the middle, a hill on it, the village levelled,
    // the road flattened, the whole smoothed once.
    { op: "terrain", id: "ground", seed: "isle", ops: [
      { noise: { amplitude: 10, scale: 90, octaves: 4 } },
      { add: { height: -9 } },
      { stamp: { shape: "circle", center: [0, 0], radius: 60, height: 16, falloff: 50 } },
      { stamp: { shape: "circle", center: [-20, 20], radius: 25, height: 14, falloff: 35 } },
      { smooth: { passes: 1 } },
      { level: { zone: "village", height: 9, blend: 10 } },
      // The road's bed: flat across the whole profile (7 m) and a little beyond, following
      // the land along the path, after the smoothing, so the asphalt lies on the ground.
      { flatten: { path: "road", width: 12, blend: 10, height: "terrain" } },
      { clamp: { min: -12, max: 60 } },
    ], surfaces: [{ surface: "sand", height: [-100, 1.5] }, { surface: "grass", height: [1.5, 100] }, { surface: "rock", slope: [30, 90] }], water: { level: 0.5 } },
  ]);
  // The road itself: the path on the ground, then two lanes with lines swept along it.
  await ws.apply([{ op: "resample", id: "road", spacing: 8, ground: true }]);
  await ws.rule({ id: "asphalt", kind: "sweep", on: { path: "road" }, profile: { preset: "road", lanes: 2 }, ground: true, rise: 0.08, step: 4 });
  // Cherry trees are heavy; most of the green is shrubs, so the scene stays under a phone's budget.
  await ws.rule({ id: "trees", kind: "scatter", seed: "isle-trees", target: "trees", tags: ["tree"], on: { zone: "whole", spacing: 14, jitter: 0.6 }, ground: true, where: { surfaces: ["grass"] }, yaw: "random", scale: [0.8, 1.2],
    avoid: [{ path: "road", width: 14 }, { zone: "village" }], candidates: [{ model: "flowering_cherry_tree_01", weight: 1 }, { model: "garden_shrub_01", weight: 6 }, { model: "bamboo_cluster_01", weight: 1 }] });
  await ws.rule({ id: "rocks", kind: "scatter", seed: "isle-rocks", target: "rocks", on: { zone: "whole", spacing: 12, jitter: 0.7 }, ground: true, where: { surfaces: ["rock"] }, yaw: "random", scale: [0.6, 1.4],
    candidates: [{ model: "garden_shrub_01", weight: 1 }] });
  const derived = await ws.derive();
  const audit = await ws.audit();
  await ws.map({ file: "island-map.png", size: 768 });
  await ws.observe(["perspective"], { file: "island-view.png", size: 900, camera: { position: [-150, 90, 170], target: [0, 5, 0] } });
  await ws.exportTile({ file: "island.fun3d" });
  await ws.exportWorld({ dir: "island-world", name: "Island" });
  return { derived, audit };
}
