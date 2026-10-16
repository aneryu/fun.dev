// The carving itself. The knife is free: wherever it is pushed into the stone it leaves a
// groove, on the draft or not. Every push is recorded as a stroke (a start point, the angle it
// ran along and the hand's sideways wobble every STEP), so a seal looks the same every time
// it is opened. The draft's cuts count as carved where a groove runs along them.
import { STAGES } from "./seals.js";

export const STEP = 0.006; // face units between recorded knife points
const POSITION = 8192; // stroke starts are stored in 1/POSITION face units (int16)
const OFFSET = 16384; // sideways wobble in 1/OFFSET face units (int8: up to ±0.0078)
// A draft cut counts as finished at this coverage; the last gaps are cut automatically.
export const FINISH = 0.9;
// Unit directions of the four axes a stroke can run along, in face coordinates (u, v).
export const AXES = [[1, 0], [0, 1], [-1, 0], [0, -1]];
// A stroke runs at any of ANGLES directions around the face (the stone turns freely under the
// knife); its angle is stored as an index.
export const ANGLES = 256;
export const angleIndex = (dx, dy) => ((Math.round(Math.atan2(dy, dx) / (Math.PI * 2) * ANGLES) % ANGLES) + ANGLES) % ANGLES;
const directionOf = (stroke) => { const a = stroke.angle / ANGLES * Math.PI * 2; return [Math.cos(a), Math.sin(a)]; };

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

// A small deterministic hash: the same point of the same stroke always chips the same way.
export function hash(a, b = 0, c = 0) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// The ground cleared around the raised characters is tracked on a CLEAR × CLEAR grid over the
// face; it counts as cleared at CLEAR_FINISH, and the last of it is cleared for the carver.
export const CLEAR = 128;
export const CLEAR_FINISH = 0.85;

const inside = (rects, u, v, margin = 0) => rects.some(([u0, v0, u1, v1]) => u >= u0 - margin && u <= u1 + margin && v >= v0 - margin && v <= v1 + margin);

