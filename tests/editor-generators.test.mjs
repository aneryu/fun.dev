import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  createStore,
  emptyProject,
  validateProject,
} from "../site/workshop/document.js";
import { primitive } from "../site/workshop/mesh.js";
import { loadKernel } from "../site/workshop/kernel.js";
import { roundOutline } from "../site/workshop/generators.js";

before(() => loadKernel());

// A closed, consistently oriented, non-intersecting solid. Curved sweeps keep slightly
// non-planar quads, which validation reports separately.
function solid(project, id) {
  const v = validateProject(project);
  assert.deepEqual(v.errors, [], JSON.stringify(v.errors));
  const bad = v.warnings.filter(
    (w) =>
      (!id || w.node === id) &&
      ["open-edges", "nonmanifold", "inward-shell", "surface-check-incomplete"].includes(w.code),
  );
  assert.deepEqual(bad, []);
  return project.nodes.find((n) => n.id === id)?.mesh;
}
const create = (id, kind, options, extra = {}) => {
  const store = createStore(emptyProject("Generators"));
  store.apply([{ op: "create", id, kind, options, ...extra }]);
  return store;
};
const bounds = (mesh) =>
  [0, 1, 2].map((k) => [
    Math.min(...mesh.vertices.map((v) => v[k])),
    Math.max(...mesh.vertices.map((v) => v[k])),
  ]);

test("plain extrusions are unchanged; rounded outlines keep the prism layout", () => {
  const points = [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]];
  assert.deepEqual(
    primitive("extrude", { points, depth: 0.2, holes: [], round: 0 }),
    primitive("extrude", { points, depth: 0.2 }),
  );
  const store = create("plate", "extrude", { points, depth: 0.2, round: 0.2, roundSegments: 4 });
  const mesh = solid(store.snapshot(), "plate");
  // Four corners of five points each; caps f0/f1, then one side per outline edge.
  assert.equal(mesh.vertices.length, 2 * 4 * 5);
  assert.equal(mesh.faces.length, 2 + 20);
  assert.deepEqual(mesh.faces.slice(0, 2).map((f) => f.id), ["f0", "f1"]);
  assert.deepEqual(bounds(mesh)[0], [-1, 1], "fillets stay tangent to the straight edges");
  assert.ok(!mesh.vertices.some(([x, y]) => Math.abs(Math.abs(x) - 1) < 1e-9 && Math.abs(Math.abs(y) - 0.5) < 1e-9), "no sharp corner remains");
  // Concave corners fill in: the L's inner corner arc bulges into the notch.
  const l = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
  const rounded = roundOutline(l, 0.25, 6);
  assert.equal(rounded.length, 6 * 7);
  assert.ok(rounded.some(([x, y]) => x > 1.0001 && y > 1.0001 && x < 1.25 && y < 1.25));
});

test("extrusions with holes build closed walls with a few editable cap pieces", () => {
  const store = create("wall", "extrude", {
    points: [[-1.5, 0], [1.5, 0], [1.5, 2.8], [-1.5, 2.8]],
    depth: 0.2,
    holes: [
      [[-1.1, 0.9], [-0.3, 0.9], [-0.3, 2.1], [-1.1, 2.1]],
      [[0.3, 0.9], [1.1, 0.9], [1.1, 2.1], [0.3, 2.1]],
    ],
  });
  const mesh = solid(store.snapshot(), "wall");
  const inner = mesh.faces.filter((f) => {
    const vs = f.vertices.map((i) => mesh.vertices[i]);
    return vs.every((v) => v[1] >= 0.9 - 1e-6 && v[1] <= 2.1 + 1e-6) && vs.some((v) => Math.abs(v[2]) < 0.1 - 1e-6 || Math.abs(Math.abs(v[2]) - 0.1) < 1e-6) && vs.every((v) => Math.abs(v[0]) <= 1.1 + 1e-6 && Math.abs(v[0]) >= 0.3 - 1e-6);
  });
  assert.ok(inner.length >= 8, "eight window reveals");
  assert.ok(mesh.faces.length <= 20, `${mesh.faces.length} faces`);
  // Rounded holes: arched reveals stay closed.
  const arch = create("arch", "extrude", {
    points: [[-1.5, 0], [1.5, 0], [1.5, 2.8], [-1.5, 2.8]],
    depth: 0.24,
    holes: [[[-0.5, 0], [0.5, 0], [0.5, 2.2], [-0.5, 2.2]].map(([x, y]) => [x, y === 0 ? 0.3 : y])],
    round: 0.4,
    roundSegments: 6,
  });
  solid(arch.snapshot(), "arch");
  // A hole outside the outline is rejected atomically.
  const before = store.snapshot();
  assert.throws(
    () => store.apply([{ op: "create", id: "bad", kind: "extrude", options: { points: [[0, 0], [1, 0], [1, 1], [0, 1]], holes: [[[2, 2], [3, 2], [3, 3]]] } }]),
    /inside the outline/,
  );
  assert.deepEqual(store.snapshot(), before);
});

