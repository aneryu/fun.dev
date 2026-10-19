import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createStore, emptyProject, validateProject, measure } from "../site/workshop/document.js";
import { queryComponents } from "../site/workshop/components.js";
import { capabilities, commandsSchema, validateSchema } from "../site/workshop/agent-contract.js";
import { loadKernel } from "../site/workshop/kernel.js";
import { falloffWeight, formula, fbm3, vertexNormals } from "../site/workshop/deform.js";
import { primitive } from "../site/workshop/mesh.js";

// Shape edits (docs/model-editor.md "Deformers, displacement, smoothing and subdivision").
before(() => loadKernel());

const codes = (project) => {
  const v = validateProject(project);
  assert.deepEqual(v.errors, []);
  return v.warnings.map((w) => w.code);
};
const closed = (project) =>
  assert.deepEqual(codes(project).filter((c) => ["open-edges", "nonmanifold", "inward-shell"].includes(c)), []);
const node = (store, id) => store.snapshot().nodes.find((n) => n.id === id);
const near = (a, b, tolerance = 1e-9, label = "") => assert.ok(Math.abs(a - b) <= tolerance, `${label} ${a} vs ${b}`);
const box = (id, size = [1, 1, 1], extra = {}) => ({ op: "create", id, kind: "box", options: { size }, ...extra });
const fresh = (...commands) => {
  const store = createStore(emptyProject("Shape"));
  store.apply(commands);
  return store;
};

test("taper scales the lateral axes along the range; from, to, pivot and power shape it", () => {
  const store = fresh(box("b", [1, 2, 1]), { op: "convert", id: "b" });
  store.apply([{ op: "deform", id: "b", kind: "taper", amount: 0.5 }]);
  const top = node(store, "b").mesh.vertices.filter((v) => v[1] > 0),
    bottom = node(store, "b").mesh.vertices.filter((v) => v[1] < 0);
  top.forEach((v) => [v[0], v[2]].forEach((c) => near(Math.abs(c), 0.25, 1e-9, "top")));
  bottom.forEach((v) => [v[0], v[2]].forEach((c) => near(Math.abs(c), 0.5, 1e-9, "bottom")));
  // A range in the lower half: everything above `to` takes the full taper.
  const ranged = fresh(box("b", [1, 2, 1]), { op: "convert", id: "b" }, { op: "deform", id: "b", kind: "taper", amount: [0.5, 1], from: -1, to: 0 });
  ranged.snapshot().nodes[0].mesh.vertices.filter((v) => v[1] > 0).forEach((v) => {
    near(Math.abs(v[0]), 0.25, 1e-9, "x tapered");
    near(Math.abs(v[2]), 0.5, 1e-9, "z kept");
  });
  // The pivot moves the axis line: tapering about x = 0.5 leaves that side in place.
  const pivot = fresh(box("b", [1, 2, 1]), { op: "convert", id: "b" }, { op: "deform", id: "b", kind: "taper", amount: [0.5, 1], pivot: [0.5, 0, 0] });
  const pivotTop = pivot.snapshot().nodes[0].mesh.vertices.filter((v) => v[1] > 0).map((v) => v[0]);
  near(Math.max(...pivotTop), 0.5, 1e-9, "pivot side stays");
  near(Math.min(...pivotTop), 0, 1e-9, "the far side comes halfway");
  // power bends the ramp: with power 2 the middle is tapered a quarter of the way.
  const curved = fresh(
    { op: "create", id: "c", kind: "cylinder", options: { radius: 1, height: 2, segments: 8 } },
    { op: "convert", id: "c" },
    { op: "cut", id: "c", axis: "y", offset: 0 },
    { op: "deform", id: "c", kind: "taper", amount: 0.2, power: 2 },
  );
  const middle = curved.snapshot().nodes[0].mesh.vertices.filter((v) => Math.abs(v[1]) < 1e-9);
  assert.ok(middle.length >= 8);
  middle.forEach((v) => near(Math.hypot(v[0], v[2]), 0.8, 1e-9, "middle ring"));
  assert.throws(() => store.apply([{ op: "deform", id: "b", kind: "taper", amount: 0.5, from: 1, to: 0 }]), /above from/);
  assert.throws(() => store.apply([{ op: "deform", id: "b", kind: "squash", amount: 0.5 }]), /Expected one of|kind/);
});

