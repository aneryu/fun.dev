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
  nodePoints,
  decompose,
} from "./spatial.js";
import { meshEdges, bevelEdges, cutPlane, loopCut } from "./topology.js";
import { surfaceDiagnostics } from "./diagnostics.js";
import { booleanMesh } from "./booleans.js";
import { resamplePath, resolveProfile } from "../runtime/kit/sweep.js";
import { arrayStep, stepMatrix, arrayMesh } from "./arrays.js";
import { blueprintCommands } from "./blueprints.js";
import { generateHeights, classifySurfaces, heightAt } from "../runtime/kit/terrain.js";
import { hashString } from "../runtime/kit/random.js";
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
    triangleCount = 0,
    copyCount = 0;
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
    const tags = normalizeTags(node.tags, `nodes.${node.id}.tags`);
    if (tags.length) result.tags = tags;
    if (node.params !== undefined && node.params !== null)
      result.params = normalizeParams(node.params, `nodes.${node.id}.params`);
    const data = DATA_KINDS.filter((k) => node[k]);
    if (
      data.length > 1 ||
      (data.length &&
        (result.mesh || result.generator || result.recipe || result.symmetry || result.instanceOf))
    )
      fail("A part is one of: mesh, placed model, marker, zone or path", `nodes.${node.id}`);
    if (node.place) result.place = normalizePlace(node.place, `nodes.${node.id}.place`);
    if (node.marker) result.marker = true;
    if (node.zone) result.zone = normalizeZone(node.zone, `nodes.${node.id}.zone`);
    if (node.path) result.path = normalizePath(node.path, `nodes.${node.id}.path`);
    if (node.terrain) {
      result.terrain = normalizeTerrain(node.terrain, `nodes.${node.id}.terrain`);
      if (result.rotation.some((v) => v !== 0) || result.scale.some((v) => v !== 1)) fail("A terrain is placed, never rotated or scaled", `nodes.${node.id}`);
    }
    if (node.copies !== undefined && node.copies !== null) {
      if (!result.place) fail("copies belong to a placed model", `nodes.${node.id}.copies`);
      result.copies = normalizeCopies(node.copies, `nodes.${node.id}.copies`);
      if ((copyCount += result.copies.length) > COPY_LIMITS.total)
        fail(`More than ${COPY_LIMITS.total} copies in the project`, `nodes.${node.id}.copies`);
      if (node.tints !== undefined && node.tints !== null)
        result.tints = normalizeTints(node.tints, result.copies.length, `nodes.${node.id}.tints`);
    }
    if (node.derived) result.derived = normalizeDerived(node.derived, `nodes.${node.id}.derived`);
    if (node.sockets !== undefined && node.sockets !== null) {
      if (dataKind(result)) fail("Sockets belong to mesh and group parts; a placed model carries its own", `nodes.${node.id}.sockets`);
      result.sockets = normalizeFrames(node.sockets, `nodes.${node.id}.sockets`);
    }
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
  const sources = normalizeSources(input.sources),
    tile = normalizeTile(input.tile),
    rules = normalizeRules(input.rules);
  return {
    format: FORMAT,
    version: VERSION,
    name: label(input.name, "name"),
    ...(tile ? { tile } : {}),
    ...(rules.length ? { rules } : {}),
    assemblies: normalizeAssemblies(
      input.assemblies ?? (legacyAssembly ? [legacyAssembly] : []),
      nodes,
    ),
    materials,
    nodes,
    ...(sources.length ? { sources } : {}),
  };
}

// Where a project's parts came from (docs/library-api.md): library models opened or added.
// Kinds this version does not know are dropped, so later kinds never stop a project opening.
function normalizeSources(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 64) fail("Expected up to 64 sources", "sources");
  return input
    .filter((s) => s?.kind === "library")
    .map((s, i) => {
      if (
        !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(s.id) ||
        !/^v\d{3}$/.test(s.version) ||
        !["source.funmodel.glb", "model.glb"].includes(s.file) ||
        !/^[a-f0-9]{64}$/.test(s.sha256)
      )
        fail("Invalid library source", `sources.${i}`);
      return { kind: "library", id: s.id, version: s.version, file: s.file, sha256: s.sha256 };
    });
}

