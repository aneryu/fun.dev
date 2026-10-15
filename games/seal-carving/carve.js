// The carving itself. The knife is free: wherever it is pushed into the stone it leaves a
// groove, on the draft or not. Every push is recorded as a stroke (a start point, the axis it
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

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

// A small deterministic hash: the same point of the same stroke always chips the same way.
export function hash(a, b = 0, c = 0) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// widths: groove width for each stroke width code (the blade differs per step).
export function createCarving(segments, widths) {
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
    const [dx, dy] = AXES[stroke.axis];
    return [stroke.u + dx * k * STEP - dy * offset, stroke.v + dy * k * STEP + dx * offset];
  }

  // Marks the draft samples a new groove point runs over. Returns the cuts that changed.
  function cover(stroke, k) {
    const [u, v] = strokePoint(stroke, k);
    const [dx, dy] = AXES[stroke.axis];
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
  function beginStroke(u, v, axis, width, stage = 0) {
    const stroke = { index: strokes.length, u: Math.round(u * POSITION) / POSITION, v: Math.round(v * POSITION) / POSITION, axis, width, stage, offsets: [] };
    strokes.push(stroke);
    return stroke;
  }

  // Grows a stroke to `distance` along its axis, with `offset` sideways at the new points.
  // Returns { points: new point indices, cuts: draft cuts whose coverage changed }.
  function extend(stroke, distance, offset) {
    const target = Math.floor(Math.max(0, distance) / STEP);
    const points = [], changed = new Set();
    const value = clamp(Math.round(offset * OFFSET), -127, 127);
    while (stroke.offsets.length <= target && stroke.offsets.length < 65535) {
      const k = stroke.offsets.length;
      stroke.offsets.push(value);
      points.push(k);
      for (const cut of cover(stroke, k)) changed.add(cut);
    }
    return { points, cuts: [...changed] };
  }

  // Cuts the remaining gaps of a nearly finished draft cut as straight strokes.
  function finish(cut, width) {
    const made = [];
    let k = 0;
    const axis = AXES.findIndex(([dx, dy]) => dx * cut.direction[0] + dy * cut.direction[1] > 0.98);
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

  // The first step that still has unfinished cuts ("dust" once everything is carved).
  function stage() {
    for (const name of STAGES.slice(0, 4)) if (cuts.some((cut) => cut.stage === name && !cut.done)) return name;
    return "dust";
  }

  const progress = () => cuts.reduce((sum, cut) => sum + cut.carved, 0) / total;

  // Keeps only the given strokes (in order) and works out the draft's coverage again: undoing
  // the last strokes, or a whole step.
  function rebuild(kept) {
    const old = kept.map((stroke) => ({ ...stroke, offsets: stroke.offsets.slice() }));
    strokes.length = 0;
    for (const cut of cuts) { cut.covered.fill(0); cut.carved = 0; cut.done = false; }
    const changed = new Set();
    for (const entry of old) {
      const stroke = beginStroke(entry.u, entry.v, entry.axis, entry.width, entry.stage);
      for (let k = 0; k < entry.offsets.length; k++) {
        stroke.offsets.push(entry.offsets[k]);
        for (const cut of cover(stroke, k)) changed.add(cut);
      }
    }
    settle(changed);
  }
  const rewind = (count) => rebuild(strokes.slice(0, Math.max(0, count)));
  const removeStage = (stage) => rebuild(strokes.filter((stroke) => stroke.stage !== STAGES.indexOf(stage)));

  // Saved form: per stroke int16 u, int16 v, uint8 axis + 4 × width + 16 × step, uint16 count, then int8
  // offsets; all strokes concatenated and base64-encoded.
  function serialize() {
    const size = strokes.reduce((sum, stroke) => sum + 7 + stroke.offsets.length, 0);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    let at = 0;
    for (const stroke of strokes) {
      view.setInt16(at, Math.round(stroke.u * POSITION)); view.setInt16(at + 2, Math.round(stroke.v * POSITION));
      view.setUint8(at + 4, stroke.axis + 4 * stroke.width + 16 * stroke.stage); view.setUint16(at + 5, stroke.offsets.length);
      at += 7;
      for (const offset of stroke.offsets) view.setInt8(at++, offset);
    }
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
      if (at + 7 > bytes.length) throw new Error("Truncated carving.");
      const u = view.getInt16(at) / POSITION, v = view.getInt16(at + 2) / POSITION;
      const code = view.getUint8(at + 4), count = view.getUint16(at + 5);
      at += 7;
      const width = Math.floor(code / 4) % 4, stage = Math.floor(code / 16);
      if (width >= widths.length || stage > 3 || at + count > bytes.length) throw new Error("Malformed carving.");
      const stroke = beginStroke(u, v, code % 4, width, stage);
      for (let k = 0; k < count; k++) {
        stroke.offsets.push(view.getInt8(at++));
        for (const cut of cover(stroke, k)) changed.add(cut);
      }
    }
    settle(changed);
  }

  return { cuts, strokes, total, widths, point, project, coverage, strokePoint, beginStroke, extend, finish, settle, stage, progress, serialize, restore, rewind, removeStage };
}

// Paints strokes into a 2D canvas context whose square of `size` pixels is the face. The
// mask is white where stone was cut away: grooves with chipped edges, and the chamfer.
export function createMaskPainter(carving, context2d, size) {
  const px = (value) => (value + 0.5) * size;

  // One point's piece of groove, from halfway to the previous point to halfway to the next,
  // so pieces join without gaps; the stroke's first and last points get square caps.
  function paintPoint(stroke, k) {
    const [dx, dy] = AXES[stroke.axis];
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
    for (const k of points) {
      // The previous point's piece is redrawn so the join follows the new point's wobble.
      if (k > 0 && !points.includes(k - 1)) paintPoint(stroke, k - 1);
      paintPoint(stroke, k);
    }
  }

  function clear() {
    context2d.fillStyle = "#000";
    context2d.fillRect(0, 0, size, size);
  }

  function paintAll() {
    clear();
    for (const stroke of carving.strokes) paint(stroke, stroke.offsets.map((_, k) => k));
  }

  return { paint, paintAll, clear };
}
