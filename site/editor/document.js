import {
  ModelError,
  fail,
  vector,
  number,
  normal,
  triangulate,
  primitive,
  extrudeRegion,
  insetFace,
  bevelMesh,
  add,
  sub,
  dot,
  transformVector,
} from "./mesh.js";
import {
  identity,
  matrix,
  multiply,
  point,
  inverse,
  worldMatrix,
  setMatrix,
  bake,
  transformMesh,
  transformNodeMesh,
  boundsOf,
  nodeInfo,
  reflection,
} from "./spatial.js";
import { meshEdges, bevelEdges, cutPlane, loopCut } from "./topology.js";
import { surfaceDiagnostics } from "./diagnostics.js";
import { booleanMesh } from "./booleans.js";
import { arrayStep, stepMatrix, arrayMesh } from "./arrays.js";
import { blueprintCommands } from "./blueprints.js";
import {
  MESH_EDITS,
  DISTANCE_EDITS,
  editMesh,
  separateParts,
  joinParts,
} from "./edit-ops.js";
import {
  removeMaterial,
  purgeMaterials,
  validateMaterialReferences,
  normalizeMaterial,
  MATERIAL_FIELDS,
} from "./materials.js";
import {
  topologyToken,
  connectivityToken,
  resolveComponents,
  componentRef,
  queryComponents,
} from "./components.js";
import {
  normalizeRecipe,
  recipeValue,
  normalizeParameters,
  recipeMaterial,
  editRecipeStep,
  remapRecipeReferences,
} from "./recipe.js";
import {
  normalizeAssembly,
  normalizeAssemblies,
  rebuildAssemblies,
  assetFor,
  bindingFor,
  copyAssemblies,
  contains,
} from "./assembly.js";
export { ModelError } from "./mesh.js";
const diagnosticCache = new Map();
function surfaces(mesh) {
  const key = topologyToken(mesh);
  if (!diagnosticCache.has(key)) {
    diagnosticCache.set(key, surfaceDiagnostics(mesh));
    if (diagnosticCache.size > 64)
      diagnosticCache.delete(diagnosticCache.keys().next().value);
  }
  return copy(diagnosticCache.get(key));
}

export const FORMAT = "fun.dev/model",
  VERSION = 1;
export const LIMITS = {
  nodes: 512,
  materials: 32,
  vertices: 30000,
  triangles: 50000,
  bytes: 8 * 1024 * 1024,
};
const copy = (value) => structuredClone(value);
function affine(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 16 ||
    value.some((v) => !Number.isFinite(v) || Math.abs(v) > 10000) ||
    [3, 7, 11].some((i) => value[i] !== 0) ||
    value[15] !== 1
  )
    fail("Invalid affine basis");
  inverse(value);
  return [...value];
}
function label(value, path) {
  if (typeof value !== "string" || !value.trim() || value.length > 100)
    fail("Expected a name of 1–100 characters", path);
  return value;
}
function identifier(value, path) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value)
  )
    fail("Invalid ID", path);
  return value;
}
const unique = (values, path) => {
  if (new Set(values).size !== values.length) fail("Duplicate ID", path);
};
export function emptyProject(name = "Untitled") {
  return {
    format: FORMAT,
    version: VERSION,
    name,
    materials: [
      { id: "yellow", name: "Sun", color: "#ffd43b", roughness: 0.85 },
      { id: "orange", name: "Terracotta", color: "#f28c28", roughness: 0.85 },
      { id: "ink", name: "Ink", color: "#211f17", roughness: 0.8 },
      { id: "cream", name: "Cream", color: "#fff7d6", roughness: 0.9 },
      { id: "blue", name: "Water", color: "#4ba3c7", roughness: 0.9 },
    ],
    nodes: [],
  };
}

// Smooth shading of a part: the crease angle in degrees (edges sharper than it stay hard),
// true for 60°; false, 0 or nothing for flat faces.
export function smoothAngle(value, path = "smooth") {
  if (value === undefined || value === null || value === false || value === 0) return 0;
  if (value === true) return 60;
  return number(value, 0, 180, path);
}
export function normalizeProject(input) {
  if (!input || input.format !== FORMAT || input.version !== VERSION)
    fail("Unsupported project format/version", "version");
  if (new TextEncoder().encode(JSON.stringify(input)).length > LIMITS.bytes)
    fail("Project exceeds 8 MB");
  if (
    !Array.isArray(input.materials) ||
    !input.materials.length ||
    input.materials.length > LIMITS.materials
  )
    fail(`Expected 1–${LIMITS.materials} materials`);
  const materials = input.materials.map((m) => normalizeMaterial(m));
  unique(
    materials.map((m) => m.id),
    "materials",
  );
  const materialIds = new Set(materials.map((m) => m.id));
  if (!Array.isArray(input.nodes) || input.nodes.length > LIMITS.nodes)
    fail(`Expected at most ${LIMITS.nodes} nodes`);
  let vertexCount = 0,
    triangleCount = 0;
  const nodes = input.nodes.map((node) => {
    if (!node) fail("Invalid node");
    const result = {
      id: identifier(node.id, "node.id"),
      name: label(node.name, "node.name"),
      parent: node.parent == null ? null : identifier(node.parent, "parent"),
      position: vector(node.position ?? [0, 0, 0], "position"),
      rotation: vector(node.rotation ?? [0, 0, 0], "rotation"),
      scale: vector(node.scale ?? [1, 1, 1], "scale"),
      mesh: null,
    };
    const smooth = smoothAngle(node.smooth, `nodes.${node.id}.smooth`);
    if (smooth) result.smooth = smooth;
    if (result.scale.some((v) => v < 0.001 || v > 1000))
      fail(
        "Scale must be positive, from 0.001 to 1000; use mirror for reflection",
      );
    let sourceMesh = node.mesh;
    if (node.generator) {
      const g = node.generator;
      if (
        ![
          "box",
          "sphere",
          "cylinder",
          "cone",
          "lathe",
          "extrude",
          "revolve",
          "sweep",
          "torus",
          "capsule",
        ].includes(g.kind)
      )
        fail("Unknown generator kind");
      result.generator = {
        kind: g.kind,
        options: copy(g.options ?? {}),
        material: g.material ?? materials[0].id,
      };
      if (!materialIds.has(result.generator.material))
        fail("Unknown generator material");
      sourceMesh = primitive(
        g.kind,
        result.generator.options,
        result.generator.material,
      );
      if (g.basis) {
        if (
          !Array.isArray(g.basis) ||
          g.basis.length !== 16 ||
          g.basis.some((v) => !Number.isFinite(v) || Math.abs(v) > 10000) ||
          [3, 7, 11].some((i) => g.basis[i] !== 0) ||
          g.basis[15] !== 1
        )
          fail("Invalid generator basis");
        inverse(g.basis);
        result.generator.basis = [...g.basis];
        transformMesh(sourceMesh, g.basis);
      }
      const cachedFaces = node.mesh?.faces ?? [];
      if (!Array.isArray(cachedFaces))
        fail("Invalid cached generator faces", `nodes.${node.id}.mesh.faces`);
      const byId = new Map(cachedFaces.map((f) => [f?.id, f]));
      const colored = cachedFaces.filter(
        (f) => f?.material !== result.generator.material,
      );
      if (colored.length) {
        // Face IDs alone are not identity: a cap ID becomes a side after a
        // segmentation change. Reflection may reverse winding, but not membership.
        const cached = node.mesh,
          generated = sourceMesh;
        const indices = (face) =>
          [...face.vertices].sort((a, b) => a - b).join(",");
        if (
          !Array.isArray(cached.vertices) ||
          cached.vertices.length !== generated.vertices.length ||
          cached.faces.length !== generated.faces.length ||
          generated.faces.some((face) => {
            const old = byId.get(face.id);
            return (
              !old ||
              !Array.isArray(old.vertices) ||
              indices(old) !== indices(face)
            );
          })
        ) {
          const error = new ModelError(
            "Cached face colors no longer match the generator topology",
            "stale_component",
            `nodes.${node.id}.generator`,
          );
          error.node = node.id;
          error.issues = colored.map((f) => ({
            code: "paint-binding",
            node: node.id,
            face: f?.id,
            material: f?.material,
          }));
          error.suggestion =
            "Restore the original segmentation or load an unpainted copy, then bind colors with local selection rules.";
          throw error;
        }
      }
      for (const face of sourceMesh.faces)
        face.material = byId.get(face.id)?.material ?? face.material;
    }
    if (sourceMesh != null) {
      const { vertices, faces } = sourceMesh;
      if (
        !Array.isArray(vertices) ||
        vertices.length < 3 ||
        (vertexCount += vertices.length) > LIMITS.vertices
      )
        fail("Mesh vertex budget exceeded or empty mesh");
      if (
        !Array.isArray(faces) ||
        !faces.length ||
        faces.length > LIMITS.triangles
      )
        fail("Invalid mesh faces");
      const points = vertices.map((v) => vector(v, `${node.id}.vertex`));
      const polygons = faces.map((face) => {
        if (
          !face ||
          !Array.isArray(face.vertices) ||
          face.vertices.length < 3 ||
          face.vertices.length > 64
        )
          fail("Faces need 3–64 vertex indices");
        if (
          face.vertices.some(
            (i) => !Number.isInteger(i) || i < 0 || i >= points.length,
          ) ||
          new Set(face.vertices).size !== face.vertices.length
        )
          fail("Invalid face vertex index");
        if (!materialIds.has(face.material))
          fail(`Unknown material: ${face.material}`);
        triangleCount += triangulate(points, face.vertices).length;
        if (triangleCount > LIMITS.triangles) fail("Triangle budget exceeded");
        return {
          id: identifier(face.id, "face.id"),
          vertices: [...face.vertices],
          material: face.material,
        };
      });
      unique(
        polygons.map((f) => f.id),
        `${node.id}.faces`,
      );
      result.mesh = { vertices: points, faces: polygons };
    }
    if (node.recipe) {
      result.recipe = normalizeRecipe(node.recipe);
      if (result.mesh)
        result.recipe.generator.material = recipeMaterial(
          result.recipe,
          result.mesh,
        );
      if (result.recipe.basis)
        result.recipe.basis = affine(result.recipe.basis);
    } else if (
      result.generator &&
      !node.instanceOf &&
      !node.symmetry &&
      result.mesh.faces.some((f) => f.material !== result.generator.material)
    ) {
      // The first local paint uses the same guarded material layer as recipes.
      // This also upgrades older painted primitives when opening a project.
      result.recipe = recipeFor(result);
      delete result.generator;
    }
    if (node.symmetry) {
      const s = node.symmetry;
      if (!["x", "y", "z"].includes(s.axis)) fail("Invalid symmetry axis");
      result.symmetry = {
        source: identifier(s.source, "symmetry.source"),
        axis: s.axis,
        offset: number(s.offset ?? 0, -10000, 10000),
        reference:
          s.reference == null
            ? null
            : identifier(s.reference, "symmetry.reference"),
      };
      if (s.basis) result.symmetry.basis = affine(s.basis);
    }
    if (node.instanceOf)
      result.instanceOf = identifier(node.instanceOf, "instanceOf");
    if (node.instanceOf && node.instanceBasis)
      result.instanceBasis = affine(node.instanceBasis);
    return result;
  });
  unique(
    nodes.map((n) => n.id),
    "nodes",
  );
  let legacyAssembly = input.assembly;
  if (legacyAssembly && !input.assemblies && !legacyAssembly.root) {
    let root = nodes.find(
      (n) => n.id === legacyAssembly.bindings?.[0]?.id,
    )?.parent;
    while (
      root &&
      !legacyAssembly.bindings.every((b) => contains(nodes, root, b.id))
    )
      root = nodes.find((n) => n.id === root)?.parent;
    if (!root) {
      if (nodes.length >= LIMITS.nodes)
        fail("Legacy assembly needs a group root; node budget exceeded");
      root = "asset";
      let serial = 1;
      while (nodes.some((n) => n.id === root)) root = "asset-" + serial++;
      for (const n of nodes) if (n.parent === null) n.parent = root;
      nodes.push({
        id: root,
        name: "Asset",
        parent: null,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        mesh: null,
      });
    }
    legacyAssembly = { ...legacyAssembly, root };
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    const seen = new Set([node.id]);
    let id = node.parent;
    while (id !== null) {
      if (!byId.has(id)) fail(`Unknown parent: ${id}`);
      if (seen.has(id)) fail("Parent cycle");
      seen.add(id);
      id = byId.get(id).parent;
    }
    if (node.symmetry) {
      const s = node.symmetry;
      if (
        !byId.has(s.source) ||
        byId.get(s.source).symmetry ||
        s.source === node.id
      )
        fail("Symmetry needs an independent source");
      if (
        s.reference &&
        (!byId.has(s.reference) || byId.get(s.reference).symmetry)
      )
        fail("Invalid symmetry reference");
      if (node.generator) fail("A linked mirror cannot own a generator");
    }
    if (
      node.instanceOf &&
      (!byId.has(node.instanceOf) ||
        byId.get(node.instanceOf).instanceOf ||
        byId.get(node.instanceOf).symmetry ||
        node.instanceOf === node.id)
    )
      fail("Linked copies need an independent source");
  }
  const visiting = new Set(),
    visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) fail("Linked hierarchy dependency cycle");
    visiting.add(id);
    const n = byId.get(id);
    for (const dependency of [
      n.parent,
      n.instanceOf,
      n.symmetry?.source,
      n.symmetry?.reference,
    ].filter(Boolean))
      visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  nodes.forEach((n) => visit(n.id));
  validateMaterialReferences({ materials, nodes });
  return {
    format: FORMAT,
    version: VERSION,
    name: label(input.name, "name"),
    assemblies: normalizeAssemblies(
      input.assemblies ?? (legacyAssembly ? [legacyAssembly] : []),
      nodes,
    ),
    materials,
    nodes,
  };
}