test("twist turns the lateral plane about the axis, growing along the range", () => {
  const store = fresh(
    { op: "create", id: "c", kind: "cylinder", options: { radius: 1, height: 2, segments: 8 } },
    { op: "convert", id: "c" },
    { op: "cut", id: "c", axis: "y", offset: 0 },
  );
  const before = node(store, "c").mesh.vertices.map((v) => [...v]);
  store.apply([{ op: "deform", id: "c", kind: "twist", angle: 90 }]);
  const after = node(store, "c").mesh.vertices;
  before.forEach((v, i) => {
    const expected = v[1] < -0.5 ? 0 : v[1] > 0.5 ? 90 : 45,
      a = (expected * Math.PI) / 180;
    // A positive turn about +Y takes +X towards −Z.
    near(after[i][0], v[0] * Math.cos(a) + v[2] * Math.sin(a), 1e-9, "x");
    near(after[i][2], -v[0] * Math.sin(a) + v[2] * Math.cos(a), 1e-9, "z");
    near(after[i][1], v[1], 1e-12, "y");
  });
  closed(store.snapshot());
});

test("bend turns the range into an arc of the angle towards the direction; what lies beyond continues straight", () => {
  const store = fresh(box("bar", [0.2, 2, 0.2]), { op: "convert", id: "bar" }, { op: "subdivide", id: "bar", levels: 2, smooth: false });
  store.apply([{ op: "deform", id: "bar", kind: "bend", angle: 90 }]);
  const b = measure(store.snapshot(), "bar").bounds,
    radius = 2 / (Math.PI / 2);
  near(b.max[0], radius, 1e-9, "the end reaches the arc's radius along +x");
  near(b.max[1], -1 + radius + 0.1, 1e-9, "the end's height");
  near(b.min[1], -1, 1e-12, "the base stays");
  near(b.min[2], -0.1, 1e-12);
  closed(store.snapshot());
  // Bending the lower half only: the upper half continues along the end tangent (+x).
  const half = fresh(box("bar", [0.2, 2, 0.2]), { op: "convert", id: "bar" }, { op: "subdivide", id: "bar", levels: 2, smooth: false });
  half.apply([{ op: "deform", id: "bar", kind: "bend", angle: 90, from: -1, to: 0 }]);
  const hb = measure(half.snapshot(), "bar").bounds;
  near(hb.max[0], 1 / (Math.PI / 2) + 1, 1e-9, "the straight half runs along +x");
  // Negative angles bend the other way; the direction can be z.
  const back = fresh(box("bar", [0.2, 2, 0.2]), { op: "convert", id: "bar" }, { op: "deform", id: "bar", kind: "bend", angle: -90, direction: "z" });
  const bb = measure(back.snapshot(), "bar").bounds;
  near(bb.min[2], -radius, 1e-9, "bent towards −z");
  assert.throws(() => store.apply([{ op: "deform", id: "bar", kind: "bend", angle: 45, direction: "y" }]), /differ from the axis/);
  assert.throws(() => store.apply([{ op: "deform", id: "bar", kind: "bend", angle: 0 }]), /angle/);
});

test("shear and stretch move along the range", () => {
  const store = fresh(box("b", [1, 2, 1]), { op: "convert", id: "b" }, { op: "deform", id: "b", kind: "shear", amount: 0.5, direction: "z" });
  node(store, "b").mesh.vertices.forEach((v) => near(Math.abs(v[2] - (v[1] > 0 ? 0.5 : 0)), 0.5, 1e-9, "sheared z"));
  const stretched = fresh(box("b", [1, 2, 1]), { op: "convert", id: "b" }, { op: "cut", id: "b", axis: "y", offset: 0 }, { op: "deform", id: "b", kind: "stretch", amount: 2, from: 0, to: 1 });
  const b = measure(stretched.snapshot(), "b").bounds;
  near(b.max[1], 2, 1e-9, "the upper half doubled");
  near(b.min[1], -1, 1e-9, "the lower half stayed");
});

