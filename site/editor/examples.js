import { createStore, emptyProject } from "./document.js";

export function stoolProject() {
  const store = createStore(emptyProject("Little stool"));
  store.apply([
    {
      op: "material",
      id: "wood",
      name: "Honey wood",
      color: "#a36639",
      roughness: 0.8,
    },
    {
      op: "material",
      id: "legs",
      name: "Dark wood",
      color: "#684b35",
      roughness: 0.8,
    },
    { op: "create", id: "stool", name: "Stool", kind: "group" },
    {
      op: "create",
      id: "seat",
      name: "Beveled seat",
      parent: "stool",
      position: [0, 0.46, 0],
      material: "wood",
      options: { size: [0.62, 0.08, 0.62], bevel: 0.018 },
    },
    {
      op: "create",
      id: "leg",
      name: "Leg · source",
      parent: "stool",
      position: [-0.24, 0.21, 0.24],
      material: "legs",
      options: { size: [0.075, 0.42, 0.075] },
    },
    {
      op: "transform",
      id: "leg",
      vertices: [0, 1, 4, 5],
      scale: [0.6, 1, 0.6],
      space: "local",
    },
    {
      op: "duplicate",
      id: "leg",
      newId: "leg-right",
      name: "Leg · right",
      offset: [0.48, 0, 0],
      linked: true,
    },
    {
      op: "duplicate",
      id: "leg",
      newId: "leg-back",
      name: "Leg · back",
      offset: [0, 0, -0.48],
      linked: true,
    },
    {
      op: "duplicate",
      id: "leg",
      newId: "leg-back-right",
      name: "Leg · back right",
      offset: [0.48, 0, -0.48],
      linked: true,
    },
  ]);
  return store.snapshot();
}

export function planterProject() {
  const store = createStore(emptyProject("Little planter"));
  store.apply([
    {
      op: "material",
      id: "clay",
      name: "Terracotta",
      color: "#b86b45",
      roughness: 0.9,
    },
    {
      op: "create",
      id: "planter",
      name: "Hollow planter",
      kind: "lathe",
      material: "clay",
      options: {
        segments: 10,
        profile: [
          [0, 0],
          [0.3, 0],
          [0.45, 0.7],
          [0.4, 0.7],
          [0.26, 0.06],
          [0, 0.06],
        ],
      },
    },
  ]);
  return store.snapshot();
}
