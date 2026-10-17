import test from "node:test";
import assert from "node:assert/strict";
import { Matrix4, Euler, Quaternion, Vector3 } from "three";
import {
  createStore,
  emptyProject,
  duckProject,
  normalizeProject,
  validateProject,
  measure,
} from "../site/editor/document.js";
import { primitive, normal } from "../site/editor/mesh.js";
import { worldMatrix, point } from "../site/editor/spatial.js";

test("command batches roll back geometry, history and revision on failure", () => {
  const store = createStore(duckProject()),
    original = store.snapshot();
  assert.throws(
    () =>
      store.apply([
        { op: "set", id: "beak", position: [0, 2, 0] },
        { op: "set", id: "head", parent: "beak" },
      ]),
    /cycle/,
  );
  assert.deepEqual(store.snapshot(), original);
  assert.equal(store.revision, 0);
  assert.equal(store.canUndo, false);
  store.apply([{ op: "set", id: "beak", scale: [0.6, 0.1, 0.4] }], {
    ifRevision: 0,
  });
  assert.throws(
    () => store.apply([{ op: "delete", id: "duck" }], { ifRevision: 0 }),
    (e) => e.code === "conflict",
  );
  assert.equal(store.revision, 1);
  store.undo();
  assert.deepEqual(store.snapshot(), original);
  store.redo();
  assert.deepEqual(
    store.snapshot().nodes.find((n) => n.id === "beak").scale,
    [0.6, 0.1, 0.4],
  );
  const isolated = store.snapshot();
  isolated.nodes.length = 0;
  assert.equal(store.snapshot().nodes.length, 11);
});

test("closed primitives, concave outline, extrusion and reflection preserve oriented topology", () => {
  for (const kind of [
    "box",
    "sphere",
    "cylinder",
    "cone",
    "lathe",
    "extrude",
  ]) {
    const project = emptyProject();
    const options =
      kind === "lathe"
        ? {
            profile: [
              [0, 0],
              [0.5, 0.3],
              [0.2, 0.7],
              [0, 1],
            ],
          }
        : kind === "extrude"
          ? {
              points: [
                [0, 0],
                [2, 0],
                [2, 1],
                [1, 1],
                [1, 2],
                [0, 2],
              ],
            }
          : {};
    project.nodes.push({
      id: "shape",
      name: kind,
      mesh: primitive(kind, options),
    });
    const store = createStore(project);
    assert.deepEqual(validateProject(store.snapshot()).warnings, [], kind);
    if (kind !== "extrude" && kind !== "lathe") {
      const mesh = store.snapshot().nodes[0].mesh;
      for (const face of mesh.faces) {
        const center = face.vertices.reduce(
          (v, i) =>
            v.map((n, k) => n + mesh.vertices[i][k] / face.vertices.length),
          [0, 0, 0],
        );
        assert.ok(
          normal(mesh.vertices, face.vertices).reduce(
            (n, v, i) => n + v * center[i],
            0,
          ) > 0,
          `${kind} outward face`,
        );
      }
    }
    store.apply([
      { op: "extrude", id: "shape", face: "f0", distance: 0.15 },
      { op: "mirror", id: "shape", axis: "x" },
    ]);
    assert.deepEqual(validateProject(store.snapshot()).warnings, [], kind);
    assert.ok(store.snapshot().nodes[0].mesh.faces.some((f) => f.id === "f0"));
    assert.deepEqual(
      normalizeProject(JSON.parse(JSON.stringify(store.snapshot()))),
      store.snapshot(),
    );
  }
});

