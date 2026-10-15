// The seals, their four-character inscriptions and the layout of every cut on the face.
//
// Glyphs are drawn in the style of 九叠篆: straight horizontal and vertical strokes, folded
// to fill the cell evenly. Each glyph sits on a 20 × 20 grid (y down) and is written as
// polylines: "M x,y" starts one, then r/l/u/d n moves right/left/up/down by n units.
// Glyphs are authored as they print; the face is carved mirrored, as a real seal is.
//
// The characters are 朱文, raised: each stroke is one grid unit wide and stays; the carver cuts
// its outline (just outside it, so the stroke keeps its width) and then clears the ground
// around it. The border and the cross are cut as grooves.

export const GRID = 20;

// Face coordinates: u right, v toward the viewer, the face spanning -0.5..0.5 on both.
export const FACE = {
  bevel: 0.022, // width of the chamfer cut along each edge
  border: 0.062, // inset of the border groove's centreline
  frameWidth: 0.017, // border and cross grooves
  glyphWidth: 0.0125, // character grooves
  gap: 0.016, // clear stone between the frame grooves and a cell's grid
};

// Reading order of a four-character seal: right column top then bottom, then left column.
const CELL_ORDER = [[1, 0], [1, 1], [0, 0], [0, 1]];

// Stages, in carving order. Each one's cuts must be finished before the next one's show.
export const STAGES = ["bevel", "border", "cross", "glyphs", "clear", "dust", "done"];

// Shared glyphs: 天, 大, 平, 好 and others appear twice in a seal, drawn alike (as carvers do,
// though a master varies them a little).
const G = {
  // The first seal's characters: a few straight cuts each, hardly folded, to learn on.
  上: ["M10,2 d16", "M10,9 r6", "M2,18 r16"],
  吉: ["M2,4 r16", "M10,1 d7", "M5,8 r10", "M4,11 r12 d7 l12 u7"],
  只: ["M1,1 r18 d8 l18 u8", "M5,3 r10 d4 l10 u2", "M9,9 d2 l8 d2 r6 d2 l6 d2 r6 d2", "M11,9 d2 r8 d2 l6 d2 r6 d2 l6 d2"],
  是: ["M1,1 r18 d6 l18 u6", "M1,4 r18", "M1,9 r18", "M9,9 d8", "M11,11 r8 d2 l6 d2 r6", "M7,11 l6 d4 r4", "M1,15 d4 r18"],
  好: ["M1,1 r7 d5 l5 d4 r5 d9", "M1,9 r8", "M1,13 d6 r4", "M11,1 r8 d4 l4 d14 l4 u2", "M11,3 r6", "M11,9 r8"],
  玩: ["M1,1 r6 d2 l4", "M1,9 r6", "M1,17 r6 d2", "M4,5 d12", "M10,1 r9", "M9,4 r10", "M12,4 d6 l3 d9", "M16,4 d13 r3 u4", "M14,7 d6 l3"],
  天: ["M3,1 r14", "M1,5 r18", "M10,5 d4", "M10,9 l9 d3 r6 d3 l6 d4", "M10,9 r9 d3 l6 d3 r6 d4"],
  开: ["M1,3 r18", "M1,9 r18", "M6,3 d9 l5 d7", "M14,3 d16", "M14,14 r5", "M9,13 d6"],
  心: ["M2,4 d13 r16 u13", "M5,4 d10 r10 u10", "M10,1 d14", "M2,4 r1", "M18,4 l1", "M7,1 r6"],
  大: ["M2,6 r16", "M10,1 d8", "M10,9 l3 d4 l4 d5", "M10,9 r3 d4 r4 d5"],
  平: ["M1,1 r18", "M1,10 r18", "M10,1 d18", "M3,4 d4 r4", "M17,4 d4 l4", "M3,13 r5 d6", "M17,13 l5 d6"],
  安: ["M10,1 d2", "M1,6 u3 r18 d3", "M2,8 r16", "M12,8 d5 l9 d6", "M7,13 d6", "M2,16 r16"],
  吃: ["M1,4 r6 d8 l6 u8", "M10,1 r9", "M9,5 r10", "M11,9 r8 d4 l8 d6 r9"],
  饭: ["M5,1 l4 d4 r6", "M3,7 r4 d12", "M9,1 r10", "M10,1 d18", "M10,6 r9 d4 l6 d6 r6 d3", "M13,13 l3"],
  万: ["M1,2 r18", "M7,2 d6 l6 d11", "M7,8 r12 d11 l4 u3", "M12,11 d5"],
  事: ["M10,1 d18 l3", "M1,3 r18", "M4,6 r12 d3 l12 u3", "M2,12 r16", "M4,15 r12 u5"],
  如: ["M5,1 d6 l4 d4 r8 d8", "M1,7 r9", "M1,15 r4", "M12,6 r7 d10 l7 u10", "M14,9 r3 d4 l3"],
  意: ["M10,1 d2", "M3,3 r14", "M1,6 r18", "M4,8 r12 d5 l12 u5", "M4,10 r12", "M2,15 d4 r16 u4", "M10,15 d4"],
};
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
    cells.push(rect(0, 0, GRID, GRID));
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
    // The outline of the raised strokes, cut just outside them: half a groove out.
    const offset = FACE.glyphWidth / 2 / (box.size / GRID);
    for (const points of outline(filledCells(seal.glyphs[character]), offset)) {
      // Print side to face: the face is the mirror image, so u flips.
      add("glyphs", points.map(([x, y]) => [-(box.u + x / GRID * box.size), box.v + y / GRID * box.size]), FACE.glyphWidth);
    }
  });
  return segments;
}
