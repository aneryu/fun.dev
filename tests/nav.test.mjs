import test from "node:test";
import assert from "node:assert/strict";
import { navCellAt, walkableAt, navPath, lineClear, reachable } from "../site/runtime/kit/nav.js";

// kit/nav.js (docs/worlds.md §4): walks over the baked raster.
function raster(cols, rows, blocked = () => false, height = () => 0) {
  const cells = new Uint8Array(cols * rows), heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { cells[r * cols + c] = blocked(c, r) ? 0 : 1; heights[r * cols + c] = height(c, r); }
  return { cell: 1, origin: [0, 0, 0], size: [cols, rows], radius: 0.4, climb: 0.5, areas: [{ id: "ground", cost: 1 }], cells, heights };
}

test("cells, walkability and clear lines", () => {
  const nav = raster(10, 10, (c, r) => c === 5 && r < 8);
  assert.deepEqual([navCellAt(nav, 0.5, 0.5).col, navCellAt(nav, 0.5, 0.5).row], [0, 0]);
  assert.equal(walkableAt(nav, 5.5, 2.5), false);
  assert.equal(walkableAt(nav, 5.5, 9.5), true);
  assert.equal(walkableAt(nav, -1, 0), false);
  assert.equal(lineClear(nav, 0, 9), false, "the wall at column 5 blocks the top row");
  assert.equal(lineClear(nav, 9 * 10, 9 * 10 + 9), true, "the bottom row is open past the wall's end");
});

test("a walk goes round the wall through its gap, pulled straight, and respects climbs and costs", () => {
  const nav = raster(10, 10, (c, r) => c === 5 && r < 8);
  const walk = navPath(nav, [0.5, 0, 0.5], [9.5, 0, 0.5]);
  assert.ok(walk.found);
  assert.deepEqual(walk.points[0], [0.5, 0, 0.5]);
  assert.deepEqual(walk.points[walk.points.length - 1], [9.5, 0, 0.5]);
  assert.ok(walk.points.some((p) => p[2] > 8), "round the end of the wall");
  assert.ok(walk.points.length <= 5, `pulled straight into a few corners: ${walk.points.length}`);
  assert.ok(walk.length > 18 && walk.length < 24, `about the way round: ${walk.length}`);
  const raw = navPath(nav, [0.5, 0, 0.5], [9.5, 0, 0.5], { smooth: false });
  assert.ok(raw.points.length > walk.points.length);
  assert.equal(navPath(nav, [0.5, 0, 0.5], [5.5, 0, 0.5]).found, false, "a blocked goal");
  const cliff = raster(10, 2, () => false, (c) => (c >= 5 ? 2 : 0));
  assert.equal(navPath(cliff, [0.5, 0, 0.5], [9.5, 0, 0.5]).found, false, "a 2 m step is no walk");
  assert.equal(navPath(cliff, [0.5, 0, 0.5], [9.5, 0, 0.5], { climb: 2 }).found, true);
  const roads = raster(10, 3, () => false);
  roads.areas = [{ id: "ground", cost: 1 }, { id: "road", cost: 0.5 }];
  for (let c = 0; c < 10; c++) roads.cells[1 * 10 + c] = 2;
  const cheap = navPath(roads, [0.5, 0, 0.5], [9.5, 0, 0.5], { smooth: false });
  assert.ok(cheap.points.filter((p) => Math.floor(p[2]) === 1).length >= 6, "the cheaper road row carries most of the walk");
  const mask = reachable(nav, [0.5, 0, 0.5]);
  assert.equal(mask[0 * 10 + 9], 1, "the far side is reached round the wall");
  assert.equal(mask[0 * 10 + 5], 0);
});
