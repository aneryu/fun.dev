import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createStore, emptyProject, validateProject, normalizeProject, measure, statistics, duckProject, LIMITS } from "../site/workshop/document.js";
import { loadKernel } from "../site/workshop/kernel.js";
import { DenseMesh, DENSE_FROM, packMesh, unpackMesh, isDense, denseCounts, encodeDense, decodeDense } from "../site/workshop/dense.js";
import { queryComponents } from "../site/workshop/components.js";
import { commandsSchema, validateSchema, capabilities } from "../site/workshop/agent-contract.js";
import { DabSampler, mirrors } from "../site/workshop/sculpt.js";

// Dense meshes and sculpting (docs/model-editor.md "Dense meshes and sculpting").
before(() => loadKernel());

const materials = [
  { id: "skin", name: "Skin", color: "#e0b090", roughness: 0.6 },
  { id: "lips", name: "Lips", color: "#b05050", roughness: 0.5 },
];
const fresh = (...commands) => {
  const store = createStore({ ...emptyProject("Dense"), materials });
  if (commands.length) store.apply(commands);
  return store;
};
const node = (store, id) => store.snapshot().nodes.find((n) => n.id === id);
const positions = (store, id) => {
  const mesh = node(store, id).mesh;
  return isDense(mesh) ? Array.from(mesh.dense.positions) : mesh.vertices.flat();
};
const ball = (id = "ball", extra = {}) => ({ op: "create", id, kind: "sphere", material: "skin", options: { radius: 0.5, geodesic: 5 }, ...extra });
const near = (a, b, tolerance, label = "") => assert.ok(Math.abs(a - b) <= tolerance, `${label} ${a} vs ${b}`);

test("packing loses nothing; JSON carries dense meshes as base64", () => {
  const polygon = {
    vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0.5, 0.5, 1]],
    faces: [
      { id: "f0", vertices: [0, 3, 2, 1], material: "skin" },
      { id: "f1", vertices: [0, 1, 4], material: "lips" },
      { id: "f2", vertices: [1, 2, 4], material: "skin" },
      { id: "f3", vertices: [2, 3, 4], material: "skin" },
      { id: "f4", vertices: [3, 0, 4], material: "lips" },
    ],
  };
  const dense = packMesh(polygon);
  assert.ok(dense instanceof DenseMesh);
  assert.deepEqual(unpackMesh(dense), polygon);
  assert.deepEqual(denseCounts(dense), { vertices: 5, faces: 5, triangles: 6 });
  // The read-only view matches and refuses writes.
  assert.deepEqual(dense.faces.map((f) => f.id), ["f0", "f1", "f2", "f3", "f4"]);
  assert.throws(() => {
    dense.vertices[0][0] = 9;
  }, TypeError);
  const decoded = decodeDense(JSON.parse(JSON.stringify(encodeDense(dense.dense))));
  for (const key of ["positions", "offsets", "indices", "faceMaterials"]) assert.deepEqual(Array.from(decoded[key]), Array.from(dense.dense[key]), key);
  assert.deepEqual(decoded.materials, ["skin", "lips"]);
  assert.throws(() => packMesh({ ...polygon, faces: polygon.faces.slice(1) }), /f0, f1/);
  assert.deepEqual(packMesh({ ...polygon, faces: polygon.faces.slice(1) }, { renumber: true }).faces.map((f) => f.id), ["f0", "f1", "f2", "f3"]);
});

