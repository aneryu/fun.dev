import * as THREE from "/runtime/three.js";
import { WebGPURenderer } from "/vendor/three/three.webgpu.js";
import {
  OrbitControls,
  TransformControls,
  GLTFExporter,
  mergeGeometries,
} from "/workshop/tools.js";
import { evaluateCommands, selectionVertices } from "./document.js";
import {
  exportScope,
  assertExportable,
  exportValidation,
} from "./export-scope.js";
import { bindingFor } from "./assembly.js";
import { meshEdges } from "./topology.js";
import { normal, triangulate, cornerNormals } from "./mesh.js";
import { nameMeshes } from "./glb.js";
import { createSoftRenderer } from "./soft-renderer.js";
import { nodePoints } from "./spatial.js";
import { placedTemplate, ensurePlaced } from "./placed.js";
import { terrainMesh, terrainBounds, hexToLinear } from "../runtime/kit/terrain.js";

function indexAttributes(positions, normals) {
  const uniquePositions = [],
    uniqueNormals = [],
    indices = [],
    lookup = new Map();
  for (let i = 0; i < positions.length; i += 3) {
    const key = [...positions.slice(i, i + 3), ...normals.slice(i, i + 3)]
      .map((n) => Math.fround(n))
      .join(",");
    if (!lookup.has(key)) {
      lookup.set(key, uniquePositions.length / 3);
      uniquePositions.push(...positions.slice(i, i + 3));
      uniqueNormals.push(...normals.slice(i, i + 3));
    }
    indices.push(lookup.get(key));
  }
  return { positions: uniquePositions, normals: uniqueNormals, indices };
}

// The same material drives the viewport and the GLB: metallic-roughness PBR, emission
// (KHR_materials_emissive_strength above 1), blended opacity, and glass through
// KHR_materials_transmission/ior on a physical material.
export function createMaterial(m) {
  const options = {
    name: m.id,
    color: m.color,
    roughness: m.roughness,
    metalness: m.metalness ?? 0,
    ...(m.emissive
      ? { emissive: m.emissive, emissiveIntensity: m.emissiveIntensity ?? 1 }
      : {}),
    ...((m.opacity ?? 1) < 1
      ? { transparent: true, opacity: m.opacity, depthWrite: false }
      : {}),
    ...(m.doubleSided ? { side: THREE.DoubleSide } : {}),
  };
  return m.transmission
    ? new THREE.MeshPhysicalMaterial({
        ...options,
        transmission: m.transmission,
        ior: m.ior ?? 1.5,
        thickness: 0,
      })
    : new THREE.MeshStandardMaterial(options);
}

// Ambient light as a sky above a ground: on painted surfaces it is exactly a hemisphere
// light, and as an environment it gives metal and glass something to reflect (without
// one, full metal renders black). The library's stage does the same (site/model-viewer.js).
function sky(renderer, top, bottom, intensity) {
  const scene = new THREE.Scene(),
    parts = [];
  for (const [color, start] of [
    [top, 0],
    [bottom, Math.PI / 2],
  ]) {
    const geometry = new THREE.SphereGeometry(
        1,
        32,
        8,
        0,
        Math.PI * 2,
        start,
        Math.PI / 2,
      ),
      material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(intensity / Math.PI),
        side: THREE.DoubleSide,
      });
    scene.add(new THREE.Mesh(geometry, material));
    parts.push(geometry, material);
  }
  const generator = new THREE.PMREMGenerator(renderer),
    target = generator.fromScene(scene, 0, 0.1, 10, { size: 128 });
  generator.dispose();
  parts.forEach((part) => part.dispose());
  return target;
}

// Scene parts without a mesh (docs/worlds.md) draw as overlays in the workshop: a marker's
// cross, a zone's outline, a path's line, a placed model's bounds until its template loads.
// Overlays draw over everything (no depth test), are never picked by rays and never exported.
const OVERLAY = { marker: 0x27ae60, zone: 0x2d9cdb, path: 0xe67e22, placeholder: 0x8e44ad };
function overlayLines(points, color) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
  const lines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }),
  );
  lines.renderOrder = 10;
  lines.userData = { overlay: true };
  return lines;
}
const boxEdges = (size, center = [0, 0, 0]) => {
  const [w, h, d] = size,
    [cx, cy, cz] = center,
    c = (i) => [cx + (i & 1 ? w / 2 : -w / 2), cy + (i & 2 ? h / 2 : -h / 2), cz + (i & 4 ? d / 2 : -d / 2)];
  const pairs = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  return pairs.flatMap(([a, b]) => [c(a), c(b)]);
};
function markerOverlay() {
  const s = 0.15;
  return overlayLines([[-s, 0, 0], [s, 0, 0], [0, 0, -s], [0, 0, s], [0, 0, 0], [0, 2 * s, 0]], OVERLAY.marker);
}
function zoneOverlay(zone) {
  if (zone.kind === "polygon") {
    const points = [],
      n = zone.polygon.length;
    for (let i = 0; i < n; i++) {
      const [ax, az] = zone.polygon[i],
        [bx, bz] = zone.polygon[(i + 1) % n];
      for (const y of zone.y) points.push([ax, y, az], [bx, y, bz]);
      points.push([ax, zone.y[0], az], [ax, zone.y[1], az]);
    }
    return overlayLines(points, OVERLAY.zone);
  }
  if (zone.kind === "box") return overlayLines(boxEdges(zone.size), OVERLAY.zone);
  const points = [],
    r = zone.radius,
    n = 32;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2,
      b = ((i + 1) / n) * Math.PI * 2;
    points.push([r * Math.cos(a), 0, r * Math.sin(a)], [r * Math.cos(b), 0, r * Math.sin(b)]);
    points.push([r * Math.cos(a), r * Math.sin(a), 0], [r * Math.cos(b), r * Math.sin(b), 0]);
    points.push([0, r * Math.cos(a), r * Math.sin(a)], [0, r * Math.cos(b), r * Math.sin(b)]);
  }
  return overlayLines(points, OVERLAY.zone);
}
function pathOverlay(path) {
  const list = path.closed ? [...path.points, path.points[0]] : path.points,
    points = [];
  for (let i = 1; i < list.length; i++) points.push(list[i - 1], list[i]);
  const [x, y, z] = path.points[0],
    s = 0.1;
  points.push([x - s, y, z], [x + s, y, z], [x, y, z - s], [x, y, z + s]);
  return overlayLines(points, OVERLAY.path);
}
function placeholderOverlay(bounds) {
  const size = bounds.max.map((v, i) => Math.max(0.01, v - bounds.min[i])),
    center = bounds.max.map((v, i) => (v + bounds.min[i]) / 2);
  return overlayLines(boxEdges(size, center), OVERLAY.placeholder);
}
// A copy's matrix from its row [x, y, z, rx, ry, rz, scale] (degrees, the parts' convention).
const copyMatrix = (row, target = new THREE.Matrix4()) =>
  target.compose(
    new THREE.Vector3(row[0], row[1], row[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...row.slice(3, 6).map(THREE.MathUtils.degToRad), "XYZ")),
    new THREE.Vector3(row[6], row[6], row[6]),
  );
// Many copies of a placed model: one instanced mesh per part of its template, every copy's
// matrix composed with the part's place in the template.
function instancedCopies(template, node) {
  const meshes = [],
    part = new THREE.Matrix4(),
    copy = new THREE.Matrix4(),
    color = new THREE.Color();
  template.root.updateMatrixWorld(true);
  template.root.traverse((o) => {
    if (!o.isMesh) return;
    const instanced = new THREE.InstancedMesh(o.geometry, o.material, node.copies.length);
    node.copies.forEach((row, i) => {
      part.multiplyMatrices(copyMatrix(row, copy), o.matrixWorld);
      instanced.setMatrixAt(i, part);
      if (node.tints) instanced.setColorAt(i, color.setRGB(...node.tints[i]));
    });
    instanced.castShadow = instanced.receiveShadow = true;
    instanced.computeBoundingSphere();
    meshes.push(instanced);
  });
  return meshes;
}
// A terrain draws as one flat-shaded mesh coloured by surface, with its water as a pane.
function terrainObjects(node) {
  const { positions, normals, colors } = terrainMesh(node.terrain);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }));
  mesh.castShadow = mesh.receiveShadow = true;
  let water = null;
  if (node.terrain.water) {
    const bounds = terrainBounds(node.terrain);
    const pane = new THREE.PlaneGeometry(bounds.max[0], bounds.max[2]).rotateX(-Math.PI / 2).translate(bounds.max[0] / 2, node.terrain.water.level, bounds.max[2] / 2);
    const [r, g, b] = hexToLinear(node.terrain.water.color);
    water = new THREE.Mesh(pane, new THREE.MeshStandardMaterial({ color: new THREE.Color(r, g, b), transparent: true, opacity: 0.6, roughness: 0.2 }));
    water.userData = { overlay: true };
  }
  return { mesh, water };
}
function placeholderCopies(node) {
  const { min, max } = node.place.bounds,
    size = max.map((v, i) => Math.max(0.01, v - min[i])),
    center = max.map((v, i) => (v + min[i]) / 2);
  const geometry = new THREE.BoxGeometry(...size).translate(...center);
  const mesh = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: OVERLAY.placeholder, transparent: true, opacity: 0.35 }),
    node.copies.length,
  );
  const m = new THREE.Matrix4();
  node.copies.forEach((row, i) => mesh.setMatrixAt(i, copyMatrix(row, m)));
  mesh.userData = { overlay: true };
  return mesh;
}

