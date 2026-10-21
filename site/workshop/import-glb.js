// Any GLB becomes editable workshop parts: its node hierarchy and names, flat-colour PBR
// materials, and polygons recovered from triangles (coplanar, edge-connected regions of one
// material). Deforming meshes retain vertex correspondence. A workshop project
// file restores its full editable project; unsupported runtime data is reported explicitly.
import { ModelError, sub, cross, dot, triangulate } from "./mesh.js";
import { polygonize } from "./solid.js";
import { setMatrix, determinant, decompose } from "./spatial.js";
import { normalizeMaterial, visitMaterials } from "./materials.js";
import { FORMAT, VERSION, LIMITS, emptyProject } from "./document.js";
import { DENSE_FROM } from "./dense.js";
import { remapRecipeReferences } from "./recipe.js";
import { parseModelFile, workshopProject } from "./glb.js";
import { connectivityToken } from "./components.js";
import { mergeDesignReferences } from "./design-references.js";
import { readSkinWeights, importSkins } from "./import-skin.js";
import { importAnimations } from "./import-animation.js";

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
  { mode = "replace", parent = null, current = null, name, simplifier, budget } = {},
) {
  if (!["replace", "add"].includes(mode))
    fail("Expected replace or add mode", "schema", "mode");
  const { json, buffers } = parseModelFile(bytes);
  const stored = workshopProject(json, buffers);
  const { project: incoming, warnings, processing = [] } = stored
    ? { project: stored, warnings: [] }
    : projectFromGLTF(json, buffers, { name, simplifier, budget });
  if (mode === "replace")
    return {
      project: incoming,
      nodes: incoming.nodes.map((n) => n.id),
      warnings,
      processing,
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
export function editableMesh(positions, triangles, materials, report) {
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
  const result = polygonize(points, tris, group.map(String), materials);
  if (report) {
    const collapsed = tris.filter(t => new Set(t).size < 3).length;
    const outputTriangles = result.faces.reduce((n, f) => n + triangulate(result.vertices, f.vertices).length, 0);
    report({ inputVertices: positions.length, weldedVertices: points.length, outputVertices: result.vertices.length,
      inputTriangles: triangles.length, collapsedAfterWeld: collapsed, outputTriangles,
      polygonizationTriangleDelta: triangles.length - collapsed - outputTriangles,
      note: "Coplanar regions lose internal subdivision edges/vertices; compare surfaces and bounds, not triangle counts alone." });
  }
  return result;
}

// Smooth shading of an imported mesh, read from its normals: an edge is smooth where the
// normals on both sides agree at both ends. The crease angle is just above the sharpest
// smooth edge (95th percentile, so stray edges do not decide); 0 when the mesh is flat.
export function importedSmoothing(positions, triangles, normals) {
  if (!normals) return 0;
  const weld = new Map(),
    id = (i) => {
      const key = positions[i].map((v) => Math.round(v * 1e6)).join(",");
      if (!weld.has(key)) weld.set(key, weld.size);
      return weld.get(key);
    };
  const faceNormal = triangles.map(([a, b, c]) => {
    const n = cross(sub(positions[b], positions[a]), sub(positions[c], positions[a])),
      length = Math.hypot(...n);
    return length > 1e-14 ? n.map((v) => v / length) : null;
  });
  const edges = new Map();
  triangles.forEach((t, f) => {
    if (!faceNormal[f]) return;
    t.forEach((a, k) => {
      const b = t[(k + 1) % 3],
        [wa, wb] = [id(a), id(b)],
        key = wa < wb ? `${wa}:${wb}` : `${wb}:${wa}`;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push({ f, at: new Map([[wa, a], [wb, b]]) });
    });
  });
  const same = (u, v) => dot(u, v) > 0.9998; // about 1°
  const smooth = [];
  let hard = 0;
  for (const [key, sides] of edges) {
    if (sides.length !== 2) continue;
    const [x, y] = sides,
      angle = (Math.acos(Math.max(-1, Math.min(1, dot(faceNormal[x.f], faceNormal[y.f])))) * 180) / Math.PI;
    if (angle < 0.5) continue;
    const ends = key.split(":").map(Number);
    if (ends.every((w) => same(normals[x.at.get(w)], normals[y.at.get(w)]))) smooth.push(angle);
    else hard++;
  }
  if (!smooth.length || smooth.length < 0.05 * (smooth.length + hard)) return 0;
  smooth.sort((a, b) => a - b);
  return Math.min(180, Math.ceil(smooth[Math.floor(0.95 * (smooth.length - 1))]) + 1);
}

// budget: { triangles, vertices } a model may bring in unreduced; by default what dense meshes
// may hold (document.js LIMITS), so scans and sculpts up to that size import as they are.
function projectFromGLTF(json, buffers, { name, simplifier, budget } = {}) {
  const processing = [];
  budget = { triangles: budget?.triangles ?? LIMITS.denseTriangles, vertices: budget?.vertices ?? LIMITS.denseVertices };
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
  if (json.cameras?.length) warn("cameras", "Cameras were not imported");
  if (json.extensions?.KHR_lights_punctual?.lights?.length)
    warn("lights", "Lights were not imported");
  const read = accessorReader(json, buffers);
  const animatedIndices = new Set((json.animations ?? []).flatMap(a => (a.channels ?? []).map(c => c.target?.node)));

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

  // Include instances in the budget, just as the final project budget does. Counting
  // unused nodes is conservative; their geometry is still never imported.
  const primitiveCount = (p) => {
    const count = json.accessors?.[p.indices ?? p.attributes?.POSITION]?.count ?? 0;
    return (p.mode ?? 4) === 4 ? Math.floor(count / 3) : [5, 6].includes(p.mode) ? Math.max(0, count - 2) : 0;
  };
  let sourceTriangles = 0, sourceVertices = 0;
  const primitiveCounts = [];
  for (const node of json.nodes ?? []) {
    for (const p of json.meshes?.[node.mesh]?.primitives ?? []) {
      sourceTriangles += primitiveCount(p);
      if (primitiveCount(p)) primitiveCounts.push(primitiveCount(p));
      sourceVertices += json.accessors?.[p.attributes?.POSITION]?.count ?? 0;
    }
  }
  const reduce = simplifier && (sourceTriangles > budget.triangles || sourceVertices > budget.vertices);
  // Even fully disconnected triangles fit the editable vertex budget.
  const targetTriangles = Math.floor(Math.min(budget.triangles, budget.vertices / 3) * .9);
  const minimum = Math.min(128, Math.floor(targetTriangles / Math.max(1, primitiveCounts.length)));
  const reserved = primitiveCounts.reduce((sum, n) => sum + Math.min(minimum, n), 0);
  const meshes = new Map();
  const meshFor = (index) => {
    if (meshes.has(index)) return meshes.get(index);
    const mesh = json.meshes?.[index] ?? fail(`Missing mesh ${index}`);
    const positions = [],
      normals = [],
      triangles = [],
      triangleMaterials = [];
    const morphCount = Math.max(0, ...(mesh.primitives ?? []).map(p => p.targets?.length ?? 0));
    const hasSkin = (mesh.primitives ?? []).some(p => p.attributes?.JOINTS_0 !== undefined || p.attributes?.WEIGHTS_0 !== undefined);
    if (hasSkin && reduce) fail("Skin import requires lossless vertex correspondence; reduce the source explicitly before import", "budget");
    const skinWeights = [];
    if (morphCount > 128 || (morphCount && reduce)) fail("Morph import exceeds target budget or requires lossy reduction", "budget");
    const morphDeltas = Array.from({ length: morphCount }, () => []);
    let withNormals = true;
    for (const primitive of mesh.primitives ?? []) {
      const mode = primitive.mode ?? 4;
      if (![4, 5, 6].includes(mode)) {
        warn("primitives", "Line and point primitives were skipped");
        continue;
      }
      if (primitive.extensions?.KHR_draco_mesh_compression)
        fail("Compressed files are not supported yet; export the model uncompressed", "unsupported");
      if (morphCount && primitive.targets?.length !== morphCount)
        fail("All material primitives must have matching morph target counts", "invalid_glb");
      if (primitive.attributes?.POSITION === undefined) continue;
      let p = read(primitive.attributes.POSITION);
      const count = p.length / 3;
      if (!Number.isInteger(count) || count > 4_000_000)
        fail("A source primitive exceeds the import vertex budget", "budget");
      if ((morphCount || hasSkin) && positions.length + count > DENSE_FROM)
        fail("Deforming import exceeds the editable vertex budget; no skin/morph attributes were discarded", "budget");
      if (hasSkin) skinWeights.push(...readSkinWeights(json, read, primitive, count, `meshes.${index}.weights`));
      let n = primitive.attributes.NORMAL !== undefined ? read(primitive.attributes.NORMAL) : null;
      if (n && n.length !== p.length) fail("Normal and position counts differ");
      const rawIndices = primitive.indices !== undefined
        ? read(primitive.indices)
        : Float64Array.from({ length: count }, (_, i) => i);
      if (rawIndices.some((i) => !Number.isInteger(i) || i < 0 || i >= count))
        fail(`Mesh ${index} has an index outside its vertices`);
      let indices;
      if (mode === 4) indices = Uint32Array.from(rawIndices.slice(0, Math.floor(rawIndices.length / 3) * 3));
      else {
        indices = new Uint32Array(Math.max(0, rawIndices.length - 2) * 3);
        for (let i = 0; i + 2 < rawIndices.length; i++)
          indices.set(mode === 6 ? [rawIndices[0], rawIndices[i + 1], rawIndices[i + 2]]
            : i % 2 ? [rawIndices[i + 1], rawIndices[i], rawIndices[i + 2]]
            : [rawIndices[i], rawIndices[i + 1], rawIndices[i + 2]], i * 3);
      }
      if (reduce && indices.length) {
        const budget = Math.max(1, Math.min(minimum, indices.length / 3) + Math.floor((targetTriangles - reserved) * (indices.length / 3) / sourceTriangles)) * 3;
        const flat = Float32Array.from(p);
        // Weld position seams before reduction; each material primitive stays separate.
        const remap = simplifier.generatePositionRemap(flat, 3);
        indices = Uint32Array.from(indices, (i) => remap[i]);
        if (indices.length > budget) {
          [indices] = simplifier.simplify(indices, flat, 3, budget, .01);
          if (indices.length > budget)
            fail(`Cannot fit mesh ${index} (${indices.length / 3} triangles, target ${budget / 3}) into the workshop within 1% geometric error; simplify or split the source model`, "budget");
        }
        const compact = new Map(), positionsOut = [], normalsOut = [];
        indices = Uint32Array.from(indices, (i) => {
          if (!compact.has(i)) {
            compact.set(i, compact.size);
            positionsOut.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
            if (n) normalsOut.push(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]);
          }
          return compact.get(i);
        });
        p = positionsOut;
        n = n ? normalsOut : null;
      }
      const base = positions.length;
      for (let i = 0; i < p.length; i += 3) positions.push([p[i], p[i + 1], p[i + 2]]);
      for (let t = 0; t < morphCount; t++) {
        const attribute = primitive.targets[t].POSITION;
        const delta = attribute === undefined ? new Float64Array(p.length) : read(attribute);
        if (delta.length !== p.length) fail("Morph and base position counts differ", "invalid_glb");
        for (let i = 0; i < delta.length; i += 3) morphDeltas[t].push([delta[i], delta[i + 1], delta[i + 2]]);
      }
      if (n) {
        for (let i = 0; i < n.length; i += 3) {
          const v = [n[i], n[i + 1], n[i + 2]], length = Math.hypot(...v) || 1;
          normals.push(v.map((x) => x / length));
        }
      } else withNormals = false;
      const material = materialFor(primitive.material);
      for (let i = 0; i < indices.length; i += 3) {
        triangles.push([base + indices[i], base + indices[i + 1], base + indices[i + 2]]);
        triangleMaterials.push(material);
      }
    }
    // Merging into polygons rarely removes more than a few triangles: far larger meshes are
    // refused before the work.
    if (triangles.length > budget.triangles * 2)
      fail(
        `Mesh ${mesh.name ?? index} has ${triangles.length} triangles; the workshop keeps at most ${budget.triangles}`,
        "budget",
      );
    const result = triangles.length
      ? morphCount || hasSkin ? { vertices: positions, faces: triangles.map((vertices, i) => ({ id: `f${i}`, vertices, material: triangleMaterials[i] })) }
        : editableMesh(positions, triangles, triangleMaterials, r => processing.push({ mesh: mesh.name ?? index, ...r }))
      : null;
    if (result && (morphCount || hasSkin) && (positions.length > DENSE_FROM || triangles.length > DENSE_FROM))
      fail("Deforming imports must fit the editable polygon budget; dense conversion would discard authoring correspondence", "budget");
    if (result && hasSkin) result.skinWeights = skinWeights;
    if (result && morphCount) {
      if (positions.length > LIMITS.vertices || positions.length * morphCount > 1_000_000)
        fail("Editable morph import exceeds polygon/target vertex budget", "budget");
      const taken = new Set();
      const names = morphDeltas.map((_, i) => uniqueId(mesh.extras?.targetNames?.[i], taken, `target_${i}`));
      result.morph = { version: 1, connectivity: connectivityToken(result), base: structuredClone(positions),
        targets: morphDeltas.map((deltas, i) => ({ name: names[i], deltas })),
        weights: Object.fromEntries(names.map((name, i) => [name, mesh.weights?.[i] ?? 0])) };
      processing.push({ mesh: mesh.name ?? index, preservedMorphTargets: names, vertexWelding: false,
        reason: "Preserve morph vertex correspondence across material/normal seams" });
    }
    if (result) result.smooth = importedSmoothing(positions, triangles, withNormals ? normals : null);
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
  const sockets = new Map();
  const nodesByIndex = new Map(), weightsByNode = new Map();
  const jointIndices = new Set((json.skins ?? []).flatMap(s => s?.joints ?? []));
  const visit = (index, parent, path) => {
    if (path.has(index)) fail("The node hierarchy has a cycle");
    if (nodesByIndex.has(index)) fail(`Node ${index} has multiple parents in the imported scene`);
    const g = json.nodes?.[index] ?? fail(`Missing node ${index}`),
      raw = g.name ?? json.meshes?.[g.mesh]?.name;
    // An empty named socket_<name> is its parent's socket (docs/worlds.md §4), not a part.
    if (parent && !animatedIndices.has(index) && !jointIndices.has(index) && !g.extras?.workshopJoint && typeof raw === "string" && /^socket_[A-Za-z0-9_-]{1,64}$/.test(raw) && g.mesh === undefined && !(g.children ?? []).length) {
      const frame = decompose(localMatrix(g));
      if (frame) {
        const list = sockets.get(parent) ?? {};
        list[raw.slice(7)] = { position: frame.position, rotation: frame.rotation, tags: Array.isArray(g.extras?.tags) ? g.extras.tags.filter((t) => typeof t === "string").slice(0, 16) : [] };
        sockets.set(parent, list);
      }
      return;
    }
    const id = uniqueId(raw, used, `node_${index}`),
      node = {
        id,
        name: label(raw, id),
        parent,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        mesh: null,
      };
    if (g.mesh !== undefined && meshFor(g.mesh)) {
      // A mesh used by several nodes becomes linked copies of its first node.
      if (sources.has(g.mesh) && !animatedIndices.has(index) && !meshFor(g.mesh).morph && !meshFor(g.mesh).skinWeights && g.skin === undefined) node.instanceOf = sources.get(g.mesh);
      else {
        sources.set(g.mesh, id);
        const { smooth, morph, skinWeights, ...mesh } = meshFor(g.mesh);
        node.mesh = structuredClone(mesh);
        if (skinWeights) weightsByNode.set(id, skinWeights);
        if (morph) {
          node.morph = structuredClone(morph);
          if (g.weights) node.morph.weights = Object.fromEntries(morph.targets.map((t, i) => [t.name, g.weights[i] ?? 0]));
        }
        if (smooth) node.smooth = smooth;
      }
    }
    nodes.push(node);
    nodesByIndex.set(index, node);
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
  const rigNodes = new Set([...nodesByIndex].filter(([index]) =>
    json.nodes[index].skin !== undefined || animatedIndices.has(index) || jointIndices.has(index) || json.nodes[index].extras?.workshopJoint).map(([, n]) => n.id));
  for (const node of order) {
    const m = matrices.get(node.id);
    if (!decompose(m) && nodes.some(n => {
      if (!n.morph && !rigNodes.has(n.id)) return false;
      let ancestor = n;
      while (ancestor) {
        if (ancestor.id === node.id) return true;
        ancestor = nodes.find(p => p.id === ancestor.parent);
      }
      return false;
    })) fail("Morph/skin/animation import requires positive, shear-free node transforms", "unsupported");
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
  for (const [id, frames] of sockets) {
    const node = nodes.find((n) => n.id === id);
    if (node) node.sockets = frames;
  }
  importSkins(json, read, nodesByIndex, weightsByNode, processing);
  const character = importAnimations(json, read, nodesByIndex, processing, warn);

  let triangleCount = 0,
    vertexCount = 0,
    denseTriangles = 0,
    denseVertices = 0;
  // Meshes with more than DENSE_FROM faces or vertices become dense (their faces run f0, f1, …
  // from polygonize) and count against the dense budget; the rest against the polygon one.
  for (const node of nodes) {
    const mesh = node.mesh ?? nodes.find((n) => n.id === node.instanceOf)?.mesh;
    if (!mesh) continue;
    const triangles = mesh.faces.reduce((n, f) => n + f.vertices.length - 2, 0);
    if (mesh.faces.length > DENSE_FROM || mesh.vertices.length > DENSE_FROM) {
      denseVertices += mesh.vertices.length;
      denseTriangles += triangles;
    } else {
      vertexCount += mesh.vertices.length;
      triangleCount += triangles;
    }
  }
  if (triangleCount > LIMITS.triangles || vertexCount > LIMITS.vertices)
    fail(
      `This model has ${triangleCount} triangles and ${vertexCount} editable vertices in its smaller parts; the workshop keeps at most ${LIMITS.triangles} and ${LIMITS.vertices} there`,
      "budget",
    );
  if (denseTriangles + triangleCount > budget.triangles || denseVertices + vertexCount > budget.vertices)
    fail(
      `This model has ${denseTriangles + triangleCount} triangles and ${denseVertices + vertexCount} editable vertices; the workshop keeps at most ${budget.triangles} and ${budget.vertices}`,
      "budget",
    );
  triangleCount += denseTriangles;
  if (reduce) warn("simplified", `High-poly model reduced for editing: ${sourceTriangles} source triangles → ${triangleCount} editable triangles. Original file unchanged.`);
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
      ...(character ? { character } : {}),
    },
    warnings: [...warnings.values()],
    processing,
  };
}

/** Adds another project's parts: clashing node and material IDs get suffixes. */
/**
 * A GLB as Three.js objects for display: the node tree with its names and transforms and
 * triangle meshes with flat-colour materials from `material(desc)` (a workshop material).
 * Placed library models draw through this in the workshop (docs/worlds.md); no project limit
 * applies, and skins, animations and textures are ignored.
 */
export function glbToObject(bytes, { THREE, material: makeMaterial }) {
  const { json, buffers } = parseModelFile(bytes);
  const read = accessorReader(json, buffers);
  const materials = new Map();
  const materialFor = (index) => {
    const key = index ?? -1;
    if (!materials.has(key)) {
      const source =
        index === undefined ? { name: "default" } : (json.materials?.[index] ?? fail(`Missing material ${index}`));
      materials.set(key, makeMaterial(convertMaterial(source, `material_${key < 0 ? "default" : key}`, () => {})));
    }
    return materials.get(key);
  };
  const meshes = new Map();
  let triangles = 0;
  const meshFor = (index) => {
    if (meshes.has(index)) return meshes.get(index);
    const mesh = json.meshes?.[index] ?? fail(`Missing mesh ${index}`);
    const parts = [];
    for (const primitive of mesh.primitives ?? []) {
      const mode = primitive.mode ?? 4;
      if (![4, 5, 6].includes(mode) || primitive.attributes?.POSITION === undefined) continue;
      if (primitive.extensions?.KHR_draco_mesh_compression)
        fail("Compressed files are not supported; export the model uncompressed", "unsupported");
      const p = read(primitive.attributes.POSITION),
        count = p.length / 3;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(Float32Array.from(p), 3));
      if (primitive.attributes.NORMAL !== undefined)
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(Float32Array.from(read(primitive.attributes.NORMAL)), 3));
      const indices =
        primitive.indices !== undefined ? read(primitive.indices) : Float64Array.from({ length: count }, (_, i) => i);
      const list = [];
      if (mode === 4) for (let i = 0; i + 2 < indices.length; i += 3) list.push(indices[i], indices[i + 1], indices[i + 2]);
      else if (mode === 5)
        for (let i = 0; i + 2 < indices.length; i++)
          list.push(...(i % 2 ? [indices[i + 1], indices[i], indices[i + 2]] : [indices[i], indices[i + 1], indices[i + 2]]));
      else for (let i = 1; i + 1 < indices.length; i++) list.push(indices[0], indices[i], indices[i + 1]);
      if (list.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) fail(`Mesh ${index} has an index outside its vertices`);
      if (!list.length) continue;
      geometry.setIndex(
        count > 65535 ? new THREE.Uint32BufferAttribute(Uint32Array.from(list), 1) : new THREE.Uint16BufferAttribute(Uint16Array.from(list), 1),
      );
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      triangles += list.length / 3;
      parts.push({ geometry, material: materialFor(primitive.material) });
    }
    meshes.set(index, parts);
    return parts;
  };
  const root = new THREE.Group();
  const visited = new Set();
  const socketEmpties = [];
  const build = (index, parent) => {
    if (visited.has(index)) fail("Node cycle");
    visited.add(index);
    const node = json.nodes?.[index] ?? fail(`Missing node ${index}`);
    const object = new THREE.Group();
    object.name = typeof node.name === "string" && node.name ? node.name : `node_${index}`;
    object.applyMatrix4(new THREE.Matrix4().fromArray(localMatrix(node)));
    parent.add(object);
    if (/^socket_[A-Za-z0-9_-]{1,64}$/.test(object.name) && node.mesh === undefined && !(node.children ?? []).length) {
      socketEmpties.push({ object, tags: Array.isArray(node.extras?.tags) ? node.extras.tags.filter((t) => typeof t === "string").slice(0, 16) : [] });
      return;
    }
    if (node.mesh !== undefined)
      for (const part of meshFor(node.mesh)) {
        const m = new THREE.Mesh(part.geometry, part.material);
        m.castShadow = m.receiveShadow = true;
        object.add(m);
      }
    for (const child of node.children ?? []) build(child, object);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  for (const index of scene?.nodes ?? []) build(index, root);
  root.updateMatrixWorld(true);
  // Sockets in the model's space, as the workshop keeps them (degrees).
  const sockets = {};
  for (const { object, tags } of socketEmpties) {
    const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
    object.matrixWorld.decompose(position, quaternion, scale);
    const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
    sockets[object.name.slice(7)] = {
      position: position.toArray().map((v) => Math.round(v * 1e6) / 1e6),
      rotation: [euler.x, euler.y, euler.z].map((v) => Math.round(THREE.MathUtils.radToDeg(v) * 1e4) / 1e4),
      tags,
    };
    object.removeFromParent();
  }
  const box = new THREE.Box3().setFromObject(root, true);
  return {
    root,
    triangles,
    sockets,
    bounds: box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() },
    dispose() {
      for (const parts of meshes.values()) for (const part of parts) part.geometry.dispose();
      for (const m of materials.values()) m.dispose();
    },
  };
}

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
    if (n.attachment) {
      n.attachment.target = map(n.attachment.target);
      if (n.attachment.mirror) n.attachment.mirror.source = map(n.attachment.mirror.source);
    }
    if (n.skin) n.skin.joints = n.skin.joints.map(map);
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
  if (add.viewPresets?.length) {
    const used = new Set((project.viewPresets ?? []).map(p => p.id));
    project.viewPresets = [...(project.viewPresets ?? []), ...add.viewPresets.map(p => ({
      ...p, id: uniqueId(p.id, used, "view"), ...(p.ids ? { ids: p.ids.map(map) } : {}),
    }))];
  }
  if (add.designReferences) project.designReferences = mergeDesignReferences(project.designReferences, add.designReferences);
  if (add.relations?.length) {
    const used = new Set((project.relations ?? []).map(r => r.id));
    project.relations = [...(project.relations ?? []), ...add.relations.map(r => ({
      ...r, id: uniqueId(r.id, used, "relation"), source: map(r.source), target: map(r.target),
    }))];
  }
  if (add.character) {
    if (add.character.pose || project.character?.pose)
      fail("Clear character clip previews before combining editable character projects", "dependency");
    const c = project.character ??= { version: 1, controls: [], values: {}, rest: {}, clips: [] };
    c.version = Math.max(c.version, add.character.version);
    const controls = new Set(c.controls.map(x => x.id)), clips = new Set(c.clips.map(x => x.name));
    const names = new Map(add.character.controls.map(x => [x.id, uniqueId(x.id, controls, "control")]));
    c.controls.push(...add.character.controls.map(x => ({ ...x, id: names.get(x.id),
      bindings: x.bindings.map(b => ({ ...b, node: map(b.node),
        ...(b.attenuateBy === undefined ? {} : { attenuateBy: names.get(b.attenuateBy) }) })) })));
    Object.assign(c.values, Object.fromEntries(Object.entries(add.character.values).map(([id, value]) => [names.get(id), value])));
    Object.assign(c.rest, Object.fromEntries(Object.entries(add.character.rest).map(([id, value]) => [map(id), value])));
    c.clips.push(...add.character.clips.map(x => ({ ...x, name: uniqueId(x.name, clips, "clip"),
      tracks: x.tracks.map(t => t.control ? { ...t, control: names.get(t.control) } : { ...t, node: map(t.node) }) })));
  }
  project.assemblies = [
    ...(project.assemblies ?? []),
    ...remap(add.assemblies ?? []),
  ];
  // The added file's own library sources come with its parts.
  const sources = [...(project.sources ?? []), ...(incoming.sources ?? [])].filter(
    (s, i, all) => all.findIndex((o) => o.kind === s.kind && o.id === s.id && o.version === s.version) === i,
  );
  if (sources.length) project.sources = sources;
  return { project, nodes: add.nodes.map((n) => n.id) };
}
