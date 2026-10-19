// Cutting a project into tiles (docs/worlds.md §3.2). Tile (i, k) is centred on (i·w, k·d),
// so a scene built around the origin is the one tile 0_0 and a world grows outward. A part
// goes to the tile under the centre of its bounds with its ancestors along as pivots; copies
// go row by row; a terrain is split into sub-fields along its cells; markers, zones and paths
// are the world's data, in no tile. Far files keep the terrain coarsened and the big parts.
import { worldMatrix, point, nodePoints, boundsOf } from "./spatial.js";
import { statistics } from "./document.js";

/** The tile grid of a project with `tile`, or null: index and rect of tiles, the allowed extent. */
export function tileGrid(project) {
  if (!project.tile) return null;
  const [w, d] = project.tile.size, span = project.tile.span ?? [1, 1];
  return {
    size: [w, d],
    span,
    index: (x, z) => [Math.floor(x / w + 0.5), Math.floor(z / d + 0.5)],
    rect: (i, k) => ({ min: [i * w - w / 2, k * d - d / 2], max: [i * w + w / 2, k * d + d / 2] }),
    extent: { min: [(-span[0] * w) / 2, (-span[1] * d) / 2], max: [(span[0] * w) / 2, (span[1] * d) / 2] },
  };
}

const tag = (i) => (i < 0 ? `m${-i}` : `${i}`);
/** A node as a bare pivot: its transform, nothing it carried. */
function pivotOf(node) {
  const { mesh, place, marker, zone, path, terrain, tags, params, copies, tints, derived, sockets, material, options, ...rest } = node;
  return { ...rest, mesh: null };
}
/** World bounds of a part without its copies. */
function partBounds(project, node) {
  const m = worldMatrix(project, node.id);
  const points = (node.mesh?.vertices ?? nodePoints({ ...node, copies: undefined })).map((v) => point(m, v));
  return boundsOf(points);
}
const extentOf = (bounds) => Math.max(...bounds.size);

/** A terrain's sub-fields, one per tile its cells fall in (cells by their centres). */
function terrainCuts(project, node, index) {
  const t = node.terrain, o = point(worldMatrix(project, node.id), [0, 0, 0]), [nx, nz] = t.samples, c = t.cell;
  const ranges = (n, origin, axis) => {
    const out = [];
    let start = 0, current = null;
    for (let j = 0; j < n - 1; j++) {
      const centre = origin + (j + 0.5) * c, idx = index(axis === 0 ? centre : 0, axis === 0 ? 0 : centre)[axis === 0 ? 0 : 1];
      if (current === null) current = idx;
      else if (idx !== current) { out.push({ tile: current, from: start, to: j }); start = j; current = idx; }
    }
    out.push({ tile: current, from: start, to: n - 1 });
    return out;
  };
  const cuts = [];
  for (const rz of ranges(nz, o[2], 2))
    for (const rx of ranges(nx, o[0], 0)) {
      const sx = rx.to - rx.from + 1, sz = rz.to - rz.from + 1, heights = new Array(sx * sz);
      for (let k = 0; k < sz; k++) for (let j = 0; j < sx; j++) heights[k * sx + j] = t.heights[(rz.from + k) * nx + rx.from + j];
      let surfaces;
      if (t.surfaces) {
        surfaces = new Array((sx - 1) * (sz - 1));
        for (let k = 0; k < sz - 1; k++) for (let j = 0; j < sx - 1; j++) surfaces[k * (sx - 1) + j] = t.surfaces[(rz.from + k) * (nx - 1) + rx.from + j];
      }
      cuts.push({
        tile: [rx.tile, rz.tile],
        node: {
          ...pivotOf(node),
          id: `${node.id}__${tag(rx.tile)}_${tag(rz.tile)}`,
          parent: null,
          position: [o[0] + rx.from * c, o[1], o[2] + rz.from * c],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          ...(node.tags ? { tags: [...node.tags] } : {}),
          terrain: { cell: c, samples: [sx, sz], heights, ...(surfaces ? { surfaces } : {}), surfaceTable: t.surfaceTable, ...(t.water ? { water: t.water } : {}) },
        },
      });
    }
  return cuts;
}

