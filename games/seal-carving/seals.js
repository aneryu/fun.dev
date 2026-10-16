// The seals, their four-character inscriptions and the layout of every cut on the face.
//
// The characters are small seal script (小篆) from the 说文解字, taken from public-domain
// drawings (see glyphs.js and dev/build-glyphs.mjs): each one stretched to fill its square cell
// as seal carvers do, its strokes redrawn at one even width. Glyphs are stored as they print;
// the face is carved mirrored, as a real seal is.
//
// The characters are 朱文, raised: the strokes stay and everything else in the character's cell
// (its ground) is cut away, as in the video, with grooves pushed side by side. The draft guides
// each push. The border and the cross are cut as grooves.
import { GLYPH_SIZE, GLYPH_MASKS } from "./glyphs.js";

export const GRID = 20;

// Face coordinates: u right, v toward the viewer, the face spanning -0.5..0.5 on both.
export const FACE = {
  bevel: 0.022, // width of the chamfer cut along each edge
  border: 0.062, // inset of the border groove's centreline
  frameWidth: 0.017, // border and cross grooves
  glyphWidth: 0.0225, // character grooves: a little over one grid unit, so one push clears a gap
  gap: 0.016, // clear stone between the frame grooves and a cell's grid
};

// Reading order of a four-character seal: right column top then bottom, then left column.
const CELL_ORDER = [[1, 0], [1, 1], [0, 0], [0, 1]];

// Stages, in carving order. Each one's cuts must be finished before the next one's show.
// Each character is its own step, carved in reading order, the stone turned between them.
export const STAGES = ["bevel", "border", "cross", "glyph0", "glyph1", "glyph2", "glyph3", "dust", "done"];
export const isGlyph = (stage) => /^glyph\d$/.test(stage);

// Each seal's characters as displayed, and the seal-script characters carved for them (the
// 说文 has 開 and 萬 where today's writing has 开 and 万). The first seal is the plainest.
export const seals = [
  { id: "best-of-luck", text: { zh: "上上大吉", en: "Best of luck" }, glyphs: "上上大吉", stone: "shoushan-red" },
  { id: "happy-every-day", text: { zh: "天天开心", en: "Happy every day" }, glyphs: "天天開心", stone: "chicken-blood" },
  { id: "safe-and-sound", text: { zh: "平平安安", en: "Safe and sound" }, glyphs: "平平安安", stone: "furong" },
  { id: "all-as-wished", text: { zh: "万事如意", en: "All as you wish" }, glyphs: "萬事如意", stone: "black-jade" },
];

// A glyph's mask: GLYPH_SIZE × GLYPH_SIZE, 1 where a stroke stands, rows top to bottom. It
// spans the character's whole cell, -0.5..GRID + 0.5 in grid units.
const masks = new Map();
export function glyphMask(character) {
  if (!masks.has(character)) {
    const data = GLYPH_MASKS[character];
    if (!data) throw new Error(`No glyph for ${character}`);
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    masks.set(character, Uint8Array.from({ length: GLYPH_SIZE * GLYPH_SIZE }, (_, i) => bytes[i >> 3] >> (i & 7) & 1));
  }
  return masks.get(character);
}
const PIXEL = (GRID + 1) / GLYPH_SIZE; // grid units per mask pixel
const characters = (seal) => [...seal.glyphs];

// The print-side rectangle of each cell, in face coordinates.
function cellBox(column, row) {
  const outer = FACE.border + FACE.frameWidth / 2 + FACE.gap;
  const inner = FACE.frameWidth / 2 + FACE.gap;
  const size = 0.5 - outer - inner;
  return { u: -0.5 + outer + column * (size + 2 * inner), v: -0.5 + outer + row * (size + 2 * inner), size };
}

// Every cut of a seal as straight segments: { stage, a: [u, v], b: [u, v], width, stroke }.
// `stroke` groups the segments of one polyline, so short folds can be cut in one go.
const toFaceOf = (box) => (x, y) => [-(box.u + x / GRID * box.size), box.v + y / GRID * box.size];