// Scene data (docs/worlds.md): tags and parameters on any part; a part that is a placed
// library model, a marker, a zone or a path instead of a mesh.
const TAG = /^[\p{L}\p{N}_:.-]{1,64}$/u;
export function normalizeTags(value, path = "tags") {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    value.some((t) => typeof t !== "string" || !TAG.test(t))
  )
    fail("Tags are up to 16 strings of letters, digits, _ : . - (1–64)", path);
  return [...new Set(value)];
}
export function normalizeParams(value, path = "params") {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("Parameters are a JSON object", path);
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    fail("Parameters must be plain JSON", path);
  }
  if (text === undefined || text.length > 4096)
    fail("Parameters are plain JSON up to 4 KB", path);
  return JSON.parse(text);
}
const MODEL_REF = /^[a-z0-9]+(?:_[a-z0-9]+)*@v\d{3}$/,
  SHA = /^[a-f0-9]{64}$/,
  SHORT_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function normalizePlace(value, path = "place") {
  if (!value || typeof value !== "object") fail("Invalid placed model", path);
  if (typeof value.model !== "string" || !MODEL_REF.test(value.model))
    fail("A placed model is <id>@v<nnn>", `${path}.model`);
  const bounds = value.bounds;
  if (!bounds || typeof bounds !== "object")
    fail("A placed model needs its bounds", `${path}.bounds`);
  const min = vector(bounds.min, `${path}.bounds.min`),
    max = vector(bounds.max, `${path}.bounds.max`);
  if (min.some((v, i) => v > max[i]))
    fail("Placed model bounds are inverted", `${path}.bounds`);
  const result = { model: value.model, bounds: { min, max } };
  if (value.sha256 !== undefined && value.sha256 !== null) {
    if (!SHA.test(value.sha256)) fail("Invalid sha256", `${path}.sha256`);
    result.sha256 = value.sha256;
  }
  if (value.derived !== undefined && value.derived !== null) {
    if (!SHA.test(value.derived)) fail("Invalid derived sha256", `${path}.derived`);
    result.derived = value.derived;
  }
  if (value.triangles !== undefined && value.triangles !== null) {
    if (!Number.isInteger(value.triangles) || value.triangles < 0 || value.triangles > 1e8)
      fail("Invalid triangle count", `${path}.triangles`);
    result.triangles = value.triangles;
  }
  if (value.variants !== undefined && value.variants !== null) {
    if (typeof value.variants !== "object" || Array.isArray(value.variants))
      fail("Variants map an axis to a variant id", `${path}.variants`);
    const entries = Object.entries(value.variants);
    if (
      entries.length > 16 ||
      entries.some(([k, v]) => !SHORT_ID.test(k) || typeof v !== "string" || !SHORT_ID.test(v))
    )
      fail("Variants map up to 16 axes to variant ids", `${path}.variants`);
    if (entries.length) result.variants = Object.fromEntries(entries);
  }
  if (value.tint !== undefined && value.tint !== null) {
    const tint = vector(value.tint, `${path}.tint`);
    if (tint.some((v) => v < 0 || v > 1)) fail("Tint components are 0–1", `${path}.tint`);
    result.tint = tint;
  }
  if (value.sockets !== undefined && value.sockets !== null && Object.keys(value.sockets).length)
    result.sockets = normalizeFrames(value.sockets, `${path}.sockets`);
  return result;
}
export function normalizeZone(value, path = "area") {
  if (!value || typeof value !== "object") fail("Invalid zone", path);
  if (value.polygon !== undefined) {
    if (!Array.isArray(value.polygon) || value.polygon.length < 3 || value.polygon.length > 256)
      fail("A zone polygon has 3–256 [x, z] points", `${path}.polygon`);
    const polygon = value.polygon.map((p, i) => {
      if (!Array.isArray(p) || p.length !== 2 || p.some((v) => !Number.isFinite(v) || Math.abs(v) > 100000))
        fail("Polygon points are [x, z]", `${path}.polygon.${i}`);
      return [p[0], p[1]];
    });
    const y = value.y ?? [0, 3];
    if (!Array.isArray(y) || y.length !== 2 || y.some((v) => !Number.isFinite(v) || Math.abs(v) > 100000) || y[1] <= y[0])
      fail("A zone's y is [bottom, top]", `${path}.y`);
    return { kind: "polygon", polygon, y: [y[0], y[1]] };
  }
  if (value.size !== undefined) {
    const size = vector(value.size, `${path}.size`);
    if (size.some((v) => v <= 0)) fail("A box zone needs a positive size", `${path}.size`);
    return { kind: "box", size };
  }
  if (value.radius !== undefined)
    return { kind: "sphere", radius: number(value.radius, 1e-6, 100000, `${path}.radius`) };
  fail("A zone is a polygon with y, a box size or a sphere radius", path);
}
// A path's kind says what it is for a game (road, track, rail, river, walk; data for anything
// else); profile, lanes, oneway and speed ride into the tile's edge for routing (kit/world.js).
export const PATH_KINDS = ["data", "road", "track", "rail", "river", "walk"];
export const PATH_POINTS = 4096;
export function normalizePath(value, path = "path") {
  if (!value || typeof value !== "object" || !Array.isArray(value.points) || value.points.length < 2 || value.points.length > PATH_POINTS)
    fail(`A path has 2–${PATH_POINTS} points`, `${path}.points`);
  const out = { points: value.points.map((p, i) => vector(p, `${path}.points.${i}`)), closed: !!value.closed };
  if (value.kind !== undefined && value.kind !== null) {
    if (!PATH_KINDS.includes(value.kind)) fail(`kind is one of ${PATH_KINDS.join(", ")}`, `${path}.kind`);
    if (value.kind !== "data") out.kind = value.kind;
  }
  if (value.profile !== undefined && value.profile !== null) out.profile = identifier(value.profile, `${path}.profile`);
  if (value.lanes !== undefined && value.lanes !== null) {
    if (!Number.isInteger(value.lanes) || value.lanes < 1 || value.lanes > 8) fail("lanes is 1–8", `${path}.lanes`);
    out.lanes = value.lanes;
  }
  if (value.oneway) out.oneway = true;
  if (value.speed !== undefined && value.speed !== null) out.speed = number(value.speed, 1, 400, `${path}.speed`);
  return out;
}
// tile.size cuts a world into tiles centred on multiples of it (tiles.js); tile.span is how
// many tiles across and deep the world may use, centred on tile 0_0 (odd numbers; 1 by default).
function normalizeTile(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || !Array.isArray(value.size) || value.size.length !== 2 || value.size.some((v) => !(v >= 1 && v <= 100000)))
    fail("tile.size is [width, depth] in metres", "tile.size");
  const tile = { size: [value.size[0], value.size[1]] };
  if (value.span !== undefined && value.span !== null) {
    if (!Array.isArray(value.span) || value.span.length !== 2 || value.span.some((v) => !Number.isInteger(v) || v < 1 || v > 63 || v % 2 === 0))
      fail("tile.span is [across, deep] tiles, odd numbers from 1 to 63", "tile.span");
    if (value.span[0] !== 1 || value.span[1] !== 1) tile.span = [value.span[0], value.span[1]];
  }
  return tile;
}
// Many copies of a placed model in one part (docs/worlds.md §5): rows [x, y, z, rx, ry, rz,
// scale] in the part's space, usually derived by a rule; a derived stamp names the rule.
export const COPY_LIMITS = { perNode: 10000, total: 100000, rules: 64, candidates: 16, avoid: 32 };
function normalizeCopies(value, path) {
  if (!Array.isArray(value) || value.length < 1 || value.length > COPY_LIMITS.perNode)
    fail(`Copies are 1–${COPY_LIMITS.perNode} rows of [x, y, z, rx, ry, rz, scale]`, path);
  return value.map((row, i) => {
    if (
      !Array.isArray(row) ||
      row.length !== 7 ||
      row.some((v) => !Number.isFinite(v) || Math.abs(v) > 100000) ||
      row[6] < 0.001 ||
      row[6] > 1000
    )
      fail("A copy is [x, y, z, rx, ry, rz, scale] with a scale from 0.001 to 1000", `${path}.${i}`);
    return [...row];
  });
}
function normalizeTints(value, count, path) {
  if (!Array.isArray(value) || value.length !== count) fail("Tints need one [r, g, b] per copy", path);
  return value.map((t, i) => {
    const tint = vector(t, `${path}.${i}`);
    if (tint.some((v) => v < 0 || v > 1)) fail("Tint components are 0–1", `${path}.${i}`);
    return tint;
  });
}
function normalizeDerived(value, path) {
  if (!value || typeof value !== "object" || typeof value.hash !== "string" || value.hash.length > 32)
    fail("A derived stamp is { rule, hash }", path);
  return { rule: identifier(value.rule, `${path}.rule`), hash: value.hash };
}
const RULE_MODEL = /^[a-z0-9]+(?:_[a-z0-9]+)*(?:@v\d{3})?$/;
function normalizeYaw(value, path) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return { mode: "fixed", value: number(value, -10000, 10000, path) };
  if (value === "path" || value === "random") return { mode: value };
  if (value && typeof value === "object") {
    const mode = value.mode ?? (value.value !== undefined ? "fixed" : "random");
    if (!["path", "random", "fixed"].includes(mode))
      fail("yaw is path, random, a number, or { mode, value, jitter }", path);
    const out = { mode };
    if (mode === "fixed") out.value = number(value.value ?? 0, -10000, 10000, `${path}.value`);
    if (value.jitter !== undefined) out.jitter = number(value.jitter, 0, 360, `${path}.jitter`);
    return out;
  }
  fail("yaw is path, random, a number, or { mode, value, jitter }", path);
}
const SOCKET_ID = /^[A-Za-z0-9_-]{1,64}$/,
  BOX_SIDES = ["n", "s", "e", "w", "up", "down"];
