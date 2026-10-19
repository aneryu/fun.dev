// An escape room (docs/worlds.md, step 1): walls and floor built in the workshop, furniture
// placed from the library, markers and a trigger zone for the game's puzzle logic.
//   node scripts/editor-agent.mjs --run examples/worlds/escape-room.mjs
export default async function (ws) {
  await ws.load({
    name: "Escape room",
    tile: { size: [8, 8] },
    materials: [
      { id: "mat_floor", color: "#9c7b57", roughness: 0.9 },
      { id: "mat_wall", color: "#d8d2c4", roughness: 0.95 },
      { id: "mat_door", color: "#5a3d26", roughness: 0.7 },
    ],
  });
  // The room: 6 × 4 m, 2.8 m high, a door opening in the south wall.
  await ws.apply([
    { op: "create", id: "floor", kind: "box", material: "mat_floor", position: [0, -0.05, 0], options: { size: [6, 0.1, 4] }, tags: ["ground"] },
    { op: "create", id: "wall_n", kind: "box", material: "mat_wall", position: [0, 1.4, -2.05], options: { size: [6.2, 2.8, 0.1] } },
    { op: "create", id: "wall_w", kind: "box", material: "mat_wall", position: [-3.05, 1.4, 0], options: { size: [0.1, 2.8, 4] } },
    { op: "create", id: "wall_e", kind: "box", material: "mat_wall", position: [3.05, 1.4, 0], options: { size: [0.1, 2.8, 4] } },
    { op: "create", id: "wall_s_w", kind: "box", material: "mat_wall", position: [-1.75, 1.4, 2.05], options: { size: [2.7, 2.8, 0.1] } },
    { op: "create", id: "wall_s_e", kind: "box", material: "mat_wall", position: [1.75, 1.4, 2.05], options: { size: [2.7, 2.8, 0.1] } },
    { op: "create", id: "lintel", kind: "box", material: "mat_wall", position: [0, 2.5, 2.05], options: { size: [0.8, 0.6, 0.1] } },
    { op: "create", id: "door", kind: "box", material: "mat_door", position: [0, 1.1, 2.05], options: { size: [0.8, 2.2, 0.06] }, tags: ["door"], params: { locked: true } },
  ]);
  // Furniture by reference.
  await ws.place({ id: "bed", model: "bed_single_01", position: [-1.9, 0, -0.9], rotation: [0, 90, 0] });
  await ws.place({ id: "bedside", model: "bedside_table_01", position: [-2.7, 0, 0.6], tags: ["search"], params: { contains: "note" } });
  await ws.place({ id: "desk", model: "curved_reception_desk_01", position: [1.8, 0, -1.5], rotation: [0, 180, 0] });
  await ws.place({ id: "chair", model: "desk_chair_01", position: [1.8, 0, -0.6], rotation: [0, 180, 0] });
  await ws.place({ id: "safe", model: "office_security_safe_01", position: [2.7, 0, 1.6], rotation: [0, -90, 0], tags: ["puzzle"], params: { code: "4471" } });
  await ws.place({ id: "crate", model: "wooden_shipping_crate_01", position: [-2.5, 0, 1.6], tags: ["search"], params: { contains: "key" } });
  await ws.place({ id: "rug", model: "living_room_rug_01", position: [0.2, 0, 0.2] });
  await ws.place({ id: "clock", model: "wall_clock_01", position: [0, 2.1, -1.97], tags: ["puzzle"], params: { shows: "4:47" } });
  await ws.place({ id: "easel", model: "painting_easel_01", position: [0.1, 0, -1.5], rotation: [0, 20, 0], tags: ["look"], params: { hint: "the clock never lies" } });
  await ws.place({ id: "book", model: "closed_book_01", position: [1.6, 1.1, -1.5], tags: ["search"], params: { contains: "hint" } });
  // Game data: where the player starts, the exit, and the trigger that ends the game.
  await ws.apply([
    { op: "create", id: "start", kind: "marker", position: [0, 0, -0.3], rotation: [0, 180, 0], tags: ["spawn"] },
    { op: "create", id: "exit", kind: "marker", position: [0, 0, 2.6], tags: ["exit"] },
    { op: "create", id: "doorway", kind: "zone", position: [0, 1.1, 1.7], tags: ["trigger"], area: { size: [1, 2.2, 0.8] }, params: { event: "escaped" } },
  ]);
  const audit = await ws.audit();
  await ws.map({ file: "room-map.png", size: 512 });
  await ws.observe(["perspective"], { file: "room-view.png", size: 768, camera: { position: [4.2, 6.5, 6], target: [0, 0.3, -0.2] } });
  await ws.observe(["perspective"], { file: "room-view-plain.png", size: 768, overlays: { data: false }, camera: { position: [4.2, 6.5, 6], target: [0, 0.3, -0.2] } });
  await ws.exportTile({ file: "room.fun3d" });
  return audit;
}
