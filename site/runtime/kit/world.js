// Scene data of a loaded tile (docs/worlds.md): the markers, zones and paths a game reads,
// each with its tags and the game's own parameters, in the tile's space. Behaviour stays in
// the game; this only answers where things are. No Three.js needed: positions are arrays.
//
//   const data = worldData(tile);                 // tile = await fun3d.load(bytes, { resolve })
//   for (const m of data.markers("spawn")) …      // { id, tags, params, position, rotation, node }
//   data.zone("safe_1").contains([x, y, z]);
//   const lap = data.path("lap"); lap.at(0.5); lap.nearest(p); lap.length

import { evaluateScatter } from "./scatter.js";
import { evaluateAssembly } from "./assemble.js";
import { heightAt, surfaceAt } from "./terrain.js";

const ZONES = "fun3d.zones", PATHS = "fun3d.paths", PARAMS = "fun3d.params", RULES = "fun3d.rules";

function polygonContains(polygon, x, z) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// p rotated by the inverse of the unit quaternion q.
function unrotate(p, q) {
  const [x, y, z] = p, [qx, qy, qz, qw] = [-q[0], -q[1], -q[2], q[3]];
  const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
}

function zoneOf(z) {
  const shape = z.shape ?? {};
  let contains;
  if (shape.polygon) {
    const [y0, y1] = shape.y ?? [-Infinity, Infinity];
    contains = (p) => p[1] >= y0 && p[1] <= y1 && polygonContains(shape.polygon, p[0], p[2]);
  } else if (shape.box) {
    const { center = [0, 0, 0], halfExtents = [0, 0, 0], rotation = null } = shape.box;
    contains = (p) => {
      let d = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
      if (rotation) d = unrotate(d, rotation);
      return Math.abs(d[0]) <= halfExtents[0] && Math.abs(d[1]) <= halfExtents[1] && Math.abs(d[2]) <= halfExtents[2];
    };
  } else if (shape.sphere) {
    const { center = [0, 0, 0], radius = 0 } = shape.sphere;
    contains = (p) => Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) <= radius;
  } else contains = () => false;
  return { id: z.id, tags: [...(z.tags ?? [])], params: z.params ?? {}, shape, contains };
}

function pathOf(edge, points) {
  const list = edge.points.map((i) => [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]]);
  if (edge.closed && list.length > 1) list.push([...list[0]]);
  const cumulative = [0];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    cumulative.push(cumulative[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const length = cumulative[cumulative.length - 1];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  return {
    id: edge.id, kind: edge.kind ?? "data", tags: [...(edge.tags ?? [])], params: edge.params ?? {}, closed: !!edge.closed, points: list.map((p) => [...p]), length,
    /** The point at a fraction of the length (0–1), and the segment's direction. */
    at(t) {
      const target = Math.min(1, Math.max(0, t)) * length;
      for (let i = 1; i < list.length; i++)
        if (target <= cumulative[i] || i === list.length - 1) {
          const span = cumulative[i] - cumulative[i - 1] || 1, a = list[i - 1], b = list[i];
          const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], n = Math.hypot(...d) || 1;
          return { position: lerp(a, b, (target - cumulative[i - 1]) / span), direction: d.map((v) => v / n), segment: i - 1 };
        }
      return { position: [...list[0]], direction: [0, 0, 1], segment: 0 };
    },
    /** The closest point of the path to p: its position, fraction t, distance and segment. */
    nearest(p) {
      let best = { distance: Infinity, position: [...list[0]], t: 0, segment: 0 };
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i], d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        const u = l2 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / l2)) : 0;
        const q = lerp(a, b, u), distance = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        if (distance < best.distance) best = { distance, position: q, t: length ? (cumulative[i - 1] + u * (cumulative[i] - cumulative[i - 1])) / length : 0, segment: i - 1 };
      }
      return best;
    },
  };
}

