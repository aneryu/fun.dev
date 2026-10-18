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

// glTF metallic-roughness PBR plus the KHR emissive-strength and transmission extensions.
// Defaults are omitted, so older projects keep their exact JSON.
const COLOR = /^#[0-9a-f]{6}$/i;
const OPTIONAL = {
  metalness: [0, 0, 1],
  emissiveIntensity: [1, 0, 1000],
  opacity: [1, 0, 1],
  transmission: [0, 0, 1],
  ior: [1.5, 1, 3],
};
export const MATERIAL_FIELDS = [
  "name",
  "color",
  "roughness",
  "metalness",
  "emissive",
  "emissiveIntensity",
  "opacity",
  "transmission",
  "ior",
  "doubleSided",
];
export function normalizeMaterial(m, path = "material") {
  const bad = (message, field) => {
    throw new ModelError(message, "invalid", `${path}.${field}`);
  };
  if (!m || typeof m !== "object") bad("Expected a material", "id");
  if (typeof m.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(m.id))
    bad("Invalid ID", "id");
  if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 100)
    bad("Expected a name of 1–100 characters", "name");
  if (!COLOR.test(m.color ?? "")) bad("Expected a #rrggbb material color", "color");
  const number = (field, fallback, min, max) => {
    const value = m[field] ?? fallback;
    if (!Number.isFinite(value) || value < min || value > max)
      bad(`Expected ${field} from ${min} to ${max}`, field);
    return value;
  };
  const result = {
    id: m.id,
    name: m.name,
    color: m.color,
    roughness: number("roughness", 0.85, 0, 1),
  };
  for (const [field, [fallback, min, max]] of Object.entries(OPTIONAL)) {
    const value = number(field, fallback, min, max);
    if (value !== fallback) result[field] = value;
  }
  if (m.emissive != null) {
    if (!COLOR.test(m.emissive)) bad("Expected a #rrggbb emissive color", "emissive");
    if (m.emissive.toLowerCase() !== "#000000") result.emissive = m.emissive;
  }
  // Strength only means something on an emitting material.
  if (!result.emissive) delete result.emissiveIntensity;
  if (!result.transmission) delete result.ior;
  if (m.doubleSided !== undefined && typeof m.doubleSided !== "boolean")
    bad("Expected doubleSided true or false", "doubleSided");
  if (m.doubleSided) result.doubleSided = true;
  // Stable key order keeps documents and history comparisons deterministic.
  return Object.fromEntries(
    ["id", ...MATERIAL_FIELDS]
      .filter((k) => result[k] !== undefined)
      .map((k) => [k, result[k]]),
  );
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
