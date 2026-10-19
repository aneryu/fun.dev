import test from "node:test";
import assert from "node:assert/strict";
import { sweepPath, resamplePath, resolveProfile, SWEEP_PRESETS, SWEEP_MATERIALS } from "../site/runtime/kit/sweep.js";

// kit/sweep.js (docs/worlds.md §5): profiles carried along paths become road and track meshes.
const flat = (faces, vertices) => faces.every((f) => f.vertices.every((i) => Math.abs(vertices[i][1]) < 1e-6));
const normalY = (f, v) => {
  const [a, b, c] = f.vertices.map((i) => v[i]);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return u[2] * w[0] - u[0] * w[2];
};

test("presets resolve to strips whose materials the workshop knows", () => {
  for (const name of Object.keys(SWEEP_PRESETS)) {
    const p = resolveProfile(name);
    assert.ok(p.strips.length >= 1 && p.width > 0, name);
    for (const s of [...p.strips, ...p.marks]) for (const m of s.materials ?? [s.material]) assert.ok(SWEEP_MATERIALS[m], `${name}: ${m}`);
  }
  assert.equal(resolveProfile({ preset: "road", lanes: 4 }).width, 14);
  assert.equal(resolveProfile({ strips: [{ width: 3, material: "a" }, { width: 3, material: "b", offset: 0.2 }] }).width, 6);
  assert.throws(() => resolveProfile("nope"), /unknown profile preset/);
});

test("a straight road is a flat ribbon of the profile's width with its lines on top", () => {
  const { chunks, length, width } = sweepPath([[0, 0, 0], [0, 0, 40]], { profile: { preset: "road", lanes: 2, lines: true }, step: 10 });
  assert.equal(chunks.length, 1);
  assert.equal(length, 40);
  assert.equal(width, 7);
  const { vertices, faces } = chunks[0];
  const asphalt = faces.filter((f) => f.material === "mat_asphalt");
  assert.equal(asphalt.length, 8, "two triangles per 10 m segment");
  assert.ok(flat(asphalt, vertices), "the asphalt lies at the path's height");
  assert.ok(asphalt.every((f) => normalY(f, vertices) > 0), "faces point up");
  const xs = vertices.filter((v) => Math.abs(v[1]) < 1e-6).map((v) => v[0]);
  assert.equal(Math.min(...xs), -3.5);
  assert.equal(Math.max(...xs), 3.5);
  const lines = faces.filter((f) => f.material === "mat_line_yellow");
  assert.ok(lines.length === 8 && lines.every((f) => f.vertices.every((i) => Math.abs(vertices[i][1] - 0.01) < 1e-6)), "the centre line sits just above the asphalt");
});

test("corners mitre, sidewalks step up with kerb faces, dashes alternate by length", () => {
  const { chunks } = sweepPath([[0, 0, 0], [0, 0, 20], [20, 0, 20]], { profile: { preset: "road", lanes: 2, sidewalks: true }, step: 100 });
  const { vertices, faces } = chunks[0];
  // At the 90° corner the outer edge sits at (−5.5·√2 along the bisector): x = -5.5, z = 25.5.
  const corner = vertices.filter((v) => Math.abs(v[2] - 25.5) < 1e-3 && Math.abs(v[0] + 5.5) < 1e-3);
  assert.ok(corner.length >= 1, `the outer corner vertex is mitred: ${JSON.stringify(vertices.filter((v) => v[2] > 20))}`);
  const sidewalk = faces.filter((f) => f.material === "mat_sidewalk");
  assert.ok(sidewalk.some((f) => f.vertices.every((i) => Math.abs(vertices[i][1] - 0.15) < 1e-6)), "sidewalk tops at +15 cm");
  assert.ok(sidewalk.some((f) => f.vertices.some((i) => Math.abs(vertices[i][1]) < 1e-6) && f.vertices.some((i) => Math.abs(vertices[i][1] - 0.15) < 1e-6)), "a kerb face joins road and sidewalk");
  const track = sweepPath([[0, 0, 0], [0, 0, 40]], { profile: "track", step: 2 }).chunks[0];
  const red = track.faces.filter((f) => f.material === "mat_kerb_red").length, white = track.faces.filter((f) => f.material === "mat_kerb" && Math.abs(track.vertices[f.vertices[0]][1] - 0.05) < 1e-3).length;
  assert.ok(red > 0 && white > 0 && Math.abs(red - white) <= 4, `kerbs alternate: ${red} red, ${white} white`);
});

