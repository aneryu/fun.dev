import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadKernel } from "../site/workshop/kernel.js";
import { primitive, triangulate, cornerNormals } from "../site/workshop/mesh.js";
import { importedSmoothing } from "../site/workshop/import-glb.js";
import { emptyProject, evaluateCommands, normalizeProject } from "../site/workshop/document.js";
import { expandOutline, autoSegments } from "../site/workshop/generators.js";

// Round shapes and outline items (docs/workshop-agents.md "Shapes", "Outlines and paths").
before(() => loadKernel());

// Closed, consistently oriented, outward: every edge used once each way, positive volume.
function solid(mesh, label) {
  const edges = new Map();
  for (const face of mesh.faces) {
    assert.ok(face.vertices.length >= 3 && face.vertices.length <= 64, `${label}: face size`);
    face.vertices.forEach((a, i) => {
      const b = face.vertices[(i + 1) % face.vertices.length],
        key = `${a}:${b}`;
      assert.ok(!edges.has(key), `${label}: edge ${key} used twice the same way`);
      edges.set(key, true);
    });
  }
  for (const key of edges.keys()) {
    const [a, b] = key.split(":");
    assert.ok(edges.has(`${b}:${a}`), `${label}: open edge ${key}`);
  }
  let volume = 0;
  for (const face of mesh.faces)
    for (const [a, b, c] of triangulate(mesh.vertices, face.vertices)) {
      const [p, q, r] = [a, b, c].map((i) => mesh.vertices[i]);
      volume += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    }
  assert.ok(volume > 0, `${label}: faces point outward (volume ${volume})`);
  return volume;
}
const bounds = (mesh) =>
  [0, 1, 2].map((k) => [Math.min(...mesh.vertices.map((v) => v[k])), Math.max(...mesh.vertices.map((v) => v[k]))]);
const near = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance * Math.abs(b), `${label}: ${a} vs ${b}`);

test("frustums, cones and partial, hollow or rounded cylinders are closed solids of the right size", () => {
  const frustum = primitive("cylinder", { radius: 0.4, radiusTop: 0.2, height: 1, segments: 64 }, "m");
  near(solid(frustum, "frustum"), (Math.PI * 1 * (0.16 + 0.08 + 0.04)) / 3, 0.01, "frustum volume");
  assert.deepEqual(bounds(frustum)[1], [-0.5, 0.5]);
  const truncated = primitive("cone", { radius: 0.4, radiusTop: 0.1, height: 1, segments: 64 }, "m");
  near(solid(truncated, "cone with radiusTop"), (Math.PI * (0.16 + 0.04 + 0.01)) / 3, 0.01, "truncated cone volume");
  const half = primitive("cylinder", { radius: 0.5, height: 1, segments: 64, angle: 180 }, "m");
  near(solid(half, "half cylinder"), (Math.PI * 0.25) / 2, 0.01, "half volume");
  const pipe = primitive("cylinder", { radius: 0.5, innerRadius: 0.4, height: 2, segments: 64 }, "m");
  near(solid(pipe, "pipe"), Math.PI * (0.25 - 0.16) * 2, 0.01, "pipe volume");
  const tapered = primitive("cylinder", { radius: 0.5, radiusTop: 0.3, innerRadius: 0.4, height: 1 }, "m");
  solid(tapered, "tapered pipe");
  const can = primitive("cylinder", { radius: 0.3, height: 0.6, round: 0.05, segments: 48 }, "m");
  const canVolume = solid(can, "rounded can");
  assert.ok(canVolume < Math.PI * 0.09 * 0.6 && canVolume > Math.PI * 0.09 * 0.6 * 0.95, "rounding takes a little off");
  assert.deepEqual(bounds(can)[1].map((v) => +v.toFixed(6)), [-0.3, 0.3], "rounding keeps the height");
  const quarterPipe = primitive("cylinder", { radius: 0.5, innerRadius: 0.4, height: 1, angle: 90, round: 0.02 }, "m");
  solid(quarterPipe, "rounded quarter pipe");
  assert.throws(() => primitive("cone", { radius: 0.5, innerRadius: 0.2, height: 1 }, "m"), /wall/);
});

test("axis lays round shapes along x or z; partial angles start on +X", () => {
  const along = (axis) => bounds(primitive("cylinder", { radius: 0.2, height: 2, segments: 16, axis }, "m"));
  assert.deepEqual(along("x")[0].map((v) => +v.toFixed(6)), [-1, 1]);
  assert.deepEqual(along("z")[2].map((v) => +v.toFixed(6)), [-1, 1]);
  solid(primitive("capsule", { radius: 0.2, height: 1, axis: "x" }, "m"), "capsule along x");
  solid(primitive("torus", { radius: 0.4, tube: 0.05, axis: "z" }, "m"), "torus about z");
  assert.throws(() => primitive("cylinder", { axis: "w" }, "m"), /axis/);
  // A quarter about +Y from +X: towards −Z (positive rotation), as revolve does.
  const quarter = bounds(primitive("cylinder", { radius: 1, height: 0.1, angle: 90, segments: 64 }, "m"));
  assert.ok(quarter[0][0] > -1e-9 && quarter[2][1] < 1e-9, `quarter in +X −Z: ${JSON.stringify(quarter)}`);
});

