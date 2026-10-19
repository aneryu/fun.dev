// Scatter (docs/worlds.md §5): deterministic placements along a path, inside an area or on a
// grid. The same code runs in the workshop when a rule is derived and in a game that asks the
// runtime to scatter at play time; it knows nothing about documents: inputs are points and
// polygons, the output is rows [x, y, z, rx, ry, rz, scale] (degrees, uniform scale).
import { createRandom } from "./random.js";

const TAU = Math.PI * 2;
const degrees = (radians) => (radians * 180) / Math.PI;

/** Stations along a polyline every `spacing` metres, with the path's direction at each. */
export function alongPath(points, { closed = false, spacing = 1, start = 0, end = null, jitter = 0 } = {}, random = createRandom(1)) {
  const list = closed && points.length > 1 ? [...points, points[0]] : points;
  const lengths = [0];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    lengths.push(lengths[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = lengths[lengths.length - 1], stop = Math.min(end ?? total, total), out = [];
  if (!(spacing > 0) || total <= 0) return out;
  for (let s = start; s <= stop + 1e-9; s += spacing) {
    const at = Math.min(stop, Math.max(0, s + (jitter ? (random.next() - 0.5) * 2 * jitter * spacing : 0)));
    let i = 1;
    while (i < list.length - 1 && lengths[i] < at) i++;
    const a = list[i - 1], b = list[i], span = lengths[i] - lengths[i - 1] || 1, t = (at - lengths[i - 1]) / span;
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], n = Math.hypot(d[0], d[2]) || 1;
    out.push({ position: [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t], direction: [d[0] / n, 0, d[2] / n], distance: at });
  }
  return out;
}

/** Point in polygon (x, z), even-odd. */
export function insidePolygon(polygon, x, z) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function segmentDistance(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const u = l2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
  return Math.hypot(x - (ax + dx * u), z - (az + dz * u));
}
/** Distance from (x, z) to a polygon's edges. */
export function edgeDistance(polygon, x, z) {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++)
    best = Math.min(best, segmentDistance(x, z, polygon[j][0], polygon[j][1], polygon[i][0], polygon[i][1]));
  return best;
}
/** Distance from (x, z) to a polyline (points [x, y, z]). */
export function polylineDistance(points, closed, x, z) {
  const list = closed && points.length > 1 ? [...points, points[0]] : points;
  let best = Infinity;
  for (let i = 1; i < list.length; i++) best = Math.min(best, segmentDistance(x, z, list[i - 1][0], list[i - 1][2], list[i][0], list[i][2]));
  return best;
}

/** Jittered hexagonal grid over a polygon: about one point per spacing² inside it, margin from the edges. */
export function inPolygon(polygon, { spacing = 1, jitter = 0.5, margin = 0, count = null, y = 0 } = {}, random = createRandom(1)) {
  const xs = polygon.map((p) => p[0]), zs = polygon.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const rowStep = spacing * 0.866, out = [];
  if (!(spacing > 0)) return out;
  let row = 0;
  for (let z = minZ + spacing / 2; z <= maxZ; z += rowStep, row++)
    for (let x = minX + spacing / 2 + (row % 2 ? spacing / 2 : 0); x <= maxX; x += spacing) {
      const px = x + (random.next() - 0.5) * jitter * spacing, pz = z + (random.next() - 0.5) * jitter * spacing;
      if (!insidePolygon(polygon, px, pz)) continue;
      if (margin > 0 && edgeDistance(polygon, px, pz) < margin) continue;
      out.push({ position: [px, y, pz] });
    }
  if (count !== null && out.length > count) return random.shuffle(out).slice(0, count);
  return out;
}

/** Rows and columns of a grid, centred on its origin. */
export function onGrid({ cells = [1, 1], spacing = 1, origin = [0, 0, 0] } = {}) {
  const [nx, nz] = cells, out = [];
  for (let i = 0; i < nx; i++)
    for (let k = 0; k < nz; k++)
      out.push({ position: [origin[0] + (i - (nx - 1) / 2) * spacing, origin[1], origin[2] + (k - (nz - 1) / 2) * spacing] });
  return out;
}

