import test from "node:test";
import assert from "node:assert/strict";
import {
  createStore,
  emptyProject,
  normalizeProject,
} from "../site/workshop/document.js";

test("materials carry metalness, emission, opacity and glass; defaults stay out of the document", () => {
  const store = createStore(emptyProject("Lamp"));
  store.apply([
    {
      op: "material",
      id: "mat_light",
      name: "lamp",
      color: "#fff3c4",
      emissive: "#ffe9a8",
      emissiveIntensity: 4,
    },
    {
      op: "material",
      id: "mat_glass",
      color: "#9fc3cf",
      roughness: 0.05,
      transmission: 0.9,
      ior: 1.45,
      opacity: 0.6,
      doubleSided: true,
    },
    { op: "material", id: "mat_steel", color: "#8c9399", metalness: 1 },
    { op: "create", id: "bulb", kind: "sphere", material: "mat_light" },
  ]);
  const byId = Object.fromEntries(
    store.snapshot().materials.map((m) => [m.id, m]),
  );
  assert.deepEqual(byId.mat_light, {
    id: "mat_light",
    name: "lamp",
    color: "#fff3c4",
    roughness: 0.85,
    emissive: "#ffe9a8",
    emissiveIntensity: 4,
  });
  assert.deepEqual(byId.mat_glass, {
    id: "mat_glass",
    name: "mat_glass",
    color: "#9fc3cf",
    roughness: 0.05,
    opacity: 0.6,
    transmission: 0.9,
    ior: 1.45,
    doubleSided: true,
  });
  assert.equal(byId.mat_steel.metalness, 1);
  // The five default materials are unchanged, field for field.
  assert.deepEqual(byId.yellow, emptyProject().materials[0]);

  // null removes an optional property; required ones cannot be removed.
  store.apply([
    { op: "material", id: "mat_light", emissive: null },
    { op: "material", id: "mat_glass", transmission: null, opacity: 1 },
  ]);
  const after = Object.fromEntries(
    store.snapshot().materials.map((m) => [m.id, m]),
  );
  assert.equal(after.mat_light.emissive, undefined);
  assert.equal(after.mat_light.emissiveIntensity, undefined);
  assert.equal(after.mat_glass.transmission, undefined);
  assert.equal(after.mat_glass.ior, undefined, "ior only lives with glass");
  assert.equal(after.mat_glass.opacity, undefined, "opacity 1 is the default");
  assert.throws(
    () => store.apply([{ op: "material", id: "mat_glass", color: null }]),
    /cannot be removed/,
  );
  assert.throws(
    () => store.apply([{ op: "material", id: "mat_steel", metalness: 2 }]),
    /metalness/,
  );
  assert.throws(
    () =>
      normalizeProject({
        ...emptyProject(),
        materials: [{ id: "a", name: "a", color: "#ffffff", emissive: "red" }],
      }),
    /emissive/,
  );
});

test("rename follows every reference; copies name their parts by map or replacement", () => {
  const store = createStore(emptyProject("Car"));
  store.apply([
    { op: "create", id: "car", kind: "group" },
    { op: "create", id: "steer_front_l", kind: "group", parent: "car", position: [0.8, 0.3, 1.3] },
    { op: "create", id: "wheel_front_l", kind: "group", parent: "steer_front_l" },
    { op: "create", id: "tire_front_l", kind: "cylinder", parent: "wheel_front_l", rotation: [0, 0, 90], options: { radius: 0.3, height: 0.2 } },
    { op: "create", id: "hub_front_l", kind: "cylinder", parent: "wheel_front_l", rotation: [0, 0, 90], options: { radius: 0.15, height: 0.22 } },
  ]);
  // Mirror by suffix replacement: every part keeps a meaningful glTF name.
  const mirrored = store.apply([
    { op: "symmetry", id: "steer_front_l", newId: "steer_front_r", axis: "x", space: "world", replace: ["_l", "_r"] },
  ]);
  assert.deepEqual(mirrored.results[0].idMap, {
    steer_front_l: "steer_front_r",
    wheel_front_l: "wheel_front_r",
    tire_front_l: "tire_front_r",
    hub_front_l: "hub_front_r",
  });
  const p = store.snapshot(),
    tireR = p.nodes.find((n) => n.id === "tire_front_r");
  assert.equal(tireR.parent, "wheel_front_r");
  assert.equal(tireR.symmetry.source, "tire_front_l");
  // Rear wheels: explicit idMap for some parts, replacement for the rest.
  const copied = store.apply([
    { op: "duplicate", id: "wheel_front_l", newId: "wheel_rear_l", offset: [0, 0, -2.6], replace: ["front", "rear"], idMap: { hub_front_l: "rim_rear_l" } },
  ]);
  assert.deepEqual(copied.results[0].idMap, {
    wheel_front_l: "wheel_rear_l",
    tire_front_l: "tire_rear_l",
    hub_front_l: "rim_rear_l",
  });
  // Renaming a mirror source updates the mirror, parents and linked copies.
  store.apply([
    { op: "duplicate", id: "tire_front_l", newId: "spare_tire", linked: true },
    { op: "rename", id: "tire_front_l", newId: "tyre_front_l" },
    { op: "rename", id: "wheel_front_l", newId: "wheel_fl" },
  ]);
  const q = store.snapshot(),
    byId = new Map(q.nodes.map((n) => [n.id, n]));
  assert.equal(byId.has("tire_front_l"), false);
  assert.equal(byId.get("tyre_front_l").parent, "wheel_fl");
  assert.equal(byId.get("tire_front_r").symmetry.source, "tyre_front_l");
  assert.equal(byId.get("spare_tire").instanceOf, "tyre_front_l");
  // Collisions, bad patterns and foreign idMap keys fail atomically.
  const before = store.snapshot();
  assert.throws(() => store.apply([{ op: "rename", id: "hub_front_l", newId: "tire_front_r" }]), /already exists/);
  assert.throws(() => store.apply([{ op: "rename", id: "hub_front_l", newId: "bad id" }]), /Invalid ID/);
  assert.throws(() => store.apply([{ op: "duplicate", id: "steer_front_l", newId: "x", replace: ["_q", "_z"] }]), /does not contain/);
  assert.throws(() => store.apply([{ op: "duplicate", id: "wheel_fl", newId: "y", idMap: { car: "z" } }]), /not a copied descendant/);
  assert.deepEqual(store.snapshot(), before);
});

test("rename keeps assembly bindings and anchors attached", async () => {
  const { toolboxAssemblyCommands } = await import("../site/workshop/assembly.js");
  const { hollowBoxRecipe } = await import("../site/workshop/recipe.js");
  const store = createStore(emptyProject("Toolbox"));
  store.apply(toolboxAssemblyCommands(hollowBoxRecipe()));
  const asset = store.snapshot().assemblies[0],
    bound = asset.bindings[0].id;
  store.apply([{ op: "rename", id: asset.root, newId: "crate" }, { op: "rename", id: bound, newId: "crate_part" }]);
  const after = store.snapshot().assemblies[0];
  assert.equal(after.root, "crate");
  assert.ok(after.bindings.some((b) => b.id === "crate_part"));
  assert.doesNotMatch(JSON.stringify(after), new RegExp(`"(?:id|root|node)":"${bound}"`));
  // Parameters still drive the renamed parts.
  store.apply([{ op: "assemblyParameters", root: "crate", values: { width: 0.9 } }]);
});