test("displace moves along the normals (uniform = inflate), by a gradient, by seeded noise or by a formula", () => {
  const store = fresh({ op: "create", id: "s", kind: "sphere", options: { radius: 0.5, segments: 16, rings: 8 } }, { op: "convert", id: "s" });
  store.apply([{ op: "displace", id: "s", amount: 0.1 }]);
  node(store, "s").mesh.vertices.forEach((v) => near(Math.hypot(...v), 0.6, 0.02, "inflated radius"));
  closed(store.snapshot());
  // Gradient along y: the top rises by the amount, the bottom stays.
  const plate = () => fresh(box("p", [2, 0.2, 2]), { op: "convert", id: "p" }, { op: "subdivide", id: "p", levels: 2, smooth: false });
  const g = plate();
  g.apply([{ op: "displace", id: "p", amount: 0.5, along: "y", mode: "gradient" }]);
  const gb = measure(g.snapshot(), "p").bounds;
  near(gb.max[1], 0.6, 1e-9, "top");
  near(gb.min[1], -0.1, 1e-9, "bottom");
  // Noise: deterministic by seed, bounded by the amount, different seeds differ.
  const a = plate(),
    b = plate(),
    c = plate();
  a.apply([{ op: "displace", id: "p", amount: 0.05, mode: "noise", noise: { scale: 0.5, seed: "rock" } }]);
  b.apply([{ op: "displace", id: "p", amount: 0.05, mode: "noise", noise: { scale: 0.5, seed: "rock" } }]);
  c.apply([{ op: "displace", id: "p", amount: 0.05, mode: "noise", noise: { scale: 0.5, seed: "pebble" } }]);
  assert.deepEqual(node(a, "p").mesh.vertices, node(b, "p").mesh.vertices);
  assert.notDeepEqual(node(a, "p").mesh.vertices, node(c, "p").mesh.vertices);
  const flat = plate().snapshot().nodes[0].mesh.vertices;
  node(a, "p").mesh.vertices.forEach((v, i) => assert.ok(Math.hypot(...v.map((x, k) => x - flat[i][k])) <= 0.05 + 1e-9));
  // A formula: a cosine wave across x, full on the top (v = 1), nothing at the bottom (v = 0).
  const f = plate(),
    flatPlate = node(f, "p").mesh.vertices.map((v) => [...v]);
  f.apply([
    {
      op: "displace",
      id: "p",
      amount: 0.05,
      along: "y",
      mode: "formula",
      expr: { $expr: "mul", args: [{ $expr: "cos", args: [{ $expr: "mul", args: [{ $var: "x" }, 180] }] }, { $var: "v" }] },
    },
  ]);
  node(f, "p").mesh.vertices.forEach((v, i) => {
    const [x, y] = flatPlate[i],
      share = (y + 0.1) / 0.2;
    near(v[1], y + 0.05 * Math.cos(x * Math.PI) * share, 1e-9, "wave");
    near(v[0], x, 1e-12);
  });
  assert.throws(() => f.apply([{ op: "displace", id: "p", amount: 0.05, mode: "formula", expr: { $var: "q" } }]), /Unknown formula variable q/);
  assert.throws(() => f.apply([{ op: "displace", id: "p", amount: 0.05, mode: "formula", expr: { $expr: "sin", args: [1, 2] } }]), /sin takes 1 argument/);
  assert.throws(() => f.apply([{ op: "displace", id: "p", amount: 0.05, expr: 1 }]), /expr belongs to formula mode/);
  assert.throws(() => f.apply([{ op: "displace", id: "p", amount: 0.05, mode: "formula" }]), /needs expr/);
  // The formula helper and the noise field directly.
  near(formula({ $expr: "clamp", args: [5, 0, 1] }, {}), 1);
  near(formula({ $expr: "smoothstep", args: [0, 1, 0.5] }, {}), 0.5);
  near(formula({ $expr: "atan2", args: [1, 1] }, {}), 45);
  near(formula({ $expr: "lerp", args: [2, 4, 0.25] }, {}), 2.5);
  const n = fbm3(0.3, 0.7, -1.2, { seed: 3 });
  assert.ok(n >= -1 && n <= 1 && n === fbm3(0.3, 0.7, -1.2, { seed: 3 }));
});

