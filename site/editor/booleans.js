// Boolean union, difference and intersection on closed solids. Tools are other parts
// (consumed unless kept) or an inline primitive placed in the part's local coordinates,
// which is what a recipe step uses: a parametric hole stays editable.
import { fail, primitive } from "./mesh.js";
import { matrix, multiply, inverse, worldMatrix } from "./spatial.js";
import { kernel } from "./kernel.js";
import { toSolid, fromSolid } from "./solid.js";

export const BOOLEAN_OPERATIONS = ["union", "difference", "intersection"];

export function booleanMesh(project, node, command) {
  if (!node.mesh) fail("Boolean needs a mesh part", "id");
  if (!BOOLEAN_OPERATIONS.includes(command.operation))
    fail("Expected union, difference or intersection", "operation");
  if (!!command.with === !!command.shape)
    fail("Give either with (part IDs) or shape (an inline primitive)", "with");
  const { Manifold } = kernel(),
    owned = [],
    sources = new Map(),
    track = (solid, materials, fallback) => {
      owned.push(solid);
      sources.set(solid.sourceID, { materials, fallback });
      return solid;
    };
  const consumed = [];
  try {
    const target = track(
      toSolid(node.mesh),
      node.mesh.faces.map((f) => f.material),
    );
    const tools = [];
    if (command.shape) {
      const s = command.shape,
        material = s.material ?? node.mesh.faces[0].material,
        mesh = primitive(s.kind ?? "box", s.options ?? {}, material),
        placement = matrix({
          position: s.position ?? [0, 0, 0],
          rotation: s.rotation ?? [0, 0, 0],
          scale: s.scale ?? [1, 1, 1],
        });
      if (!project.materials.some((m) => m.id === material))
        fail(`Unknown material: ${material}`, "shape.material");
      tools.push(track(toSolid(mesh, placement), mesh.faces.map((f) => f.material)));
    } else {
      if (!Array.isArray(command.with) || !command.with.length)
        fail("with needs part IDs", "with");
      const local = inverse(worldMatrix(project, node.id));
      for (const id of new Set(command.with)) {
        const tool = project.nodes.find((n) => n.id === id);
        if (!tool?.mesh) fail(`Boolean tool needs a mesh part: ${id}`, "with");
        if (id === node.id) fail("A part cannot cut itself", "with");
        for (let p = node.parent; p; p = project.nodes.find((n) => n.id === p)?.parent)
          if (p === id) fail(`A tool cannot contain the target: ${id}`, "with");
        const placement = multiply(local, worldMatrix(project, id));
        tools.push(track(toSolid(tool.mesh, placement), tool.mesh.faces.map((f) => f.material)));
        consumed.push(id);
      }
    }
    let result;
    if (command.operation === "union")
      result = Manifold.union([target, ...tools]);
    else if (command.operation === "intersection")
      result = Manifold.intersection([target, ...tools]);
    else {
      const cutter = tools.length > 1 ? Manifold.union(tools) : tools[0];
      if (cutter !== tools[0]) owned.push(cutter);
      result = target.subtract(cutter);
    }
    owned.push(result);
    if (result.isEmpty())
      fail("The boolean result is empty; check the tool placement", "with");
    node.mesh = fromSolid(result, sources);
    if (!node.mesh.faces.length) fail("The boolean result is empty", "with");
  } finally {
    for (const solid of owned) solid.delete();
  }
  return { consumed: command.keep ? [] : consumed };
}
