import test from "node:test";
import assert from "node:assert/strict";
import { fbm, valueNoise, generateHeights, classifySurfaces, heightAt, surfaceAt, terrainMesh, terrainBounds } from "../site/runtime/kit/terrain.js";

// kit/terrain.js (docs/worlds.md §4): height fields shaped by ops, surfaces, queries, meshes.
const field = { cell: 2, samples: [9, 9], origin: [-8, 0, -8] };

test("noise is deterministic, bounded and continuous across tiles", () => {
  assert.equal(valueNoise(3.3, 4.4, 7), valueNoise(3.3, 4.4, 7));
  assert.notEqual(valueNoise(3.3, 4.4, 7), valueNoise(3.3, 4.4, 8));
  let min = 1, max = -1;
  for (let i = 0; i < 2000; i++) { const v = fbm(i * 1.37, i * 0.71, { scale: 50, seed: 3 }); min = Math.min(min, v); max = Math.max(max, v); }
  assert.ok(min >= -1 && max <= 1 && max - min > 0.5, `fbm spans ${min}..${max}`);
  // Two fields sharing an edge get the same heights there: noise is a function of world x, z.
  const west = generateHeights({ cell: 2, samples: [5, 5], origin: [-8, 0, 0] }, [{ noise: { amplitude: 5, scale: 20 } }], 4);
  const east = generateHeights({ cell: 2, samples: [5, 5], origin: [0, 0, 0] }, [{ noise: { amplitude: 5, scale: 20 } }], 4);
  for (let k = 0; k < 5; k++) assert.equal(west[k * 5 + 4], east[k * 5], `row ${k} meets at x = 0`);
});

test("ops stamp, flatten along a path, level inside a polygon, smooth and clamp", () => {
  const stamped = generateHeights(field, [{ stamp: { shape: "circle", center: [0, 0], radius: 3, height: 6, falloff: 2 } }]);
  assert.equal(stamped[4 * 9 + 4], 6, "the centre takes the full height");
  assert.equal(stamped[0], 0, "far corners stay");
  assert.ok(stamped[4 * 9 + 6] > 0 && stamped[4 * 9 + 6] < 6, "the falloff ring is in between");
  const flat = generateHeights(field, [{ noise: { amplitude: 4, scale: 10 } }, { flatten: { points: [[-8, 1, 0], [8, 1, 0]], width: 2, blend: 1 } }], 2);
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(flat[4 * 9 + i] - 1) < 1e-6, `the road row sits at the path's height (${flat[4 * 9 + i]})`);
  const levelled = generateHeights(field, [{ noise: { amplitude: 4, scale: 10 } }, { level: { polygon: [[2, 2], [8, 2], [8, 8], [2, 8]], height: 3, blend: 0.5 } }], 2);
  assert.ok(Math.abs(levelled[7 * 9 + 7] - 3) < 1e-6, "inside the polygon the height is set");
  const rough = generateHeights(field, [{ noise: { amplitude: 4, scale: 6 } }], 5), smoothed = generateHeights(field, [{ noise: { amplitude: 4, scale: 6 } }, { smooth: { passes: 2 } }], 5);
  const spread = (h) => Math.max(...h) - Math.min(...h);
  assert.ok(spread(smoothed) < spread(rough), "smoothing narrows the range");
  const clamped = generateHeights(field, [{ noise: { amplitude: 4, scale: 6 } }, { clamp: { min: -1, max: 1 } }], 5);
  assert.ok(clamped.every((h) => h >= -1 && h <= 1));
});

test("heights are read on the triangles the mesh draws, surfaces per cell", () => {
  const heights = generateHeights(field, [{ noise: { amplitude: 3, scale: 7 } }], 9);
  const terrain = { ...field, heights };
  const { positions, triangles } = terrainMesh(terrain);
  assert.equal(triangles, 128);
  // Every mesh vertex lies on the queried height field (positions are in the terrain's space).
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v] + field.origin[0], y = positions[v + 1], z = positions[v + 2] + field.origin[2];
    assert.ok(Math.abs(heightAt(terrain, x, z) - y) < 1e-5, `vertex at ${x}, ${z}`);
  }
  // A point inside a cell is on the plane of its triangle: both diagonals handled.
  const probe = (x, z) => { const h = heightAt(terrain, x, z); assert.ok(Number.isFinite(h)); return h; };
  probe(-7.5, -7.5); probe(-5.5, -7.5); probe(0.3, 0.7);
  assert.equal(heightAt(terrain, 100, 100), null);
  const surfaces = classifySurfaces(heights, field, [{}, { surface: 1, height: [0.5, 100] }, { surface: 2, slope: [40, 90] }]);
  assert.equal(surfaces.length, 64);
  const table = [{ id: "sand", color: "#d9c58a" }, { id: "grass", color: "#6b8f3a" }, { id: "rock", color: "#7a746c" }];
  const named = surfaceAt({ ...terrain, surfaces, surfaceTable: table }, -7, -7);
  assert.ok(table.includes(named));
  const bounds = terrainBounds(terrain);
  assert.deepEqual([bounds.max[0], bounds.max[2]], [16, 16]);
  assert.ok(bounds.min[1] <= Math.min(...heights) && bounds.max[1] >= Math.max(...heights));
});
