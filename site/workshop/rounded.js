// A box with rounded edges and corners: the convex hull of eight sampled corner spheres.
// The six flat sides come first, in the plain box's face order (f0 -Z … f5 +Y), so their
// IDs mean the same thing with or without rounding.
import { fail, cross, sub, dot } from "./mesh.js";
import { kernel } from "./kernel.js";
import { polygonize } from "./solid.js";

const SIDES = [
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
];

export function roundedBox(size, radius, segments, material) {
  const half = size.map((v) => v / 2);
  if (radius >= Math.min(...half))
    fail("Bevel is too wide for this box", "options.bevel");
  const points = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const center = [sx, sy, sz].map((s, k) => s * (half[k] - radius));
        for (let i = 0; i <= segments; i++)
          for (let j = 0; j <= segments; j++) {
            const theta = (Math.PI / 2) * (i / segments),
              phi = (Math.PI / 2) * (j / segments);
            const d = [
              Math.sin(theta) * Math.cos(phi) * sx,
              Math.cos(theta) * sy,
              Math.sin(theta) * Math.sin(phi) * sz,
            ];
            points.push(center.map((c, k) => c + radius * d[k]));
          }
      }
  const hull = kernel().Manifold.hull(points);
  let mesh;
  try {
    const result = hull.getMesh(),
      positions = [];
    for (let i = 0; i < result.vertProperties.length / result.numProp; i++)
      positions.push(
        [0, 1, 2].map((k) => result.vertProperties[i * result.numProp + k]),
      );
    const triangles = [],
      planes = [];
    for (let t = 0; t < result.triVerts.length / 3; t++) {
      const tri = [...result.triVerts.slice(t * 3, t * 3 + 3)];
      const n = cross(
        sub(positions[tri[1]], positions[tri[0]]),
        sub(positions[tri[2]], positions[tri[0]]),
      );
      const length = Math.hypot(...n) || 1,
        unit = n.map((v) => v / length);
      triangles.push(tri);
      // Coplanar triangles share a key and merge into one polygon.
      planes.push(
        [...unit, dot(unit, positions[tri[0]])]
          .map((v) => Math.round(v * 1e5) / 1e5 || 0)
          .join(","),
      );
    }
    mesh = polygonize(
      positions,
      triangles,
      planes,
      triangles.map(() => material),
    );
  } finally {
    hull.delete();
  }
  const sideOf = (face) => {
    const ps = face.vertices.map((i) => mesh.vertices[i]);
    return SIDES.findIndex((axis) => {
      const k = axis.findIndex((v) => v !== 0);
      return ps.every((p) => Math.abs(p[k] - axis[k] * half[k]) < 1e-6);
    });
  };
  const sides = [],
    rest = [];
  for (const face of mesh.faces) {
    const side = sideOf(face);
    if (side >= 0) sides[side] = face;
    else rest.push(face);
  }
  if (sides.filter(Boolean).length !== 6)
    fail("Rounded box needs room for its flat sides", "options.bevel");
  mesh.faces = [...sides, ...rest].map((face, i) => ({ ...face, id: `f${i}` }));
  return mesh;
}