/**
 * A scatter rule over resolved inputs: { paths: { id: { points, closed } }, polygons: { id: polygon },
 * zoneY: { id: [bottom, top] }, avoid: { paths: [{ points, closed, width }], polygons: [polygon],
 * boxes: [{ min, max }] } }. Returns one list of rows per candidate index and the tints picked.
 */
export function evaluateScatter(rule, inputs, seed = rule.seed ?? 1) {
  const random = createRandom(seed), on = rule.on;
  let stations;
  if (on.path !== undefined) {
    const path = inputs.paths?.[on.path];
    if (!path) throw new Error(`scatter ${rule.id}: no path ${on.path}`);
    const base = alongPath(path.points, { closed: path.closed, spacing: on.spacing, start: on.start, end: on.end, jitter: on.jitter }, random);
    const offsets = Array.isArray(on.offset) ? on.offset : on.sides === "both" ? [on.offset, -on.offset] : [on.offset];
    stations = [];
    for (const s of base)
      for (const offset of offsets) {
        const left = [-s.direction[2], 0, s.direction[0]];
        stations.push({ position: [s.position[0] + left[0] * offset, s.position[1], s.position[2] + left[2] * offset], direction: s.direction, side: Math.sign(offset) });
      }
  } else if (on.zone !== undefined) {
    const polygon = inputs.polygons?.[on.zone];
    if (!polygon) throw new Error(`scatter ${rule.id}: no zone ${on.zone}`);
    stations = inPolygon(polygon, { spacing: on.spacing, jitter: on.jitter, margin: on.margin, count: on.count, y: inputs.zoneY?.[on.zone]?.[0] ?? 0 }, random);
  } else stations = onGrid(on.grid);
  if (rule.y !== undefined && rule.y !== null) for (const s of stations) s.position[1] = rule.y;
  // On the ground: the terrain's height under each station; stations off every terrain go.
  if (rule.ground && inputs.height) stations = stations.filter((s) => { const h = inputs.height(s.position[0], s.position[2]); if (h === null) return false; s.position[1] = h; return true; });
  // Only on some surfaces.
  if (rule.where?.surfaces?.length && inputs.surface) stations = stations.filter((s) => rule.where.surfaces.includes(inputs.surface(s.position[0], s.position[2])));
  if (rule.where?.types?.length && inputs.cellType) stations = stations.filter((s) => rule.where.types.includes(inputs.cellType(s.position[0], s.position[2])));
  // Keep-out: other paths by width, zones, and the footprints of solids.
  const avoid = inputs.avoid ?? {};
  stations = stations.filter((s) => {
    const [x, , z] = s.position;
    if ((avoid.paths ?? []).some((p) => polylineDistance(p.points, p.closed, x, z) < p.width / 2)) return false;
    if ((avoid.polygons ?? []).some((polygon) => insidePolygon(polygon, x, z))) return false;
    if ((avoid.boxes ?? []).some((b) => x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2])) return false;
    return true;
  });
  const candidates = rule.candidates, weights = candidates.map((c) => c.weight ?? 1), total = weights.reduce((a, b) => a + b, 0);
  const rows = candidates.map(() => []), tints = candidates.map(() => []);
  const yaw = rule.yaw ?? { mode: on.path !== undefined ? "path" : "random" };
  for (const s of stations) {
    let pick = 0;
    if (candidates.length > 1) {
      let r = random.next() * total;
      for (pick = 0; pick < candidates.length - 1 && r >= weights[pick]; pick++) r -= weights[pick];
    }
    let angle;
    if (yaw.mode === "path" && s.direction) angle = degrees(Math.atan2(s.direction[0], s.direction[2])) + (s.side < 0 ? 180 : 0);
    else if (yaw.mode === "fixed") angle = yaw.value ?? 0;
    else angle = random.float(0, 360);
    if (yaw.jitter) angle += (random.next() - 0.5) * 2 * yaw.jitter;
    const scale = rule.scale ? random.float(rule.scale[0], rule.scale[1]) : 1;
    rows[pick].push([s.position[0], s.position[1], s.position[2], 0, ((angle % 360) + 360) % 360, 0, scale]);
    const palette = candidates[pick].tints;
    if (palette?.length) tints[pick].push([...random.pick(palette)]);
  }
  return { rows, tints: tints.map((t, i) => (candidates[i].tints?.length ? t : null)) };
}
