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

export async function exportTile(project, { name = project.name } = {}) {
  const model = buildModel(project);
  try {
    // The root's name must not collide with a part's id.
    model.root.name = project.nodes.some((n) => n.id === "scene") ? "scene_root" : "scene";
    const refs = new Map();
    for (const node of project.nodes) {
      const o = model.objects.get(node.id);
      if (node.tags?.length) o.userData.tags = [...node.tags];
      if (node.params) o.userData.params = structuredClone(node.params);
      if (node.place) {
        if (!refs.has(node.place.model)) refs.set(node.place.model, `m${refs.size}`);
        o.userData.fun3dModel = {
          ref: refs.get(node.place.model),
          ...(node.place.variants ? { variants: { ...node.place.variants } } : {}),
          ...(node.place.tint ? { tint: [...node.place.tint] } : {}),
        };
      }
      // Zones and paths live in the tile's tables; their nodes stay only as pivots of children.
      if ((node.zone || node.path) && !project.nodes.some((n) => n.parent === node.id)) o.removeFromParent();
    }
    model.root.updateMatrixWorld(true);
    const zones = [],
      points = [],
      edges = [];
    const position = new THREE.Vector3(),
      quaternion = new THREE.Quaternion(),
      scale = new THREE.Vector3();
    for (const node of project.nodes) {
      if (!(node.zone || node.path)) continue;
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
        edges.push({ ...common, points: node.path.points.map((_, i) => start + i), closed: node.path.closed, kind: "data" });
      }
    }
    const bounds = sceneBounds(project);
    const extensions = { "fun3d.tile": { bounds, ...(project.tile ? { size: [...project.tile.size] } : {}) } };
    if (zones.length) extensions["fun3d.zones"] = zones;
    if (edges.length) extensions["fun3d.paths"] = { points: { stream: Float32Array.from(points), format: "float32x3" }, edges };
    const writer = createWriter({ THREE });
    const bytes = await writer.write(model.root, {
      kind: "model",
      asset: { name, source: { kind: "edit", tool: "fun.dev/workshop" } },
      refs: [...refs].map(([modelId, id]) => ({ id, model: modelId })),
      extensions,
      edit: { tool: "fun.dev/workshop", version: 3, document: project },
    });
    const stats = statistics(project);
    return {
      bytes,
      report: {
        bytes: bytes.length,
        bounds,
        refs: refs.size,
        placed: stats.placed,
        placedTriangles: stats.placedTriangles,
        markers: stats.markers,
        zones: zones.length,
        paths: edges.length,
        meshes: stats.meshes,
        triangles: stats.triangles,
      },
    };
  } finally {
    model.dispose();
  }
}
