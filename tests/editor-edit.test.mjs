import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  createStore,
  emptyProject,
  validateProject,
  measure,
} from "../site/workshop/document.js";
import { queryComponents } from "../site/workshop/components.js";
import { commandsSchema, validateSchema } from "../site/workshop/agent-contract.js";
import { loadKernel } from "../site/workshop/kernel.js";
import { meshEdges } from "../site/workshop/topology.js";

before(() => loadKernel());

const codes = (project) => {
  const v = validateProject(project);
  assert.deepEqual(v.errors, []);
  return v.warnings.map((w) => w.code);
};
const closed = (project, cavity = false) =>
  assert.deepEqual(
    codes(project).filter((c) =>
      ["open-edges", "nonmanifold", ...(cavity ? [] : ["inward-shell"])].includes(c),
    ),
    [],
  );
const node = (store, id) => store.snapshot().nodes.find((n) => n.id === id);
const faces = (store, id, query) =>
  queryComponents(store.snapshot(), { id, kind: "faces", ...query }).items;
const box = (id, extra = {}) => ({
  op: "create",
  id,
  kind: "box",
  options: { size: [1, 1, 1] },
  ...extra,
});

test("deleteComponents opens a mesh; fill closes it again, as commands and recipe steps", () => {
  const store = createStore(emptyProject("Edit"));
  store.apply([box("b"), { op: "convert", id: "b" }]);
  const top = faces(store, "b", { normal: [0, 1, 0] }).map((f) => f.ref);
  store.apply([{ op: "deleteComponents", id: "b", faces: top }]);
  assert.equal(node(store, "b").mesh.faces.length, 5);
  assert.ok(codes(store.snapshot()).includes("open-edges"));
  const filled = store.apply([{ op: "fill", id: "b" }]);
  assert.equal(filled.results[0].filledLoops, 1);
  closed(store.snapshot());
  // Edges and vertices remove every face that uses them.
  const vertex = queryComponents(store.snapshot(), { id: "b", kind: "vertices" }).items[0].ref;
  store.apply([{ op: "deleteComponents", id: "b", vertices: [vertex] }]);
  assert.equal(node(store, "b").mesh.faces.length, 3);
  assert.throws(
    () => store.apply([{ op: "deleteComponents", id: "b", select: { kind: "faces", normal: [0, 0, 0.0001], normalTolerance: 2 } }]),
    /delete the part instead/,
  );
  // An open-top box as a parametric recipe: the opening follows the size.
  const recipe = createStore(emptyProject("Crate"));
  recipe.apply([
    box("crate"),
    {
      op: "recipe",
      id: "crate",
      definition: {
        parameters: { width: { value: 0.6 } },
        generator: { kind: "box", options: { size: [{ $param: "width" }, 0.4, 0.4] } },
        steps: [
          { op: "deleteComponents", select: { kind: "faces", normal: [0, 1, 0] } },
          { op: "solidify", thickness: 0.02 },
        ],
      },
    },
  ]);
  closed(recipe.snapshot());
  recipe.apply([{ op: "recipeParameters", id: "crate", values: { width: 0.9 } }]);
  const b = measure(recipe.snapshot(), "crate").bounds;
  assert.ok(Math.abs(b.size[0] - 0.9) < 1e-9);
  closed(recipe.snapshot());
});

test("dissolve merges coplanar faces: explicit edges, limited cleanup, vertices", () => {
  const store = createStore(emptyProject("Dissolve"));
  store.apply([box("b"), { op: "convert", id: "b" }, { op: "cut", id: "b", axis: "x", offset: 0.1 }]);
  assert.equal(node(store, "b").mesh.faces.length, 10);
  const seam = queryComponents(store.snapshot(), {
    id: "b",
    kind: "edges",
    at: { axis: "x", value: 0.1 },
    boundary: { axis: "y", side: "max" },
  }).items.map((e) => e.ref);
  assert.equal(seam.length, 1);
  store.apply([{ op: "dissolve", id: "b", edges: seam }]);
  assert.equal(node(store, "b").mesh.faces.length, 9);
  closed(store.snapshot());
  // A crease is not dissolved by an explicit request.
  const crease = queryComponents(store.snapshot(), { id: "b", kind: "edges", crease: 80 }).items[0].ref;
  assert.throws(() => store.apply([{ op: "dissolve", id: "b", edges: [crease] }]), /coplanar/);
  // Limited dissolve cleans the remaining split sides and drops collinear vertices.
  const result = store.apply([{ op: "dissolve", id: "b" }]);
  assert.equal(node(store, "b").mesh.faces.length, 6);
  assert.equal(node(store, "b").mesh.vertices.length, 8);
  assert.ok(result.results[0].removedVertices >= 4);
  closed(store.snapshot());
  // A triangulated flat sheet (as imports deliver it) cleans up to one quad.
  const N = 10, vertices = [], tris = [];
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) vertices.push([i * 0.1, 0, j * 0.1]);
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const a = i * (N + 1) + j;
      tris.push({ id: `t${tris.length}`, vertices: [a, a + 1, a + N + 2], material: "yellow" }, { id: `t${tris.length + 1}`, vertices: [a, a + N + 2, a + N + 1], material: "yellow" });
    }
  const flat = createStore(emptyProject("Sheet"));
  flat.apply([{ op: "create", id: "sheet", kind: "mesh", mesh: { vertices, faces: tris } }, { op: "dissolve", id: "sheet" }]);
  assert.equal(node(flat, "sheet").mesh.faces.length, 1);
  assert.equal(node(flat, "sheet").mesh.vertices.length, 4);
  // Dissolving a vertex between two collinear edges keeps both faces.
  store.apply([{ op: "cut", id: "b", axis: "y", offset: 0 }]);
  const before = node(store, "b").mesh.faces.length;
  store.apply([{ op: "dissolve", id: "b", angle: 0.1 }]);
  assert.equal(node(store, "b").mesh.faces.length, before - 4);
  closed(store.snapshot());
});

