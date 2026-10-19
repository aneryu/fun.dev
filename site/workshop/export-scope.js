import {
  ModelError,
  validateProject,
  evaluateProject,
  evaluationIssues,
} from "./document.js";

export function exportScope(project, { ids } = {}) {
  project = evaluateProject(project);
  if (!ids) return project;
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => !nodes.has(id)))
    throw new ModelError("Unknown export roots");
  const included = new Set(),
    retained = new Set();
  for (const node of project.nodes) {
    let current = node;
    while (current) {
      if (ids.includes(current.id)) {
        included.add(node.id);
        break;
      }
      current = nodes.get(current.parent);
    }
  }
  for (const id of included) {
    let n = nodes.get(id);
    while (n) {
      retained.add(n.id);
      n = nodes.get(n.parent);
    }
  }
  return {
    ...project,
    assemblies: [],
    nodes: project.nodes
      .filter((n) => retained.has(n.id))
      .map((n) => {
        const node = structuredClone(n);
        // Export the evaluated geometry; dependencies outside this asset are not needed.
        delete node.generator;
        delete node.recipe;
        delete node.instanceOf;
        delete node.symmetry;
        if (!included.has(n.id)) node.mesh = null;
        return node;
      }),
  };
}
export function exportValidation(project, options = {}) {
  const scoped = exportScope(project, options),
    validation = validateProject(scoped);
  validation.errors.push(...evaluationIssues(project, scoped));
  validation.ok = validation.errors.length === 0;
  return {
    ...validation,
    scope: options.ids ?? "all",
  };
}
export function assertExportable(project, options = {}) {
  const validation = exportValidation(project, options);
  if (!validation.ok && !options.force) {
    const error = new ModelError(
      "Export blocked by geometry errors; inspect the report or explicitly use force",
      "export_validation",
    );
    error.issues = validation.errors;
    error.validation = validation;
    throw error;
  }
  return validation;
}
