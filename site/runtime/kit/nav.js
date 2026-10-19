// Navigation (docs/worlds.md §4): a walkable raster per tile, baked by the workshop from the
// ground (terrain, grids, floors and roads) less the solids, an agent's radius and the
// slopes it cannot climb. Cells carry an area (0 blocked) and the ground height; paths are
// an A* over the cells, pulled straight where the way is clear. Pure: the same code answers
// in the workshop's audit and in the game.
import { createHeap } from "./grid.js";

/** The cell under a world point: { col, row, index, area, height } or null (outside, blocked cells have area 0). */
export function navCellAt(nav, x, z) {
  const { cell, size: [cols, rows], origin } = nav;
  const col = Math.floor((x - origin[0]) / cell), row = Math.floor((z - origin[2]) / cell);
  if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
  const index = row * cols + col;
  return { col, row, index, area: nav.cells[index], height: nav.heights ? nav.heights[index] : origin[1] };
}
/** Whether an agent may stand at a world point. */
export const walkableAt = (nav, x, z) => (navCellAt(nav, x, z)?.area ?? 0) > 0;
const centre = (nav, index) => {
  const cols = nav.size[0], col = index % cols, row = (index - col) / cols;
  return [nav.origin[0] + (col + 0.5) * nav.cell, nav.heights ? nav.heights[index] : nav.origin[1], nav.origin[2] + (row + 0.5) * nav.cell];
};
/** Whether every cell on the straight line between two cells is walkable (and climbable). */
export function lineClear(nav, from, to, climb = Infinity) {
  const cols = nav.size[0];
  let c0 = from % cols, r0 = (from - c0) / cols;
  const c1 = to % cols, r1 = (to - c1) / cols;
  const dc = Math.abs(c1 - c0), dr = Math.abs(r1 - r0), sc = c0 < c1 ? 1 : -1, sr = r0 < r1 ? 1 : -1;
  let error = dc - dr, previous = from;
  for (;;) {
    const index = r0 * cols + c0;
    if (!(nav.cells[index] > 0)) return false;
    if (nav.heights && Math.abs(nav.heights[index] - nav.heights[previous]) > climb) return false;
    previous = index;
    if (c0 === c1 && r0 === r1) return true;
    const e2 = 2 * error;
    // Step one axis at a time, so the line never squeezes between two blocked corners.
    if (e2 > -dr) { error -= dr; c0 += sc; } else if (e2 < dc) { error += dc; r0 += sr; }
  }
}

/**
 * The shortest walk between two world points over the raster: A* over eight neighbours
 * (no cutting corners past blocked cells, no steps higher than `climb`), the areas' costs,
 * then the corners pulled straight wherever the line between them is clear. Returns
 * { found, points, length, cells }.
 */
export function navPath(nav, from, to, { climb = 0.6, smooth = true, costs = null } = {}) {
  const start = navCellAt(nav, from[0], from[2]), goal = navCellAt(nav, to[0], to[2]);
  const none = { found: false, points: [], length: 0, cells: 0 };
  if (!start || !goal || !start.area || !goal.area) return none;
  const { cell, size: [cols, rows], cells, heights, areas = [] } = nav;
  const cost = (index) => costs?.[areas[cells[index] - 1]?.id] ?? areas[cells[index] - 1]?.cost ?? 1;
  const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  const g = new Float64Array(cols * rows).fill(Infinity), came = new Int32Array(cols * rows).fill(-1), closed = new Uint8Array(cols * rows);
  const h = (index) => { const c = index % cols, r = (index - c) / cols; return Math.hypot(c - goal.col, r - goal.row); };
  const heap = createHeap();
  g[start.index] = 0;
  heap.push(h(start.index), start.index);
  let expanded = 0;
  while (heap.size) {
    const [, index] = heap.pop();
    if (closed[index]) continue;
    closed[index] = 1;
    expanded++;
    if (index === goal.index) break;
    const c = index % cols, r = (index - c) / cols;
    for (const [dc, dr, length] of steps) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const next = nr * cols + nc;
      if (closed[next] || !(cells[next] > 0)) continue;
      if (heights && Math.abs(heights[next] - heights[index]) > climb) continue;
      if (dc && dr && (!(cells[r * cols + nc] > 0) || !(cells[nr * cols + c] > 0))) continue;
      const score = g[index] + length * cost(next);
      if (score < g[next]) { g[next] = score; came[next] = index; heap.push(score + h(next), next); }
    }
  }
  if (!Number.isFinite(g[goal.index])) return none;
  const chain = [];
  for (let i = goal.index; i !== -1; i = came[i]) chain.push(i);
  chain.reverse();
  // String pulling: from each corner, jump to the farthest later cell the line reaches.
  let corners = chain;
  if (smooth && chain.length > 2) {
    corners = [chain[0]];
    let at = 0;
    while (at < chain.length - 1) {
      let far = at + 1;
      for (let j = chain.length - 1; j > at + 1; j--) if (lineClear(nav, chain[at], chain[j], climb)) { far = j; break; }
      corners.push(chain[far]);
      at = far;
    }
  }
  const points = corners.map((i) => centre(nav, i));
  points[0] = [from[0], points[0][1], from[2]];
  points[points.length - 1] = [to[0], points[points.length - 1][1], to[2]];
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][2] - points[i - 1][2]);
  return { found: true, points: points.map((p) => p.map((v) => Math.round(v * 1000) / 1000)), length: Math.round(length * 1000) / 1000, cells: expanded };
}

