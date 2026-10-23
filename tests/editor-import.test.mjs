import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  createStore,
  emptyProject,
  evaluateProject,
  validateProject,
} from "../site/workshop/document.js";
import { loadKernel } from "../site/workshop/kernel.js";
import { importModel } from "../site/workshop/import-glb.js";
import {
  writeGLB,
  withWorkshopProject,
  parseModelFile,
  toBase64,
  fromBase64,
} from "../site/workshop/glb.js";
import { worldMatrix, point } from "../site/workshop/spatial.js";

before(() => loadKernel());

// A tiny glTF writer: meshes as { primitives: [{ positions, indices, material }] }.
function gltf({ nodes, meshes = [], materials, scene, extensions, ...extra }) {
  const chunks = [],
    accessors = [],
    bufferViews = [];
  let length = 0;
  const add = (array, type, componentType, target) => {
    const bytes = new Uint8Array(array.buffer.slice(0));
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, ...(target ? { target } : {}) });
    chunks.push(bytes);
    length += Math.ceil(bytes.length / 4) * 4;
    if (bytes.length % 4) chunks.push(new Uint8Array(4 - (bytes.length % 4)));
    return bufferViews.length - 1;
  };
  const gltfMeshes = meshes.map((mesh) => ({
    ...(mesh.name ? { name: mesh.name } : {}),
    primitives: mesh.primitives.map(({ positions, indices, material, mode, targets }) => {
      const flat = new Float32Array(positions.flat()),
        min = [0, 1, 2].map((k) => Math.min(...positions.map((p) => p[k]))),
        max = [0, 1, 2].map((k) => Math.max(...positions.map((p) => p[k])));
      accessors.push({ bufferView: add(flat, "VEC3", 5126, 34962), componentType: 5126, count: positions.length, type: "VEC3", min, max });
      const position = accessors.length - 1;
      let index;
      if (indices) {
        accessors.push({ bufferView: add(new Uint16Array(indices), "SCALAR", 5123, 34963), componentType: 5123, count: indices.length, type: "SCALAR" });
        index = accessors.length - 1;
      }
      return {
        attributes: { POSITION: position },
        ...(index !== undefined ? { indices: index } : {}),
        ...(material !== undefined ? { material } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(targets ? { targets } : {}),
      };
    }),
  }));
  const bin = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bin.set(chunk, offset);
    offset += chunk.length;
  }
  const json = {
    asset: { version: "2.0", generator: "test" },
    scene: 0,
    scenes: [scene ?? { nodes: nodes.map((_, i) => i).filter((i) => !nodes.some((n) => n.children?.includes(i))) }],
    nodes,
    ...(gltfMeshes.length ? { meshes: gltfMeshes } : {}),
    ...(materials ? { materials } : {}),
    accessors,
    bufferViews,
    buffers: [{ byteLength: length }],
    ...(extensions ? { extensions } : {}),
    ...extra,
  };
  return writeGLB(json, bin);
}
// A cube as exporters write it: 24 vertices (split per face), 12 triangles.
function cube(size = 1, material) {
  const h = size / 2,
    faces = [
      [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]],
      [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]],
      [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]],
      [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]],
      [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]],
      [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]],
    ];
  return {
    positions: faces.flat(),
    indices: faces.flatMap((_, f) => [0, 1, 2, 0, 2, 3].map((i) => f * 4 + i)),
    material,
  };
}
const world = (project, id, v) => point(worldMatrix(project, id), v);
const close = (a, b, eps = 1e-5) =>
  assert.ok(a.every((v, i) => Math.abs(v - b[i]) < eps), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

test("a split-vertex cube imports as one welded, closed mesh of six quads with its PBR material", () => {
  const bytes = gltf({
    nodes: [{ name: "crate_01", mesh: 0 }],
    meshes: [{ primitives: [cube(1, 0)] }],
    materials: [{ name: "mat_sage", pbrMetallicRoughness: { baseColorFactor: [0.2384, 0.4019, 0.2502, 1], metallicFactor: 0, roughnessFactor: 0.78 } }],
  });
  const { project, warnings, container } = importModel(bytes);
  assert.equal(container, false);
  assert.deepEqual(warnings, []);
  const p = evaluateProject(project),
    crate = p.nodes[0];
  assert.equal(crate.id, "crate_01");
  assert.equal(crate.mesh.vertices.length, 8);
  assert.deepEqual(crate.mesh.faces.map((f) => f.vertices.length), [4, 4, 4, 4, 4, 4]);
  assert.deepEqual(p.materials, [{ id: "mat_sage", name: "mat_sage", color: "#86aa89", roughness: 0.78 }]);
  const v = validateProject(p);
  assert.deepEqual(v.warnings.filter((w) => ["open-edges", "nonmanifold", "inward-shell"].includes(w.code)), []);
});

test("hierarchy, TRS and matrices land on the same world positions; names become IDs", () => {
  const s = Math.SQRT1_2;
  const bytes = gltf({
    nodes: [
      { name: "Car Body", translation: [1, 2, 3], rotation: [0, s, 0, s], children: [1, 2], mesh: 0 },
      { name: "wheel", scale: [2, 2, 2], translation: [0.5, 0, 0], mesh: 0 },
      { name: "车灯", matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1], mesh: 0 },
    ],
    meshes: [{ primitives: [cube(0.2)] }],
  });
  const p = evaluateProject(importModel(bytes).project);
  const ids = p.nodes.map((n) => n.id);
  assert.deepEqual(ids, ["Car_Body", "wheel", "node_2"]);
  assert.equal(p.nodes[2].name, "车灯");
  // Rotation of 90° about +Y maps +X to -Z.
  close(world(p, "Car_Body", [0.1, 0, 0]), [1, 2, 2.9]);
  close(world(p, "wheel", [0.1, 0, 0]), [1, 2, 3 - 0.5 - 0.2]);
  close(world(p, "node_2", [0, 0, 0]), [1, 3, 3]);
  // One mesh used three times: the first node owns it, the others are linked copies.
  assert.equal(p.nodes[1].instanceOf, "Car_Body");
  assert.equal(p.nodes[2].instanceOf, "Car_Body");
});