/** A grid's sub-grids, one per tile its cells fall in (cells by their centres). */
function gridCuts(project, node, index) {
  const g = node.grid, o = point(worldMatrix(project, node.id), [0, 0, 0]), [cols, rows] = g.size, c = g.cell;
  const ranges = (n, origin, axis) => {
    const out = [];
    let start = 0, current = null;
    for (let j = 0; j < n; j++) {
      const centre = origin + (j + 0.5) * c, idx = index(axis === 0 ? centre : 0, axis === 0 ? 0 : centre)[axis === 0 ? 0 : 1];
      if (current === null) current = idx;
      else if (idx !== current) { out.push({ tile: current, from: start, to: j }); start = j; current = idx; }
    }
    out.push({ tile: current, from: start, to: n });
    return out;
  };
  const cuts = [];
  for (const rz of ranges(rows, o[2], 2))
    for (const rx of ranges(cols, o[0], 0)) {
      const w = rx.to - rx.from, h = rz.to - rz.from, cells = new Array(w * h), levels = g.levels ? new Array(w * h) : null;
      for (let k = 0; k < h; k++) for (let j = 0; j < w; j++) {
        cells[k * w + j] = g.cells[(rz.from + k) * cols + rx.from + j];
        if (levels) levels[k * w + j] = g.levels[(rz.from + k) * cols + rx.from + j];
      }
      cuts.push({
        tile: [rx.tile, rz.tile],
        node: {
          ...pivotOf(node),
          id: `${node.id}__${tag(rx.tile)}_${tag(rz.tile)}`,
          parent: null,
          position: [o[0] + rx.from * c, o[1], o[2] + rz.from * c],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          ...(node.tags ? { tags: [...node.tags] } : {}),
          grid: { cell: c, size: [w, h], step: g.step, types: g.types, cells, ...(levels ? { levels } : {}) },
        },
      });
    }
  return cuts;
}

/**
 * The project cut into tiles: `tiles` (sorted by z then x) each with a sub-project of what
 * stands in it, and `data`, the sub-project of markers, zones and paths (with their pivots)
 * that becomes the world's data file.
 */
export function cutTiles(project) {
  const grid = tileGrid(project), index = grid ? grid.index : () => [0, 0];
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const ancestors = (id) => {
    const out = [];
    for (let n = byId.get(id); n?.parent; n = byId.get(n.parent)) out.push(n.parent);
    return out;
  };
  const tiles = new Map();
  const tileFor = (i, k) => {
    const key = `${i}_${k}`;
    if (!tiles.has(key)) tiles.set(key, { x: i, z: k, members: new Map(), extra: [] });
    return tiles.get(key);
  };
  const member = (holder, node, replacement) => {
    holder.members.set(node.id, { node: replacement, pivot: false });
    for (const a of ancestors(node.id)) if (!holder.members.has(a)) holder.members.set(a, { node: byId.get(a), pivot: true });
  };
  const data = { members: new Map() };
  for (const node of project.nodes) {
    if (node.zone || node.path || node.marker) { member(data, node, node); continue; }
    if (node.terrain || node.grid) {
      const cuts = node.terrain ? terrainCuts(project, node, index) : gridCuts(project, node, index);
      if (cuts.length === 1) member(tileFor(...cuts[0].tile), node, node);
      else for (const cut of cuts) tileFor(...cut.tile).extra.push(cut.node);
      continue;
    }
    if (node.copies) {
      const m = worldMatrix(project, node.id), groups = new Map();
      node.copies.forEach((row, r) => {
        const p = point(m, [row[0], row[1], row[2]]), [i, k] = index(p[0], p[2]), key = `${i}_${k}`;
        if (!groups.has(key)) groups.set(key, { tile: [i, k], rows: [] });
        groups.get(key).rows.push(r);
      });
      for (const g of groups.values())
        member(tileFor(...g.tile), node, { ...node, copies: g.rows.map((r) => node.copies[r]), ...(node.tints ? { tints: g.rows.map((r) => node.tints[r]) } : {}) });
      continue;
    }
    if (node.mesh || node.place) {
      const b = partBounds(project, node);
      member(tileFor(...index(b.center[0], b.center[2])), node, node);
    }
  }
  const assemble = (holder) => {
    const nodes = [];
    for (const node of project.nodes) {
      const e = holder.members.get(node.id);
      if (e) nodes.push(e.pivot ? pivotOf(e.node) : e.node);
    }
    nodes.push(...(holder.extra ?? []));
    const { rules, ...rest } = project;
    return { ...rest, nodes };
  };
  const list = [...tiles.values()].sort((a, b) => a.z - b.z || a.x - b.x).map((t) => ({ x: t.x, z: t.z, project: assemble(t) }));
  return { grid, tiles: list, data: assemble(data) };
}

