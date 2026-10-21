import { ModelError, vector } from "./mesh.js";
import { connectivityToken } from "./components.js";
import { isDense } from "./dense.js";
import { worldMatrix, inverse, multiply, point } from "./spatial.js";

const fail = (id, message, code = "skin") => {
  const e = new ModelError(message, code, `nodes.${id}.skin`);
  e.suggestion = "Keep vertex correspondence and joint dependencies; unbind explicitly before changing topology.";
  throw e;
};
function matrix(value, id) {
  if (!Array.isArray(value) || value.length !== 16 || !value.every(Number.isFinite))
    fail(id, "Bind matrices need 16 finite column-major values");
  inverse(value);
  return value.map(v => v || 0);
}
function influences(value, joints, id) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4)
    fail(id, "Each vertex needs 1–4 joint influences");
  const seen = new Set();
  const result = value.map(v => {
    const joint = typeof v.joint === "string" ? joints.indexOf(v.joint) : v.joint;
    if (!Number.isInteger(joint) || joint < 0 || joint >= joints.length || seen.has(joint) ||
        !Number.isFinite(v.weight) || v.weight <= 0 || v.weight > 1)
      fail(id, "Influences need unique existing joints and positive weights up to 1");
    seen.add(joint);
    return { joint, weight: v.weight };
  });
  const sum = result.reduce((s, v) => s + v.weight, 0);
  if (Math.abs(sum - 1) > 1e-6) fail(id, `Weights must sum to 1; actual ${sum}`);
  return result.map(v => ({ ...v, weight: v.weight / sum }));
}
export function normalizeSkin(s, node) {
  const id = node.id;
  if (!node.mesh || isDense(node.mesh) || node.instanceOf || node.symmetry || node.attachment)
    fail(id, "Skin requires an independent polygon mesh without a surface-driven transform");
  if (s?.version !== 1 || s.connectivity !== connectivityToken(node.mesh))
    fail(id, "Skin topology changed", "stale_skin");
  if (!Array.isArray(s.joints) || !s.joints.length || s.joints.length > 128 ||
      new Set(s.joints).size !== s.joints.length || s.joints.some(j => typeof j !== "string"))
    fail(id, "Skin needs 1–128 unique joint ids");
  if (!Array.isArray(s.base) || s.base.length !== node.mesh.vertices.length ||
      !Array.isArray(s.weights) || s.weights.length !== s.base.length ||
      !Array.isArray(s.inverseBind) || s.inverseBind.length !== s.joints.length)
    fail(id, "Skin base, weights and inverse bind counts must match vertices and joints");
  return { version: 1, connectivity: s.connectivity, joints: [...s.joints],
    base: s.base.map(v => vector(v)), bindMatrix: matrix(s.bindMatrix, id),
    inverseBind: s.inverseBind.map(v => matrix(v, id)),
    weights: s.weights.map(v => influences(v, s.joints, id)) };
}
export function validateSkinDependencies(project) {
  const nodes = new Map(project.nodes.map(n => [n.id, n]));
  // A common attached frame moves the mesh and every joint together. It
  // cancels from inverse(meshWorld) * jointWorld before local skinning.
  // Different attached branches require a dependency-aware evaluation order.
  const attachedFrame = node => {
    for (let current = node; current; current = nodes.get(current.parent))
      if (current.attachment) return current.id;
    return null;
  };
  for (const n of project.nodes) if (n.skin) {
    const frame = attachedFrame(n);
    for (const id of n.skin.joints) {
      const joint = nodes.get(id);
      if (!joint?.joint) fail(n.id, `Missing joint ${id}`);
      if (attachedFrame(joint) !== frame)
        fail(n.id, `Joint ${id} and mesh must share the same surface-attached frame (mesh: ${frame ?? "world"}, joint: ${attachedFrame(joint) ?? "world"})`);
    }
    if (project.nodes.some(o => o.instanceOf === n.id || o.symmetry?.source === n.id))
      fail(n.id, "Skinned mesh cannot be a linked-copy or symmetry source");
  }
}
export function resetSkins(project) {
  for (const n of project.nodes) if (n.skin) n.mesh.vertices = n.skin.base.map(v => [...v]);
}
export function refreshSkinBases(project) {
  for (const n of project.nodes) if (n.skin) {
    if (!n.mesh || connectivityToken(n.mesh) !== n.skin.connectivity)
      fail(n.id, "Operation changed skin topology", "stale_skin");
    n.skin.base = n.mesh.vertices.map(v => [...v]);
  }
}
export function applySkins(project) {
  validateSkinDependencies(project);
  for (const n of project.nodes) if (n.skin) {
    const s = n.skin, toLocal = inverse(worldMatrix(project, n.id));
    const matrices = s.joints.map((id, i) =>
      multiply(toLocal, multiply(worldMatrix(project, id), multiply(s.inverseBind[i], s.bindMatrix))));
    const base = n.morph ? n.mesh.vertices : s.base;
    n.mesh.vertices = base.map((v, i) => s.weights[i].reduce((p, w) => {
      const q = point(matrices[w.joint], v);
      return p.map((x, k) => x + q[k] * w.weight);
    }, [0, 0, 0]));
  }
}
export function skinCommand(project, node, command) {
  if (command.op === "skinUnbind") { delete node.skin; return; }
  if (command.op === "skinBind") {
    if (!node.mesh || isDense(node.mesh)) fail(node.id, "Skin requires a polygon mesh");
    const joints = command.joints;
    if (!Array.isArray(joints) || !joints.length) fail(node.id, "Specify joints");
    node.skin = { version: 1, connectivity: connectivityToken(node.mesh),
      joints: [...joints], base: node.mesh.vertices.map(v => [...v]),
      bindMatrix: worldMatrix(project, node.id),
      inverseBind: joints.map(id => {
        if (!project.nodes.find(n => n.id === id)?.joint) fail(node.id, `Missing joint ${id}`);
        return inverse(worldMatrix(project, id));
      }), weights: Array(node.mesh.vertices.length).fill(null) };
  }
  if (!node.skin) fail(node.id, "Bind the mesh before editing skin weights");
  const seen = new Set();
  for (const w of command.weights ?? []) {
    if (!Number.isInteger(w.index) || w.index < 0 || w.index >= node.skin.weights.length || seen.has(w.index))
      fail(node.id, `Invalid or duplicate weight vertex ${w.index}`);
    seen.add(w.index);
    node.skin.weights[w.index] = influences(w.influences, node.skin.joints, node.id);
  }
  node.skin = normalizeSkin(node.skin, node);
  validateSkinDependencies(project);
}