// The pushes that clear a character's ground, in mask pixels: [[x, y], [x, y]] centre lines.
// Candidates are the straight runs, across, upright and on both diagonals, whose centre keeps
// clear of the strokes; the longest-reaching are taken greedily until little ground is left.
// A groove `half` mask pixels wide on each side clears what it passes, never the strokes.
const pushCache = new Map();
const CLEARANCE = 0.9; // mask pixels from a push's centre line to the nearest stroke
const MIN_PUSH = 8; // mask pixels
const GUIDED = 0.9; // the share of the ground the guides cover (a character is done at CLEAR_FINISH)
function groundPushes(character, half) {
  const key = `${character}|${half.toFixed(3)}`;
  if (pushCache.has(key)) return pushCache.get(key);
  const N = GLYPH_SIZE, mask = glyphMask(character);
  // Distance (mask pixels) from each pixel to the nearest stroke: a chamfer transform.
  const distance = new Float32Array(N * N);
  for (let i = 0; i < distance.length; i++) distance[i] = mask[i] ? 0 : 1e9;
  const near = [[-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1], [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, 1, Math.SQRT2]];
  for (let pass = 0; pass < 4; pass++) {
    for (let n = 0; n < N * N; n++) {
      const i = pass % 2 ? N * N - 1 - n : n, x = i % N, y = Math.floor(i / N);
      for (const [dx, dy, cost] of near) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < N && ny < N) distance[i] = Math.min(distance[i], distance[ny * N + nx] + cost);
      }
    }
  }
  const free = (x, y) => x >= 0 && y >= 0 && x < N && y < N && distance[y * N + x] > CLEARANCE;
  // Candidate runs along every line of pixel centres in four directions.
  const candidates = [];
  for (const [dx, dy, weight] of [[1, 0, 1], [0, 1, 1], [1, 1, 0.85], [1, -1, 0.85]]) {
    const starts = [];
    for (let k = 0; k < N; k++) {
      if (dx && !dy) starts.push([0, k]);
      else if (dy && !dx) starts.push([k, 0]);
      else if (dy > 0) starts.push([k, 0], ...(k ? [[0, k]] : []));
      else starts.push([k, N - 1], ...(k < N - 1 ? [[0, k]] : []));
    }
    for (const [sx, sy] of starts) {
      let run = null;
      for (let x = sx, y = sy; ; x += dx, y += dy) {
        const inside = x >= 0 && y >= 0 && x < N && y < N;
        if (inside && free(x, y)) { run ??= [x, y]; continue; }
        if (run) {
          const a = run, b = [x - dx, y - dy];
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) + 1 >= MIN_PUSH) candidates.push({ a, b, weight });
          run = null;
        }
        if (!inside) break;
      }
    }
  }
  // The ground pixels each candidate's groove covers.
  for (const candidate of candidates) {
    const [ax, ay] = candidate.a, [bx, by] = candidate.b, vx = bx - ax, vy = by - ay, length2 = vx * vx + vy * vy || 1;
    const covers = [];
    const r = Math.ceil(half);
    for (let y = Math.max(0, Math.min(ay, by) - r); y <= Math.min(N - 1, Math.max(ay, by) + r); y++) {
      for (let x = Math.max(0, Math.min(ax, bx) - r); x <= Math.min(N - 1, Math.max(ax, bx) + r); x++) {
        if (mask[y * N + x]) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / length2));
        if (Math.hypot(x - ax - vx * t, y - ay - vy * t) <= half) covers.push(y * N + x);
      }
    }
    candidate.covers = covers;
    candidate.gain = covers.length * candidate.weight;
  }
  // Greedy cover, lazily re-scored: a candidate's gain only ever shrinks.
  const covered = new Uint8Array(N * N);
  let ground = 0;
  for (let i = 0; i < N * N; i++) if (!mask[i]) ground++;
  let done = 0;
  const pushes = [];
  while (done < ground * GUIDED) {
    let best = null;
    for (const candidate of candidates) if (!best || candidate.gain > best.gain) best = candidate;
    if (!best || best.gain < MIN_PUSH * half) break;
    const fresh = best.covers.filter((i) => !covered[i]).length * best.weight;
    if (fresh < best.gain) { best.gain = fresh; continue; }
    for (const i of best.covers) if (!covered[i]) { covered[i] = 1; done++; }
    best.gain = 0;
    pushes.push([best.a, best.b]);
  }
  pushCache.set(key, pushes);
  return pushes;
}

