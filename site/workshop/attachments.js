// Persistent material-point bindings. Coordinates/offsets are metres; the
// triangle's first edge defines +X, its oriented normal +Z, and +Y = Z × X.
import { ModelError, triangulate, sub, add, mul, dot, cross } from "./mesh.js";
import { connectivityToken } from "./components.js";
import { worldMatrix, matrix, point, direction, inverse, multiply, decompose } from "./spatial.js";
import { isDense } from "./dense.js";

const error = (message, id, code = "attachment", details = {}) => {
  const e = new ModelError(message, code, `nodes.${id}.attachment`);
  e.suggestion = "Inspect the binding; detachSurface before topology edits, then attachSurface explicitly to rebind.";
  Object.assign(e, details);
  throw e;
};
const vec = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const unit = (v, id) => {
  const length = Math.hypot(...v);
  if (length < 1e-12) error("Attachment triangle collapsed", id);
  return mul(v, 1 / length);
};
export function normalizeAttachment(a, id) {
  if (!a || ![1, 2, 3].includes(a.version) || typeof a.target !== "string" || typeof a.face !== "string" ||
      typeof a.connectivity !== "string" || !["position", "frame", "deform"].includes(a.mode) ||
      !vec(a.anchor) || !vec(a.weights) || a.weights.some(w => w < -1e-9 || w > 1 + 1e-9) ||
      Math.abs(a.weights.reduce((s, w) => s + w, 0) - 1) > 1e-8 ||
      !Array.isArray(a.vertices) || a.vertices.length !== 3 ||
      a.vertices.some(i => !Number.isSafeInteger(i) || i < 0) || new Set(a.vertices).size !== 3 ||
      !Number.isFinite(a.offset) ||
      (a.mode === "frame" && (!Array.isArray(a.relative) || a.relative.length !== 16 || !a.relative.every(Number.isFinite))))
    error("Invalid surface attachment", id);
  if (a.mode === "deform" && (![2, 3].includes(a.version) || typeof a.sourceConnectivity !== "string" ||
      !Array.isArray(a.coordinates) || a.coordinates.length > 30000 || !a.coordinates.length || a.coordinates.some(v => !vec(v))))
    error("Deform attachment needs v2, source connectivity and saved per-vertex coordinates", id);
  const m = a.mirror;
  if (m && (a.version !== 3 || typeof m.source !== "string" || !["x", "y", "z"].includes(m.axis) ||
      !Number.isFinite(m.plane) || !(m.tolerance > 0 && Number.isFinite(m.tolerance)) ||
      !Number.isFinite(m.residual) || m.residual < 0 || m.residual > m.tolerance || typeof m.sourceSignature !== "string"))
    error("Invalid mirrored surface binding", id);
  return { version: m ? 3 : a.mode === "deform" ? 2 : 1, target: a.target, face: a.face, connectivity: a.connectivity,
    vertices: [...a.vertices], weights: [...a.weights], anchor: [...a.anchor], offset: a.offset,
    mode: a.mode, ...(a.mode === "frame" ? { relative: [...a.relative] } : {}),
    ...(a.mode === "deform" ? { sourceConnectivity: a.sourceConnectivity, coordinates: a.coordinates.map(v => [...v]) } : {}),
    ...(m ? { mirror: { source: m.source, axis: m.axis, plane: m.plane, tolerance: m.tolerance,
      residual: m.residual, sourceSignature: m.sourceSignature } } : {}) };
}
const bindingSignature = a => JSON.stringify([a.face, a.vertices, a.weights.map(w => Math.round(w * 1e10)), a.connectivity, a.mode]);
const localBindingPoint = (target, a) => a.vertices.reduce((p, index, i) => add(p, mul(target.mesh.vertices[index], a.weights[i])), [0, 0, 0]);
export function mirrorSurface(project, node, command) {
  const source = project.nodes.find(n => n.id === command.sourceId), a = source?.attachment;
  if (!a || source.id === node.id) error("Choose a different source with an existing surface binding", node.id, "dependency");
  const checked = new Set();
  const checkDependency = id => {
    if (!id || checked.has(id)) return;
    if (id === node.id) error("Mirrored binding would create a surface attachment / parent dependency cycle", node.id, "dependency");
    checked.add(id);
    const dependency = project.nodes.find(n => n.id === id);
    if (!dependency) error(`Missing mirror dependency ${id}`, node.id, "dependency");
    for (const next of [dependency.parent, dependency.attachment?.target, dependency.attachment?.mirror?.source])
      checkDependency(next);
  };
  checkDependency(source.id);
  const target = targetMesh(project, node.id, a.target), axis = command.axis ?? "x", plane = command.plane ?? 0;
  const tolerance = command.tolerance ?? 1e-5;
  if (!["x", "y", "z"].includes(axis) || !Number.isFinite(plane) || !(tolerance > 0 && Number.isFinite(tolerance)))
    error("Mirror axis is x/y/z; plane and positive tolerance use target-local metres", node.id);
  frame(project, a, source.id); // Explicitly reject stale source bindings before looking up their points.
  const at = localBindingPoint(target, a), k = ["x", "y", "z"].indexOf(axis);
  at[k] = 2 * plane - at[k];
  bindSurface(project, node, { targetId: target.id, at: point(worldMatrix(project, target.id), at),
    anchor: command.anchor ?? node.attachment?.anchor ?? [0, 0, 0], offset: a.offset, mode: command.mode ?? a.mode });
  const residual = Math.hypot(...sub(localBindingPoint(target, node.attachment), at));
  if (residual > tolerance) error(`No mirrored surface within tolerance ${tolerance}; measured ${residual} target-local metres`, node.id,
    "mirror_surface_miss", { retryable: false, issues: [{ code: "mirror_surface_miss", node: node.id, target: target.id,
      point: at, nearest: localBindingPoint(target, node.attachment), space: "target-local", actual: residual, threshold: tolerance }],
      suggestion: "Check the target-local mirror axis/plane and target symmetry; no binding was committed." });
  node.attachment = normalizeAttachment({ ...node.attachment, version: 3, mirror: {
    source: source.id, axis, plane, tolerance, residual, sourceSignature: bindingSignature(a),
  } }, node.id);
  return { source: source.id, target: target.id, space: "target-local", unit: "metre", axis, plane, tolerance, residual };
}
function targetMesh(project, id, target) {
  const n = project.nodes.find(n => n.id === target);
  if (!n?.mesh) error(`Missing attachment target mesh: ${target}`, id);
  // These are evaluated in a separate dependency pass. Reject, never accept a
  // binding whose order cannot yet be guaranteed.
  if (derivedFrame(project, n) || isDense(n.mesh))
    error("Bind to an independent polygon mesh; derived/dense targets are not supported yet", id);
  return n;
}
function derivedFrame(project, node) {
  const seen = new Set();
  while (node) {
    if (seen.has(node.id)) error("Parent cycle", node.id, "dependency");
    seen.add(node.id);
    if (node.symmetry || node.instanceOf) return true;
    node = project.nodes.find(n => n.id === node.parent);
  }
  return false;
}
function frame(project, a, id) {
  const target = targetMesh(project, id, a.target);
  const face = target.mesh.faces.find(f => f.id === a.face);
  if (connectivityToken(target.mesh) !== a.connectivity ||
      !face || a.vertices.some(i => !face.vertices.includes(i)))
    error("Attachment topology changed; explicit rebind required", id, "stale_attachment");
  const matrix = worldMatrix(project, target.id);
  const [p, q, r] = a.vertices.map(i => point(matrix, target.mesh.vertices[i]));
  const z = unit(cross(sub(q, p), sub(r, p)), id);
  // Deform mode retains edge length and in-plane shear; normal distance stays
  // in world metres. Position/frame modes retain their orthonormal basis.
  const x = a.mode === "deform" ? sub(q, p) : unit(sub(q, p), id);
  const y = a.mode === "deform" ? sub(r, p) : cross(z, x);
  const at = add(add(add(mul(p, a.weights[0]), mul(q, a.weights[1])), mul(r, a.weights[2])), mul(z, a.offset));
  return [...x, 0, ...y, 0, ...z, 0, ...at, 1];
}
function closest(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d00 = dot(ab, ab), d01 = dot(ab, ac), d11 = dot(ac, ac);
  const denominator = d00 * d11 - d01 * d01;
  if (denominator <= 1e-24) return null;
  const v = (d11 * dot(ap, ab) - d01 * dot(ap, ac)) / denominator;
  const w = (d00 * dot(ap, ac) - d01 * dot(ap, ab)) / denominator;
  let weights = [1 - v - w, v, w];
  const position = weights => add(add(mul(a, weights[0]), mul(b, weights[1])), mul(c, weights[2]));
  if (weights.some(w => w < 0)) {
    let best = Infinity;
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
      const ps = [a, b, c], edge = sub(ps[j], ps[i]);
      const t = Math.max(0, Math.min(1, dot(sub(p, ps[i]), edge) / dot(edge, edge)));
      const candidate = [0, 0, 0]; candidate[i] = 1 - t; candidate[j] = t;
      const distance = Math.hypot(...sub(p, position(candidate)));
      if (distance < best) { best = distance; weights = candidate; }
    }
  }
  return { weights, distance: Math.hypot(...sub(p, position(weights))) };
}
export function bindSurface(project, node, command) {
  if (derivedFrame(project, node) || node.recipe)
    error("Attach an independent mesh or group; put recipe parts below an attached group", node.id);
  const { targetId, anchor = [0, 0, 0], offset = 0, mode = "position" } = command;
  if (!vec(anchor) || !Number.isFinite(offset) || !["position", "frame", "deform"].includes(mode))
    error("Expected local anchor, metre offset, and position/frame/deform mode", node.id);
  if (mode === "deform" && (!node.mesh || isDense(node.mesh) || node.morph || node.skin))
    error("Deform attachment needs an independent polygon mesh without morph or skin; put those parts under a position/frame mount", node.id);
  const target = targetMesh(project, node.id, targetId);
  const at = command.at ?? point(worldMatrix(project, node.id), anchor);
  if (!vec(at)) error("at must be a world-space point in metres", node.id);
  const m = worldMatrix(project, target.id);
  let best;
  for (const f of target.mesh.faces) for (const vertices of triangulate(target.mesh.vertices, f.vertices)) {
    const hit = closest(at, ...vertices.map(i => point(m, target.mesh.vertices[i])));
    if (hit && (!best || hit.distance < best.distance)) best = { ...hit, face: f.id, vertices };
  }
  if (!best) error("Target has no nondegenerate triangles", node.id);
  const a = { version: 1, target: target.id, face: best.face, vertices: best.vertices,
    weights: best.weights, connectivity: connectivityToken(target.mesh), anchor, offset, mode };
  if (mode === "frame") {
    a.relative = multiply(inverse(frame(project, a, node.id)), worldMatrix(project, node.id));
    a.relative.splice(12, 3, ...mul(direction(a.relative, anchor), -1));
  }
  if (mode === "deform") {
    a.version = 2; a.sourceConnectivity = connectivityToken(node.mesh);
    const toPatch = multiply(inverse(frame(project, { ...a, offset: 0 }, node.id)), worldMatrix(project, node.id));
    a.coordinates = node.mesh.vertices.map(v => point(toPatch, v));
    // The saved patch coordinates become this mesh's geometry driver.
    delete node.generator;
  }
  node.attachment = normalizeAttachment(a, node.id);
}
export function updateAttachments(project) {
  if (!project.nodes.some(n => n.attachment)) return;
  const visiting = new Set(), done = new Set();
  const visit = id => {
    if (!id || done.has(id)) return;
    if (visiting.has(id)) error("Surface attachment / parent dependency cycle", id, "dependency");
    const node = project.nodes.find(n => n.id === id);
    if (!node) error(`Missing dependency ${id}`, id);
    visiting.add(id);
    visit(node.parent);
    if (node.attachment) {
      if (derivedFrame(project, node)) error("Attached node cannot use a derived parent frame", id);
      const a = node.attachment;
      if (a.mirror) {
        visit(a.mirror.source);
        const source = project.nodes.find(n => n.id === a.mirror.source)?.attachment;
        if (!source || source.target !== a.target || bindingSignature(source) !== a.mirror.sourceSignature)
          error("Mirror source binding changed or disappeared; detach the mirrored follower, edit the source, then mirrorSurface again in one transaction", id, "stale_attachment");
        a.offset = source.offset;
      }
      visit(a.target);
      const f = frame(project, a, id);
      if (a.mode === "deform") {
        if (!node.mesh || isDense(node.mesh) || node.morph || node.skin ||
            connectivityToken(node.mesh) !== a.sourceConnectivity || node.mesh.vertices.length !== a.coordinates.length)
          error("Deform follower topology or geometry driver changed; detach and explicitly rebind", id, "stale_attachment");
        const toLocal = multiply(inverse(worldMatrix(project, id)), f);
        node.mesh.vertices = a.coordinates.map(v => point(toLocal, v).map(v => v || 0));
      } else if (a.mode === "position") {
        // Only translation is driven. Re-decomposing the unchanged linear
        // transform on every evaluation causes rotation/scale roundoff drift.
        const anchor = point(inverse(worldMatrix(project, node.parent)), f.slice(12, 15));
        node.position = sub(anchor, direction(matrix(node), a.anchor)).map(v => v || 0);
      } else {
        const world = multiply(f, a.relative);
        const trs = decompose(multiply(inverse(worldMatrix(project, node.parent)), world));
        if (!trs) error("Attachment requires a shear-free positive-scale transform", id);
        for (const key of ["position", "rotation", "scale"]) trs[key] = trs[key].map(v => v || 0);
        Object.assign(node, trs);
      }
    }
    visiting.delete(id); done.add(id);
  };
  for (const node of project.nodes) visit(node.id);
}
