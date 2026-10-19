// A walled garden by a chain (docs/worlds.md §5): retaining walls follow a fixed sequence of
// straights and corners around a lawn, shrubs scattered inside, a gate as the only opening.
//   node scripts/editor-agent.mjs --run examples/worlds/walled-garden.mjs
export default async function (ws) {
  await ws.load({ name: "Walled garden", tile: { size: [20, 20] }, materials: [] });
  await ws.apply([
    { op: "create", id: "lawn", kind: "zone", tags: ["lawn"], area: { polygon: [[-5, -5], [5, -5], [5, 5], [-5, 5]], y: [0, 3] } },
    { op: "create", id: "spawn", kind: "marker", position: [0, 0, 7], rotation: [0, 180, 0], tags: ["spawn"] },
  ]);
  // The wall: 2 m straights with ends on their x sides, a 0.6 m corner turning +z into +x.
  // The chain starts at the south-west corner and walks the rectangle: 5 straights, a corner,
  // repeated four times (the corner's out faces the next side).
  await ws.rule({
    id: "wall", kind: "assemble", seed: 1, target: "wall", tags: ["wall"], frontier: "last", from: "e", at: [-6, 0, 6], count: 24,
    mates: [["wall", "wall"], ["wall", "corner_in"], ["corner_out", "wall"]],
    sequence: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    pieces: [
      { model: "retaining_wall_straight_01", sockets: { e: "wall", w: "wall" }, start: true },
      { model: "retaining_wall_corner_01", sockets: { w: { position: [-0.3, 0, 0], rotation: [0, -90, 0], tags: ["corner_in"] }, n: { position: [0, 0, -0.3], rotation: [0, 180, 0], tags: ["corner_out"] } } },
    ],
  });
  await ws.rule({
    id: "shrubs", kind: "scatter", seed: "garden", target: "shrubs", tags: ["shrub"], on: { zone: "lawn", spacing: 2.2, jitter: 0.5, margin: 0.8 }, yaw: "random", scale: [0.8, 1.1],
    candidates: [{ model: "garden_shrub_01", weight: 3 }, { model: "flowering_perennial_01", weight: 2 }],
  });
  const derived = await ws.derive();
  const audit = await ws.audit();
  await ws.map({ file: "garden-map.png", size: 512 });
  await ws.observe(["perspective"], { file: "garden-view.png", size: 900, camera: { position: [-12, 9, 14], target: [0, 0, 0] } });
  return { derived, audit };
}