test("spheres cut by latitude and angle: domes, bowls and wedges", () => {
  const dome = primitive("sphere", { radius: 1, segments: 64, rings: 32, latitude: [0, 90] }, "m");
  near(solid(dome, "dome"), (2 / 3) * Math.PI, 0.01, "dome volume");
  assert.deepEqual(bounds(dome)[1].map((v) => +v.toFixed(6)), [0, 1]);
  const bowl = primitive("sphere", { radius: 1, segments: 64, rings: 32, latitude: [-90, -30] }, "m");
  solid(bowl, "bowl");
  const wedge = primitive("sphere", { radius: 1, segments: 64, rings: 32, angle: 90 }, "m");
  near(solid(wedge, "wedge"), Math.PI / 3, 0.02, "wedge volume");
  const quarterDome = primitive("sphere", { radius: 1, segments: 64, rings: 32, angle: 180, latitude: [0, 90] }, "m");
  near(solid(quarterDome, "half dome"), Math.PI / 3, 0.02, "half dome volume");
  assert.throws(() => primitive("sphere", { latitude: [10, 10] }, "m"), /latitude/);
});

test("tori, elbows and capsules", () => {
  const ring = primitive("torus", { radius: 0.5, tube: 0.1, segments: 64, tubeSegments: 32 }, "m");
  near(solid(ring, "torus"), 2 * Math.PI * Math.PI * 0.5 * 0.01, 0.01, "torus volume");
  const elbow = primitive("torus", { radius: 0.5, tube: 0.1, segments: 64, tubeSegments: 32, angle: 90 }, "m");
  near(solid(elbow, "elbow"), (2 * Math.PI * Math.PI * 0.5 * 0.01) / 4, 0.01, "elbow volume");
  assert.throws(() => primitive("torus", { radius: 0.2, tube: 0.3 }, "m"), /thinner/);
  const capsule = primitive("capsule", { radius: 0.2, height: 1, segments: 64, rings: 16 }, "m");
  near(solid(capsule, "capsule"), Math.PI * 0.04 * 0.6 + (4 / 3) * Math.PI * 0.008, 0.01, "capsule volume");
  assert.deepEqual(bounds(capsule)[1].map((v) => +v.toFixed(6)), [-0.5, 0.5]);
  const ball = primitive("capsule", { radius: 0.2, height: 0.4 }, "m");
  solid(ball, "capsule as a ball");
});

test('"auto" segments follow the size; new shapes default to it', () => {
  assert.deepEqual([0.01, 0.05, 0.3, 1, 2].map(autoSegments), [8, 12, 28, 52, 64]);
  const small = primitive("cylinder", { radius: 0.05, height: 0.1, segments: "auto" }, "m"),
    large = primitive("cylinder", { radius: 1, height: 0.1, segments: "auto" }, "m");
  assert.equal(small.vertices.length, 24);
  assert.equal(large.vertices.length, 104);
  assert.equal(primitive("cylinder", { radius: 1 }, "m").vertices.length, 16, "without auto the old default stays");
  const sphere = primitive("sphere", { radius: 0.3, segments: "auto", rings: "auto" }, "m");
  solid(sphere, "auto sphere");
});

