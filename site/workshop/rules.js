// Scatter rules in the workshop (docs/worlds.md §5): a rule's inputs come from the project
// (paths, zones and solids in world space), the geometry runs in kit/scatter.js (the same code
// a game may run), and the result is parts with copies, each stamped with the rule and a hash
// of what it was derived from, so the audit can tell when a rule has gone stale.
import { worldMatrix, point, inverse, multiply, decompose, matrix, identity } from "./spatial.js";
import { evaluateScatter } from "../runtime/kit/scatter.js";
import { evaluateAssembly, boxSockets } from "../runtime/kit/assemble.js";
import { hashString } from "../runtime/kit/random.js";
import { solidBounds } from "./audit.js";
import { ModelError } from "./mesh.js";

const round = (v) => Math.round(v * 10000) / 10000;

function descendants(project, id) {
  const ids = new Set([id]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of project.nodes)
      if (ids.has(n.parent) && !ids.has(n.id)) {
        ids.add(n.id);
        changed = true;
      }
  }
  return ids;
}

/** The world-space inputs a rule reads: its path or zone, and what it avoids. */
export function ruleInputs(project, rule) {
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const dependency = (message, id) => new ModelError(`Rule ${rule.id}: ${message}`, "dependency", id);
  const pathOf = (id) => {
    const n = byId.get(id);
    if (!n?.path) throw dependency(`${id} is not a path`, id);
    const m = worldMatrix(project, id);
    return { points: n.path.points.map((p) => point(m, p).map(round)), closed: n.path.closed };
  };
  const zoneOf = (id) => {
    const n = byId.get(id);
    if (!n?.zone) throw dependency(`${id} is not a zone`, id);
    const m = worldMatrix(project, id),
      z = n.zone;
    const xz = (p) => [round(p[0]), round(p[2])];
    if (z.kind === "polygon")
      return {
        polygon: z.polygon.map(([x, zz]) => xz(point(m, [x, z.y[0], zz]))),
        y: [point(m, [0, z.y[0], 0])[1], point(m, [0, z.y[1], 0])[1]].sort((a, b) => a - b).map(round),
      };
    if (z.kind === "box") {
      const [hx, hy, hz] = z.size.map((v) => v / 2);
      return {
        polygon: [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([x, zz]) => xz(point(m, [x, -hy, zz]))),
        y: [point(m, [0, -hy, 0])[1], point(m, [0, hy, 0])[1]].sort((a, b) => a - b).map(round),
      };
    }
    const polygon = [];
    for (let i = 0; i < 32; i++) polygon.push(xz(point(m, [z.radius * Math.cos((i / 32) * Math.PI * 2), 0, z.radius * Math.sin((i / 32) * Math.PI * 2)])));
    return { polygon, y: [point(m, [0, -z.radius, 0])[1], point(m, [0, z.radius, 0])[1]].sort((a, b) => a - b).map(round) };
  };
  const inputs = { paths: {}, polygons: {}, zoneY: {}, avoid: { paths: [], polygons: [], boxes: [] } };
  if (rule.kind === "assemble") {
    if (rule.bounds) inputs.polygons[rule.bounds] = zoneOf(rule.bounds).polygon;
  } else {
    if (rule.on.path !== undefined) inputs.paths[rule.on.path] = pathOf(rule.on.path);
    if (rule.on.zone !== undefined) {
      const zone = zoneOf(rule.on.zone);
      inputs.polygons[rule.on.zone] = zone.polygon;
      inputs.zoneY[rule.on.zone] = zone.y;
    }
  }
  let solids = null;
  for (const a of rule.avoid ?? []) {
    if (a.path !== undefined) inputs.avoid.paths.push({ ...pathOf(a.path), width: a.width });
    else if (a.zone !== undefined) inputs.avoid.polygons.push(zoneOf(a.zone).polygon);
    else {
      solids ??= solidBounds(project);
      const wanted = new Set(a.nodes.flatMap((id) => [...descendants(project, id)]));
      for (const s of solids) if (wanted.has(s.id)) inputs.avoid.boxes.push({ min: s.min.map(round), max: s.max.map(round) });
    }
  }
  return inputs;
}

/** The models a rule places: scatter candidates or assembly pieces. */
export const ruleModels = (rule) => (rule.kind === "assemble" ? rule.pieces : rule.candidates).map((c) => c.model);