test("moving a pivot preserves world vertices and attachment points under rotation and scale", () => {
  const store = createStore(duckProject());
  store.apply([
    { op: "set", id: "head", rotation: [15, 32, 48], scale: [1.2, 0.8, 1.6] },
  ]);
  const positions = (project) => {
    const matrix = (id) => {
      const n = project.nodes.find((n) => n.id === id);
      const m = new Matrix4().compose(
        new Vector3(...n.position),
        new Quaternion().setFromEuler(
          new Euler(...n.rotation.map((v) => (v * Math.PI) / 180)),
        ),
        new Vector3(...n.scale),
      );
      return n.parent ? matrix(n.parent).multiply(m) : m;
    };
    return ["head", "beak", "eye-left", "eye-right"].flatMap((id) =>
      project.nodes
        .find((n) => n.id === id)
        .mesh.vertices.map((v) =>
          new Vector3(...v).applyMatrix4(matrix(id)).toArray(),
        ),
    );
  };
  const before = positions(store.snapshot());
  store.apply([{ op: "pivot", id: "head", offset: [0.3, -0.1, 0.2] }]);
  positions(store.snapshot()).forEach((v, i) =>
    v.forEach((n, k) => assert.ok(Math.abs(n - before[i][k]) < 1e-10)),
  );
});

test("invalid geometry, unknown materials, unsupported versions and duplicate IDs are rejected", () => {
  const store = createStore(duckProject()),
    before = store.snapshot();
  for (const command of [
    { op: "create", id: "head" },
    { op: "paint", id: "head", material: "missing" },
    {
      op: "vertices",
      id: "head",
      changes: [{ index: -1, position: [1, 2, 3] }],
    },
    { op: "set", id: "head", scale: [1, 0, 1] },
    {
      op: "create",
      id: "bad",
      kind: "extrude",
      options: {
        points: [
          [0, 0],
          [1, 1],
          [0, 1],
          [1, 0],
        ],
      },
    },
  ])
    assert.throws(() => store.apply([command]));
  assert.deepEqual(store.snapshot(), before);
  assert.throws(() => store.replace({ ...before, version: 99 }), /version/);
  assert.equal(
    validateProject(before, { triangles: 100 }).warnings[0].code,
    "budget",
  );
});

test("duplicating/deleting a hierarchy keeps independent geometry and valid references", () => {
  const store = createStore(duckProject());
  store.apply([
    { op: "duplicate", id: "head", newId: "second-head", offset: [2, 0, 0] },
  ]);
  const cloned = store
    .snapshot()
    .nodes.filter((n) => n.parent === "second-head");
  assert.equal(cloned.length, 3);
  store.apply([{ op: "delete", id: "head" }]);
  assert.ok(store.snapshot().nodes.some((n) => n.id === "second-head"));
  assert.ok(!store.snapshot().nodes.some((n) => n.id === "beak"));
  assert.equal(validateProject(store.snapshot()).ok, true);
});

const near = (a, b, tolerance = 1e-8) =>
  a.forEach((v, i) =>
    Array.isArray(v)
      ? near(v, b[i], tolerance)
      : assert.ok(Math.abs(v - b[i]) < tolerance, `${v} != ${b[i]}`),
  );
const worldVertices = (p, id) =>
  p.nodes
    .find((n) => n.id === id)
    .mesh.vertices.map((v) => point(worldMatrix(p, id), v));

test("reparenting and applying scale preserve geometry, including shear and parametric children", () => {
  const store = createStore(duckProject());
  store.apply([
    { op: "set", id: "duck", rotation: [11, 28, -9], scale: [1.2, 0.8, 1.5] },
  ]);
  store.apply([{ op: "set", id: "body", rotation: [12, 21, -8] }]);
  const before = store.snapshot(),
    ids = ["body", "wing-left", "wing-right"];
  store.apply([{ op: "set", id: "body", parent: null }]);
  for (const id of ids)
    near(worldVertices(store.snapshot(), id), worldVertices(before, id));
  store.apply([{ op: "applyScale", id: "body" }]);
  for (const id of ids)
    near(worldVertices(store.snapshot(), id), worldVertices(before, id));
  const roundTrip = createStore(
    JSON.parse(JSON.stringify(store.snapshot())),
  ).snapshot();
  for (const id of ids)
    near(worldVertices(roundTrip, id), worldVertices(before, id));
});

