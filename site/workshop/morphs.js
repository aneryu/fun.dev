import { ModelError, vector } from "./mesh.js";
import { connectivityToken } from "./components.js";
import { isDense } from "./dense.js";

const fail = (message, id, code = "morph") => {
  const e = new ModelError(message, code, `nodes.${id}.morph`);
  e.suggestion = "Keep vertex correspondence, or explicitly remove all morph targets before topology edits.";
  throw e;
};
const nameOf = (name, id) => {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name))
    fail("Target names use 1–64 letters, digits, dots, underscores or hyphens", id);
  return name;
};
export function normalizeMorph(m, node) {
  if (!node.mesh || isDense(node.mesh) || node.symmetry || node.instanceOf) fail("Morphs need an independent polygon mesh", node.id);
  if (!m || m.version !== 1 || m.connectivity !== connectivityToken(node.mesh)) fail("Morph topology changed", node.id, "stale_morph");
  const n = node.mesh.vertices.length;
  const coordinates = (list, path) => {
    if (!Array.isArray(list) || list.length !== n) fail("Morph vertex count differs from base", node.id);
    return list.map((v, i) => vector(v, `${node.id}.morph.${path}.${i}`));
  };
  if (!Array.isArray(m.targets) || !m.targets.length || m.targets.length > 128 || m.targets.length * n > 1_000_000)
    fail("Morph budget: 1–128 targets and at most one million target vertices", node.id);
  const names = new Set();
  const targets = m.targets.map(t => {
    const name = nameOf(t.name, node.id);
    if (names.has(name)) fail("Duplicate morph target name", node.id);
    names.add(name);
    return { name, deltas: coordinates(t.deltas, name) };
  });
  const weights = {};
  for (const [name, weight] of Object.entries(m.weights ?? {})) {
    if (!names.has(name) || !Number.isFinite(weight) || weight < 0 || weight > 1)
      fail("Weights require an existing target and a number from 0 to 1", node.id);
    weights[name] = weight;
  }
  return { version: 1, connectivity: m.connectivity, base: coordinates(m.base, "base"), targets, weights };
}
export function resetMorphMeshes(project) {
  for (const n of project.nodes) if (n.morph)
    n.mesh.vertices = n.morph.base.map(v => [...v]);
}
export function refreshMorphBases(project) {
  for (const n of project.nodes) if (n.morph) {
    if (!n.mesh || isDense(n.mesh) || connectivityToken(n.mesh) !== n.morph.connectivity)
      fail("Operation changed morph topology", n.id, "stale_morph");
    n.morph.base = n.mesh.vertices.map(v => [...v]);
  }
}
export function applyMorphs(project) {
  for (const n of project.nodes) if (n.morph) {
    if (!n.mesh || connectivityToken(n.mesh) !== n.morph.connectivity) fail("Morph topology changed", n.id, "stale_morph");
    n.mesh.vertices = n.morph.base.map((v, i) => v.map((x, k) =>
      n.morph.targets.reduce((sum, t) => sum + (n.morph.weights[t.name] ?? 0) * t.deltas[i][k], x)));
  }
}
export function morphCommand(node, command) {
  if (!node.mesh || isDense(node.mesh) || node.symmetry || node.instanceOf)
    fail("Morphs need an independent polygon mesh", node.id);
  if (command.op === "morphTarget" || command.op === "morphEdit") {
    const name = nameOf(command.name, node.id);
    const existing = node.morph?.targets.find(t => t.name === name);
    if (command.op === "morphEdit" && !existing) fail("Unknown morph target; create it with morphTarget first", node.id);
    node.morph ??= { version: 1, connectivity: connectivityToken(node.mesh),
      base: node.mesh.vertices.map(v => [...v]), targets: [], weights: {} };
    const deltas = command.op === "morphEdit" ? existing.deltas.map(v => [...v]) : node.morph.base.map(() => [0, 0, 0]);
    if (!Array.isArray(command.changes)) fail("Provide absolute target positions in local metres", node.id);
    const seen = new Set();
    for (const { index, position } of command.changes) {
      if (!Number.isInteger(index) || index < 0 || index >= deltas.length || seen.has(index))
        fail("Invalid or duplicate target vertex index", node.id);
      seen.add(index);
      deltas[index] = vector(position).map((v, k) => v - node.morph.base[index][k]);
    }
    if (command.op === "morphEdit") existing.deltas = deltas;
    else node.morph.targets = [...node.morph.targets.filter(t => t.name !== name), { name, deltas }];
  } else if (command.op === "morphWeights") {
    if (!node.morph) fail("No morph targets", node.id);
    node.morph.weights = { ...node.morph.weights, ...command.values };
  } else if (command.op === "morphRemove") {
    if (!node.morph?.targets.some(t => t.name === command.name)) fail("Unknown morph target", node.id);
    node.morph.targets = node.morph.targets.filter(t => t.name !== command.name);
    delete node.morph.weights[command.name];
    if (!node.morph.targets.length) delete node.morph;
  } else if (command.op === "morphMirror") {
    const m = node.morph, source = m?.targets.find(t => t.name === command.name);
    if (!source) fail("Unknown morph target", node.id);
    const name = nameOf(command.newName, node.id), axis = ["x", "y", "z"].indexOf(command.axis ?? "x");
    if (axis < 0 || name === command.name) fail("Mirror needs an axis and a distinct target name", node.id);
    const deltas = m.base.map((p, i) => {
      const reflected = p.map((v, k) => k === axis ? -v : v);
      const matches = m.base.flatMap((v, j) => Math.hypot(...v.map((x, k) => x - reflected[k])) < 1e-7 ? [j] : []);
      if (matches.length !== 1) fail(`Vertex ${i} has no unique mirrored correspondence`, node.id);
      return source.deltas[matches[0]].map((v, k) => k === axis ? -v : v);
    });
    m.targets = [...m.targets.filter(t => t.name !== name), { name, deltas }];
  }
  if (node.morph) node.morph = normalizeMorph(node.morph, node);
}
