// Kit assembly (docs/worlds.md §5): pieces with sockets grow into corridors, road networks,
// fences and runner tracks. A socket is a frame in the piece's space whose +Z points out of
// the piece; two sockets mate when they coincide facing each other. From a start piece the
// assembler takes an open socket, tries the pieces whose sockets may mate it (by weight, in
// seeded order), keeps the first that fits inside the bounds and clear of what stands, and goes
// on until the count is reached or nothing is open. The same code runs in the workshop when a
// rule is derived and in a game that assembles at play time. Rows are [x, y, z, rx, ry, rz, 1].
import { createRandom } from "./random.js";

const DEG = Math.PI / 180;
export const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}
/** A column-major 4×4 from position, Euler XYZ degrees and a uniform scale. */
export function compose(position = [0, 0, 0], rotation = [0, 0, 0], scale = 1) {
  const [a, b, c] = rotation.map((v) => v * DEG), ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  // Three.js Euler XYZ: R = Rx · Ry · Rz applied to column vectors.
  return [
    cb * cc * scale, (sa * sb * cc + ca * sc) * scale, (-ca * sb * cc + sa * sc) * scale, 0,
    -cb * sc * scale, (-sa * sb * sc + ca * cc) * scale, (ca * sb * sc + sa * cc) * scale, 0,
    sb * scale, -sa * cb * scale, ca * cb * scale, 0,
    position[0], position[1], position[2], 1,
  ];
}
/** Inverse of a rigid or uniformly scaled transform. */
export function invert(m) {
  const sx2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
  const r = [m[0] / sx2, m[4] / sx2, m[8] / sx2, 0, m[1] / sx2, m[5] / sx2, m[9] / sx2, 0, m[2] / sx2, m[6] / sx2, m[10] / sx2, 0, 0, 0, 0, 1];
  r[12] = -(r[0] * m[12] + r[4] * m[13] + r[8] * m[14]);
  r[13] = -(r[1] * m[12] + r[5] * m[13] + r[9] * m[14]);
  r[14] = -(r[2] * m[12] + r[6] * m[13] + r[10] * m[14]);
  return r;
}
export const apply = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
/** Position and Euler XYZ degrees of a rigid transform (uniform scale 1 assumed for rows). */
export function decompose(m) {
  const sx = Math.hypot(m[0], m[1], m[2]) || 1, sy = Math.hypot(m[4], m[5], m[6]) || 1, sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const m02 = m[8] / sz, m12 = m[9] / sz, m22 = m[10] / sz, m01 = m[4] / sy, m00 = m[0] / sx, m11 = m[5] / sy, m10 = m[1] / sx;
  const y = Math.asin(Math.max(-1, Math.min(1, m02)));
  const x = Math.abs(m02) < 0.9999999 ? Math.atan2(-m12, m22) : Math.atan2(m[6] / sy, m11);
  const z = Math.abs(m02) < 0.9999999 ? Math.atan2(-m01, m00) : 0;
  const clean = (v) => { const d = Math.round((v / DEG) * 1e4) / 1e4; return Object.is(d, -0) ? 0 : d; };
  return { position: [m[12], m[13], m[14]], rotation: [clean(x), clean(y), clean(z)], scale: sx };
}
// Two sockets mate facing each other: the new piece's socket turned half a turn about its up.
const FLIP = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

/** Socket frames at the sides of a box: n (−z), s (+z), e (+x), w (−x), up, down; at the base. */
export function boxSockets(bounds, sides) {
  const { min, max } = bounds, cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2, cy = (min[1] + max[1]) / 2;
  const frames = {
    n: { position: [cx, min[1], min[2]], rotation: [0, 180, 0] },
    s: { position: [cx, min[1], max[2]], rotation: [0, 0, 0] },
    e: { position: [max[0], min[1], cz], rotation: [0, 90, 0] },
    w: { position: [min[0], min[1], cz], rotation: [0, -90, 0] },
    up: { position: [cx, max[1], cz], rotation: [-90, 0, 0] },
    down: { position: [cx, min[1], cz], rotation: [90, 0, 0] },
  };
  const out = {};
  for (const [side, tag] of Object.entries(sides)) {
    if (!frames[side]) throw new Error(`box sockets: unknown side ${side}`);
    out[side] = { ...frames[side], tags: [tag], y: cy };
  }
  return out;
}

