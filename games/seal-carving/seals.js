// The seals, their four-character inscriptions and the layout of every cut on the face.
//
// Glyphs are drawn in the style of 九叠篆: straight horizontal and vertical strokes, folded
// to fill the cell evenly. Each glyph sits on a 20 × 20 grid (y down) and is written as
// polylines: "M x,y" starts one, then r/l/u/d n moves right/left/up/down by n units.
// Glyphs are authored as they print; the face is carved mirrored, as a real seal is.
//
// The characters are 朱文, raised: each stroke is one grid unit wide and stays; everything else
// in the character's cell (its ground) is cut away, as in the video: mostly single grooves
// between strokes, and a few wider patches cut with several parallel pushes. The draft guides
// each push. The border and the cross are cut as grooves.

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

// Shared glyphs: 天, 大, 平, 好 and others appear twice in a seal, drawn alike (as carvers do,
// though a master varies them a little).
// Dense 九叠篆: strokes on even grid lines, folded so that most gaps between them are one
// unit, a single groove wide, as in the video; a few wider patches are cleared with several
// pushes. The first seal's characters are the plainest.
const G = {
  上: ["M10,0 d16", "M10,2 r8 d2 l6", "M10,6 r10 d2 l8 d2 r8 d2 l8 d2 r8", "M2,2 d12 r8", "M8,2 d12", "M4,12 u10 r2 d10", "M2,16 r18 d2 l18 d2 r18"],
  大: ["M10,0 d16", "M2,6 r16", "M2,6 u4 r6 d2", "M18,6 u4 l6 d2", "M4,8 r12", "M10,10 l6 d10", "M2,12 d8 r2", "M6,12 d8 r2 u8", "M10,10 r6 d10", "M18,12 d8 l2", "M14,12 d8 l2 u8"],
  吉: ["M2,2 r16", "M2,2 d2 r6", "M18,2 d2 l6", "M10,0 d10", "M4,6 r12", "M6,8 r8", "M2,10 r16 d10 l16 u10", "M4,12 r12 d6 l12 u6", "M6,14 r8 d2 l8 u2"],
  只: ["M2,0 r16 d8 l16 u8", "M4,2 r12 d4 l12 u4", "M6,4 r8", "M8,10 l6 d10", "M8,12 d8", "M4,12 r2 d8", "M4,12 d8", "M12,10 r6 d10", "M12,12 d8", "M14,12 r2 d8", "M14,12 d8"],
  是: ["M2,0 r16 d8 l16 u8", "M2,4 r16", "M4,2 r12", "M4,6 r12", "M0,10 r20", "M10,10 d10", "M10,12 r8", "M10,14 r8", "M10,16 r8", "M10,18 r8", "M2,12 d8 r18", "M2,12 r6 d6", "M4,14 r2 d6", "M4,14 d6"],
  好: ["M8,2 l6 d2 r6 d2 l6 d2 r6 d2 l6 d2 r6 d2 l6 d2 r6 d2 l6", "M4,0 d2", "M12,2 r8 d2 l6 d2 r6", "M16,6 d14 l4 u2", "M10,10 r10", "M18,12 d8 r2", "M14,12 d6", "M12,12 d4"],
  玩: ["M0,2 r8", "M2,6 r6", "M2,10 r6", "M2,14 r6", "M0,18 r8", "M4,2 d16", "M6,4 d12", "M2,6 d8", "M12,0 r8", "M10,4 r10", "M14,4 d8 l4 d8", "M18,4 d14 r2 u4", "M16,6 d12"],
  天: ["M2,0 r16", "M4,2 r12", "M2,4 r16", "M0,6 r20", "M10,0 d8", "M10,8 l8 d12", "M10,8 r8 d12", "M4,10 d8 r2 u8", "M8,10 d10", "M16,10 d8 l2 u8", "M12,10 d10"],
  开: ["M0,2 r20", "M2,4 r16", "M2,6 r16", "M2,8 r16", "M0,10 r20", "M6,2 d18", "M14,2 d18", "M2,12 d8 r2 u8", "M16,12 d8 r2 u8", "M8,12 d6 r4 u6", "M10,12 d4"],
  心: ["M2,4 d14 r16 u14", "M6,4 d10 r8 u10", "M10,0 d14", "M4,4 d12", "M16,4 d12", "M8,6 d6", "M12,6 d6", "M4,0 r2", "M14,0 r2"],
  平: ["M0,2 r20", "M2,10 r16", "M10,2 d18", "M4,4 d4 r2 u4", "M14,4 d4 r2 u4", "M2,12 r6", "M2,14 r6", "M2,16 r6", "M2,18 r6", "M12,12 r6", "M12,14 r6", "M12,16 r6", "M12,18 r6", "M2,12 d6", "M18,12 d6"],
  安: ["M10,0 d2", "M0,2 r20", "M0,2 d4", "M20,2 d4", "M4,4 r12", "M2,8 r16", "M12,8 d12", "M4,10 r12 d2 l12 d2 r12 d2 l12 d2 r12", "M2,20 r16"],
  吃: ["M0,4 r6 d10 l6 u10", "M2,6 r2 d6 l2 u6", "M10,0 r10", "M8,2 d6", "M8,4 r12", "M10,8 r10 d4 l10 d8 r10", "M12,10 r6", "M12,14 r8", "M12,16 r6", "M12,18 r8", "M0,16 r6", "M0,18 r6", "M6,16 d4 l4"],
  饭: ["M2,0 d4 r4", "M0,6 r6", "M2,6 d14", "M4,8 d10 r2", "M8,0 r12", "M8,0 d20", "M10,4 r10", "M10,8 r10 d12 l10", "M12,10 r6 d8 l6 u8", "M14,12 r2 d4 l2 u4"],
  万: ["M0,2 r20", "M6,2 d6 l4 d12", "M6,8 r12 d12 l4", "M8,10 r8 d8 l6", "M10,12 r4 d4 l2", "M2,4 r2", "M10,4 r8", "M10,6 r8", "M4,10 d10", "M4,10 r2 d8"],
  事: ["M10,0 d20 l4", "M0,2 r20", "M2,6 r16 d4 l16 u4", "M4,8 r12", "M0,12 r20", "M2,14 r16 d4 l16", "M4,16 r12", "M6,20 l4"],
  如: ["M8,2 l6 d2 r6 d2 l6 d2 r6 d2 l6 d2 r6 d2 l6 d2 r6 d2 l6", "M4,0 d2", "M10,4 r10 d12 l10 u12", "M12,6 r6 d8 l6 u8", "M14,8 r2 d4 l2 u4", "M20,16 d4 l8", "M10,18 r8"],
  意: ["M10,0 d2", "M2,2 r16", "M4,4 d2", "M16,4 d2", "M0,6 r20", "M2,8 r16 d6 l16 u6", "M4,10 r12", "M4,12 r12", "M2,16 d4 r16 u4", "M10,16 d4", "M6,16 d2", "M14,16 d2"],
};
export const GLYPHS = G;
const glyphs = (text) => Object.fromEntries([...text].map((character) => [character, G[character]]));