export function statistics(project) {
  return project.nodes.reduce(
    (s, node) => {
      if (!node.mesh) return s;
      s.meshes++;
      s.vertices += node.mesh.vertices.length;
      s.faces += node.mesh.faces.length;
      s.triangles += node.mesh.faces.reduce(
        (n, f) => n + f.vertices.length - 2,
        0,
      );
      s.drawCalls += new Set(node.mesh.faces.map((f) => f.material)).size;
      return s;
    },
    {
      nodes: project.nodes.length,
      meshes: 0,
      vertices: 0,
      faces: 0,
      triangles: 0,
      drawCalls: 0,
    },
  );
}

export function evaluationIssues(input, project) {
  const issues = [];
  const equal = (a, b) => {
    if (typeof a === "number" && typeof b === "number")
      return Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
    if (a && b && typeof a === "object" && typeof b === "object") {
      const keys = Object.keys(a);
      return (
        keys.length === Object.keys(b).length &&
        keys.every((key) => equal(a[key], b[key]))
      );
    }
    return a === b;
  };
  for (const n of project.nodes) {
    const cached = input.nodes.find((v) => v.id === n.id);
    if (
      cached &&
      (!equal(cached.position ?? [0, 0, 0], n.position) ||
        !equal(cached.rotation ?? [0, 0, 0], n.rotation) ||
        !equal(cached.scale ?? [1, 1, 1], n.scale) ||
        (cached.mesh && n.mesh && !equal(cached.mesh, n.mesh)))
    )
      issues.push({
        code: "evaluation-mismatch",
        node: n.id,
        message:
          "Cached appearance differs from dependency evaluation; rebuild before delivery",
      });
  }
  return issues;
}

export function validateProject(input, budget = {}) {
  let project;
  try {
    project = evaluateProject(input);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          code: error.code ?? "invalid",
          message: error.message,
          path: error.path ?? "",
        },
      ],
      warnings: [],
    };
  }
  const stats = statistics(project),
    warnings = [];
  warnings.push(...evaluationIssues(input, project));
  for (const key of ["triangles", "drawCalls", "vertices"]) {
    if (budget[key] !== undefined) {
      number(budget[key], 0, 1000000, `budget.${key}`);
      if (stats[key] > budget[key])
        warnings.push({
          code: "budget",
          metric: key,
          actual: stats[key],
          limit: budget[key],
        });
    }
  }
  for (const node of project.nodes)
    if (node.mesh) {
      const { vertices, faces } = node.mesh,
        edges = new Map();
      for (const face of faces) {
        const n = normal(vertices, face.vertices),
          origin = vertices[face.vertices[0]];
        if (
          face.vertices.some(
            (i) => Math.abs(dot(sub(vertices[i], origin), n)) > 1e-5,
          )
        )
          warnings.push({ code: "nonplanar", node: node.id, face: face.id });
        face.vertices.forEach((a, i) => {
          const b = face.vertices[(i + 1) % face.vertices.length],
            key = [a, b].sort((x, y) => x - y).join(":");
          const edge = edges.get(key) ?? { count: 0, balance: 0 };
          edge.count++;
          edge.balance += a < b ? 1 : -1;
          edges.set(key, edge);
        });
      }
      const boundary = [...edges.values()].filter((e) => e.count === 1).length;
      const nonmanifold = [...edges.values()].filter(
        (e) => e.count > 2 || (e.count === 2 && e.balance !== 0),
      ).length;
      if (boundary)
        warnings.push({ code: "open-edges", node: node.id, count: boundary });
      if (nonmanifold)
        warnings.push({
          code: "nonmanifold",
          node: node.id,
          count: nonmanifold,
        });
    }
  const checks = {
    connectivity: true,
    selfIntersection: true,
    shellOrientation: true,
    evaluationConsistency: true,
    interObjectIntersections: false,
    minimumWallThickness: false,
  };
  for (const node of project.nodes.filter((n) => n.mesh)) {
    const result = surfaces(node.mesh);
    warnings.push(
      ...result.issues.map((issue) => ({ ...issue, node: node.id })),
    );
    if (!result.complete) checks.selfIntersection = false;
  }
  const errors = warnings.filter((w) =>
    ["self-intersection", "zero-volume", "evaluation-mismatch"].includes(
      w.code,
    ),
  );
  return {
    ok: errors.length === 0,
    errors,
    warnings: warnings.filter((w) => !errors.includes(w)),
    stats,
    checks,
  };
}

function descendants(project, id) {
  const ids = new Set([id]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of project.nodes)
      if (ids.has(n.parent) && !ids.has(n.id)) {
        ids.add(n.id);
        changed = true;
      }
  }
  return ids;
}
export function measure(project, id, options) {
  const ids = descendants(project, id),
    points = [];
  for (const node of project.nodes.filter((n) => ids.has(n.id) && n.mesh)) {
    const m = worldMatrix(project, node.id);
    points.push(...node.mesh.vertices.map((v) => point(m, v)));
  }
  const info = nodeInfo(project, id, options);
  return { ...info, bounds: points.length ? boundsOf(points) : info.bounds };
}
export function nodeSummary(node) {
  const { mesh, ...meta } = node;
  if (meta.recipe) {
    const { name, parameters, generator, steps, paint } = meta.recipe;
    meta.recipe = {
      name,
      parameters,
      generator:
        generator.kind === "mesh"
          ? {
              kind: "mesh",
              material: generator.material,
              vertices: generator.mesh.vertices.length,
              faces: generator.mesh.faces.length,
              topology: topologyToken(generator.mesh),
            }
          : generator,
      steps: steps.map((s, index) => ({
        index,
        op: s.op,
        label: s.label,
        enabled: s.enabled !== false,
      })),
      ...(paint
        ? {
            paint: {
              all: paint.all,
              rules: paint.rules,
              faceOverrides: paint.faces.length,
            },
          }
        : {}),
    };
  }
  return {
    ...meta,
    vertices: mesh?.vertices.length ?? 0,
    faces: mesh?.faces.length ?? 0,
  };
}
export function inspectNode(project, id, { detail = "summary" } = {}) {
  if (!["summary", "full"].includes(detail))
    fail("Expected summary or full inspection detail");
  const node = project.nodes.find((n) => n.id === id);
  if (!node) fail("Unknown node: " + id);
  const topology = topologyToken(node.mesh),
    full = detail === "full";
  const info = measure(project, id, { components: full });
  return {
    node: full ? node : nodeSummary(node),
    topology,
    ...info,
    ...(full
      ? {
          edges: node.mesh
            ? meshEdges(node.mesh).map((e) => ({
                ...e,
                ref: componentRef(node, "edges", e.id, topology),
              }))
            : [],
          faces: info.faces.map((f) => ({
            ...f,
            ref: componentRef(node, "faces", f.id, topology),
          })),
        }
      : {}),
  };
}
const hasExpression = (value) =>
  value &&
  typeof value === "object" &&
  (value.$param ||
    value.$expr ||
    value.$anchor ||
    Object.values(value).some(hasExpression));