test("smooth relaxes a mesh; volume keeps its size, a rim stays in its plane, a selection limits it", () => {
  const store = fresh(box("c"), { op: "convert", id: "c" }, { op: "subdivide", id: "c", levels: 1, smooth: false });
  const size = () => measure(store.snapshot(), "c").bounds.size[0];
  store.apply([{ op: "smooth", id: "c", iterations: 3, factor: 0.5 }]);
  assert.ok(size() < 0.95, `smoothing pulls the corners in (${size()})`);
  closed(store.snapshot());
  const kept = fresh(box("c"), { op: "convert", id: "c" }, { op: "subdivide", id: "c", levels: 1, smooth: false }, { op: "smooth", id: "c", iterations: 3, factor: 0.5, volume: true });
  assert.ok(measure(kept.snapshot(), "c").bounds.size[0] > size(), "volume keeps more of the size");
  // An open box: the rim's vertices keep their height.
  const open = fresh(box("o"), { op: "convert", id: "o" });
  const top = queryComponents(open.snapshot(), { id: "o", kind: "faces", normal: [0, 1, 0] }).items.map((f) => f.ref);
  open.apply([{ op: "deleteComponents", id: "o", faces: top }, { op: "subdivide", id: "o", levels: 1, smooth: false }, { op: "smooth", id: "o", iterations: 4 }]);
  const rim = node(open, "o").mesh.vertices.filter((v) => Math.abs(v[1] - 0.5) < 1e-9);
  assert.ok(rim.length >= 8, "rim vertices stay at the top");
  // Only the selected vertices move.
  const part = fresh(box("c"), { op: "convert", id: "c" }, { op: "subdivide", id: "c", levels: 1, smooth: false });
  const before = node(part, "c").mesh.vertices.map((v) => [...v]);
  const chosen = queryComponents(part.snapshot(), { id: "c", kind: "vertices", at: { axis: "y", value: 0.5 } }).items.map((v) => v.ref);
  part.apply([{ op: "smooth", id: "c", vertices: chosen, iterations: 2 }]);
  node(part, "c").mesh.vertices.forEach((v, i) => {
    if (before[i][1] < 0.5 - 1e-9) assert.deepEqual(v, before[i]);
  });
});

test("subdivide: Catmull–Clark quads, linear mode, levels, limits and materials", () => {
  const store = fresh(box("c"), { op: "convert", id: "c" });
  const top = queryComponents(store.snapshot(), { id: "c", kind: "faces", normal: [0, 1, 0] }).items.map((f) => f.ref);
  store.apply([{ op: "material", id: "lid", color: "#ff0000", roughness: 0.5 }, { op: "paint", id: "c", material: "lid", faces: top }]);
  const result = store.apply([{ op: "subdivide", id: "c", levels: 1 }]);
  assert.equal(result.results[0].faces, 24);
  assert.equal(result.results[0].vertices, 26);
  assert.ok(result.results[0].geometry[0].invalidatesPreviousReferences);
  const mesh = node(store, "c").mesh;
  assert.ok(mesh.faces.every((f) => f.vertices.length === 4));
  assert.equal(mesh.faces.filter((f) => f.material === "lid").length, 4, "the lid's four quads keep its material");
  closed(store.snapshot());
  // The corners move in to 5/18 (the face points stay on the faces, so the bounds keep).
  assert.ok(!mesh.vertices.some((v) => v.every((c) => Math.abs(Math.abs(c) - 0.5) < 1e-9)), "no corner stays");
  assert.ok(mesh.vertices.some((v) => v.every((c) => Math.abs(Math.abs(c) - 5 / 18) < 1e-9)), "corners at 5/18");
  assert.deepEqual(measure(store.snapshot(), "c").bounds.size, [1, 1, 1]);
  // Linear subdivision keeps every point where it is.
  const linear = fresh(box("c"), { op: "convert", id: "c" }, { op: "subdivide", id: "c", levels: 2, smooth: false });
  assert.deepEqual(measure(linear.snapshot(), "c").bounds.size, [1, 1, 1]);
  assert.equal(node(linear, "c").mesh.faces.length, 96);
  closed(linear.snapshot());
  // Growth is checked against the (dense) limits before anything is built: three levels of a
  // 2 048-face sphere give a dense mesh of 129 024 quads (its 128 pole triangles become three
  // quads each, the rest four); two more levels would pass the budget.
  const big = fresh({ op: "create", id: "s", kind: "sphere", options: { radius: 1, segments: 64, rings: 32 } }, { op: "convert", id: "s" });
  big.apply([{ op: "subdivide", id: "s", levels: 3 }]);
  assert.equal(node(big, "s").mesh.dense.offsets.length - 1, (1920 * 4 + 128 * 3) * 16, "a dense mesh now");
  assert.throws(() => big.apply([{ op: "subdivide", id: "s", levels: 2 }]), /would give .* faces; the caps are/);
  assert.throws(() => big.apply([{ op: "subdivide", id: "s", levels: 4 }]), /from 1 to 3|levels/);
});