export const seals = [
  { id: "best-of-luck", text: { zh: "上上大吉", en: "Best of luck" }, stone: "shoushan-red", glyphs: glyphs("上上大吉") },
  { id: "just-for-fun", text: { zh: "只是好玩", en: "Just for fun" }, stone: "qingtian", glyphs: glyphs("只是好玩") },
  { id: "happy-every-day", text: { zh: "天天开心", en: "Happy every day" }, stone: "chicken-blood", glyphs: glyphs("天天开心") },
  { id: "safe-and-sound", text: { zh: "平平安安", en: "Safe and sound" }, stone: "furong", glyphs: glyphs("平平安安") },
  { id: "eat-well", text: { zh: "好好吃饭", en: "Eat well" }, stone: "tianhuang", glyphs: glyphs("好好吃饭") },
  { id: "all-as-wished", text: { zh: "万事如意", en: "All as you wish" }, stone: "black-jade", glyphs: glyphs("万事如意") },
];

const step = { r: [1, 0], l: [-1, 0], u: [0, -1], d: [0, 1] };

// Parses one glyph's polylines into point lists on the grid.
export function parseGlyph(strokes) {
  return strokes.map((source) => {
    const tokens = source.trim().split(/\s+/);
    const start = /^M(\d+),(\d+)$/.exec(tokens[0]);
    if (!start) throw new Error(`Glyph stroke must start with M: ${source}`);
    let x = Number(start[1]), y = Number(start[2]);
    const points = [[x, y]];
    for (const token of tokens.slice(1)) {
      const move = /^([rlud])(\d+)$/.exec(token);
      if (!move) throw new Error(`Bad glyph move ${token} in ${source}`);
      const [dx, dy] = step[move[1]];
      x += dx * Number(move[2]);
      y += dy * Number(move[2]);
      if (x < 0 || x > GRID || y < 0 || y > GRID) throw new Error(`Glyph leaves its grid: ${source}`);
      points.push([x, y]);
    }
    return points;
  });
}