test("revolve: full rings, and partial elbows with caps on the +X, −Z quadrant", () => {
  const section = [[0.4, -0.1], [0.6, -0.1], [0.6, 0.1], [0.4, 0.1]];
  const ring = create("ring", "revolve", { profile: section, segments: 12 });
  const full = solid(ring.snapshot(), "ring");
  assert.equal(full.vertices.length, 12 * 4);
  const elbow = create("elbow", "revolve", { profile: section, segments: 16, angle: 90 });
  const mesh = solid(elbow.snapshot(), "elbow");
  // 16 segments per circle: four along a quarter turn, two caps with the section's corners.
  assert.equal(mesh.vertices.length, 5 * 4);
  // Flat top and bottom merge into one polygon each; four inner, four outer, two caps.
  assert.equal(mesh.faces.length, 12);
  assert.equal(mesh.faces.filter((f) => f.vertices.length === 10).length, 2);
  const [x, y, z] = bounds(mesh);
  assert.ok(x[0] > -1e-6 && z[1] < 1e-6, `quadrant ${JSON.stringify([x, z])}`);
  assert.deepEqual(y, [-0.1, 0.1]);
  // Sections cannot cross the axis.
  assert.throws(() => primitive("revolve", { profile: [[-0.1, 0], [0.5, 0], [0.5, 1]] }, "yellow"), /x ≥ 0/);
});

test("sweep: rotation-minimising frames along a 3D path, mitred corners, closed loops", () => {
  const square = [[-0.05, -0.05], [0.05, -0.05], [0.05, 0.05], [-0.05, 0.05]];
  // A level straight path keeps the profile's y on world +Y.
  const level = primitive("sweep", { profile: square, path: [[0, 0, 0], [2, 0, 0]] }, "yellow");
  const [, ly] = bounds(level);
  assert.deepEqual(ly, [-0.05, 0.05]);
  // A helix: the frame turns smoothly, never flipping between rings.
  const helix = Array.from({ length: 25 }, (_, i) => {
    const a = (i / 24) * Math.PI * 3;
    return [Math.cos(a), i * 0.06, Math.sin(a)];
  });
  const store = create("coil", "sweep", { profile: square, path: helix, smooth: true, pathSegments: 3, round: 0.02 });
  const mesh = solid(store.snapshot(), "coil");
  const n = mesh.faces[0].vertices.length,
    rings = mesh.vertices.length / n;
  const centre = (r) => [0, 1, 2].map((k) => mesh.vertices.slice(r * n, r * n + n).reduce((s, v) => s + v[k], 0) / n);
  let worst = 0;
  for (let r = 1; r < rings; r++) {
    const a = mesh.vertices[r * n].map((v, k) => v - centre(r)[k]),
      b = mesh.vertices[(r - 1) * n].map((v, k) => v - centre(r - 1)[k]);
    const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b);
    worst = Math.max(worst, Math.acos(Math.min(1, cos)));
  }
  assert.ok(worst < 0.5, `largest ring-to-ring turn ${worst} rad`);
  // A 90° polyline corner keeps the full thickness through a mitre.
  const corner = primitive("sweep", { profile: square, path: [[0, 0, 0], [1, 0, 0], [1, 0, 1]] }, "yellow");
  const mid = corner.vertices.slice(4, 8);
  // Unmitred, the corner ring would reach 0.05 sideways; the mitre stretches it by √2.
  const spread = Math.max(...mid.map((v) => Math.hypot(v[0] - 1, v[2])));
  assert.ok(Math.abs(spread - 0.05 * Math.SQRT2) < 1e-9, `mitre ${spread}`);
  // A closed 3D loop: no caps, the seam meets without a twist.
  const loop = create("loop", "sweep", {
    profile: square,
    closed: true,
    smooth: true,
    path: [[1, 0, 0], [0, 0.4, 1], [-1, 0, 0], [0, -0.4, -1]],
  });
  const closed = solid(loop.snapshot(), "loop");
  assert.ok(closed.faces.every((f) => f.vertices.length === 4), "no caps on a closed path");
  // Sharp reversals fail clearly.
  assert.throws(() => primitive("sweep", { profile: square, path: [[0, 0, 0], [1, 0, 0], [0, 0, 0.01]] }, "yellow"), /150°|back on itself/);
});

