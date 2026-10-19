// Lots (docs/worlds.md §5): parcels along a road, one after another on either side, each
// taking a library model that fits its frontage and faces the road, a street of houses from
// a path and a few numbers. Pure: paths and candidates in, rows per candidate and the lots
// out, so the workshop bakes with it and a game may run it.
import { createRandom, hashString } from "./random.js";
import { insidePolygon, polylineDistance } from "./scatter.js";

/** The point and direction at a distance along a polyline (closed: wraps), with its length. */
export function polylineAt(points, closed, distance) {
  const list = closed && points.length > 1 ? [...points, points[0]] : points;
  const lengths = [0];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    lengths.push(lengths[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = lengths[lengths.length - 1];
  const at = closed && total > 0 ? ((distance % total) + total) % total : Math.min(total, Math.max(0, distance));
  let i = 1;
  while (i < list.length - 1 && lengths[i] < at) i++;
  const a = list[i - 1], b = list[i], span = lengths[i] - lengths[i - 1] || 1, t = (at - lengths[i - 1]) / span;
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], n = Math.hypot(d[0], d[2]) || 1;
  return { position: [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t], direction: [d[0] / n, 0, d[2] / n], length: total };
}
const round = (v) => Math.round(v * 1000) / 1000;
const range = (value, random) => (Array.isArray(value) ? value[0] + (value[1] - value[0]) * random.next() : value);
const FRONTS = { "+z": 0, "-z": 180, "+x": -90, "-x": 90 };

/**
 * Lays lots along the rule's paths. `inputs.paths[id] = { points, closed }` (world), optional
 * `inputs.polygons[rule.bounds]`, `inputs.avoid` ({ paths: [{ points, closed, width }],
 * polygons, boxes }) and `inputs.height(x, z)` for `ground`. Candidates carry the library's
 * `bounds`; one fitting the lot's frontage and depth is drawn by weight and stands with its
 * front edge on the lot's front line, facing the road. Returns rows per candidate
 * ([x, y, z, 0, yaw, 0, 1]) and the lots ({ path, side, distance, width, depth, centre, yaw,
 * corners, candidate, position }).
 */
export function evaluateLots(rule, inputs, seed = rule.seed ?? 1) {
  const random = createRandom(typeof seed === "string" ? hashString(seed) : seed);
  const candidates = rule.candidates ?? [];
  const rows = candidates.map(() => []), lots = [];
  const sides = rule.sides === "left" ? [-1] : rule.sides === "right" ? [1] : [1, -1];
  const width = rule.width ?? [10, 16], depth = rule.depth ?? 12, gap = rule.gap ?? [0, 0], offset = rule.offset ?? 5.5;
  const bounds = rule.bounds ? inputs.polygons?.[rule.bounds] : null;
  const avoid = inputs.avoid ?? { paths: [], polygons: [], boxes: [] };
  const clear = (x, z) => {
    if (bounds && !insidePolygon(bounds, x, z)) return false;
    for (const a of avoid.paths) if (polylineDistance(a.points, a.closed, x, z) < (a.width ?? 1) / 2) return false;
    for (const polygon of avoid.polygons) if (insidePolygon(polygon, x, z)) return false;
    for (const box of avoid.boxes) if (x >= box.min[0] && x <= box.max[0] && z >= box.min[2] && z <= box.max[2]) return false;
    return true;
  };
  // A candidate's extent along the frontage and into the lot, its front edge and its lateral
  // centre, in the lot's frame (the front axis turned to face the road).
  const footprints = candidates.map((c) => {
    const { min, max } = c.bounds, front = c.front ?? "+z", margin = c.margin ?? 1;
    const along = front === "+z" || front === "-z" ? max[0] - min[0] : max[2] - min[2];
    const into = front === "+z" || front === "-z" ? max[2] - min[2] : max[0] - min[0];
    const centreX = (min[0] + max[0]) / 2, centreZ = (min[2] + max[2]) / 2;
    // The middle of the model's front edge, in its own frame.
    const local = front === "+z" ? [centreX, 0, max[2]] : front === "-z" ? [centreX, 0, min[2]] : front === "+x" ? [max[0], 0, centreZ] : [min[0], 0, centreZ];
    return { along: along + 2 * margin, into, local, turn: FRONTS[front] ?? 0, weight: c.weight ?? 1 };
  });
  for (const [id, path] of Object.entries(inputs.paths ?? {})) {
    const { length } = polylineAt(path.points, path.closed, 0);
    const end = Math.min(rule.end ?? length, length);
    for (const side of sides) {
      let s = rule.start ?? 0, previous = null;
      while (s < end) {
        const w = range(width, random), d = range(depth, random);
        if (s + w > end + 1e-9) break;
        const centre = s + w / 2, { position, direction } = polylineAt(path.points, path.closed, centre);
        // Right of travel is (-dz, 0, dx); the lot lies `offset` out from the centreline.
        const right = [-direction[2], 0, direction[0]], out = [right[0] * side, 0, right[2] * side];
        const front = [position[0] + out[0] * offset, position[1], position[2] + out[2] * offset];
        const lotCentre = [front[0] + out[0] * (d / 2), front[1], front[2] + out[2] * (d / 2)];
        let y = lotCentre[1];
        if (rule.ground) { const h = inputs.height?.(lotCentre[0], lotCentre[2]); if (h === null || h === undefined) { s += w + range(gap, random); continue; } y = h; }
        const ok = clear(lotCentre[0], lotCentre[2]) && !(previous && Math.hypot(lotCentre[0] - previous[0], lotCentre[2] - previous[2]) < (previous[3] + w) / 2 - 0.01);
        if (ok) {
          // The lot's frame: x along the frontage (travel direction), z into the lot.
          const facing = [-out[0], 0, -out[2]], yawRoad = (Math.atan2(facing[0], facing[2]) * 180) / Math.PI;
          const corners = [[-w / 2, 0], [w / 2, 0], [w / 2, d], [-w / 2, d]].map(([a, b]) => [front[0] + direction[0] * a + out[0] * b, front[2] + direction[2] * a + out[2] * b]);
          const fitting = footprints.map((f, i) => ({ f, i })).filter(({ f }) => f.along <= w && f.into <= d);
          let chosen = null;
          if (fitting.length) {
            const total = fitting.reduce((sum, { f }) => sum + f.weight, 0);
            let pick = random.next() * total;
            for (const entry of fitting) { pick -= entry.f.weight; if (pick <= 0) { chosen = entry; break; } }
            chosen ??= fitting[fitting.length - 1];
          }
          let placed = null;
          if (chosen) {
            const { f, i } = chosen, yaw = yawRoad + f.turn;
            // The model's front edge on the front line, its lateral centre on the lot's.
            const rad = (yaw * Math.PI) / 180, sin = Math.sin(rad), cos = Math.cos(rad), local = f.local;
            const world = [local[0] * cos + local[2] * sin, 0, -local[0] * sin + local[2] * cos];
            placed = [round(front[0] - world[0]), round(y), round(front[2] - world[2]), 0, round(((yaw % 360) + 360) % 360), 0, 1];
            rows[i].push(placed);
          }
          lots.push({ path: id, side: side > 0 ? "right" : "left", distance: round(centre), width: round(w), depth: round(d), centre: [round(lotCentre[0]), round(y), round(lotCentre[2])], yaw: round(((yawRoad % 360) + 360) % 360), corners: corners.map((c) => c.map(round)), candidate: chosen ? chosen.i : null, position: placed ? placed.slice(0, 3) : null });
          previous = [lotCentre[0], y, lotCentre[2], w];
        }
        s += w + range(gap, random);
      }
    }
  }
  return { rows, tints: candidates.map(() => null), lots };
}