test("projects pack large meshes numbered f0, f1, … and keep everything else as it was", () => {
  // Small polygon projects are untouched (the duck normalizes to itself, nothing dense).
  const duck = normalizeProject(duckProject());
  assert.deepEqual(normalizeProject(duck), duck);
  assert.equal(statistics(duck).dense, 0);
  // A geodesic sphere of 20 480 triangles is stored dense, and round-trips through JSON.
  const store = fresh(ball());
  const mesh = node(store, "ball").mesh;
  assert.ok(isDense(mesh), "packed");
  assert.equal(denseCounts(mesh).faces, 20480);
  assert.equal(statistics(store.snapshot()).dense, 1);
  const again = normalizeProject(JSON.parse(JSON.stringify(store.snapshot())));
  assert.deepEqual(Array.from(again.nodes[0].mesh.dense.positions), Array.from(mesh.dense.positions));
  const bytes = ["positions", "offsets", "indices", "faceMaterials"].reduce((n, k) => n + mesh.dense[k].byteLength, 0);
  assert.ok(JSON.stringify(store.snapshot()).length < bytes * 1.4, "base64 (4/3 of the bytes), not decimal numbers");
  // A large mesh whose face IDs have gaps stays polygon while it fits the polygon budget…
  const gappy = fresh(ball(), { op: "convert", id: "ball" });
  const top = queryComponents(gappy.snapshot(), { id: "ball", kind: "faces", normal: [0, 1, 0], largest: true }).items.map((f) => f.ref);
  gappy.apply([{ op: "deleteComponents", id: "ball", faces: top }]);
  assert.ok(!isDense(node(gappy, "ball").mesh), "ids f0…f20479 less one: polygon");
  assert.ok(node(gappy, "ball").mesh.faces.length > DENSE_FROM);
  // …and is renumbered into a dense mesh once it exceeds it.
  const huge = fresh({ op: "create", id: "s", kind: "sphere", material: "skin", options: { radius: 1, segments: 64, rings: 32 } }, { op: "convert", id: "s" }, { op: "subdivide", id: "s", levels: 2 });
  assert.ok(isDense(node(huge, "s").mesh));
  assert.ok(denseCounts(node(huge, "s").mesh).triangles > LIMITS.triangles / 2);
});

test("edits on dense parts: moves, shape edits, paint, mirrors and copies, polygon edits", () => {
  const store = fresh(ball());
  const start = node(store, "ball").mesh;
  store.apply([{ op: "set", id: "ball", position: [0, 1, 0] }]);
  assert.equal(node(store, "ball").mesh.dense, start.dense, "a move keeps the mesh");
  // vertices: one vertex, then a proportional move of its neighbourhood.
  store.apply([{ op: "vertices", id: "ball", changes: [{ index: 0, position: [0, 0.6, 0] }] }]);
  assert.deepEqual(Array.from(node(store, "ball").mesh.dense.positions.subarray(0, 3)), [0, 0.6, 0]);
  assert.equal(node(store, "ball").mesh.dense.indices, start.dense.indices, "faces are shared");
  store.apply([{ op: "vertices", id: "ball", changes: [{ index: 0, position: [0, 0.7, 0] }], falloff: { radius: 0.3 } }]);
  const moved = positions(store, "ball").filter((v, i) => i % 3 === 1 && v > 0.5).length;
  assert.ok(moved > 10, `neighbours follow (${moved})`);
  // Component transforms by face ID.
  store.apply([{ op: "transform", id: "ball", faces: ["f100"], translation: [0, 0, 0.05], space: "local", topology: queryComponents(store.snapshot(), { id: "ball", kind: "faces", limit: 1 }).topology }]);
  // Shape edits keep the faces and give new positions.
  for (const command of [
    { op: "deform", id: "ball", kind: "taper", amount: 0.8 },
    { op: "displace", id: "ball", amount: 0.01, mode: "noise", noise: { scale: 0.2, seed: 3 } },
    { op: "smooth", id: "ball", iterations: 1, factor: 0.3 },
  ]) {
    const before = node(store, "ball").mesh;
    store.apply([command]);
    const after = node(store, "ball").mesh;
    assert.ok(isDense(after) && after.dense.positions !== before.dense.positions && after.dense.indices === before.dense.indices, command.op);
  }
  // Paint: faces by ID, then the whole part; unused material slots drop out.
  store.apply([{ op: "paint", id: "ball", material: "lips", faces: ["f1", "f2"] }]);
  assert.deepEqual(node(store, "ball").mesh.dense.materials, ["skin", "lips"]);
  assert.equal(node(store, "ball").mesh.faces[1].material, "lips");
  store.apply([{ op: "paint", id: "ball", material: "lips" }]);
  assert.deepEqual(node(store, "ball").mesh.dense.materials, ["lips"]);
  assert.equal(statistics(store.snapshot()).drawCalls, 1);
  // Mirror and apply scale make new positions; a mirror turns the faces round.
  const width = measure(store.snapshot(), "ball").bounds.size[0];
  store.apply([{ op: "mirror", id: "ball", axis: "x" }, { op: "set", id: "ball", scale: [2, 1, 1] }, { op: "applyScale", id: "ball" }]);
  near(measure(store.snapshot(), "ball").bounds.size[0], 2 * width, 1e-9, "scaled");
  assert.deepEqual(node(store, "ball").scale, [1, 1, 1]);
  // Linked mirror and copy: the copy shares the source's arrays; an unrelated edit keeps the
  // mirror's mesh object (cached transform).
  store.apply([
    { op: "symmetry", id: "ball", newId: "twin", axis: "x", offset: 1.5, space: "world" },
    { op: "duplicate", id: "ball", newId: "copy", linked: true, offset: [0, 0, 2] },
  ]);
  assert.equal(node(store, "copy").mesh.dense, node(store, "ball").mesh.dense);
  const twin = node(store, "twin").mesh;
  store.apply([{ op: "set", id: "copy", position: [0, 1, 3] }]);
  assert.equal(node(store, "twin").mesh.dense, twin.dense, "mirror reused");
  // A polygon edit unpacks, edits and packs again (new faces appended in order).
  const faces = denseCounts(node(store, "ball").mesh).faces;
  const up = queryComponents(store.snapshot(), { id: "ball", kind: "faces", normal: [0, 1, 0], largest: true }).items.map((f) => f.ref);
  store.apply([{ op: "extrude", id: "ball", faces: up, distance: 0.1 }]);
  assert.ok(isDense(node(store, "ball").mesh));
  assert.equal(denseCounts(node(store, "ball").mesh).faces, faces + 3);
  // Booleans read dense parts.
  const cut = fresh(ball());
  cut.apply([{ op: "boolean", id: "ball", operation: "difference", shape: { kind: "box", options: { size: [2, 2, 2] }, position: [0, 1, 0] } }]);
  near(measure(cut.snapshot(), "ball").bounds.max[1], 0, 1e-6, "the top half cut away");
  assert.deepEqual(validateProject(cut.snapshot()).errors, []);
});

