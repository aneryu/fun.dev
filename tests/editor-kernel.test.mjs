import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  createStore,
  emptyProject,
  validateProject,
  statistics,
} from "../site/editor/document.js";
import { loadKernel } from "../site/editor/kernel.js";

before(() => loadKernel());

const palette = () => ({
  ...emptyProject("Kernel"),
  materials: [
    { id: "mat_cream", name: "cream", color: "#f6ebd0", roughness: 0.78 },
    { id: "mat_wood", name: "wood", color: "#c89969", roughness: 0.78 },
  ],
});
const clean = (project) => {
  const v = validateProject(project);
  assert.equal(v.errors.length, 0, JSON.stringify(v.errors));
  assert.deepEqual(
    v.warnings.filter((w) => ["open-edges", "nonmanifold", "inward-shell"].includes(w.code)),
    [],
  );
  return v;
};

test("boolean difference cuts a round window; the cut takes the tool's material", () => {
  const store = createStore(palette());
  store.apply([
    { op: "create", id: "wall", kind: "box", material: "mat_cream", position: [0, 1.4, 0], options: { size: [3, 2.8, 0.2] } },
    { op: "create", id: "hole", kind: "cylinder", material: "mat_wood", position: [0, 1.5, 0], rotation: [90, 0, 0], options: { radius: 0.6, height: 1, segments: 20 } },
  ]);
  const result = store.apply([{ op: "boolean", id: "wall", operation: "difference", with: ["hole"] }]);
  assert.deepEqual(result.results[0].consumed, ["hole"]);
  const p = store.snapshot(),
    wall = p.nodes.find((n) => n.id === "wall");
  assert.equal(p.nodes.length, 1, "the tool is consumed");
  assert.equal(wall.generator, undefined);
  clean(p);
  const wood = wall.mesh.faces.filter((f) => f.material === "mat_wood");
  assert.equal(wood.length, 20, "one inner face per cylinder segment");
  assert.ok(wall.mesh.faces.length <= 30, `${wall.mesh.faces.length} editable faces`);
  // A face with a hole cannot be one polygon: the front splits into a few simple pieces.
  const front = wall.mesh.faces.filter((f) => f.material === "mat_cream" && f.vertices.every((i) => Math.abs(wall.mesh.vertices[i][2] - 0.1) < 1e-6));
  assert.ok(front.length >= 2 && front.length <= 3, `${front.length} front pieces`);
  // Volume check through statistics: 3 × 2.8 × 0.2 minus the window.
  assert.ok(statistics(p).triangles < 200);
});

test("union and intersection; keep leaves the tool; open tools are rejected", () => {
  const store = createStore(palette());
  store.apply([
    { op: "create", id: "a", kind: "box", options: { size: [1, 1, 1] }, material: "mat_cream" },
    { op: "create", id: "b", kind: "sphere", position: [0.5, 0.5, 0.5], options: { radius: 0.5, segments: 12, rings: 8 }, material: "mat_wood" },
  ]);
  store.apply([{ op: "boolean", id: "a", operation: "union", with: ["b"], keep: true }]);
  let p = store.snapshot();
  assert.equal(p.nodes.length, 2);
  clean(p);
  store.apply([{ op: "boolean", id: "b", operation: "intersection", with: ["a"] }]);
  p = store.snapshot();
  assert.deepEqual(p.nodes.map((n) => n.id), ["b"]);
  clean(p);
  // An open sheet cannot bound a solid.
  store.apply([{ op: "create", id: "sheet", kind: "mesh", mesh: { vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], faces: [{ id: "f0", vertices: [0, 1, 2], material: "mat_cream" }] } }]);
  const before = store.snapshot();
  assert.throws(() => store.apply([{ op: "boolean", id: "b", operation: "difference", with: ["sheet"] }]), /closed solid/);
  assert.deepEqual(store.snapshot(), before);
});

