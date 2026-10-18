// Editable polygon meshes. IDs belong to faces, not generated render triangles.
import { extrudeShape, revolveShape, sweepShape } from "./generators.js";
import { roundedBox } from "./rounded.js";
export class ModelError extends Error {
  constructor(message, code = "invalid", path = "") {
    super(message);
    this.name = "ModelError";
    this.code = code;
    this.path = path;
  }
}
export const fail = (message, path = "") => {
  throw new ModelError(message, "invalid", path);
};
export const sub = (a, b) => a.map((v, i) => v - b[i]);
export const add = (a, b) => a.map((v, i) => v + b[i]);
export const mul = (a, n) => a.map((v) => v * n);
export const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export function vector(value, path = "vector") {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((v) => !Number.isFinite(v) || Math.abs(v) > 10000)
  )
    fail("Expected three finite coordinates within ±10000", path);
  return value.map((v) => (v === 0 ? 0 : v));
}
export function number(value, min, max, path = "number") {
  if (!Number.isFinite(value) || value < min || value > max)
    fail(`Expected a number from ${min} to ${max}`, path);
  return value;
}
function segments(value, fallback) {
  const result = number(value ?? fallback, 3, 64, "segments");
  if (!Number.isInteger(result)) fail("Segments must be an integer");
  return result;
}
export function normal(vertices, face) {
  const n = [0, 0, 0];
  for (let i = 0; i < face.length; i++) {
    const a = vertices[face[i]],
      b = vertices[face[(i + 1) % face.length]];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const length = Math.hypot(...n);
  if (length < 1e-10) fail("Face has zero area");
  return mul(n, 1 / length);
}

// Ear clipping in the face's dominant plane supports concave outlines. Non-planar
// polygons keep a deterministic triangulation and are reported by validation.
export function triangulate(vertices, face) {
  const n = normal(vertices, face);
  const axis = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs)));
  const points = face.map((id) => vertices[id].filter((_, i) => i !== axis));
  const turn = (a, b, c) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const area = points.reduce((sum, a, i) => {
    const b = points[(i + 1) % points.length];
    return sum + a[0] * b[1] - b[0] * a[1];
  }, 0);
  const sign = Math.sign(area);
  const intersects = (a, b, c, d) =>
    turn(a, b, c) * turn(a, b, d) < -1e-14 &&
    turn(c, d, a) * turn(c, d, b) < -1e-14;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      if (
        intersects(
          points[i],
          points[(i + 1) % points.length],
          points[j],
          points[(j + 1) % points.length],
        )
      )
        fail("Face outline intersects itself");
    }
  const left = points.map((_, i) => i),
    triangles = [];
  while (left.length > 3) {
    let clipped = false;
    for (let i = 0; i < left.length; i++) {
      const a = left[(i + left.length - 1) % left.length],
        b = left[i],
        c = left[(i + 1) % left.length];
      if (sign * turn(points[a], points[b], points[c]) <= 1e-12) continue;
      if (
        left.some(
          (p) =>
            p !== a &&
            p !== b &&
            p !== c &&
            sign * turn(points[a], points[b], points[p]) >= -1e-12 &&
            sign * turn(points[b], points[c], points[p]) >= -1e-12 &&
            sign * turn(points[c], points[a], points[p]) >= -1e-12,
        )
      )
        continue;
      triangles.push([face[a], face[b], face[c]]);
      left.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped)
      fail("Cannot triangulate face; check overlapping or collinear vertices");
  }
  if (sign * turn(...left.map((i) => points[i])) <= 1e-12)
    fail("Degenerate face triangle");
  triangles.push(left.map((i) => face[i]));
  return triangles;
}