test("mirrored and sheared nodes are baked: world geometry and outward faces survive", () => {
  const bytes = gltf({
    nodes: [
      { name: "right", mesh: 0, translation: [1, 0, 0] },
      { name: "left", mesh: 0, scale: [-1, 1, 1], translation: [-1, 0, 0], children: [2] },
      { name: "child", mesh: 1, translation: [0.5, 0, 0] },
      { name: "sheared", mesh: 1, matrix: [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1] },
    ],
    meshes: [
      { primitives: [{ positions: [[0, 0, 0], [0.4, 0, 0], [0.4, 0.4, 0], [0, 0.4, 0], [0, 0, 0.4], [0.4, 0, 0.4], [0.4, 0.4, 0.4], [0, 0.4, 0.4]], indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5] }] },
      { primitives: [cube(0.2)] },
    ],
  });
  const p = evaluateProject(importModel(bytes).project);
  // The mirrored box occupies x ∈ [-1.4, -1]; its child sits at x = -1.5.
  const left = p.nodes.find((n) => n.id === "left");
  const xs = left.mesh?.vertices.map((v) => world(p, "left", v)[0]) ?? [];
  assert.ok(Math.abs(Math.min(...xs) + 1.4) < 1e-6 && Math.abs(Math.max(...xs) + 1) < 1e-6, JSON.stringify(xs));
  close(world(p, "child", [0, 0, 0]), [-1.5, 0, 0]);
  const v = validateProject(p);
  assert.deepEqual(v.warnings.filter((w) => ["inward-shell", "nonmanifold", "open-edges"].includes(w.code)), [], JSON.stringify(v.warnings));
  // The sheared part keeps its shape in world space: corner for corner.
  const shear = [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1],
    key = (v) => v.map((n) => n.toFixed(5)).join(","),
    expected = new Set([-0.1, 0.1].flatMap((x) => [-0.1, 0.1].flatMap((y) => [-0.1, 0.1].map((z) => key(point(shear, [x, y, z])))))),
    sheared = p.nodes.find((n) => n.id === "sheared"),
    actual = new Set(sheared.mesh.vertices.map((v) => key(world(p, "sheared", v))));
  assert.deepEqual([...actual].sort(), [...expected].sort());
});