// widths: groove width for each stroke width code (the blade differs per step).
// relief: { keep, cells, isStroke } from layoutRelief: the raised strokes and the grounds around them.
export function createCarving(segments, widths, relief = { keep: [], cells: [] }) {
  const isStroke = relief.isStroke ?? ((u, v) => inside(relief.keep, u, v, 0.5 / CLEAR));
  const cuts = segments.map((segment, index) => {
    const dx = segment.b[0] - segment.a[0], dy = segment.b[1] - segment.a[1];
    const length = Math.hypot(dx, dy);
    const count = Math.max(2, Math.ceil(length / STEP) + 1);
    return {
      ...segment, index, length, count,
      direction: [dx / length, dy / length],
      normal: [-dy / length, dx / length],
      covered: new Uint8Array(count),
      carved: 0,
      done: false,
    };
  });
  const total = cuts.reduce((sum, cut) => sum + cut.count, 0);
  const strokes = [];
  // The ground: grid cells inside a character's cell and clear of its strokes, each belonging
  // to its character (0..3). Character grooves clear it as they pass; once a character's
  // ground is CLEAR_FINISH cleared, the rest is cleared for the carver and its step is done.
  const NONE = 255;
  const clearable = new Uint8Array(CLEAR * CLEAR), cleared = new Uint8Array(CLEAR * CLEAR), charOf = new Uint8Array(CLEAR * CLEAR).fill(NONE);
  const characters = relief.cells.length;
  const clearTotal = new Array(characters).fill(0), clearCount = new Array(characters).fill(0), groundDone = new Array(characters).fill(false);
  const gridCentre = (i) => (i + 0.5) / CLEAR - 0.5;
  for (let j = 0; j < CLEAR; j++) for (let i = 0; i < CLEAR; i++) {
    const u = gridCentre(i), v = gridCentre(j);
    const char = relief.cells.findIndex(([u0, v0, u1, v1]) => u >= u0 && u <= u1 && v >= v0 && v <= v1);
    if (char >= 0 && !isStroke(u, v)) { const index = j * CLEAR + i; clearable[index] = 1; charOf[index] = char; clearTotal[char]++; }
  }
  const glyphStage = (stage) => (STAGES[stage] ?? "").startsWith("glyph");

  // The point at parameter t (0..1) along a cut, offset sideways by `offset` face units.
  function point(cut, t, offset = 0) {
    return [cut.a[0] + cut.direction[0] * cut.length * t + cut.normal[0] * offset, cut.a[1] + cut.direction[1] * cut.length * t + cut.normal[1] * offset];
  }

  // Projects a face point onto a cut: { t (unclamped), distance (signed, sideways) }.
  function project(cut, u, v) {
    const px = u - cut.a[0], py = v - cut.a[1];
    return { t: (px * cut.direction[0] + py * cut.direction[1]) / cut.length, distance: px * cut.normal[0] + py * cut.normal[1] };
  }

  const coverage = (cut) => cut.carved / cut.count;

  // Point k of a stroke, in face units.
  function strokePoint(stroke, k, offset = stroke.offsets[k] / OFFSET) {
    const [dx, dy] = directionOf(stroke);
    return [stroke.u + dx * k * STEP - dy * offset, stroke.v + dy * k * STEP + dx * offset];
  }

  // Marks the draft samples a new groove point runs over. Returns the cuts that changed.
  function cover(stroke, k) {
    const [u, v] = strokePoint(stroke, k);
    const [dx, dy] = directionOf(stroke);
    const width = widths[stroke.width];
    const changed = [];
    for (const cut of cuts) {
      if (cut.done || Math.abs(cut.direction[0] * dx + cut.direction[1] * dy) < 0.98) continue;
      const { t, distance } = project(cut, u, v);
      // The groove must run over the line: within most of a groove width of its centre.
      if (Math.abs(distance) > Math.max(width, cut.width) * 0.7) continue;
      const reach = (STEP * 0.75 + width * 0.25) / cut.length;
      const k0 = Math.max(0, Math.ceil((t - reach) * (cut.count - 1))), k1 = Math.min(cut.count - 1, Math.floor((t + reach) * (cut.count - 1)));
      let any = false;
      for (let i = k0; i <= k1; i++) if (!cut.covered[i]) { cut.covered[i] = 1; cut.carved++; any = true; }
      if (any) changed.push(cut);
    }
    return changed;
  }

  // `stage` is the index in STAGES of the step the stroke was cut in, for redoing a step.
  // `angle` is an index of ANGLES (see angleIndex).
  function beginStroke(u, v, angle, width, stage = 0) {
    const stroke = { index: strokes.length, u: Math.round(u * POSITION) / POSITION, v: Math.round(v * POSITION) / POSITION, angle, width, stage, offsets: [] };
    strokes.push(stroke);
    return stroke;
  }

  // Grows a stroke to `distance` along its axis, with `offset` sideways at the new points.
  // Returns { points: new point indices, cuts: draft cuts whose coverage changed }.
  function extend(stroke, distance, offset) {
    const target = Math.floor(Math.max(0, distance) / STEP);
    const points = [], changed = new Set();
    const value = clamp(Math.round(offset * OFFSET), -127, 127);
    const fresh = [];
    while (stroke.offsets.length <= target && stroke.offsets.length < 65535) {
      const k = stroke.offsets.length;
      stroke.offsets.push(value);
      points.push(k);
      for (const cut of cover(stroke, k)) changed.add(cut);
      if (glyphStage(stroke.stage)) fresh.push(...clearAt(stroke, k));
    }
    return { points, cuts: [...changed], cleared: fresh };
  }

  // Cuts the remaining gaps of a nearly finished draft cut as straight strokes.
  function finish(cut, width) {
    const made = [];
    let k = 0;
    const axis = angleIndex(cut.direction[0], cut.direction[1]);
    while (k < cut.count) {
      if (cut.covered[k]) { k++; continue; }
      let end = k;
      while (end + 1 < cut.count && !cut.covered[end + 1]) end++;
      const start = point(cut, Math.max(0, (k - 1) / (cut.count - 1)));
      const stroke = beginStroke(start[0], start[1], axis, width, STAGES.indexOf(cut.stage));
      const { points } = extend(stroke, (end - k + 2) / (cut.count - 1) * cut.length, 0);
      made.push({ stroke, points });
      k = end + 1;
    }
    for (let i = 0; i < cut.count; i++) if (!cut.covered[i]) { cut.covered[i] = 1; cut.carved++; }
    cut.done = true;
    return made;
  }

  // Marks cuts finished once fully covered. Returns those that just finished.
  function settle(changed) {
    const finished = [];
    for (const cut of changed) if (!cut.done && cut.carved === cut.count) { cut.done = true; finished.push(cut); }
    return finished;
  }

  // The first step still open: the line steps by their cuts, each character by its ground.
  function stage() {
    for (const name of STAGES.slice(0, 3)) if (cuts.some((cut) => cut.stage === name && !cut.done)) return name;
    for (let char = 0; char < characters; char++) if (!groundDone[char] && clearTotal[char]) return `glyph${char}`;
    return "dust";
  }

  // A character groove clears the ground under point k: a disc as wide as the groove.
  function clearAt(stroke, k) {
    const [u, v] = strokePoint(stroke, k);
    const radius = widths[stroke.width] / 2;
    const fresh = [];
    const i0 = Math.max(0, Math.floor((u - radius + 0.5) * CLEAR)), i1 = Math.min(CLEAR - 1, Math.floor((u + radius + 0.5) * CLEAR));
    const j0 = Math.max(0, Math.floor((v - radius + 0.5) * CLEAR)), j1 = Math.min(CLEAR - 1, Math.floor((v + radius + 0.5) * CLEAR));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const index = j * CLEAR + i;
      if (!clearable[index] || cleared[index] || Math.abs(gridCentre(i) - u) > radius || Math.abs(gridCentre(j) - v) > radius) continue;
      cleared[index] = 1; clearCount[charOf[index]]++; fresh.push(index);
    }
    return fresh;
  }
  const clearCoverage = (char) => clearTotal[char] ? clearCount[char] / clearTotal[char] : 1;
  // Finishes any character whose ground is nearly cleared, or whose guides are all cut: clears
  // the rest and closes its guides. Returns { cleared: indices, characters: those just finished }.
  const guidesCut = (char) => {
    const own = cuts.filter((cut) => cut.stage === `glyph${char}`);
    return own.length > 0 && own.every((cut) => cut.done);
  };
  function settleGround() {
    const fresh = [], finished = [];
    for (let char = 0; char < characters; char++) {
      if (groundDone[char] || (clearCoverage(char) < CLEAR_FINISH && !guidesCut(char))) continue;
      for (let index = 0; index < cleared.length; index++) if (charOf[index] === char && !cleared[index]) { cleared[index] = 1; clearCount[char]++; fresh.push(index); }
      groundDone[char] = true;
      finished.push(char);
      for (const cut of cuts) if (cut.stage === `glyph${char}` && !cut.done) { cut.covered.fill(1); cut.carved = cut.count; cut.done = true; }
    }
    return { cleared: fresh, characters: finished };
  }
  // Finishes one character outright (the cheat): clears its ground and closes its guides.
  function finishCharacter(char) {
    clearCount[char] = Math.max(clearCount[char], Math.ceil(clearTotal[char] * CLEAR_FINISH));
    return settleGround();
  }
  function resetGround() { cleared.fill(0); clearCount.fill(0); groundDone.fill(false); }
  const clearCell = (index) => [gridCentre(index % CLEAR), gridCentre(Math.floor(index / CLEAR))];

  const progress = () => (cuts.reduce((sum, cut) => sum + cut.carved, 0) + clearCount.reduce((sum, n) => sum + n, 0)) / (total + clearTotal.reduce((sum, n) => sum + n, 0));

  // Keeps only the given strokes (in order) and works out the draft's coverage again: undoing
  // the last strokes, or a whole step.
  function rebuild(kept) {
    const old = kept.map((stroke) => ({ ...stroke, offsets: stroke.offsets.slice() }));
    strokes.length = 0;
    for (const cut of cuts) { cut.covered.fill(0); cut.carved = 0; cut.done = false; }
    resetGround();
    const changed = new Set();
    for (const entry of old) {
      const stroke = beginStroke(entry.u, entry.v, entry.angle, entry.width, entry.stage);
      for (let k = 0; k < entry.offsets.length; k++) {
        stroke.offsets.push(entry.offsets[k]);
        for (const cut of cover(stroke, k)) changed.add(cut);
        if (glyphStage(stroke.stage)) clearAt(stroke, k);
      }
    }
    settle(changed);
    settleGround();
  }
  const rewind = (count) => rebuild(strokes.slice(0, Math.max(0, count)));
  const removeStage = (stage) => rebuild(strokes.filter((stroke) => stroke.stage !== STAGES.indexOf(stage)));

  // Saved form: per stroke int16 u, int16 v, uint8 angle, uint8 width + 4 × step, uint16 count,
  // then the int8 offsets as runs (value, length 1..255): the hand's wobble changes slowly.
  // All strokes concatenated and base64-encoded.
  function runs(offsets) {
    const list = [];
    for (const value of offsets) {
      const last = list.at(-1);
      if (last && last[0] === value && last[1] < 255) last[1]++; else list.push([value, 1]);
    }
    return list;
  }
  function serialize() {
    const encoded = strokes.map((stroke) => runs(stroke.offsets));
    const size = strokes.reduce((sum, stroke, i) => sum + 8 + encoded[i].length * 2, 0);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    let at = 0;
    strokes.forEach((stroke, i) => {
      view.setInt16(at, Math.round(stroke.u * POSITION)); view.setInt16(at + 2, Math.round(stroke.v * POSITION));
      view.setUint8(at + 4, stroke.angle); view.setUint8(at + 5, stroke.width + 4 * stroke.stage); view.setUint16(at + 6, stroke.offsets.length);
      at += 8;
      for (const [value, length] of encoded[i]) { view.setInt8(at++, value); view.setUint8(at++, length); }
    });
    let binary = "";
    for (let i = 0; i < bytes.length; i += 4096) binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
    return btoa(binary);
  }

  // Replays saved strokes; throws on malformed data.
  function restore(encoded) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    let at = 0;
    const changed = new Set();
    while (at < bytes.length) {
      if (at + 8 > bytes.length) throw new Error("Truncated carving.");
      const u = view.getInt16(at) / POSITION, v = view.getInt16(at + 2) / POSITION;
      const angle = view.getUint8(at + 4), code = view.getUint8(at + 5), count = view.getUint16(at + 6);
      at += 8;
      const width = code % 4, stage = Math.floor(code / 4);
      if (width >= widths.length || stage >= STAGES.length) throw new Error("Malformed carving.");
      const stroke = beginStroke(u, v, angle, width, stage);
      while (stroke.offsets.length < count) {
        if (at + 2 > bytes.length) throw new Error("Truncated carving.");
        const value = view.getInt8(at++), length = view.getUint8(at++);
        if (!length || stroke.offsets.length + length > count) throw new Error("Malformed carving.");
        for (let n = 0; n < length; n++) {
          const k = stroke.offsets.length;
          stroke.offsets.push(value);
          for (const cut of cover(stroke, k)) changed.add(cut);
          if (glyphStage(stroke.stage)) clearAt(stroke, k);
        }
      }
    }
    settle(changed);
    settleGround();
  }

  return { cuts, strokes, total, widths, point, project, coverage, strokePoint, beginStroke, extend, finish, settle, stage, progress, serialize, restore, rewind, removeStage,
    relief, clearable, cleared, charOf, clearCoverage, settleGround, finishCharacter, clearCell };
}