test("the ribbon follows a height function, banks on curvature and splits into chunks", () => {
  const points = [];
  for (let i = 0; i < 36; i++) points.push([Math.cos((i / 36) * Math.PI * 2) * 50, 0, Math.sin((i / 36) * Math.PI * 2) * 50]);
  const height = (x, z) => 2 + x / 100;
  const result = sweepPath(points, { closed: true, profile: { strips: [{ width: 8, material: "a" }], bank: { max: 10, radius: 50 } }, step: 2, height, rise: 0.1, chunk: 100 });
  assert.ok(result.chunks.length >= 3 && result.chunks.length <= 4, `chunks of 100 m: ${result.chunks.length}`);
  assert.ok(Math.abs(result.length - 2 * Math.PI * 50) < 3);
  const all = result.chunks.flatMap((c) => c.vertices);
  // Inside the circle the centre line sits on the terrain plus the rise.
  const centre = result.chunks[0].vertices.filter((v) => Math.abs(Math.hypot(v[0], v[2]) - 50) < 0.3);
  assert.ok(centre.length === 0, "no vertex on the centre line: the strip spans ±4 m");
  const inner = all.filter((v) => Math.hypot(v[0], v[2]) < 48), outer = all.filter((v) => Math.hypot(v[0], v[2]) > 52);
  assert.ok(inner.length && outer.length);
  const meanInner = inner.reduce((s, v) => s + v[1] - height(v[0], v[2]), 0) / inner.length, meanOuter = outer.reduce((s, v) => s + v[1] - height(v[0], v[2]), 0) / outer.length;
  assert.ok(meanOuter - meanInner > 0.8, `the outer edge rises on the bend: ${meanOuter.toFixed(2)} vs ${meanInner.toFixed(2)}`);
  // Seam vertices repeat in the next chunk: the same positions appear in both.
  const [a, b] = result.chunks;
  const shared = a.vertices.filter((v) => b.vertices.some((w) => w.every((x, i) => Math.abs(x - v[i]) < 1e-6)));
  assert.ok(shared.length >= 2, "the seam is shared");
  const slab = sweepPath([[0, 1, 0], [0, 1, 10]], { profile: { strips: [{ width: 4, material: "a" }], thickness: 0.5 }, step: 10 }).chunks[0];
  assert.ok(slab.vertices.some((v) => Math.abs(v[1] - 0.5) < 1e-6) && slab.faces.length === 2 + 6, "walls and a bottom under the slab");
});

test("resampling spaces points evenly along a smooth curve, closed or open", () => {
  const square = [[0, 0, 0], [20, 0, 0], [20, 0, 20], [0, 0, 20]];
  const loop = resamplePath(square, { closed: true, spacing: 2 });
  assert.ok(loop.length >= 36 && loop.length <= 44, `about 80 m / 2 m: ${loop.length}`);
  const gaps = loop.map((p, i) => Math.hypot(...p.map((v, k) => v - loop[(i + 1) % loop.length][k])));
  assert.ok(Math.max(...gaps) < 3.1, `even spacing: ${Math.max(...gaps)}`);
  assert.ok(loop.every((p) => Math.abs(p[1]) < 1e-9));
  assert.ok(loop.every((p) => p[0] > -5 && p[0] < 25 && p[2] > -5 && p[2] < 25), "the centripetal curve bows a little outside the square, never far");
  const open = resamplePath([[0, 0, 0], [10, 0, 0], [10, 0, 10]], { spacing: 1 });
  assert.deepEqual(open[0], [0, 0, 0]);
  assert.deepEqual(open[open.length - 1], [10, 0, 10]);
  const straight = resamplePath([[0, 0, 0], [0, 0, 9]], { spacing: 3, smooth: false });
  assert.deepEqual(straight, [[0, 0, 0], [0, 0, 3], [0, 0, 6], [0, 0, 9]]);
});