/**
 * The Three.js objects of a project: one object per part, named by its id. With `display`,
 * scene parts get their overlays and placed models their loaded templates (copies sharing the
 * template's geometry); exports build without, so nothing of that reaches a file.
 */
export function buildModel(project, { display = false } = {}) {
  const root = new THREE.Group(),
    objects = new Map(),
    materials = new Map(),
    geometries = new Map(),
    placedMeshes = new Map(),
    overlays = new Map(),
    missing = [];
  root.name = project.name;
  for (const m of project.materials) materials.set(m.id, createMaterial(m));
  for (const node of project.nodes) {
    let object;
    if (node.mesh) {
      const positions = [],
        normals = [],
        triangleFaces = [],
        geometry = new THREE.BufferGeometry();
      const used = [...new Set(node.mesh.faces.map((f) => f.material))];
      // Smooth parts carry a normal per face corner; flat ones the face's own.
      const corners = node.smooth ? cornerNormals(node.mesh, node.smooth) : null,
        faceIndex = new Map(node.mesh.faces.map((f, i) => [f, i]));
      for (const [index, material] of used.entries()) {
        const start = positions.length / 3;
        for (const face of node.mesh.faces.filter(
          (f) => f.material === material,
        )) {
          const n = normal(node.mesh.vertices, face.vertices),
            smooth = corners?.[faceIndex.get(face)];
          for (const triangle of triangulate(
            node.mesh.vertices,
            face.vertices,
          )) {
            for (const i of triangle) {
              positions.push(...node.mesh.vertices[i]);
              normals.push(...(smooth ? smooth[face.vertices.indexOf(i)] : n));
            }
            triangleFaces.push(face.id);
          }
        }
        geometry.addGroup(start, positions.length / 3 - start, index);
      }
      const {
        positions: uniquePositions,
        normals: uniqueNormals,
        indices,
      } = indexAttributes(positions, normals);
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(uniquePositions, 3),
      );
      geometry.setAttribute(
        "normal",
        new THREE.Float32BufferAttribute(uniqueNormals, 3),
      );
      geometry.setIndex(indices);
      geometry.computeBoundingSphere();
      const geometryKey = JSON.stringify([
        uniquePositions,
        uniqueNormals,
        indices,
        geometry.groups,
      ]);
      const shared = geometries.get(geometryKey);
      if (shared) geometry.dispose();
      else geometries.set(geometryKey, geometry);
      object = new THREE.Mesh(
        shared ?? geometry,
        used.map((id) => materials.get(id)),
      );
      object.castShadow = true;
      object.receiveShadow = true;
      // Keep render-only metadata outside userData so it never enters GLB extras.
      object.editorFaces = triangleFaces;
    } else {
      object = new THREE.Group();
      if (display) {
        let overlay = null;
        if (node.place) {
          const template = placedTemplate(node.place);
          if (template && node.copies) {
            const meshes = instancedCopies(template, node);
            for (const m of meshes) {
              m.name = node.id;
              m.userData = { placed: true };
              object.add(m);
            }
            placedMeshes.set(node.id, meshes);
          } else if (template) {
            const copy = template.root.clone(true),
              meshes = [];
            copy.traverse((o) => {
              if (o.isMesh) {
                o.name = node.id;
                o.userData = { placed: true };
                meshes.push(o);
              }
            });
            copy.userData = { placed: true };
            object.add(copy);
            placedMeshes.set(node.id, meshes);
          } else {
            overlay = node.copies ? placeholderCopies(node) : placeholderOverlay(node.place.bounds);
            missing.push(node.place);
          }
        } else if (node.marker) overlay = markerOverlay();
        else if (node.zone) overlay = zoneOverlay(node.zone);
        else if (node.path) overlay = pathOverlay(node.path);
        else if (node.terrain) {
          const { mesh, water } = terrainObjects(node);
          mesh.name = node.id;
          mesh.userData = { placed: true };
          object.add(mesh);
          placedMeshes.set(node.id, [mesh]);
          if (water) overlay = water;
        }
        if (overlay) {
          object.add(overlay);
          overlays.set(node.id, overlay);
        }
      }
    }
    object.name = node.id;
    object.userData = { label: node.name };
    object.position.fromArray(node.position);
    object.rotation.set(...node.rotation.map(THREE.MathUtils.degToRad));
    object.scale.fromArray(node.scale);
    objects.set(node.id, object);
  }
  for (const node of project.nodes)
    (node.parent ? objects.get(node.parent) : root).add(objects.get(node.id));
  root.updateMatrixWorld(true);
  return {
    root,
    objects,
    placedMeshes,
    overlays,
    missing,
    dispose() {
      new Set(
        [...objects.values()].map((o) => o.geometry).filter(Boolean),
      ).forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      for (const o of overlays.values()) {
        o.geometry.dispose();
        o.material.dispose();
      }
      for (const [id, meshes] of placedMeshes)
        if (project.nodes.find((n) => n.id === id)?.terrain)
          for (const m of meshes) {
            m.geometry.dispose();
            m.material.dispose();
          }
    },
  };
}

export const VIEWS = {
  perspective: [3, 2.1, 4],
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0.0001],
};
// Screen right and up of each orthographic view, in world axes. A reference's center is
// measured along these from the world origin.
export const REFERENCE_AXES = {
  front: [
    [1, 0, 0],
    [0, 1, 0],
  ],
  back: [
    [-1, 0, 0],
    [0, 1, 0],
  ],
  left: [
    [0, 0, 1],
    [0, 1, 0],
  ],
  right: [
    [0, 0, -1],
    [0, 1, 0],
  ],
  top: [
    [1, 0, 0],
    [0, 0, -1],
  ],
};

