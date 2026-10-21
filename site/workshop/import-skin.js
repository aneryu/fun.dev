import { ModelError } from "./mesh.js";
import { identity } from "./spatial.js";
import { connectivityToken } from "./components.js";

const fail = (message, path, code = "invalid_glb") => {
  const error = new ModelError(message, code, path);
  error.retryable = false;
  error.suggestion = "Export uncompressed VEC4 joint/weight attributes with at most four influences; retain the joint hierarchy and inverse bind matrices.";
  throw error;
};
export function readSkinWeights(json, read, primitive, count, path) {
  const attrs = primitive.attributes ?? {};
  if (Object.keys(attrs).some(key => /^(JOINTS|WEIGHTS)_[1-9]/.test(key)))
    fail("More than four skin influences are not supported; no weights were discarded", path, "unsupported");
  const ja = json.accessors?.[attrs.JOINTS_0], wa = json.accessors?.[attrs.WEIGHTS_0];
  if (!ja || !wa || ja.type !== "VEC4" || wa.type !== "VEC4" || ja.count !== count || wa.count !== count ||
      ![5121, 5123].includes(ja.componentType) || ja.normalized ||
      ![5121, 5123, 5126].includes(wa.componentType) || (wa.componentType !== 5126 && !wa.normalized))
    fail("Skin attributes require matching VEC4 counts, unsigned joint indices and float or normalized unsigned weights", path);
  const joints = read(attrs.JOINTS_0), weights = read(attrs.WEIGHTS_0);
  return Array.from({ length: count }, (_, index) => {
    const combined = new Map();
    for (let k = 0; k < 4; k++) {
      const joint = joints[index * 4 + k], weight = weights[index * 4 + k];
      if (!Number.isInteger(joint) || joint < 0 || !Number.isFinite(weight) || weight < 0 || weight > 1)
        fail(`Invalid skin influence at vertex ${index}, slot ${k}`, `${path}.${index}`);
      if (weight) combined.set(joint, (combined.get(joint) ?? 0) + weight);
    }
    const sum = [...combined.values()].reduce((a, b) => a + b, 0);
    if (!sum || Math.abs(sum - 1) > 1e-4)
      fail(`Skin weights at vertex ${index} must sum to 1; actual ${sum}, tolerance 0.0001`, `${path}.${index}`);
    return [...combined].map(([joint, weight]) => ({ joint, weight: weight / sum }));
  });
}

export function importSkins(json, read, nodesByIndex, weightsByNode, processing) {
  const marked = new Set();
  for (const [index, node] of nodesByIndex) {
    const source = json.nodes[index], skin = json.skins?.[source.skin];
    if (source.skin === undefined) continue;
    const path = `skins.${source.skin}`;
    if (!skin || !Array.isArray(skin.joints) || !skin.joints.length || skin.joints.length > 128 ||
        new Set(skin.joints).size !== skin.joints.length)
      fail("Skin requires 1–128 unique joint nodes", path);
    if (!node.mesh || !weightsByNode.has(node.id)) fail("Skinned node has no matching joint/weight geometry", `nodes.${index}`);
    const joints = skin.joints.map(index => {
      const joint = nodesByIndex.get(index);
      if (!joint) fail(`Joint node ${index} is outside the imported scene or missing`, path);
      if (joint.mesh || joint.instanceOf) fail(`Joint node ${index} also carries geometry; split it into a joint and mesh child before import`, path, "unsupported");
      marked.add(joint);
      return joint.id;
    });
    let inverseBind = joints.map(() => identity());
    if (skin.inverseBindMatrices !== undefined) {
      const a = json.accessors?.[skin.inverseBindMatrices];
      if (!a || a.type !== "MAT4" || a.componentType !== 5126 || a.count < joints.length)
        fail("Inverse bind accessor must contain one FLOAT MAT4 per joint", `${path}.inverseBindMatrices`);
      const values = read(skin.inverseBindMatrices);
      inverseBind = joints.map((_, i) => Array.from(values.slice(i * 16, (i + 1) * 16)));
    }
    const weights = weightsByNode.get(node.id);
    for (const [index, influences] of weights.entries())
      if (influences.some(w => w.joint >= joints.length)) fail(`Vertex ${index} references a joint outside its skin palette`, `${path}.weights.${index}`);
    // glTF inverse binds already include the mesh bind transform.
    node.skin = { version: 1, joints, inverseBind, bindMatrix: identity(),
      connectivity: connectivityToken(node.mesh), base: node.mesh.vertices.map(v => [...v]),
      weights: structuredClone(weights) };
    processing.push({ node: node.id, skin: source.skin, preservedSkinJoints: [...joints],
      vertexWelding: false, inverseBindsPreserved: skin.inverseBindMatrices !== undefined,
      reason: "Preserve skin attribute correspondence; glTF inverse binds use an identity mesh bind matrix" });
  }
  for (const [index, node] of nodesByIndex)
    if (json.nodes[index].extras?.workshopJoint?.version === 1 && !node.mesh && !node.instanceOf) marked.add(node);
  for (const node of marked) node.joint = { version: 1,
    rest: Object.fromEntries(["position", "rotation", "scale"].map(key => [key, [...node[key]]])) };
}