test("outline items: arcs about a centre or through a point, curves, shapes and corner radii", () => {
  // A wheel arch: a half circle cut up into a side outline.
  const side = expandOutline(
    [[-2, 0], [-1.2, 0], { arc: { center: [-0.8, 0], angle: -180, segments: 8 } }, [2, 0], [2, 1], [-2, 1]],
    { path: "points" },
  ).points;
  assert.equal(side.length, 2 + 8 + 3);
  assert.ok(side.slice(2, 10).every(([x, y]) => Math.abs(Math.hypot(x + 0.8, y) - 0.4) < 1e-9 && y >= -1e-9), "on the arch");
  // An arched window: the arc through its top.
  const window = expandOutline([[-0.3, 0], [0.3, 0], [0.3, 0.4], { arc: { through: [0, 0.7], to: [-0.3, 0.4] } }], { path: "points" }).points;
  assert.ok(window.some(([x, y]) => Math.abs(x) < 1e-6 && Math.abs(y - 0.7) < 0.01), "reaches the top");
  assert.deepEqual(window.at(-1), [-0.3, 0.4]);
  const curve = expandOutline([[0, 0], { bezier: { controls: [[0.5, 1]], to: [1, 0], segments: 4 } }, [0.5, -0.5]], { path: "points" }).points;
  assert.deepEqual(curve[2].map((v) => +v.toFixed(6)), [0.5, 0.5], "a quadratic's midpoint");
  assert.equal(expandOutline({ circle: { radius: 0.1, segments: 20 } }, { path: "holes.0" }).points.length, 20);
  assert.equal(expandOutline({ polygon: { sides: 6, radius: 1 } }, { path: "points" }).points.length, 6);
  // A sign with only its top corners rounded, extruded.
  const sign = primitive("extrude", { points: [[-0.5, 0], [0.5, 0], [0.5, 0.6, 0.1], [-0.5, 0.6, 0.1]], depth: 0.02 }, "m");
  solid(sign, "sign");
  assert.equal(sign.faces.length, 2 + (2 + 4 + 4), "two caps, two sharp and eight rounded sides");
  const washer = primitive("extrude", { points: { circle: 0.05 }, holes: [{ circle: 0.02 }], depth: 0.004 }, "m");
  solid(washer, "washer");
  assert.throws(() => expandOutline([{ arc: { center: [0, 0], angle: 90 } }], { path: "points" }), /starts with a point/);
});

test("paths take arcs, helices and curves; lathes take arcs and corner radii", () => {
  const rail = primitive(
    "sweep",
    { profile: { circle: { radius: 0.02, segments: 12 } }, path: [[0.6, 0, 0], { arc: { center: [0, 0, 0], axis: [0, 1, 0], angle: 360, rise: 3 } }] },
    "m",
  );
  solid(rail, "spiral rail");
  // The section stands square to the climbing path, so it reaches a little under 2 cm above.
  const topY = bounds(rail)[1][1];
  assert.ok(topY > 3.01 && topY <= 3.02 + 1e-9, `rises three metres: ${topY}`);
  const elbow = primitive("sweep", { profile: { circle: 0.05 }, path: [[0, 0, 0], [0, 0.5, 0], { arc: { through: [0.15, 0.85, 0], to: [0.5, 1, 0] } }, [1, 1, 0]] }, "m");
  solid(elbow, "pipe with a bend");
  const vase = primitive(
    "lathe",
    { profile: [[0, 0], [0.12, 0, 0.02], [0.2, 0.3], { bezier: { controls: [[0.25, 0.45]], to: [0.08, 0.6] } }, [0.1, 0.7], [0, 0.7]], segments: 32 },
    "m",
  );
  solid(vase, "vase");
});

// Saved projects rebuild their parts from these options: the meshes (and face IDs) of the
// shapes as they were before the new options must never change. Fingerprints taken from
// the generators of 2026-10-18 (3460635).
test("shapes from before the new options rebuild exactly as they did", () => {
  const legacy = [
    ["cylinder", {}, "828f74e4f68aa1f4"],
    ["cylinder", {"radius": 0.3, "height": 2, "segments": 24}, "81f3838656020886"],
    ["cone", {}, "d9391be1a6a8405d"],
    ["cone", {"radius": 0.2, "height": 0.5, "segments": 5}, "9647913dc2ccebaa"],
    ["sphere", {}, "48a7e133da7c3518"],
    ["sphere", {"radius": 0.7, "segments": 32, "rings": 16}, "0cb59595e5bd73d7"],
    ["lathe", {"profile": [[0, 0], [0.3, 0], [0.45, 0.7], [0.4, 0.7], [0.26, 0.06], [0, 0.06]], "segments": 10}, "cec4a0456d6cd286"],
    ["lathe", {"profile": [[0, 0], [0.055, 0], [0.038, 5.7], [0, 5.7]], "segments": 10}, "f17e745f6ae47cd4"],
    ["extrude", {"points": [[0, 0], [1, 0], [1, 0.5], [0, 1]], "depth": 0.2}, "23704dfd69b459eb"],
    ["extrude", {"points": [[0, 0], [2, 0], [2, 1], [0, 1]], "depth": 0.3, "round": 0.1, "roundSegments": 4}, "b02d27de19d8df3c"],
    ["extrude", {"points": [[0, 0], [2, 0], [2, 1], [0, 1]], "depth": 0.3, "holes": [[[0.5, 0.25], [1.5, 0.25], [1.5, 0.75], [0.5, 0.75]]]}, "340f45ce55779bb0"],
    ["revolve", {"profile": [[0.35, -0.08], [0.55, -0.08], [0.55, 0.08], [0.35, 0.08]], "segments": 16}, "66ea6fb44c680946"],
    ["revolve", {"profile": [[0.35, -0.08], [0.55, -0.08], [0.55, 0.08], [0.35, 0.08]], "angle": 90, "round": 0.02}, "fa3fa58b685ecd06"],
    ["sweep", {"profile": [[-0.04, -0.04], [0.04, -0.04], [0.04, 0.04], [-0.04, 0.04]], "path": [[0, 0, 0], [0, 1, 0], [1, 1.5, 0]], "smooth": true, "round": 0.01}, "f4caa7cd58b13f1c"],
  ];
  for (const [kind, options, fingerprint] of legacy)
    assert.equal(
      createHash("sha256").update(JSON.stringify(primitive(kind, structuredClone(options), "m"))).digest("hex").slice(0, 16),
      fingerprint,
      `${kind} ${JSON.stringify(options)}`,
    );
});