test("world extrusion uses meters; local extrusion remains explicit", () => {
  for (const space of ["world", "local"]) {
    const store = createStore();
    store.apply([{ op: "create", id: "seat", scale: [0.6, 0.08, 0.6] }]);
    const before = measure(store.snapshot(), "seat").bounds.max[1];
    store.apply([
      { op: "extrude", id: "seat", face: "f5", distance: 0.1, space },
    ]);
    near(
      [measure(store.snapshot(), "seat").bounds.max[1] - before],
      [space === "world" ? 0.1 : 0.008],
    );
    assert.deepEqual(validateProject(store.snapshot()).warnings, []);
  }
});

test("mirrors follow source shape and transform across a world plane, including hierarchy", () => {
  const store = createStore(duckProject());
  store.apply([
    {
      op: "symmetry",
      id: "head",
      newId: "mirror-head",
      axis: "x",
      offset: 2,
      linked: true,
    },
  ]);
  store.apply([
    {
      op: "set",
      id: "head",
      position: [0.3, 1.7, 0.6],
      rotation: [10, 25, 8],
      scale: [1.1, 0.8, 1.2],
    },
    { op: "parameters", id: "head", options: { radius: 0.6 } },
  ]);
  const p = store.snapshot();
  for (const target of p.nodes.filter((n) => n.id.startsWith("mirror-head")))
    near(
      worldVertices(p, target.id),
      worldVertices(p, target.symmetry.source).map(([x, y, z]) => [
        4 - x,
        y,
        z,
      ]),
    );
  assert.throws(
    () => store.apply([{ op: "set", id: "mirror-head", position: [0, 0, 0] }]),
    /Unlink/,
  );
  store.apply([{ op: "unlink", id: "mirror-head" }]);
  const frozen = worldVertices(store.snapshot(), "mirror-head");
  store.apply([{ op: "set", id: "head", position: [3, 0, 0] }]);
  near(worldVertices(store.snapshot(), "mirror-head"), frozen);
});

test("linked copies update all legs while retaining independent placements", () => {
  const store = createStore();
  store.apply([
    {
      op: "create",
      id: "leg",
      scale: [0.08, 0.42, 0.08],
      position: [-0.24, 0.21, 0.24],
    },
    {
      op: "duplicate",
      id: "leg",
      newId: "leg2",
      offset: [0.48, 0, 0],
      linked: true,
    },
  ]);
  store.apply([
    {
      op: "transform",
      id: "leg",
      vertices: [0, 1, 4, 5],
      scale: [0.6, 1, 0.6],
      space: "local",
    },
  ]);
  const p = store.snapshot();
  assert.deepEqual(p.nodes[0].mesh, p.nodes[1].mesh);
  near(p.nodes[1].position, [0.24, 0.21, 0.24]);
  const linkedBefore = worldVertices(store.snapshot(), "leg2");
  store.apply([{ op: "applyScale", id: "leg" }]);
  near(worldVertices(store.snapshot(), "leg2"), linkedBefore);
  store.apply([{ op: "ground", ids: ["leg", "leg2"] }]);
  near([measure(store.snapshot(), "leg2").bounds.min[1]], [0]);
  store.apply([{ op: "delete", id: "leg" }]);
  assert.equal(store.snapshot().nodes[0].instanceOf, undefined);
  assert.equal(validateProject(store.snapshot()).ok, true);
});

test("linked dependency cycles are rejected before modifying the document", () => {
  const store = createStore(duckProject()),
    before = store.snapshot();
  assert.throws(
    () => store.apply([{ op: "set", id: "wing-left", parent: "wing-right" }]),
    /cycle/,
  );
  assert.deepEqual(store.snapshot(), before);
});

test("hollow lathe profiles retain parameters and regenerate as closed oriented solids", () => {
  const store = createStore();
  const profile = [
    [0, 0],
    [0.3, 0],
    [0.45, 0.7],
    [0.4, 0.7],
    [0.26, 0.06],
    [0, 0.06],
  ];
  store.apply([
    {
      op: "create",
      id: "pot",
      kind: "lathe",
      options: { profile, segments: 8 },
    },
  ]);
  assert.deepEqual(validateProject(store.snapshot()).warnings, []);
  store.apply([{ op: "parameters", id: "pot", options: { segments: 12 } }]);
  assert.equal(store.snapshot().nodes[0].generator.options.segments, 12);
  assert.deepEqual(validateProject(store.snapshot()).warnings, []);
  const mesh = store.snapshot().nodes[0].mesh;
  store.apply([{ op: "convert", id: "pot" }]);
  assert.deepEqual(store.snapshot().nodes[0].mesh, mesh);
  assert.equal(store.snapshot().nodes[0].generator, undefined);
  store.undo();
  assert.ok(store.snapshot().nodes[0].generator);
});

