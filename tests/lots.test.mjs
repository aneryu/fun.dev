import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLots, polylineAt } from "../site/runtime/kit/lots.js";

// kit/lots.js (docs/worlds.md §5): parcels along a road with models fitting and facing it.
const street = { points: [[-50, 0, 0], [50, 0, 0]], closed: false };
const house = { model: "house_01", bounds: { min: [-4, 0, -5], max: [4, 7, 5] }, weight: 1 };      // 8 wide, 10 deep, front at +z
const hut = { model: "hut_01", bounds: { min: [-2, 0, -2], max: [2, 3, 2] }, weight: 1, front: "-z" };

test("polylineAt walks a polyline by distance, wrapping when closed", () => {
  const { position, direction, length } = polylineAt(street.points, false, 25);
  assert.deepEqual([position, direction, length], [[-25, 0, 0], [1, 0, 0], 100]);
  assert.deepEqual(polylineAt([[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]], true, 45).position, [5, 0, 0], "45 m round a 40 m square: 5 m along the first side");
});

test("lots line both sides of a street, houses stand on their front line facing the road, gaps and bounds hold", () => {
  const { rows, lots } = evaluateLots({ seed: 3, width: [12, 12], depth: 14, offset: 6, gap: [0, 0], candidates: [house] }, { paths: { street } });
  assert.equal(lots.length, 16, "100 m / 12 m per lot on both sides");
  assert.equal(rows[0].length, 16, "a house fits every lot");
  const right = lots.filter((l) => l.side === "right"), left = lots.filter((l) => l.side === "left");
  assert.equal(right.length, 8);
  // Travelling +x, right is +z: the right lots' front line sits at z = 6, their centres at z = 13.
  assert.ok(right.every((l) => Math.abs(l.centre[2] - 13) < 1e-6 && Math.abs(l.corners[0][1] - 6) < 1e-6), JSON.stringify(right[0]));
  assert.ok(left.every((l) => Math.abs(l.centre[2] + 13) < 1e-6));
  // The house's +z front faces the road: on the right side it is turned 180° so its front edge (local z = 5) lies at z = 6.
  const row = rows[0].find((r) => r[2] > 0);
  assert.equal(row[4], 180);
  assert.ok(Math.abs(row[2] - 11) < 1e-6, `origin 5 m behind the front line: ${row}`);
  assert.ok(rows[0].filter((r) => r[2] < 0).every((r) => r[4] === 0 && Math.abs(r[2] + 11) < 1e-6), "left side: unturned, front at z = -6");
  assert.deepEqual(lots.map((l) => l.distance).slice(0, 3), [6, 18, 30]);
  const gapped = evaluateLots({ seed: 3, width: [12, 12], depth: 14, offset: 6, gap: [4, 4], sides: "right", candidates: [house] }, { paths: { street } });
  assert.equal(gapped.lots.length, 6, "12 m lots with 4 m gaps on one side");
  const bounded = evaluateLots({ seed: 3, width: [12, 12], depth: 14, offset: 6, sides: "right", bounds: "block", candidates: [house] }, { paths: { street }, polygons: { block: [[-20, 0], [20, 0], [20, 30], [-20, 30]] } });
  assert.ok(bounded.lots.length >= 2 && bounded.lots.every((l) => Math.abs(l.centre[0]) <= 20), "only lots inside the block");
  assert.deepEqual(evaluateLots({ seed: 3, width: [12, 12], depth: 14, offset: 6, candidates: [house] }, { paths: { street } }).lots, lots, "deterministic");
});

test("candidates must fit the lot; a lot nothing fits stays empty; ground heights and keep-outs apply", () => {
  const narrow = evaluateLots({ seed: 1, width: [6, 6], depth: 14, offset: 6, sides: "right", candidates: [house, hut] }, { paths: { street } });
  assert.equal(narrow.rows[0].length, 0, "the 8 m house never fits a 6 m lot");
  assert.equal(narrow.rows[1].length, narrow.lots.length, "the 4 m hut (plus 1 m margins) fits every 6 m lot");
  assert.ok(narrow.rows[1].every((r) => r[4] === 0), "a -z front on the right side needs no turn");
  const none = evaluateLots({ seed: 1, width: [3, 3], depth: 14, offset: 6, sides: "right", candidates: [house, hut] }, { paths: { street } });
  assert.ok(none.lots.length > 0 && none.lots.every((l) => l.candidate === null) && none.rows.every((r) => r.length === 0), "empty lots are listed");
  const sloped = evaluateLots({ seed: 1, width: [10, 10], depth: 10, offset: 5, sides: "right", ground: true, candidates: [hut] }, { paths: { street }, height: (x) => (x > 0 ? 2 : null) });
  assert.ok(sloped.lots.every((l) => l.centre[0] > 0 && l.centre[1] === 2), "lots off the ground are dropped, the rest take its height");
  const kept = evaluateLots({ seed: 1, width: [10, 10], depth: 10, offset: 5, sides: "right", candidates: [hut] }, { paths: { street }, avoid: { paths: [], polygons: [[[-14, 0], [14, 0], [14, 20], [-14, 20]]], boxes: [] } });
  assert.ok(kept.lots.length > 0 && kept.lots.every((l) => Math.abs(l.centre[0]) > 14), "no lot inside the kept-out polygon");
});