function worldBounds(bounds, m) {
  const corners = [];
  for (let i = 0; i < 8; i++) corners.push(apply(m, [i & 1 ? bounds.max[0] : bounds.min[0], i & 2 ? bounds.max[1] : bounds.min[1], i & 4 ? bounds.max[2] : bounds.min[2]]));
  return { min: [0, 1, 2].map((k) => Math.min(...corners.map((c) => c[k]))), max: [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k]))) };
}
const overlapDepth = (a, b) => [0, 1, 2].map((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]));
function insidePolygon(polygon, x, z) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Grows an assembly. pieces: [{ bounds: { min, max }, sockets: { name: { position, rotation,
 * tags } }, weight, start, closer }]. rule: { seed, count, start (piece index), at, yaw, mates
 * ([[open, new]] pairs, default: equal tags), frontier ("any" | "last"), from (the start piece's
 * socket a chain grows from), sequence (piece indices for chains), bounds (polygon [[x, z]]),
 * tolerance, close }. Returns rows per piece index, the sockets left open and what happened.
 */
export function evaluateAssembly(rule, pieces, seed = rule.seed ?? 1) {
  const random = createRandom(seed);
  const count = rule.count ?? 64, tolerance = rule.tolerance ?? 0.05, frontier = rule.frontier ?? "any";
  // Which new socket may meet an open one: [open, new] pairs; without a table, equal tags.
  const mates = (open, candidate) => (rule.mates?.length ? rule.mates.some(([x, y]) => x === open && y === candidate) : open === candidate);
  const either = (a, b) => mates(a, b) || mates(b, a);
  const placed = []; // { piece, matrix, bounds, sockets: [{ name, tags, matrix, open }] }
  const rows = pieces.map(() => []);
  const socketsOf = (piece, matrix) =>
    Object.entries(piece.sockets ?? {}).map(([name, s]) => ({ name, tags: s.tags ?? [], matrix: multiply(matrix, compose(s.position, s.rotation)), open: true }));
  const fits = (piece, matrix) => {
    const box = worldBounds(piece.bounds, matrix);
    if (rule.bounds) {
      const corners = [[box.min[0], box.min[2]], [box.max[0], box.min[2]], [box.max[0], box.max[2]], [box.min[0], box.max[2]]];
      if (!corners.every(([x, z]) => insidePolygon(rule.bounds, x, z))) return null;
    }
    for (const other of placed) {
      const depth = overlapDepth(box, other.bounds);
      if (depth.every((d) => d > tolerance)) return null;
    }
    for (const b of rule.avoid?.boxes ?? []) if (overlapDepth(box, b).every((d) => d > tolerance)) return null;
    return box;
  };
  // Adjacency: a socket may not face into a piece that offers no mating socket there, and a
  // piece may not block an open socket of what stands without mating it (no road into a wall).
  const forward = (m) => { const p = apply(m, [0, 0, 0.1]); return [p[0], p[1], p[2]]; };
  const inside = (p, box) => p[0] > box.min[0] + 1e-6 && p[0] < box.max[0] - 1e-6 && p[1] > box.min[1] - 1e-6 && p[1] < box.max[1] + 1e-6 && p[2] > box.min[2] + 1e-6 && p[2] < box.max[2] - 1e-6;
  const coincide = (a, b) => Math.hypot(a[12] - b[12], a[13] - b[13], a[14] - b[14]) < 1e-3;
  const consistent = (piece, matrix, box) => {
    const sockets = socketsOf(piece, matrix);
    for (const s of sockets) {
      const probe = forward(s.matrix);
      for (const other of placed)
        if (inside(probe, other.bounds) && !other.sockets.some((t) => coincide(t.matrix, s.matrix) && either(t.tags[0], s.tags[0]))) return false;
    }
    for (const other of placed)
      for (const t of other.sockets)
        if (t.open && inside(forward(t.matrix), box) && !sockets.some((s) => coincide(s.matrix, t.matrix) && either(t.tags[0], s.tags[0]))) return false;
    return true;
  };
  const place = (index, matrix, box) => {
    const entry = { piece: index, matrix, bounds: box ?? worldBounds(pieces[index].bounds, matrix), sockets: socketsOf(pieces[index], matrix) };
    placed.push(entry);
    const d = decompose(matrix);
    rows[index].push([...d.position.map((v) => Math.round(v * 1e6) / 1e6 || 0), ...d.rotation, 1]);
    // Sockets landing on open sockets of what stands already are connected, not open.
    for (const s of entry.sockets)
      for (const other of placed)
        if (other !== entry)
          for (const t of other.sockets)
            if (t.open && Math.hypot(s.matrix[12] - t.matrix[12], s.matrix[13] - t.matrix[13], s.matrix[14] - t.matrix[14]) < 1e-3 && either(t.tags[0], s.tags[0])) { s.open = false; t.open = false; }
    return entry;
  };
  // The start piece, at the rule's origin.
  const startIndex = rule.start ?? pieces.findIndex((p) => p.start) ?? 0;
  const first = pieces[startIndex < 0 ? 0 : startIndex];
  if (!first) throw new Error("assemble: no start piece");
  const startMatrix = compose(rule.at ?? [0, 0, 0], [0, rule.yaw ?? 0, 0]);
  const startBox = fits(first, startMatrix);
  if (!startBox) throw new Error("assemble: the start piece does not fit the bounds");
  let last = place(startIndex < 0 ? 0 : startIndex, startMatrix, startBox);
  // A chain grows from one socket of the start piece (`from`, else its first); the others wait.
  if (frontier === "last" && rule.from) {
    const chosen = last.sockets.find((s) => s.name === rule.from);
    if (!chosen) throw new Error(`assemble: the start piece has no socket ${rule.from}`);
    last.sockets = [chosen, ...last.sockets.filter((s) => s !== chosen)];
  }
  let steps = 0;
  const open = () => (frontier === "last" ? last.sockets.filter((s) => s.open) : placed.flatMap((p) => p.sockets.filter((s) => s.open)));
  const stuck = new Set();
  while (placed.length < count) {
    const candidates = open().filter((s) => !stuck.has(s));
    if (!candidates.length) break;
    const socket = frontier === "last" ? candidates[0] : random.pick(candidates);
    const order = rule.sequence ? [rule.sequence[steps % rule.sequence.length]] : weightedOrder(pieces, random, (p) => !p.closer);
    let done = false;
    for (const index of order) {
      const piece = pieces[index];
      const mating = Object.entries(piece.sockets ?? {}).filter(([, s]) => mates(socket.tags[0], s.tags?.[0]));
      for (const [name, s] of random.shuffle(mating)) {
        const matrix = multiply(multiply(socket.matrix, FLIP), invert(compose(s.position, s.rotation)));
        const box = fits(piece, matrix);
        if (!box || !consistent(piece, matrix, box)) continue;
        const entry = place(index, matrix, box);
        socket.open = false;
        const own = entry.sockets.find((t) => t.name === name);
        if (own) own.open = false;
        last = entry;
        done = true;
        break;
      }
      if (done) break;
    }
    if (!done) stuck.add(socket);
    steps++;
    if (steps > count * 8) break;
  }
  // Closers cap what stays open: end pieces, walls, buffers.
  const everyOpen = () => placed.flatMap((p) => p.sockets.filter((s) => s.open));
  if (rule.close !== false && pieces.some((p) => p.closer))
    for (const socket of everyOpen())
      for (const index of weightedOrder(pieces, random, (p) => p.closer)) {
        const piece = pieces[index];
        const mating = Object.entries(piece.sockets ?? {}).filter(([, s]) => mates(socket.tags[0], s.tags?.[0]));
        let capped = false;
        for (const [name, s] of mating) {
          const matrix = multiply(multiply(socket.matrix, FLIP), invert(compose(s.position, s.rotation)));
          const box = fits(piece, matrix);
          if (!box || !consistent(piece, matrix, box)) continue;
          const entry = place(index, matrix, box);
          socket.open = false;
          const own = entry.sockets.find((t) => t.name === name);
          if (own) own.open = false;
          capped = true;
          break;
        }
        if (capped) break;
      }
  return {
    rows,
    placed: placed.length,
    open: everyOpen().map((s) => ({ tags: s.tags, position: s.matrix.slice(12, 15).map((v) => Math.round(v * 1e6) / 1e6 || 0) })),
    stuck: stuck.size,
  };
}

function weightedOrder(pieces, random, keep) {
  const pool = pieces.map((p, index) => ({ index, weight: p.weight ?? 1 })).filter(({ index }) => keep(pieces[index]) && (pieces[index].weight ?? 1) > 0);
  const out = [];
  while (pool.length) {
    const total = pool.reduce((s, p) => s + p.weight, 0);
    let r = random.next() * total, i = 0;
    while (i < pool.length - 1 && r >= pool[i].weight) r -= pool[i++].weight;
    out.push(pool.splice(i, 1)[0].index);
  }
  return out;
}
