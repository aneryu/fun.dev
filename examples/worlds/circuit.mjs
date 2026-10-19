// A racing circuit (docs/worlds.md step 3): a lap drawn as eight control points and
// resampled into a smooth curve, a gently rolling terrain flattened under it, the track swept
// from the lap with the track preset (asphalt, white edge lines, red and white kerbs, banking
// by curvature), lamps along both sides, trees in the infield away from the track, the start
// line and a spawn facing down it. The lap keeps kind track for the game: path("lap").at(t),
// nearest(p), frame(t).
//   node scripts/editor-agent.mjs --run examples/worlds/circuit.mjs
export default async function (ws) {
  await ws.load({ name: "Circuit", tile: { size: [320, 320] } });
  await ws.apply([
    { op: "create", id: "ground", kind: "terrain", position: [-160, 0, -160], tags: ["ground"], terrain: {
      cell: 4, samples: [81, 81],
      surfaceTable: [{ id: "grass", color: "#6b8f3a", tags: ["green"] }, { id: "gravel", color: "#9a927f", friction: 0.6, tags: ["loose"] }],
    } },
    { op: "create", id: "lap", kind: "path", tags: ["lap"], path: {
      points: [[-110, 2, -70], [40, 2, -90], [120, 2, -40], [90, 2, 30], [110, 2, 90], [-20, 2, 100], [-120, 2, 60], [-130, 2, -10]], closed: true, kind: "track", lanes: 2,
    } },
    { op: "resample", id: "lap", spacing: 3 },
    { op: "create", id: "infield", kind: "zone", tags: ["infield"], area: { polygon: [[-100, -60], [100, -60], [100, 70], [-100, 70]], y: [0, 30] } },
    { op: "create", id: "start", kind: "marker", position: [-110, 2.2, -70], rotation: [0, -80, 0], tags: ["start", "spawn"], params: { grid: 1 } },
    // Rolling ground, flattened under the lap, gravel where it is steep.
    { op: "terrain", id: "ground", seed: "circuit", ops: [
      { noise: { amplitude: 4, scale: 70, octaves: 3 } },
      { flatten: { path: "lap", width: 20, blend: 12 } },
    ], surfaces: [{ surface: "grass" }, { surface: "gravel", slope: [18, 90] }] },
  ]);
  // The track itself: 12 m of asphalt with kerbs, banked up to 8° on the bends.
  await ws.rule({ id: "track", kind: "sweep", on: { path: "lap" }, profile: { preset: "track", width: 12 }, ground: true, rise: 0.1, step: 3, bank: { max: 8, radius: 60 } });
  // Lamps along both sides, trees in the infield away from the track.
  await ws.rule({ id: "lamps", kind: "scatter", target: "lamps", tags: ["lamp"], on: { path: "lap", spacing: 40, offset: 9.5, sides: "both" }, ground: true, candidates: [{ model: "street_lamp_01" }] });
  // Cherry trees are heavy; most of the green is shrubs, so the scene stays under a phone's budget.
  await ws.rule({ id: "trees", kind: "scatter", seed: "infield", target: "trees", tags: ["tree"], on: { zone: "infield", spacing: 14, jitter: 0.6 }, ground: true, where: { surfaces: ["grass"] }, yaw: "random", scale: [0.8, 1.2],
    avoid: [{ path: "lap", width: 26 }], candidates: [{ model: "flowering_cherry_tree_01", weight: 1 }, { model: "garden_shrub_01", weight: 7 }] });
  const derived = await ws.derive();
  const audit = await ws.audit();
  await ws.map({ file: "circuit-map.png", size: 768 });
  await ws.observe(["perspective"], { file: "circuit-view.png", size: 900, camera: { position: [-200, 60, -160], target: [-60, 2, -60] } });
  await ws.exportTile({ file: "circuit.fun3d" });
  await ws.exportWorld({ dir: "circuit-world", name: "Circuit" });
  return { derived, audit };
}