// Paints strokes into a 2D canvas context whose square of `size` pixels is the face. The
// mask is white where stone was cut away: grooves with chipped edges, and the chamfer.
export function createMaskPainter(carving, context2d, size) {
  const px = (value) => (value + 0.5) * size;
  // The raised strokes stand however the knife strays: after grooves or clearing are painted,
  // the strokes are painted back as uncut stone. (A clip path would do the same, but a canvas
  // once clipped this way uploads to the GPU very slowly ever after.)
  // Snapped to whole pixels, so neighbouring rows leave no seams.
  const keep = carving.relief.keep.map(([u0, v0, u1, v1]) => {
    const x = Math.round(px(u0)), y = Math.round(px(v0));
    return [x, y, Math.max(1, Math.round(px(u1)) - x), Math.max(1, Math.round(px(v1)) - y)];
  });
  const protect = (draw) => {
    draw();
    if (!keep.length) return;
    const fill = context2d.fillStyle;
    context2d.fillStyle = "#000";
    for (const rect of keep) context2d.fillRect(...rect);
    context2d.fillStyle = fill;
  };

  // One point's piece of groove, from halfway to the previous point to halfway to the next,
  // so pieces join without gaps; the stroke's first and last points get square caps.
  function paintPoint(stroke, k) {
    const [dx, dy] = directionOf(stroke);
    const nx = -dy, ny = dx;
    const width = carving.widths[stroke.width], w = width / 2;
    const last = stroke.offsets.length - 1;
    const offset = stroke.offsets[k] / OFFSET;
    const before = k > 0 ? stroke.offsets[k - 1] / OFFSET : offset;
    const after = k < last ? stroke.offsets[k + 1] / OFFSET : offset;
    const from = k === 0 ? -w : -STEP / 2, to = k === last ? w : STEP / 2;
    const center = carving.strokePoint(stroke, k, 0);
    const a = [center[0] + dx * from + nx * (offset + before) / 2, center[1] + dy * from + ny * (offset + before) / 2];
    const b = [center[0] + dx * to + nx * (offset + after) / 2, center[1] + dy * to + ny * (offset + after) / 2];
    const g = context2d;
    g.beginPath();
    g.moveTo(px(a[0] + nx * w), px(a[1] + ny * w));
    g.lineTo(px(b[0] + nx * w), px(b[1] + ny * w));
    g.lineTo(px(b[0] - nx * w), px(b[1] - ny * w));
    g.lineTo(px(a[0] - nx * w), px(a[1] - ny * w));
    g.closePath();
    g.fill();
    // Character grooves leave a fine tool mark down their middle, so a patch cleared with
    // several pushes reads as hatched, scraped stone, as in the video.
    if (stroke.width === 2) {
      const m = w * 0.16;
      g.fillStyle = "#c8c8c8";
      g.beginPath();
      g.moveTo(px(a[0] + nx * m), px(a[1] + ny * m));
      g.lineTo(px(b[0] + nx * m), px(b[1] + ny * m));
      g.lineTo(px(b[0] - nx * m), px(b[1] - ny * m));
      g.lineTo(px(a[0] - nx * m), px(a[1] - ny * m));
      g.closePath();
      g.fill();
      g.fillStyle = "#fff";
    }
    // 刀味: the stone flakes off along the groove's lips, more where the hand wobbled. The
    // chamfer (the widest blade) is cut flat and stays clean.
    if (stroke.width === 0) return;
    const wobble = Math.min(1, Math.abs(offset - before) / (width * 0.2) + Math.abs(offset) / (width * 0.5));
    for (const side of [-1, 1]) {
      if (hash(stroke.index, k, side) > 0.18 + 0.5 * wobble) continue;
      const along = (hash(stroke.index, k, side + 7) - 0.5) * STEP;
      const depth = width * (0.12 + 0.35 * hash(stroke.index, k, side + 11) * (0.5 + wobble));
      const span = width * (0.35 + 0.6 * hash(stroke.index, k, side + 13));
      const lip = [center[0] + dx * along + nx * (offset + side * w), center[1] + dy * along + ny * (offset + side * w)];
      const skew = (hash(stroke.index, k, side + 17) - 0.5) * span;
      g.beginPath();
      g.moveTo(px(lip[0] - dx * span / 2), px(lip[1] - dy * span / 2));
      g.lineTo(px(lip[0] + nx * side * depth + dx * skew), px(lip[1] + ny * side * depth + dy * skew));
      g.lineTo(px(lip[0] + dx * span / 2), px(lip[1] + dy * span / 2));
      g.closePath();
      g.fill();
    }
  }

  function paint(stroke, points) {
    context2d.fillStyle = "#fff";
    const draw = () => {
      for (const k of points) {
        // The previous point's piece is redrawn so the join follows the new point's wobble.
        if (k > 0 && !points.includes(k - 1)) paintPoint(stroke, k - 1);
        paintPoint(stroke, k);
      }
    };
    // Character outlines never cut into the strokes they surround.
    if ((STAGES[stroke.stage] ?? "").startsWith("glyph")) protect(draw); else draw();
  }

  // Cleared ground: each grid cell a little larger than itself, unevenly, so the floor reads
  // as scraped stone rather than squares.
  function paintClear(indices) {
    const cell = size / CLEAR;
    context2d.fillStyle = "#fff";
    protect(() => {
      for (const index of indices) {
        const [u, v] = carving.clearCell(index);
        const grow = cell * (0.7 + 0.5 * hash(index, 3));
        context2d.fillRect(px(u) - cell / 2 - grow / 2, px(v) - cell / 2 - grow / 2, cell + grow, cell + grow);
      }
    });
  }

  function clear() {
    context2d.fillStyle = "#000";
    context2d.fillRect(0, 0, size, size);
  }

  function paintAll() {
    clear();
    for (const stroke of carving.strokes) paint(stroke, stroke.offsets.map((_, k) => k));
    const done = [];
    for (let index = 0; index < carving.cleared.length; index++) if (carving.cleared[index]) done.push(index);
    if (done.length) paintClear(done);
  }

  return { paint, paintClear, paintAll, clear };
}
