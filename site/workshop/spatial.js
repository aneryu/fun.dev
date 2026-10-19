// Small affine helpers shared by the document engine, inspector and viewport.
// Column-major matrices, XYZ Euler degrees; no renderer or DOM dependency.
import {
  transformVector,
  add,
  sub,
  mul,
  dot,
  cross,
  normal,
  fail,
} from "./mesh.js";
import { connectivityToken } from "./components.js";
export const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function matrix(node) {
  const columns = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ].map((v) => transformVector(v, node.rotation, node.scale));
  return [
    ...columns[0],
    0,
    ...columns[1],
    0,
    ...columns[2],
    0,
    ...node.position,
    1,
  ];
}
export function multiply(a, b) {
  return Array.from({ length: 16 }, (_, i) =>
    [0, 1, 2, 3].reduce(
      (s, k) => s + a[(i % 4) + k * 4] * b[k + Math.floor(i / 4) * 4],
      0,
    ),
  );
}
export function point(m, v) {
  return [0, 1, 2].map(
    (i) => m[i] * v[0] + m[i + 4] * v[1] + m[i + 8] * v[2] + m[i + 12],
  );
}
export const direction = (m, v) => sub(point(m, v), point(m, [0, 0, 0]));
export const determinant = (m) =>
  dot(m.slice(0, 3), cross(m.slice(4, 7), m.slice(8, 11)));