test("falloff: proportional editing on transform, vertices and shape edits", () => {
  const plate = () => fresh(box("p", [2, 0.1, 2]), { op: "convert", id: "p" }, { op: "subdivide", id: "p", levels: 3, smooth: false });
  const store = plate();
  const top = queryComponents(store.snapshot(), { id: "p", kind: "vertices", at: { axis: "y", value: 0.05 } }).items,
    centre = top.filter((v) => Math.hypot(v.center[0], v.center[2]) < 1e-9).map((v) => v.ref);
  assert.equal(centre.length, 1);
  const flat = node(store, "p").mesh.vertices.map((v) => [...v]);
  store.apply([{ op: "transform", id: "p", vertices: centre, translation: [0, 0.4, 0], falloff: { radius: 0.8, shape: "smooth" } }]);
  node(store, "p").mesh.vertices.forEach((v, i) => {
    const d = Math.hypot(flat[i][0], flat[i][1] - 0.05, flat[i][2]),
      expected = flat[i][1] + (d < 0.8 ? 0.4 * falloffWeight("smooth", d / 0.8) : 0);
    near(v[1], expected, 1e-9, `falloff at ${d}`);
  });
  // The bottom is only 0.1 below the moved vertex, so it followed; a smaller radius leaves it alone.
  const tight = plate();
  tight.apply([{ op: "transform", id: "p", vertices: centre, translation: [0, 0.4, 0], falloff: 0.05 }]);
  near(measure(tight.snapshot(), "p").bounds.min[1], -0.05, 1e-12, "the bottom stays");
  // vertices with falloff: neighbours follow the nearest changed vertex's move.
  const moved = plate();
  const index = centre[0].id;
  moved.apply([{ op: "vertices", id: "p", changes: [{ index, position: [0, 0.3, 0] }], falloff: { radius: 0.5, shape: "linear" }, topology: centre[0].topology }]);
  node(moved, "p").mesh.vertices.forEach((v, i) => {
    const d = Math.hypot(flat[i][0], flat[i][1] - 0.05, flat[i][2]);
    near(v[1], flat[i][1] + (d < 0.5 ? 0.25 * (1 - d / 0.5) : 0), 1e-9, `linear at ${d}`);
  });
  // Shape edits take a selection and a falloff too.
  const bumped = plate();
  bumped.apply([{ op: "displace", id: "p", amount: 0.2, vertices: centre, falloff: { radius: 0.6, shape: "sphere" } }]);
  node(bumped, "p").mesh.vertices.forEach((v, i) => {
    if (Math.hypot(flat[i][0], flat[i][1] - 0.05, flat[i][2]) >= 0.6) assert.deepEqual(v, flat[i], "beyond the radius nothing moves");
  });
  assert.ok(measure(bumped.snapshot(), "p").bounds.max[1] > 0.24);
  // Every shape has its curve; constant moves everything within the radius fully.
  for (const shape of ["smooth", "sphere", "root", "sharp", "linear", "inverseSquare"]) {
    near(falloffWeight(shape, 0), 1, 1e-12, shape);
    near(falloffWeight(shape, 1), 0, 1e-12, shape);
    assert.ok(falloffWeight(shape, 0.5) > 0 && falloffWeight(shape, 0.5) < 1, shape);
  }
  assert.equal(falloffWeight("constant", 0.9), 1);
  assert.throws(() => store.apply([{ op: "transform", id: "p", translation: [1, 0, 0], falloff: 1 }]), /needs a component selection/);
  assert.throws(() => store.apply([{ op: "displace", id: "p", amount: 0.1, falloff: 1 }]), /needs a component selection/);
  assert.throws(() => validateSchema([{ op: "transform", id: "p", vertices: centre, translation: [1, 0, 0], falloff: { radius: 1, shape: "wave" } }], commandsSchema), /Expected/);
  const fresher = plate(),
    ref = queryComponents(fresher.snapshot(), { id: "p", kind: "vertices", limit: 1 }).items[0].ref;
  assert.throws(() => fresher.apply([{ op: "transform", id: "p", vertices: [ref], translation: [1, 0, 0], falloff: { radius: 1, shape: "wave" } }]), /shape/);
});

