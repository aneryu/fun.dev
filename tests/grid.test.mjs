import test from "node:test";
import assert from "node:assert/strict";
import { cellAt, gridHeightAt, cellCentre, gridBounds, gridMesh, gridPath } from "../site/runtime/kit/grid.js";

// kit/grid.js (docs/worlds.md §4): cell maps with types and levels, their mesh and paths.
const types = [{ id: "plain", color: "#9fb66b" }, { id: "rock", color: "#6f6a62", walkable: false }, { id: "water", color: "#4ba3c7", walkable: false, buildable: false }];
function map(cols, rows, paint = () => 0, levels = null) {
  const cells = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells[r * cols + c] = paint(c, r);
  return { cell: 2, size: [cols, rows], origin: [10, 1, -4], step: 0.5, types, cells, levels: levels ? Uint8Array.from({ length: cols * rows }, (_, i) => levels(i % cols, Math.floor(i / cols))) : null };
}

test("cells answer by world position with their type, level and floor height", () => {
  const g = map(8, 6, (c) => (c === 3 ? 1 : 0), (c, r) => (r >= 3 ? 2 : 0));
  assert.deepEqual([cellAt(g, 10.1, -3.9).col, cellAt(g, 10.1, -3.9).row], [0, 0]);
  assert.equal(cellAt(g, 17, 0).type.id, "rock");
  assert.equal(cellAt(g, 17, 0).type.walkable, false);
  assert.equal(gridHeightAt(g, 11, 3), 1 + 2 * 0.5, "row 3 sits two levels up");
  assert.equal(gridHeightAt(g, 11, -3), 1);
  assert.equal(cellAt(g, 9, 0), null);
  assert.equal(cellAt(g, 26, 0), null, "past the last column");
  assert.deepEqual(cellCentre(g, 0, 0), [11, 1, -3]);
  assert.deepEqual(gridBounds(g), { min: [0, 0, 0], max: [16, 1, 12] });
});

test("the mesh has two triangles per cell plus walls at level changes, coloured by type", () => {
  const flat = gridMesh(map(4, 3));
  assert.equal(flat.triangles, 24);
  assert.ok(Array.from(flat.normals).every((v, i) => (i % 3 === 1 ? Math.abs(v - 1) < 1e-6 : Math.abs(v) < 1e-6)), "flat tops look up");
  const stepped = gridMesh(map(4, 3, () => 0, (c) => (c >= 2 ? 1 : 0)));
  assert.equal(stepped.triangles, 24 + 3 * 2, "one wall per row where the level changes");
  const walls = [];
  for (let t = 0; t < stepped.triangles; t++) if (Math.abs(stepped.normals[t * 9 + 1]) < 1e-6) walls.push(stepped.normals[t * 9]);
  assert.ok(walls.length === 6 && walls.every((nx) => nx < -0.99), "walls face the lower (west) side");
  const colour = Array.from(gridMesh(map(1, 1, () => 2)).colors.slice(0, 3));
  assert.ok(colour[2] > colour[0], "water is blue");
});

test("grid paths walk around blocked cells, climb only one level, and can go diagonal", () => {
  // A wall of rock down column 4 with a gap at row 5.
  const g = map(10, 8, (c, r) => (c === 4 && r !== 5 ? 1 : 0));
  const route = gridPath(g, cellCentre(g, 1, 1), cellCentre(g, 8, 1));
  assert.ok(route.found);
  assert.deepEqual(route.cells[0], [1, 1]);
  assert.deepEqual(route.cells[route.cells.length - 1], [8, 1]);
  assert.ok(route.cells.some(([c, r]) => c === 4 && r === 5), "through the gap");
  assert.ok(route.cells.every(([c, r]) => g.cells[r * 10 + c] === 0), "never on rock");
  assert.equal(route.length, (route.cells.length - 1) * 2);
  assert.equal(route.points[0][1], 1, "centres carry the floor height");
  assert.equal(gridPath(g, cellCentre(g, 1, 1), cellCentre(g, 4, 1)).found, false, "a rock cell is no goal");
  assert.equal(gridPath(g, cellCentre(g, 1, 1), [100, 0, 100]).found, false);
  const diagonal = gridPath(map(6, 6), cellCentre(g, 0, 0), cellCentre(g, 5, 5), { diagonal: true });
  assert.equal(diagonal.cells.length, 6, "a straight diagonal");
  assert.ok(Math.abs(diagonal.length - 5 * Math.SQRT2 * 2) < 1e-9);
  // Levels: a cliff two levels high blocks, a ramp of single steps does not.
  const cliff = map(5, 1, () => 0, (c) => (c >= 2 ? 2 : 0));
  assert.equal(gridPath(cliff, cellCentre(cliff, 0, 0), cellCentre(cliff, 4, 0)).found, false);
  assert.equal(gridPath(cliff, cellCentre(cliff, 0, 0), cellCentre(cliff, 4, 0), { climb: 2 }).found, true);
  const ramp = map(5, 1, () => 0, (c) => c);
  assert.equal(gridPath(ramp, cellCentre(ramp, 0, 0), cellCentre(ramp, 4, 0)).found, true);
  assert.equal(gridPath(g, cellCentre(g, 1, 1), cellCentre(g, 8, 1), { types: ["rock"] }).found, false, "only the named types are walkable");
});
