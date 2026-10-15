// Reshapes the head to a photo's face: MediaPipe's 3D landmarks are aligned to the default
// face's (rotation, scale, position removed), and what remains (face length, jaw, nose,
// mouth, eye spacing) moves nearby head vertices. The photo UVs follow the landmarks, so the
// texture stays registered while the shape changes.

const DEPTH = 0.6;       // MediaPipe depth is noisier than x/y.
const LIMIT = 0.025;     // Largest landmark move, metres.
const SIGMA = 0.012;     // Smoothing radius of the displacement field.
const REACH = [0.012, 0.04]; // Full effect near the landmarks, none beyond.

// Largest eigenvector of a symmetric 4×4 matrix (Jacobi rotations).
function principal(m) {
  const a = m.map((row) => [...row]);
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 4; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 4; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

// Similarity transform (Horn 1987) that best maps points `from` onto `to` (flat xyz arrays).
export function align(from, to) {
  const n = from.length / 3;
  const cf = [0, 0, 0], ct = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { cf[k] += from[i * 3 + k] / n; ct[k] += to[i * 3 + k] / n; }
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let sf = 0, st = 0;
  for (let i = 0; i < n; i++) {
    const p = [0, 1, 2].map((k) => from[i * 3 + k] - cf[k]), q = [0, 1, 2].map((k) => to[i * 3 + k] - ct[k]);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a][b] += p[a] * q[b];
    sf += p[0] ** 2 + p[1] ** 2 + p[2] ** 2; st += q[0] ** 2 + q[1] ** 2 + q[2] ** 2;
  }
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const [w, x, y, z] = principal(N);
  const R = [
    [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
  ];
  const scale = Math.sqrt(st / sf);
  return (point) => {
    const p = [point[0] - cf[0], point[1] - cf[1], point[2] - cf[2]];
    return [0, 1, 2].map((r) => scale * (R[r][0] * p[0] + R[r][1] * p[1] + R[r][2] * p[2]) + ct[r]);
  };
}

// For each landmark, the landmark nearest to its mirror image across x = 0.
export function mirrors(reference) {
  const count = reference.length / 3;
  return Int32Array.from({ length: count }, (_, i) => {
    let best = i, bestD = Infinity;
    for (let j = 0; j < count; j++) {
      const d = (reference[j * 3] + reference[i * 3]) ** 2 + (reference[j * 3 + 1] - reference[i * 3 + 1]) ** 2 + (reference[j * 3 + 2] - reference[i * 3 + 2]) ** 2;
      if (d < bestD) { bestD = d; best = j; }
    }
    return best;
  });
}

// photo: 468 × (x, y) in 0..1 of a square crop plus depth (crop-width units, smaller = nearer);
// reference: the default face's 468 landmarks in the head frame; vertices: head rest positions.
// Returns per-vertex offsets (flat xyz) or null without depth.
export function fitShape({ landmarks, depth, reference, vertices, strength = 1 }) {
  if (!depth || strength <= 0) return null;
  const count = reference.length / 3;
  const photo = new Float32Array(count * 3);
  // Image right is the character's left (+x); image down is −y; nearer is +z.
  for (let i = 0; i < count; i++) photo.set([landmarks[i * 2], -landmarks[i * 2 + 1], -depth[i]], i * 3);
  const map = align(photo, reference);
  const raw = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const target = map([photo[i * 3], photo[i * 3 + 1], photo[i * 3 + 2]]);
    raw.set([target[0] - reference[i * 3], target[1] - reference[i * 3 + 1], (target[2] - reference[i * 3 + 2]) * DEPTH], i * 3);
  }
  // Faces are nearly symmetric; averaging each landmark with its mirror removes most of what a
  // tilted or turned photo adds.
  const mirror = mirrors(reference);
  const moves = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const j = mirror[i];
    let d = [(raw[i * 3] - raw[j * 3]) / 2, (raw[i * 3 + 1] + raw[j * 3 + 1]) / 2, (raw[i * 3 + 2] + raw[j * 3 + 2]) / 2];
    const length = Math.hypot(...d);
    if (length > LIMIT) d = d.map((v) => (v * LIMIT) / length);
    moves.set(d, i * 3);
  }
  const offsets = new Float32Array(vertices.length);
  const inv = 1 / (2 * SIGMA * SIGMA);
  for (let v = 0; v < vertices.length / 3; v++) {
    const px = vertices[v * 3], py = vertices[v * 3 + 1], pz = vertices[v * 3 + 2];
    let wsum = 0, ox = 0, oy = 0, oz = 0, nearest = Infinity;
    for (let i = 0; i < count; i++) {
      const d2 = (px - reference[i * 3]) ** 2 + (py - reference[i * 3 + 1]) ** 2 + (pz - reference[i * 3 + 2]) ** 2;
      if (d2 < nearest) nearest = d2;
      if (d2 > 9 * SIGMA * SIGMA * 4) continue;
      const w = Math.exp(-d2 * inv);
      wsum += w; ox += w * moves[i * 3]; oy += w * moves[i * 3 + 1]; oz += w * moves[i * 3 + 2];
    }
    if (wsum < 1e-6) continue;
    const t = Math.min(1, Math.max(0, (REACH[1] - Math.sqrt(nearest)) / (REACH[1] - REACH[0])));
    const fade = (strength * t * t * (3 - 2 * t)) / wsum;
    offsets.set([ox * fade, oy * fade, oz * fade], v * 3);
  }
  return offsets;
}