export function shapeGenerator(node) {
  const generator =
    node?.generator ??
    (node?.recipe && !hasExpression(node.recipe.generator.options)
      ? node.recipe.generator
      : null);
  return generator?.kind === "mesh" ? null : generator;
}
function recipeFor(node) {
  if (node?.recipe) return copy(node.recipe);
  if (!node?.mesh || node.instanceOf || node.symmetry)
    fail("This node has no editable mesh; unlink copies before editing");
  if (!node.generator)
    return normalizeRecipe({
      parameters: {},
      generator: { kind: "mesh", mesh: copy(node.mesh) },
      steps: [],
    });
  const { basis, ...generator } = copy(node.generator);
  const faces = node.mesh.faces
    .filter((f) => f.material !== generator.material)
    .map((f) => ({
      id: f.id,
      vertices: [...f.vertices],
      material: f.material,
    }));
  return normalizeRecipe({
    parameters: {},
    generator,
    steps: [],
    ...(basis ? { basis } : {}),
    ...(faces.length
      ? { paint: { faces, layout: connectivityToken(node.mesh) } }
      : {}),
  });
}
export function getRecipe(project, { id, index } = {}) {
  const node = project.nodes.find((n) => n.id === id);
  const recipe = recipeFor(node);
  if (index === undefined)
    return { node: id, recipe, ...(!node.recipe ? { implicit: true } : {}) };
  if (!Number.isInteger(index) || !recipe.steps[index])
    fail("Recipe step index is out of range");
  return {
    node: id,
    index,
    step: recipe.steps[index],
    evaluated: recipeValue(recipe.steps[index], recipe.parameters),
    parameters: recipe.parameters,
    basis: recipe.basis,
  };
}
// The input geometry for a step is independent of later steps and affine bakes.
// Keep it in recipe coordinates for selection; only the preview receives the bake.
export function recipeInput(project, id, index) {
  const source = project.nodes.find((n) => n.id === id),
    recipe = recipeFor(source);
  if (!Number.isInteger(index) || index < 0 || index > recipe.steps.length)
    fail("Invalid recipe input stage");
  recipe.generator.material = recipeMaterial(recipe, source.mesh);
  recipe.steps = recipe.steps.slice(0, index);
  delete recipe.basis;
  delete recipe.paint;
  const input = {
    ...emptyProject(),
    materials: copy(project.materials),
    nodes: [],
  };
  return evaluateCommands(input, [
    { op: "create", id, kind: "box" },
    { op: "recipe", id, definition: recipe },
  ]);
}
function recipePreview(project, id, input) {
  const preview = copy(project),
    node = preview.nodes.find((n) => n.id === id);
  node.mesh = copy(input.nodes[0].mesh);
  const basis = recipeFor(node).basis;
  if (basis) transformMesh(node.mesh, basis);
  return preview;
}
export function inspectRecipeStage(project, { id, index, query = {} }) {
  const input = recipeInput(project, id, index),
    recipe = recipeFor(project.nodes.find((n) => n.id === id)),
    components = queryComponents(input, { ...query, id, space: "local" }),
    kind = components.kind,
    selection = {
      id,
      ids: [id],
      mode: { faces: "face", edges: "edge", vertices: "vertex" }[kind],
      faces: [],
      edges: [],
      vertices: [],
      [kind]: components.items.map((c) => c.id),
    };
  return {
    id,
    index,
    coordinateSpace: "recipe",
    step: copy(recipe.steps[index] ?? null),
    evaluated: recipe.steps[index]
      ? recipeValue(recipe.steps[index], recipe.parameters)
      : null,
    input: inspectNode(input, id),
    components,
    placement: {
      worldMatrix: worldMatrix(project, id),
      basis: copy(recipe.basis ?? identity()),
    },
    project: recipePreview(project, id, input),
    selection,
  };
}
export function recipeSelection(project, id, index, step) {
  const input = recipeInput(project, id, index),
    source = project.nodes.find((n) => n.id === id);
  const resolved = resolveComponents(input, {
    ...recipeValue(step, recipeFor(source).parameters),
    id,
    space: "local",
  });
  const selection = {
    id,
    ids: [id],
    mode: "object",
    faces: [],
    edges: [],
    vertices: [],
  };
  for (const kind of ["faces", "edges", "vertices"]) {
    const singular = kind === "faces" ? "face" : "edge";
    if (
      resolved[kind] ||
      (kind !== "vertices" && resolved[singular] !== undefined)
    ) {
      selection[kind] = resolved[kind] ?? [resolved[singular]];
      selection.mode = { faces: "face", edges: "edge", vertices: "vertex" }[
        kind
      ];
      break;
    }
  }
  if (selection.mode !== "object")
    selectionVertices(input.nodes[0], {
      [{ face: "faces", edge: "edges", vertex: "vertices" }[selection.mode]]:
        selection[
          { face: "faces", edge: "edges", vertex: "vertices" }[selection.mode]
        ],
    });
  const preview = recipePreview(project, id, input),
    node = preview.nodes.find((n) => n.id === id);
  return {
    project: preview,
    selection,
    count:
      selection.mode === "object"
        ? node.mesh.faces.length
        : selection[
            { face: "faces", edge: "edges", vertex: "vertices" }[selection.mode]
          ].length,
    evaluated: recipeValue(step, source.recipe.parameters),
  };
}
export function selectionVertices(node, command) {
  if (!node.mesh) fail("Select a mesh");
  const indices =
    command.vertices ??
    (command.edges
      ? command.edges.flatMap((id) => {
          const edge = meshEdges(node.mesh).find((e) => e.id === id);
          if (!edge) fail("Unknown selected edge");
          return edge.vertices;
        })
      : command.faces
        ? command.faces.flatMap((id) => {
            const f = node.mesh.faces.find((f) => f.id === id);
            if (!f) fail("Unknown selected face");
            return f.vertices;
          })
        : node.mesh.vertices.map((_, i) => i));
  if (
    !indices.length ||
    indices.some((i) => !Number.isInteger(i) || !node.mesh.vertices[i])
  )
    fail("Unknown selected vertex");
  return [...new Set(indices)];
}
// New IDs for a copied hierarchy: the root takes newId; descendants take an explicit
// idMap entry, a last-occurrence replacement (e.g. ["_l", "_r"]), or newId-<n>.
function copyIds(project, ids, command) {
  const map = new Map();
  if (command.replace !== undefined) {
    const [from, to] = command.replace ?? [];
    if (typeof from !== "string" || !from || typeof to !== "string")
      fail("replace needs [from, to] strings", "replace");
  }
  for (const key of Object.keys(command.idMap ?? {}))
    if (key === ids[0] || !ids.includes(key))
      fail(`idMap: ${key} is not a copied descendant`, "idMap");
  ids.forEach((id, i) => {
    let next = command.newId;
    if (i) {
      next = command.idMap?.[id];
      if (next === undefined && command.replace) {
        const [from, to] = command.replace,
          at = id.lastIndexOf(from);
        if (at < 0)
          fail(`replace: ${id} does not contain "${from}"`, "replace");
        next = id.slice(0, at) + to + id.slice(at + from.length);
      }
      next ??= `${command.newId}-${i}`;
    }
    map.set(id, identifier(next, "newId"));
  });
  const values = [...map.values()],
    taken = new Set(project.nodes.map((n) => n.id));
  if (new Set(values).size !== values.length)
    fail("Copied IDs collide; adjust newId, idMap or replace", "idMap");
  for (const value of values)
    if (taken.has(value)) fail(`ID already exists: ${value}`, "newId");
  return map;
}
function rootIds(project, ids) {
  if (!ids?.length || ids.some((id) => !project.nodes.some((n) => n.id === id)))
    fail("Unknown selected part");
  return [...new Set(ids)].filter(
    (id) =>
      !ids.some((other) => other !== id && descendants(project, other).has(id)),
  );
}
function worldTransform(project, ids, m) {
  for (const id of rootIds(project, ids)) {
    const node = project.nodes.find((n) => n.id === id);
    if (node.symmetry) {
      const roots = rootIds(project, ids),
        sourceSelected = roots.some((root) =>
          descendants(project, root).has(node.symmetry.source),
        );
      if (!sourceSelected)
        fail(
          "Select the mirror source too, or group the pair to move it together",
        );
      const s = node.symmetry,
        reference = multiply(
          worldMatrix(project, s.reference),
          s.basis ?? identity(),
        ),
        plane = multiply(
          reference,
          multiply(reflection(s.axis, s.offset), inverse(reference)),
        );
      if (!roots.some((root) => descendants(project, root).has(s.reference))) {
        const a = multiply(plane, m),
          b = multiply(m, plane);
        if (a.some((v, i) => Math.abs(v - b[i]) > 1e-6))
          fail(
            "This transform moves across the mirror plane. Group the pair first",
          );
      }
      continue;
    }
    const local = multiply(
      inverse(worldMatrix(project, node.parent)),
      multiply(m, worldMatrix(project, id)),
    );
    setMatrix(project, node, local);
  }
}
function selectionTransform(project, command) {
  const ids = command.ids ?? [command.id],
    node = project.nodes.find((n) => n.id === ids.at(-1));
  if (!node) fail("Unknown selected part");
  const components = command.vertices || command.faces || command.edges,
    indices = components ? selectionVertices(node, command) : null;
  const world = worldMatrix(project, node.id),
    points = components
      ? indices.map((i) => point(world, node.mesh.vertices[i]))
      : ids.flatMap((id) => {
          const b = measure(project, id).bounds;
          return [b.min, b.max];
        });
  const frame = command.space === "local" ? world : identity(),
    center = command.pivot ?? point(inverse(frame), boundsOf(points).center);
  const delta = matrix({
    position: vector(command.translation ?? [0, 0, 0]),
    rotation: vector(command.rotation ?? [0, 0, 0]),
    scale: vector(command.scale ?? [1, 1, 1]),
  });
  if ((command.scale ?? [1, 1, 1]).some((v) => v <= 0))
    fail("Selection scale must be positive");
  const before = identity(),
    after = identity();
  before.splice(12, 3, ...center.map((v) => -v));
  after.splice(12, 3, ...center);
  let m = multiply(
    frame,
    multiply(after, multiply(delta, multiply(before, inverse(frame)))),
  );
  if (command.matrix) {
    if (
      !Array.isArray(command.matrix) ||
      command.matrix.length !== 16 ||
      command.matrix.some((v) => !Number.isFinite(v)) ||
      [3, 7, 11].some((i) => command.matrix[i] !== 0) ||
      command.matrix[15] !== 1
    )
      fail("Invalid affine transform");
    inverse(command.matrix);
    m = command.matrix;
  }
  if (components) {
    if (node.symmetry || node.instanceOf)
      fail("Edit the source or unlink this part before editing geometry");
    delete node.generator;
    delete node.recipe;
    const local = multiply(inverse(world), multiply(m, world));
    for (const i of indices)
      node.mesh.vertices[i] = point(local, node.mesh.vertices[i]);
  } else worldTransform(project, ids, m);
}
function synchronize(project) {
  for (const node of project.nodes.filter((n) => n.instanceOf)) {
    const source = project.nodes.find((n) => n.id === node.instanceOf);
    node.mesh = copy(source.mesh);
    if (node.mesh && node.instanceBasis)
      transformMesh(node.mesh, node.instanceBasis);
    delete node.generator;
    delete node.recipe;
    // Linked copies share the source's look: its smoothing too.
    if (source.smooth) node.smooth = source.smooth;
    else delete node.smooth;
  }
  const pending = project.nodes.filter((n) => n.symmetry),
    done = new Set();
  while (done.size < pending.length) {
    let progress = false;
    for (const node of pending)
      if (
        !done.has(node.id) &&
        (!pending.some((n) => n.id === node.parent) || done.has(node.parent))
      ) {
        const s = node.symmetry,
          source = project.nodes.find((n) => n.id === s.source);
        if (!source) fail("Missing symmetry source");
        node.mesh = copy(source.mesh);
        delete node.generator;
        delete node.recipe;
        if (source.smooth) node.smooth = source.smooth;
        else delete node.smooth;
        const flip = reflection(s.axis),
          reference = multiply(
            worldMatrix(project, s.reference),
            s.basis ?? identity(),
          ),
          plane = multiply(
            reference,
            multiply(reflection(s.axis, s.offset), inverse(reference)),
          );
        if (node.mesh) transformMesh(node.mesh, flip);
        setMatrix(
          project,
          node,
          multiply(
            inverse(worldMatrix(project, node.parent)),
            multiply(plane, multiply(worldMatrix(project, source.id), flip)),
          ),
        );
        done.add(node.id);
        progress = true;
      }
    if (!progress) fail("Symmetry hierarchy cycle");
  }
}
function preservePortValues(project, binding) {
  const child = project.assemblies.find((a) => a.root === binding.id);
  if (binding.assetValues && child?.source)
    for (const key of Object.keys(binding.assetValues))
      (child.overrides ??= {})[key] = child.parameters[key].value;
}
function selectionSummary(project, command) {
  const node = project.nodes.find((n) => n.id === command.id);
  if (!node?.mesh) return null;
  for (const [kind, fields] of [
    ["faces", ["faces", "face"]],
    ["edges", ["edges", "edge"]],
    ["vertices", ["vertices"]],
  ])
    for (const field of fields)
      if (command[field] !== undefined)
        return {
          scope: "components",
          kind,
          count: Array.isArray(command[field]) ? command[field].length : 1,
        };
  return [
    "bevel",
    "paint",
    "mirror",
    "cut",
    "dissolve",
    "weld",
    "fill",
    "solidify",
  ].includes(command.op)
    ? { scope: "mesh", kind: "faces", count: node.mesh.faces.length }
    : null;
}
function run(project, command) {
  if (
    ["assembly", "assemblyParameters", "detachBinding"].includes(command.op)
  ) {
    project.assemblies ??= [];
    if (command.op === "assembly" && command.definition !== null) {
      const a = normalizeAssembly(
        {
          ...command.definition,
          ...(command.root ? { root: command.root } : {}),
        },
        project.nodes,
      );
      project.assemblies = [
        ...project.assemblies.filter((v) => v.root !== a.root),
        a,
      ];
      return;
    }
    const a = command.root
      ? project.assemblies.find((v) => v.root === command.root)
      : command.op === "detachBinding"
        ? project.assemblies.find((a) =>
            a.bindings.some((b) => b.id === command.id),
          )
        : project.assemblies.length === 1
          ? project.assemblies[0]
          : null;
    if (!a)
      throw new ModelError(
        "Specify an existing asset root",
        "dependency",
        "root",
      );
    if (command.op === "assembly") {
      for (const b of a.bindings) preservePortValues(project, b);
      project.assemblies = project.assemblies.filter((v) => v !== a);
      for (const linked of project.assemblies)
        if (linked.source === a.root) {
          delete linked.source;
          delete linked.overrides;
        }
    } else if (command.op === "detachBinding") {
      const binding = a.bindings.find((b) => b.id === command.id);
      if (!binding) fail("No binding for this part");
      if (command.mode && !["keep", "inherit"].includes(command.mode))
        fail("Expected keep or inherit detach mode");
      if (
        command.mode === "inherit" &&
        command.fields &&
        !command.fields.includes("assetValues")
      )
        fail("Restore inheritance requires detaching assetValues");
      if (!command.fields || command.fields.includes("assetValues")) {
        if (command.mode === "inherit") {
          const child = project.assemblies.find((v) => v.root === binding.id);
          if (!binding.assetValues || !child?.source)
            fail(
              "Restore inheritance requires a linked child parameter binding",
            );
          for (const key of Object.keys(binding.assetValues))
            delete child.overrides?.[key];
        } else preservePortValues(project, binding);
      }
      if (command.fields) {
        if (
          !Array.isArray(command.fields) ||
          !command.fields.length ||
          command.fields.some(
            (k) =>
              ![
                "position",
                "rotation",
                "options",
                "recipeValues",
                "assetValues",
              ].includes(k) || !binding[k],
          )
        )
          fail("Specify existing driven fields to detach");
        for (const key of command.fields) delete binding[key];
      } else
        for (const key of Object.keys(binding))
          if (key !== "id") delete binding[key];
      a.bindings = a.bindings.filter((b) => Object.keys(b).length > 1);
    } else {
      if (a.source && !command.override && !command.resetOverrides?.length)
        throw new ModelError(
          "Edit the source asset or make its parameters independent",
          "dependency",
          a.source,
        );
      for (const [key, value] of Object.entries(command.values)) {
        const p = a.parameters[key];
        if (!p || p.expression)
          fail("Unknown or derived assembly parameter: " + key);
        if (
          project.assemblies.some((owner) =>
            owner.bindings.some(
              (b) => b.id === a.root && Object.hasOwn(b.assetValues ?? {}, key),
            ),
          )
        )
          throw new ModelError(
            "Parameter is driven by a parent asset port: " + key,
            "dependency",
          );
        if (a.source) {
          if (!command.override)
            fail("Use override to edit instance parameters");
          (a.overrides ??= {})[key] = value;
        } else {
          if (command.override) fail("Overrides need a linked asset");
          p.value = value;
        }
      }
      for (const key of command.resetOverrides ?? []) {
        if (!a.source || !a.parameters[key])
          fail("Unknown shared parameter: " + key);
        delete a.overrides?.[key];
      }
      a.parameters = normalizeParameters(a.parameters);
    }
    return;
  }
  if (!command || typeof command.op !== "string")
    fail("Expected a command with op");
  if (command.op === "renameProject") {
    project.name = command.name;
    return;
  }
  if (command.op === "material") {
    const old = project.materials.find((m) => m.id === command.id);
    if (old) {
      // null removes an optional property (emission, glass, metalness…).
      const next = { ...old };
      for (const key of MATERIAL_FIELDS)
        if (command[key] === null) {
          if (["name", "color", "roughness"].includes(key))
            fail(`${key} cannot be removed`, key);
          delete next[key];
        } else if (command[key] !== undefined) next[key] = command[key];
      project.materials[project.materials.indexOf(old)] =
        normalizeMaterial(next);
    } else {
      if (project.materials.length >= LIMITS.materials) {
        const error = new ModelError(
          "Material limit reached (32)",
          "material_limit",
          "materials",
        );
        error.suggestion =
          "Use purgeMaterials to remove unused materials, or removeMaterial with a replacement to consolidate existing materials.";
        throw error;
      }
      const fields = Object.fromEntries(
        MATERIAL_FIELDS.filter((k) => command[k] != null).map((k) => [
          k,
          command[k],
        ]),
      );
      project.materials.push(
        normalizeMaterial({ name: command.id, ...fields, id: command.id }),
      );
    }
    return;
  }
  if (command.op === "removeMaterial") return removeMaterial(project, command);
  if (command.op === "purgeMaterials") return purgeMaterials(project);
  if (command.op === "create") {
    const {
      id,
      name = id,
      parent = null,
      position = [0, 0, 0],
      rotation = [0, 0, 0],
      scale = [1, 1, 1],
      kind = "box",
      material = project.materials[0].id,
      options = {},
    } = command;
    project.nodes.push({
      id,
      name,
      parent,
      position,
      rotation,
      scale,
      mesh:
        kind === "group"
          ? null
          : kind === "mesh"
            ? copy(command.mesh)
            : primitive(kind, options, material),
      ...(!["group", "mesh"].includes(kind)
        ? { generator: { kind, options: copy(options), material } }
        : {}),
      ...(smoothAngle(command.smooth) && kind !== "group"
        ? { smooth: smoothAngle(command.smooth) }
        : {}),
    });
    return;
  }
  if (command.op === "group") {
    identifier(command.newId, "newId");
    const ids = rootIds(project, command.ids),
      contained = new Set(ids.flatMap((id) => [...descendants(project, id)]));
    for (const n of project.nodes.filter(
      (n) => contained.has(n.id) && n.symmetry,
    ))
      if (!contained.has(n.symmetry.source))
        fail("Group the mirrored part together with its source");
    const planeFrames = new Map(
      project.nodes
        .filter(
          (n) =>
            contained.has(n.id) &&
            n.symmetry &&
            !contained.has(n.symmetry.reference),
        )
        .map((n) => [
          n.id,
          multiply(
            worldMatrix(project, n.symmetry.reference),
            n.symmetry.basis ?? identity(),
          ),
        ]),
    );
    const worlds = new Map(ids.map((id) => [id, worldMatrix(project, id)]));
    const center = boundsOf(
      ids.flatMap((id) => {
        const b = measure(project, id).bounds;
        return [b.min, b.max];
      }),
    ).center;
    project.nodes.push({
      id: command.newId,
      name: command.name ?? "Group",
      parent: null,
      position: center,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      mesh: null,
    });
    for (const id of ids) {
      const n = project.nodes.find((n) => n.id === id);
      n.parent = command.newId;
      setMatrix(
        project,
        n,
        multiply(inverse(worldMatrix(project, command.newId)), worlds.get(id)),
      );
    }
    for (const [id, frame] of planeFrames) {
      const n = project.nodes.find((n) => n.id === id);
      n.symmetry.reference = command.newId;
      n.symmetry.basis = multiply(
        inverse(worldMatrix(project, command.newId)),
        frame,
      );
    }
    return;
  }
  if (command.op === "transform") {
    selectionTransform(project, command);
    return;
  }
  if (command.op === "align" || command.op === "ground") {
    const ids = rootIds(project, command.ids ?? [command.id]),
      axis =
        command.op === "ground"
          ? 1
          : ["x", "y", "z"].indexOf(command.axis ?? "x");
    if (axis < 0) fail("Expected x, y or z axis");
    const mode = command.mode ?? "center";
    if (!["min", "center", "max"].includes(mode))
      fail("Unknown alignment mode");
    const value =
      command.op === "ground"
        ? 0
        : measure(project, command.reference ?? ids.at(-1)).bounds[mode][axis];
    for (const id of ids) {
      const m = identity();
      m[12 + axis] =
        value -
        measure(project, id).bounds[command.op === "ground" ? "min" : mode][
          axis
        ];
      worldTransform(project, [id], m);
    }
    return;
  }
  const node = project.nodes.find((n) => n.id === command.id);
  if (!node) fail(`Unknown node: ${command.id}`);
  if (
    node.instanceOf &&
    [
      "recipe",
      "recipeParameters",
      "recipeStep",
      "recipePaint",
      "parameters",
      "convert",
      "vertices",
      "extrude",
      "inset",
      "bevel",
      "cut",
      "loopCut",
      "paint",
      "mirror",
      "pivot",
      "applyScale",
      "boolean",
      ...MESH_EDITS,
      "separate",
      "join",
    ].includes(command.op)
  )
    fail("Edit the source or unlink this copy first");
  if (
    node.symmetry &&
    !["unlink", "delete", "duplicate", "rename"].includes(command.op)
  )
    fail("Unlink the mirrored part before editing it");
  switch (command.op) {
    case "rename": {
      // A node ID is its glTF name: games find wheels, doors and lights by it.
      const from = node.id,
        to = identifier(command.newId, "newId");
      if (to === from) fail("newId equals the current ID", "newId");
      if (project.nodes.some((n) => n.id === to))
        fail(`ID already exists: ${to}`, "newId");
      for (const n of project.nodes) {
        if (n.id === from) n.id = to;
        if (n.parent === from) n.parent = to;
        if (n.instanceOf === from) n.instanceOf = to;
        if (n.symmetry?.source === from) n.symmetry.source = to;
        if (n.symmetry?.reference === from) n.symmetry.reference = to;
      }
      remapRecipeReferences(node.recipe, from, to);
      const remap = (value) =>
        Array.isArray(value)
          ? value.map(remap)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([k, v]) => [
                  k,
                  ["id", "root", "node", "source"].includes(k) && v === from
                    ? to
                    : remap(v),
                ]),
              )
            : value;
      project.assemblies = remap(project.assemblies ?? []);
      return { idMap: { [from]: to } };
    }
    case "recipe":
    case "recipeParameters":
    case "recipeStep": {
      if (!node.mesh) fail("Recipe needs a mesh");
      const originalRecipe =
        !node.recipe && node.generator ? recipeFor(node) : null;
      const recipe = normalizeRecipe(
        command.op === "recipe"
          ? command.definition
          : command.op === "recipeStep"
            ? editRecipeStep(recipeFor(node), command)
            : node.recipe,
      );
      for (const [key, value] of Object.entries(command.values ?? {})) {
        if (!recipe.parameters[key]) fail(`Unknown recipe parameter: ${key}`);
        if (recipe.parameters[key].expression)
          fail("Derived parameters are read-only: " + key);
        recipe.parameters[key].value = value;
      }
      recipe.parameters = normalizeRecipe(recipe).parameters;
      const material = (recipe.generator.material = recipeMaterial(
        recipe,
        node.mesh,
      ));
      const temp = {
        ...emptyProject(),
        materials: copy(project.materials),
        nodes: [],
      };
      const activeSteps = recipe.steps
        .map((step, index) => ({ step, index }))
        .filter(({ step }) => step.enabled !== false);
      const commands = [
        {
          op: "create",
          id: node.id,
          kind: recipe.generator.kind,
          material,
          ...(recipe.generator.kind === "mesh"
            ? { mesh: copy(recipe.generator.mesh) }
            : {}),
          options: recipeValue(
            recipe.generator.options ?? {},
            recipe.parameters,
          ),
        },
        ...activeSteps.map(({ step: { enabled, label, ...step } }) => ({
          ...recipeValue(step, recipe.parameters),
          // A recipe transforms geometry, never a disposable temporary object.
          ...(step.op === "transform" &&
          !["select", "faces", "edges", "vertices"].some(
            (k) => step[k] !== undefined,
          )
            ? {
                select: {
                  kind: "vertices",
                  space: "local",
                  limit: LIMITS.vertices,
                },
              }
            : {}),
          id: node.id,
          space: "local",
        })),
      ];
      let built;
      try {
        built = evaluateCommands(temp, commands);
      } catch (error) {
        error.recipeStepIndex = activeSteps[error.commandIndex - 1]?.index;
        error.recipeOperation = error.operation;
        error.recipeArguments = commands[error.commandIndex];
        error.recipeParameters = Object.fromEntries(
          Object.entries(recipe.parameters).map(([key, p]) => [key, p.value]),
        );
        if (error.code === "stale_component")
          error.suggestion = `Query recipeStage({id:${JSON.stringify(node.id)},index:${error.recipeStepIndex}}) for this step's input references. Use semantic selectors for steps that must follow parameter changes.`;
        error.path = `nodes.${node.id}.recipe.${error.recipeStepIndex === undefined ? "generator" : "steps." + error.recipeStepIndex}`;
        delete error.commandIndex;
        delete error.operation;
        throw error;
      }
      node.mesh = built.nodes[0].mesh;
      if (recipe.basis) transformMesh(node.mesh, recipe.basis);
      if (recipe.paint?.all)
        for (const face of node.mesh.faces) face.material = recipe.paint.all;
      for (const rule of recipe.paint?.rules ?? []) {
        const selected = new Set(
          queryComponents(
            project,
            {
              ...rule.select,
              id: node.id,
              kind: "faces",
              space: "local",
            },
            { complete: true },
          ).items.map((f) => f.id),
        );
        for (const face of node.mesh.faces)
          if (selected.has(face.id)) face.material = rule.material;
      }
      if (
        recipe.paint?.faces.length &&
        recipe.paint.layout &&
        recipe.paint.layout !== connectivityToken(node.mesh)
      ) {
        const error = new ModelError(
          "Paint bindings need remapping after a topology change",
          "stale_component",
          "recipe.paint",
        );
        error.issues = recipe.paint.faces.map((f) => ({
          code: "paint-binding",
          node: node.id,
          face: f.id,
          material: f.material,
        }));
        error.node = node.id;
        error.recovery = {
          commands: [
            ...(originalRecipe
              ? [{ op: "recipe", id: node.id, definition: originalRecipe }]
              : []),
            { op: "recipePaint", id: node.id, mode: "clear" },
          ],
          retry: command,
          alternatives: ["semantic rules", "convert to mesh"],
        };
        error.suggestion =
          "Replace face overrides with local selection rules, or clear them and retry in one batch.";
        throw error;
      }

      for (const binding of recipe.paint?.faces ?? []) {
        const face = node.mesh.faces.find((f) => f.id === binding.id);
        if (
          !face ||
          JSON.stringify(face.vertices) !== JSON.stringify(binding.vertices)
        )
          throw new ModelError(
            "Painted face changed topology; update its material binding or bake the recipe",
            "stale_component",
            `recipe.paint.${binding.id}`,
          );
        face.material = binding.material;
      }
      delete node.generator;
      node.recipe = recipe;
      break;
    }
    case "set": {
      if (command.parent !== undefined && command.parent !== node.parent) {
        if (descendants(project, node.id).has(command.parent))
          fail("Parent cycle");
        const old = worldMatrix(project, node.id);
        node.parent = command.parent;
        if (command.keepWorld !== false)
          setMatrix(
            project,
            node,
            multiply(inverse(worldMatrix(project, node.parent)), old),
          );
      }
      for (const key of ["name", "position", "rotation", "scale"])
        if (command[key] !== undefined) node[key] = copy(command[key]);
      if (command.smooth !== undefined) {
        const angle = smoothAngle(command.smooth);
        if (angle) node.smooth = angle;
        else delete node.smooth;
      }
      break;
    }
    case "delete": {
      const ids = descendants(project, node.id);
      for (const n of project.nodes)
        if (n.instanceOf && ids.has(n.instanceOf)) delete n.instanceOf;
      for (const n of project.nodes)
        if (n.symmetry && ids.has(n.symmetry.source))
          for (const id of descendants(project, n.id)) ids.add(id);
      project.assemblies = (project.assemblies ?? []).filter(
        (a) => !ids.has(a.root),
      );
      for (const a of project.assemblies) {
        if (ids.has(a.source)) {
          delete a.source;
          delete a.overrides;
        }
        a.bindings = a.bindings.filter((b) => !ids.has(b.id));
        const referencesDeleted = (v) =>
          v &&
          typeof v === "object" &&
          (ids.has(v.$anchor?.node) ||
            Object.values(v).some(referencesDeleted));
        if (a.bindings.some(referencesDeleted))
          throw new ModelError(
            "This part is an assembly anchor; detach its dependent bindings first",
            "dependency",
            "assemblies." + a.root,
          );
      }
      project.nodes = project.nodes.filter((n) => !ids.has(n.id));
      break;
    }
    case "duplicate": {
      identifier(command.newId, "newId");
      const ids = descendants(project, node.id),
        map = copyIds(project, [...ids], command);
      const clones = project.nodes
        .filter((n) => ids.has(n.id))
        .map((n) => {
          const clone = {
            ...copy(n),
            id: map.get(n.id),
            parent: map.get(n.parent) ?? n.parent,
          };
          remapRecipeReferences(clone.recipe, n.id, clone.id);
          return clone;
        });
      const root = clones.find((n) => n.id === command.newId);
      const hasAsset = project.assemblies?.some((a) => map.has(a.root));
      const assetMode =
        command.assetMode ?? (command.linked ? "linked" : "independent");
      if (!["independent", "linked", "static"].includes(assetMode))
        fail("Unknown asset copy mode");
      clones.forEach((n) => {
        if (hasAsset && n.instanceOf && map.has(n.instanceOf))
          n.instanceOf = map.get(n.instanceOf);
        else {
          delete n.instanceOf;
          delete n.instanceBasis;
        }
        if (hasAsset && n.symmetry && map.has(n.symmetry.source)) {
          n.symmetry.source = map.get(n.symmetry.source);
          n.symmetry.reference =
            map.get(n.symmetry.reference) ?? n.symmetry.reference;
        } else delete n.symmetry;
        if (hasAsset && assetMode === "static") {
          delete n.generator;
          delete n.recipe;
          delete n.instanceOf;
          delete n.instanceBasis;
          delete n.symmetry;
        }
      });
      if (command.linked && !hasAsset)
        for (const n of clones) {
          const source = project.nodes.find((s) => map.get(s.id) === n.id);
          n.instanceOf = source.instanceOf ?? source.id;
          delete n.generator;
        }
      root.name = command.name ?? `${node.name} copy`;
      root.position = add(root.position, vector(command.offset ?? [0.2, 0, 0]));
      project.nodes.push(...clones);
      if (hasAsset) copyAssemblies(project, map, assetMode);
      return { idMap: Object.fromEntries(map) };
    }
    case "pivot": {
      const delta = vector(command.offset);
      node.position = add(
        node.position,
        transformVector(delta, node.rotation, node.scale),
      );
      const shift = identity();
      shift.splice(12, 3, ...delta.map((v) => -v));
      bake(project, node, shift);
      break;
    }
    case "parameters": {
      if (node.recipe) {
        for (const key of Object.keys(command.options))
          if (hasExpression(node.recipe.generator.options?.[key]))
            throw new ModelError(
              "This generator option is driven by recipe parameters; edit recipeParameters or bind recipeValues instead",
              "dependency",
              `nodes.${node.id}.recipe.generator.options.${key}`,
            );
        node.recipe.generator.options = {
          ...node.recipe.generator.options,
          ...copy(command.options),
        };
        run(project, { op: "recipe", id: node.id, definition: node.recipe });
        break;
      }
      if (!node.generator)
        fail("This part is a mesh; generator parameters are unavailable");
      Object.assign(node.generator.options, copy(command.options));
      const generated = primitive(
        node.generator.kind,
        node.generator.options,
        node.generator.material,
      );
      if (node.generator.basis) transformMesh(generated, node.generator.basis);
      for (const f of generated.faces)
        f.material =
          node.mesh.faces.find((old) => old.id === f.id)?.material ??
          f.material;
      node.mesh = generated;
      break;
    }
    case "convert":
      delete node.generator;
      delete node.recipe;
      break;
    case "applyScale": {
      const m = matrix({
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: node.scale,
      });
      bake(project, node, m);
      node.scale = [1, 1, 1];
      break;
    }
    case "dimensions": {
      const bounds = measure(project, node.id).bounds,
        size = vector(command.size);
      if (size.some((v) => v <= 0) || bounds.size.some((v) => v < 1e-10))
        fail("Dimensions need positive three-dimensional bounds");
      selectionTransform(project, {
        id: node.id,
        scale: size.map((v, i) => v / bounds.size[i]),
        pivot: bounds.center,
      });
      break;
    }
    case "symmetry": {
      identifier(command.newId, "newId");
      if (node.symmetry) fail("Mirror an independent source");
      const ids = [...descendants(project, node.id)],
        map = copyIds(project, ids, command);
      const clones = ids.map((id) => {
        const src = project.nodes.find((n) => n.id === id);
        if (src.symmetry)
          fail("Unlink nested mirrors before mirroring this hierarchy");
        return {
          ...copy(src),
          id: map.get(id),
          name:
            id === node.id
              ? (command.name ?? `${src.name} ↔`)
              : `${src.name} ↔`,
          parent: map.get(src.parent) ?? src.parent,
          symmetry: {
            source: id,
            axis: command.axis ?? "x",
            offset: command.offset ?? 0,
            reference: command.space === "parent" ? node.parent : null,
          },
        };
      });
      clones.forEach((n) => {
        delete n.generator;
        delete n.instanceOf;
        delete n.instanceBasis;
      });
      project.nodes.push(...clones);
      synchronize(project);
      if (command.linked === false) clones.forEach((n) => delete n.symmetry);
      return { idMap: Object.fromEntries(map) };
    }
    case "unlink":
      for (const n of project.nodes.filter((n) =>
        descendants(project, node.id).has(n.id),
      )) {
        delete n.symmetry;
        delete n.instanceOf;
      }
      break;
    case "vertices":
      if (
        !node.mesh ||
        !Array.isArray(command.changes) ||
        !command.changes.length
      )
        fail("Expected vertex changes on a mesh");
      delete node.generator;
      delete node.recipe;
      for (const { index, position } of command.changes) {
        if (!Number.isInteger(index) || !node.mesh.vertices[index])
          fail("Unknown vertex index");
        node.mesh.vertices[index] = vector(position);
      }
      break;
    case "extrude":
    case "inset":
    case "bevel":
    case "cut":
    case "loopCut": {
      if (!node.mesh) fail("Select a mesh");
      delete node.generator;
      delete node.recipe;
      const m =
        command.space === "local" ? identity() : worldMatrix(project, node.id);
      transformMesh(node.mesh, m);
      if (command.op === "extrude")
        extrudeRegion(
          node.mesh,
          command.faces ?? [command.face],
          command.distance,
        );
      if (command.op === "inset")
        for (const id of command.faces ?? [command.face])
          insetFace(node.mesh, id, command.distance);
      if (command.op === "bevel") {
        if (command.edges)
          bevelEdges(node.mesh, command.edges, command.distance);
        else bevelMesh(node.mesh, command.distance);
      }
      if (command.op === "cut")
        cutPlane(node.mesh, command.axis, command.offset);
      if (command.op === "loopCut")
        loopCut(node.mesh, command.edge, command.ratio);
      transformMesh(node.mesh, inverse(m));
      break;
    }
    case "array": {
      const step = arrayStep(command);
      // Inside a recipe (local space) copies can only merge into this mesh.
      if (command.merge || command.space === "local") {
        if (!node.mesh) fail("Merged arrays need a mesh part", "id");
        if (node.instanceOf) fail("Edit the source or unlink this copy first");
        if (bindingFor(project, node.id))
          throw new ModelError(
            "Edit assembly parameters or detach the assembly before changing a driven field",
            "dependency",
            `nodes.${node.id}`,
          );
        delete node.generator;
        delete node.recipe;
        node.mesh = arrayMesh(node.mesh, step);
        break;
      }
      if (
        command.newIds !== undefined &&
        command.newIds.length !== step.count - 1
      )
        fail(`newIds needs ${step.count - 1} IDs`, "newIds");
      // Copies step in the parent's coordinates, turning about the part's origin by default.
      const one = stepMatrix({ ...step, pivot: step.pivot ?? node.position }),
        local = matrix(node),
        inner = [...descendants(project, node.id)].slice(1),
        copies = [];
      let m = one;
      for (let k = 2; k <= step.count; k++) {
        const newId = command.newIds?.[k - 2] ?? `${node.id}_${k}`,
          result = run(project, {
            op: "duplicate",
            id: node.id,
            newId,
            idMap: Object.fromEntries(inner.map((id) => [id, `${id}_${k}`])),
            offset: [0, 0, 0],
            linked: command.linked !== false,
            name: `${node.name} ${k}`,
          });
        setMatrix(
          project,
          project.nodes.find((n) => n.id === newId),
          multiply(m, local),
        );
        copies.push({ root: newId, idMap: result.idMap });
        m = multiply(one, m);
      }
      return { copies };
    }
    case "deleteComponents":
    case "dissolve":
    case "weld":
    case "fill":
    case "bridge":
    case "connect":
    case "solidify": {
      if (!node.mesh) fail("Select a mesh");
      const { generator, recipe } = node;
      delete node.generator;
      delete node.recipe;
      // Weld distances and solidify thickness are world meters unless space is local.
      const m =
        DISTANCE_EDITS.includes(command.op) && command.space !== "local"
          ? worldMatrix(project, node.id)
          : identity();
      const vertices = node.mesh.vertices;
      transformMesh(node.mesh, m);
      const output = editMesh(node.mesh, command);
      transformMesh(node.mesh, inverse(m));
      // A weld that merged nothing keeps the part exactly as it was, parametric too.
      if (output.unchanged) {
        node.mesh.vertices = vertices;
        if (generator) node.generator = generator;
        if (recipe) node.recipe = recipe;
      }
      return output;
    }
    case "separate":
      return separateParts(project, node, command, identifier);
    case "join": {
      const output = joinParts(project, node, command);
      for (const id of output.consumed) {
        // Children and mirrors of a joined part stay, attached to the result.
        for (const n of project.nodes.filter(
          (n) =>
            !output.consumed.includes(n.id) &&
            (n.parent === id || n.symmetry?.source === id),
        )) {
          if (n.symmetry) run(project, { op: "unlink", id: n.id });
          if (n.parent === id) run(project, { op: "set", id: n.id, parent: node.id });
        }
        if (project.nodes.some((n) => n.id === id))
          run(project, { op: "delete", id });
      }
      return output;
    }
    case "boolean": {
      delete node.generator;
      delete node.recipe;
      const { consumed } = booleanMesh(project, node, command);
      for (const id of consumed)
        if (project.nodes.some((n) => n.id === id))
          run(project, { op: "delete", id });
      return { consumed };
    }
    case "recipePaint": {
      if (!node.recipe) fail("Material bindings need a recipe");
      const recipe = copy(node.recipe);
      if (command.mode === "clear") {
        if (recipe.paint) {
          recipe.paint.faces = [];
          delete recipe.paint.layout;
        }
      } else if (command.mode === "rules") {
        if (!Array.isArray(command.rules))
          fail("Expected material selection rules");
        recipe.paint = {
          ...recipe.paint,
          faces: [],
          rules: copy(command.rules),
        };
        delete recipe.paint.layout;
      } else fail("Expected clear or rules material binding mode");
      run(project, { op: "recipe", id: node.id, definition: recipe });
      break;
    }
    case "paint": {
      if (!node.mesh) fail("Select a mesh");
      if (
        command.faces !== undefined &&
        (!Array.isArray(command.faces) ||
          !command.faces.length ||
          command.faces.some((id) => !node.mesh.faces.some((f) => f.id === id)))
      )
        fail("Unknown face ID");
      for (const face of node.mesh.faces)
        if (!command.faces || command.faces.includes(face.id))
          face.material = command.material;
      if (node.generator && !command.faces)
        node.generator.material = command.material;
      if (node.recipe) {
        if (command.faces) {
          const paint = node.recipe.paint ?? { faces: [] };
          paint.layout = connectivityToken(node.mesh);
          for (const id of command.faces) {
            paint.faces = paint.faces.filter((f) => f.id !== id);
            const face = node.mesh.faces.find((f) => f.id === id);
            paint.faces.push({
              id,
              vertices: [...face.vertices],
              material: command.material,
            });
          }
          node.recipe.paint = paint;
        } else node.recipe.paint = { all: command.material, faces: [] };
      }
      break;
    }
    case "mirror": {
      if (!node.mesh || !["x", "y", "z"].includes(command.axis))
        fail("Mirror needs a mesh and x/y/z axis");
      transformNodeMesh(node, reflection(command.axis));
      if (node.generator)
        node.generator.basis = multiply(
          reflection(command.axis),
          node.generator.basis ?? identity(),
        );
      if (node.recipe)
        node.recipe.basis = multiply(
          reflection(command.axis),
          node.recipe.basis ?? identity(),
        );
      break;
    }
    default:
      fail(`Unknown operation: ${command.op}`);
  }
}

