// The walkable raster (docs/worlds.md §4, kit/nav.js) baked from a project: the ground
// (terrains, grids, floors and roads tagged ground) less what stands on it, the water, the
// grid cells no one walks, the slopes too steep for the agent, and the agent's own radius.
import { worldMatrix, point } from "./spatial.js";
import { terrainFields, gridFields } from "./rules.js";
import { heightAt } from "../runtime/kit/terrain.js";
import { gridHeightAt, cellAt } from "../runtime/kit/grid.js";
import { placedTemplate } from "./placed.js";

// A placed model blocks where its geometry stands in the agent's band (a trunk, not the
// canopy; a lamp's pole, not its arm): the template's triangles between 20 cm and the
// clearance over its base, rasterised once per template into local footprint points.
const footprints = new WeakMap();
function templateFootprint(template, base, clearance, cell = 0.25) {
  const key = `${clearance}|${cell}`;
  let byKey = footprints.get(template);
  if (!byKey) footprints.set(template, (byKey = new Map()));
  if (byKey.has(key)) return byKey.get(key);
  const low = base + 0.2, high = base + clearance, hits = new Set(), points = [];
  template.root.updateMatrixWorld(true);
  template.root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const position = o.geometry.attributes.position, index = o.geometry.index, e = o.matrixWorld.elements, count = index ? index.count : position.count;
    const at = (k) => {
      const i = index ? index.getX(k) : k, x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
    };
    for (let k = 0; k + 2 < count; k += 3) {
      const t = [at(k), at(k + 1), at(k + 2)];
      const ys = t.map((p) => p[1]);
      if (Math.max(...ys) < low || Math.min(...ys) > high) continue;
      const xs = t.map((p) => p[0]), zs = t.map((p) => p[2]);
      for (let z = Math.floor(Math.min(...zs) / cell); z <= Math.floor(Math.max(...zs) / cell); z++)
        for (let x = Math.floor(Math.min(...xs) / cell); x <= Math.floor(Math.max(...xs) / cell); x++) {
          const px = (x + 0.5) * cell, pz = (z + 0.5) * cell;
          if (triangleHeight(t, px, pz) === null && !(Math.max(...xs) - Math.min(...xs) < cell && Math.max(...zs) - Math.min(...zs) < cell)) continue;
          const id = `${x}|${z}`;
          if (!hits.has(id)) { hits.add(id); points.push([px, 0, pz]); }
        }
    }
  });
  byKey.set(key, points);
  return points;
}

export const NAV_LIMITS = { cells: 1048576 };

/** World triangles of a mesh part (polygon faces fanned), with its first tag that is not ground. */
function groundTriangles(project, node) {
  const m = worldMatrix(project, node.id), vertices = node.mesh.vertices.map((v) => point(m, v)), triangles = [];
  for (const face of node.mesh.faces) for (let i = 1; i + 1 < face.vertices.length; i++) triangles.push([vertices[face.vertices[0]], vertices[face.vertices[i]], vertices[face.vertices[i + 1]]]);
  return triangles;
}
/** The height of a triangle's plane at (x, z), or null when the point is outside it. */
function triangleHeight([a, b, c], x, z) {
  const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
  if (Math.abs(d) < 1e-12) return null;
  const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d, v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d, w = 1 - u - v;
  if (u < -1e-9 || v < -1e-9 || w < -1e-9) return null;
  return u * a[1] + v * b[1] + w * c[1];
}
/** Every copy's world box of a part: placed models per copy, meshes by their vertices. */
function solidBoxes(project, node) {
  const m = worldMatrix(project, node.id), boxes = [];
  const box = (points) => ({ min: [0, 1, 2].map((i) => Math.min(...points.map((p) => p[i]))), max: [0, 1, 2].map((i) => Math.max(...points.map((p) => p[i]))) });
  if (node.mesh) return [box(node.mesh.vertices.map((v) => point(m, v)))];
  if (!node.place) return boxes;
  const { min, max } = node.place.bounds;
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);
  if (!node.copies) return [box(corners.map((c) => point(m, c)))];
  for (const [x, y, z, rx, ry, rz, s] of node.copies) {
    const cy = Math.cos((ry * Math.PI) / 180), sy = Math.sin((ry * Math.PI) / 180);
    // Yaw is what the copies carry in practice; pitch and roll are rare and small.
    void rx; void rz;
    const local = corners.map(([cx, cyy, cz]) => [x + (cx * cy + cz * sy) * s, y + cyy * s, z + (-cx * sy + cz * cy) * s]);
    boxes.push(box(local.map((c) => point(m, c))));
  }
  return boxes;
}

