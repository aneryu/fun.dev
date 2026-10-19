// A street block (docs/worlds.md step 3): an avenue swept with sidewalks, lots laid along
// both sides that take the library's buildings by footprint (offices and shops on wide lots,
// cafés on narrow ones), each facing the road with its front edge on the lots' front line,
// lamps along the kerb, trees in the gaps, a spawn at one end. The lots are zones too, so a
// game knows which parcel is whose; the map shows the world's 96 m tiles.
//   node scripts/editor-agent.mjs --run examples/worlds/block.mjs
export default async function (ws) {
  await ws.load({ name: "Block", tile: { size: [96, 96], span: [3, 3] }, materials: [{ id: "mat_lawn", name: "Lawn", color: "#7fa05a", roughness: 1 }] });
  await ws.apply([
    { op: "create", id: "ground", kind: "box", material: "mat_lawn", position: [0, -0.1, 0], options: { size: [220, 0.2, 120] }, tags: ["ground"] },
    { op: "create", id: "avenue", kind: "path", tags: ["road"], path: { points: [[-100, 0, 0], [100, 0, 0]], kind: "road", lanes: 2, speed: 40 } },
    { op: "create", id: "spawn", kind: "marker", position: [-95, 0, 0], rotation: [0, -90, 0], tags: ["spawn"] },
  ]);
  // The road first: two lanes with sidewalks; the lots' front line follows its width.
  await ws.rule({ id: "road", kind: "sweep", on: { path: "avenue" }, profile: { preset: "road", lanes: 2, sidewalks: true }, step: 10 });
  // Parcels 18–26 m wide and 24 m deep on both sides, 4–8 m apart (the city buildings are
  // 32 k triangles each: wider lots keep the tile under a phone's budget); the buildings that
  // fit them (the city set is 12 × 18 m, the school 18 × 24 m, the café 6.6 × 6 m) face the avenue.
  await ws.rule({ id: "lots", kind: "lots", seed: "block", on: { path: "avenue" }, width: [18, 26], depth: 24, gap: [4, 8], start: 4, zones: true,
    candidates: [{ model: "city_office_midrise_01", weight: 2 }, { model: "city_retail_residential_01", weight: 3 }, { model: "city_school_01", weight: 1, margin: 0 }, { model: "cafe_01", weight: 1, margin: 2 }] });
  // Lamps along the kerb line, trees between the buildings' front lines and the sidewalks.
  await ws.rule({ id: "lamps", kind: "scatter", target: "lamps", tags: ["lamp"], on: { path: "avenue", spacing: 24, offset: 5.4, sides: "both", start: 12 }, y: 0.15, candidates: [{ model: "street_lamp_01" }] });
  await ws.rule({ id: "trees", kind: "scatter", seed: "block", target: "trees", tags: ["tree"], on: { path: "avenue", spacing: 11, offset: 7, sides: "both", start: 6, jitter: 0.2 }, yaw: "random", scale: [0.8, 1.1],
    candidates: [{ model: "flowering_cherry_tree_01", weight: 1 }, { model: "garden_shrub_01", weight: 2 }] });
  const derived = await ws.derive();
  const audit = await ws.audit();
  await ws.map({ file: "block-map.png", size: 768 });
  await ws.observe(["perspective"], { file: "block-view.png", size: 900, camera: { position: [-120, 50, 90], target: [0, 5, 0] } });
  await ws.observe(["perspective"], { file: "block-front.png", size: 900, camera: { position: [-60, 3, 0], target: [-40, 6, 14] } });
  await ws.sample({ path: "avenue", every: 50, height: 1.7, file: "block-walk.png" });
  await ws.exportTile({ file: "block.fun3d" });
  await ws.exportWorld({ dir: "block-world", name: "Block" });
  return { derived, audit };
}
