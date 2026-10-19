// Terrain (docs/worlds.md §4): height fields shaped by ops, classified into surfaces, asked
// for heights and surfaces, and turned into flat-shaded low-poly meshes. Samples are
// row-major (k rows along +z of nx columns along +x) from the terrain's origin corner; the
// same code shapes a terrain in the workshop and answers a game's queries at play time.

// Value noise on an integer lattice, hashed with the seed; fbm sums octaves of it.
function lattice(ix, iz, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const smooth = (t) => t * t * (3 - 2 * t);
export function valueNoise(x, z, seed = 1) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = smooth(x - ix), fz = smooth(z - iz);
  const a = lattice(ix, iz, seed), b = lattice(ix + 1, iz, seed), c = lattice(ix, iz + 1, seed), d = lattice(ix + 1, iz + 1, seed);
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}
/** Fractal noise in −1..1 over world metres: scale is the largest feature's size. */
export function fbm(x, z, { scale = 100, octaves = 4, persistence = 0.5, lacunarity = 2, seed = 1 } = {}) {
  let sum = 0, amplitude = 1, frequency = 1 / scale, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += (valueNoise(x * frequency + o * 17.17, z * frequency - o * 31.3, seed + o * 1013) * 2 - 1) * amplitude;
    norm += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }
  return sum / norm;
}

function segmentDistance(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const u = l2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
  return { distance: Math.hypot(x - (ax + dx * u), z - (az + dz * u)), u };
}
function insidePolygon(polygon, x, z) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function edgeDistance(polygon, x, z) {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) best = Math.min(best, segmentDistance(x, z, polygon[j][0], polygon[j][1], polygon[i][0], polygon[i][1]).distance);
  return best;
}
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Heights from ops, in world metres (origin is the terrain's corner in the world; heights are
 * absolute): noise { amplitude, scale, octaves, persistence, seed, mode: add | set }, stamp
 * { shape: circle | box, center, radius | size, height, falloff, mode: add | set | max | min },
 * flatten { points (a world polyline), width, blend, height: "path" | number }, level
 * { polygon, height, blend }, smooth { passes }, clamp { min, max }, add { height }.
 */
export function generateHeights({ cell, samples: [nx, nz], origin = [0, 0, 0] }, ops = [], seed = 1) {
  const heights = new Float32Array(nx * nz);
  const world = (i, k) => [origin[0] + i * cell, origin[2] + k * cell];
  for (const op of ops) {
    if (op.noise) {
      const n = op.noise, amplitude = n.amplitude ?? 10;
      for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const [x, z] = world(i, k), v = fbm(x + (n.offset?.[0] ?? 0), z + (n.offset?.[1] ?? 0), { scale: n.scale ?? 100, octaves: n.octaves ?? 4, persistence: n.persistence ?? 0.5, lacunarity: n.lacunarity ?? 2, seed: n.seed ?? seed }) * amplitude;
        heights[k * nx + i] = n.mode === "set" ? v : heights[k * nx + i] + v;
      }
    } else if (op.stamp) {
      const s = op.stamp, [cx, cz] = s.center ?? [0, 0], falloff = s.falloff ?? 0, mode = s.mode ?? "add";
      for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const [x, z] = world(i, k);
        let outside;
        if (s.shape === "box") { const [w, d] = s.size ?? [1, 1]; outside = Math.max(Math.abs(x - cx) - w / 2, Math.abs(z - cz) - d / 2); }
        else outside = Math.hypot(x - cx, z - cz) - (s.radius ?? 1);
        if (outside >= falloff) continue;
        const weight = outside <= 0 ? 1 : 1 - smooth(outside / falloff);
        const index = k * nx + i, target = s.height ?? 0;
        if (mode === "add") heights[index] += target * weight;
        else if (mode === "set") heights[index] = lerp(heights[index], target, weight);
        else if (mode === "max") heights[index] = lerp(heights[index], Math.max(heights[index], target), weight);
        else if (mode === "min") heights[index] = lerp(heights[index], Math.min(heights[index], target), weight);
      }
    } else if (op.flatten) {
      const f = op.flatten, points = f.points ?? [], width = f.width ?? 4, blend = f.blend ?? 2;
      if (points.length < 2) continue;
      for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const [x, z] = world(i, k);
        let best = { distance: Infinity, y: 0 };
        for (let p = 1; p < points.length; p++) {
          const a = points[p - 1], b = points[p], hit = segmentDistance(x, z, a[0], a[2], b[0], b[2]);
          if (hit.distance < best.distance) best = { distance: hit.distance, y: lerp(a[1], b[1], hit.u) };
        }
        const outside = best.distance - width / 2;
        if (outside >= blend) continue;
        const target = typeof f.height === "number" ? f.height : best.y, weight = outside <= 0 ? 1 : 1 - smooth(outside / blend);
        heights[k * nx + i] = lerp(heights[k * nx + i], target, weight);
      }
    } else if (op.level) {
      const l = op.level, polygon = l.polygon ?? [], blend = l.blend ?? 2, target = l.height ?? 0;
      if (polygon.length < 3) continue;
      for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const [x, z] = world(i, k), inside = insidePolygon(polygon, x, z);
        const distance = edgeDistance(polygon, x, z);
        const weight = inside ? 1 : distance >= blend ? 0 : 1 - smooth(distance / blend);
        if (weight > 0) heights[k * nx + i] = lerp(heights[k * nx + i], target, weight);
      }
    } else if (op.smooth) {
      for (let pass = 0; pass < (op.smooth.passes ?? 1); pass++) {
        const source = Float32Array.from(heights);
        for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
          let sum = 0, count = 0;
          for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
            const ii = i + di, kk = k + dk;
            if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
            sum += source[kk * nx + ii];
            count++;
          }
          heights[k * nx + i] = sum / count;
        }
      }
    } else if (op.clamp) {
      const { min = -Infinity, max = Infinity } = op.clamp;
      for (let i = 0; i < heights.length; i++) heights[i] = Math.min(max, Math.max(min, heights[i]));
    } else if (op.add) {
      for (let i = 0; i < heights.length; i++) heights[i] += op.add.height ?? 0;
    }
  }
  return heights;
}