test("undo steps share what an edit did not change; validation reads dense parts", () => {
  const store = fresh(ball());
  const first = node(store, "ball").mesh;
  for (let i = 0; i < 5; i++) store.apply([{ op: "vertices", id: "ball", changes: [{ index: i, position: [0, 0.6 + i * 0.01, 0] }] }]);
  for (let i = 0; i < 5; i++) store.undo();
  assert.equal(node(store, "ball").mesh.dense.positions, first.dense.positions, "undo returns the very arrays");
  store.redo();
  assert.equal(node(store, "ball").mesh.dense.indices, first.dense.indices);
  const v = validateProject(store.snapshot());
  assert.deepEqual(v.errors, []);
  assert.equal(v.checks.selfIntersection, false, "dense meshes report the surface scan unchecked");
  // An open dense mesh reports its open edges.
  const open = fresh(ball(), { op: "convert", id: "ball" });
  // (The geodesic equator lies on y = 0 already: delete the upper faces along it.)
  const lower = queryComponents(open.snapshot(), { id: "ball", kind: "faces", normal: [0, 1, 0], normalTolerance: 1.5 }).items.filter((f) => f.center[1] > 0).map((f) => f.ref);
  open.apply([{ op: "deleteComponents", id: "ball", faces: lower }]);
  const warnings = validateProject(open.snapshot()).warnings.map((w) => w.code);
  assert.ok(warnings.includes("open-edges"), warnings.join(","));
});

