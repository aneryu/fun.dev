// The scene audit (docs/worlds.md §9): what an agent cannot see in a picture. Findings are
// structured and come with a suggestion; none of them blocks an export, a game may want
// what the audit flags (a lamp standing in a planter overlaps it).
import { worldMatrix, point, nodePoints } from "./spatial.js";
import { statistics } from "./document.js";
import { ruleStatus, terrainFields, gridFields } from "./rules.js";
import { auditTiles, tileGrid } from "./tiles.js";
import { heightAt } from "../runtime/kit/terrain.js";
import { gridHeightAt } from "../runtime/kit/grid.js";
import { buildNavgrid } from "./nav.js";
import { navCellAt, reachable } from "../runtime/kit/nav.js";
import { sceneBounds } from "./tile.js";

const EPS = 0.02; // 2 cm: resting on something, or on the ground
const round = (v) => Math.round(v * 1000) / 1000;

/** World bounds of every solid part: meshes and placed models. */
export function solidBounds(project) {
  const solids = [];
  for (const node of project.nodes) {
    if (!(node.mesh || node.place || node.terrain || node.grid)) continue;
    const m = worldMatrix(project, node.id);
    const points = (node.mesh?.vertices ?? nodePoints(node)).map((v) => point(m, v));
    const min = [0, 1, 2].map((i) => Math.min(...points.map((p) => p[i]))),
      max = [0, 1, 2].map((i) => Math.max(...points.map((p) => p[i])));
    solids.push({ id: node.id, min, max, kind: node.place ? "place" : node.terrain ? "terrain" : node.grid ? "grid" : "mesh", copies: node.copies?.length ?? 0 });
  }
  return solids;
}

/**
 * Audits a project: overlapping solids, floating or buried parts, parts outside the tile,
 * placed models without a runtime file, and the triangle budget. `ground` is the floor's
 * height (0: the library convention); `budget.triangles` defaults to a phone's.
 */