test("join merges parts in the target's frame; overlapping parts stay as warned shells", () => {
  const store = createStore(emptyProject("Join"));
  store.apply([
    box("a"),
    box("b", { position: [2, 0, 0], rotation: [0, 45, 0] }),
    { op: "create", id: "knob", kind: "sphere", parent: "b", position: [0.5, 0.6, 0], options: { radius: 0.1 } },
    box("c", { position: [-2, 0, 0] }),
    { op: "symmetry", id: "c", newId: "c_mirror", axis: "x", space: "world", offset: 3 },
  ]);
  const knobBefore = measure(store.snapshot(), "knob").bounds;
  const joined = store.apply([{ op: "join", id: "a", with: ["b", "c"] }]);
  assert.deepEqual(joined.results[0].consumed, ["b", "c"]);
  const p = store.snapshot();
  assert.deepEqual(p.nodes.map((n) => n.id).sort(), ["a", "c_mirror", "knob"]);
  assert.equal(p.nodes.find((n) => n.id === "knob").parent, "a");
  const round9 = (v) => v.map((x) => +x.toFixed(9));
  assert.deepEqual(round9(measure(p, "knob").bounds.min), round9(knobBefore.min));
  assert.equal(p.nodes.find((n) => n.id === "c_mirror").symmetry, undefined, "the mirror survives, unlinked");
  assert.equal(node(store, "a").mesh.faces.length, 18);
  // a spans ±0.5, c sits at x = -2, b (turned 45°) reaches 2 + √½.
  assert.ok(Math.abs(measure(p, "a").bounds.size[0] - (2.5 + 2 + Math.SQRT1_2)) < 1e-9);
  closed(p);
  // Like Blender's join, overlapping parts become separate shells of one mesh: allowed,
  // reported as shell-overlap (boolean union makes one clean solid instead).
  store.apply([box("d", { position: [0.5, 0, 0] })]);
  store.apply([{ op: "join", id: "a", with: ["d"] }]);
  const joinedOverlap = validateProject(store.snapshot());
  assert.equal(joinedOverlap.errors.length, 0);
  assert.ok(joinedOverlap.warnings.some((w) => w.code === "shell-overlap" && w.node === "a"));
});

test("weld merges split vertices into one closed solid and refuses to pinch faces", () => {
  // An unwelded cube, as imports deliver it: every face has its own corners.
  const corners = [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2]];
  const mesh = { vertices: [], faces: [] };
  quads.forEach((q, i) => {
    const base = mesh.vertices.length;
    mesh.vertices.push(...q.map((v) => corners[v]));
    mesh.faces.push({ id: `f${i}`, vertices: [0, 1, 2, 3].map((k) => base + k), material: "yellow" });
  });
  const store = createStore(emptyProject("Weld"));
  store.apply([{ op: "create", id: "cube", kind: "mesh", mesh }]);
  assert.ok(codes(store.snapshot()).includes("open-edges"));
  // A weld with nothing to merge leaves a parametric part parametric.
  store.apply([box("plain"), { op: "weld", id: "plain" }]);
  assert.ok(node(store, "plain").generator, "generator kept");
  const welded = store.apply([{ op: "weld", id: "cube" }]);
  assert.equal(welded.results[0].mergedVertices, 16);
  assert.equal(node(store, "cube").mesh.vertices.length, 8);
  closed(store.snapshot());
  const before = store.snapshot();
  // Opposite corners of the +X face: the face would pass through one point twice.
  const side = queryComponents(before, { id: "cube", kind: "vertices", boundary: { axis: "x", side: "max" } }).items;
  const diagonal = side.filter((v) => v.center[1] === v.center[2]).map((v) => v.ref);
  assert.equal(diagonal.length, 2);
  assert.throws(() => store.apply([{ op: "weld", id: "cube", distance: 5, vertices: diagonal }]), /pinch/);
  assert.deepEqual(store.snapshot(), before);
});

