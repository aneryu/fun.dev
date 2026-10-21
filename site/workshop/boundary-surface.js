// Open, ordered 3D curves form the rows of a low-poly surface. No automatic
// reversal: corresponding endpoints and authored sample order are intentional.
import { ModelError, vector, add, sub, mul, cross } from "./mesh.js";

const fail = (message, path) => { throw new ModelError(message, "boundary_surface", path); };
function integer(value, min, max, path) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`Expected integer ${min}–${max}`, path);
  return value;
}
function resample(curve, count, sampling) {
  const distances = [0];
  for (let i = 1; i < curve.length; i++)
    distances.push(distances.at(-1) + (sampling === "index" ? 1 : Math.hypot(...sub(curve[i], curve[i - 1]))));
  const length = distances.at(-1);
  if (length < 1e-12) fail("Boundary curve collapsed", "curves");
  return Array.from({ length: count }, (_, i) => {
    if (i === 0) return [...curve[0]];
    if (i === count - 1) return [...curve.at(-1)];
    const at = i * length / (count - 1);
    let j = 0;
    while (j < curve.length - 2 && distances[j + 1] <= at) j++;
    const t = (at - distances[j]) / (distances[j + 1] - distances[j]);
    return add(mul(curve[j], 1 - t), mul(curve[j + 1], t));
  });
}
export function boundarySurface(options, material) {
  const { curves, tangents, sampling = "index", flip = false, bulge = 0, bulgeDirection = [0, 1, 0],
    closedSections = false, caps = false } = options;
  if (!Array.isArray(curves) || curves.length < 2 || curves.length > 32)
    fail("Provide 2–32 ordered boundary/section curves", "curves");
  const rows = curves.map((curve, row) => {
    if (!Array.isArray(curve) || curve.length < 2 || curve.length > 256)
      fail("A curve has 2–256 local 3D points", `curves.${row}`);
    return curve.map((p, i) => vector(p, `curves.${row}.${i}`));
  });
  if (!["index", "arc"].includes(sampling)) fail("sampling is index or arc", "sampling");
  if ([flip, closedSections, caps].some(v => typeof v !== "boolean") || !Number.isFinite(bulge))
    fail("Expected boolean flip/closedSections/caps and finite bulge", "options");
  if (caps && !closedSections) fail("caps requires closedSections", "caps");
  const samples = integer(options.samples ?? Math.max(...rows.map(r => r.length)), 2, 256, "samples");
  const spans = integer(options.spans ?? 1, 1, 32, "spans");
  if (((rows.length - 1 + Number(closedSections)) * spans + 1) * samples + 2 > 30000) fail("Surface exceeds 30000 vertices", "samples");
  // Tangents are derivatives per strip, with one vector per resampled column.
  if (tangents && (!Array.isArray(tangents) || tangents.length !== rows.length ||
      tangents.some(r => !Array.isArray(r) || r.length !== samples)))
    fail("tangents must have one row per curve and one vector per sample", "tangents");
  const derivatives = tangents?.map((r, j) => r.map((v, i) => vector(v, `tangents.${j}.${i}`)));
  const direction = vector(bulgeDirection, "bulgeDirection"), magnitude = Math.hypot(...direction);
  if (magnitude < 1e-12) fail("bulgeDirection cannot be zero", "bulgeDirection");
  const normal = mul(direction, 1 / magnitude);
  const aligned = rows.map(r => resample(r, samples, sampling));
  if (closedSections) {
    aligned.push(aligned[0]);
    if (derivatives) derivatives.push(derivatives[0]);
  }
  const vertices = [], grid = [], positions = new Map();
  function append(row) {
    grid.push(row.map(p => {
      // Exactly shared endpoints are one vertex, so mouth corners cannot crack
      // simply because two boundary rows meet there. No distance-based welding.
      const key = JSON.stringify(p.map(v => v || 0));
      if (!positions.has(key)) { positions.set(key, vertices.length); vertices.push(p); }
      return positions.get(key);
    }));
  }
  for (let j = 0; j < aligned.length - 1; j++) {
    for (let step = 0; step < spans; step++) {
      const t = step / spans;
      append(aligned[j].map((a, i) => {
        const b = aligned[j + 1][i];
        if (!step) return [...a];
        const p = derivatives ? [0, 1, 2].map(k =>
          (2 * t ** 3 - 3 * t ** 2 + 1) * a[k] +
          (t ** 3 - 2 * t ** 2 + t) * derivatives[j][i][k] +
          (-2 * t ** 3 + 3 * t ** 2) * b[k] +
          (t ** 3 - t ** 2) * derivatives[j + 1][i][k]) :
          add(mul(a, 1 - t), mul(b, t));
        // Zero endpoint derivative: bulge does not change supplied tangents.
        return add(p, mul(normal, bulge * 16 * t ** 2 * (1 - t) ** 2));
      }));
    }
  }
  append(aligned.at(-1));
  const faces = [];
  const face = triangle => faces.push({ id: `f${faces.length}`, vertices: flip ? triangle.reverse() : triangle, material });
  for (let j = 0; j < grid.length - 1; j++) for (let i = 0; i < samples - 1; i++) {
    const quad = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]];
    for (const triangle of [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]]) {
      if (new Set(triangle).size < 3) continue;
      const [a, b, c] = triangle.map(i => vertices[i]);
      if (Math.hypot(...cross(sub(b, a), sub(c, a))) < 1e-12)
        fail("Corresponding samples produce a degenerate triangle; revise curve correspondence", `cell.${j}.${i}`);
      face(triangle);
    }
  }
  if (caps) for (const column of [0, samples - 1]) {
    const ring = grid.slice(0, -1).map(r => r[column]);
    const center = [0, 1, 2].map(k => ring.reduce((sum, i) => sum + vertices[i][k], 0) / ring.length);
    const id = vertices.length; vertices.push(center);
    for (let j = 0; j < ring.length; j++) {
      const a = ring[j], b = ring[(j + 1) % ring.length];
      if (a !== b) face(column === 0 ? [id, a, b] : [id, b, a]);
    }
  }
  if (!faces.length) fail("Boundaries enclose no surface", "curves");
  return { vertices, faces };
}