/** The cells reachable from a world point (a flood over walkable, climbable neighbours), as a Uint8Array mask. */
export function reachable(nav, from, { climb = 0.6 } = {}) {
  const { size: [cols, rows], cells, heights } = nav, mask = new Uint8Array(cols * rows);
  const start = navCellAt(nav, from[0], from[2]);
  if (!start || !start.area) return mask;
  const stack = [start.index];
  mask[start.index] = 1;
  while (stack.length) {
    const index = stack.pop(), c = index % cols, r = (index - c) / cols;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const next = nr * cols + nc;
      if (mask[next] || !(cells[next] > 0) || (heights && Math.abs(heights[next] - heights[index]) > climb)) continue;
      mask[next] = 1;
      stack.push(next);
    }
  }
  return mask;
}

/**
 * One raster over several tiles' rasters (the same cell size, origins on the cell lattice):
 * the union of their rectangles, each tile's cells copied in, areas merged by id. Cells no
 * tile covers stay blocked. Returns null when the rasters disagree on the cell size.
 */
export function stitchNavgrids(list) {
  const grids = list.filter(Boolean);
  if (!grids.length) return null;
  if (grids.length === 1) return grids[0];
  const cell = grids[0].cell;
  if (grids.some((g) => Math.abs(g.cell - cell) > 1e-9)) return null;
  const minX = Math.min(...grids.map((g) => g.origin[0])), minZ = Math.min(...grids.map((g) => g.origin[2]));
  const maxX = Math.max(...grids.map((g) => g.origin[0] + g.size[0] * g.cell)), maxZ = Math.max(...grids.map((g) => g.origin[2] + g.size[1] * g.cell));
  const cols = Math.round((maxX - minX) / cell), rows = Math.round((maxZ - minZ) / cell);
  const cells = new Uint8Array(cols * rows), heights = new Float32Array(cols * rows), areas = [];
  const areaIndex = (id, cost) => { let i = areas.findIndex((a) => a.id === id); if (i < 0) i = areas.push({ id, cost: cost ?? 1 }) - 1; return i + 1; };
  for (const g of grids) {
    const c0 = Math.round((g.origin[0] - minX) / cell), r0 = Math.round((g.origin[2] - minZ) / cell);
    const map = (g.areas ?? []).map((a) => areaIndex(a.id, a.cost));
    for (let r = 0; r < g.size[1]; r++)
      for (let c = 0; c < g.size[0]; c++) {
        const from = r * g.size[0] + c, to = (r0 + r) * cols + c0 + c;
        if (to < 0 || to >= cells.length || c0 + c >= cols) continue;
        const area = g.cells[from];
        if (!area) continue;
        cells[to] = map[area - 1] ?? areaIndex("ground");
        heights[to] = g.heights ? g.heights[from] : g.origin[1];
      }
  }
  return { cell, origin: [minX, 0, minZ], size: [cols, rows], radius: grids[0].radius ?? 0, climb: grids[0].climb ?? 0.5, areas, cells, heights, tiles: grids.length };
}