test("separate moves faces or loose parts into new parts with the same placement", () => {
  const store = createStore(emptyProject("Separate"));
  store.apply([
    box("a", { position: [0, 0.5, 0], rotation: [0, 30, 0] }),
    box("b", { position: [3, 0.5, 0] }),
    { op: "join", id: "a", with: ["b"] },
  ]);
  const before = measure(store.snapshot(), "a").bounds;
  const loose = store.apply([{ op: "separate", id: "a", newId: "part", loose: true }]);
  assert.deepEqual(loose.results[0].created, ["part"]);
  const p = store.snapshot();
  assert.equal(p.nodes.find((n) => n.id === "a").mesh.faces.length, 6);
  assert.deepEqual(p.nodes.find((n) => n.id === "part").rotation, [0, 30, 0]);
  const after = [measure(p, "a").bounds, measure(p, "part").bounds];
  assert.ok(Math.abs(Math.max(after[0].max[0], after[1].max[0]) - before.max[0]) < 1e-9);
  const top = faces(store, "a", { normal: [0, 1, 0] }).map((f) => f.ref);
  store.apply([{ op: "separate", id: "a", newId: "lid", faces: top }]);
  assert.equal(node(store, "lid").mesh.faces.length, 1);
  assert.equal(node(store, "a").mesh.faces.length, 5);
  assert.throws(() => store.apply([{ op: "separate", id: "lid", newId: "x", loose: true }]), /one connected piece/);
  assert.throws(() => store.apply([{ op: "separate", id: "a", newId: "lid", loose: true }]), /already exists|one connected/);
});

test("bridge tunnels between two inset faces; connect splits a face", () => {
  const store = createStore(emptyProject("Bridge"));
  store.apply([box("wall", { options: { size: [2, 2, 0.3] } }), { op: "convert", id: "wall" }]);
  const sides = [[0, 0, 1], [0, 0, -1]].map((n) => faces(store, "wall", { normal: n })[0].ref);
  store.apply([{ op: "inset", id: "wall", faces: sides, distance: 0.5 }]);
  const inner = [[0, 0, 1], [0, 0, -1]].map(
    (n) => faces(store, "wall", { normal: n }).find((f) => Math.hypot(f.center[0], f.center[1]) < 1e-9).ref,
  );
  const bridged = store.apply([{ op: "bridge", id: "wall", faces: inner }]);
  assert.equal(bridged.results[0].faces.length, 4);
  closed(store.snapshot());
  // A hole through: no face covers the middle any more.
  const middle = faces(store, "wall", { normal: [0, 0, 1] }).filter((f) => Math.hypot(f.center[0], f.center[1]) < 0.1);
  assert.equal(middle.length, 0);
  const fresh = faces(store, "wall", { normal: [0, 0, 1] })[0].ref;
  assert.throws(() => store.apply([{ op: "bridge", id: "wall", faces: [fresh, fresh] }]), /two different/);
  assert.throws(() => store.apply([{ op: "bridge", id: "wall", faces: inner }]), /expired/);
  // connect: split the top face along its diagonal.
  store.apply([box("b"), { op: "convert", id: "b" }]);
  const top = node(store, "b").mesh.faces.find((f) => f.id === faces(store, "b", { normal: [0, 1, 0] })[0].id);
  const topology = queryComponents(store.snapshot(), { id: "b", kind: "vertices" }).topology;
  store.apply([{ op: "connect", id: "b", vertices: [top.vertices[0], top.vertices[2]], topology }]);
  assert.equal(node(store, "b").mesh.faces.length, 7);
  closed(store.snapshot());
  const again = queryComponents(store.snapshot(), { id: "b", kind: "vertices" }).topology;
  assert.throws(
    () => store.apply([{ op: "connect", id: "b", vertices: [top.vertices[0], top.vertices[1]], topology: again }]),
    /not already joined/,
  );
});