test("shape edits in world space, on selections, and the guards for copies and assets", () => {
  // A part turned 90° about z lies along world x: bending along world x towards +z.
  const store = fresh(box("b", [0.2, 2, 0.2]), { op: "convert", id: "b" }, { op: "subdivide", id: "b", levels: 2, smooth: false }, { op: "set", id: "b", rotation: [0, 0, 90] });
  store.apply([{ op: "deform", id: "b", kind: "bend", angle: 90, axis: "x", direction: "z", space: "world" }]);
  const b = measure(store.snapshot(), "b").bounds;
  near(b.max[2], 2 / (Math.PI / 2), 1e-9, "the world bend reaches +z");
  near(b.min[0], -1, 1e-9, "the base stays at world x = −1");
  // Linked copies follow their source; a copy cannot be edited itself.
  const linked = fresh(box("src"), { op: "convert", id: "src" }, { op: "duplicate", id: "src", newId: "copy", linked: true });
  linked.apply([{ op: "deform", id: "src", kind: "taper", amount: 0.5 }]);
  assert.deepEqual(node(linked, "copy").mesh.vertices, node(linked, "src").mesh.vertices);
  assert.throws(() => linked.apply([{ op: "smooth", id: "copy" }]), /Edit the source or unlink/);
  // A displace on selected faces moves only their vertices.
  const faces = fresh(box("c"), { op: "convert", id: "c" });
  const top = queryComponents(faces.snapshot(), { id: "c", kind: "faces", normal: [0, 1, 0] }).items.map((f) => f.ref);
  faces.apply([{ op: "displace", id: "c", amount: 0.2, along: "y", faces: top }]);
  near(measure(faces.snapshot(), "c").bounds.max[1], 0.7, 1e-9);
  near(measure(faces.snapshot(), "c").bounds.min[1], -0.5, 1e-9);
  // Vertex normals average the faces at a point; a cube corner points along its diagonal.
  const normals = vertexNormals(primitive("box", { size: [1, 1, 1] }, "m"));
  normals.forEach((n) => [0, 1, 2].forEach((k) => near(Math.abs(n[k]), 1 / Math.sqrt(3), 1e-9)));
});

