// The scene audit (docs/worlds.md §9): what an agent cannot see in a picture. Findings are
// structured and come with a suggestion; none of them blocks an export, a game may want
// what the audit flags (a lamp standing in a planter overlaps it).
import { worldMatrix, point, nodePoints } from "./spatial.js";
import { statistics } from "./document.js";

const EPS = 0.02; // 2 cm: resting on something, or on the ground
const round = (v) => Math.round(v * 1000) / 1000;

/** World bounds of every solid part: meshes and placed models. */
export function solidBounds(project) {
  const solids = [];
  for (const node of project.nodes) {
    if (!(node.mesh || node.place)) continue;
    const m = worldMatrix(project, node.id);
    const points = (node.mesh?.vertices ?? nodePoints(node)).map((v) => point(m, v));
    const min = [0, 1, 2].map((i) => Math.min(...points.map((p) => p[i]))),
      max = [0, 1, 2].map((i) => Math.max(...points.map((p) => p[i])));
    solids.push({ id: node.id, min, max, kind: node.place ? "place" : "mesh" });
  }
  return solids;
}

/**
 * Audits a project: overlapping solids, floating or buried parts, parts outside the tile,
 * placed models without a runtime file, and the triangle budget. `ground` is the floor's
 * height (0: the library convention); `budget.triangles` defaults to a phone's.
 */
export function auditProject(project, { ground = 0, budget = {} } = {}) {
  if (!Number.isFinite(ground)) throw new TypeError("ground must be a number");
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

  // Overlaps: bounds that interpenetrate by more than 5 cm on every axis.
  for (let i = 0; i < solids.length; i++)
    for (let j = i + 1; j < solids.length; j++) {
      const a = solids[i],
        b = solids[j];
      if (related(a.id, b.id)) continue;
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

  // Floating and buried: a solid stands on the ground, rests on another solid under its
  // footprint, or touches one on a side (a clock on a wall, a shelf against it).
  const touch = (a, b) => [0, 1, 2].every((k) => Math.max(a.min[k], b.min[k]) - Math.min(a.max[k], b.max[k]) <= EPS);
  for (const s of solids) {
    if (grounds.has(s.id)) continue;
    const bottom = s.min[1];
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
    const others = solids.filter((o) => o !== s && !related(o.id, s.id));
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

  // The tile's extent.
  if (project.tile) {
    const [w, d] = project.tile.size;
    for (const s of solids)
      if (s.min[0] < -w / 2 || s.max[0] > w / 2 || s.min[2] < -d / 2 || s.max[2] > d / 2)
        findings.push({
          code: "out-of-bounds",
          severity: "warning",
          node: s.id,
          message: `${s.id} leaves the ${w} × ${d} m tile`,
          suggestion: "Move it inside the tile or enlarge tile.size.",
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

  // The budget: local triangles plus the placed models' own.
  const stats = statistics(project),
    triangles = stats.triangles + stats.placedTriangles,
    limit = budget.triangles ?? 300000;
  if (triangles > limit)
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
    counts: {
      errors: findings.filter((f) => f.severity === "error").length,
      warnings: findings.filter((f) => f.severity === "warning").length,
    },
    solids: solids.length,
    triangles,
  };
}