test("new kinds take recipe parameters: a parametric window and a revolve angle", () => {
  const store = createStore(emptyProject("Recipe"));
  store.apply([
    { op: "create", id: "wall", kind: "box" },
    {
      op: "recipe",
      id: "wall",
      definition: {
        parameters: { w: { value: 0.8, min: 0.2, max: 2 } },
        generator: {
          kind: "extrude",
          options: {
            points: [[-1.5, 0], [1.5, 0], [1.5, 2.8], [-1.5, 2.8]],
            depth: 0.2,
            holes: [[[{ $param: "w", factor: -0.5 }, 0.9], [{ $param: "w", factor: 0.5 }, 0.9], [{ $param: "w", factor: 0.5 }, 2.1], [{ $param: "w", factor: -0.5 }, 2.1]]],
          },
        },
        steps: [],
      },
    },
  ]);
  const width = () => {
    const m = store.snapshot().nodes[0].mesh;
    const xs = m.vertices.filter((v) => v[1] > 0.85 && v[1] < 2.15).map((v) => Math.abs(v[0]));
    return 2 * Math.max(...xs.filter((x) => x < 1.4));
  };
  assert.ok(Math.abs(width() - 0.8) < 1e-6);
  store.apply([{ op: "recipeParameters", id: "wall", values: { w: 1.2 } }]);
  assert.ok(Math.abs(width() - 1.2) < 1e-6);
  solid(store.snapshot(), "wall");
  // The elbow's turn is a parameter too: a half turn reaches −X.
  store.apply([
    { op: "create", id: "elbow", kind: "box" },
    {
      op: "recipe",
      id: "elbow",
      definition: {
        parameters: { turn: { value: 90, min: 10, max: 360 } },
        generator: { kind: "revolve", options: { profile: [[0.4, -0.1], [0.6, -0.1], [0.6, 0.1], [0.4, 0.1]], segments: 16, angle: { $param: "turn" } } },
        steps: [],
      },
    },
  ]);
  const minX = () => Math.min(...store.snapshot().nodes.find((n) => n.id === "elbow").mesh.vertices.map((v) => v[0]));
  assert.ok(minX() > -1e-6);
  store.apply([{ op: "recipeParameters", id: "elbow", values: { turn: 180 } }]);
  assert.ok(Math.abs(minX() + 0.6) < 1e-6);
  solid(store.snapshot(), "elbow");
});

test("array: linked copies with named parts, radial copies about a pivot, merged recipe repetition", () => {
  const store = createStore(emptyProject("Fence"));
  store.apply([
    { op: "create", id: "post", kind: "group" },
    { op: "create", id: "post_cap", kind: "box", parent: "post", position: [0, 1, 0], options: { size: [0.12, 0.05, 0.12] } },
    { op: "create", id: "post_body", kind: "box", parent: "post", position: [0, 0.5, 0], options: { size: [0.1, 1, 0.1] } },
  ]);
  const made = store.apply([{ op: "array", id: "post", count: 4, offset: [1, 0, 0] }]);
  assert.deepEqual(made.results[0].copies.map((c) => c.root), ["post_2", "post_3", "post_4"]);
  let p = store.snapshot();
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  assert.deepEqual(byId.get("post_4").position, [3, 0, 0]);
  assert.equal(byId.get("post_cap_3").parent, "post_3");
  assert.equal(byId.get("post_cap_3").instanceOf, "post_cap");
  // Radial: six seats around the origin, each turned to face it.
  store.apply([
    { op: "create", id: "seat", kind: "box", position: [2, 0.25, 0], options: { size: [0.4, 0.5, 0.4] } },
    { op: "array", id: "seat", count: 6, rotation: [0, 60, 0], pivot: [0, 0, 0], linked: false, newIds: ["seat_b", "seat_c", "seat_d", "seat_e", "seat_f"] },
  ]);
  p = store.snapshot();
  for (const id of ["seat", "seat_b", "seat_c", "seat_d", "seat_e", "seat_f"]) {
    const n = p.nodes.find((v) => v.id === id);
    assert.ok(Math.abs(Math.hypot(n.position[0], n.position[2]) - 2) < 1e-9, id);
    assert.equal(n.instanceOf, undefined);
  }
  const seatD = p.nodes.find((v) => v.id === "seat_d");
  assert.ok(Math.abs(seatD.position[0] + 2) < 1e-9, "the fourth seat sits opposite");
  // Merged repetition in a recipe: picket count is a parameter.
  store.apply([
    { op: "create", id: "pickets", kind: "box", position: [0, 0, 3], options: { size: [0.08, 0.9, 0.03] } },
    {
      op: "recipe",
      id: "pickets",
      definition: {
        parameters: { n: { value: 5, min: 2, max: 40 } },
        generator: { kind: "box", options: { size: [0.08, 0.9, 0.03] } },
        steps: [{ op: "array", count: { $param: "n" }, offset: [0.15, 0, 0] }],
      },
    },
  ]);
  const faces = () => store.snapshot().nodes.find((n) => n.id === "pickets").mesh.faces.length;
  assert.equal(faces(), 5 * 6);
  store.apply([{ op: "recipeParameters", id: "pickets", values: { n: 9 } }]);
  assert.equal(faces(), 9 * 6);
  solid(store.snapshot(), "pickets");
  // Overlapping merged copies are separate shells passing through each other: allowed,
  // reported as a warning.
  store.apply([{ op: "array", id: "post_body", count: 2, offset: [0.05, 0, 0], merge: true }]);
  const overlap = validateProject(store.snapshot());
  assert.equal(overlap.errors.length, 0);
  assert.ok(overlap.warnings.some((w) => w.code === "shell-overlap" && w.node === "post_body"));
  assert.throws(() => store.apply([{ op: "array", id: "post", count: 3 }]), /offset or a rotation/);
  assert.throws(() => store.apply([{ op: "array", id: "post", count: 3, offset: [1, 0, 0] }]), /already exists/);
});