export function inverse(m) {
  const a = m.slice(0, 3),
    b = m.slice(4, 7),
    c = m.slice(8, 11),
    d = dot(a, cross(b, c));
  if (!Number.isFinite(d) || Math.abs(d) < 1e-14) fail("Transform is singular");
  const rows = [cross(b, c), cross(c, a), cross(a, b)].map((v) =>
      mul(v, 1 / d),
    ),
    out = identity();
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) out[i + j * 4] = rows[i][j];
  out.splice(12, 3, ...mul(direction(out, m.slice(12, 15)), -1));
  return out;
}
export function worldMatrix(project, id, seen = new Set()) {
  if (id == null) return identity();
  if (seen.has(id)) fail("Parent cycle");
  seen.add(id);
  const node = project.nodes.find((n) => n.id === id);
  if (!node) fail(`Unknown node: ${id}`);
  return multiply(worldMatrix(project, node.parent, seen), matrix(node));
}
export function decompose(m) {
  const scale = [0, 4, 8].map((i) => Math.hypot(...m.slice(i, i + 3)));
  if (scale.some((s) => s < 1e-12) || determinant(m) <= 0) return null;
  const columns = [0, 4, 8].map((i, j) => mul(m.slice(i, i + 3), 1 / scale[j]));
  if (
    Math.max(
      Math.abs(dot(columns[0], columns[1])),
      Math.abs(dot(columns[0], columns[2])),
      Math.abs(dot(columns[1], columns[2])),
    ) > 1e-8
  )
    return null;
  const y = Math.asin(Math.max(-1, Math.min(1, columns[2][0])));
  const x =
    Math.abs(columns[2][0]) < 0.9999999
      ? Math.atan2(-columns[2][1], columns[2][2])
      : Math.atan2(columns[1][2], columns[1][1]);
  const z =
    Math.abs(columns[2][0]) < 0.9999999
      ? Math.atan2(-columns[1][0], columns[0][0])
      : 0;
  return {
    position: m.slice(12, 15),
    rotation: [x, y, z].map((v) => (v * 180) / Math.PI),
    scale,
  };
}
export function transformMesh(mesh, m) {
  mesh.vertices = mesh.vertices.map((v) => point(m, v));
  if (determinant(m) < 0) mesh.faces.forEach((f) => f.vertices.reverse());
}
// Affine reflection changes winding, but not face identity. Preserve manual
// paint references only when their original topology is still valid.
export function transformNodeMesh(node, m) {
  const paint = node.recipe?.paint;
  const valid =
    paint &&
    (!paint.layout || paint.layout === connectivityToken(node.mesh)) &&
    paint.faces.every(
      (f) =>
        JSON.stringify(f.vertices) ===
        JSON.stringify(node.mesh.faces.find((v) => v.id === f.id)?.vertices),
    );
  transformMesh(node.mesh, m);
  if (valid) {
    if (determinant(m) < 0) paint.faces.forEach((f) => f.vertices.reverse());
    if (paint.layout) paint.layout = connectivityToken(node.mesh);
  }
}
// Bake affine residuals rather than silently losing shear during reparenting.
export function bake(project, node, m) {
  if (node.mesh) transformNodeMesh(node, m);
  if (node.generator)
    node.generator.basis = multiply(m, node.generator.basis ?? identity());
  if (node.recipe)
    node.recipe.basis = multiply(m, node.recipe.basis ?? identity());
  if (node.instanceOf)
    node.instanceBasis = multiply(m, node.instanceBasis ?? identity());
  // Appearance-preserving bakes also preserve each link's coordinate system.
  for (const other of project.nodes) {
    if (other.instanceOf === node.id)
      other.instanceBasis = multiply(
        other.instanceBasis ?? identity(),
        inverse(m),
      );
    if (other.symmetry?.reference === node.id)
      other.symmetry.basis = multiply(m, other.symmetry.basis ?? identity());
  }
  for (const child of project.nodes.filter((n) => n.parent === node.id))
    setMatrix(project, child, multiply(m, matrix(child)));
}
export function setMatrix(project, node, m) {
  const trs = decompose(m);
  if (trs) Object.assign(node, trs);
  else {
    node.position = m.slice(12, 15);
    node.rotation = [0, 0, 0];
    node.scale = [1, 1, 1];
    const linear = [...m];
    linear.splice(12, 3, 0, 0, 0);
    bake(project, node, linear);
  }
}
export function boundsOf(points) {
  if (!points.length)
    return {
      min: [0, 0, 0],
      max: [0, 0, 0],
      size: [0, 0, 0],
      center: [0, 0, 0],
    };
  const min = [0, 1, 2].map((i) => Math.min(...points.map((v) => v[i]))),
    max = [0, 1, 2].map((i) => Math.max(...points.map((v) => v[i])));
  return { min, max, size: sub(max, min), center: mul(add(min, max), 0.5) };
}
// The local points that bound a part without a mesh (docs/worlds.md): a placed model's
// bounds, a zone's corners, a path's points; a marker is its origin.
export function nodePoints(node) {
  if (node.place) {
    const { min, max } = node.place.bounds;
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [
      i & 1 ? max[0] : min[0],
      i & 2 ? max[1] : min[1],
      i & 4 ? max[2] : min[2],
    ]);
    if (!node.copies) return corners;
    const points = [];
    for (const [x, y, z, rx, ry, rz, s] of node.copies) {
      const m = matrix({ position: [x, y, z], rotation: [rx, ry, rz], scale: [s, s, s] });
      for (const c of corners) points.push(point(m, c));
    }
    return points;
  }
  if (node.zone) {
    const z = node.zone;
    if (z.kind === "polygon") return z.polygon.flatMap(([x, zz]) => [[x, z.y[0], zz], [x, z.y[1], zz]]);
    if (z.kind === "box") {
      const h = z.size.map((v) => v / 2);
      return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? h[0] : -h[0], i & 2 ? h[1] : -h[1], i & 4 ? h[2] : -h[2]]);
    }
    const r = z.radius;
    return [[-r, 0, 0], [r, 0, 0], [0, -r, 0], [0, r, 0], [0, 0, -r], [0, 0, r]];
  }
  if (node.path) return node.path.points.map((p) => [...p]);
  if (node.grid) {
    const g = node.grid, top = g.levels ? Math.max(...g.levels) * g.step : 0, w = g.size[0] * g.cell, d = g.size[1] * g.cell;
    return [[0, 0, 0], [w, 0, 0], [w, 0, d], [0, 0, d], [0, top, 0], [w, top, 0], [w, top, d], [0, top, d]];
  }
  if (node.terrain) {
    const t = node.terrain;
    let lo = Infinity, hi = -Infinity;
    for (const h of t.heights) { if (h < lo) lo = h; if (h > hi) hi = h; }
    const w = (t.samples[0] - 1) * t.cell, d = (t.samples[1] - 1) * t.cell;
    return [[0, lo, 0], [w, lo, 0], [w, lo, d], [0, lo, d], [0, hi, 0], [w, hi, 0], [w, hi, d], [0, hi, d]];
  }
  return [[0, 0, 0]];
}
export function nodeInfo(project, id, { components = true } = {}) {
  const node = project.nodes.find((n) => n.id === id);
  if (!node) fail(`Unknown node: ${id}`);
  const world = worldMatrix(project, id),
    vertices = (node.mesh?.vertices ?? nodePoints(node)).map((v) => point(world, v));
  return {
    worldMatrix: world,
    bounds: boundsOf(vertices),
    origin: point(world, [0, 0, 0]),
    ...(components
      ? {
          faces:
            node.mesh?.faces.map((f) => ({
              id: f.id,
              vertices: [...f.vertices],
              center: mul(
                f.vertices.reduce((s, i) => add(s, vertices[i]), [0, 0, 0]),
                1 / f.vertices.length,
              ),
              normal: normal(vertices, f.vertices),
              material: f.material,
            })) ?? [],
        }
      : {}),
  };
}
export function reflection(axis, offset = 0) {
  const m = identity(),
    i = ["x", "y", "z"].indexOf(axis);
  if (i < 0) fail("Expected x, y or z axis");
  m[i + i * 4] = -1;
  m[12 + i] = 2 * offset;
  return m;
}