const mesh = (vertices, faces, material) => ({
  vertices,
  faces: faces.map((vertices, i) => ({ id: `f${i}`, vertices, material })),
});
export function primitive(kind, options = {}, material = "yellow") {
  if (kind === "box") {
    const [x, y, z] = vector(options.size ?? [1, 1, 1]).map(
      (v) => number(v, 0.001, 1000) / 2,
    );
    const result = mesh(
      [
        [-x, -y, -z],
        [x, -y, -z],
        [x, y, -z],
        [-x, y, -z],
        [-x, -y, z],
        [x, -y, z],
        [x, y, z],
        [-x, y, z],
      ],
      [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 4, 7, 3],
        [1, 2, 6, 5],
        [0, 1, 5, 4],
        [3, 7, 6, 2],
      ],
      material,
    );
    if (options.bevel) {
      const rounding = options.bevelSegments ?? 1;
      if (!Number.isInteger(rounding) || rounding < 1 || rounding > 16)
        fail("Bevel segments must be an integer from 1 to 16");
      // More than one segment rounds the edges (kernel hull of corner spheres).
      if (rounding > 1)
        return roundedBox(
          [x, y, z].map((v) => v * 2),
          number(options.bevel, 0.00001, 1000),
          rounding,
          material,
        );
      bevelMesh(result, options.bevel);
    }
    return result;
  }
  if (["sphere", "cylinder", "cone", "lathe"].includes(kind)) {
    const count = segments(options.segments, 8);
    let profile;
    if (kind === "sphere") {
      const rings = segments(options.rings, 6),
        radius = number(options.radius ?? 0.5, 0.001, 1000);
      profile = Array.from({ length: rings + 1 }, (_, i) => [
        i === 0 || i === rings ? 0 : radius * Math.sin((Math.PI * i) / rings),
        -radius * Math.cos((Math.PI * i) / rings),
      ]);
    } else if (kind === "lathe") {
      profile = options.profile;
      if (!Array.isArray(profile) || profile.length < 2 || profile.length > 64)
        fail("Lathe needs 2–64 [radius, height] points");
      profile = profile.map((p) => {
        if (!Array.isArray(p) || p.length !== 2) fail("Invalid lathe point");
        return [number(p[0], 0, 1000), number(p[1], -1000, 1000)];
      });
      if (
        profile.some(
          (p, i) =>
            i &&
            Math.hypot(p[0] - profile[i - 1][0], p[1] - profile[i - 1][1]) <
              1e-8,
        )
      )
        fail("Repeated lathe profile point");
      const outline = [[0, profile[0][1]], ...profile, [0, profile.at(-1)[1]]];
      const area = outline.reduce((sum, a, i) => {
        const b = outline[(i + 1) % outline.length];
        return sum + a[0] * b[1] - b[0] * a[1];
      }, 0);
      if (Math.abs(area) < 1e-10) fail("Lathe profile has zero volume");
      if (area < 0) profile.reverse();
      const turn = (a, b, c) =>
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      for (let i = 0; i < profile.length - 1; i++)
        for (let j = i + 2; j < profile.length - 1; j++) {
          const [a, b, c, d] = [
            profile[i],
            profile[i + 1],
            profile[j],
            profile[j + 1],
          ];
          if (
            turn(a, b, c) * turn(a, b, d) < -1e-12 &&
            turn(c, d, a) * turn(c, d, b) < -1e-12
          )
            fail("Lathe profile intersects itself");
        }
    } else {
      const radius = number(options.radius ?? 0.5, 0.001, 1000),
        h = number(options.height ?? 1, 0.001, 1000) / 2;
      profile = [
        [radius, -h],
        [kind === "cone" ? 0 : radius, h],
      ];
    }
    const vertices = [],
      faces = [];
    const rows = profile.map(([r, y]) =>
      Array.from({ length: r === 0 ? 1 : count }, (_, i) => {
        const id = vertices.length,
          angle = (2 * Math.PI * i) / count;
        vertices.push([r * Math.cos(angle), y, r * Math.sin(angle)]);
        return id;
      }),
    );
    for (let j = 0; j < rows.length - 1; j++)
      for (let i = 0; i < count; i++) {
        const a = rows[j],
          b = rows[j + 1],
          next = (i + 1) % count;
        if (a.length === 1 && b.length === 1)
          fail("Consecutive points on the lathe axis form no surface");
        faces.push(
          a.length === 1
            ? [a[0], b[i], b[next]]
            : b.length === 1
              ? [a[i], b[0], a[next]]
              : [a[i], b[i], b[next], a[next]],
        );
      }
    if (rows[0].length > 1) faces.push([...rows[0]]);
    if (rows.at(-1).length > 1) faces.push([...rows.at(-1)].reverse());
    return mesh(vertices, faces, material);
  }
  // Holes, rounded corners, revolved sections and sweeps: generators.js.
  if (kind === "extrude" && (options.holes?.length || options.round))
    return extrudeShape(options, material);
  if (kind === "revolve") return revolveShape(options, material);
  if (kind === "sweep") return sweepShape(options, material);
  if (kind === "extrude") {
    const points = options.points ?? [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ];
    if (!Array.isArray(points) || points.length < 3 || points.length > 64)
      fail("Extrude needs 3–64 [x, y] points");
    const depth = number(options.depth ?? 0.5, 0.001, 1000);
    const outline = points.map((p) => {
      if (!Array.isArray(p) || p.length !== 2) fail("Invalid outline point");
      return [number(p[0], -1000, 1000), number(p[1], -1000, 1000)];
    });
    if (
      outline.reduce((sum, a, i) => {
        const b = outline[(i + 1) % outline.length];
        return sum + a[0] * b[1] - b[0] * a[1];
      }, 0) < 0
    )
      outline.reverse();
    const vertices = [-depth / 2, depth / 2].flatMap((z) =>
      outline.map(([x, y]) => [x, y, z]),
    );
    const n = outline.length,
      base = outline.map((_, i) => i);
    return mesh(
      vertices,
      [
        [...base].reverse(),
        base.map((i) => i + n),
        ...base.map((i) => [i, (i + 1) % n, ((i + 1) % n) + n, i + n]),
      ],
      material,
    );
  }
  fail(`Unknown primitive: ${kind}`);
}