// Socket frames in a piece's space: a box-side shorthand ({ e: "road" }), explicit frames, or
// "model" for the sockets the library model carries.
export function normalizeSockets(value, path = "sockets") {
  if (value === "model") return "model";
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Sockets are { side: tag }, { name: { position, rotation, tags } } or \"model\"", path);
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 32) fail("Up to 32 sockets", path);
  const out = {};
  for (const [name, spec] of entries) {
    if (!SOCKET_ID.test(name)) fail("Socket names use letters, digits, _ -", `${path}.${name}`);
    // A side shorthand, as written ({ e: "road" }) or as already normalized ({ side, tags }).
    if (typeof spec === "string" || (spec && typeof spec === "object" && typeof spec.side === "string")) {
      const tag = typeof spec === "string" ? spec : spec.tags?.[0];
      if (!BOX_SIDES.includes(name) || (typeof spec !== "string" && spec.side !== name)) fail(`A side shorthand names n, s, e, w, up or down`, `${path}.${name}`);
      if (typeof tag !== "string" || !tag || tag.length > 64) fail("A socket tag is 1–64 characters", `${path}.${name}`);
      out[name] = { side: name, tags: [tag] };
    } else {
      if (!spec || typeof spec !== "object") fail("A socket is { position, rotation, tags }", `${path}.${name}`);
      const tags = normalizeTags(spec.tags, `${path}.${name}.tags`);
      out[name] = { position: vector(spec.position ?? [0, 0, 0], `${path}.${name}.position`), rotation: vector(spec.rotation ?? [0, 0, 0], `${path}.${name}.rotation`), tags };
    }
  }
  return out;
}
/** Socket frames given explicitly: { name: { position, rotation (degrees), tags } }. */
export function normalizeFrames(value, path = "sockets") {
  const frames = normalizeSockets(value, path);
  if (frames === "model" || Object.values(frames).some((f) => f.side)) fail("Give sockets as { name: { position, rotation, tags } }", path);
  return frames;
}
function normalizeAssembleRule(value, rule, path) {
  if (!Array.isArray(value.pieces) || !value.pieces.length || value.pieces.length > COPY_LIMITS.candidates)
    fail(`pieces are 1–${COPY_LIMITS.candidates} library models`, `${path}.pieces`);
  rule.pieces = value.pieces.map((c, i) => {
    const at = `${path}.pieces.${i}`;
    if (!c || typeof c !== "object" || typeof c.model !== "string" || !RULE_MODEL.test(c.model)) fail("A piece names a library model (id or id@vNNN)", `${at}.model`);
    const out = { model: c.model, weight: number(c.weight ?? 1, 0, 1000, `${at}.weight`), sockets: normalizeSockets(c.sockets ?? "model", `${at}.sockets`) };
    if (c.closer) out.closer = true;
    if (c.start) out.start = true;
    return out;
  });
  if (value.mates !== undefined && value.mates !== null) {
    if (!Array.isArray(value.mates) || value.mates.length > 64 || value.mates.some((m) => !Array.isArray(m) || m.length !== 2 || m.some((t) => typeof t !== "string" || !t || t.length > 64)))
      fail("mates are pairs of socket tags", `${path}.mates`);
    rule.mates = value.mates.map((m) => [...m]);
  }
  if (value.start !== undefined && value.start !== null) rule.start = number(value.start, 0, rule.pieces.length - 1, `${path}.start`);
  if (value.at !== undefined && value.at !== null) rule.at = vector(value.at, `${path}.at`);
  if (value.yaw !== undefined && value.yaw !== null) rule.yaw = number(value.yaw, -10000, 10000, `${path}.yaw`);
  rule.count = number(value.count ?? 64, 1, COPY_LIMITS.perNode, `${path}.count`);
  rule.frontier = value.frontier === "last" ? "last" : "any";
  if (value.from !== undefined && value.from !== null) {
    if (typeof value.from !== "string" || !SOCKET_ID.test(value.from)) fail("from names a socket of the start piece", `${path}.from`);
    rule.from = value.from;
  }
  if (value.sequence !== undefined && value.sequence !== null) {
    if (!Array.isArray(value.sequence) || !value.sequence.length || value.sequence.length > 1024 || value.sequence.some((v) => !Number.isInteger(v) || v < 0 || v >= rule.pieces.length))
      fail("sequence lists piece indices", `${path}.sequence`);
    rule.sequence = [...value.sequence];
  }
  if (value.bounds !== undefined && value.bounds !== null) rule.bounds = identifier(value.bounds, `${path}.bounds`);
  if (value.close === false) rule.close = false;
  if (value.tolerance !== undefined && value.tolerance !== null) rule.tolerance = number(value.tolerance, 0, 10, `${path}.tolerance`);
}
export function normalizeRule(value, path = "definition") {
  if (!value || typeof value !== "object") fail("Invalid rule", path);
  const id = identifier(value.id, `${path}.id`);
  if (!["scatter", "assemble", "sweep"].includes(value.kind)) fail("Rule kinds: scatter, assemble, sweep", `${path}.kind`);
  const rule = { id, kind: value.kind };
  if (typeof value.seed === "string") {
    if (!value.seed.length || value.seed.length > 64) fail("A seed is a number or a short string", `${path}.seed`);
    rule.seed = value.seed;
  } else rule.seed = value.seed === undefined ? 1 : number(value.seed, 0, 4294967295, `${path}.seed`);
  rule.target = value.target === undefined ? id : identifier(value.target, `${path}.target`);
  if (value.parent !== undefined && value.parent !== null) rule.parent = identifier(value.parent, `${path}.parent`);
  const tags = normalizeTags(value.tags, `${path}.tags`);
  if (tags.length) rule.tags = tags;
  // bake false: the rule rides in the tile for the game to run at play time (kit/world.js).
  if (value.bake === false) rule.bake = false;
  if (rule.kind === "sweep") {
    normalizeSweepRule(value, rule, path);
    return rule;
  }
  if (rule.kind === "assemble") {
    normalizeAssembleRule(value, rule, path);
    if (value.avoid !== undefined && value.avoid !== null) rule.avoid = normalizeAvoid(value.avoid, path);
    return rule;
  }
  const on = value.on;
  if (!on || typeof on !== "object") fail("A scatter rule needs on: { path } | { zone } | { grid }", `${path}.on`);
  const modes = ["path", "zone", "grid"].filter((k) => on[k] !== undefined && on[k] !== null);
  if (modes.length !== 1) fail("on is one of path, zone or grid", `${path}.on`);
  const spacing = number(on.spacing ?? on.grid?.spacing ?? 1, 0.01, 10000, `${path}.on.spacing`);
  if (modes[0] === "path") {
    const offset = Array.isArray(on.offset)
      ? [number(on.offset[0], -10000, 10000, `${path}.on.offset`), number(on.offset[1] ?? on.offset[0], -10000, 10000, `${path}.on.offset`)]
      : number(on.offset ?? 0, -10000, 10000, `${path}.on.offset`);
    rule.on = {
      path: identifier(on.path, `${path}.on.path`),
      spacing,
      offset,
      sides: on.sides === "both" ? "both" : "one",
      start: number(on.start ?? 0, 0, 1000000, `${path}.on.start`),
      end: on.end === undefined || on.end === null ? null : number(on.end, 0, 1000000, `${path}.on.end`),
      jitter: number(on.jitter ?? 0, 0, 1, `${path}.on.jitter`),
    };
  } else if (modes[0] === "zone") {
    rule.on = {
      zone: identifier(on.zone, `${path}.on.zone`),
      spacing,
      jitter: number(on.jitter ?? 0.5, 0, 1, `${path}.on.jitter`),
      margin: number(on.margin ?? 0, 0, 10000, `${path}.on.margin`),
      count: on.count === undefined || on.count === null ? null : number(on.count, 1, COPY_LIMITS.perNode, `${path}.on.count`),
    };
  } else {
    const grid = on.grid;
    if (!grid || typeof grid !== "object" || !Array.isArray(grid.cells) || grid.cells.length !== 2 || grid.cells.some((v) => !Number.isInteger(v) || v < 1 || v > 1000) || grid.cells[0] * grid.cells[1] > COPY_LIMITS.perNode)
      fail(`A grid has cells [columns, rows] up to ${COPY_LIMITS.perNode} in all`, `${path}.on.grid`);
    rule.on = { grid: { cells: [...grid.cells], spacing, origin: vector(grid.origin ?? [0, 0, 0], `${path}.on.grid.origin`) } };
  }
  if (value.y !== undefined && value.y !== null) rule.y = number(value.y, -100000, 100000, `${path}.y`);
  if (value.ground) rule.ground = true;
  if (value.where !== undefined && value.where !== null) {
    if (typeof value.where !== "object" || !Array.isArray(value.where.surfaces) || !value.where.surfaces.length || value.where.surfaces.length > 16 || value.where.surfaces.some((v) => typeof v !== "string" || !SHORT_ID.test(v)))
      fail("where is { surfaces: [ids] }", `${path}.where`);
    rule.where = { surfaces: [...value.where.surfaces] };
  }
  const yaw = normalizeYaw(value.yaw, `${path}.yaw`);
  if (yaw) rule.yaw = yaw;
  if (value.scale !== undefined && value.scale !== null) {
    const scale = value.scale;
    if (!Array.isArray(scale) || scale.length !== 2 || scale.some((v) => !(v >= 0.001 && v <= 1000)) || scale[0] > scale[1])
      fail("scale is [min, max]", `${path}.scale`);
    rule.scale = [scale[0], scale[1]];
  }
  if (!Array.isArray(value.candidates) || !value.candidates.length || value.candidates.length > COPY_LIMITS.candidates)
    fail(`candidates are 1–${COPY_LIMITS.candidates} library models`, `${path}.candidates`);
  rule.candidates = value.candidates.map((c, i) => {
    if (!c || typeof c !== "object" || typeof c.model !== "string" || !RULE_MODEL.test(c.model))
      fail("A candidate names a library model (id or id@vNNN)", `${path}.candidates.${i}.model`);
    const out = { model: c.model, weight: number(c.weight ?? 1, 0, 1000, `${path}.candidates.${i}.weight`) };
    if (c.tints !== undefined && c.tints !== null) {
      if (!Array.isArray(c.tints) || !c.tints.length || c.tints.length > 16) fail("tints are 1–16 colours", `${path}.candidates.${i}.tints`);
      out.tints = normalizeTints(c.tints, c.tints.length, `${path}.candidates.${i}.tints`);
    }
    return out;
  });
  if (value.avoid !== undefined && value.avoid !== null) rule.avoid = normalizeAvoid(value.avoid, path);
  return rule;
}
// Sweep (docs/worlds.md §5): a profile carried along paths becomes mesh parts tagged ground.
const SWEEP_LIMITS = { paths: 64, strips: 16, marks: 16 };
function normalizeSweepRule(value, rule, path) {
  if (value.bake === false) fail("Sweep rules bake in the workshop; bake: false is for scatter and assembly", `${path}.bake`);
  const on = value.on;
  if (!on || typeof on !== "object") fail("A sweep rule needs on: { path } | { paths: [ids] } | { tag }", `${path}.on`);
  if (on.path !== undefined && on.path !== null) rule.on = { paths: [identifier(on.path, `${path}.on.path`)] };
  else if (Array.isArray(on.paths) && on.paths.length && on.paths.length <= SWEEP_LIMITS.paths) rule.on = { paths: on.paths.map((p, i) => identifier(p, `${path}.on.paths.${i}`)) };
  else if (typeof on.tag === "string") rule.on = { tag: normalizeTags([on.tag], `${path}.on.tag`)[0] };
  else fail(`on is { path } | { paths: [up to ${SWEEP_LIMITS.paths} ids] } | { tag }`, `${path}.on`);
  const given = value.profile === undefined || value.profile === null ? "road" : value.profile;
  let profile;
  try {
    profile = resolveProfile(given);
  } catch (e) {
    fail(e.message, `${path}.profile`);
  }
  if (profile.strips.length > SWEEP_LIMITS.strips || profile.marks.length > SWEEP_LIMITS.marks) fail(`A profile has up to ${SWEEP_LIMITS.strips} strips and ${SWEEP_LIMITS.marks} marks`, `${path}.profile`);
  profile.strips.forEach((s, i) => {
    number(s.width, 0.01, 100, `${path}.profile.strips.${i}.width`);
    number(s.offset ?? 0, -10, 10, `${path}.profile.strips.${i}.offset`);
    identifier(s.material, `${path}.profile.strips.${i}.material`);
  });
  profile.marks.forEach((m, i) => {
    number(m.at, -100, 100, `${path}.profile.marks.${i}.at`);
    number(m.width, 0.01, 100, `${path}.profile.marks.${i}.width`);
    for (const id of m.materials ?? [m.material]) identifier(id, `${path}.profile.marks.${i}.material`);
    if (m.dash !== undefined && m.dash !== null && (!Array.isArray(m.dash) || m.dash.length !== 2 || m.dash.some((v) => !(v > 0 && v <= 1000)))) fail("dash is [on, off] metres", `${path}.profile.marks.${i}.dash`);
  });
  if (profile.thickness !== undefined) number(profile.thickness, 0, 10, `${path}.profile.thickness`);
  rule.profile = typeof given === "string" ? given : JSON.parse(JSON.stringify(given));
  if (value.ground) rule.ground = true;
  rule.rise = number(value.rise ?? 0.05, -10, 10, `${path}.rise`);
  rule.step = number(value.step ?? 4, 0.25, 100, `${path}.step`);
  if (value.bank === null) rule.bank = null;
  else if (typeof value.bank === "number") rule.bank = { max: number(value.bank, 0, 45, `${path}.bank`), radius: 40 };
  else if (value.bank !== undefined) {
    if (typeof value.bank !== "object") fail("bank is degrees, { max, radius } or null", `${path}.bank`);
    rule.bank = { max: number(value.bank.max ?? 0, 0, 45, `${path}.bank.max`), radius: number(value.bank.radius ?? 40, 1, 10000, `${path}.bank.radius`) };
  }
  if (value.chunk !== undefined && value.chunk !== null) rule.chunk = number(value.chunk, 1, 100000, `${path}.chunk`);
}
function normalizeAvoid(value, path) {
  if (!Array.isArray(value) || value.length > COPY_LIMITS.avoid) fail(`avoid lists up to ${COPY_LIMITS.avoid} entries`, `${path}.avoid`);
  return value.map((a, i) => {
    const at = `${path}.avoid.${i}`;
    if (!a || typeof a !== "object") fail("avoid entries are { path, width } | { zone } | { nodes }", at);
    if (a.path !== undefined) return { path: identifier(a.path, `${at}.path`), width: number(a.width ?? 1, 0, 10000, `${at}.width`) };
    if (a.zone !== undefined) return { zone: identifier(a.zone, `${at}.zone`) };
    if (Array.isArray(a.nodes) && a.nodes.length && a.nodes.length <= 64) return { nodes: a.nodes.map((n, k) => identifier(n, `${at}.nodes.${k}`)) };
    fail("avoid entries are { path, width } | { zone } | { nodes }", at);
  });
}
function normalizeRules(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > COPY_LIMITS.rules) fail(`Expected up to ${COPY_LIMITS.rules} rules`, "rules");
  const rules = input.map((r, i) => normalizeRule(r, `rules.${i}`));
  unique(rules.map((r) => r.id), "rules");
  return rules;
}
// Terrain (docs/worlds.md §4): a height field in the part's space, its corner at the origin,
// samples row by row along +z of columns along +x; never rotated or scaled.
const HEX = /^#[0-9a-fA-F]{6}$/;
export function normalizeTerrain(value, path = "terrain") {
  if (!value || typeof value !== "object") fail("Invalid terrain", path);
  const cell = number(value.cell ?? 2, 0.1, 100, `${path}.cell`);
  const samples = value.samples;
  if (!Array.isArray(samples) || samples.length !== 2 || samples.some((v) => !Number.isInteger(v) || v < 2 || v > 257))
    fail("samples are [columns, rows] from 2 to 257", `${path}.samples`);
  const n = samples[0] * samples[1], cells = (samples[0] - 1) * (samples[1] - 1);
  let heights = value.heights;
  if (heights === undefined || heights === null) heights = new Array(n).fill(0);
  else {
    if (!Array.isArray(heights) && !ArrayBuffer.isView(heights)) fail(`heights are ${n} numbers`, `${path}.heights`);
    if (heights.length !== n) fail(`heights are ${n} numbers`, `${path}.heights`);
    heights = Array.from(heights, (v, i) => {
      if (!Number.isFinite(v) || Math.abs(v) > 10000) fail("Invalid height", `${path}.heights.${i}`);
      return Math.round(v * 1000) / 1000;
    });
  }
  const table = value.surfaceTable ?? [{ id: "ground", color: "#8a9a5b" }];
  if (!Array.isArray(table) || !table.length || table.length > 16) fail("surfaceTable has 1–16 surfaces", `${path}.surfaceTable`);
  const surfaceTable = table.map((s, i) => {
    if (!s || typeof s !== "object" || !SHORT_ID.test(s.id ?? "") || !HEX.test(s.color ?? "")) fail("A surface is { id, color, roughness, friction, tags }", `${path}.surfaceTable.${i}`);
    const out = { id: s.id, color: s.color.toLowerCase() };
    if (s.roughness !== undefined) out.roughness = number(s.roughness, 0, 1, `${path}.surfaceTable.${i}.roughness`);
    if (s.friction !== undefined) out.friction = number(s.friction, 0, 2, `${path}.surfaceTable.${i}.friction`);
    const tags = normalizeTags(s.tags, `${path}.surfaceTable.${i}.tags`);
    if (tags.length) out.tags = tags;
    return out;
  });
  const result = { cell, samples: [samples[0], samples[1]], heights, surfaceTable };
  if (value.surfaces !== undefined && value.surfaces !== null) {
    const surfaces = value.surfaces;
    if ((!Array.isArray(surfaces) && !ArrayBuffer.isView(surfaces)) || surfaces.length !== cells) fail(`surfaces are ${cells} surface indices`, `${path}.surfaces`);
    result.surfaces = Array.from(surfaces, (v, i) => {
      if (!Number.isInteger(v) || v < 0 || v >= surfaceTable.length) fail("A surface index names an entry of surfaceTable", `${path}.surfaces.${i}`);
      return v;
    });
  }
  if (value.water !== undefined && value.water !== null) {
    if (typeof value.water !== "object") fail("water is { level, color }", `${path}.water`);
    result.water = { level: number(value.water.level ?? 0, -10000, 10000, `${path}.water.level`), color: HEX.test(value.water.color ?? "") ? value.water.color.toLowerCase() : "#4ba3c7" };
  }
  if (value.ops !== undefined && value.ops !== null) {
    if (!Array.isArray(value.ops) || value.ops.length > 32 || value.ops.some((o) => !o || typeof o !== "object")) fail("ops are up to 32 objects", `${path}.ops`);
    if (JSON.stringify(value.ops).length > 16384) fail("ops are up to 16 KB", `${path}.ops`);
    result.ops = JSON.parse(JSON.stringify(value.ops));
  }
  if (value.rules !== undefined && value.rules !== null) {
    if (!Array.isArray(value.rules) || value.rules.length > 16) fail("surface rules are up to 16 entries", `${path}.rules`);
    result.rules = value.rules.map((r, i) => {
      if (!r || typeof r !== "object") fail("A surface rule is { surface, slope, height }", `${path}.rules.${i}`);
      const out = { surface: typeof r.surface === "string" ? r.surface : number(r.surface ?? 0, 0, surfaceTable.length - 1, `${path}.rules.${i}.surface`) };
      if (typeof out.surface === "string" && !surfaceTable.some((t) => t.id === out.surface)) fail(`Unknown surface ${out.surface}`, `${path}.rules.${i}.surface`);
      for (const key of ["slope", "height"])
        if (r[key] !== undefined && r[key] !== null) {
          if (!Array.isArray(r[key]) || r[key].length !== 2 || r[key].some((v) => !Number.isFinite(v)) || r[key][0] > r[key][1]) fail(`${key} is [min, max]`, `${path}.rules.${i}.${key}`);
          out[key] = [r[key][0], r[key][1]];
        }
      return out;
    });
  }
  return result;
}
export const DATA_KINDS = ["place", "marker", "zone", "path", "terrain"];
export const dataKind = (node) => DATA_KINDS.find((k) => node?.[k]) ?? null;