// The print-side rectangle of each cell, in face coordinates.
function cellBox(column, row) {
  const outer = FACE.border + FACE.frameWidth / 2 + FACE.gap;
  const inner = FACE.frameWidth / 2 + FACE.gap;
  const size = 0.5 - outer - inner;
  return { u: -0.5 + outer + column * (size + 2 * inner), v: -0.5 + outer + row * (size + 2 * inner), size };
}

// Every cut of a seal as straight segments: { stage, a: [u, v], b: [u, v], width, stroke }.
// `stroke` groups the segments of one polyline, so short folds can be cut in one go.
// The shortest side of a stroke (in grid units) the carver outlines with the knife.
const MIN_RUN = 4;

// The grid cells (by integer centre) a glyph's strokes fill.
function filledCells(strokes) {
  const filled = new Set();
  for (const points of parseGlyph(strokes)) {
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1], [x1, y1] = points[i];
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) filled.add(`${x},${y}`);
    }
  }
  return filled;
}

// The outline of a glyph's filled cells, as straight runs on the grid (short sides left out),
// each pushed outward by
// `offset` grid units (and lengthened by it at both ends, so corners close): [[x, y], [x, y]].
function outline(filled, offset) {
  const edges = new Map(); // "h|v,line,side" → sorted positions along the line
  const has = (x, y) => filled.has(`${x},${y}`);
  for (const key of filled) {
    const [x, y] = key.split(",").map(Number);
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      if (has(x + dx, y + dy)) continue;
      // A horizontal edge (dy) at y ± 0.5 spanning x; a vertical one (dx) at x ± 0.5 spanning y.
      const id = dy ? `h,${y + dy / 2},${dy}` : `v,${x + dx / 2},${dx}`;
      if (!edges.has(id)) edges.set(id, []);
      edges.get(id).push(dy ? x : y);
    }
  }
  const runs = [];
  for (const [id, positions] of edges) {
    const [kind, lineText, sideText] = id.split(",");
    const line = Number(lineText) + Number(sideText) * offset;
    positions.sort((p, q) => p - q);
    let start = positions[0];
    for (let i = 1; i <= positions.length; i++) {
      if (i < positions.length && positions[i] === positions[i - 1] + 1) continue;
      const from = start - 0.5 - offset, to = positions[i - 1] + 0.5 + offset;
      // Short sides (a stroke's end, a step in a fold) are left to the clearing, which never
      // touches the stroke; only the long sides are cut with the knife.
      if (positions[i - 1] - start >= MIN_RUN - 1) runs.push(kind === "h" ? [[from, line], [to, line]] : [[line, from], [line, to]]);
      start = positions[i];
    }
  }
  return runs;
}

