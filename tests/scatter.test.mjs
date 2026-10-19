import test from "node:test";
import assert from "node:assert/strict";
import { alongPath, inPolygon, onGrid, evaluateScatter, insidePolygon, polylineDistance } from "../site/runtime/kit/scatter.js";
import { createRandom } from "../site/runtime/kit/random.js";

// kit/scatter.js (docs/worlds.md §5): deterministic placements along paths, in areas, on grids.
const square = [[-10, -10], [10, -10], [10, 10], [-10, 10]];

test("stations along a path are spaced by arc length and carry the direction", () => {
  const stations = alongPath([[0, 0, 0], [10, 0, 0], [10, 0, 10]], { spacing: 5 });
  assert.deepEqual(stations.map((s) => s.position), [[0, 0, 0], [5, 0, 0], [10, 0, 0], [10, 0, 5], [10, 0, 10]]);
  assert.deepEqual(stations[1].direction, [1, 0, 0]);
  assert.deepEqual(stations[3].direction, [0, 0, 1]);
  assert.equal(alongPath([[0, 0, 0], [10, 0, 0]], { spacing: 4, start: 2, end: 8 }).length, 2);
  // A closed path comes back to its start without a station on top of the first.
  const loop = alongPath([[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]], { closed: true, spacing: 10 });
  assert.equal(loop.length, 5);
});

test("points in a polygon keep a margin, respect a count and are reproducible", () => {
  const a = inPolygon(square, { spacing: 2, jitter: 0.5, margin: 1 }, createRandom(3));
  const b = inPolygon(square, { spacing: 2, jitter: 0.5, margin: 1 }, createRandom(3));
  assert.deepEqual(a, b, "the same seed gives the same points");
  assert.notDeepEqual(a, inPolygon(square, { spacing: 2, jitter: 0.5, margin: 1 }, createRandom(4)));
  assert.ok(a.length > 50 && a.length < 110, `about one point per spacing² (${a.length})`);
  assert.ok(a.every((p) => insidePolygon(square, p.position[0], p.position[2])));
  assert.ok(a.every((p) => Math.abs(p.position[0]) <= 9 && Math.abs(p.position[2]) <= 9), "the margin keeps points off the edges");
  assert.equal(inPolygon(square, { spacing: 2, count: 7 }, createRandom(1)).length, 7);
  assert.equal(onGrid({ cells: [3, 4], spacing: 2 }).length, 12);
  assert.deepEqual(onGrid({ cells: [2, 1], spacing: 2, origin: [0, 1, 0] }).map((p) => p.position), [[-1, 1, 0], [1, 1, 0]]);
});

test("a rule along a path places on both sides facing along it, avoiding what it must", () => {
  const rule = {
    id: "lamps", seed: 5, on: { path: "road", spacing: 10, offset: 1.5, sides: "both", start: 0, end: null, jitter: 0 },
    candidates: [{ model: "lamp@v001", weight: 1 }],
  };
  const inputs = { paths: { road: { points: [[0, 0, 0], [40, 0, 0]], closed: false } } };
  const { rows } = evaluateScatter(rule, inputs);
  assert.equal(rows[0].length, 10, "five stations, two sides");
  assert.deepEqual(rows[0][0], [0, 0, 1.5, 0, 90, 0, 1], "left of the path, facing along it");
  assert.deepEqual(rows[0][1], [0, 0, -1.5, 0, 270, 0, 1], "right of the path, facing the other way");
  const avoided = evaluateScatter(rule, { ...inputs, avoid: { boxes: [{ min: [15, 0, -5], max: [25, 3, 5] }] } });
  assert.equal(avoided.rows[0].length, 8, "the two stations in the box are left out");
  const kept = evaluateScatter({ ...rule, on: { ...rule.on, offset: 0, sides: "one" }, avoid: [] }, { ...inputs, avoid: { paths: [{ points: [[20, 0, -5], [20, 0, 5]], closed: false, width: 4 }] } });
  assert.equal(kept.rows[0].length, 4, "a crossing path's width keeps one station away");
  assert.ok(polylineDistance([[20, 0, -5], [20, 0, 5]], false, 21, 0) < 1.01);
});

test("candidates are picked by weight, scaled in range, tinted from a palette, with random yaw in a zone", () => {
  const rule = {
    id: "trees", seed: 11, on: { zone: "lawn", spacing: 1.5, jitter: 0.4, margin: 0, count: null },
    yaw: { mode: "random" }, scale: [0.8, 1.2],
    candidates: [{ model: "shrub@v001", weight: 3, tints: [[1, 0, 0], [0, 1, 0]] }, { model: "tree@v001", weight: 1 }],
  };
  const inputs = { polygons: { lawn: square }, zoneY: { lawn: [0.35, 3] } };
  const { rows, tints } = evaluateScatter(rule, inputs);
  const total = rows[0].length + rows[1].length;
  assert.ok(total > 100, `many points (${total})`);
  assert.ok(rows[0].length > rows[1].length * 2, `weights 3:1 (${rows[0].length}:${rows[1].length})`);
  assert.ok(rows[0].every((r) => r[1] === 0.35 && r[6] >= 0.8 && r[6] <= 1.2 && r[4] >= 0 && r[4] < 360));
  assert.equal(tints[0].length, rows[0].length);
  assert.ok(tints[0].every((t) => t[0] === 1 || t[1] === 1));
  assert.equal(tints[1], null, "no palette, no tints");
  assert.deepEqual(evaluateScatter(rule, inputs).rows, rows, "deterministic");
  const fixed = evaluateScatter({ ...rule, y: 2, yaw: { mode: "fixed", value: 45 } }, inputs);
  assert.ok(fixed.rows[0].every((r) => r[1] === 2 && r[4] === 45));
});