export function statistics(project) {
  return project.nodes.reduce(
    (s, node) => {
      if (node.place) {
        s.placed++;
        const count = node.copies?.length ?? 1;
        s.copies += node.copies?.length ?? 0;
        s.placedTriangles += (node.place.triangles ?? 0) * count;
      } else if (node.marker) s.markers++;
      else if (node.zone) s.zones++;
      else if (node.path) s.paths++;
      else if (node.terrain) {
        s.terrains++;
        s.terrainTriangles += (node.terrain.samples[0] - 1) * (node.terrain.samples[1] - 1) * 2;
      }
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
      placed: 0,
      copies: 0,
      placedTriangles: 0,
      markers: 0,
      zones: 0,
      paths: 0,
      terrains: 0,
      terrainTriangles: 0,
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
      // Derived sweeps are open ribbons by design.
      if (boundary && !node.derived)
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
  for (const node of project.nodes.filter((n) => n.mesh && !n.derived)) {
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
  for (const node of project.nodes.filter(
    (n) => ids.has(n.id) && (n.mesh || n.place || n.zone || n.path),
  )) {
    const m = worldMatrix(project, node.id);
    points.push(...(node.mesh?.vertices ?? nodePoints(node)).map((v) => point(m, v)));
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
  // Scatter rules (docs/worlds.md §5): rules are data on the project; `derived` replaces what
  // a rule produced last time with what it produces now, every node stamped with the rule.
  if (command.op === "rule") {
    const rule = normalizeRule(command.definition, "definition");
    project.rules = [...(project.rules ?? []).filter((r) => r.id !== rule.id), rule];
    return;
  }
  if (command.op === "removeRule") {
    identifier(command.id, "id");
    if (!(project.rules ?? []).some((r) => r.id === command.id)) fail(`Unknown rule: ${command.id}`);
    project.rules = project.rules.filter((r) => r.id !== command.id);
    const removed = new Set(project.nodes.filter((n) => n.derived?.rule === command.id).map((n) => n.id));
    if (project.nodes.some((n) => removed.has(n.parent) && !removed.has(n.id)))
      fail("A derived part has children; move them before removing the rule");
    project.nodes = project.nodes.filter((n) => !removed.has(n.id));
    return;
  }
  if (command.op === "derived") {
    identifier(command.rule, "rule");
    if (!(project.rules ?? []).some((r) => r.id === command.rule)) fail(`Unknown rule: ${command.rule}`);
    if (!Array.isArray(command.nodes) || command.nodes.length > 64) fail("derived takes up to 64 nodes", "nodes");
    const removed = new Set(project.nodes.filter((n) => n.derived?.rule === command.rule).map((n) => n.id));
    if (project.nodes.some((n) => removed.has(n.parent) && !removed.has(n.id)))
      fail("A derived part has children; move them before deriving again");
    project.nodes = project.nodes.filter((n) => !removed.has(n.id));
    for (const [i, node] of command.nodes.entries()) {
      const at = `nodes.${i}`;
      if (!node || typeof node !== "object") fail("Invalid derived node", at);
      const result = {
        id: identifier(node.id, `${at}.id`),
        name: label(node.name ?? node.id, `${at}.name`),
        parent: node.parent == null ? null : identifier(node.parent, `${at}.parent`),
        position: vector(node.position ?? [0, 0, 0], `${at}.position`),
        rotation: vector(node.rotation ?? [0, 0, 0], `${at}.rotation`),
        scale: vector(node.scale ?? [1, 1, 1], `${at}.scale`),
        mesh: null,
        derived: { rule: command.rule, hash: normalizeDerived({ rule: command.rule, hash: node.derived?.hash ?? node.hash ?? "" }, `${at}.derived`).hash },
      };
      // A sweep derives meshes (validated with the project); the others place library models.
      if (node.mesh) result.mesh = copy(node.mesh);
      else result.place = normalizePlace(node.place, `${at}.place`);
      if (result.place && node.copies !== undefined && node.copies !== null) {
        result.copies = normalizeCopies(node.copies, `${at}.copies`);
        if (node.tints !== undefined && node.tints !== null) result.tints = normalizeTints(node.tints, result.copies.length, `${at}.tints`);
      }
      const tags = normalizeTags(node.tags, `${at}.tags`);
      if (tags.length) result.tags = tags;
      if (node.params !== undefined && node.params !== null) result.params = normalizeParams(node.params, `${at}.params`);
      project.nodes.push(result);
    }
    return;
  }
  if (command.op === "snap") {
    // Moves a part so that one of its sockets meets a socket of another part, facing it.
    const part = project.nodes.find((n) => n.id === command.id);
    if (!part) fail(`Unknown node: ${command.id}`);
    const target = project.nodes.find((n) => n.id === command.target?.id);
    if (!target) fail(`Unknown node: ${command.target?.id}`, "target");
    if (descendants(project, part.id).has(target.id)) fail("A part cannot snap to its own descendant", "target");
    const frameOf = (node, name, path) => {
      const frames = node.sockets ?? node.place?.sockets ?? {};
      const frame = frames[name];
      if (!frame) fail(`${node.id} has no socket ${name}`, path);
      return matrix({ position: frame.position, rotation: frame.rotation, scale: [1, 1, 1] });
    };
    const world = multiply(worldMatrix(project, target.id), frameOf(target, command.target.socket, "target.socket"));
    const local = frameOf(part, command.socket, "socket");
    const flip = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
    // The part keeps its scale: its rotation follows from the mated frames, and its origin
    // sits at −(R S p) from the frame's, with R that rotation and p the socket's local position.
    const current = decompose(worldMatrix(project, part.id));
    if (!current) fail("Snap needs a part without shear");
    const scale = current.scale;
    const frame = multiply(world, flip);
    const R = [frame[0], frame[1], frame[2], 0, frame[4], frame[5], frame[6], 0, frame[8], frame[9], frame[10], 0, 0, 0, 0, 1];
    const localRotation = [local[0], local[1], local[2], 0, local[4], local[5], local[6], 0, local[8], local[9], local[10], 0, 0, 0, 0, 1];
    const partRotation = multiply(R, inverse(localRotation));
    const offset = point(partRotation, [local[12] * scale[0], local[13] * scale[1], local[14] * scale[2]]);
    const placed = multiply(
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, frame[12] - offset[0], frame[13] - offset[1], frame[14] - offset[2], 1],
      multiply(partRotation, [scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, 0, 0, 0, 1]),
    );
    setMatrix(project, part, part.parent ? multiply(inverse(worldMatrix(project, part.parent)), placed) : placed);
    // Mated frames give exact values; the trigonometry's dust is swept off.
    const tidy = (v) => Math.round(v * 1e7) / 1e7 || 0;
    part.position = part.position.map(tidy);
    part.rotation = part.rotation.map(tidy);
    part.scale = part.scale.map(tidy);
    return;
  }
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
    const base = { id, name, parent, position, rotation, scale, mesh: null };
    const tags = normalizeTags(command.tags, "tags");
    if (tags.length) base.tags = tags;
    if (command.params !== undefined && command.params !== null)
      base.params = normalizeParams(command.params, "params");
    if (command.sockets !== undefined && command.sockets !== null) {
      if (DATA_KINDS.includes(kind)) fail("Sockets belong to mesh and group parts", "sockets");
      base.sockets = normalizeFrames(command.sockets, "sockets");
    }
    if (kind === "place") {
      if (!command.place) {
        const error = new ModelError(
          "Placing a library model needs its resolved record",
          "schema",
          "place",
        );
        error.suggestion = "Call place({ model, id, … }) which resolves the model in the library first.";
        throw error;
      }
      const placed = { ...base, place: normalizePlace(command.place, "place") };
      if (command.copies !== undefined && command.copies !== null) {
        placed.copies = normalizeCopies(command.copies, "copies");
        if (command.tints !== undefined && command.tints !== null) placed.tints = normalizeTints(command.tints, placed.copies.length, "tints");
      }
      project.nodes.push(placed);
      return;
    }
    if (kind === "marker") {
      project.nodes.push({ ...base, marker: true });
      return;
    }
    if (kind === "zone") {
      project.nodes.push({ ...base, zone: normalizeZone(command.area ?? options, "area") });
      return;
    }
    if (kind === "path") {
      project.nodes.push({ ...base, path: normalizePath(command.path ?? options, "path") });
      return;
    }
    if (kind === "terrain") {
      if (rotation.some((v) => v !== 0) || scale.some((v) => v !== 1)) fail("A terrain is placed, never rotated or scaled", "rotation");
      project.nodes.push({ ...base, terrain: normalizeTerrain(command.terrain ?? options, "terrain") });
      return;
    }
    project.nodes.push({
      ...base,
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
  if (dataKind(node) && !["set", "delete", "duplicate", "rename", "socket", "removeSocket", "terrain", "resample"].includes(command.op))
    fail("Placed models, markers, zones and paths take set, delete, duplicate and rename only");
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
    case "resample": {
      // Points about `spacing` apart along a smooth curve through the path's points; with
      // ground, each point's height is the terrain's under it.
      if (!node.path) fail("resample takes a path part", "id");
      const spacing = number(command.spacing ?? 2, 0.1, 10000, "spacing");
      const points = resamplePath(node.path.points, { closed: node.path.closed, spacing, smooth: command.smooth !== false });
      if (points.length > PATH_POINTS) fail(`Resampling at ${spacing} m gives ${points.length} points; the cap is ${PATH_POINTS}`, "spacing");
      if (command.ground) {
        const fields = project.nodes.filter((n) => n.terrain).map((n) => {
          const origin = point(worldMatrix(project, n.id), [0, 0, 0]);
          return { cell: n.terrain.cell, samples: n.terrain.samples, origin, heights: n.terrain.heights.map((h) => h + origin[1]) };
        });
        if (!fields.length) fail("ground needs a terrain part", "ground");
        const m = worldMatrix(project, node.id);
        for (const p of points) {
          const w = point(m, p);
          for (const f of fields) {
            const h = heightAt(f, w[0], w[2]);
            if (h !== null) { p[1] = Math.round((p[1] + h - w[1]) * 1000) / 1000; break; }
          }
        }
      }
      node.path = { ...node.path, points };
      break;
    }
    case "terrain": {
      if (!node.terrain) fail("terrain shapes a terrain part", "id");
      const terrain = node.terrain, origin = point(worldMatrix(project, node.id), [0, 0, 0]);
      const ops = command.ops === undefined ? terrain.ops ?? [] : normalizeTerrain({ ...terrain, ops: command.ops }, "ops").ops;
      // Paths and zones named by ops become world geometry for the generator.
      const resolved = ops.map((op) => {
        if (op.flatten?.path) {
          const source = project.nodes.find((n) => n.id === op.flatten.path);
          if (!source?.path) fail(`${op.flatten.path} is not a path`, "ops");
          const m = worldMatrix(project, source.id);
          const points = source.path.points.map((pt) => point(m, pt));
          if (source.path.closed) points.push(points[0]);
          return { flatten: { ...op.flatten, points } };
        }
        if (op.level?.zone) {
          const source = project.nodes.find((n) => n.id === op.level.zone);
          if (!source?.zone) fail(`${op.level.zone} is not a zone`, "ops");
          const z = source.zone, m = worldMatrix(project, source.id);
          const polygon =
            z.kind === "polygon"
              ? z.polygon.map(([x, zz]) => { const w = point(m, [x, z.y[0], zz]); return [w[0], w[2]]; })
              : z.kind === "box"
                ? [[-z.size[0] / 2, -z.size[2] / 2], [z.size[0] / 2, -z.size[2] / 2], [z.size[0] / 2, z.size[2] / 2], [-z.size[0] / 2, z.size[2] / 2]].map(([x, zz]) => { const w = point(m, [x, 0, zz]); return [w[0], w[2]]; })
                : Array.from({ length: 32 }, (_, i) => { const w = point(m, [z.radius * Math.cos((i / 32) * Math.PI * 2), 0, z.radius * Math.sin((i / 32) * Math.PI * 2)]); return [w[0], w[2]]; });
          return { level: { ...op.level, polygon } };
        }
        return op;
      });
      const seed = typeof command.seed === "string" ? hashString(command.seed) : command.seed === undefined ? 1 : number(command.seed, 0, 4294967295, "seed");
      const world = generateHeights({ cell: terrain.cell, samples: terrain.samples, origin }, resolved, seed);
      const heights = Array.from(world, (h) => Math.round((h - origin[1]) * 1000) / 1000);
      const next = { ...terrain, heights, ops };
      const rules = command.surfaces === undefined ? terrain.rules : normalizeTerrain({ ...terrain, rules: command.surfaces }, "surfaces").rules;
      if (rules) {
        next.rules = rules;
        const indexOf = (surface) => (typeof surface === "string" ? terrain.surfaceTable.findIndex((t) => t.id === surface) : surface);
        const ordered = [{}, ...rules.map((r) => ({ ...r }))];
        const classes = classifySurfaces(Float32Array.from(heights), terrain, ordered);
        next.surfaces = Array.from(classes, (c) => (c === 0 ? 0 : indexOf(rules[c - 1].surface)));
      }
      if (command.water !== undefined) {
        if (command.water === null) delete next.water;
        else next.water = normalizeTerrain({ ...terrain, water: command.water }, "water").water;
      }
      node.terrain = normalizeTerrain(next, "terrain");
      break;
    }
    case "socket": {
      if (dataKind(node)) fail("Sockets belong to mesh and group parts");
      const frames = normalizeFrames({ [command.socket]: { position: command.position ?? [0, 0, 0], rotation: command.rotation ?? [0, 0, 0], tags: command.tags ?? [] } }, "socket");
      node.sockets = { ...(node.sockets ?? {}), ...frames };
      if (Object.keys(node.sockets).length > 32) fail("Up to 32 sockets per part");
      break;
    }
    case "removeSocket": {
      if (!node.sockets?.[command.socket]) fail(`${node.id} has no socket ${command.socket}`, "socket");
      delete node.sockets[command.socket];
      if (!Object.keys(node.sockets).length) delete node.sockets;
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
      if (command.tags !== undefined) {
        const tags = normalizeTags(command.tags, "tags");
        if (tags.length) node.tags = tags;
        else delete node.tags;
      }
      if (command.params !== undefined) {
        if (command.params === null) delete node.params;
        else node.params = normalizeParams(command.params, "params");
      }
      if (command.variants !== undefined || command.tint !== undefined) {
        if (!node.place) fail("Variants and tint belong to placed models", "variants");
        node.place = normalizePlace(
          {
            ...node.place,
            ...(command.variants !== undefined ? { variants: command.variants } : {}),
            ...(command.tint !== undefined ? { tint: command.tint } : {}),
          },
          "place",
        );
      }
      if (command.copies !== undefined) {
        if (!node.place) fail("copies belong to placed models", "copies");
        if (command.copies === null) {
          delete node.copies;
          delete node.tints;
        } else {
          node.copies = normalizeCopies(command.copies, "copies");
          if (command.tints === undefined && node.tints && node.tints.length !== node.copies.length) delete node.tints;
        }
      }
      if (command.tints !== undefined) {
        if (!node.copies) fail("tints belong to copies", "tints");
        if (command.tints === null) delete node.tints;
        else node.tints = normalizeTints(command.tints, node.copies.length, "tints");
      }
      if (command.area !== undefined) {
        if (!node.zone) fail("area belongs to zones", "area");
        node.zone = normalizeZone(command.area, "area");
      }
      if (command.path !== undefined) {
        if (!node.path) fail("path belongs to paths", "path");
        node.path = normalizePath(command.path, "path");
      }
      if (command.terrain !== undefined) {
        if (!node.terrain) fail("terrain belongs to terrains", "terrain");
        node.terrain = normalizeTerrain({ ...node.terrain, ...command.terrain }, "terrain");
      }
      if (node.terrain && ((command.rotation && command.rotation.some((v) => v !== 0)) || (command.scale && command.scale.some((v) => v !== 1))))
        fail("A terrain is placed, never rotated or scaled", "rotation");
      if (command.sockets !== undefined) {
        if (dataKind(node)) fail("Sockets belong to mesh and group parts", "sockets");
        if (command.sockets === null) delete node.sockets;
        else node.sockets = normalizeFrames(command.sockets, "sockets");
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
          // A copy made by hand is no longer the rule's to replace.
          delete clone.derived;
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
          if (dataKind(n)) fail("Linked copies need mesh parts; duplicate placed models, markers, zones and paths without linked");
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
        if (topology === previous || n.derived) continue;
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