export async function createViewport(
  canvas,
  {
    onPick = () => {},
    onTransform = () => {},
    onBoxEnd = () => {},
    onGrid = () => {},
    helpers = true,
    signal,
    onError = (error) => console.error(error),
  },
) {
  const requested =
    { webgl: "webgl2", software: "software" }[
      new URLSearchParams(location.search).get("renderer")
    ] ?? "auto";
  // WebGPU, else WebGL 2; a browser with neither (no GPU, WebGL switched off) draws in
  // software: slower, but the workshop, its observations and exports all still work.
  let renderer = null;
  if (requested !== "software")
    try {
      renderer = new WebGPURenderer({
        canvas,
        antialias: true,
        alpha: false,
        forceWebGL: requested === "webgl2" || !navigator.gpu,
      });
      renderer.onDeviceLost = () =>
        onError(new Error("Graphics device lost; save the project and reload."));
      renderer.onError = (error) => onError(new Error(error.message));
      await renderer.init();
    } catch (error) {
      // A renderer whose init failed holds nothing; dispose() would retry init and reject.
      console.warn("No WebGPU or WebGL; drawing the workshop in software.", error);
      renderer = null;
    }
  renderer ??= createSoftRenderer(canvas, THREE);
  if (signal?.aborted) {
    await renderer.dispose();
    throw new DOMException("Preview closed", "AbortError");
  }
  const software = !!renderer.isSoftRenderer;
  const backend = software
    ? "software"
    : renderer.backend.isWebGPUBackend
      ? "webgpu"
      : "webgl2";
  canvas.dataset.renderer = backend;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#d7d9db");
  const perspective = new THREE.PerspectiveCamera(38, 1, 0.001, 10000),
    orthographic = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.001, 10000);
  let camera = perspective,
    orbit = new OrbitControls(camera, canvas);
  const transform = new TransformControls(camera, canvas),
    proxy = new THREE.Object3D();
  scene.add(proxy, transform.getHelper());
  transform.setSize(0.8);
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(-3, 7, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0003;
  scene.add(key, key.target);
  // The software renderer takes the same sky as two colours instead of a PMREM texture.
  const environment = software ? null : sky(renderer, 0xffffff, 0x657180, 1.8);
  scene.environment = environment?.texture ?? null;
  if (software)
    renderer.environment = { top: 0xffffff, bottom: 0x657180, intensity: 1.8 };
  const grid = new THREE.GridHelper(20, 40, 0x77818a, 0xaab0b6);
  grid.material.transparent = true;
  grid.material.opacity = 0.4;
  scene.add(grid);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShadowMaterial({ opacity: 0.16 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.001;
  floor.receiveShadow = true;
  grid.visible = floor.visible = helpers;
  scene.add(floor);
  const clay = new THREE.MeshStandardMaterial({
      color: 0xb4b8bd,
      roughness: 0.85,
    }),
    silhouette = new THREE.MeshBasicMaterial({ color: 0x22262b });
  const highlights = new THREE.Group(),
    wires = new THREE.Group();
  scene.add(highlights, wires);
  // Reference images (blueprints, photos, concept views) stand behind the model in one
  // orthographic view. They are drawing aids: never picked, exported or saved in a project.
  const referenceGroup = new THREE.Group();
  scene.add(referenceGroup);
  let references = [];
  function placeReferences() {
    const box = model
      ? new THREE.Box3().setFromObject(model.root, true)
      : new THREE.Box3();
    const corners = box.isEmpty()
      ? [new THREE.Vector3()]
      : [0, 1, 2, 3, 4, 5, 6, 7].map(
          (i) =>
            new THREE.Vector3(
              i & 1 ? box.max.x : box.min.x,
              i & 2 ? box.max.y : box.min.y,
              i & 4 ? box.max.z : box.min.z,
            ),
        );
    const margin = box.isEmpty()
      ? 0.01
      : box.getSize(new THREE.Vector3()).length() * 0.02 + 0.001;
    for (const { spec, mesh } of references) {
      const [right, up] = REFERENCE_AXES[spec.view].map(
          (v) => new THREE.Vector3(...v),
        ),
        normal = new THREE.Vector3().crossVectors(right, up),
        depth = Math.min(...corners.map((c) => c.dot(normal))) - margin;
      mesh.matrix
        .makeBasis(right, up, normal)
        .setPosition(
          right
            .clone()
            .multiplyScalar(spec.center[0])
            .add(up.clone().multiplyScalar(spec.center[1]))
            .add(normal.clone().multiplyScalar(depth)),
        );
      mesh.matrixWorldNeedsUpdate = true;
    }
  }
  function showReferences(name = null) {
    const direction = camera.position.clone().sub(orbit.target).normalize();
    for (const { spec, mesh } of references) {
      const [right, up] = REFERENCE_AXES[spec.view].map(
        (v) => new THREE.Vector3(...v),
      );
      mesh.visible =
        name !== null
          ? name === spec.view
          : camera.isOrthographicCamera &&
            direction.dot(new THREE.Vector3().crossVectors(right, up)) > 0.999;
    }
  }
  const raycaster = new THREE.Raycaster(),
    boxOverlay = document.createElement("div");
  boxOverlay.className = "selection-box";
  boxOverlay.hidden = true;
  canvas.parentElement.append(boxOverlay);
  let model = null,
    project = null,
    selection = { ids: [], faces: [], vertices: [] },
    wireframe = false,
    xray = false,
    boxMode = false,
    shading = "material",
    space = "world",
    frame = 0,
    disposed = false,
    down = null,
    dragStart = null,
    cancelled = false,
    readonly = false,
    viewState = { hidden: new Set(), locked: new Set(), isolated: null };
  const render = () => {
    if (!frame && !disposed)
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateGrid();
        showReferences();
        if (software) renderer.renderInteractive(scene, camera);
        else renderer.render(scene, camera);
        updateAxes();
      });
  };
  function clear(group) {
    for (const o of [...group.children]) {
      group.remove(o);
      o.geometry?.dispose();
      for (const m of [o.material].flat()) m?.dispose();
    }
  }
  function selectedIndices() {
    const node = project?.nodes.find((n) => n.id === selection.id);
    if (!node?.mesh || selection.mode === "object") return [];
    try {
      return selectionVertices(
        node,
        selection.mode === "vertex"
          ? { vertices: selection.vertices ?? [] }
          : selection.mode === "edge"
            ? { edges: selection.edges ?? [] }
            : { faces: selection.faces ?? [] },
      );
    } catch {
      return [];
    }
  }
  function inherited(id, set) {
    let o = model?.objects.get(id);
    while (o && o !== model.root) {
      if (set.has(o.name)) return true;
      o = o.parent;
    }
    return false;
  }
  function shown(id) {
    return (
      !inherited(id, viewState.hidden) &&
      (!viewState.isolated ||
        inherited(id, viewState.isolated) ||
        [...viewState.isolated].some((v) => {
          let o = model.objects.get(v);
          while (o) {
            if (o.name === id) return true;
            o = o.parent;
          }
          return false;
        }))
    );
  }
  function pickable(id) {
    return shown(id) && !inherited(id, viewState.locked);
  }
  function visibleMeshes() {
    const meshes = [...model.objects.values()].filter((o) => o.isMesh && shown(o.name));
    for (const [id, list] of model.placedMeshes) if (shown(id)) meshes.push(...list);
    return meshes;
  }
  function canTransform() {
    if (readonly || !selection.id || selection.ids.some((id) => !pickable(id)))
      return false;
    const n = project.nodes.find((n) => n.id === selection.id);
    if (selection.ids.some((id) => bindingFor(project, id))) return false;
    if (selection.mode !== "object")
      return (
        !!n?.mesh &&
        !n.generator &&
        !n.symmetry &&
        !n.instanceOf &&
        selectedIndices().length > 0
      );
    return selection.ids.every((id) => {
      const s = project.nodes.find((n) => n.id === id)?.symmetry;
      return (
        !s ||
        selection.ids.some((root) => {
          let o = model.objects.get(s.source);
          while (o) {
            if (o.name === root) return true;
            o = o.parent;
          }
          return false;
        })
      );
    });
  }
  function viewHeight() {
    return camera.isOrthographicCamera
      ? (camera.top - camera.bottom) / 2 / camera.zoom
      : (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) *
          camera.position.distanceTo(orbit.target)) /
          camera.zoom;
  }
  function reorient(direction, next = camera) {
    const h = viewHeight(),
      target = orbit.target.clone(),
      aspect = canvas.clientWidth / canvas.clientHeight;
    switchCamera(next);
    camera.zoom = 1;
    const distance = h / Math.tan(THREE.MathUtils.degToRad(38 / 2));
    camera.position
      .copy(target)
      .add(
        new THREE.Vector3(...direction).normalize().multiplyScalar(distance),
      );
    if (camera.isOrthographicCamera)
      Object.assign(camera, {
        left: -h * aspect,
        right: h * aspect,
        top: h,
        bottom: -h,
      });
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    orbit.target.copy(target);
    orbit.update();
    render();
  }
  let gridStep = 0;
  function updateGrid() {
    const desired = viewHeight() / 8,
      power = 10 ** Math.floor(Math.log10(Math.max(desired, 1e-6))),
      step =
        [1, 2, 5, 10].map((n) => n * power).find((n) => n >= desired) ??
        power * 10;
    if (step !== gridStep) {
      gridStep = step;
      grid.scale.setScalar(step / 0.5);
      onGrid(step);
    }
  }
  function selectedRoots() {
    const ids = selection.ids ?? [selection.id];
    return ids.filter((id) => {
      let o = model?.objects.get(id)?.parent;
      while (o && o !== model.root) {
        if (ids.includes(o.name)) return false;
        o = o.parent;
      }
      return true;
    });
  }
  function bounds(focus = false) {
    const b = new THREE.Box3();
    if (model) {
      if (focus && selection.id) {
        if (selection.mode === "object") {
          for (const id of selection.ids ?? [selection.id]) {
            const o = model.objects.get(id);
            if (o) b.union(new THREE.Box3().setFromObject(o));
          }
        } else {
          const o = model.objects.get(selection.id),
            n = project.nodes.find((n) => n.id === selection.id);
          for (const i of selectedIndices())
            b.expandByPoint(
              new THREE.Vector3(...n.mesh.vertices[i]).applyMatrix4(
                o.matrixWorld,
              ),
            );
          if (b.isEmpty() && o) b.setFromObject(o);
        }
      } else {
        for (const o of visibleMeshes())
          b.union(new THREE.Box3().setFromObject(o));
        for (const [id, o] of model.overlays)
          if (shown(id)) b.union(new THREE.Box3().setFromObject(o));
      }
    }
    if (b.isEmpty())
      b.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
    return b;
  }
  function aim(
    cam,
    direction,
    focus = false,
    aspect = canvas.clientWidth / canvas.clientHeight,
  ) {
    const b = bounds(focus),
      center = b.getCenter(new THREE.Vector3()),
      radius = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 0.03);
    const fov = THREE.MathUtils.degToRad(38) / 2,
      distance =
        (radius / Math.sin(Math.min(fov, Math.atan(Math.tan(fov) * aspect)))) *
        1.12;
    cam.position
      .copy(center)
      .add(
        new THREE.Vector3(...direction).normalize().multiplyScalar(distance),
      );
    cam.near = Math.max(0.0001, distance / 10000);
    cam.far = Math.max(100, distance * 20);
    if (cam.isOrthographicCamera) {
      const h = (radius * 1.12) / Math.min(aspect, 1);
      cam.left = -h * aspect;
      cam.right = h * aspect;
      cam.top = h;
      cam.bottom = -h;
      cam.zoom = 1;
    } else cam.aspect = aspect;
    cam.lookAt(center);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    return center;
  }
  function switchCamera(next) {
    if (camera === next) return;
    const target = orbit.target.clone();
    orbit.dispose();
    camera = next;
    transform.camera = next;
    orbit = new OrbitControls(camera, canvas);
    orbit.target.copy(target);
    orbit.addEventListener("change", render);
    orbit.enabled = !boxMode;
  }
  function view(name = "perspective", options = {}) {
    if (!VIEWS[name]) throw new Error(`Unknown view: ${name}`);
    if (options.preserve) {
      reorient(
        VIEWS[name],
        (options.projection ??
          (name === "perspective" ? "perspective" : "orthographic")) ===
          "perspective"
          ? perspective
          : orthographic,
      );
      return;
    }
    switchCamera(
      (options.projection ??
        (name === "perspective" ? "perspective" : "orthographic")) ===
        "perspective"
        ? perspective
        : orthographic,
    );
    orbit.target.copy(aim(camera, VIEWS[name], options.focus));
    orbit.update();
    render();
  }
  function focus() {
    const d = camera.position.clone().sub(orbit.target).normalize().toArray();
    orbit.target.copy(aim(camera, d, true));
    orbit.update();
    render();
  }
  function projection() {
    const direction = camera.position
      .clone()
      .sub(orbit.target)
      .normalize()
      .toArray();
    reorient(
      direction,
      camera.isPerspectiveCamera ? orthographic : perspective,
    );
    return camera.isOrthographicCamera ? "orthographic" : "perspective";
  }
  function cameraInfo(cam = camera, target = orbit.target) {
    return {
      projection: cam.isOrthographicCamera ? "orthographic" : "perspective",
      position: cam.position.toArray(),
      target: target.toArray(),
      up: cam.up.toArray(),
      near: cam.near,
      far: cam.far,
      zoom: cam.zoom,
      ...(cam.isPerspectiveCamera
        ? { fov: cam.fov, aspect: cam.aspect }
        : {
            left: cam.left,
            right: cam.right,
            top: cam.top,
            bottom: cam.bottom,
          }),
      projectionMatrix: cam.projectionMatrix.toArray(),
      worldMatrix: cam.matrixWorld.toArray(),
    };
  }
  function updateAxes() {
    const svg = canvas.id === "canvas" ? document.querySelector("#axes") : null;
    if (!svg) return;
    const q = camera.quaternion.clone().invert();
    for (const [i, a] of ["x", "y", "z"].entries()) {
      const v = new THREE.Vector3(
        ...[0, 1, 2].map((k) => (k === i ? 1 : 0)),
      ).applyQuaternion(q);
      const x = 40 + v.x * 25,
        y = 40 - v.y * 25;
      svg.querySelector(`[data-axis="${a}"]`).setAttribute("x2", x);
      svg.querySelector(`[data-axis="${a}"]`).setAttribute("y2", y);
      const text = svg.querySelector(`[data-label="${a}"]`);
      text.setAttribute("x", x);
      text.setAttribute("y", y - 4);
    }
  }
  function applyShading() {
    if (model)
      model.root.traverse((o) => {
        if (o.isMesh) {
          o.editorMaterials ??= o.material;
          o.material =
            shading === "clay"
              ? clay
              : shading === "silhouette"
                ? silhouette
                : o.editorMaterials;
        }
      });
  }
  function disposeModel() {
    if (!model) return;
    model.root.traverse((o) => {
      if (o.editorMaterials) o.material = o.editorMaterials;
    });
    scene.remove(model.root);
    model.dispose();
  }
  function install(next) {
    disposeModel();
    model = buildModel(next, { display: true });
    scene.add(model.root);
    for (const [id, o] of model.objects) o.visible = shown(id);
    applyShading();
    // Placed models whose template has not loaded show their bounds; the scene rebuilds once
    // a template arrives, if the same project is still shown.
    if (model.missing.length) {
      const current = next;
      Promise.allSettled(model.missing.map((place) => ensurePlaced(place))).then((results) => {
        if (disposed || project !== current) return;
        if (!results.some((r) => r.status === "fulfilled" && r.value)) return;
        install(project);
        refreshSelection();
        render();
      });
    }
  }
  function refreshSelection(attach = true) {
    clear(highlights);
    if (attach) transform.detach();
    const object = model?.objects.get(selection.id),
      node = project?.nodes.find((n) => n.id === selection.id);
    if (!object || !shown(selection.id)) {
      render();
      return;
    }
    if (selection.mode === "object") {
      for (const id of selection.ids ?? [selection.id]) {
        const o = model.objects.get(id);
        if (o && shown(id))
          highlights.add(
            new THREE.BoxHelper(o, id === selection.id ? 0x9a4f00 : 0x006e91),
          );
      }
    }
    if (node?.mesh && selection.mode === "face")
      for (const face of node.mesh.faces.filter((f) =>
        selection.faces?.includes(f.id),
      )) {
        const positions = triangulate(
          node.mesh.vertices,
          face.vertices,
        ).flatMap((t) => t.flatMap((i) => node.mesh.vertices[i]));
        const geometry = new THREE.BufferGeometry().setAttribute(
          "position",
          new THREE.Float32BufferAttribute(positions, 3),
        );
        const overlay = new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({
            color: 0x0086ac,
            transparent: true,
            opacity: 0.4,
            side: THREE.DoubleSide,
            depthWrite: false,
            depthTest: !xray,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
          }),
        );
        overlay.matrixAutoUpdate = false;
        overlay.matrix.copy(object.matrixWorld);
        highlights.add(overlay);
      }
    if (node?.mesh && selection.mode === "vertex")
      for (const selected of [false, true]) {
        const vertices = selected
          ? (selection.vertices ?? []).map((i) => node.mesh.vertices[i])
          : node.mesh.vertices;
        if (!vertices.length) continue;
        const points = new THREE.Points(
          new THREE.BufferGeometry().setAttribute(
            "position",
            new THREE.Float32BufferAttribute(vertices.flat(), 3),
          ),
          new THREE.PointsMaterial({
            color: selected ? 0x007bce : 0x252a30,
            size: selected ? 11 : 6,
            sizeAttenuation: false,
            depthTest: !xray,
            depthWrite: false,
          }),
        );
        points.matrixAutoUpdate = false;
        points.matrix.copy(object.matrixWorld);
        points.renderOrder = selected ? 2 : 1;
        highlights.add(points);
      }
    if (node?.mesh && selection.mode === "edge") {
      for (const selected of [false, true]) {
        const edges = meshEdges(node.mesh).filter(
          (e) => selected === selection.edges?.includes(e.id),
        );
        const line = new THREE.LineSegments(
          new THREE.BufferGeometry().setAttribute(
            "position",
            new THREE.Float32BufferAttribute(
              edges.flatMap((e) =>
                e.vertices.flatMap((i) => node.mesh.vertices[i]),
              ),
              3,
            ),
          ),
          new THREE.LineBasicMaterial({
            color: selected ? 0x006bd1 : 0x39434b,
            depthTest: !xray,
            transparent: true,
            opacity: selected ? 1 : 0.55,
          }),
        );
        line.matrixAutoUpdate = false;
        line.matrix.copy(object.matrixWorld);
        line.renderOrder = selected ? 3 : 1;
        highlights.add(line);
      }
    }
    const related =
      project.nodes.find((n) => n.id === selection.id && n.symmetry) ??
      project.nodes.find((n) => n.symmetry?.source === selection.id);
    if (related) {
      const sym = related.symmetry,
        frame = new THREE.Matrix4();
      if (sym.reference)
        frame.copy(model.objects.get(sym.reference).matrixWorld);
      if (sym.basis) frame.multiply(new THREE.Matrix4().fromArray(sym.basis));
      const center = bounds(true)
          .getCenter(new THREE.Vector3())
          .applyMatrix4(frame.clone().invert()),
        axis = ["x", "y", "z"].indexOf(sym.axis);
      center.setComponent(axis, sym.offset);
      const size = Math.max(
          bounds(true).getSize(new THREE.Vector3()).length() * 1.4,
          0.2,
        ),
        plane = new THREE.Mesh(
          new THREE.PlaneGeometry(size, size),
          new THREE.MeshBasicMaterial({
            color: 0x386f9e,
            transparent: true,
            opacity: 0.09,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
      plane.position.copy(center);
      if (axis === 0) plane.rotation.y = Math.PI / 2;
      else if (axis === 1) plane.rotation.x = Math.PI / 2;
      plane.updateMatrix();
      plane.matrix.premultiply(frame);
      plane.matrixAutoUpdate = false;
      highlights.add(plane);
    }
    const editable = canTransform();
    if (attach && editable) {
      proxy.position.copy(bounds(true).getCenter(new THREE.Vector3()));
      proxy.quaternion.identity();
      proxy.scale.set(1, 1, 1);
      if (space === "local") object.getWorldQuaternion(proxy.quaternion);
      proxy.updateMatrixWorld();
      transform.attach(proxy);
    }
    render();
  }
  function updateWires() {
    clear(wires);
    if (wireframe && model)
      for (const node of project.nodes.filter((n) => n.mesh && shown(n.id))) {
        const object = model.objects.get(node.id),
          seen = new Set(),
          positions = [];
        for (const face of node.mesh.faces)
          face.vertices.forEach((a, i) => {
            const b = face.vertices[(i + 1) % face.vertices.length],
              key = [a, b].sort((a, b) => a - b).join(":");
            if (!seen.has(key)) {
              seen.add(key);
              positions.push(
                ...node.mesh.vertices[a],
                ...node.mesh.vertices[b],
              );
            }
          });
        const line = new THREE.LineSegments(
          new THREE.BufferGeometry().setAttribute(
            "position",
            new THREE.Float32BufferAttribute(positions, 3),
          ),
          new THREE.LineBasicMaterial({
            color: 0x3c4852,
            transparent: true,
            opacity: 0.65,
            depthTest: !xray,
          }),
        );
        line.matrixAutoUpdate = false;
        line.matrix.copy(object.matrixWorld);
        wires.add(line);
      }
    render();
  }
  function transformCommand(delta) {
    return {
      op: "transform",
      id: selection.id,
      ...(selection.mode === "object"
        ? { ids: selectedRoots() }
        : selection.mode === "vertex"
          ? { vertices: selection.vertices }
          : selection.mode === "edge"
            ? { edges: selection.edges }
            : { faces: selection.faces }),
      matrix: delta,
    };
  }
  function previewDelta(delta) {
    try {
      const next = evaluateCommands(project, [
        transformCommand(delta.toArray()),
      ]);
      install(next);
    } catch {
      install(project);
    }
    highlights.visible = false;
    wires.visible = false;
    render();
  }
  orbit.addEventListener("change", render);
  transform.addEventListener("change", render);
  transform.addEventListener("dragging-changed", (e) => {
    orbit.enabled = !e.value && !boxMode;
  });
  transform.addEventListener("mouseDown", () => {
    cancelled = false;
    proxy.updateMatrixWorld();
    dragStart = {
      matrix: proxy.matrixWorld.clone(),
      objects: new Map(
        [...model.objects].map(([id, o]) => [id, o.matrixWorld.clone()]),
      ),
    };
  });
  transform.addEventListener("objectChange", () => {
    if (dragStart) {
      proxy.updateMatrixWorld();
      previewDelta(
        proxy.matrixWorld.clone().multiply(dragStart.matrix.clone().invert()),
      );
    }
  });
  transform.addEventListener("mouseUp", () => {
    if (!dragStart) return;
    proxy.updateMatrixWorld();
    const delta = proxy.matrixWorld
      .clone()
      .multiply(dragStart.matrix.clone().invert())
      .toArray();
    dragStart = null;
    highlights.visible = wires.visible = true;
    if (
      !cancelled &&
      delta.some((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) > 1e-8)
    )
      onTransform(transformCommand(delta));
    install(project);
    refreshSelection();
    updateWires();
  });
  function visible(v, id) {
    if (xray) return true;
    const p = v.clone().project(camera);
    raycaster.setFromCamera(new THREE.Vector2(p.x, p.y), camera);
    const hit = raycaster.intersectObjects(visibleMeshes(), false)[0];
    return (
      !hit ||
      (id && hit.object.name === id) ||
      hit.distance + Math.max(1e-5, hit.distance * 1e-5) >=
        v.distanceTo(raycaster.ray.origin)
    );
  }
  function projected(v) {
    const p = v.clone().project(camera),
      r = canvas.getBoundingClientRect();
    return {
      x: ((p.x + 1) * r.width) / 2 + r.left,
      y: ((1 - p.y) * r.height) / 2 + r.top,
      z: p.z,
    };
  }
  function candidates() {
    if (!model) return [];
    if (selection.mode === "object")
      return [...model.objects]
        .filter(([id, o]) => (o.isMesh || model.placedMeshes.has(id) || model.overlays.has(id)) && pickable(id))
        .map(([id, o]) => ({
          id,
          world: new THREE.Box3()
            .setFromObject(o)
            .getCenter(new THREE.Vector3()),
        }));
    const node = project.nodes.find((n) => n.id === selection.id),
      o = model.objects.get(selection.id);
    if (!node?.mesh || !pickable(node.id)) return [];
    if (selection.mode === "edge")
      return meshEdges(node.mesh).map((e) => ({
        id: node.id,
        edge: e.id,
        ends: e.vertices.map((i) =>
          new THREE.Vector3(...node.mesh.vertices[i]).applyMatrix4(
            o.matrixWorld,
          ),
        ),
        world: new THREE.Vector3(...node.mesh.vertices[e.vertices[0]])
          .add(new THREE.Vector3(...node.mesh.vertices[e.vertices[1]]))
          .multiplyScalar(0.5)
          .applyMatrix4(o.matrixWorld),
      }));
    return selection.mode === "vertex"
      ? node.mesh.vertices.map((v, i) => ({
          id: node.id,
          vertex: i,
          world: new THREE.Vector3(...v).applyMatrix4(o.matrixWorld),
        }))
      : node.mesh.faces.map((f) => ({
          id: node.id,
          face: f.id,
          world: f.vertices
            .reduce(
              (s, i) => s.add(new THREE.Vector3(...node.mesh.vertices[i])),
              new THREE.Vector3(),
            )
            .divideScalar(f.vertices.length)
            .applyMatrix4(o.matrixWorld),
        }));
  }
  function objectInBox(id, rect) {
    const o = model.objects.get(id),
      n = project.nodes.find((n) => n.id === id),
      points = (n.mesh?.vertices ?? nodePoints(n))
        .map((v) =>
          projected(new THREE.Vector3(...v).applyMatrix4(o.matrixWorld)),
        )
        .filter((p) => p.z >= -1 && p.z <= 1);
    if (!points.length) return false;
    const left = Math.max(rect.left, Math.min(...points.map((p) => p.x))),
      right = Math.min(rect.right, Math.max(...points.map((p) => p.x))),
      top = Math.max(rect.top, Math.min(...points.map((p) => p.y))),
      bottom = Math.min(rect.bottom, Math.max(...points.map((p) => p.y)));
    if (left > right || top > bottom) return false;
    if (xray || !n.mesh) return true;
    const r = canvas.getBoundingClientRect();
    for (const x of [0.1, 0.3, 0.5, 0.7, 0.9])
      for (const y of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        raycaster.setFromCamera(
          new THREE.Vector2(
            ((left + (right - left) * x - r.left) / r.width) * 2 - 1,
            1 - ((top + (bottom - top) * y - r.top) / r.height) * 2,
          ),
          camera,
        );
        if (
          raycaster.intersectObjects(visibleMeshes(), false)[0]?.object.name ===
          id
        )
          return true;
      }
    return false;
  }
  canvas.addEventListener("pointerdown", (e) => {
    down = {
      x: e.clientX,
      y: e.clientY,
      transformed: !!transform.axis,
      box: boxMode,
    };
    if (boxMode) {
      const r = canvas.getBoundingClientRect();
      boxOverlay.hidden = false;
      Object.assign(boxOverlay.style, {
        left: `${e.clientX - r.left}px`,
        top: `${e.clientY - r.top}px`,
        width: "0px",
        height: "0px",
      });
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!down?.box) return;
    const r = canvas.getBoundingClientRect();
    Object.assign(boxOverlay.style, {
      left: `${Math.min(e.clientX, down.x) - r.left}px`,
      top: `${Math.min(e.clientY, down.y) - r.top}px`,
      width: `${Math.abs(e.clientX - down.x)}px`,
      height: `${Math.abs(e.clientY - down.y)}px`,
    });
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!down) return;
    const start = down;
    down = null;
    if (start.box) {
      boxOverlay.hidden = true;
      const rect = {
        left: Math.min(start.x, e.clientX),
        right: Math.max(start.x, e.clientX),
        top: Math.min(start.y, e.clientY),
        bottom: Math.max(start.y, e.clientY),
      };
      const found = candidates().filter((c) => {
        if (selection.mode === "object") return objectInBox(c.id, rect);
        const p = projected(c.world);
        return (
          p.z >= -1 &&
          p.z <= 1 &&
          p.x >= Math.min(start.x, e.clientX) &&
          p.x <= Math.max(start.x, e.clientX) &&
          p.y >= Math.min(start.y, e.clientY) &&
          p.y <= Math.max(start.y, e.clientY) &&
          visible(c.world)
        );
      });
      onPick({
        items: found.map(({ world, ends, ...c }) => c),
        additive: e.shiftKey,
      });
      boxMode = false;
      orbit.enabled = true;
      transform.enabled = true;
      onBoxEnd();
      return;
    }
    if (
      start.transformed ||
      transform.dragging ||
      e.button !== 0 ||
      Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5
    )
      return;
    if (selection.mode === "vertex" || selection.mode === "edge") {
      let best = 12,
        chosen;
      for (const c of candidates()) {
        let world = c.world,
          p = projected(world);
        if (c.ends) {
          const a = projected(c.ends[0]),
            b = projected(c.ends[1]),
            dx = b.x - a.x,
            dy = b.y - a.y,
            t = Math.max(
              0,
              Math.min(
                1,
                ((e.clientX - a.x) * dx + (e.clientY - a.y) * dy) /
                  (dx * dx + dy * dy),
              ),
            );
          let worldT = t;
          if (camera.isPerspectiveCamera) {
            const za = -c.ends[0]
                .clone()
                .applyMatrix4(camera.matrixWorldInverse).z,
              zb = -c.ends[1].clone().applyMatrix4(camera.matrixWorldInverse).z;
            worldT = (t * za) / ((1 - t) * zb + t * za);
          }
          world = c.ends[0].clone().lerp(c.ends[1], worldT);
          p = { x: a.x + dx * t, y: a.y + dy * t, z: projected(world).z };
        }
        const d = Math.hypot(p.x - e.clientX, p.y - e.clientY);
        if (p.z >= -1 && p.z <= 1 && d < best && visible(world)) {
          best = d;
          chosen = c;
        }
      }
      if (chosen) {
        const { world, ends, ...item } = chosen;
        onPick({ ...item, additive: e.shiftKey });
        return;
      }
      onPick({ empty: true, additive: e.shiftKey });
      return;
    }
    const r = canvas.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      ),
      camera,
    );
    const hit = raycaster.intersectObjects(visibleMeshes(), false)[0];
    onPick(
      hit && pickable(hit.object.name)
        ? {
            id: hit.object.name,
            face: hit.object.editorFaces[hit.faceIndex],
            additive: e.shiftKey,
          }
        : { empty: true, additive: e.shiftKey },
    );
  });
  const resize = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    perspective.aspect = width / height;
    perspective.updateProjectionMatrix();
    const h = orthographic.top;
    orthographic.left = (-h * width) / height;
    orthographic.right = (h * width) / height;
    orthographic.updateProjectionMatrix();
    render();
  };
  function fitLighting() {
    const b = bounds(),
      s = Math.max(...b.getSize(new THREE.Vector3()).toArray(), 1) * 1.5;
    key.target.position.copy(b.getCenter(new THREE.Vector3()));
    key.position
      .copy(key.target.position)
      .add(new THREE.Vector3(-s, 2 * s, 1.5 * s));
    Object.assign(key.shadow.camera, {
      left: -s,
      right: s,
      top: s,
      bottom: -s,
      far: s * 8,
    });
    key.shadow.camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  return {
    async setReferences(list) {
      const loaded = [];
      try {
        for (const spec of list) {
          const image = new Image();
          image.src = spec.image;
          await image.decode();
          const texture = new THREE.Texture(image);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.needsUpdate = true;
          const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(
              spec.width,
              (spec.width * image.naturalHeight) / image.naturalWidth,
            ),
            new THREE.MeshBasicMaterial({
              map: texture,
              transparent: true,
              opacity: spec.opacity,
              depthWrite: false,
              toneMapped: false,
              side: THREE.DoubleSide,
            }),
          );
          mesh.matrixAutoUpdate = false;
          mesh.renderOrder = -1;
          loaded.push({ spec, mesh });
        }
      } catch (error) {
        for (const { mesh } of loaded) {
          mesh.geometry.dispose();
          mesh.material.map.dispose();
          mesh.material.dispose();
        }
        throw new Error("Reference image cannot be decoded");
      }
      for (const { mesh } of references) {
        mesh.removeFromParent();
        mesh.geometry.dispose();
        mesh.material.map.dispose();
        mesh.material.dispose();
      }
      references = loaded;
      for (const { mesh } of loaded) referenceGroup.add(mesh);
      placeReferences();
      render();
    },
    rendererInfo() {
      return {
        backend,
        requested,
        fallback: requested === "auto" && backend !== "webgpu",
        ...(software ? { software: true } : {}),
      };
    },
    setViewState(value) {
      viewState = value;
      if (model) for (const [id, o] of model.objects) o.visible = shown(id);
      refreshSelection();
      updateWires();
    },
    setReadonly(value) {
      readonly = value;
      refreshSelection();
    },
    setProject(next) {
      transform.detach();
      project = next;
      install(next);
      placeReferences();
      fitLighting();
      updateWires();
      refreshSelection();
    },
    select(next) {
      selection = next;
      refreshSelection();
    },
    setMode(mode) {
      transform.setMode(mode);
    },
    setSpace(value) {
      space = value;
      transform.setSpace(value);
      refreshSelection();
    },
    setWireframe(value) {
      wireframe = value;
      updateWires();
    },
    setXray(value) {
      xray = value;
      refreshSelection();
      updateWires();
    },
    setBox(value) {
      boxMode = value;
      orbit.enabled = !value;
      transform.enabled = !value;
    },
    setSnap(value, degrees = 15) {
      transform.setTranslationSnap(value || null);
      transform.setRotationSnap(
        value ? THREE.MathUtils.degToRad(degrees) : null,
      );
      transform.setScaleSnap(value ? 0.1 : null);
    },
    setShading(value) {
      if (!["material", "clay", "silhouette"].includes(value))
        throw new Error("Unknown shading");
      shading = value;
      applyShading();
      render();
    },
    cancel() {
      if (dragStart) {
        cancelled = true;
        transform.reset();
        install(project);
        render();
      }
      boxMode = false;
      boxOverlay.hidden = true;
      orbit.enabled = true;
      transform.enabled = true;
      onBoxEnd();
    },
    view,
    focus,
    projection,
    cameraInfo,
    bounds() {
      const b = bounds();
      return {
        min: b.min.toArray(),
        max: b.max.toArray(),
        size: b.getSize(new THREE.Vector3()).toArray(),
      };
    },
    renderProject(next, names, size, options) {
      const original = project,
        originalSelection = selection;
      try {
        project = next;
        if (options?.selection) selection = options.selection;
        install(next);
        placeReferences();
        fitLighting();
        return this.renderViews(names, size, options);
      } finally {
        project = original;
        selection = originalSelection;
        install(original);
        placeReferences();
        fitLighting();
        updateWires();
        refreshSelection();
        render();
      }
    },
    renderViews(
      names = ["front", "left", "back", "perspective"],
      size = 512,
      options = {},
    ) {
      if (
        !Array.isArray(names) ||
        !names.length ||
        names.length > 6 ||
        names.some((n) => n !== "current" && !VIEWS[n])
      )
        throw new Error("Choose 1–6 named views");
      if (!Number.isInteger(size) || size < 64 || size > 2048)
        throw new Error("Image size must be 64–2048");
      if (
        options.ids &&
        (!Array.isArray(options.ids) ||
          !options.ids.length ||
          options.ids.some((id) => !model.objects.has(id)))
      )
        throw new Error("Unknown observation IDs");
      if (
        options.shading &&
        !["material", "clay", "silhouette", "ids"].includes(options.shading)
      )
        throw new Error("Unknown observation shading");
      const previous = {
        size: renderer.getSize(new THREE.Vector2()),
        ratio: renderer.getPixelRatio(),
        viewState,
        shading,
        wireframe,
        grid: grid.visible,
        floor: floor.visible,
        helper: transform.getHelper().visible,
        highlights: highlights.visible,
        wires: wires.visible,
      };
      const temporary = [];
      try {
        if (options.ids || options.visibility === "all")
          viewState = {
            hidden: new Set(),
            locked: viewState.locked,
            isolated: options.ids ? new Set(options.ids) : null,
          };
        for (const [id, o] of model.objects) o.visible = shown(id);
        shading = options.shading ?? shading;
        applyShading();
        const nodeColors = {};
        if (shading === "ids") {
          let i = 0;
          for (const [id, o] of model.objects) {
            const meshes = o.isMesh ? [o] : (model.placedMeshes.get(id) ?? []);
            if (!meshes.length) continue;
            const color =
              "#" + ((++i * 7919) % 0xffffff).toString(16).padStart(6, "0");
            nodeColors[id] = color;
            const m = new THREE.MeshBasicMaterial({
              color,
              toneMapped: false,
            });
            temporary.push(m);
            for (const mesh of meshes) mesh.material = m;
          }
        }
        // Scene data overlays (zones, paths, markers, placeholders): shown unless asked away.
        for (const o of model.overlays.values())
          o.visible = shading !== "ids" && (options.overlays?.data ?? true);
        wireframe = options.overlays?.wire ?? false;
        updateWires();
        refreshSelection();
        highlights.visible = !!options.overlays?.selection && shading !== "ids";
        wires.visible = wireframe && shading !== "ids";
        transform.getHelper().visible = false;
        grid.visible = floor.visible =
          shading !== "ids" && (options.helpers ?? true);
        renderer.setPixelRatio(1);
        const observation = {
          visibleIds: visibleMeshes().map((o) => o.name),
          viewState: {
            hidden: [...viewState.hidden],
            locked: [...viewState.locked],
            isolated: viewState.isolated ? [...viewState.isolated] : null,
          },
          selection: structuredClone(selection),
          overlays: { wire: wires.visible, selection: highlights.visible },
          helpers: grid.visible,
          nodeColors,
        };
        return names.map((name) => {
          const height =
            name === "current"
              ? Math.max(
                  64,
                  Math.min(
                    2048,
                    Math.round(
                      size / (canvas.clientWidth / canvas.clientHeight),
                    ),
                  ),
                )
              : size;
          renderer.setSize(size, height, false);
          const pose = options.camera;
          const shot =
            name === "current" && !pose
              ? camera.clone()
              : (pose?.projection ??
                    options.projection ??
                    (name === "perspective"
                      ? "perspective"
                      : "orthographic")) === "perspective"
                ? perspective.clone()
                : orthographic.clone();
          let target =
            name === "current" && !pose
              ? orbit.target.clone()
              : aim(
                  shot,
                  VIEWS[name] ?? VIEWS.perspective,
                  // Explicit observation roots define the frame, independent
                  // of a human's selection elsewhere in the document.
                  options.ids ? false : options.focus,
                  size / height,
                );
          if (pose) {
            const vector = (v) =>
              Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
            if (
              !vector(pose.position) ||
              !vector(pose.target) ||
              (pose.up && !vector(pose.up))
            )
              throw new Error(
                "Camera needs finite position and target vectors",
              );
            shot.position.fromArray(pose.position);
            target = new THREE.Vector3(...pose.target);
            shot.up.fromArray(pose.up ?? [0, 1, 0]);
            if (
              shot.position.distanceTo(target) < 1e-8 ||
              shot.up.length() < 1e-8
            )
              throw new Error("Degenerate camera pose");
            // Without explicit clipping, keep the depth range of the named views: a fixed
            // 0.0001–10000 m range leaves too little depth precision (striped surfaces).
            const distance = shot.position.distanceTo(target);
            shot.near = pose.near ?? Math.max(0.0001, distance / 10000);
            shot.far = pose.far ?? Math.max(100, distance * 20);
            if (
              !(
                shot.near > 0 &&
                shot.far > shot.near &&
                Number.isFinite(shot.far)
              )
            )
              throw new Error("Invalid camera clipping range");
            if (shot.isPerspectiveCamera) {
              shot.fov = pose.fov ?? 38;
              if (!(shot.fov > 0 && shot.fov < 180))
                throw new Error("Invalid camera FOV");
            } else {
              const h =
                pose.height ??
                (pose.top !== undefined ? pose.top - pose.bottom : 1);
              if (!(h > 0 && Number.isFinite(h)))
                throw new Error("Invalid orthographic height");
              shot.top = h / 2;
              shot.bottom = -h / 2;
              shot.left = ((-h / 2) * size) / height;
              shot.right = ((h / 2) * size) / height;
              shot.zoom = pose.zoom ?? 1;
            }
            shot.zoom = pose.zoom ?? 1;
            if (!(shot.zoom > 0 && Number.isFinite(shot.zoom)))
              throw new Error("Invalid camera zoom");
            shot.lookAt(target);
          }
          if (shot.isPerspectiveCamera) shot.aspect = size / height;
          shot.updateProjectionMatrix();
          shot.updateMatrixWorld();
          showReferences(options.references ? name : "");
          renderer.render(scene, shot);
          return {
            view: name,
            width: size,
            height,
            mimeType: "image/png",
            dataUrl: canvas.toDataURL("image/png"),
            camera: cameraInfo(shot, target),
            shading,
            observation,
          };
        });
      } finally {
        viewState = previous.viewState;
        shading = previous.shading;
        wireframe = previous.wireframe;
        for (const [id, o] of model.objects) o.visible = shown(id);
        for (const o of model.overlays.values()) o.visible = true;
        applyShading();
        temporary.forEach((m) => m.dispose());
        updateWires();
        refreshSelection();
        grid.visible = previous.grid;
        floor.visible = previous.floor;
        highlights.visible = previous.highlights;
        wires.visible = previous.wires;
        transform.getHelper().visible = previous.helper;
        showReferences();
        renderer.setPixelRatio(previous.ratio);
        renderer.setSize(previous.size.x, previous.size.y, false);
        render();
      }
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      orbit.dispose();
      transform.dispose();
      disposeModel();
      clear(highlights);
      clear(wires);
      grid.geometry.dispose();
      grid.material.dispose();
      floor.geometry.dispose();
      floor.material.dispose();
      clay.dispose();
      silhouette.dispose();
      environment?.dispose();
      renderer.dispose().catch(onError);
      boxOverlay.remove();
    },
  };
}

