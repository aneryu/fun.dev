// Any GLB becomes editable workshop parts: its node hierarchy and names, flat-colour PBR
// materials, and polygons recovered from triangles (coplanar, edge-connected regions of one
// material). A workshop project file restores its editable project instead. Skins,
// animations and textures are reported, not imported: the workshop edits static models.
import { ModelError, sub, cross, dot } from "./mesh.js";
import { polygonize } from "./solid.js";
import { setMatrix, determinant } from "./spatial.js";
import { normalizeMaterial, visitMaterials } from "./materials.js";
import { FORMAT, VERSION, LIMITS, emptyProject } from "./document.js";
import { remapRecipeReferences } from "./recipe.js";
import { parseModelFile, workshopProject } from "./glb.js";

const fail = (message, code = "invalid_glb", path = "data") => {
  throw new ModelError(message, code, path);
};
// Decoders for these are not part of the workshop (the library rejects them too).
const COMPRESSED = new Set([
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_texture_basisu",
  "EXT_texture_webp",
  "EXT_texture_avif",
]);
const UNDERSTOOD = new Set([
  "KHR_mesh_quantization",
  "KHR_texture_transform",
  "KHR_materials_unlit",
  "KHR_materials_emissive_strength",
  "KHR_materials_transmission",
  "KHR_materials_ior",
  "KHR_materials_volume",
  "KHR_materials_specular",
  "KHR_materials_clearcoat",
  "KHR_materials_sheen",
  "KHR_materials_variants",
  "KHR_lights_punctual",
]);

/**
 * Reads a GLB (or .gltf with embedded buffers). Returns the project to commit: in "replace"
 * mode the file's own project, in "add" mode the current one with the file's parts added
 * (under parent, if given). nodes lists the added node IDs; warnings what was left out.
 */