test("shape edits are recipe steps with parameters, patches and formulas; the schema and capabilities know them", () => {
  const store = fresh(
    { op: "create", id: "t", kind: "cylinder", options: { radius: 0.5, height: 2, segments: 12 } },
    {
      op: "recipe",
      id: "t",
      definition: {
        parameters: { top: { value: 0.5, min: 0, max: 2 }, bumps: { value: 0.02 } },
        generator: { kind: "cylinder", options: { radius: 0.5, height: 2, segments: 12 } },
        steps: [
          { op: "subdivide", levels: 1, smooth: false },
          { op: "deform", kind: "taper", amount: { $param: "top" } },
          { op: "displace", amount: { $param: "bumps" }, mode: "formula", expr: { $expr: "sin", args: [{ $expr: "mul", args: [{ $var: "a" }, 6] }] } },
          { op: "smooth", iterations: 1, factor: 0.2 },
        ],
      },
    },
  );
  // The top ring's radius follows the taper (the bumps and smoothing move it a little).
  const topRadius = () => {
    const top = measure(store.snapshot(), "t").bounds.max[1];
    return Math.max(...node(store, "t").mesh.vertices.filter((v) => v[1] > top - 0.05).map((v) => Math.hypot(v[0], v[2])));
  };
  near(topRadius(), 0.25, 0.05, "half");
  store.apply([{ op: "recipeParameters", id: "t", values: { top: 0.1 } }]);
  near(topRadius(), 0.05, 0.05, "a tenth");
  assert.ok(node(store, "t").recipe, "the recipe stays attached");
  store.apply([{ op: "recipeStep", id: "t", action: "patch", index: 1, patch: { amount: 1.5 } }]);
  near(topRadius(), 0.75, 0.08, "patched amount widens the top");
  store.apply([{ op: "recipeStep", id: "t", action: "patch", index: 2, patch: { enabled: false } }]);
  closed(store.snapshot());
  // The schema: unknown fields and wrong kinds are rejected; the step schema takes expressions.
  validateSchema([{ op: "deform", id: "t", kind: "bend", angle: 30 }], commandsSchema);
  assert.throws(() => validateSchema([{ op: "deform", id: "t", kind: "bend", angle: 30, radius: 1 }], commandsSchema), /Unknown field radius/);
  assert.throws(() => validateSchema([{ op: "subdivide", id: "t", levels: 9 }], commandsSchema), /outside allowed range/);
  validateSchema([{ op: "create", id: "l", kind: "loft", options: { profile: { circle: 0.2 }, sections: [{ at: 0 }, { at: 1, scale: 0.5 }] } }], commandsSchema);
  const features = capabilities().features;
  for (const f of ["loft", "deformers", "displacement", "formulaDisplacement", "smoothing", "subdivision", "proportionalEditing"]) assert.ok(features.includes(f), f);
  assert.ok(!capabilities().unsupported.includes("subdivision"));
  const deform = capabilities({ command: "deform" }).schema;
  assert.deepEqual(deform.properties.kind.enum, ["taper", "bend", "twist", "shear", "stretch"]);
  assert.ok(capabilities({ command: "displace" }).schema.$defs.formula);
});

test("triangulate splits quads and n-gons like export, whole or by faces, as a command and a recipe step", () => {
  const store = fresh(box("c"), { op: "convert", id: "c" });
  const top = queryComponents(store.snapshot(), { id: "c", kind: "faces", normal: [0, 1, 0] }).items.map((f) => f.ref);
  let result = store.apply([{ op: "triangulate", id: "c", faces: top }]);
  assert.equal(result.results[0].triangulated, 1);
  assert.equal(node(store, "c").mesh.faces.length, 7);
  assert.equal(node(store, "c").mesh.faces.filter((f) => f.vertices.length === 3).length, 2);
  result = store.apply([{ op: "triangulate", id: "c" }]);
  assert.equal(result.results[0].triangulated, 5);
  assert.equal(node(store, "c").mesh.faces.length, 12);
  assert.ok(node(store, "c").mesh.faces.every((f) => f.vertices.length === 3));
  closed(store.snapshot());
  // Nothing to split keeps the part parametric.
  const kept = fresh(box("p"));
  kept.apply([{ op: "triangulate", id: "p", faces: [] }].slice(0, 0).concat([{ op: "convert", id: "p" }, { op: "triangulate", id: "p" }, { op: "triangulate", id: "p" }]));
  assert.equal(node(kept, "p").mesh.faces.length, 12);
  const parametric = fresh({ op: "create", id: "s", kind: "sphere", options: { radius: 0.5, geodesic: 1 } });
  parametric.apply([{ op: "triangulate", id: "s" }]);
  assert.ok(node(parametric, "s").generator, "an icosphere has nothing to split, so it stays a generator");
  // A twisted box reports its bent quads and the suggestion; triangulating settles them.
  const twisted = fresh(box("t", [1, 2, 1]), { op: "convert", id: "t" });
  const bent = twisted.apply([{ op: "deform", id: "t", kind: "twist", angle: 60 }]).results[0];
  assert.equal(bent.nonplanarFaces, 4);
  assert.match(bent.suggestion, /triangulate/);
  twisted.apply([{ op: "triangulate", id: "t" }]);
  assert.deepEqual(codes(twisted.snapshot()).filter((c) => c === "nonplanar"), []);
  // As a recipe step after a displacement.
  const recipe = fresh(
    box("r", [1, 0.2, 1]),
    {
      op: "recipe",
      id: "r",
      definition: {
        parameters: { bump: { value: 0.1 } },
        generator: { kind: "box", options: { size: [1, 0.2, 1] } },
        steps: [
          { op: "subdivide", levels: 2, smooth: false },
          { op: "displace", amount: { $param: "bump" }, mode: "noise", noise: { scale: 0.4, seed: 7 } },
          { op: "triangulate" },
        ],
      },
    },
  );
  assert.ok(node(recipe, "r").mesh.faces.every((f) => f.vertices.length === 3));
  recipe.apply([{ op: "recipeParameters", id: "r", values: { bump: 0.02 } }]);
  assert.ok(node(recipe, "r").recipe);
  validateSchema([{ op: "triangulate", id: "r", select: { kind: "faces", normal: [0, 1, 0] } }], commandsSchema);
  assert.throws(() => validateSchema([{ op: "triangulate", id: "r", select: { kind: "edges" } }], commandsSchema), /constant|Expected/);
});

