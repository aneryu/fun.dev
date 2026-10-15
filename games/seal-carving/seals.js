// The seals, their four-character inscriptions and the layout of every cut on the face.
//
// Glyphs are drawn in the style of 九叠篆: straight horizontal and vertical strokes, folded
// to fill the cell evenly. Each glyph sits on a 20 × 20 grid (y down) and is written as
// polylines: "M x,y" starts one, then r/l/u/d n moves right/left/up/down by n units.
// Glyphs are authored as they print; the face is carved mirrored, as a real seal is.

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
export const STAGES = ["bevel", "border", "cross", "glyphs", "dust", "done"];

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
  大: ["M2,7 r16", "M10,1 d7", "M10,8 l4 d4 l4 d6", "M10,8 r4 d4 r4 d6"],
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
    for (const points of parseGlyph(seal.glyphs[character])) {
      // Print side to face: the face is the mirror image, so u flips.
      add("glyphs", points.map(([x, y]) => [-(box.u + x / GRID * box.size), box.v + y / GRID * box.size]), FACE.glyphWidth);
    }
  });
  return segments;
}