test("smooth shading: round sides blend, caps and sharp edges stay hard", () => {
  const can = primitive("cylinder", { radius: 1, height: 1, segments: 16 }, "m"),
    corners = cornerNormals(can, 60);
  can.faces.forEach((face, f) =>
    face.vertices.forEach((v, k) => {
      const n = corners[f][k];
      if (face.vertices.length === 4) {
        // Sides: the normal points straight out from the axis at that corner.
        const p = can.vertices[v],
          r = Math.hypot(p[0], p[2]);
        assert.ok(Math.abs(n[1]) < 1e-9 && (n[0] * p[0] + n[2] * p[2]) / r > 0.9999, "radial side normal");
      } else assert.ok(Math.abs(Math.abs(n[1]) - 1) < 1e-9, "flat cap");
    }),
  );
  // 90° box edges are sharper than 60°: a box stays flat.
  const box = primitive("box", {}, "m");
  cornerNormals(box, 60).forEach((list) => list.forEach((n) => assert.ok(Math.max(...n.map(Math.abs)) > 0.9999)));
  // A cone's tip: each face keeps its own direction instead of pointing straight up.
  const cone = primitive("cone", { radius: 0.5, height: 1, segments: 32 }, "m"),
    tip = cornerNormals(cone, 60);
  cone.faces.forEach((face, f) => {
    if (face.vertices.length !== 3) return;
    const n = tip[f][face.vertices.findIndex((v) => cone.vertices[v][1] > 0.49)];
    assert.ok(n[1] < 0.9, `tip normal leans out: ${n}`);
  });
});

test("parts carry smooth shading through create, set, copies and mirrors", () => {
  let project = emptyProject("smooth");
  project = evaluateCommands(project, [
    { op: "create", id: "can", kind: "cylinder", smooth: true, options: { segments: 24 } },
    { op: "symmetry", id: "can", newId: "can_mirror", axis: "x" },
    { op: "create", id: "tile", kind: "box", smooth: 30 },
  ]);
  const node = (id) => project.nodes.find((n) => n.id === id);
  assert.equal(node("can").smooth, 60);
  assert.equal(node("can_mirror").smooth, 60, "a mirror follows its source");
  assert.equal(node("tile").smooth, 30);
  project = evaluateCommands(project, [{ op: "set", id: "can", smooth: false }]);
  assert.equal(node("can").smooth, undefined);
  assert.equal(node("can_mirror").smooth, undefined);
  assert.equal(normalizeProject(project).nodes.find((n) => n.id === "tile").smooth, 30, "saved and loaded");
  assert.throws(() => evaluateCommands(project, [{ op: "set", id: "tile", smooth: 200 }]));
});

test("imports keep the smoothing of the file's normals", () => {
  // A 16-sided can as a file would hold it: sides with normals out from the axis, caps flat
  // on their own vertices.
  const can = primitive("cylinder", { radius: 1, height: 1, segments: 16 }, "m"),
    positions = [],
    normals = [],
    triangles = [];
  for (const face of can.faces)
    for (const t of triangulate(can.vertices, face.vertices)) {
      triangles.push(t.map((_, k) => positions.length + k));
      for (const v of t) {
        const p = can.vertices[v];
        positions.push(p);
        normals.push(face.vertices.length === 4 ? [p[0], 0, p[2]].map((x) => x / Math.hypot(p[0], p[2])) : [0, Math.sign(p[1]), 0]);
      }
    }
  const crease = importedSmoothing(positions, triangles, normals);
  assert.ok(crease >= 23 && crease <= 25, `just above the 22.5° between sides: ${crease}`);
  const flat = triangles.flatMap(([a, b, c]) => {
    const u = positions[b].map((v, k) => v - positions[a][k]),
      w = positions[c].map((v, k) => v - positions[a][k]),
      n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]],
      l = Math.hypot(...n);
    return [n, n, n].map((x) => x.map((v) => v / l));
  });
  assert.equal(importedSmoothing(positions, triangles, flat), 0, "faceted files stay flat");
  assert.equal(importedSmoothing(positions, triangles, null), 0, "no normals: flat");
});