// What stays of the characters and where the ground is cleared, in face coordinates:
// { keep: [[u0, v0, u1, v1]] (the strokes, as row runs), cells: [[u0, v0, u1, v1]] (the four
// cells' grounds), spines: [{ a, b }] (each straight stroke's centre line, lengthened to its
// outline's ends: the line a two-edged cut follows), twin: the distance from a spine to the
// outline on either side }.
export function layoutRelief(seal) {
  const keep = [], cells = [], spines = [];
  let twin = 0;
  [...seal.text.zh].forEach((character, index) => {
    const [column, row] = CELL_ORDER[index];
    const box = cellBox(column, row);
    const toFace = (x, y) => [-(box.u + x / GRID * box.size), box.v + y / GRID * box.size];
    const rect = (x0, y0, x1, y1) => {
      const [a0, b0] = toFace(x0, y0), [a1, b1] = toFace(x1, y1);
      return [Math.min(a0, a1), Math.min(b0, b1), Math.max(a0, a1), Math.max(b0, b1)];
    };
    cells.push(rect(-0.5, -0.5, GRID + 0.5, GRID + 0.5));
    const reach = 0.5 + FACE.glyphWidth / 2 / (box.size / GRID); // grid units from centre to outline
    twin = reach * box.size / GRID;
    for (const points of parseGlyph(seal.glyphs[character])) {
      for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1], [x1, y1] = points[i];
        const dx = Math.sign(x1 - x0), dy = Math.sign(y1 - y0);
        spines.push({ a: toFace(x0 - dx * reach, y0 - dy * reach), b: toFace(x1 + dx * reach, y1 + dy * reach) });
      }
    }
    const filled = filledCells(seal.glyphs[character]);
    for (let y = 0; y <= GRID; y++) {
      for (let x = 0; x <= GRID; x++) {
        if (!filled.has(`${x},${y}`) || filled.has(`${x - 1},${y}`)) continue;
        let end = x;
        while (filled.has(`${end + 1},${y}`)) end++;
        keep.push(rect(x - 0.5, y - 0.5, end + 0.5, y + 0.5));
      }
    }
  });
  return { keep, cells, spines, twin };
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
  const characters = [...seal.text.zh];
  characters.forEach((character, index) => {
    const [column, row] = CELL_ORDER[index];
    const box = cellBox(column, row);
    // Guides over the ground: each ground cell belongs to the longer of its row and column runs;
    // each straight run of cells sharing a direction is one push of the knife.
    const filled = filledCells(seal.glyphs[character]);
    const ground = (x, y) => x >= 0 && y >= 0 && x <= GRID && y <= GRID && !filled.has(`${x},${y}`);
    const run = (x, y, dx, dy) => { let n = 0; while (ground(x + dx * (n + 1), y + dy * (n + 1))) n++; return n; };
    const across = new Map();
    for (let y = 0; y <= GRID; y++) for (let x = 0; x <= GRID; x++) {
      if (!ground(x, y)) continue;
      const h = run(x, y, 1, 0) + run(x, y, -1, 0), v = run(x, y, 0, 1) + run(x, y, 0, -1);
      across.set(`${x},${y}`, h > v);
    }
    const toFace = (x, y) => [-(box.u + x / GRID * box.size), box.v + y / GRID * box.size];
    const stage = `glyph${index}`;
    for (const horizontal of [true, false]) {
      for (let line = 0; line <= GRID; line++) {
        let start = null;
        for (let k = 0; k <= GRID + 1; k++) {
          const [x, y] = horizontal ? [k, line] : [line, k];
          const on = k <= GRID && across.get(`${x},${y}`) === horizontal;
          if (on && start === null) start = k;
          if (!on && start !== null) {
            const end = k - 1;
            // A lone cell is left to the pushes beside it (and to the finishing of the step).
            if (end === start) { start = null; continue; }
            const a = horizontal ? [start - 0.5, line] : [line, start - 0.5], b = horizontal ? [end + 0.5, line] : [line, end + 0.5];
            add(stage, [toFace(...a), toFace(...b)], FACE.glyphWidth);
            start = null;
          }
        }
      }
    }
  });
  return segments;
}