test("solidify thickens sheets into closed shells and hollows closed solids", () => {
  const sheet = {
    vertices: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]],
    faces: [{ id: "f0", vertices: [0, 3, 2, 1], material: "yellow" }],
  };
  const store = createStore(emptyProject("Solidify"));
  store.apply([{ op: "create", id: "s", kind: "mesh", mesh: sheet }]);
  store.apply([{ op: "solidify", id: "s", thickness: 0.1 }]);
  const b = measure(store.snapshot(), "s").bounds;
  assert.ok(Math.abs(b.min[1] + 0.1) < 1e-9 && Math.abs(b.max[1]) < 1e-9, "offset -1 grows inward");
  assert.equal(node(store, "s").mesh.faces.length, 6);
  closed(store.snapshot());
  // World thickness on a scaled part, centred offset.
  store.apply([{ op: "create", id: "t", kind: "mesh", mesh: sheet, scale: [1, 4, 1] }, { op: "solidify", id: "t", thickness: 0.2, offset: 0 }]);
  const t = measure(store.snapshot(), "t").bounds;
  assert.ok(Math.abs(t.size[1] - 0.2) < 1e-9);
  // A closed box becomes a hollow shell: an intentionally inward cavity, no open edges.
  store.apply([box("c"), { op: "solidify", id: "c", thickness: 0.05 }]);
  assert.equal(node(store, "c").mesh.faces.length, 12);
  const warnings = codes(store.snapshot());
  assert.ok(warnings.includes("inward-shell"));
  closed(store.snapshot(), true);
});

test("bevel handles concave corners when both edges are bevelled; rounded boxes", () => {
  const arch = (cx) => {
    const a0 = Math.asin((0.22 - 0.33) / 0.38), pts = [];
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI - a0 + ((2 * a0 - Math.PI) * i) / 8;
      pts.push([cx + 0.38 * Math.cos(a), 0.33 + 0.38 * Math.sin(a)]);
    }
    return pts;
  };
  const points = [[-2.15, 0.22], ...arch(-1.3), ...arch(1.3), [2.15, 0.22], [2.2, 0.3], [2.2, 0.6], [2.12, 0.76], [0.9, 0.86], [-1.45, 0.88], [-2.12, 0.84], [-2.2, 0.62], [-2.2, 0.3]];
  const store = createStore(emptyProject("Car"));
  store.apply([{ op: "create", id: "body", kind: "extrude", rotation: [0, -90, 0], options: { points, depth: 1.76 } }]);
  store.apply([{ op: "bevel", id: "body", distance: 0.03, select: { kind: "edges", crease: 20 } }]);
  closed(store.snapshot());
  // One bevelled edge at a concave corner is refused with a clear reason.
  const notch = createStore(emptyProject("Notch"));
  notch.apply([{ op: "create", id: "l", kind: "extrude", options: { points: [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]], depth: 0.5 } }]);
  const inner = queryComponents(notch.snapshot(), { id: "l", kind: "edges" }).items.filter(
    (e) => e.endpoints.every((p) => Math.abs(p[1] - 1) < 1e-9) && e.endpoints.some((p) => p[0] > 1.5),
  ).map((e) => e.ref);
  assert.throws(() => notch.apply([{ op: "bevel", id: "l", edges: inner.slice(0, 1), distance: 0.05 }]), /concave corner needs both/);
  // Rounded box: flat sides keep the plain box's IDs f0..f5.
  const rounded = createStore(emptyProject("Rounded"));
  rounded.apply([{ op: "create", id: "r", kind: "box", options: { size: [1, 0.6, 0.4], bevel: 0.08, bevelSegments: 4 } }]);
  const mesh = node(rounded, "r").mesh,
    tops = faces(rounded, "r", { normal: [0, 1, 0] });
  assert.deepEqual(tops.map((f) => f.id), ["f5"]);
  assert.ok(Math.abs(tops[0].area - (1 - 0.16) * (0.4 - 0.16)) < 1e-6);
  assert.ok(mesh.faces.length > 100);
  closed(rounded.snapshot());
  rounded.apply([{ op: "parameters", id: "r", options: { bevelSegments: 2 } }]);
  closed(rounded.snapshot());
  assert.throws(() => rounded.apply([{ op: "parameters", id: "r", options: { bevel: 0.3 } }]), /too wide/);
});

test("new commands validate against the agent schema", () => {
  for (const command of [
    { op: "deleteComponents", id: "a", select: { kind: "faces", normal: [0, 1, 0] } },
    { op: "dissolve", id: "a", angle: 1 },
    { op: "weld", id: "a", distance: 0.001, space: "local" },
    { op: "fill", id: "a", material: "yellow" },
    { op: "bridge", id: "a", faces: ["f1", "f2"], topology: "x" },
    { op: "connect", id: "a", vertices: [0, 2], topology: "x" },
    { op: "solidify", id: "a", thickness: 0.02, offset: 0 },
    { op: "separate", id: "a", newId: "b", loose: true },
    { op: "join", id: "a", with: ["b"] },
    { op: "create", id: "r", kind: "box", options: { size: [1, 1, 1], bevel: 0.1, bevelSegments: 3 } },
  ])
    validateSchema([command], commandsSchema, "commands");
  assert.throws(() => validateSchema([{ op: "join", id: "a" }], commandsSchema, "commands"), /Missing with/);
  assert.equal(meshEdges({ vertices: [], faces: [] }).length, 0);
});