export function auditProject(project, { ground: plane = 0, budget = {} } = {}) {
  if (!Number.isFinite(plane)) throw new TypeError("ground must be a number");
  const ground = plane;
  const findings = [];
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const ancestors = (id) => {
    const set = new Set();
    for (let n = byId.get(id); n?.parent; n = byId.get(n.parent)) set.add(n.parent);
    return set;
  };
  const related = (a, b) => ancestors(a).has(b) || ancestors(b).has(a);
  const solids = solidBounds(project);
  // Parts tagged `ground` are the floor itself: never buried or floating, a support for the rest.
  const grounds = new Set(project.nodes.filter((n) => n.tags?.includes("ground")).map((n) => n.id));
  const footprintsTouch = (a, b) =>
    a.min[0] < b.max[0] + EPS && a.max[0] > b.min[0] - EPS && a.min[2] < b.max[2] + EPS && a.max[2] > b.min[2] - EPS;

  // Overlaps: bounds that interpenetrate by more than 5 cm on every axis. Parts with many
  // copies are one wide box and stay out of this (their rules keep them off paths and solids).
  const singles = solids.filter((s) => !s.copies && s.kind !== "terrain" && s.kind !== "grid");
  for (let i = 0; i < singles.length; i++)
    for (let j = i + 1; j < singles.length; j++) {
      const a = singles[i],
        b = singles[j];
      if (related(a.id, b.id)) continue;
      // Chunks of one sweep share their seams by design.
      const ra = byId.get(a.id)?.derived?.rule, rb = byId.get(b.id)?.derived?.rule;
      if (ra && ra === rb) continue;
      const depth = [0, 1, 2].map((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]));
      if (depth.every((d) => d > 0.05))
        findings.push({
          code: "overlap",
          severity: "warning",
          nodes: [a.id, b.id],
          depth: depth.map(round),
          message: `${a.id} and ${b.id} overlap by ${depth.map((d) => round(d)).join(" × ")} m`,
          suggestion: "Move one apart, or keep it when they are meant to meet (a lamp standing in a planter).",
        });
    }

  // Floating and buried: a solid stands on the ground (a terrain's height under it, else the
  // ground plane), rests on another solid under its footprint, or touches one on a side (a
  // clock on a wall, a shelf against it).
  const touch = (a, b) => [0, 1, 2].every((k) => Math.max(a.min[k], b.min[k]) - Math.min(a.max[k], b.max[k]) <= EPS);
  const fields = terrainFields(project), grids = gridFields(project);
  const groundAt = (x, z) => {
    for (const t of fields) { const h = heightAt(t, x, z); if (h !== null) return h; }
    for (const g of grids) { const h = gridHeightAt(g, x, z); if (h !== null) return h; }
    return ground;
  };
  const terrainIds = new Set([...fields.map((t) => t.node), ...grids.map((g) => g.node)]);
  for (const s of singles) {
    if (grounds.has(s.id) || terrainIds.has(s.id)) continue;
    const bottom = s.min[1], ground = groundAt((s.min[0] + s.max[0]) / 2, (s.min[2] + s.max[2]) / 2);
    if (bottom < ground - EPS) {
      findings.push({
        code: "buried",
        severity: "warning",
        node: s.id,
        depth: round(ground - bottom),
        message: `${s.id} sinks ${round(ground - bottom)} m below the ground`,
        suggestion: `{ op: "ground", id: "${s.id}" } puts it on the ground.`,
      });
      continue;
    }
    if (bottom <= ground + EPS) continue;
    const others = singles.filter((o) => o !== s && !related(o.id, s.id));
    if (others.some((o) => touch(o, s))) continue;
    let support = ground;
    for (const o of others) if (o.max[1] <= bottom + EPS && o.max[1] > support && footprintsTouch(o, s)) support = o.max[1];
    const gap = bottom - support;
    findings.push({
      code: "floating",
      severity: "warning",
      node: s.id,
      gap: round(gap),
      message: `${s.id} touches nothing; it floats ${round(gap)} m above ${support === ground ? "the ground" : "what is under it"}`,
      suggestion: `Lower it by ${round(gap)} m, or { op: "ground", id: "${s.id}" } for the ground.`,
    });
  }

  // The world's extent: the tile, or tile.span tiles around it.
  const grid = tileGrid(project);
  if (grid) {
    const { min, max } = grid.extent, [w, d] = grid.size, many = grid.span[0] > 1 || grid.span[1] > 1;
    for (const s of solids)
      if (s.min[0] < min[0] || s.max[0] > max[0] || s.min[2] < min[1] || s.max[2] > max[1])
        findings.push({
          code: "out-of-bounds",
          severity: "warning",
          node: s.id,
          message: many ? `${s.id} leaves the ${grid.span[0]} × ${grid.span[1]} tiles of ${w} × ${d} m` : `${s.id} leaves the ${w} × ${d} m tile`,
          suggestion: many ? "Move it inside the world or widen tile.span." : "Move it inside the tile, enlarge tile.size, or set tile.span for a world of several tiles.",
        });
  }

  // Placed models the runtime cannot load yet.
  for (const n of project.nodes)
    if (n.place && !n.place.derived)
      findings.push({
        code: "unconverted-model",
        severity: "warning",
        node: n.id,
        model: n.place.model,
        message: `${n.place.model} has no .fun3d file yet; a tile needs it`,
        suggestion: "The library converts approved versions; ask for the conversion or pick another version.",
      });

  // Rules whose inputs changed since they were derived, or never derived.
  for (const status of ruleStatus(project))
    if (status.state !== "current" && status.state !== "runtime")
      findings.push({
        code: status.state === "underived" ? "underived-rule" : "stale-rule",
        severity: "warning",
        rule: status.id,
        message:
          status.state === "underived"
            ? `rule ${status.id} has not been derived yet`
            : `rule ${status.id} was derived from inputs that have changed since`,
        suggestion: `derive({ id: "${status.id}" }) rebuilds its copies.`,
      });

  // Reach (nav set): every marker must be reachable from a spawn marker over the walkable raster.
  if (project.nav) {
    const markers = project.nodes.filter((n) => n.marker), spawns = markers.filter((n) => n.tags?.includes("spawn"));
    if (spawns.length) {
      const b = sceneBounds(project), nav = buildNavgrid(project, project.nav, { min: [b.min[0], b.min[2]], max: [Math.max(b.max[0], b.min[0] + project.nav.cell), Math.max(b.max[2], b.min[2] + project.nav.cell)] });
      const at = (n) => point(worldMatrix(project, n.id), [0, 0, 0]);
      const mask = new Uint8Array(nav.cells.length);
      for (const s of spawns) {
        const p = at(s), c = navCellAt(nav, p[0], p[2]);
        if (!c || !c.area) {
          findings.push({ code: "unwalkable", severity: "warning", node: s.id, message: `spawn ${s.id} stands where no one can walk`, suggestion: "Move it onto open ground, or widen nav.radius's clearance around it." });
          continue;
        }
        const r = reachable(nav, p, { climb: nav.climb });
        for (let i = 0; i < mask.length; i++) if (r[i]) mask[i] = 1;
      }
      let listed = 0;
      for (const m of markers) {
        if (m.tags?.includes("spawn")) continue;
        const p = at(m), c = navCellAt(nav, p[0], p[2]);
        if (c && c.area && mask[c.index]) continue;
        if (listed++ >= 20) break;
        findings.push({ code: "unreachable", severity: "warning", node: m.id, message: c && c.area ? `${m.id} cannot be reached from any spawn marker` : `${m.id} stands where no one can walk`, suggestion: "Open a way (a path on the ground, a gap in what blocks), lower nav.slope or nav.radius, or move the marker." });
      }
    }
  }

  // The budget: local triangles plus the placed models' own; per tile once the scene cuts
  // into several (what streams in together is what a phone draws together).
  const stats = statistics(project),
    triangles = stats.triangles + stats.placedTriangles,
    limit = budget.triangles ?? 300000;
  const many = grid && (grid.span[0] > 1 || grid.span[1] > 1);
  const tiles = many ? auditTiles(project, { triangles: limit }) : { findings: [], tiles: [] };
  findings.push(...tiles.findings);
  if (!many && triangles > limit)
    findings.push({
      code: "budget",
      severity: "warning",
      metric: "triangles",
      actual: triangles,
      limit,
      message: `${triangles} triangles in the scene, above the budget of ${limit}`,
      suggestion: "Use lighter models or fewer copies; far detail can come later as LOD.",
    });

  return {
    findings,
    tiles: tiles.tiles,
    counts: {
      errors: findings.filter((f) => f.severity === "error").length,
      warnings: findings.filter((f) => f.severity === "warning").length,
    },
    solids: solids.length,
    triangles,
  };
}