test("bevel and inset/extrude retain closed geometry, reject over-wide operations atomically", () => {
  const store = createStore();
  store.apply([{ op: "create", id: "box" }]);
  const before = store.snapshot();
  assert.throws(
    () => store.apply([{ op: "bevel", id: "box", distance: 1 }]),
    /wide/,
  );
  assert.deepEqual(store.snapshot(), before);
  store.apply([{ op: "bevel", id: "box", distance: 0.1 }]);
  assert.deepEqual(validateProject(store.snapshot()).warnings, []);
  assert.equal(store.snapshot().nodes[0].mesh.faces.length, 26);
  near(measure(store.snapshot(), "box").bounds.size, [1, 1, 1]);
  store.undo();
  store.apply([
    { op: "inset", id: "box", face: "f5", distance: 0.1 },
    { op: "extrude", id: "box", face: "f5", distance: -0.2 },
  ]);
  assert.deepEqual(validateProject(store.snapshot()).warnings, []);
});

test("batch object transforms avoid double-transforming children; dimensions and alignment use world bounds", () => {
  const store = createStore(duckProject()),
    before = worldVertices(store.snapshot(), "beak");
  store.apply([
    { op: "transform", ids: ["head", "beak"], translation: [1, 2, 3] },
  ]);
  near(
    worldVertices(store.snapshot(), "beak"),
    before.map((v) => v.map((n, i) => n + [1, 2, 3][i])),
  );
  store.apply([{ op: "dimensions", id: "head", size: [1, 2, 3] }]);
  near(measure(store.snapshot(), "head").bounds.size, [1, 2, 3]);
  store.apply([
    {
      op: "align",
      ids: ["head", "body"],
      axis: "y",
      mode: "min",
      reference: "body",
    },
  ]);
  near(
    [measure(store.snapshot(), "head").bounds.min[1]],
    [measure(store.snapshot(), "body").bounds.min[1]],
  );
});

test("dependent commands in one batch see synchronized copies, with one undo", async () => {
  const { stoolProject } = await import("../site/editor/examples.js");
  const base = stoolProject(),
    batch = createStore(base),
    sequential = createStore(base);
  const ids = ["leg", "leg-right", "leg-back", "leg-back-right"];
  const commands = [
    {
      op: "transform",
      id: "leg",
      vertices: [0, 1, 4, 5],
      translation: [0, -0.1, 0],
    },
    { op: "ground", ids },
  ];
  batch.apply(commands);
  commands.forEach((c) => sequential.apply([c]));
  assert.deepEqual(batch.snapshot(), sequential.snapshot());
  for (const id of ids)
    assert.ok(Math.abs(measure(batch.snapshot(), id).bounds.min[1]) < 1e-8);
  batch.undo();
  assert.deepEqual(batch.snapshot(), base);
  assert.ok(
    batch.apply([{ op: "delete", id: "seat" }]).removed.includes("seat"),
  );
  assert.deepEqual(
    batch.apply([{ op: "material", id: "wood", color: "#123456" }]).materials,
    ["wood"],
  );
});