// Mask pixel (centre) to grid units.
const gridOf = ([x, y]) => [(x + 0.5) * PIXEL - 0.5, (y + 0.5) * PIXEL - 0.5];

// What stays of the characters and where the ground is cleared, in face coordinates:
// { keep: [[u0, v0, u1, v1]] (the strokes, as row runs of their masks), cells: [[u0, v0, u1,
// v1]] (the four cells' grounds), isStroke(u, v) }.
export function layoutRelief(seal) {
  const keep = [], cells = [], boxes = [];
  characters(seal).forEach((character, index) => {
    const [column, row] = CELL_ORDER[index];
    const box = cellBox(column, row);
    const toFace = toFaceOf(box);
    const rect = (x0, y0, x1, y1) => {
      const [a0, b0] = toFace(x0, y0), [a1, b1] = toFace(x1, y1);
      return [Math.min(a0, a1), Math.min(b0, b1), Math.max(a0, a1), Math.max(b0, b1)];
    };
    cells.push(rect(-0.5, -0.5, GRID + 0.5, GRID + 0.5));
    boxes.push({ box, mask: glyphMask(character) });
    const mask = glyphMask(character), N = GLYPH_SIZE;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (!mask[y * N + x] || (x && mask[y * N + x - 1])) continue;
        let end = x;
        while (end + 1 < N && mask[y * N + end + 1]) end++;
        keep.push(rect(x * PIXEL - 0.5, y * PIXEL - 0.5, (end + 1) * PIXEL - 0.5, (y + 1) * PIXEL - 0.5));
      }
    }
  });
  // Whether face point (u, v) lies on a raised stroke.
  const isStroke = (u, v) => boxes.some(({ box, mask }) => {
    const x = Math.floor(((-u - box.u) / box.size * GRID + 0.5) / PIXEL), y = Math.floor(((v - box.v) / box.size * GRID + 0.5) / PIXEL);
    return x >= 0 && y >= 0 && x < GLYPH_SIZE && y < GLYPH_SIZE && mask[y * GLYPH_SIZE + x] === 1;
  });
  return { keep, cells, isStroke };
}

export function layoutSeal(seal) {
  const segments = [];
  let stroke = 0;
  const add = (stage, points, width) => {
    for (let i = 1; i < points.length; i++) segments.push({ stage, a: points[i - 1], b: points[i], width, stroke });
    stroke++;
  };
  // The chamfer: one cut along each edge, its centre half a chamfer in from the edge.
  const e = 0.5 - FACE.bevel / 2;
  for (const points of [[[-e, -e], [e, -e]], [[e, -e], [e, e]], [[e, e], [-e, e]], [[-e, e], [-e, -e]]]) add("bevel", points, FACE.bevel);
  const b = 0.5 - FACE.border;
  for (const points of [[[-b, -b], [b, -b]], [[b, -b], [b, b]], [[b, b], [-b, b]], [[-b, b], [-b, -b]]]) add("border", points, FACE.frameWidth);
  add("cross", [[0, -b], [0, b]], FACE.frameWidth);
  add("cross", [[-b, 0], [b, 0]], FACE.frameWidth);
  characters(seal).forEach((character, index) => {
    const [column, row] = CELL_ORDER[index];
    const box = cellBox(column, row);
    const toFace = toFaceOf(box);
    // Guides over the ground: one per push of the knife.
    // (A little narrower than the groove: the carving samples the ground more coarsely.)
    const half = 0.9 * FACE.glyphWidth / 2 / (box.size / GRID) / PIXEL;
    for (const [a, b] of groundPushes(character, half)) add(`glyph${index}`, [toFace(...gridOf(a)), toFace(...gridOf(b))], FACE.glyphWidth);
  });
  return segments;
}