export function importModel(
  bytes,
  { mode = "replace", parent = null, current = null, name } = {},
) {
  if (!["replace", "add"].includes(mode))
    fail("Expected replace or add mode", "schema", "mode");
  const { json, buffers } = parseModelFile(bytes);
  const stored = workshopProject(json);
  const { project: incoming, warnings } = stored
    ? { project: stored, warnings: [] }
    : projectFromGLTF(json, buffers, { name });
  if (mode === "replace")
    return {
      project: incoming,
      nodes: incoming.nodes.map((n) => n.id),
      warnings,
      container: !!stored,
    };
  if (!current) fail("Adding parts needs the current project", "invalid", "mode");
  const merged = mergeProjects(current, incoming, { parent });
  return { ...merged, warnings, container: !!stored };
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
function uniqueId(raw, used, fallback) {
  let base = String(raw ?? "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, 58);
  if (!ID.test(base)) base = fallback;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}
const label = (raw, fallback) =>
  (typeof raw === "string" ? raw.trim().slice(0, 100) : "") || fallback;

const clamp = (v, min = 0, max = 1) =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
// glTF colour factors are linear; workshop colours are sRGB hex.
const srgb = (c) => {
  const v = clamp(c);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};
const hex = (rgb) =>
  "#" +
  rgb
    .slice(0, 3)
    .map((c) =>
      Math.round(srgb(c) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

function convertMaterial(m, id, warn) {
  const pbr = m.pbrMetallicRoughness ?? {},
    ext = m.extensions ?? {},
    [r = 1, g = 1, b = 1, a = 1] = pbr.baseColorFactor ?? [];
  if (
    pbr.baseColorTexture ||
    pbr.metallicRoughnessTexture ||
    m.normalTexture ||
    m.occlusionTexture ||
    m.emissiveTexture
  )
    warn("textures", "Textures were not imported; materials keep flat colours");
  if (ext.KHR_materials_unlit)
    warn("unlit", "Unlit materials became matte, lit materials");
  const emissive = m.emissiveFactor ?? [0, 0, 0],
    transmission = clamp(ext.KHR_materials_transmission?.transmissionFactor ?? 0),
    opacity =
      m.alphaMode === "BLEND"
        ? clamp(a)
        : m.alphaMode === "MASK"
          ? a >= (m.alphaCutoff ?? 0.5)
            ? 1
            : 0
          : 1;
  return normalizeMaterial({
    id,
    name: label(m.name, id),
    color: hex([r, g, b]),
    roughness: ext.KHR_materials_unlit ? 1 : clamp(pbr.roughnessFactor ?? 1),
    metalness: ext.KHR_materials_unlit ? 0 : clamp(pbr.metallicFactor ?? 1),
    ...(Math.max(...emissive) > 0
      ? {
          emissive: hex(emissive),
          emissiveIntensity: clamp(
            ext.KHR_materials_emissive_strength?.emissiveStrength ?? 1,
            0,
            1000,
          ),
        }
      : {}),
    opacity,
    transmission,
    ...(transmission > 0 ? { ior: clamp(ext.KHR_materials_ior?.ior ?? 1.5, 1, 3) } : {}),
    doubleSided: m.doubleSided === true,
  });
}

const COMPONENTS = {
  5120: [1, "getInt8", 127],
  5121: [1, "getUint8", 255],
  5122: [2, "getInt16", 32767],
  5123: [2, "getUint16", 65535],
  5125: [4, "getUint32", 0],
  5126: [4, "getFloat32", 0],
};
const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function accessorReader(json, buffers) {
  return (index) => {
    const a = json.accessors?.[index];
    if (!a) fail(`Missing accessor ${index}`);
    if (a.sparse) fail("Sparse accessors are not supported", "unsupported");
    const component = COMPONENTS[a.componentType],
      size = SIZES[a.type];
    if (!component || !size || !Number.isInteger(a.count) || a.count < 0)
      fail(`Unsupported accessor ${index}`);
    const [bytes, method, max] = component,
      out = new Float64Array(a.count * size);
    if (a.bufferView === undefined) return out;
    const view = json.bufferViews?.[a.bufferView],
      buffer = buffers[view?.buffer];
    if (!view || !buffer) fail(`Missing data for accessor ${index}`);
    const stride = view.byteStride || bytes * size,
      start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0),
      end = (view.byteOffset ?? 0) + view.byteLength;
    if (a.count && start + stride * (a.count - 1) + bytes * size > Math.min(end, buffer.length))
      fail(`Accessor ${index} reads past its buffer`);
    const data = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    for (let i = 0; i < a.count; i++)
      for (let k = 0; k < size; k++) {
        const v = data[method](start + i * stride + k * bytes, true);
        out[i * size + k] = a.normalized && max ? Math.max(v / max, -1) : v;
      }
    return out;
  };
}

// glTF node TRS (or matrix) as a column-major 4×4, the workshop's convention too.
function localMatrix(node) {
  if (node.matrix) {
    if (!Array.isArray(node.matrix) || node.matrix.length !== 16 || node.matrix.some((v) => !Number.isFinite(v)))
      fail("Invalid node matrix");
    return [...node.matrix];
  }
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1],
    [sx, sy, sz] = node.scale ?? [1, 1, 1],
    [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

// glTF stores triangles; the workshop edits polygons. Coplanar, edge-connected triangles of
// one material grow into regions against their seed's plane (no drift around curves), and
// polygonize turns each region into one polygon, or a few where it has holes.
export function editableMesh(positions, triangles, materials) {
  const canonical = new Map(),
    points = [],
    index = positions.map((p) => {
      const key = p.map((v) => Math.round(v * 1e6)).join(",");
      if (!canonical.has(key)) {
        canonical.set(key, points.length);
        points.push(p);
      }
      return canonical.get(key);
    });
  const tris = triangles.map((t) => t.map((v) => index[v]));
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  const tolerance = Math.max(4e-6, Math.hypot(...sub(hi, lo)) * 2e-7);
  const normals = tris.map(([a, b, c]) => {
    const n = cross(sub(points[b], points[a]), sub(points[c], points[a])),
      length = Math.hypot(...n);
    return new Set([a, b, c]).size === 3 && length > 1e-14
      ? n.map((v) => v / length)
      : null;
  });
  const byEdge = new Map();
  tris.forEach((t, i) =>
    t.forEach((a, k) => {
      const b = t[(k + 1) % 3],
        key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (!byEdge.has(key)) byEdge.set(key, []);
      byEdge.get(key).push(i);
    }),
  );
  const group = new Array(tris.length).fill(-1);
  let regions = 0;
  for (let seed = 0; seed < tris.length; seed++) {
    if (group[seed] >= 0 || !normals[seed]) continue;
    const id = regions++,
      n = normals[seed],
      origin = points[tris[seed][0]],
      queue = [seed];
    group[seed] = id;
    while (queue.length) {
      const t = tris[queue.pop()];
      for (let k = 0; k < 3; k++) {
        const a = t[k],
          b = t[(k + 1) % 3];
        const shared = byEdge.get(a < b ? `${a}:${b}` : `${b}:${a}`);
        // An edge with a third face (a fin standing on a plate) stays a polygon edge:
        // merging across it would leave the fin standing inside a face.
        if (shared.length > 2) continue;
        for (const j of shared) {
          if (
            group[j] >= 0 ||
            !normals[j] ||
            materials[j] !== materials[seed] ||
            dot(normals[j], n) < 1 - 1e-5 ||
            tris[j].some(
              (v) => Math.abs(dot(sub(points[v], origin), n)) > tolerance,
            )
          )
            continue;
          group[j] = id;
          queue.push(j);
        }
      }
    }
  }
  for (let i = 0; i < group.length; i++) if (group[i] < 0) group[i] = regions++;
  return polygonize(points, tris, group.map(String), materials);
}

function projectFromGLTF(json, buffers, { name } = {}) {
  const warnings = new Map(),
    warn = (code, message) => {
      if (!warnings.has(code)) warnings.set(code, { code, message });
    };
  const required = json.extensionsRequired ?? [];
  const compressed = required.filter((e) => COMPRESSED.has(e));
  if (compressed.length)
    fail(
      `Compressed files are not supported yet (${compressed.join(", ")}); export the model uncompressed`,
      "unsupported",
    );
  const unknown = required.filter((e) => !UNDERSTOOD.has(e));
  if (unknown.length)
    fail(`Unsupported required extensions: ${unknown.join(", ")}`, "unsupported");
  if (json.skins?.length) warn("skins", "Skins and bones were not imported");
  if (json.animations?.length) warn("animations", "Animations were not imported");
  if (json.cameras?.length) warn("cameras", "Cameras were not imported");
  if (json.extensions?.KHR_lights_punctual?.lights?.length)
    warn("lights", "Lights were not imported");
  const read = accessorReader(json, buffers);

  const materialIds = new Set(),
    materials = [],
    byGltf = new Map(),
    byLook = new Map();
  const materialFor = (index) => {
    if (byGltf.has(index)) return byGltf.get(index);
    const source =
      index === undefined
        ? { name: "default" }
        : (json.materials?.[index] ?? fail(`Missing material ${index}`));
    const look = convertMaterial(source, "pending", warn),
      key = JSON.stringify([source.name ?? null, { ...look, id: null }]);
    // glTF files often repeat one material per mesh: same name and look share one ID.
    let id = byLook.get(key);
    if (!id) {
      id = uniqueId(source.name ?? `material_${index}`, materialIds, "material");
      byLook.set(key, id);
      materials.push({ ...look, id, name: label(source.name, id) });
      if (materials.length > LIMITS.materials)
        fail(
          `This model uses more than ${LIMITS.materials} materials, the workshop's limit`,
          "budget",
        );
    }
    byGltf.set(index, id);
    return id;
  };

  const meshes = new Map();
  const meshFor = (index) => {
    if (meshes.has(index)) return meshes.get(index);
    const mesh = json.meshes?.[index] ?? fail(`Missing mesh ${index}`);
    const positions = [],
      triangles = [],
      triangleMaterials = [];
    for (const primitive of mesh.primitives ?? []) {
      const mode = primitive.mode ?? 4;
      if (![4, 5, 6].includes(mode)) {
        warn("primitives", "Line and point primitives were skipped");
        continue;
      }
      if (primitive.extensions?.KHR_draco_mesh_compression)
        fail("Compressed files are not supported yet; export the model uncompressed", "unsupported");
      if (primitive.targets?.length) warn("morphs", "Morph targets were not imported");
      if (primitive.attributes?.POSITION === undefined) continue;
      const p = read(primitive.attributes.POSITION),
        base = positions.length,
        count = p.length / 3;
      for (let i = 0; i < count; i++) positions.push([p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
      const indices =
        primitive.indices !== undefined
          ? read(primitive.indices)
          : Float64Array.from({ length: count }, (_, i) => i);
      if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= count))
        fail(`Mesh ${index} has an index outside its vertices`);
      const material = materialFor(primitive.material),
        push = (a, b, c) => {
          triangles.push([base + a, base + b, base + c]);
          triangleMaterials.push(material);
        };
      if (mode === 4)
        for (let i = 0; i + 2 < indices.length; i += 3) push(indices[i], indices[i + 1], indices[i + 2]);
      else if (mode === 5)
        for (let i = 0; i + 2 < indices.length; i++)
          if (i % 2) push(indices[i + 1], indices[i], indices[i + 2]);
          else push(indices[i], indices[i + 1], indices[i + 2]);
      else for (let i = 1; i + 1 < indices.length; i++) push(indices[0], indices[i], indices[i + 1]);
    }
    // Merging into polygons rarely removes more than a few triangles: far larger meshes are
    // refused before the work.
    if (triangles.length > LIMITS.triangles * 2)
      fail(
        `Mesh ${mesh.name ?? index} has ${triangles.length} triangles; the workshop keeps at most ${LIMITS.triangles}`,
        "budget",
      );
    const result = triangles.length
      ? editableMesh(positions, triangles, triangleMaterials)
      : null;
    meshes.set(index, result?.faces.length ? result : null);
    return meshes.get(index);
  };

  const sceneIndex = json.scene ?? 0,
    children = new Set((json.nodes ?? []).flatMap((n) => n.children ?? [])),
    roots =
      json.scenes?.[sceneIndex]?.nodes ??
      (json.nodes ?? []).map((_, i) => i).filter((i) => !children.has(i));
  const used = new Set(),
    nodes = [],
    order = [],
    matrices = new Map(),
    sources = new Map();
  const visit = (index, parent, path) => {
    if (path.has(index)) fail("The node hierarchy has a cycle");
    const g = json.nodes?.[index] ?? fail(`Missing node ${index}`),
      raw = g.name ?? json.meshes?.[g.mesh]?.name,
      id = uniqueId(raw, used, `node_${index}`),
      node = {
        id,
        name: label(raw, id),
        parent,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        mesh: null,
      };
    if (g.skin !== undefined) warn("skins", "Skins and bones were not imported");
    if (g.mesh !== undefined && meshFor(g.mesh)) {
      // A mesh used by several nodes becomes linked copies of its first node.
      if (sources.has(g.mesh)) node.instanceOf = sources.get(g.mesh);
      else {
        sources.set(g.mesh, id);
        node.mesh = structuredClone(meshFor(g.mesh));
      }
    }
    nodes.push(node);
    if (nodes.length > LIMITS.nodes)
      fail(`This model has more than ${LIMITS.nodes} parts, the workshop's limit`, "budget");
    matrices.set(id, localMatrix(g));
    const inside = new Set(path).add(index);
    for (const child of g.children ?? []) visit(child, id, inside);
    order.push(node);
  };
  for (const root of roots) visit(root, null, new Set());

  // Children first: a parent's shear or mirror bakes into its own mesh and its children.
  const project = { nodes };
  for (const node of order) {
    const m = matrices.get(node.id);
    if (Math.abs(determinant(m)) < 1e-12) {
      warn("collapsed", "Parts scaled to zero were left out");
      node.position = m.slice(12, 15);
      const source = node.mesh;
      node.mesh = null;
      delete node.instanceOf;
      // Its linked copies keep the geometry as independent parts.
      for (const other of nodes)
        if (other.instanceOf === node.id) {
          delete other.instanceOf;
          other.mesh = structuredClone(source);
        }
      continue;
    }
    setMatrix(project, node, m);
  }

  let triangleCount = 0,
    vertexCount = 0;
  for (const node of nodes) {
    const mesh = node.mesh ?? nodes.find((n) => n.id === node.instanceOf)?.mesh;
    if (!mesh) continue;
    vertexCount += mesh.vertices.length;
    triangleCount += mesh.faces.reduce((n, f) => n + f.vertices.length - 2, 0);
  }
  if (triangleCount > LIMITS.triangles || vertexCount > LIMITS.vertices)
    fail(
      `This model has ${triangleCount} triangles and ${vertexCount} editable vertices; the workshop keeps at most ${LIMITS.triangles} and ${LIMITS.vertices}`,
      "budget",
    );
  const title =
    name ??
    json.scenes?.[sceneIndex]?.name ??
    (roots.length === 1 ? json.nodes?.[roots[0]]?.name : undefined);
  return {
    project: {
      format: FORMAT,
      version: VERSION,
      name: label(title, "Imported model"),
      materials: materials.length ? materials : emptyProject().materials,
      nodes,
    },
    warnings: [...warnings.values()],
  };
}

/** Adds another project's parts: clashing node and material IDs get suffixes. */
export function mergeProjects(current, incoming, { parent = null } = {}) {
  if (parent !== null && !current.nodes.some((n) => n.id === parent))
    fail(`Unknown parent: ${parent}`, "invalid", "parent");
  const project = structuredClone(current),
    add = structuredClone(incoming);
  const materialIds = new Set([
      ...project.materials.map((m) => m.id),
      ...add.materials.map((m) => m.id),
    ]),
    materialMap = new Map();
  for (const m of add.materials) {
    const same = project.materials.find((v) => v.id === m.id);
    if (same && JSON.stringify(same) === JSON.stringify(m)) continue;
    if (same) {
      const id = uniqueId(m.id, materialIds, "material");
      materialMap.set(m.id, id);
      project.materials.push({ ...m, id });
    } else project.materials.push(m);
  }
  if (project.materials.length > LIMITS.materials)
    fail(`Together the models use more than ${LIMITS.materials} materials`, "budget");
  if (materialMap.size)
    visitMaterials(add, ({ owner, key, material }) => {
      if (materialMap.has(material)) owner[key] = materialMap.get(material);
    });
  const taken = new Set(project.nodes.map((n) => n.id)),
    ids = new Set([...taken, ...add.nodes.map((n) => n.id)]),
    idMap = new Map();
  for (const n of add.nodes)
    if (taken.has(n.id)) idMap.set(n.id, uniqueId(n.id, ids, "node"));
  const map = (id) => (id == null ? id : (idMap.get(id) ?? id));
  for (const n of add.nodes) {
    if (idMap.has(n.id)) remapRecipeReferences(n.recipe, n.id, idMap.get(n.id));
    n.id = map(n.id);
    n.parent = n.parent === null ? parent : map(n.parent);
    if (n.instanceOf) n.instanceOf = map(n.instanceOf);
    if (n.symmetry) {
      n.symmetry.source = map(n.symmetry.source);
      if (n.symmetry.reference) n.symmetry.reference = map(n.symmetry.reference);
    }
  }
  const remap = (value) =>
    Array.isArray(value)
      ? value.map(remap)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [
              k,
              ["id", "root", "node", "source"].includes(k) && typeof v === "string"
                ? map(v)
                : remap(v),
            ]),
          )
        : value;
  project.nodes.push(...add.nodes);
  project.assemblies = [
    ...(project.assemblies ?? []),
    ...remap(add.assemblies ?? []),
  ];
  return { project, nodes: add.nodes.map((n) => n.id) };
}
