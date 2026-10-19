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
import { heightAt, surfaceAt } from "../runtime/kit/terrain.js";
import { sweepPath, resolveProfile } from "../runtime/kit/sweep.js";
import { gridHeightAt, cellAt } from "../runtime/kit/grid.js";

/** The project's terrains in world space, with a cheap digest for staleness. */
export function terrainFields(project) {
  return project.nodes.filter((n) => n.terrain).map((n) => {
    const origin = point(worldMatrix(project, n.id), [0, 0, 0]);
    const t = n.terrain;
    let digest = 0;
    for (let i = 0; i < t.heights.length; i += 7) digest = (digest * 31 + Math.round(t.heights[i] * 1000)) % 1000000007;
    return { node: n.id, origin, cell: t.cell, samples: t.samples, heights: t.heights.map((h) => h + origin[1]), surfaces: t.surfaces ?? null, surfaceTable: t.surfaceTable, digest };
  });
}
/** The project's grids in world space, with a cheap digest for staleness. */
export function gridFields(project) {
  return project.nodes.filter((n) => n.grid).map((n) => {
    const origin = point(worldMatrix(project, n.id), [0, 0, 0]), g = n.grid;
    let digest = 0;
    for (let i = 0; i < g.cells.length; i += 3) digest = (digest * 31 + g.cells[i] * 7 + (g.levels ? g.levels[i] : 0)) % 1000000007;
    return { node: n.id, origin, cell: g.cell, size: g.size, step: g.step, types: g.types, cells: g.cells, levels: g.levels ?? null, digest };
  });
}
const groundQueries = (fields, grids = []) => ({
  height: (x, z) => {
    for (const t of fields) { const h = heightAt(t, x, z); if (h !== null) return h; }
    for (const g of grids) { const h = gridHeightAt(g, x, z); if (h !== null) return h; }
    return null;
  },
  surface: (x, z) => { for (const t of fields) { const s = surfaceAt(t, x, z); if (s) return s.id; } return null; },
  cellType: (x, z) => { for (const g of grids) { const c = cellAt(g, x, z); if (c) return c.type.id; } return null; },
});

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
  if (rule.ground || rule.where) {
    const fields = terrainFields(project), grids = gridFields(project), queries = groundQueries(fields, grids);
    inputs.terrains = fields.map((t) => [t.node, t.digest]);
    if (grids.length) inputs.grids = grids.map((g) => [g.node, g.digest]);
    Object.defineProperties(inputs, { height: { value: queries.height, enumerable: false }, surface: { value: queries.surface, enumerable: false }, cellType: { value: queries.cellType, enumerable: false } });
  }
  if (rule.kind === "sweep") {
    for (const id of sweepPaths(project, rule)) inputs.paths[id] = pathOf(id);
    if (!Object.keys(inputs.paths).length) throw dependency(`no path carries the tag ${rule.on.tag}`, "on.tag");
  } else if (rule.kind === "assemble") {
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

/** The models a rule places: scatter candidates or assembly pieces; a sweep places none. */
export const ruleModels = (rule) => (rule.kind === "sweep" ? [] : (rule.kind === "assemble" ? rule.pieces : rule.candidates).map((c) => c.model));

/** The ids of the paths a sweep rule covers: named, or every path carrying its tag. */
export const sweepPaths = (project, rule) => rule.on.paths ?? project.nodes.filter((n) => n.path && n.tags?.includes(rule.on.tag)).map((n) => n.id);

/** The materials a sweep rule's profile paints with. */
export function sweepMaterials(rule) {
  const p = resolveProfile(rule.profile);
  return [...new Set([...p.strips.map((s) => s.material), ...p.marks.flatMap((m) => m.materials ?? [m.material]), ...(p.below ? [p.below] : [])])];
}

/** Profile summaries for the tile's path table: one per sweep rule, with the paths it covers. */
export function sweepProfiles(project) {
  return (project.rules ?? [])
    .filter((r) => r.kind === "sweep")
    .map((rule) => {
      const p = resolveProfile(rule.profile);
      return { id: rule.id, width: p.width, lanes: p.lanes, kind: p.kind, paths: sweepPaths(project, rule) };
    });
}

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
  if (rule.kind === "sweep") return sweepNodes(project, rule, inputs);
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
 * The mesh parts a sweep derives: a ribbon per path in chunks of `chunk` metres (the tile
 * size by default), each tagged ground, vertices in the parent's space.
 */
function sweepNodes(project, rule, inputs) {
  const hash = ruleHash(rule, inputs);
  const parentWorld = rule.parent ? worldMatrix(project, rule.parent) : identity();
  const toParent = inverse(parentWorld);
  const atOrigin = parentWorld.every((v, i) => Math.abs(v - identity()[i]) < 1e-12);
  const chunk = rule.chunk ?? (project.tile ? Math.min(...project.tile.size) : 200);
  const ids = Object.keys(inputs.paths), nodes = [];
  let index = 0, triangles = 0;
  const tags = [...new Set(["ground", ...(rule.tags ?? [])])];
  for (const id of ids) {
    const { points, closed } = inputs.paths[id];
    const result = sweepPath(points, {
      closed,
      profile: rule.profile,
      step: rule.step,
      height: rule.ground ? inputs.height : null,
      rise: rule.rise,
      bank: rule.bank === null ? { max: 0 } : rule.bank,
      chunk,
    });
    result.chunks.forEach((part, c) => {
      index++;
      triangles += part.faces.length;
      nodes.push({
        id: ids.length === 1 && result.chunks.length === 1 ? rule.target : `${rule.target}_${index}`,
        name: `${rule.target} ${id}${result.chunks.length > 1 ? ` ${c + 1}` : ""}`,
        parent: rule.parent ?? null,
        mesh: {
          vertices: atOrigin ? part.vertices : part.vertices.map((v) => point(toParent, v).map(round)),
          faces: part.faces.map((f, k) => ({ id: `f${k}`, vertices: f.vertices, material: f.material })),
        },
        tags,
        derived: { rule: rule.id, hash },
      });
    });
  }
  nodes.report = { paths: ids.length, chunks: nodes.length, triangles };
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
    if (rule.bake === false) return { id: rule.id, state: "runtime", parts: parts.map((n) => n.id) };
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

/**
 * A runtime rule as a tile carries it (docs/worlds.md §5): the rule with its models pinned
 * and, for assembly, each piece's bounds and socket frames resolved, keep-outs by solids as
 * boxes in tile space. Paths and zones stay references: the tile's tables hold them by id.
 */
export function runtimeRule(project, rule, records, ids = (id) => id) {
  const out = { id: ids(rule.id), kind: rule.kind, seed: rule.seed ?? 1, target: rule.target ?? rule.id, ...(rule.tags ? { tags: rule.tags } : {}) };
  const avoid = { paths: [], polygons: [], boxes: [] };
  let solids = null;
  for (const a of rule.avoid ?? []) {
    if (a.path !== undefined) avoid.paths.push({ path: ids(a.path), width: a.width });
    else if (a.zone !== undefined) avoid.polygons.push(ids(a.zone));
    else {
      solids ??= solidBounds(project);
      const wanted = new Set(a.nodes.flatMap((id) => [...descendants(project, id)]));
      for (const s of solids) if (wanted.has(s.id)) avoid.boxes.push({ min: s.min.map(round), max: s.max.map(round) });
    }
  }
  if (avoid.paths.length || avoid.polygons.length || avoid.boxes.length) out.avoid = avoid;
  if (rule.kind === "assemble") {
    out.pieces = rule.pieces.map((piece, i) => {
      const resolved = assemblyPiece(piece, records[i], i);
      return { model: records[i].model, weight: piece.weight, bounds: resolved.bounds, sockets: resolved.sockets, ...(piece.closer ? { closer: true } : {}), ...(piece.start ? { start: true } : {}) };
    });
    for (const key of ["mates", "start", "at", "yaw", "count", "frontier", "sequence", "close", "tolerance"]) if (rule[key] !== undefined) out[key] = rule[key];
    if (rule.from !== undefined) out.from = rule.from;
    if (rule.bounds) out.bounds = ids(rule.bounds);
  } else {
    out.on = { ...rule.on };
    if (out.on.path !== undefined) out.on.path = ids(out.on.path);
    if (out.on.zone !== undefined) out.on.zone = ids(out.on.zone);
    for (const key of ["y", "yaw", "scale", "ground", "where"]) if (rule[key] !== undefined) out[key] = rule[key];
    out.candidates = rule.candidates.map((c, i) => ({ model: records[i].model, weight: c.weight, ...(c.tints ? { tints: c.tints } : {}), bounds: records[i].bounds }));
  }
  return out;
}