/** The scene data of a loaded tile or model. */
export function worldData(model) {
  const manifest = model.manifest, extensions = model.extensions ?? manifest.extensions ?? {};
  model.root.updateMatrixWorld(true);
  const markers = [];
  for (const n of manifest.nodes ?? []) {
    const tags = n.tags ?? [], params = n.extensions?.[PARAMS];
    if (!tags.length && !params) continue;
    const object = model.nodes.get(n.id);
    if (n.placements && model.placements?.get(n.id)) {
      // One marker per copy, in the tile's space.
      const { count, transforms } = model.placements.get(n.id), parent = object.parent?.matrixWorld?.elements ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      for (let i = 0; i < count; i++) {
        const t = transforms.subarray(i * 16, i * 16 + 16);
        const x = parent[0] * t[12] + parent[4] * t[13] + parent[8] * t[14] + parent[12], y = parent[1] * t[12] + parent[5] * t[13] + parent[9] * t[14] + parent[13], z = parent[2] * t[12] + parent[6] * t[13] + parent[10] * t[14] + parent[14];
        markers.push({ id: `${n.id}#${i}`, tags: [...tags], params: params ?? {}, position: [x, y, z], rotation: [0, 0, 0, 1], node: object, copy: i });
      }
      continue;
    }
    const e = object.matrixWorld.elements;
    // Position and rotation in the tile's space (the root sits at the origin when loaded).
    const sx = Math.hypot(e[0], e[1], e[2]) || 1, sy = Math.hypot(e[4], e[5], e[6]) || 1, sz = Math.hypot(e[8], e[9], e[10]) || 1;
    const m00 = e[0] / sx, m01 = e[4] / sy, m02 = e[8] / sz, m10 = e[1] / sx, m11 = e[5] / sy, m12 = e[9] / sz, m20 = e[2] / sx, m21 = e[6] / sy, m22 = e[10] / sz;
    const trace = m00 + m11 + m22;
    let q;
    if (trace > 0) { const s = 0.5 / Math.sqrt(trace + 1); q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]; }
    else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
    else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
    else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
    markers.push({ id: n.id, tags: [...tags], params: params ?? {}, position: [e[12], e[13], e[14]], rotation: q, node: object });
  }
  const zones = (extensions[ZONES] ?? []).map(zoneOf);
  const paths = [];
  const table = extensions[PATHS];
  if (table?.points?.stream !== undefined && model.streams) {
    const points = model.streams.of(table.points);
    for (const edge of table.edges ?? []) paths.push(pathOf(edge, points));
  }
  const byTag = (list, tag) => (tag === undefined ? [...list] : list.filter((x) => x.tags.includes(tag)));
  // Terrains: the fields as typed arrays, asked by world x and z.
  const terrains = (extensions["fun3d.terrain"] ?? []).map((t) => ({
    node: t.node, origin: t.origin, cell: t.cell, samples: t.samples, surfaceTable: t.surfaceTable, water: t.water ?? null,
    heights: model.streams ? model.streams.of(t.heights) : new Float32Array(t.samples[0] * t.samples[1]),
    surfaces: t.surfaces && model.streams ? model.streams.of(t.surfaces) : null,
  }));
  const height = (x, z) => { for (const t of terrains) { const h = heightAt(t, x, z); if (h !== null) return h; } return null; };
  const surface = (x, z) => { for (const t of terrains) { const s = surfaceAt(t, x, z); if (s) return s; } return null; };
  // Rules the workshop left for play time (bake: false): the same evaluators, the tile's
  // paths and zones as their inputs, rows in the tile's space, per model.
  const rules = extensions[RULES] ?? [];
  const polygonOf = (zone) => {
    const shape = zone.shape ?? {};
    if (shape.polygon) return shape.polygon;
    if (shape.box) {
      const { center = [0, 0, 0], halfExtents = [0, 0, 0] } = shape.box;
      return [[center[0] - halfExtents[0], center[2] - halfExtents[2]], [center[0] + halfExtents[0], center[2] - halfExtents[2]], [center[0] + halfExtents[0], center[2] + halfExtents[2]], [center[0] - halfExtents[0], center[2] + halfExtents[2]]];
    }
    if (shape.sphere) { const { center = [0, 0, 0], radius = 0 } = shape.sphere, out = []; for (let i = 0; i < 32; i++) out.push([center[0] + radius * Math.cos((i / 32) * Math.PI * 2), center[2] + radius * Math.sin((i / 32) * Math.PI * 2)]); return out; }
    return [];
  };
  const inputsOf = (rule) => {
    const inputs = { paths: {}, polygons: {}, zoneY: {}, avoid: { paths: [], polygons: [], boxes: [...(rule.avoid?.boxes ?? [])] }, height, surface: (x, z) => surface(x, z)?.id ?? null };
    const path = (id) => { const p = paths.find((x) => x.id === id); if (!p) throw new Error(`rule ${rule.id}: the tile has no path ${id}`); return { points: p.points.slice(0, p.closed ? -1 : undefined), closed: p.closed }; };
    const zone = (id) => { const z = zones.find((x) => x.id === id); if (!z) throw new Error(`rule ${rule.id}: the tile has no zone ${id}`); return z; };
    if (rule.kind === "assemble") { if (rule.bounds) inputs.polygons[rule.bounds] = polygonOf(zone(rule.bounds)); }
    else {
      if (rule.on.path !== undefined) inputs.paths[rule.on.path] = path(rule.on.path);
      if (rule.on.zone !== undefined) { const z = zone(rule.on.zone); inputs.polygons[rule.on.zone] = polygonOf(z); inputs.zoneY[rule.on.zone] = z.shape?.y ?? [0, 0]; }
    }
    for (const a of rule.avoid?.paths ?? []) inputs.avoid.paths.push({ ...path(a.path), width: a.width });
    for (const id of rule.avoid?.polygons ?? []) inputs.avoid.polygons.push(polygonOf(zone(id)));
    return inputs;
  };
  const run = (id, { seed } = {}) => {
    const rule = rules.find((r) => r.id === id);
    if (!rule) throw new Error(`the tile has no rule ${id}`);
    const inputs = inputsOf(rule), models = rule.kind === "assemble" ? rule.pieces : rule.candidates;
    let rows, tints = models.map(() => null), report = {};
    if (rule.kind === "assemble") {
      const result = evaluateAssembly({ ...rule, bounds: rule.bounds ? inputs.polygons[rule.bounds] : undefined, avoid: inputs.avoid }, rule.pieces, seed ?? rule.seed);
      rows = result.rows;
      report = { placed: result.placed, open: result.open, stuck: result.stuck };
    } else ({ rows, tints } = evaluateScatter(rule, inputs, seed ?? rule.seed));
    return {
      id: rule.id, kind: rule.kind, tags: [...(rule.tags ?? [])], ...report,
      placed: models.map((m, i) => ({ model: m.model, rows: rows[i], tints: tints[i] })).filter((p) => p.rows.length),
    };
  };
  return {
    rules: () => rules.map((r) => ({ id: r.id, kind: r.kind, tags: [...(r.tags ?? [])], models: (r.kind === "assemble" ? r.pieces : r.candidates).map((m) => m.model) })),
    run,
    terrains: () => terrains.map((t) => ({ node: t.node, origin: t.origin, cell: t.cell, samples: t.samples, surfaceTable: t.surfaceTable, water: t.water })),
    /** The terrain's height under a world point, null off every terrain. */
    height,
    /** The terrain surface under a world point ({ id, color, friction, tags }), null off every terrain. */
    surface,
    markers: (tag) => byTag(markers, tag),
    marker: (id) => markers.find((m) => m.id === id) ?? null,
    zones: (tag) => byTag(zones, tag),
    zone: (id) => zones.find((z) => z.id === id) ?? null,
    /** The zones containing a point. */
    zonesAt: (p) => zones.filter((z) => z.contains(p)),
    paths: (tag) => byTag(paths, tag),
    path: (id) => paths.find((p) => p.id === id) ?? null,
    tile: extensions["fun3d.tile"] ?? null,
  };
}