/** Coarsens a height field for the distance: every s-th sample where s divides the cells. */
export function coarsenTerrain(t, step = 4) {
  const [nx, nz] = t.samples;
  const s = [step, step + 1, step - 1, 3, 2].find((k) => k >= 2 && (nx - 1) % k === 0 && (nz - 1) % k === 0);
  if (!s) return t;
  const sx = (nx - 1) / s + 1, sz = (nz - 1) / s + 1, heights = new Array(sx * sz);
  for (let k = 0; k < sz; k++) for (let j = 0; j < sx; j++) heights[k * sx + j] = t.heights[k * s * nx + j * s];
  let surfaces;
  if (t.surfaces) {
    surfaces = new Array((sx - 1) * (sz - 1));
    for (let k = 0; k < sz - 1; k++) for (let j = 0; j < sx - 1; j++) surfaces[k * (sx - 1) + j] = t.surfaces[k * s * (nx - 1) + j * s];
  }
  return { ...t, cell: t.cell * s, samples: [sx, sz], heights, ...(surfaces ? { surfaces } : {}) };
}

/**
 * The far version of a tile's sub-project: terrains coarsened, parts and copies at least
 * `minSize` metres across, their ancestors as pivots; null when nothing is worth the distance.
 */
export function farProject(sub, { minSize = 8, step = 4 } = {}) {
  const byId = new Map(sub.nodes.map((n) => [n.id, n]));
  const keep = new Map();
  const mark = (node, replacement) => {
    keep.set(node.id, { node: replacement, pivot: false });
    for (let n = byId.get(node.parent); n; n = byId.get(n.parent)) if (!keep.has(n.id)) keep.set(n.id, { node: n, pivot: true });
  };
  for (const node of sub.nodes) {
    if (node.terrain) { mark(node, { ...node, terrain: coarsenTerrain(node.terrain, step) }); continue; }
    if (node.grid) { mark(node, node); continue; }
    if (!(node.mesh || node.place)) continue;
    const bounds = partBounds(sub, node);
    if (node.copies) {
      const base = extentOf(bounds);
      const rows = node.copies.map((row, r) => r).filter((r) => base * node.copies[r][6] >= minSize);
      if (rows.length) mark(node, { ...node, copies: rows.map((r) => node.copies[r]), ...(node.tints ? { tints: rows.map((r) => node.tints[r]) } : {}) });
    } else if (extentOf(bounds) >= minSize) mark(node, node);
  }
  if (![...keep.values()].some((e) => !e.pivot)) return null;
  const nodes = [];
  for (const node of sub.nodes) {
    const e = keep.get(node.id);
    if (e) nodes.push(e.pivot ? pivotOf(e.node) : e.node);
  }
  return { ...sub, nodes };
}

/** Per-tile triangle budgets: what streams in together is what a phone draws together. */
export function auditTiles(project, { triangles: limit = 300000 } = {}) {
  const findings = [];
  if (!project.tile) return { findings, tiles: [] };
  const { tiles } = cutTiles(project);
  const report = tiles.map((t) => {
    const s = statistics(t.project);
    return { x: t.x, z: t.z, triangles: s.triangles + s.placedTriangles + s.terrainTriangles + s.gridTriangles, placed: s.placed, copies: s.copies, terrains: s.terrains, grids: s.grids, parts: t.project.nodes.length };
  });
  for (const t of report)
      if (t.triangles > limit)
        findings.push({
          code: "tile-budget",
          severity: "warning",
          tile: [t.x, t.z],
          metric: "triangles",
          actual: t.triangles,
          limit,
          message: `tile ${t.x}_${t.z} has ${t.triangles} triangles, over the budget of ${limit}`,
          suggestion: "Thin the scatter there, pick lighter models, or cut smaller tiles.",
        });
  return { findings, tiles: report };
}