export function evaluateTransaction(
  project,
  commands,
  {
    strictComponents = false,
    includeResults = true,
    includeComponents = false,
  } = {},
) {
  if (!Array.isArray(commands) || !commands.length || commands.length > 256)
    fail("Expected 1–256 commands");
  // A blueprint stands for the commands that build its asset (blueprints.js); they run in its
  // place and report its index. Materials created earlier in the batch are not created again.
  const expanded = [],
    materialIds = new Set((project.materials ?? []).map((m) => m.id));
  const add = (index, c) => {
    expanded.push([index, c]);
    if (c && c.op === "material" && typeof c.id === "string") materialIds.add(c.id);
  };
  for (const [index, input] of commands.entries()) {
    if (input && input.op === "blueprint") {
      let built;
      try {
        built = blueprintCommands(input, { materials: [...materialIds].map((id) => ({ id })) });
      } catch (e) {
        if (e instanceof ModelError && e.commandIndex === undefined) e.commandIndex = index;
        throw e;
      }
      for (const c of built) add(index, c);
    } else add(index, input);
  }
  // Every command copies its input below, so the store's project is never mutated.
  let next = project;
  const results = [];
  for (const [index, input] of expanded) {
    let command;
    try {
      const before = next;
      command = resolveComponents(before, input, { strict: strictComponents });
      if (
        ["transform", "align", "ground"].includes(command.op) &&
        (command.ids ?? [command.id]).some((id) => bindingFor(next, id))
      )
        throw new ModelError(
          "Edit assembly parameters or transform the whole asset root",
          "dependency",
        );
      const binding = bindingFor(next, command.id);
      if (
        binding &&
        ((command.op === "recipeParameters" && binding.recipeValues) ||
          (command.op === "parameters" && binding.options) ||
          (command.op === "recipe" && binding.recipeValues) ||
          (command.op === "set" &&
            ((binding.position && command.position) ||
              (binding.rotation && command.rotation) ||
              command.scale ||
              command.parent !== undefined)) ||
          [
            "transform",
            "dimensions",
            "pivot",
            "applyScale",
            "mirror",
            "convert",
            "vertices",
            "inset",
            "extrude",
            "bevel",
            "cut",
            "loopCut",
            "boolean",
            ...MESH_EDITS,
            "separate",
            "join",
          ].includes(command.op))
      )
        throw new ModelError(
          "Edit assembly parameters or detach the assembly before changing a driven field",
          "dependency",
          `nodes.${command.id}`,
        );
      next = copy(before);
      const output = run(next, command);
      // Affine edits and paint must remain reconstructible before being saved.
      if (
        !["recipe", "recipeParameters", "recipeStep", "recipePaint"].includes(
          command.op,
        )
      )
        for (const n of next.nodes)
          if (
            n.recipe &&
            !n.instanceOf &&
            !n.symmetry &&
            JSON.stringify(n) !==
              JSON.stringify(before.nodes.find((v) => v.id === n.id))
          )
            run(next, { op: "recipe", id: n.id, definition: n.recipe });
      synchronize(next);
      if (next.assemblies?.length) rebuildAssemblies(next, run, synchronize);
      next = normalizeProject(next);
      synchronize(next);
      // Mirrors and linked copies are rebuilt after normalization: keep its -0 → 0 rule.
      for (const n of next.nodes)
        if (n.symmetry || n.instanceOf) {
          for (const key of ["position", "rotation", "scale"])
            n[key] = n[key].map((v) => v || 0);
          if (n.mesh) n.mesh.vertices = n.mesh.vertices.map((p) => p.map((v) => v || 0));
        }
      const changed = next.nodes.filter(
        (n) =>
          JSON.stringify(n) !==
          JSON.stringify(before.nodes.find((v) => v.id === n.id)),
      );
      const geometry = [];
      for (const n of changed.filter((n) => n.mesh)) {
        const old = before.nodes.find((v) => v.id === n.id),
          previous = topologyToken(old?.mesh),
          topology = topologyToken(n.mesh);
        if (topology === previous) continue;
        // Only faults this edit adds block it: an imported mesh may already carry some.
        // Separate shells passing through each other, and checks too large to finish,
        // are warnings.
        const faults = (mesh) =>
          surfaces(mesh).issues.filter((i) =>
            ["self-intersection", "zero-volume"].includes(i.code),
          );
        const invalid = faults(n.mesh);
        if (invalid.length > (old?.mesh ? faults(old.mesh).length : 0)) {
          const error = new ModelError(
            "Geometry would intersect itself or collapse",
            "geometry",
            `nodes.${n.id}.mesh`,
          );
          error.issues = invalid.map((i) => ({ ...i, node: n.id }));
          error.suggestion =
            "Reduce the edit distance or split the operation; inspect the reported faces.";
          throw error;
        }
        if (includeResults) {
          const oldFaces = new Set(old?.mesh?.faces.map((f) => f.id) ?? []),
            edges = meshEdges(n.mesh);
          geometry.push({
            node: n.id,
            previousTopology: previous,
            topology,
            invalidatesPreviousReferences: true,
            faceCount: n.mesh.faces.length,
            edgeCount: edges.length,
            ...(includeComponents
              ? {
                  createdFaces: n.mesh.faces
                    .filter((f) => !oldFaces.has(f.id))
                    .slice(0, 1000)
                    .map((f) => componentRef(n, "faces", f.id, topology)),
                  removedFaces: [...oldFaces].filter(
                    (id) => !n.mesh.faces.some((f) => f.id === id),
                  ),
                  faces: n.mesh.faces
                    .slice(0, 1000)
                    .map((f) => componentRef(n, "faces", f.id, topology)),
                  edges: edges
                    .slice(0, 1000)
                    .map((e) => componentRef(n, "edges", e.id, topology)),
                  truncated: n.mesh.faces.length > 1000 || edges.length > 1000,
                }
              : {}),
          });
        }
      }
      if (includeResults)
        results.push({
          index,
          op: command.op,
          node: command.id ?? null,
          ...output,
          selection: selectionSummary(before, command),
          parameterChanges: (next.assemblies ?? []).flatMap((a) =>
            Object.entries(a.parameters).flatMap(([key, p]) => {
              const old = before.assemblies?.find((v) => v.root === a.root)
                ?.parameters[key]?.value;
              return old !== undefined && old !== p.value
                ? [
                    {
                      root: a.root,
                      parameter: key,
                      before: old,
                      after: p.value,
                    },
                  ]
                : [];
            }),
          ),
          changed: changed.map((n) => n.id),
          removed: before.nodes
            .filter((n) => !next.nodes.some((v) => v.id === n.id))
            .map((n) => n.id),
          geometry,
          materialRules: changed
            .filter((n) => n.recipe?.paint?.rules?.length)
            .map((n) => ({
              node: n.id,
              rules: n.recipe.paint.rules.map((rule, index) => ({
                index,
                name: rule.name ?? null,
                material: rule.material,
                matched: queryComponents(
                  next,
                  { ...rule.select, id: n.id, kind: "faces", space: "local" },
                  { complete: true },
                ).total,
              })),
            })),
          detachedRecipes: changed
            .filter(
              (n) =>
                !n.recipe && before.nodes.find((v) => v.id === n.id)?.recipe,
            )
            .map((n) => n.id),
        });
    } catch (error) {
      if (error.recovery) error.recovery.retry = copy(input);
      error.commandIndex ??= index;
      error.operation ??= input?.op;
      error.node ??= input?.id;
      error.components ??= command
        ? {
            faces: command.faces ?? (command.face ? [command.face] : undefined),
            edges: command.edges ?? (command.edge ? [command.edge] : undefined),
            vertices: command.vertices,
          }
        : undefined;
      if (/too wide|crosses an adjacent edge/i.test(error.message)) {
        error.code = "geometry_limit";
        error.suggestion = `Reduce the distance (${error.recipeArguments?.distance ?? command?.distance ?? "current value"} m) and preview again.`;
      }
      if (!error.path) error.path = `commands.${index}`;
      throw error;
    }
  }
  return { project: next, results, stats: statistics(next) };
}
export function evaluateCommands(project, commands, options = {}) {
  return evaluateTransaction(project, commands, {
    ...options,
    includeResults: false,
  }).project;
}

