// A street network grown from the city_streets kit (docs/worlds.md §5): 12 m tiles with
// sockets on the sides that carry road, grown from a crossing inside a block, dead ends capped.
//   node scripts/editor-agent.mjs --run examples/worlds/street-grid.mjs
export default async function (ws) {
  await ws.load({ name: "Street grid", tile: { size: [96, 96] }, materials: [] });
  await ws.apply([
    { op: "create", id: "block", kind: "zone", tags: ["block"], area: { polygon: [[-48, -48], [48, -48], [48, 48], [-48, 48]], y: [0, 10] } },
    { op: "create", id: "spawn", kind: "marker", position: [0, 0.35, 0], tags: ["spawn"] },
  ]);
  await ws.rule({
    id: "streets", kind: "assemble", seed: "block-7", target: "streets", tags: ["street"], bounds: "block", count: 60,
    pieces: [
      // The cross is 12 × 12 with road out of every side. A straight is 12 m wide (sidewalks
      // included) and 6 m long: its road runs along z, two of them span a block side. The
      // corner joins e and s, the tee opens e, w and s, the end cap closes a road from s
      // (read off each piece's top view: ws.place one, then ws.map).
      { model: "city_street_cross_01", sockets: { n: "road", s: "road", e: "road", w: "road" }, start: true, weight: 1 },
      { model: "city_street_straight_01", sockets: { n: "road", s: "road" }, weight: 6 },
      { model: "city_street_t_01", sockets: { e: "road", w: "road", s: "road" }, weight: 2 },
      { model: "city_street_corner_01", sockets: { e: "road", s: "road" }, weight: 2 },
      { model: "city_street_endcap_01", sockets: { s: "road" }, closer: true },
    ],
  });
  const derived = await ws.derive();
  const audit = await ws.audit();
  await ws.map({ file: "streets-map.png", size: 768 });
  await ws.observe(["perspective"], { file: "streets-view.png", size: 900, camera: { position: [-60, 45, 70], target: [0, 0, 0] } });
  await ws.exportTile({ file: "streets.fun3d" });
  return { derived, audit };
}