test("paired symmetry moves along its plane and a group carries the plane with the pair", () => {
  const s = createStore(duckProject()),
    ids = ["wing-left", "wing-right"];
  const before = ids.map((id) => measure(s.snapshot(), id).bounds.center);
  s.apply([{ op: "transform", ids, translation: [0, 0.2, 0] }]);
  ids.forEach((id, i) =>
    assert.ok(
      Math.abs(
        measure(s.snapshot(), id).bounds.center[1] - before[i][1] - 0.2,
      ) < 1e-7,
    ),
  );
  const saved = s.snapshot();
  assert.throws(
    () => s.apply([{ op: "transform", ids, translation: [0.2, 0, 0] }]),
    /Group/,
  );
  assert.deepEqual(s.snapshot(), saved);
  s.apply([{ op: "group", ids, newId: "wings" }]);
  const grouped = ids.map((id) => measure(s.snapshot(), id).bounds.center);
  s.apply([{ op: "transform", id: "wings", translation: [0.3, 0.2, -0.1] }]);
  ids.forEach((id, i) =>
    measure(s.snapshot(), id).bounds.center.forEach((v, k) =>
      assert.ok(Math.abs(v - grouped[i][k] - [0.3, 0.2, -0.1][k]) < 1e-7),
    ),
  );
  assert.deepEqual(validateProject(s.snapshot()).warnings, []);
});

test("selected-edge bevel finishes a concave recessed box and rejects excessive widths atomically", async () => {
  const { meshEdges } = await import("../site/editor/topology.js");
  const s = createStore(emptyProject());
  s.apply([
    {
      op: "create",
      id: "box",
      kind: "box",
      options: { size: [0.6, 0.4, 0.4] },
    },
    { op: "convert", id: "box" },
    { op: "inset", id: "box", face: "f5", distance: 0.04 },
    { op: "extrude", id: "box", face: "f5", distance: -0.05 },
  ]);
  const mesh = () => s.snapshot().nodes[0].mesh;
  // Outer top perimeter, then the recessed floor boundary, on the same solid.
  let edges = meshEdges(mesh())
    .filter(
      (e) =>
        e.vertices.every((i) => Math.abs(mesh().vertices[i][1] - 0.2) < 1e-8) &&
        e.vertices.every(
          (i) =>
            Math.abs(mesh().vertices[i][0]) > 0.29 ||
            Math.abs(mesh().vertices[i][2]) > 0.19,
        ),
    )
    .map((e) => e.id);
  s.apply([{ op: "bevel", id: "box", edges, distance: 0.008 }]);
  assert.deepEqual(validateProject(s.snapshot()).warnings, []);
  edges = meshEdges(mesh())
    .filter((e) => e.sides.some((side) => side.face === "f5"))
    .map((e) => e.id);
  const before = s.snapshot();
  assert.throws(() =>
    s.apply([{ op: "bevel", id: "box", edges, distance: 2 }]),
  );
  assert.deepEqual(s.snapshot(), before);
  s.apply([{ op: "bevel", id: "box", edges, distance: 0.008 }]);
  assert.deepEqual(validateProject(s.snapshot()).warnings, []);
  assert.ok(s.snapshot().nodes[0].mesh.faces.length > 20);
});

test("quad loop and plane cuts retain closed geometry and bounds", () => {
  for (const op of [
    { op: "loopCut", edge: "0:1", ratio: 0.3 },
    { op: "cut", axis: "y", offset: 0.1 },
  ]) {
    const s = createStore(emptyProject());
    s.apply([{ op: "create", id: "box", kind: "box" }]);
    const before = measure(s.snapshot(), "box").bounds;
    s.apply([{ ...op, id: "box" }]);
    assert.deepEqual(validateProject(s.snapshot()).warnings, []);
    assert.deepEqual(measure(s.snapshot(), "box").bounds, before);
    assert.equal(s.snapshot().nodes[0].mesh.faces.length, 10);
  }
});

test("numeric local multi-selection transforms use the active object's frame", () => {
  const s=createStore(emptyProject());
  s.apply([{op:'create',id:'a',kind:'box'},{op:'create',id:'b',kind:'box',position:[2,0,0],rotation:[0,90,0]}]);
  const ids=['a','b'],before=ids.map(id=>measure(s.snapshot(),id).bounds.center);
  s.apply([{op:'transform',ids,translation:[1,0,0],space:'local'}]);
  ids.forEach((id,i)=>measure(s.snapshot(),id).bounds.center.forEach((v,k)=>assert.ok(Math.abs(v-before[i][k]-[0,0,-1][k])<1e-7)));
});
