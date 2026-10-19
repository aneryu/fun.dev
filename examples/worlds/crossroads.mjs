// A crossroads (docs/worlds.md step 3): two avenues crossing, a side street ending on one
// of them, all welded where they meet and swept as one network (ribbons stop short of the
// junctions, a patch of asphalt fills each), sidewalks and lamps along them, shops on lots
// along the east–west avenue kept off the other roads, a spawn and a walk through the
// crossing. The welded paths route as one road network in the game.
//   node scripts/editor-agent.mjs --run examples/worlds/crossroads.mjs
export default async function (ws) {
  await ws.load({ name: "Crossroads", tile: { size: [160, 160] }, materials: [{ id: "mat_lawn", name: "Lawn", color: "#7fa05a", roughness: 1 }] });
  await ws.apply([
    { op: "create", id: "ground", kind: "box", material: "mat_lawn", position: [0, -0.1, 0], options: { size: [150, 0.2, 150] }, tags: ["ground"] },
    { op: "create", id: "east_west", kind: "path", tags: ["road"], path: { points: [[-70, 0, 0], [70, 0, 0]], kind: "road", lanes: 2, speed: 40 } },
    { op: "create", id: "north_south", kind: "path", tags: ["road"], path: { points: [[0, 0, -70], [0, 0, 70]], kind: "road", lanes: 2, speed: 40 } },
    { op: "create", id: "side", kind: "path", tags: ["road"], path: { points: [[35, 0, 0.4], [35, 0, -60]], kind: "road", lanes: 2, speed: 30 } },
    { op: "create", id: "spawn", kind: "marker", position: [-65, 0, 0], rotation: [0, -90, 0], tags: ["spawn"] },
    // Where they meet: the crossing and the side street's foot become shared points.
    { op: "meet", tag: "road", tolerance: 1 },
  ]);
  await ws.rule({ id: "roads", kind: "sweep", on: { tag: "road" }, profile: { preset: "road", lanes: 2, sidewalks: true }, step: 5 });
  await ws.rule({ id: "lamps", kind: "scatter", target: "lamps", tags: ["lamp"], on: { path: "east_west", spacing: 20, offset: 5.4, sides: "both", start: 10 }, y: 0.2,
    avoid: [{ path: "north_south", width: 14 }, { path: "side", width: 14 }], candidates: [{ model: "street_lamp_01" }] });
  await ws.rule({ id: "shops", kind: "lots", seed: "corner", on: { path: "east_west" }, width: [14, 18], depth: 20, gap: [3, 5], start: 6, zones: true,
    avoid: [{ path: "north_south", width: 32 }, { path: "side", width: 32 }], candidates: [{ model: "city_retail_residential_01", weight: 2 }, { model: "cafe_01", weight: 1, margin: 2 }] });
  const derived = await ws.derive();
  const audit = await ws.audit();
  await ws.map({ file: "crossroads-map.png", size: 768 });
  await ws.observe(["perspective"], { file: "crossroads-view.png", size: 900, camera: { position: [-60, 40, 70], target: [10, 0, -5] } });
  await ws.observe(["perspective"], { file: "crossroads-corner.png", size: 900, camera: { position: [-14, 2, 12], target: [8, 1, -6] } });
  await ws.sample({ path: "east_west", every: 35, height: 1.7, file: "crossroads-walk.png" });
  await ws.exportTile({ file: "crossroads.fun3d" });
  await ws.exportWorld({ dir: "crossroads-world", name: "Crossroads" });
  return { derived, audit };
}