/** The surface index of every cell by rules in order (the last matching wins): { slope: [min, max] degrees, height: [min, max] }. */
export function classifySurfaces(heights, { cell, samples: [nx, nz] }, rules) {
  const cells = new Uint8Array((nx - 1) * (nz - 1));
  for (let k = 0; k < nz - 1; k++) for (let i = 0; i < nx - 1; i++) {
    const h00 = heights[k * nx + i], h10 = heights[k * nx + i + 1], h01 = heights[(k + 1) * nx + i], h11 = heights[(k + 1) * nx + i + 1];
    const mean = (h00 + h10 + h01 + h11) / 4;
    const slope = (Math.atan(Math.max(Math.abs(h10 - h00), Math.abs(h11 - h01), Math.abs(h01 - h00), Math.abs(h11 - h10)) / cell) * 180) / Math.PI;
    let chosen = 0;
    rules.forEach((rule, index) => {
      if (rule.slope && (slope < rule.slope[0] || slope > rule.slope[1])) return;
      if (rule.height && (mean < rule.height[0] || mean > rule.height[1])) return;
      chosen = index;
    });
    cells[k * (nx - 1) + i] = chosen;
  }
  return cells;
}

/** Height at a world point, on the triangles the mesh draws (null outside the terrain). */
export function heightAt(terrain, x, z) {
  const { cell, samples: [nx, nz], origin = [0, 0, 0], heights } = terrain;
  const u = (x - origin[0]) / cell, v = (z - origin[2]) / cell;
  if (u < 0 || v < 0 || u > nx - 1 || v > nz - 1) return null;
  const i = Math.min(nx - 2, Math.floor(u)), k = Math.min(nz - 2, Math.floor(v)), fx = u - i, fz = v - k;
  const h00 = heights[k * nx + i], h10 = heights[k * nx + i + 1], h01 = heights[(k + 1) * nx + i], h11 = heights[(k + 1) * nx + i + 1];
  // The diagonal alternates per cell, as the mesh builder splits it.
  if ((i + k) % 2 === 0) return fx + fz <= 1 ? h00 + (h10 - h00) * fx + (h01 - h00) * fz : h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  return fx >= fz ? h00 + (h10 - h00) * fx + (h11 - h10) * fz : h00 + (h01 - h00) * fz + (h11 - h01) * fx;
}
export function surfaceAt(terrain, x, z) {
  const { cell, samples: [nx, nz], origin = [0, 0, 0], surfaces } = terrain;
  const i = Math.floor((x - origin[0]) / cell), k = Math.floor((z - origin[2]) / cell);
  if (i < 0 || k < 0 || i >= nx - 1 || k >= nz - 1) return null;
  const index = surfaces ? surfaces[k * (nx - 1) + i] : 0;
  return terrain.surfaceTable?.[index] ?? { id: String(index), color: "#808080" };
}

const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export function hexToLinear(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [linear(((v >> 16) & 255) / 255), linear(((v >> 8) & 255) / 255), linear((v & 255) / 255)];
}
/**
 * A flat-shaded mesh of the terrain in its own space (origin corner at 0, 0, 0): positions,
 * normals and linear vertex colours per triangle corner, coloured by the cell's surface.
 */
export function terrainMesh(terrain) {
  const { cell, samples: [nx, nz], heights, surfaces, surfaceTable = [] } = terrain;
  const triangles = (nx - 1) * (nz - 1) * 2;
  const positions = new Float32Array(triangles * 9), normals = new Float32Array(triangles * 9), colors = new Float32Array(triangles * 9);
  const palette = surfaceTable.map((s) => hexToLinear(s.color ?? "#808080"));
  let t = 0;
  const corner = (i, k) => [i * cell, heights[k * nx + i], k * cell];
  const put = (a, b, c, color) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx_ = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz_ = ux * vy - uy * vx;
    const l = Math.hypot(nx_, ny, nz_) || 1;
    nx_ /= l; ny /= l; nz_ /= l;
    for (const p of [a, b, c]) {
      positions.set(p, t * 3);
      normals.set([nx_, ny, nz_], t * 3);
      colors.set(color, t * 3);
      t++;
    }
  };
  for (let k = 0; k < nz - 1; k++) for (let i = 0; i < nx - 1; i++) {
    const color = palette[surfaces ? surfaces[k * (nx - 1) + i] : 0] ?? [0.5, 0.5, 0.5];
    const p00 = corner(i, k), p10 = corner(i + 1, k), p01 = corner(i, k + 1), p11 = corner(i + 1, k + 1);
    // Counter-clockwise seen from above (+y), so the faces look up.
    if ((i + k) % 2 === 0) { put(p00, p01, p10, color); put(p10, p01, p11, color); }
    else { put(p00, p01, p11, color); put(p00, p11, p10, color); }
  }
  return { positions, normals, colors, triangles };
}
/** The terrain's extent in its own space, for bounds. */
export function terrainBounds(terrain) {
  const { cell, samples: [nx, nz], heights } = terrain;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < heights.length; i++) { if (heights[i] < min) min = heights[i]; if (heights[i] > max) max = heights[i]; }
  return { min: [0, min, 0], max: [(nx - 1) * cell, max, (nz - 1) * cell] };
}
