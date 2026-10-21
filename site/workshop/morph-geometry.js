import * as THREE from "/runtime/three.js";
import { normal, cornerNormals, triangulate } from "./mesh.js";

// Preserve a render-corner -> editable-vertex correspondence. Coincident base
// positions can have different target deltas, so position/normal-only welding
// would lose authoring data.
export function morphGeometry(node) {
  const { base, targets } = node.morph ?? { base: node.skin.base, targets: [] }, faces = node.mesh.faces;
  const materials = [...new Set(faces.map(f => f.material))];
  const refs = [], geometry = new THREE.BufferGeometry();
  for (const [slot, material] of materials.entries()) {
    const start = refs.length;
    faces.forEach((face, index) => {
      if (face.material !== material) return;
      for (const triangle of triangulate(base, face.vertices))
        for (const vertex of triangle) refs.push({ vertex, face: index, corner: face.vertices.indexOf(vertex) });
    });
    geometry.addGroup(start, refs.length - start, slot);
  }
  const normals = vertices => {
    const corners = node.smooth ? cornerNormals({ vertices, faces }, node.smooth) : null;
    const flat = corners ? null : faces.map(f => normal(vertices, f.vertices));
    return refs.flatMap(r => corners ? corners[r.face][r.corner] : flat[r.face]);
  };
  const baseNormals = normals(base);
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(refs.flatMap(r => base[r.vertex]), 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(baseNormals, 3));
  geometry.setIndex(refs.map((_, i) => i));
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = [];
  geometry.morphAttributes.normal = [];
  for (const target of targets) {
    const positions = new THREE.Float32BufferAttribute(refs.flatMap(r => target.deltas[r.vertex]), 3);
    positions.name = target.name;
    const targetNormals = normals(base.map((p, i) => p.map((v, k) => v + target.deltas[i][k])));
    const deltaNormals = new THREE.Float32BufferAttribute(targetNormals.map((v, i) => v - baseNormals[i]), 3);
    deltaNormals.name = target.name;
    geometry.morphAttributes.position.push(positions);
    geometry.morphAttributes.normal.push(deltaNormals);
  }
  geometry.computeBoundingSphere();
  if (node.skin) {
    geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(refs.flatMap(r =>
      Array.from({ length: 4 }, (_, i) => node.skin.weights[r.vertex][i]?.joint ?? 0)), 4));
    geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(refs.flatMap(r =>
      Array.from({ length: 4 }, (_, i) => node.skin.weights[r.vertex][i]?.weight ?? 0)), 4));
  }
  return { geometry, materials };
}