export function extrudeFace(mesh, id, distance) {
  number(distance, -1000, 1000);
  if (Math.abs(distance) < 0.0001) fail("Extrusion distance is too small");
  const face = mesh.faces.find((face) => face.id === id);
  if (!face) fail(`Unknown face: ${id}`);
  const direction = mul(normal(mesh.vertices, face.vertices), distance),
    old = [...face.vertices];
  const top = old.map((i) => {
    mesh.vertices.push(add(mesh.vertices[i], direction));
    return mesh.vertices.length - 1;
  });
  const used = new Set(mesh.faces.map((f) => f.id));
  let next = 0;
  old.forEach((v, i) => {
    while (used.has(`f${next}`)) next++;
    const sideId = `f${next++}`;
    used.add(sideId);
    const j = (i + 1) % old.length;
    mesh.faces.push({
      id: sideId,
      vertices: [v, old[j], top[j], top[i]],
      material: face.material,
    });
  });
  face.vertices = top; // The cap keeps its semantic face ID through extrusion.
}

const unit = (v) => {
  const length = Math.hypot(...v);
  if (length < 1e-10) fail("Zero length edge");
  return mul(v, 1 / length);
};
function faceIds(mesh) {
  const used = new Set(mesh.faces.map((f) => f.id));
  let i = 0;
  return () => {
    while (used.has(`f${i}`)) i++;
    const id = `f${i++}`;
    used.add(id);
    return id;
  };
}
export function extrudeRegion(mesh, ids, distance) {
  number(distance, -1000, 1000);
  if (Math.abs(distance) < 1e-5) fail("Extrusion distance is too small");
  const faces = ids.map((id) => mesh.faces.find((f) => f.id === id));
  if (!faces.length || faces.some((f) => !f)) fail("Unknown selected face");
  const n = normal(mesh.vertices, faces[0].vertices);
  if (faces.some((f) => dot(n, normal(mesh.vertices, f.vertices)) < 0.99999))
    fail(
      "Region extrusion needs coplanar faces; extrude separate regions individually",
    );
  const edges = new Map(),
    selected = new Set(faces.flatMap((f) => f.vertices)),
    cap = new Map(),
    next = faceIds(mesh);
  for (const f of faces)
    f.vertices.forEach((a, i) => {
      const b = f.vertices[(i + 1) % f.vertices.length],
        key = [a, b].sort((a, b) => a - b).join(":");
      const edge = edges.get(key) ?? { a, b, count: 0, material: f.material };
      edge.count++;
      edges.set(key, edge);
    });
  if ([...edges.values()].some((e) => e.count > 2))
    fail("Nonmanifold selected region");
  for (const i of selected) {
    cap.set(i, mesh.vertices.length);
    mesh.vertices.push(add(mesh.vertices[i], mul(n, distance)));
  }
  for (const edge of edges.values())
    if (edge.count === 1)
      mesh.faces.push({
        id: next(),
        vertices: [edge.a, edge.b, cap.get(edge.b), cap.get(edge.a)],
        material: edge.material,
      });
  faces.forEach((f) => {
    f.vertices = f.vertices.map((i) => cap.get(i));
  });
}
function insetPoints(vertices, face, distance) {
  number(distance, 0.00001, 1000);
  const n = normal(vertices, face);
  const points = face.map((index, i) => {
    const p = vertices[index],
      prev = vertices[face[(i + face.length - 1) % face.length]],
      next = vertices[face[(i + 1) % face.length]];
    const incoming = unit(sub(p, prev)),
      outgoing = unit(sub(next, p));
    if (dot(cross(incoming, outgoing), n) <= 1e-8)
      fail("Inset/bevel needs strictly convex faces");
    const a = cross(n, incoming),
      b = cross(n, outgoing);
    return add(p, mul(add(a, b), distance / (1 + dot(a, b))));
  });
  for (let i = 0; i < face.length; i++) {
    const edge = sub(vertices[face[(i + 1) % face.length]], vertices[face[i]]);
    if (dot(sub(points[(i + 1) % face.length], points[i]), edge) <= 1e-10)
      fail("Inset/bevel is too wide for this face");
  }
  return points;
}
export function insetFace(mesh, id, distance) {
  const face = mesh.faces.find((f) => f.id === id);
  if (!face) fail("Unknown face");
  const old = [...face.vertices],
    next = faceIds(mesh),
    points = insetPoints(mesh.vertices, old, distance);
  const cap = points.map((v) => {
    mesh.vertices.push(v);
    return mesh.vertices.length - 1;
  });
  old.forEach((a, i) => {
    const j = (i + 1) % old.length;
    mesh.faces.push({
      id: next(),
      vertices: [a, old[j], cap[j], cap[i]],
      material: face.material,
    });
  });
  face.vertices = cap;
}
// A one-segment bevel for closed convex solids. Unsupported topology is rejected
// atomically, rather than producing holes or silently changing arbitrary edges.
export function bevelMesh(mesh, distance) {
  const vertices = [],
    faces = [],
    edges = new Map(),
    corners = new Map(),
    next = faceIds(mesh);
  for (const face of mesh.faces) {
    const n = normal(mesh.vertices, face.vertices),
      origin = mesh.vertices[face.vertices[0]];
    if (mesh.vertices.some((v) => dot(sub(v, origin), n) > 1e-6))
      fail("Bevel needs a closed convex solid");
    const points = insetPoints(mesh.vertices, face.vertices, distance);
    const ids = points.map((v) => {
      vertices.push(v);
      return vertices.length - 1;
    });
    faces.push({ ...face, vertices: ids });
    face.vertices.forEach((a, i) => {
      const b = face.vertices[(i + 1) % face.vertices.length],
        key = [a, b].sort((a, b) => a - b).join(":");
      const list = edges.get(key) ?? [];
      list.push({
        a,
        b,
        ia: ids[i],
        ib: ids[(i + 1) % ids.length],
        material: face.material,
      });
      edges.set(key, list);
      const corner = corners.get(a) ?? [];
      corner.push(ids[i]);
      corners.set(a, corner);
    });
  }
  for (const pair of edges.values()) {
    if (pair.length !== 2 || pair[0].a !== pair[1].b)
      fail("Bevel needs a closed consistently oriented solid");
    const [a, b] = pair;
    faces.push({
      id: next(),
      vertices: [a.ib, a.ia, b.ib, b.ia],
      material: a.material,
    });
  }
  for (const [original, ids] of corners) {
    if (ids.length < 3) fail("Bevel needs manifold corners");
    const center = mul(
      ids.reduce((s, i) => add(s, vertices[i]), [0, 0, 0]),
      1 / ids.length,
    );
    const n = unit(sub(mesh.vertices[original], center)),
      x = unit(sub(vertices[ids[0]], center)),
      y = cross(n, x);
    ids.sort(
      (a, b) =>
        Math.atan2(
          dot(sub(vertices[a], center), y),
          dot(sub(vertices[a], center), x),
        ) -
        Math.atan2(
          dot(sub(vertices[b], center), y),
          dot(sub(vertices[b], center), x),
        ),
    );
    faces.push({
      id: next(),
      vertices: ids,
      material: mesh.faces.find((f) => f.vertices.includes(original)).material,
    });
  }
  mesh.vertices = vertices;
  mesh.faces = faces;
}

export function transformVector(v, rotation, scale) {
  // Three.js Euler XYZ: Rz is applied first, then Ry, then Rx.
  let [x, y, z] = v.map((n, i) => n * scale[i]);
  const [rx, ry, rz] = rotation.map((n) => (n * Math.PI) / 180);
  [x, y] = [
    x * Math.cos(rz) - y * Math.sin(rz),
    x * Math.sin(rz) + y * Math.cos(rz),
  ];
  [x, z] = [
    x * Math.cos(ry) + z * Math.sin(ry),
    -x * Math.sin(ry) + z * Math.cos(ry),
  ];
  [y, z] = [
    y * Math.cos(rx) - z * Math.sin(rx),
    y * Math.sin(rx) + z * Math.cos(rx),
  ];
  return [x, y, z];
}
