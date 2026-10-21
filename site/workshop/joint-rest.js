import { ModelError, vector } from "./mesh.js";
import { worldMatrix, inverse, multiply, decompose } from "./spatial.js";
import { skinCommand } from "./skin.js";

// Runs after document resets character, morph and skin to their authored bases.
export function editJointRest(project, node, command) {
  const fail = (message, id = node.id, details = {}) => {
    const error = new ModelError(message, "dependency", `nodes.${id}.joint`);
    error.node = id; error.retryable = false;
    error.issues = [{ code: "joint_rest_dependency", node: id, space: "world",
      point: worldMatrix(project, id).slice(12, 15), message, ...details }];
    error.suggestion = "Edit an independent joint; detach conflicting drivers first. Existing absolute animation keys are not retargeted.";
    throw error;
  };
  if (!node.joint) fail("Select an existing joint");
  const children = project.nodes.filter(n => n.parent === node.id);
  for (const n of [node, ...children])
    if (n.attachment || n.instanceOf || n.symmetry ||
        project.assemblies?.some(a => a.bindings.some(b => b.id === n.id)))
      fail("Joint rest editing cannot override surface, linked or assembly drivers", n.id);
  const saved = children.map(n => ({ node: n, world: worldMatrix(project, n.id) }));
  for (const key of ["position", "rotation", "scale"])
    if (command[key] !== undefined) node[key] = vector(command[key], `nodes.${node.id}.${key}`);
  if (node.scale.some(v => v <= 0)) fail("Joint rest scale must be positive");
  // Adjust the pivot without dragging the authored children through space.
  for (const { node: child, world } of saved) {
    const desiredLocalMatrix = multiply(inverse(worldMatrix(project, node.id)), world);
    const local = decompose(desiredLocalMatrix);
    if (!local) fail("Preserving this child would require shear; use a uniform joint scale", child.id,
      { desiredLocalMatrix, matrixSpace: "parent-local" });
    Object.assign(child, local);
  }
  for (const n of [node, ...children].filter(n => n.joint))
    n.joint.rest = Object.fromEntries(["position", "rotation", "scale"].map(k => [k, [...n[k]]]));
  const reboundSkins = [];
  for (const mesh of project.nodes) if (mesh.skin?.joints.includes(node.id)) {
    const skin = mesh.skin;
    skinCommand(project, mesh, { op: "skinBind", joints: skin.joints,
      weights: skin.weights.map((ws, index) => ({ index,
        influences: ws.map(w => ({ joint: skin.joints[w.joint], weight: w.weight })),
      })) });
    reboundSkins.push(mesh.id);
  }
  const adjusted = new Set([node.id, ...children.map(n => n.id)]);
  const unchangedTracks = (project.character?.clips ?? []).flatMap(clip => clip.tracks
    .filter(track => adjusted.has(track.node) && ["position", "rotation", "scale"].includes(track.channel))
    .map(track => ({ clip: clip.name, node: track.node, channel: track.channel })));
  return { joint: node.id, space: "parent-local", units: { position: "metres", rotation: "XYZ degrees", scale: "factor" },
    preservedChildWorldFrames: children.map(n => n.id), reboundSkins, unchangedTracks,
    geometry: "Unposed base geometry preserved; current animation/expression pose is not baked.",
    animation: "Absolute keys are unchanged, not retargeted; inspect clips after moving a rest joint." };
}