/**
 * Bakes the raster over `rect` ({ min: [x, z], max: [x, z] }): cells of `nav.cell` metres
 * with an area index (0 blocked) and the ground height. Returns the record the tile carries
 * plus counts.
 */
export function buildNavgrid(project, nav, rect) {
  const { cell: wanted = 1, radius = 0.4, slope = 40, climb = 0.5, clearance = 1.8 } = nav;
  const width = rect.max[0] - rect.min[0], depth = rect.max[1] - rect.min[1];
  let cell = wanted;
  while (Math.ceil(width / cell) * Math.ceil(depth / cell) > NAV_LIMITS.cells) cell *= 2;
  const cols = Math.max(1, Math.ceil(width / cell)), rows = Math.max(1, Math.ceil(depth / cell));
  const origin = [rect.min[0], 0, rect.min[1]];
  const cells = new Uint8Array(cols * rows), heights = new Float32Array(cols * rows), blocked = new Uint8Array(cols * rows);
  const areas = [], areaIndex = (id) => { let i = areas.findIndex((a) => a.id === id); if (i < 0) { i = areas.push({ id, cost: 1 }) - 1; } return i + 1; };
  // Ground sources.
  const terrains = terrainFields(project), grids = gridFields(project);
  const water = new Map(project.nodes.filter((n) => n.terrain?.water).map((n) => [n.id, n.terrain.water.level + point(worldMatrix(project, n.id), [0, 0, 0])[1]]));
  const floors = [];
  for (const node of project.nodes) {
    if (!node.mesh || !node.tags?.includes("ground")) continue;
    const triangles = groundTriangles(project, node), area = node.tags.find((t) => t !== "ground") ?? "floor", buckets = new Map();
    triangles.forEach((t, i) => {
      const xs = t.map((p) => p[0]), zs = t.map((p) => p[2]);
      const c0 = Math.max(0, Math.floor((Math.min(...xs) - origin[0]) / cell)), c1 = Math.min(cols - 1, Math.floor((Math.max(...xs) - origin[0]) / cell));
      const r0 = Math.max(0, Math.floor((Math.min(...zs) - origin[2]) / cell)), r1 = Math.min(rows - 1, Math.floor((Math.max(...zs) - origin[2]) / cell));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const k = r * cols + c; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(i); }
    });
    floors.push({ triangles, area, buckets });
  }
  // Each cell: the highest ground under its centre and that ground's area.
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const index = r * cols + c, x = origin[0] + (c + 0.5) * cell, z = origin[2] + (r + 0.5) * cell;
      let best = null, area = null, wet = false;
      for (const t of terrains) {
        const h = heightAt(t, x, z);
        if (h === null) continue;
        const surface = t.surfaces && t.surfaceTable ? t.surfaceTable[t.surfaces[Math.min(t.samples[1] - 2, Math.floor((z - t.origin[2]) / t.cell)) * (t.samples[0] - 1) + Math.min(t.samples[0] - 2, Math.floor((x - t.origin[0]) / t.cell))]] : null;
        if (best === null || h > best) { best = h; area = surface?.id ?? "ground"; wet = water.has(t.node) && h < water.get(t.node); }
      }
      for (const g of grids) {
        const found = cellAt(g, x, z);
        if (!found) continue;
        if (best === null || found.height > best) { best = found.height; area = found.type.walkable === false ? null : found.type.id; wet = false; }
      }
      for (const f of floors) {
        let top = null;
        for (const i of f.buckets.get(index) ?? []) { const h = triangleHeight(f.triangles[i], x, z); if (h !== null && (top === null || h > top)) top = h; }
        if (top !== null && (best === null || top > best)) { best = top; area = f.area; wet = false; }
      }
      if (best === null) continue;
      heights[index] = best;
      if (area === null || wet) { blocked[index] = 1; continue; }
      cells[index] = areaIndex(area);
    }
  // What stands on the ground blocks it (anything lower than a kerb does not): placed models
  // by the geometry in the agent's band when their template is here, else by their box.
  const stamp = (x, z) => {
    const c = Math.floor((x - origin[0]) / cell), r = Math.floor((z - origin[2]) / cell);
    if (c >= 0 && r >= 0 && c < cols && r < rows && cells[r * cols + c]) blocked[r * cols + c] = 1;
  };
  for (const node of project.nodes) {
    if (!(node.mesh || node.place) || node.tags?.includes("ground")) continue;
    const template = node.place ? placedTemplate(node.place) : null;
    if (template?.root) {
      const points = templateFootprint(template, node.place.bounds.min[1], clearance), m = worldMatrix(project, node.id);
      const copies = node.copies ?? [[0, 0, 0, 0, 0, 0, 1]];
      const own = !node.copies;
      for (const [x, y, z, , ry, , s] of copies) {
        const cy = Math.cos((ry * Math.PI) / 180), sy = Math.sin((ry * Math.PI) / 180);
        for (const [px, , pz] of points) {
          const local = own ? [px, 0, pz] : [x + (px * cy + pz * sy) * s, y, z + (-px * sy + pz * cy) * s];
          const w = point(m, local);
          stamp(w[0], w[2]);
        }
      }
      continue;
    }
    for (const b of solidBoxes(project, node)) {
      const c0 = Math.max(0, Math.floor((b.min[0] - origin[0]) / cell)), c1 = Math.min(cols - 1, Math.floor((b.max[0] - origin[0]) / cell));
      const r0 = Math.max(0, Math.floor((b.min[2] - origin[2]) / cell)), r1 = Math.min(rows - 1, Math.floor((b.max[2] - origin[2]) / cell));
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          const index = r * cols + c;
          if (!cells[index]) continue;
          if (b.min[1] < heights[index] + clearance && b.max[1] > heights[index] + 0.2) blocked[index] = 1;
        }
    }
  }
  // Slopes: the rise to a neighbour over the cell, against the agent's limit.
  const limit = Math.tan((slope * Math.PI) / 180) * cell;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const index = r * cols + c;
      if (!cells[index]) continue;
      for (const [dc, dr] of [[1, 0], [0, 1]]) {
        const nc = c + dc, nr = r + dr;
        if (nc >= cols || nr >= rows) continue;
        const next = nr * cols + nc;
        if (!cells[next]) continue;
        const rise = Math.abs(heights[next] - heights[index]);
        if (rise > limit && rise > climb) { blocked[index] = 1; blocked[next] = 1; }
      }
    }
  // The agent's radius: a cell whose centre lies within the radius of a blocked cell's edge
  // is blocked too (a 2 m lane stays open to a 0.4 m agent; a 1.2 m one closes it).
  const grow = Math.ceil(radius / cell + 0.5), dilated = new Uint8Array(cols * rows);
  const near = [];
  for (let dr = -grow; dr <= grow; dr++)
    for (let dc = -grow; dc <= grow; dc++)
      if ((dc || dr) && Math.hypot(Math.max(0, Math.abs(dc) - 0.5), Math.max(0, Math.abs(dr) - 0.5)) * cell < radius - 1e-9) near.push([dc, dr]);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!blocked[r * cols + c]) continue;
      dilated[r * cols + c] = 1;
      for (const [dc, dr] of near) {
        const nc = c + dc, nr = r + dr;
        if (nc >= 0 && nr >= 0 && nc < cols && nr < rows) dilated[nr * cols + nc] = 1;
      }
    }
  let walkable = 0;
  for (let i = 0; i < cells.length; i++) { if (dilated[i]) cells[i] = 0; if (cells[i]) walkable++; }
  return { cell, origin: [origin[0], 0, origin[2]], size: [cols, rows], radius, climb, areas, cells, heights, stats: { walkable, total: cols * rows, blocked: cols * rows - walkable } };
}