/** A piece for the assembler: the library's bounds and the socket frames the rule gives it. */
export function assemblyPiece(piece, record, index) {
  let sockets;
  if (piece.sockets === "model") {
    if (!record.sockets || !Object.keys(record.sockets).length)
      throw new ModelError(`Piece ${index} (${piece.model}) has no sockets in the library; give the rule sockets for it`, "dependency", `pieces.${index}.sockets`);
    sockets = record.sockets;
  } else {
    const sides = Object.fromEntries(Object.entries(piece.sockets).filter(([, s]) => s.side).map(([name, s]) => [name, s.tags[0]]));
    sockets = { ...(Object.keys(sides).length ? boxSockets(record.bounds, sides) : {}) };
    for (const [name, s] of Object.entries(piece.sockets)) if (!s.side) sockets[name] = { position: s.position, rotation: s.rotation, tags: s.tags };
  }
  return { bounds: record.bounds, sockets, weight: piece.weight, closer: !!piece.closer, start: !!piece.start };
}

/** What a derivation depends on: the rule and its inputs (models are pinned on the parts). */
export function ruleHash(rule, inputs) {
  const text = JSON.stringify({ rule, inputs });
  return hashString(text).toString(16).padStart(8, "0") + hashString(`${text}#`).toString(16).padStart(8, "0");
}

/**
 * The parts a rule derives: one per candidate that received copies, under the rule's parent,
 * copies in that parent's space (the derived part itself sits at the origin).
 */
export function deriveNodes(project, rule, records, inputs = ruleInputs(project, rule)) {
  let rows, tints, candidates, report = null;
  if (rule.kind === "assemble") {
    const pieces = rule.pieces.map((piece, i) => assemblyPiece(piece, records[i], i));
    const result = evaluateAssembly(
      { ...rule, bounds: rule.bounds ? inputs.polygons[rule.bounds] : undefined, avoid: inputs.avoid },
      pieces,
    );
    rows = result.rows;
    tints = pieces.map(() => null);
    candidates = rule.pieces;
    report = { placed: result.placed, open: result.open.length, stuck: result.stuck };
  } else {
    ({ rows, tints } = evaluateScatter(rule, inputs));
    candidates = rule.candidates;
  }
  const parentWorld = rule.parent ? worldMatrix(project, rule.parent) : identity();
  const parentFrame = decompose(parentWorld);
  if (!parentFrame || Math.abs(parentFrame.scale[0] - parentFrame.scale[1]) > 1e-6 || Math.abs(parentFrame.scale[0] - parentFrame.scale[2]) > 1e-6)
    throw new ModelError(`Rule ${rule.id}: the parent must be uniformly scaled and not sheared`, "dependency", rule.parent);
  const toParent = inverse(parentWorld);
  const atOrigin = parentWorld.every((v, i) => Math.abs(v - identity()[i]) < 1e-12);
  const hash = ruleHash(rule, inputs);
  const nodes = [];
  candidates.forEach((candidate, i) => {
    if (!rows[i].length) return;
    const record = records[i];
    // Rows are world space; under a transformed parent they move into its space.
    const copies = rows[i].map((row) => {
      if (atOrigin) return row.map(round);
      const m = multiply(toParent, matrix({ position: row.slice(0, 3), rotation: row.slice(3, 6), scale: [row[6], row[6], row[6]] }));
      const d = decompose(m);
      return [...d.position.map(round), ...d.rotation.map(round), round(d.scale[0])];
    });
    const { name, type, ...place } = record;
    nodes.push({
      id: candidates.length > 1 ? `${rule.target}_${i + 1}` : rule.target,
      name: `${name} × ${copies.length}`,
      parent: rule.parent ?? null,
      place,
      copies,
      ...(tints[i] ? { tints: tints[i] } : {}),
      ...(rule.tags ? { tags: rule.tags } : {}),
      derived: { rule: rule.id, hash },
    });
  });
  if (report) nodes.report = report;
  return nodes;
}

/**
 * Every rule's state: current (its derived parts carry the hash of today's inputs), stale
 * (inputs or the rule changed) or underived (no parts yet). Records come from the derived
 * parts themselves, so no library call is needed.
 */
export function ruleStatus(project) {
  return (project.rules ?? []).map((rule) => {
    const parts = project.nodes.filter((n) => n.derived?.rule === rule.id);
    if (!parts.length) return { id: rule.id, state: "underived", parts: [] };
    let inputs;
    try {
      inputs = ruleInputs(project, rule);
    } catch {
      return { id: rule.id, state: "stale", parts: parts.map((n) => n.id) };
    }
    const hash = ruleHash(rule, inputs);
    const current = parts.every((n) => n.derived.hash === hash);
    return { id: rule.id, state: current ? "current" : "stale", parts: parts.map((n) => n.id) };
  });
}