// One evaluation boundary for imported JSON, restored drafts and export snapshots.
export function evaluateProject(input) {
  const project = normalizeProject(input);
  for (const n of project.nodes)
    if (n.recipe && !n.instanceOf && !n.symmetry)
      run(project, { op: "recipe", id: n.id, definition: n.recipe });
  synchronize(project);
  if (project.assemblies.length) rebuildAssemblies(project, run, synchronize);
  synchronize(project);
  return normalizeProject(project);
}

// Snapshot history keeps topology edits and batches atomic. Reads never expose mutable state.
export function createStore(
  initial = emptyProject(),
  {
    revision: initialRevision = 0,
    beforeChange = () => {},
    cached = false,
  } = {},
) {
  const prepare = evaluateProject;
  let project = cached ? normalizeProject(initial) : prepare(initial),
    revision = initialRevision;
  const past = [],
    future = [],
    listeners = new Set();
  const snapshot = () => copy(project);
  const push = (stack, value) => {
    stack.push(JSON.stringify(value));
    while (
      stack.length > 30 ||
      (stack.length > 1 &&
        stack.reduce((n, s) => n + s.length, 0) > 64 * 1024 * 1024)
    )
      stack.shift();
  };
  function commit(next, { results = [], ...options } = {}, evaluated = false) {
    beforeChange(revision);
    if (options.ifRevision !== undefined && options.ifRevision !== revision)
      throw new ModelError("Project changed; inspect and retry", "conflict");
    // A transaction result is normalized after its last command already.
    const valid = evaluated ? next : prepare(next);
    const changed = valid.nodes
      .filter(
        (n) =>
          JSON.stringify(n) !==
          JSON.stringify(project.nodes.find((old) => old.id === n.id)),
      )
      .map((n) => n.id);
    const removed = project.nodes
      .filter((n) => !valid.nodes.some((v) => v.id === n.id))
      .map((n) => n.id);
    const removedMaterials = project.materials
      .filter((m) => !valid.materials.some((v) => v.id === m.id))
      .map((m) => m.id);
    const materials = valid.materials
      .filter(
        (m) =>
          JSON.stringify(m) !==
          JSON.stringify(project.materials.find((v) => v.id === m.id)),
      )
      .map((m) => m.id)
      .concat(removedMaterials);
    push(past, project);
    future.length = 0;
    project = valid;
    revision++;
    // Listeners see command results, e.g. to follow a renamed selection.
    listeners.forEach((listener) => listener(results));
    return {
      revision,
      stats: statistics(project),
      changed,
      removed,
      materials,
      removedMaterials,
    };
  }
  return {
    snapshot,
    get revision() {
      return revision;
    },
    get canUndo() {
      return !!past.length;
    },
    get canRedo() {
      return !!future.length;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replace(next, options) {
      return commit(next, options);
    },
    preview(commands, options = {}) {
      if (options.ifRevision !== undefined && options.ifRevision !== revision)
        throw new ModelError("Project changed; inspect and retry", "conflict");
      return { revision, ...evaluateTransaction(project, commands, options) };
    },
    apply(commands, options = {}) {
      beforeChange(revision);
      if (options.ifRevision !== undefined && options.ifRevision !== revision)
        throw new ModelError("Project changed; inspect and retry", "conflict");
      const evaluated = evaluateTransaction(project, commands, options);
      return {
        ...commit(
          evaluated.project,
          { ...options, results: evaluated.results },
          true,
        ),
        results: evaluated.results,
      };
    },
    undo() {
      if (!past.length) return false;
      beforeChange(revision);
      push(future, project);
      project = JSON.parse(past.pop());
      revision++;
      listeners.forEach((fn) => fn());
      return true;
    },
    redo() {
      if (!future.length) return false;
      beforeChange(revision);
      push(past, project);
      project = JSON.parse(future.pop());
      revision++;
      listeners.forEach((fn) => fn());
      return true;
    },
  };
}

export function duckProject() {
  const store = createStore(emptyProject("Little duck"));
  store.apply([
    { op: "create", id: "duck", name: "Duck", kind: "group" },
    {
      op: "create",
      id: "body",
      name: "Body",
      parent: "duck",
      kind: "sphere",
      position: [0, 0.85, 0],
      scale: [1.3, 1, 1.7],
      options: { radius: 0.7, segments: 10, rings: 6 },
    },
    {
      op: "create",
      id: "head",
      name: "Head",
      parent: "duck",
      kind: "sphere",
      position: [0, 1.65, 0.6],
      options: { radius: 0.52, segments: 10, rings: 6 },
    },
    {
      op: "create",
      id: "beak",
      name: "Beak",
      parent: "head",
      material: "orange",
      position: [0, -0.1, 0.5],
      scale: [0.62, 0.18, 0.55],
    },
    {
      op: "create",
      id: "wing-left",
      name: "Left wing",
      parent: "body",
      kind: "sphere",
      position: [-0.59, 0, 0],
      scale: [0.23, 0.65, 0.65],
      rotation: [0, 0, -12],
      options: { radius: 0.5, segments: 8, rings: 4 },
    },
    {
      op: "symmetry",
      id: "wing-left",
      newId: "wing-right",
      name: "Right wing",
      axis: "x",
      space: "parent",
      linked: true,
    },
    ...[-1, 1].map((s) => ({
      op: "create",
      id: s < 0 ? "eye-left" : "eye-right",
      name: s < 0 ? "Left eye" : "Right eye",
      parent: "head",
      kind: "sphere",
      material: "ink",
      position: [s * 0.37, 0.12, 0.34],
      options: { radius: 0.065, segments: 6, rings: 4 },
    })),
    ...[-1, 1].map((s) => ({
      op: "create",
      id: s < 0 ? "foot-left" : "foot-right",
      name: s < 0 ? "Left foot" : "Right foot",
      parent: "duck",
      material: "orange",
      position: [s * 0.32, 0.08, 0.3],
      scale: [0.4, 0.16, 0.65],
    })),
    {
      op: "create",
      id: "tail",
      name: "Tail",
      parent: "duck",
      kind: "cone",
      position: [0, 1.02, -1.0],
      rotation: [-55, 0, 0],
      options: { radius: 0.28, height: 0.7, segments: 5 },
    },
  ]);
  return store.snapshot();
}