test("geodesic spheres: an icosphere by level, cut by latitude and angle, beside the unchanged lathe sphere", () => {
  const ico = primitive("sphere", { radius: 0.5, geodesic: 0 }, "m");
  assert.equal(ico.vertices.length, 12);
  assert.equal(ico.faces.length, 20);
  ico.vertices.forEach((v) => near(Math.hypot(...v), 0.5, 1e-12, "on the sphere"));
  const two = primitive("sphere", { radius: 1, geodesic: 2 }, "m");
  assert.equal(two.faces.length, 320);
  assert.equal(two.vertices.length, 162);
  two.vertices.forEach((v) => near(Math.hypot(...v), 1, 1e-12));
  const store = fresh({ op: "create", id: "g", kind: "sphere", options: { radius: 0.5, geodesic: 2 } });
  closed(store.snapshot());
  assert.deepEqual(codes(store.snapshot()), []);
  assert.equal(node(store, "g").generator.kind, "sphere");
  // A dome: flat where cut, the rest still on the sphere.
  const dome = fresh({ op: "create", id: "d", kind: "sphere", options: { radius: 0.5, geodesic: 2, latitude: [0, 90] } });
  closed(dome.snapshot());
  const db = measure(dome.snapshot(), "d").bounds;
  near(db.min[1], 0, 1e-6, "cut at the equator");
  near(db.max[1], 0.5, 1e-6, "the pole");
  assert.ok(node(dome, "d").mesh.faces.some((f) => f.vertices.length > 3), "the cut face is a polygon");
  // A wedge of 90° starting on +x.
  const wedge = fresh({ op: "create", id: "w", kind: "sphere", options: { radius: 0.5, geodesic: 1, angle: 90 } });
  closed(wedge.snapshot());
  const wb = measure(wedge.snapshot(), "w").bounds;
  near(wb.min[0], 0, 1e-6);
  near(wb.max[2], 0, 1e-6);
  assert.ok(wb.max[0] > 0.45 && wb.max[0] <= 0.5 + 1e-9, "reaches +x (no vertex lies exactly on the axis)");
  assert.ok(wb.min[2] < -0.45 && wb.min[2] >= -0.5 - 1e-9, "reaches −z");
  // Without the option the old sphere is built as before (fingerprinted in editor-shapes).
  const lathe = primitive("sphere", { radius: 0.5, segments: 8, rings: 6 }, "m");
  assert.equal(lathe.faces.length, 48);
  assert.throws(() => primitive("sphere", { radius: 0.5, geodesic: 8 }, "m"), /0 to 7/);
});