function exportModel(
  project,
  { ids, mergeStatic = [], origin = "world", rootName } = {},
) {
  if (!["world", "asset-root", "ground-center"].includes(origin))
    throw new Error("Unknown export origin");
  if (origin === "asset-root" && ids?.length !== 1)
    throw new Error("Asset-root origin needs exactly one export root");
  if (
    rootName !== undefined &&
    (typeof rootName !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(rootName))
  )
    throw new Error("rootName uses letters, digits, _ . - (1–64)");
  const scoped = exportScope(project, { ids }),
    model = buildModel(scoped),
    nodes = new Map(scoped.nodes.map((n) => [n.id, n]));
  const included = (id) => !!nodes.get(id)?.mesh;
  // Sockets travel as empties named socket_<name> under their part, tags in the extras.
  for (const node of scoped.nodes)
    for (const [name, frame] of Object.entries(node.sockets ?? {})) {
      const empty = new THREE.Object3D();
      empty.name = `socket_${name}`;
      empty.position.fromArray(frame.position);
      empty.rotation.set(...frame.rotation.map(THREE.MathUtils.degToRad));
      if (frame.tags?.length) empty.userData = { tags: [...frame.tags] };
      model.objects.get(node.id).add(empty);
    }
  model.root.updateMatrixWorld(true);
  const anchor = new THREE.Vector3();
  if (origin === "asset-root")
    model.objects.get(ids[0]).getWorldPosition(anchor);
  else if (origin === "ground-center") {
    const box = new THREE.Box3().setFromObject(model.root, true);
    if (!box.isEmpty()) {
      box.getCenter(anchor);
      anchor.y = box.min.y;
    }
  }
  model.origin = {
    mode: origin,
    point: anchor.toArray(),
    up: "Y",
    front: "+Z",
  };
  model.root.position.sub(anchor);
  model.root.updateMatrixWorld(true);
  if (rootName !== undefined) {
    // The library convention: one <id>_ROOT node holds the asset. A single top-level
    // part becomes that root itself, without another wrapper.
    const tops = scoped.nodes.filter((n) => n.parent === null);
    if (tops.length === 1) {
      const top = model.objects.get(tops[0].id),
        wrapper = model.root;
      wrapper.remove(top);
      top.applyMatrix4(wrapper.matrix);
      top.name = rootName;
      model.root = top;
      top.updateMatrixWorld(true);
    } else model.root.name = rootName;
  }
  // "auto": every mesh directly under the root is static; meshes in groups move.
  if (mergeStatic === "auto")
    mergeStatic = model.root.children
      .filter((o) => o.isMesh && !o.children.length && nodes.has(o.name))
      .map((o) => o.name);
  model.mergedStatic = mergeStatic;
  if (mergeStatic.length) {
    if (
      new Set(mergeStatic).size !== mergeStatic.length ||
      mergeStatic.some(
        (id) =>
          !included(id) ||
          !model.objects.get(id)?.isMesh ||
          (nodes.size && project.nodes.some((n) => n.parent === id)),
      )
    ) {
      model.dispose();
      throw new Error(
        "Merge accepts unique included leaf mesh IDs only; keep moving parts separate",
      );
    }
    const byParent = new Map();
    for (const id of mergeStatic) {
      const o = model.objects.get(id),
        g = o.geometry.toNonIndexed();
      const parent = o.parent;
      const byMaterial = byParent.get(parent) ?? new Map();
      byParent.set(parent, byMaterial);
      g.applyMatrix4(
        new THREE.Matrix4()
          .copy(parent.matrixWorld)
          .invert()
          .multiply(o.matrixWorld),
      );
      for (const group of g.groups) {
        const material = o.material[group.materialIndex],
          bucket = byMaterial.get(material) ?? {
            pieces: [],
            sourceIds: new Set(),
          };
        const piece = new THREE.BufferGeometry();
        for (const name of ["position", "normal"])
          piece.setAttribute(
            name,
            new THREE.Float32BufferAttribute(
              g.attributes[name].array.slice(
                group.start * 3,
                (group.start + group.count) * 3,
              ),
              3,
            ),
          );
        bucket.pieces.push(piece);
        bucket.sourceIds.add(id);
        byMaterial.set(material, bucket);
      }
      g.dispose();
      o.removeFromParent();
    }
    let i = 0;
    for (const [parent, byMaterial] of byParent)
      for (const [material, { pieces, sourceIds }] of byMaterial) {
        const g = mergeGeometries(pieces),
          o = new THREE.Mesh(g, material);
        const indexed = indexAttributes(
          g.attributes.position.array,
          g.attributes.normal.array,
        );
        g.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(indexed.positions, 3),
        );
        g.setAttribute(
          "normal",
          new THREE.Float32BufferAttribute(indexed.normals, 3),
        );
        g.setIndex(indexed.indices);
        pieces.forEach((p) => p.dispose());
        // Library convention: static__<material> under the root, <pivot>__<material>
        // under a moving part.
        const base =
          parent === model.root
            ? `static__${material.name}`
            : `${parent.name}__${material.name}`;
        o.name = base;
        for (let n = 2; model.objects.has(o.name); n++) o.name = `${base}-${n}`;
        i++;
        o.userData = { sourceIds: [...sourceIds] };
        parent.add(o);
        model.objects.set(o.name, o);
      }
  }
  return model;
}
function modelReport(project, model, options) {
  const meshes = [];
  model.root.traverse((o) => {
    if (o.isMesh) meshes.push(o);
  });
  const geometries = new Set(meshes.map((o) => o.geometry)),
    groups = new Map();
  for (const o of meshes) {
    const list = groups.get(o.geometry) ?? [];
    list.push(o.name);
    groups.set(o.geometry, list);
  }
  const box = new THREE.Box3().setFromObject(model.root, true),
    sourceIds = new Set(
      meshes.flatMap((o) => o.userData.sourceIds ?? [o.name]),
    );
  return {
    editableVertices: project.nodes
      .filter((o) => sourceIds.has(o.id))
      .reduce((n, o) => n + (o.mesh?.vertices.length ?? 0), 0),
    renderVertices: meshes.reduce(
      (n, o) => n + o.geometry.attributes.position.count,
      0,
    ),
    uniqueGeometryVertices: [...geometries].reduce(
      (n, g) => n + g.attributes.position.count,
      0,
    ),
    triangles: meshes.reduce(
      (n, o) =>
        n +
        (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3,
      0,
    ),
    meshes: meshes.length,
    uniqueGeometries: geometries.size,
    drawCalls: meshes.reduce((n, o) => n + (o.geometry.groups.length || 1), 0),
    sharedGeometry: [...groups.values()].filter((ids) => ids.length > 1),
    bounds: box.isEmpty()
      ? null
      : { min: box.min.toArray(), max: box.max.toArray() },
    scope: options.ids ?? "all",
    origin: model.origin,
    mergedStatic: model.mergedStatic ?? options.mergeStatic ?? [],
    mergeGroups: meshes
      .filter((o) => o.userData.sourceIds)
      .map((o) => ({
        id: o.name,
        parent: o.parent === model.root ? null : o.parent.name,
        material: o.material.name,
        sourceIds: o.userData.sourceIds,
      })),
    notes: [
      "drawCalls counts material groups, excluding shadow passes",
      "Sharing geometry saves buffers; it does not combine draw calls",
    ],
  };
}
export function exportReport(project, options = {}) {
  const model = exportModel(project, options);
  try {
    return {
      ...modelReport(project, model, options),
      validation: exportValidation(project, options),
    };
  } finally {
    model.dispose();
  }
}
export async function exportAsset(project, options = {}) {
  const validation = assertExportable(project, options);
  const model = exportModel(project, options);
  try {
    const report = modelReport(project, model, options);
    const buffer = nameMeshes(
      new Uint8Array(
        await new GLTFExporter().parseAsync(model.root, {
          binary: true,
          trs: true,
          onlyVisible: true,
        }),
      ),
    ).buffer;
    return {
      buffer,
      report: {
        ...report,
        bytes: buffer.byteLength,
        validation,
        forced: !validation.ok && !!options.force,
      },
    };
  } finally {
    model.dispose();
  }
}
export async function exportGLB(project, options = {}) {
  return (await exportAsset(project, options)).buffer;
}