test("sculpt brushes: inflate, clay, flatten, crease, smooth and grab do what they say", () => {
  const radiusAt = (store, i) => {
    const p = positions(store, "ball");
    return Math.hypot(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
  };
  const stroke = (brush, extra = {}) => ({ op: "sculpt", id: "ball", brush, radius: 0.2, points: [[0, 0.5, 0], [0.1, 0.49, 0]], ...extra });
  // The vertex nearest the stroke's start.
  const store = fresh(ball());
  const p0 = positions(store, "ball");
  let top = 0;
  for (let i = 0; i < p0.length / 3; i++) if (p0[3 * i + 1] > p0[3 * top + 1]) top = i;
  const r0 = radiusAt(store, top);
  store.apply([stroke("inflate")]);
  assert.ok(radiusAt(store, top) > r0 + 0.005, "inflate pushes out");
  store.apply([stroke("inflate", { invert: true }), stroke("inflate", { invert: true })]);
  assert.ok(radiusAt(store, top) < r0, "deflate pulls in");
  const clay = fresh(ball());
  clay.apply([stroke("clay", { strength: 1 })]);
  assert.ok(radiusAt(clay, top) > r0, "clay builds up");
  // flatten: the cap under the stroke gets flatter (its heights spread less).
  const cap = (s) => {
    const p = positions(s, "ball"),
      ys = [];
    for (let i = 0; i < p.length / 3; i++) if (Math.hypot(p[3 * i], p[3 * i + 2]) < 0.12 && p[3 * i + 1] > 0) ys.push(p[3 * i + 1]);
    return Math.max(...ys) - Math.min(...ys);
  };
  const flat = fresh(ball()),
    spread = cap(flat);
  flat.apply([stroke("flatten", { strength: 1, points: [[0, 0.5, 0]] }), stroke("flatten", { strength: 1, points: [[0, 0.5, 0]] })]);
  assert.ok(cap(flat) < spread * 0.7, `flatten ${cap(flat)} vs ${spread}`);
  // crease presses the line in; smooth then relaxes it back towards the sphere.
  const crease = fresh(ball());
  crease.apply([stroke("crease", { strength: 1 })]);
  assert.ok(radiusAt(crease, top) < r0 - 0.002, "crease presses in");
  const pressed = radiusAt(crease, top);
  crease.apply([stroke("smooth", { strength: 1 }), stroke("smooth", { strength: 1 })]);
  assert.ok(radiusAt(crease, top) > pressed, "smooth relaxes");
  // grab moves the region under the first point by the stroke's offset.
  const grab = fresh(ball());
  grab.apply([{ op: "sculpt", id: "ball", brush: "grab", radius: 0.2, points: [[0, 0.5, 0], [0, 0.6, 0], [0, 0.7, 0]] }]);
  near(positions(grab, "ball")[3 * top + 1], p0[3 * top + 1] + 0.2, 0.01, "the top follows");
  near(measure(grab.snapshot(), "ball").bounds.min[1], -0.5, 1e-9, "the bottom stays");
});

test("strokes: dabs along the points, incremental equals batch, mirrors, world space, determinism", () => {
  const sampler = new DabSampler(0.1),
    points = [[0, 0, 0], [0.25, 0, 0], [0.25, 0.3, 0], [0.26, 0.3, 0]];
  const batch = points.flatMap((p) => sampler.add(p));
  assert.deepEqual(batch.map((d) => d.at.map((v) => +v.toFixed(9))), [[0, 0, 0], [0.1, 0, 0], [0.2, 0, 0], [0.25, 0.05, 0], [0.25, 0.15, 0], [0.25, 0.25, 0]]);
  const again = new DabSampler(0.1),
    pieces = [];
  for (const p of points) pieces.push(...again.add(p));
  assert.deepEqual(pieces, batch);
  assert.deepEqual(mirrors([1, 2, 3], ["x", "z"]), [[1, 2, 3], [1, 2, -3], [-1, 2, 3], [-1, 2, -3]]);
  // Symmetry keeps a symmetric ball symmetric.
  const sym = fresh(ball());
  sym.apply([{ op: "sculpt", id: "ball", brush: "inflate", radius: 0.15, strength: 1, points: [[0.3, 0.3, 0.3], [0.35, 0.1, 0.36]], symmetry: "x" }]);
  const b = measure(sym.snapshot(), "ball").bounds;
  near(b.max[0], -b.min[0], 1e-9, "mirrored dabs");
  // The same stroke on two stores gives the same positions; world space equals local space.
  const a1 = fresh(ball()),
    a2 = fresh(ball("ball", { position: [1, 2, 3], scale: [2, 2, 2] }));
  a1.apply([{ op: "sculpt", id: "ball", brush: "clay", radius: 0.1, points: [[0, 0.5, 0], [0.2, 0.45, 0]] }]);
  a2.apply([{ op: "sculpt", id: "ball", brush: "clay", radius: 0.2, space: "world", points: [[1, 3, 3], [1.4, 2.9, 3]] }]);
  const p1 = positions(a1, "ball"),
    p2 = positions(a2, "ball");
  assert.equal(p1.length, p2.length);
  for (let i = 0; i < p1.length; i++) near(p1[i], p2[i], 1e-9, `vertex coordinate ${i}`);
  // Vertex symmetry: a stroke across the seam stays exactly symmetric, sources on their side.
  const pair = fresh(ball(), { op: "vertexSymmetry", id: "ball", axis: "x", side: 1 });
  pair.apply([{ op: "sculpt", id: "ball", brush: "crease", radius: 0.12, strength: 1, points: [[0.02, 0.4, 0.3], [-0.02, 0.2, 0.45]] }]);
  const s = node(pair, "ball").vertexSymmetry,
    q = positions(pair, "ball");
  for (const [a, m] of s.pairs) {
    near(q[3 * m], -q[3 * a], 1e-12);
    assert.ok(q[3 * a] >= 0);
  }
  // A recipe can carry a stroke, re-applied when its parameters change.
  const recipe = fresh(ball(), {
    op: "recipe",
    id: "ball",
    definition: {
      parameters: { bulge: { value: 0.5, min: 0, max: 1 } },
      generator: { kind: "sphere", options: { radius: 0.5, geodesic: 5 } },
      steps: [{ op: "sculpt", brush: "inflate", radius: 0.2, strength: { $param: "bulge" }, points: [[0, 0.5, 0]] }],
    },
  });
  const low = measure(recipe.snapshot(), "ball").bounds.max[1];
  recipe.apply([{ op: "recipeParameters", id: "ball", values: { bulge: 1 } }]);
  assert.ok(measure(recipe.snapshot(), "ball").bounds.max[1] > low, "the stroke follows its parameter");
  // The schema: a stroke's falloff is a curve name.
  validateSchema([{ op: "sculpt", id: "ball", brush: "grab", radius: 0.1, points: [[0, 0, 0], [0, 1, 0]], falloff: "sharp" }], commandsSchema);
  assert.throws(() => validateSchema([{ op: "sculpt", id: "ball", brush: "pull", radius: 0.1, points: [[0, 0, 0]] }], commandsSchema), /Expected one of/);
  assert.throws(() => sym.apply([{ op: "sculpt", id: "ball", brush: "grab", radius: 0.1, points: [[0, 0, 0]] }]), /at least two points/);
  assert.ok(capabilities().features.includes("sculpting"));
});

test("performance at about 258 000 triangles: strokes, edits and validation", () => {
  const store = fresh({ op: "create", id: "s", kind: "sphere", material: "skin", options: { radius: 1, segments: 64, rings: 32 } }, { op: "convert", id: "s" }, { op: "subdivide", id: "s", levels: 3 });
  const counts = denseCounts(node(store, "s").mesh);
  assert.ok(counts.triangles > 250000, `${counts.triangles} triangles`);
  const time = (label, fn) => {
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    console.log(`  ${label}: ${ms.toFixed(1)} ms`);
    return ms;
  };
  // Warm the caches (first stroke builds the vertex grid and adjacency).
  store.apply([{ op: "sculpt", id: "s", brush: "inflate", radius: 0.05, points: [[0, 1, 0]] }]);
  const stroke = time("a 20-dab inflate stroke", () =>
    store.apply([{ op: "sculpt", id: "s", brush: "inflate", radius: 0.1, points: [[0, 1, 0], [0.5, 0.86, 0]] }]),
  );
  const grab = time("a grab", () => store.apply([{ op: "sculpt", id: "s", brush: "grab", radius: 0.2, points: [[0, -1, 0], [0, -1.2, 0]] }]));
  const edit = time("a vertex edit", () => store.apply([{ op: "vertices", id: "s", changes: [{ index: 10, position: [0, 1.1, 0] }] }]));
  const check = time("validate", () => validateProject(store.snapshot()));
  const undo = time("undo", () => store.undo());
  // Generous bounds for slow machines; the measured numbers are printed above.
  assert.ok(stroke < 250 && grab < 250 && edit < 250 && check < 400 && undo < 50, JSON.stringify({ stroke, grab, edit, check, undo }));
});
