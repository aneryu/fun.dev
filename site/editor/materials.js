import { ModelError } from "./mesh.js";

// Only visit material slots, never arbitrary strings such as object names.
// Cached faces and dormant recipe inputs both count as live references.
export function visitMaterials(project, visit) {
  for (const node of project.nodes) {
    const slot = (owner, key, path, retained = true) => {
      if (owner?.[key] !== undefined)
        visit({
          owner,
          key,
          material: owner[key],
          node: node.id,
          path,
          retained,
        });
    };
    const mesh = (value, path, retained) =>
      value?.faces?.forEach((face, i) =>
        slot(face, "material", `${path}.faces.${i}.material`, retained),
      );
    mesh(node.mesh, `nodes.${node.id}.mesh`, false);
    slot(node.generator, "material", `nodes.${node.id}.generator.material`);
    const recipe = node.recipe,
      path = `nodes.${node.id}.recipe`;
    if (!recipe) continue;
    slot(recipe.generator, "material", `${path}.generator.material`);
    mesh(recipe.generator?.mesh, `${path}.generator.mesh`, true);
    recipe.steps?.forEach((step, i) =>
      slot(step, "material", `${path}.steps.${i}.material`),
    );
    slot(recipe.paint, "all", `${path}.paint.all`);
    for (const kind of ["faces", "rules"])
      recipe.paint?.[kind]?.forEach((entry, i) =>
        slot(entry, "material", `${path}.paint.${kind}.${i}.material`),
      );
  }
}

export function materialUsage(project) {
  const byId = new Map(
    project.materials.map((m) => [
      m.id,
      {
        ...m,
        users: new Set(),
        retainedBy: new Set(),
        referenceCount: 0,
      },
    ]),
  );
  visitMaterials(project, ({ material, node, retained }) => {
    const entry = byId.get(material);
    if (!entry) return;
    entry[retained ? "retainedBy" : "users"].add(node);
    entry.referenceCount++;
  });
  return [...byId.values()].map((m) => ({
    ...m,
    users: [...m.users],
    retainedBy: [...m.retainedBy],
    unused: m.referenceCount === 0,
  }));
}

export function validateMaterialReferences(project) {
  const ids = new Set(project.materials.map((m) => m.id));
  visitMaterials(project, ({ material, path }) => {
    if (!ids.has(material))
      throw new ModelError("Unknown material", "invalid", path);
  });
}

export function removeMaterial(project, { id, replacement }) {
  if (!project.materials.some((m) => m.id === id))
    throw new ModelError("Unknown material", "invalid", "id");
  if (
    replacement !== undefined &&
    (replacement === id || !project.materials.some((m) => m.id === replacement))
  )
    throw new ModelError(
      "Choose a different existing replacement material",
      "invalid",
      "replacement",
    );
  if (project.materials.length === 1)
    throw new ModelError("Keep at least one material", "invalid", "id");
  const references = [];
  visitMaterials(project, (ref) => {
    if (ref.material === id) references.push(ref);
  });
  if (references.length && replacement === undefined) {
    const error = new ModelError(
      "Material is still used by geometry or a recipe",
      "material_in_use",
      "id",
    );
    error.issues = references
      .slice(0, 10)
      .map(({ node, path, material }) => ({
        code: "material-reference",
        node,
        path,
        material,
      }));
    error.suggestion =
      "Provide replacement with another material ID, or use purgeMaterials to remove only unused materials.";
    throw error;
  }
  for (const { owner, key } of references) owner[key] = replacement;
  project.materials = project.materials.filter((m) => m.id !== id);
  return {
    removedMaterials: [id],
    ...(replacement === undefined ? {} : { replacement }),
    replacedReferences: references.length,
  };
}

export function purgeMaterials(project) {
  const usage = materialUsage(project),
    unused = usage.filter((m) => m.unused);
  // A model always has a default paint material, including an empty project.
  const removed = new Set(
    (unused.length === usage.length ? unused.slice(1) : unused).map(
      (m) => m.id,
    ),
  );
  project.materials = project.materials.filter((m) => !removed.has(m.id));
  return { removedMaterials: [...removed] };
}
