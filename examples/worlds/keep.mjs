// A tower-defence map (docs/worlds.md step 3): a 40 × 30 cell board with a lane painted from
// the gate to the keep, a river with a ford, rock, a raised plateau, build spots as markers;
// trees scattered on the plain cells only; a walkthrough down the lane. The game reads
// cell(x, z) for types and levels, gridPath for the creeps, markers("build") for turrets.
//   node scripts/editor-agent.mjs --run examples/worlds/keep.mjs
export default async function (ws) {
  await ws.load({ name: "Keep", tile: { size: [96, 96] }, materials: [{ id: "stone", name: "Stone", color: "#8f8a80", roughness: 0.9 }] });
  await ws.apply([
    { op: "create", id: "board", kind: "grid", position: [-40, 0, -30], tags: ["ground"], grid: {
      cell: 2, size: [40, 30], step: 0.5,
      types: [
        { id: "plain", color: "#9fb66b", tags: ["green"] },
        { id: "lane", color: "#c2b280", buildable: false, tags: ["lane"] },
        { id: "rock", color: "#6f6a62", walkable: false, buildable: false },
        { id: "water", color: "#4ba3c7", walkable: false, buildable: false },
        { id: "plateau", color: "#b7c48a" },
      ],
    } },
    { op: "create", id: "river", kind: "zone", tags: ["river"], area: { polygon: [[-6, -30], [0, -30], [0, 30], [-6, 30]], y: [0, 1] } },
    { op: "create", id: "lane", kind: "path", tags: ["lane"], path: { points: [[-39, 0, 27], [-39, 0, 1], [-3, 0, 1], [-3, 0, -17], [25, 0, -17], [25, 0, 13], [35, 0, 13]], kind: "walk" } },
    { op: "grid", id: "board", paint: [
      { type: "water", zone: "river" },
      { type: "rock", rect: [8, 0, 11, 7] },
      { type: "rock", rect: [26, 20, 39, 29] },
      { type: "plateau", level: 2, rect: [30, 0, 39, 9] },
      // The lane, cell by cell along the path's legs (the ford crosses the river at row 15).
      { type: "lane", rect: [0, 28, 0, 15] },
      { type: "lane", rect: [0, 15, 18, 15] },
      { type: "lane", rect: [18, 15, 18, 6] },
      { type: "lane", rect: [18, 6, 32, 6] },
      { type: "lane", rect: [32, 6, 32, 21] },
      { type: "lane", rect: [32, 21, 37, 21] },
    ] },
    { op: "create", id: "gate", kind: "marker", position: [-39, 0, 27], rotation: [0, 180, 0], tags: ["spawn", "gate"] },
    { op: "create", id: "keep", kind: "marker", position: [35, 0, 13], tags: ["goal", "keep"] },
    { op: "create", id: "tower_1", kind: "marker", position: [-31, 0, 9], tags: ["build"], params: { slot: 1 } },
    { op: "create", id: "tower_2", kind: "marker", position: [3, 0, -9], tags: ["build"], params: { slot: 2 } },
    { op: "create", id: "tower_3", kind: "marker", position: [27, 1, -25], tags: ["build"], params: { slot: 3 } },
    { op: "create", id: "donjon", kind: "box", material: "stone", position: [35, 3, 9], options: { size: [6, 6, 6] } },
  ]);
  // Shrubs and a few trees on the plain cells, away from the lane (cherry trees are heavy:
  // the board stays under a phone's budget).
  await ws.rule({ id: "trees", kind: "scatter", seed: "keep", target: "trees", tags: ["tree"], on: { grid: { cells: [20, 15], spacing: 4, origin: [0, 0, 0] } }, ground: true, where: { types: ["plain"] }, yaw: "random", scale: [0.7, 1.1],
    avoid: [{ path: "lane", width: 5 }], candidates: [{ model: "garden_shrub_01", weight: 10 }, { model: "flowering_cherry_tree_01", weight: 1 }] });
  const derived = await ws.derive();
  const audit = await ws.audit();
  await ws.map({ file: "keep-map.png", size: 768 });
  await ws.observe(["perspective"], { file: "keep-view.png", size: 900, camera: { position: [-70, 45, 70], target: [0, 0, 0] } });
  await ws.sample({ path: "lane", every: 25, height: 2, file: "keep-walk.png" });
  await ws.exportTile({ file: "keep.fun3d" });
  await ws.exportWorld({ dir: "keep-world", name: "Keep" });
  return { derived, audit };
}
