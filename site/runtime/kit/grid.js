// Grids (docs/worlds.md §4): a cell map for strategy, builder, tower-defence and dungeon
// games. Each cell has a type (walkable, buildable, a colour, tags) and may have a level
// (`step` metres each: terraces, dungeon floors); the corner sits at the origin like a
// terrain. Pure: the same data builds the mesh in the workshop and answers cell queries and
// grid paths in the game.
import { hexToLinear } from "./terrain.js";

/** A binary heap of [priority, value] for searches. */
export function createHeap() {
  const items = [];
  const swap = (i, j) => { const t = items[i]; items[i] = items[j]; items[j] = t; };
  return {
    get size() { return items.length; },
    push(priority, value) {
      items.push([priority, value]);
      for (let i = items.length - 1; i > 0; ) { const p = (i - 1) >> 1; if (items[p][0] <= items[i][0]) break; swap(i, p); i = p; }
    },
    pop() {
      const top = items[0], last = items.pop();
      if (items.length) {
        items[0] = last;
        for (let i = 0; ; ) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < items.length && items[l][0] < items[m][0]) m = l;
          if (r < items.length && items[r][0] < items[m][0]) m = r;
          if (m === i) break;
          swap(i, m);
          i = m;
        }
      }
      return top;
    },
  };
}

const levelOf = (grid, index) => (grid.levels ? grid.levels[index] : 0);
/** The cell under a world point: its column, row, type, level and floor height; null outside. */
export function cellAt(grid, x, z) {
  const { cell, size: [cols, rows], origin = [0, 0, 0], step = 1 } = grid;
  const col = Math.floor((x - origin[0]) / cell), row = Math.floor((z - origin[2]) / cell);
  if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
  const index = row * cols + col, level = levelOf(grid, index);
  return { col, row, index, type: grid.types[grid.cells[index]] ?? grid.types[0], level, height: origin[1] + level * step };
}
/** The floor height under a world point, null outside the grid. */
export const gridHeightAt = (grid, x, z) => cellAt(grid, x, z)?.height ?? null;
/** The world centre of a cell. */
export function cellCentre(grid, col, row) {
  const { cell, origin = [0, 0, 0], step = 1, size: [cols] } = grid;
  return [origin[0] + (col + 0.5) * cell, origin[1] + levelOf(grid, row * cols + col) * step, origin[2] + (row + 0.5) * cell];
}
/** The grid's extent in its own space (the corner at the origin). */
export function gridBounds(grid) {
  const { cell, size: [cols, rows], step = 1 } = grid;
  let top = 0;
  if (grid.levels) for (let i = 0; i < grid.levels.length; i++) if (grid.levels[i] > top) top = grid.levels[i];
  return { min: [0, 0, 0], max: [cols * cell, top * step, rows * cell] };
}

/** A flat-shaded mesh in the grid's space: a quad per cell at its level, walls where levels differ. */
export function gridMesh(grid) {
  const { cell, size: [cols, rows], step = 1, types = [], cells } = grid;
  const palette = types.map((t) => hexToLinear(t.color ?? "#808080"));
  const positions = [], normals = [], colors = [];
  const put = (a, b, c, color) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const p of [a, b, c]) { positions.push(p[0], p[1], p[2]); normals.push(nx, ny, nz); colors.push(color[0], color[1], color[2]); }
  };
  const quad = (a, b, c, d, color) => { put(a, b, c, color); put(a, c, d, color); };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const index = r * cols + c, y = levelOf(grid, index) * step, color = palette[cells[index]] ?? [0.5, 0.5, 0.5];
      const x0 = c * cell, x1 = x0 + cell, z0 = r * cell, z1 = z0 + cell;
      // Counter-clockwise seen from above (+y), so the top looks up.
      quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], color);
      // Walls to the east and south neighbours when the level changes, facing the lower cell.
      if (c + 1 < cols) {
        const other = levelOf(grid, index + 1) * step;
        if (other !== y) {
          const high = Math.max(y, other), low = Math.min(y, other), wallColor = other > y ? palette[cells[index + 1]] ?? color : color;
          if (other > y) quad([x1, low, z0], [x1, low, z1], [x1, high, z1], [x1, high, z0], wallColor);
          else quad([x1, low, z1], [x1, low, z0], [x1, high, z0], [x1, high, z1], wallColor);
        }
      }
      if (r + 1 < rows) {
        const other = levelOf(grid, index + cols) * step;
        if (other !== y) {
          const high = Math.max(y, other), low = Math.min(y, other), wallColor = other > y ? palette[cells[index + cols]] ?? color : color;
          if (other > y) quad([x1, low, z1], [x0, low, z1], [x0, high, z1], [x1, high, z1], wallColor);
          else quad([x0, low, z1], [x1, low, z1], [x1, high, z1], [x0, high, z1], wallColor);
        }
      }
    }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), colors: Float32Array.from(colors), triangles: positions.length / 9 };
}

/**
 * A* over the cells from the cell under `from` to the one under `to`: walkable types only,
 * four neighbours (eight with `diagonal`), level steps up to `climb`, optionally only `types`
 * (ids). Returns the cells and their world centres.
 */
export function gridPath(grid, from, to, { walkable = true, diagonal = false, climb = 1, types = null } = {}) {
  const start = cellAt(grid, from[0], from[2]), goal = cellAt(grid, to[0], to[2]);
  const none = { found: false, cells: [], points: [], length: 0 };
  if (!start || !goal) return none;
  const { cell, size: [cols, rows], cells, types: table } = grid;
  const allowed = types ? new Set(types) : null;
  const open = (index) => {
    const type = table[cells[index]];
    if (!type) return false;
    if (walkable && type.walkable === false) return false;
    return !allowed || allowed.has(type.id);
  };
  if (!open(start.index) || !open(goal.index)) return none;
  const steps = diagonal ? [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]] : [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1]];
  const g = new Float64Array(cols * rows).fill(Infinity), came = new Int32Array(cols * rows).fill(-1), closed = new Uint8Array(cols * rows);
  const h = (index) => { const c = index % cols, r = (index - c) / cols; return diagonal ? Math.hypot(c - goal.col, r - goal.row) : Math.abs(c - goal.col) + Math.abs(r - goal.row); };
  const heap = createHeap();
  g[start.index] = 0;
  heap.push(h(start.index), start.index);
  while (heap.size) {
    const [, index] = heap.pop();
    if (closed[index]) continue;
    closed[index] = 1;
    if (index === goal.index) break;
    const c = index % cols, r = (index - c) / cols, level = levelOf(grid, index);
    for (const [dc, dr, cost] of steps) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const next = nr * cols + nc;
      if (closed[next] || !open(next) || Math.abs(levelOf(grid, next) - level) > climb) continue;
      // No cutting corners past blocked cells.
      if (dc && dr && (!open(r * cols + nc) || !open(nr * cols + c))) continue;
      const score = g[index] + cost;
      if (score < g[next]) { g[next] = score; came[next] = index; heap.push(score + h(next), next); }
    }
  }
  if (!Number.isFinite(g[goal.index])) return none;
  const chain = [];
  for (let i = goal.index; i !== -1; i = came[i]) chain.push(i);
  chain.reverse();
  const list = chain.map((i) => [i % cols, (i - (i % cols)) / cols]);
  return { found: true, cells: list, points: list.map(([c, r]) => cellCentre(grid, c, r)), length: g[goal.index] * cell };
}