test("coplanar triangles merge into polygons: a grid into one n-gon, an L into one concave face, a frame into a few", () => {
  // 2×2 grid of quads on y = 0, facing up.
  const grid = [];
  for (let z = 0; z <= 2; z++) for (let x = 0; x <= 2; x++) grid.push([x, 0, z]);
  const quads = [];
  for (let z = 0; z < 2; z++)
    for (let x = 0; x < 2; x++) {
      const a = z * 3 + x;
      quads.push(a, a + 3, a + 4, a, a + 4, a + 1);
    }
  const l = [[0, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 2, 0], [0, 2, 0]];
  const frameOuter = [[0, 0, 0], [3, 0, 0], [3, 3, 0], [0, 3, 0]],
    frameInner = [[1, 1, 0], [2, 1, 0], [2, 2, 0], [1, 2, 0]];
  const bytes = gltf({
    nodes: [{ name: "grid", mesh: 0 }, { name: "ell", mesh: 1 }, { name: "frame", mesh: 2 }],
    meshes: [
      { primitives: [{ positions: grid, indices: quads }] },
      { primitives: [{ positions: l, indices: [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5] }] },
      {
        primitives: [{
          positions: [...frameOuter, ...frameInner],
          indices: [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
        }],
      },
    ],
  });
  const p = evaluateProject(importModel(bytes).project),
    by = (id) => p.nodes.find((n) => n.id === id).mesh;
  assert.equal(by("grid").faces.length, 1);
  assert.equal(by("grid").faces[0].vertices.length, 8, "corners and shared edge midpoints");
  assert.equal(by("ell").faces.length, 1);
  assert.equal(by("ell").faces[0].vertices.length, 6);
  const frame = by("frame").faces;
  assert.ok(frame.length >= 2 && frame.length <= 4, `${frame.length} frame pieces`);
});

test("materials map KHR emission, transmission and blending; animation losses are reported", () => {
  const bytes = gltf({
    nodes: [{ name: "lamp", mesh: 0 }],
    meshes: [{
      primitives: [
        { ...cube(1, 0) },
        { ...cube(0.5, 1) },
        { ...cube(0.25, 2) },
        { ...cube(0.1, 3) },
      ],
    }],
    materials: [
      { name: "mat_light", emissiveFactor: [1, 0.8, 0.4], extensions: { KHR_materials_emissive_strength: { emissiveStrength: 6 } } },
      { name: "mat_glass", pbrMetallicRoughness: { baseColorFactor: [0.5, 0.6, 0.7, 0.4], metallicFactor: 0, roughnessFactor: 0.05 }, alphaMode: "BLEND", doubleSided: true, extensions: { KHR_materials_transmission: { transmissionFactor: 0.9 }, KHR_materials_ior: { ior: 1.45 } } },
      { name: "mat_steel", pbrMetallicRoughness: { baseColorFactor: [0.6, 0.6, 0.6, 1] } },
      { name: "flat", extensions: { KHR_materials_unlit: {} } },
    ],
    animations: [{ channels: [], samplers: [] }],
    extensionsUsed: ["KHR_materials_emissive_strength", "KHR_materials_transmission", "KHR_materials_ior", "KHR_materials_unlit"],
  });
  const { project, warnings } = importModel(bytes);
  const m = Object.fromEntries(project.materials.map((v) => [v.id, v]));
  assert.equal(m.mat_light.emissive, "#ffe7aa");
  assert.equal(m.mat_light.emissiveIntensity, 6);
  assert.equal(m.mat_light.metalness, 1, "glTF's default metallic factor is 1");
  assert.deepEqual(
    { opacity: m.mat_glass.opacity, transmission: m.mat_glass.transmission, ior: m.mat_glass.ior, doubleSided: m.mat_glass.doubleSided },
    { opacity: 0.4, transmission: 0.9, ior: 1.45, doubleSided: true },
  );
  assert.equal(m.flat.metalness, undefined);
  assert.deepEqual(warnings.map((w) => w.code).sort(), ["animations", "unlit"]);
  assert.ok(evaluateProject(project));
});

test("invalid skin data fails explicitly instead of importing an unbound mesh", () => {
  const bytes = gltf({ nodes: [{ mesh: 0, skin: 0 }], meshes: [{ primitives: [cube()] }],
    skins: [{ joints: [0] }] });
  assert.throws(() => importModel(bytes), e => e.code === "invalid_glb" &&
    e.path === "nodes.0" && /joint\/weight geometry/.test(e.message) && e.retryable === false);
});

test("compressed files, unknown required extensions and over-budget models are refused", () => {
  const base = { nodes: [{ mesh: 0 }], meshes: [{ primitives: [cube()] }] };
  assert.throws(() => importModel(gltf({ ...base, extensionsRequired: ["KHR_draco_mesh_compression"] })), (e) => e.code === "unsupported" && /Compressed/.test(e.message));
  assert.throws(() => importModel(gltf({ ...base, extensionsRequired: ["EXT_meshopt_compression"] })), /Compressed/);
  assert.throws(() => importModel(gltf({ ...base, extensionsRequired: ["VENDOR_magic"] })), /Unsupported required/);
  const many = gltf({ nodes: Array.from({ length: 600 }, () => ({})), meshes: [] });
  assert.throws(() => importModel(many), (e) => e.code === "budget");
  assert.throws(() => importModel(new Uint8Array([1, 2, 3, 4])), /Not a GLB/);
});

test("a workshop project file restores the exact editable project, recipes included", () => {
  const store = createStore(emptyProject("Stool"));
  store.apply([
    { op: "create", id: "seat", kind: "box", options: { size: [0.4, 0.05, 0.4], bevel: 0.01 } },
    { op: "create", id: "leg", kind: "cylinder", position: [0.15, -0.2, 0.15], options: { radius: 0.02, height: 0.4 } },
    { op: "duplicate", id: "leg", newId: "leg_2", linked: true, offset: [-0.3, 0, 0] },
  ]);
  const project = store.snapshot(),
    plain = gltf({ nodes: [{ name: "seat", mesh: 0 }], meshes: [{ primitives: [cube(0.4)] }] }),
    file = withWorkshopProject(plain, project);
  // Viewers see an ordinary model; the extension is used, never required.
  const { json } = parseModelFile(file);
  assert.ok(json.extensionsUsed.includes("FUNDEV_workshop"));
  assert.equal(json.extensionsRequired, undefined);
  const result = importModel(fromBase64(toBase64(file)));
  assert.equal(result.container, true);
  assert.deepEqual(evaluateProject(result.project), evaluateProject(project));
});

test("adding parts keeps existing ones: clashing IDs and materials get suffixes, roots go under parent", () => {
  const current = createStore(emptyProject("Scene"));
  current.apply([
    { op: "create", id: "base", kind: "group" },
    { op: "create", id: "crate_01", kind: "box", parent: "base" },
    { op: "material", id: "mat_sage", color: "#ff0000" },
  ]);
  const bytes = gltf({
    nodes: [{ name: "crate_01", mesh: 0, children: [1] }, { name: "lid", mesh: 0, translation: [0, 1, 0] }],
    meshes: [{ primitives: [cube(1, 0)] }],
    materials: [{ name: "mat_sage", pbrMetallicRoughness: { baseColorFactor: [0.2384, 0.4019, 0.2502, 1], metallicFactor: 0 } }],
  });
  const result = importModel(bytes, { mode: "add", parent: "base", current: current.snapshot() });
  assert.deepEqual(result.nodes, ["crate_01-2", "lid"]);
  const p = evaluateProject(result.project);
  const added = p.nodes.find((n) => n.id === "crate_01-2"),
    lid = p.nodes.find((n) => n.id === "lid");
  assert.equal(added.parent, "base");
  assert.equal(lid.parent, "crate_01-2");
  assert.equal(lid.instanceOf, "crate_01-2");
  assert.ok(p.materials.some((m) => m.id === "mat_sage-2" && m.color === "#86aa89"));
  assert.equal(p.materials.find((m) => m.id === "mat_sage").color, "#ff0000");
  assert.ok(added.mesh.faces.every((f) => f.material === "mat_sage-2"));
  assert.throws(() => importModel(bytes, { mode: "add", parent: "nope", current: current.snapshot() }), /Unknown parent/);
});

test('high-poly import reduces geometry while retaining materials, parts and instances', async () => {
  const { MeshoptSimplifier } = await import('meshoptimizer');
  const { SphereGeometry } = await import('three');
  await MeshoptSimplifier.ready;
  const low = gltf({ nodes: [{ mesh: 0 }], meshes: [{ primitives: [{
    positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], indices: [0, 1, 2],
  }] }] });
  assert.deepEqual(importModel(low, { simplifier: MeshoptSimplifier }), importModel(low));
  const sphere = new SphereGeometry(1, 180, 160);
  const p = sphere.attributes.position.array;
  const positions = Array.from({ length: p.length / 3 }, (_, i) => Array.from(p.slice(i * 3, i * 3 + 3)));
  const bytes = gltf({
    nodes: [{ name: 'assembly', children: [1, 2] }, { name: 'head', mesh: 0 }, { name: 'copy', mesh: 0, translation: [3, 0, 0] }],
    meshes: [{ primitives: [{ positions, indices: Array.from(sphere.index.array), material: 0 }] }],
    materials: [{ name: 'gold', pbrMetallicRoughness: { baseColorFactor: [1, .5, 0, 1] } }],
  });
  // Within the dense budget the sphere comes in as it is: a dense part, nothing reduced.
  const whole = importModel(bytes);
  assert.ok(evaluateProject(whole.project).nodes[1].mesh.dense, 'dense');
  assert.ok(!whole.warnings.some(w => w.code === 'simplified'));
  // Asked for a smaller budget, it is refused without a simplifier and reduced with one.
  const budget = { triangles: 50000, vertices: 30000 };
  assert.throws(() => importModel(bytes, { budget }), { code: 'budget' });
  const { project, warnings } = importModel(bytes, { simplifier: MeshoptSimplifier, budget });
  assert.equal(project.nodes.length, 3);
  assert.equal(project.nodes[1].parent, 'assembly');
  assert.equal(project.nodes[2].instanceOf, 'head');
  assert.deepEqual(project.nodes[2].position, [3, 0, 0]);
  const mesh = project.nodes[1].mesh;
  assert.ok(mesh.faces.length > 100 && mesh.faces.length < 4501);
  assert.ok(mesh.faces.every(f => f.material === 'gold'));
  assert.ok(mesh.vertices.every(p => Math.abs(Math.hypot(...p) - 1) < .02));
  assert.ok(warnings.some(w => w.code === 'simplified'));
  const stored = withWorkshopProject(bytes, project);
  assert.deepEqual(importModel(stored, { simplifier: MeshoptSimplifier, budget }).project, JSON.parse(JSON.stringify(project)));
});
