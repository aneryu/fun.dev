// A scene as a .fun3d tile (docs/worlds.md §3.1): the project's own parts as geometry,
// placed library models as references, markers as tagged nodes with their parameters, zones
// and paths as the tile's data tables in tile space, and the project in the editing section
// so the tile reopens in the workshop.
import * as THREE from "/runtime/three.js";
import { createWriter } from "../runtime/kit/fun3d-write.js";
import { idFromName } from "../runtime/kit/fun3d-schema.js";
import { buildModel } from "./viewport.js";
import { worldMatrix, point } from "./spatial.js";
import { solidBounds } from "./audit.js";
import { statistics } from "./document.js";
import { runtimeRule, sweepProfiles } from "./rules.js";
import { terrainMesh } from "../runtime/kit/terrain.js";
import { gridMesh } from "../runtime/kit/grid.js";

const round = (v) => Math.round(v * 1e6) / 1e6;

/** The scene's world bounds: every solid part, or the origin for an empty scene. */
export function sceneBounds(project) {
  const solids = solidBounds(project);
  if (!solids.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  return {
    min: [0, 1, 2].map((i) => round(Math.min(...solids.map((s) => s.min[i])))),
    max: [0, 1, 2].map((i) => round(Math.max(...solids.map((s) => s.max[i])))),
  };
}

/**
 * Writes a project as one tile. In a world (`world: { id, x, z, size, bounds, far, level,
 * data }`, see world-export.js) a tile carries geometry only: the markers, zones and paths
 * belong to the world's data file (`world.data: true` writes that file), its tile record
 * names the world, and `physics: false` / `edit: false` leave bodies and the project out.
 * `source` is the whole project when `project` is a cut of it (runtime rules read it).
 */
export async function exportTile(project, { name = project.name, runtime = [], world = null, physics: wantPhysics = true, edit: wantEdit = true, source = null } = {}) {
  const model = buildModel(project);
  const tables = !world || !!world.data;
  try {
    // The root's name must not collide with a part's id.
    model.root.name = project.nodes.some((n) => n.id === "scene") ? "scene_root" : "scene";
    const refs = new Map();
    for (const node of project.nodes) {
      const o = model.objects.get(node.id);
      // A pure marker in a world tile is the data file's; its node stays only as a pivot.
      const carries = tables || !node.marker;
      if (carries && node.tags?.length) o.userData.tags = [...node.tags];
      if (carries && node.params) o.userData.params = structuredClone(node.params);
      if (node.sockets)
        o.userData.sockets = Object.fromEntries(
          Object.entries(node.sockets).map(([name, f]) => [
            name,
            { position: [...f.position], rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(...f.rotation.map(THREE.MathUtils.degToRad), "XYZ")).toArray().map((v) => Math.round(v * 1e7) / 1e7) },
          ]),
        );
      if (node.place) {
        if (!refs.has(node.place.model)) refs.set(node.place.model, `m${refs.size}`);
        o.userData.fun3dModel = {
          ref: refs.get(node.place.model),
          ...(node.place.variants ? { variants: { ...node.place.variants } } : {}),
          ...(node.place.tint ? { tint: [...node.place.tint] } : {}),
        };
        if (node.copies) {
          // Copies replace the part's own transform in the file: each matrix in the parent's space.
          const copies = new Float32Array(node.copies.length * 16),
            m = new THREE.Matrix4();
          node.copies.forEach((row, i) => {
            m.compose(
              new THREE.Vector3(row[0], row[1], row[2]),
              new THREE.Quaternion().setFromEuler(new THREE.Euler(...row.slice(3, 6).map(THREE.MathUtils.degToRad), "XYZ")),
              new THREE.Vector3(row[6], row[6], row[6]),
            );
            m.premultiply(o.matrix).toArray(copies, i * 16);
          });
          o.userData.fun3dModel.copies = copies;
          if (node.tints) o.userData.fun3dModel.tints = node.tints.map((t) => [...t]);
        }
      }
      // Zones and paths live in the tables; their nodes stay only as pivots of children.
      if ((node.zone || node.path || (node.marker && !carries)) && !project.nodes.some((n) => n.parent === node.id)) o.removeFromParent();
    }
    model.root.updateMatrixWorld(true);
    const zones = [],
      points = [],
      edges = [];
    const position = new THREE.Vector3(),
      quaternion = new THREE.Quaternion(),
      scale = new THREE.Vector3();
    // Profiles come from the sweep rules; an edge names the one that swept it.
    const profiles = tables ? sweepProfiles(source ?? project) : [];
    const profileFor = (id) => profiles.find((p) => p.paths.includes(id))?.id ?? null;
    const used = new Set();
    for (const node of project.nodes) {
      if (!tables || !(node.zone || node.path)) continue;
      const m = worldMatrix(project, node.id),
        id = await idFromName(node.id),
        common = { id, ...(node.tags?.length ? { tags: [...node.tags] } : {}), ...(node.params ? { params: structuredClone(node.params) } : {}) };
      new THREE.Matrix4().fromArray(m).decompose(position, quaternion, scale);
      if (node.zone) {
        const z = node.zone;
        let shape;
        if (z.kind === "polygon") {
          const polygon = z.polygon.map(([x, zz]) => {
            const p = point(m, [x, z.y[0], zz]);
            return [round(p[0]), round(p[2])];
          });
          const bottom = point(m, [0, z.y[0], 0])[1],
            top = point(m, [0, z.y[1], 0])[1];
          shape = { polygon, y: [round(Math.min(bottom, top)), round(Math.max(bottom, top))] };
        } else if (z.kind === "box")
          shape = {
            box: {
              center: position.toArray().map(round),
              halfExtents: z.size.map((v, i) => round((v / 2) * scale.getComponent(i))),
              rotation: quaternion.toArray().map((v) => round(v)),
            },
          };
        else shape = { sphere: { center: position.toArray().map(round), radius: round(z.radius * Math.max(scale.x, scale.y, scale.z)) } };
        zones.push({ ...common, shape });
      } else {
        const start = points.length / 3;
        for (const p of node.path.points) points.push(...point(m, p).map(round));
        const profile = node.path.profile ?? profileFor(node.id);
        if (profile) used.add(profile);
        edges.push({
          ...common,
          points: node.path.points.map((_, i) => start + i),
          closed: node.path.closed,
          kind: node.path.kind ?? "data",
          ...(profile ? { profile } : {}),
          ...(node.path.lanes ? { lanes: node.path.lanes } : {}),
          ...(node.path.oneway ? { oneway: true } : {}),
          ...(node.path.speed ? { speed: node.path.speed } : {}),
        });
      }
    }
    // Terrains: a flat-shaded mesh per terrain under its node, the field as data, a static body.
    const terrains = [], physics = { shapes: [], bodies: [] };
    const terrainMaterial = new THREE.MeshStandardMaterial({ name: "mat_terrain", color: "#ffffff", roughness: 0.92, metalness: 0 });
    for (const node of project.nodes) {
      if (!node.terrain) continue;
      const o = model.objects.get(node.id), t = node.terrain;
      const { positions, normals, colors } = terrainMesh(t);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geometry.name = node.id;
      const mesh = new THREE.Mesh(geometry, terrainMaterial);
      mesh.castShadow = mesh.receiveShadow = true;
      // The writer's convention: an unnamed mesh hung under its node is the node's own.
      o.add(mesh);
      o.userData.mesh = mesh;
      const id = await idFromName(node.id), origin = point(worldMatrix(project, node.id), [0, 0, 0]).map(round);
      terrains.push({
        node: id,
        origin,
        cell: t.cell,
        samples: [...t.samples],
        heights: { stream: Float32Array.from(t.heights), format: "float32" },
        ...(t.surfaces ? { surfaces: { stream: Uint8Array.from(t.surfaces), format: "uint8" } } : {}),
        surfaceTable: t.surfaceTable.map((s) => ({ ...s })),
        ...(t.water ? { water: [{ level: t.water.level, color: t.water.color }] } : {}),
      });
      if (wantPhysics) {
        physics.shapes.push({ id: `shape_${id}`, type: "mesh", geometry: id });
        physics.bodies.push({ id: `body_${id}`, node: id, shape: `shape_${id}`, motion: "static", friction: t.surfaceTable[0].friction ?? 0.8 });
      }
    }
    // Grids: a flat-shaded mesh per grid under its node, the cell map as data, a static body.
    const grids = [];
    const gridMaterial = new THREE.MeshStandardMaterial({ name: "mat_grid", color: "#ffffff", roughness: 0.9, metalness: 0 });
    for (const node of project.nodes) {
      if (!node.grid) continue;
      const o = model.objects.get(node.id), g = node.grid;
      const { positions, normals, colors } = gridMesh(g);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geometry.name = node.id;
      const mesh = new THREE.Mesh(geometry, gridMaterial);
      mesh.castShadow = mesh.receiveShadow = true;
      o.add(mesh);
      o.userData.mesh = mesh;
      const id = await idFromName(node.id), origin = point(worldMatrix(project, node.id), [0, 0, 0]).map(round);
      grids.push({
        node: id,
        origin,
        cell: g.cell,
        size: [...g.size],
        step: g.step,
        cells: { stream: Uint8Array.from(g.cells), format: "uint8" },
        ...(g.levels ? { levels: { stream: Uint8Array.from(g.levels), format: "uint8" } } : {}),
        types: g.types.map((t) => ({ ...t })),
      });
      if (wantPhysics) {
        physics.shapes.push({ id: `shape_${id}`, type: "mesh", geometry: id });
        physics.bodies.push({ id: `body_${id}`, node: id, shape: `shape_${id}`, motion: "static", friction: 0.8 });
      }
    }
    // The project's own floors (parts tagged ground: slabs, swept roads and tracks) get a
    // static mesh body, so a game stands and drives on them.
    if (wantPhysics)
      for (const node of project.nodes) {
        if (!node.mesh || !node.tags?.includes("ground")) continue;
        const id = await idFromName(node.id);
        physics.shapes.push({ id: `shape_${id}`, type: "mesh", geometry: id });
        physics.bodies.push({ id: `body_${id}`, node: id, shape: `shape_${id}`, motion: "static", friction: 0.8 });
      }
    const bounds = sceneBounds(project);
    const record = world
      ? {
          world: world.id,
          ...(world.x !== undefined ? { x: world.x, z: world.z } : {}),
          bounds: world.bounds ?? bounds,
          size: [...world.size],
          ...(world.far ? { far: world.far } : {}),
          ...(world.level ? { level: world.level } : {}),
        }
      : { bounds, ...(project.tile ? { size: [...project.tile.size] } : {}) };
    const extensions = { "fun3d.tile": record };
    if (terrains.length) extensions["fun3d.terrain"] = terrains;
    if (grids.length) extensions["fun3d.grid"] = grids;
    if (zones.length) extensions["fun3d.zones"] = zones;
    if (edges.length) {
      extensions["fun3d.paths"] = { points: { stream: Float32Array.from(points), format: "float32x3" }, edges };
      const table = profiles.filter((p) => used.has(p.id)).map(({ id, width, lanes, kind }) => ({ id, width, lanes, kind }));
      if (table.length) extensions["fun3d.paths"].profiles = table;
    }
    // Rules the game runs: pinned models (also among the refs, so a build fetches them),
    // ids as the tables name them, keep-outs from the whole project.
    if (runtime.length) {
      const names = new Map();
      for (const node of project.nodes) if (node.zone || node.path) names.set(node.id, await idFromName(node.id));
      const ids = (id) => names.get(id) ?? id;
      extensions["fun3d.rules"] = [];
      for (const { rule, records } of runtime) {
        for (const record of records) if (!refs.has(record.model)) refs.set(record.model, `m${refs.size}`);
        extensions["fun3d.rules"].push(runtimeRule(source ?? project, rule, records, ids));
      }
    }
    const writer = createWriter({ THREE });
    const bytes = await writer.write(model.root, {
      kind: "model",
      asset: { name, source: { kind: "edit", tool: "fun.dev/workshop" } },
      refs: [...refs].map(([modelId, id]) => ({ id, model: modelId })),
      extensions,
      ...(physics.bodies.length ? { physics } : {}),
      ...(wantEdit ? { edit: { tool: "fun.dev/workshop", version: 3, document: project } } : {}),
    });
    const stats = statistics(project);
    return {
      bytes,
      report: {
        bytes: bytes.length,
        bounds,
        refs: refs.size,
        placed: stats.placed,
        copies: stats.copies,
        placedTriangles: stats.placedTriangles,
        markers: stats.markers,
        zones: zones.length,
        paths: edges.length,
        rules: runtime.length,
        terrains: terrains.length,
        terrainTriangles: stats.terrainTriangles,
        grids: grids.length,
        gridTriangles: stats.gridTriangles,
        meshes: stats.meshes,
        triangles: stats.triangles,
      },
    };
  } finally {
    model.dispose();
  }
}