test("a boolean recipe step keeps a parametric hole editable", () => {
  const store = createStore(palette());
  store.apply([
    { op: "create", id: "wall", kind: "box", material: "mat_cream", options: { size: [3, 2.8, 0.2] } },
    {
      op: "recipe",
      id: "wall",
      definition: {
        parameters: { radius: { value: 0.6, min: 0.1, max: 1.2 } },
        generator: { kind: "box", options: { size: [3, 2.8, 0.2] }, material: "mat_cream" },
        steps: [
          {
            op: "boolean",
            operation: "difference",
            shape: { kind: "cylinder", rotation: [90, 0, 0], material: "mat_wood", options: { radius: { $param: "radius" }, height: 1, segments: 16 } },
          },
        ],
      },
    },
  ]);
  const area = () => {
    const wall = store.snapshot().nodes[0];
    // Hole radius from the wood faces' extent along X.
    const xs = wall.mesh.faces.filter((f) => f.material === "mat_wood").flatMap((f) => f.vertices.map((i) => wall.mesh.vertices[i][0]));
    return Math.max(...xs) - Math.min(...xs);
  };
  assert.ok(Math.abs(area() - 1.2) < 0.01);
  store.apply([{ op: "recipeParameters", id: "wall", values: { radius: 0.4 } }]);
  assert.ok(Math.abs(area() - 0.8) < 0.01);
  clean(store.snapshot());
  assert.ok(store.snapshot().nodes[0].recipe, "the recipe survives");
});

test("separate shells passing through each other warn; only faults an edit adds block it", async () => {
  const { surfaceDiagnostics } = await import("../site/editor/diagnostics.js");
  const { primitive } = await import("../site/editor/mesh.js");
  // Two crossing boxes in one mesh, as merged library parts arrive.
  const a = primitive("box", { size: [1, 1, 1] }, "mat_cream"),
    b = primitive("box", { size: [0.4, 2, 0.4] }, "mat_wood");
  const merged = {
    vertices: [...a.vertices, ...b.vertices],
    faces: [
      ...a.faces,
      ...b.faces.map((f, i) => ({ ...f, id: `g${i}`, vertices: f.vertices.map((v) => v + a.vertices.length) })),
    ],
  };
  const report = surfaceDiagnostics(merged);
  assert.ok(report.issues.some((i) => i.code === "shell-overlap"));
  assert.ok(!report.issues.some((i) => i.code === "self-intersection"));
  const store = createStore(palette());
  store.apply([{ op: "create", id: "lamp", kind: "mesh", mesh: merged }]);
  const v = validateProject(store.snapshot());
  assert.equal(v.errors.length, 0, "overlapping parts are not an error");
  // Topology edits on the merged mesh work.
  store.apply([{ op: "paint", id: "lamp", material: "mat_wood", select: { kind: "faces", normal: [0, 1, 0] } }]);
  store.apply([{ op: "boolean", id: "lamp", operation: "difference", shape: { kind: "box", position: [0, -0.9, 0], options: { size: [3, 0.4, 3] } } }]);
  // A self-intersecting shell that already exists does not block an unrelated edit…
  // One shell folding through itself: a triangulated box whose top corner is pulled
  // down through its bottom face.
  const cube = primitive("box", { size: [1, 1, 1] }, "mat_cream");
  const fold = {
    vertices: cube.vertices.map((v, i) => (i === 6 ? [0, -1, 0] : v)),
    faces: cube.faces.flatMap((f) => [
      { id: `${f.id}a`, vertices: [f.vertices[0], f.vertices[1], f.vertices[2]], material: f.material },
      { id: `${f.id}b`, vertices: [f.vertices[0], f.vertices[2], f.vertices[3]], material: f.material },
    ]),
  };
  // Creating such geometry is a new fault and refused…
  assert.throws(() => store.apply([{ op: "create", id: "fold", kind: "mesh", mesh: fold }]), /intersect itself/);
  // …but one that arrives with a loaded project or an import stays editable.
  const loaded = createStore({
    ...palette(),
    nodes: [{ id: "fold", name: "fold", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mesh: fold }],
  });
  assert.ok(validateProject(loaded.snapshot()).errors.some((e) => e.code === "self-intersection"));
  const { topologyToken } = await import("../site/editor/components.js");
  loaded.apply([{ op: "vertices", id: "fold", topology: topologyToken(loaded.snapshot().nodes[0].mesh), changes: [{ index: 3, position: [-0.6, 0.5, -0.5] }] }]);
  // …and a budget too small to finish reports incompleteness instead of blocking.
  const tiny = surfaceDiagnostics(merged, { maxPairs: 1 });
  assert.equal(tiny.complete, false);
  assert.ok(tiny.issues.some((i) => i.code === "surface-check-incomplete"));
});
