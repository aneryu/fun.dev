// Editable polygon meshes. IDs belong to faces, not generated render triangles.
import {
  extrudeShape,
  revolveShape,
  sweepShape,
  loftShape,
  geodesicSphere,
  revolveContours,
  expandOutline,
  roundOutline,
  segmentCount,
  autoSegments,
} from "./generators.js";
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

// Normals per face corner for smooth shading: each corner averages the normals of the faces
// meeting at its point (weighted by their angle there) that lie within `crease` degrees of
// its own face; edges sharper than the crease stay hard. Points are matched by position,
// so seams of unwelded vertices smooth too.
export function cornerNormals(mesh, crease) {
  const limit = Math.cos((crease * Math.PI) / 180) - 1e-9,
    normals = mesh.faces.map((f) => normal(mesh.vertices, f.vertices)),
    key = (v) => v.map((x) => Math.round(x * 1e6)).join(","),
    corners = new Map();
  mesh.faces.forEach((face, f) => {
    const n = face.vertices.length;
    face.vertices.forEach((index, k) => {
      const p = mesh.vertices[index],
        u = sub(mesh.vertices[face.vertices[(k + n - 1) % n]], p),
        w = sub(mesh.vertices[face.vertices[(k + 1) % n]], p),
        lengths = Math.hypot(...u) * Math.hypot(...w),
        angle = lengths > 0 ? Math.acos(Math.max(-1, Math.min(1, dot(u, w) / lengths))) : 0,
        id = key(p);
      if (!corners.has(id)) corners.set(id, []);
      corners.get(id).push([f, angle]);
    });
  });
  return mesh.faces.map((face, f) =>
    face.vertices.map((index) => {
      let sum = [0, 0, 0];
      for (const [g, angle] of corners.get(key(mesh.vertices[index])))
        if (dot(normals[g], normals[f]) >= limit) sum = add(sum, mul(normals[g], angle));
      const length = Math.hypot(...sum);
      return length > 1e-12 ? mul(sum, 1 / length) : normals[f];
    }),
  );
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
  // An ear on a nearly straight corner (float noise along an edge) would be a sliver that
  // overlaps its neighbours: such corners count as straight, relative to edge lengths.
  const straight = (a, b, c) =>
    sign * turn(a, b, c) <=
    Math.max(1e-12, 1e-3 * Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]));
  // Clip the best-shaped ear each time (largest area against its longest edge), so corners
  // along a straight crease are cut last and never become slivers that a neighbour shares.
  const quality = (a, b, c) =>
    Math.abs(turn(a, b, c)) /
    Math.max(
      (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2,
      (c[0] - b[0]) ** 2 + (c[1] - b[1]) ** 2,
      (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2,
    );
  while (left.length > 3) {
    let best = -1,
      bestQuality = -1;
    for (let i = 0; i < left.length; i++) {
      const a = left[(i + left.length - 1) % left.length],
        b = left[i],
        c = left[(i + 1) % left.length];
      if (straight(points[a], points[b], points[c])) continue;
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
      const q = quality(points[a], points[b], points[c]);
      if (q > bestQuality) {
        bestQuality = q;
        best = i;
      }
    }
    if (best < 0)
      fail("Cannot triangulate face; check overlapping or collinear vertices");
    const a = left[(best + left.length - 1) % left.length],
      c = left[(best + 1) % left.length];
    triangles.push([face[a], face[left[best]], face[c]]);
    left.splice(best, 1);
  }
  if (sign * turn(...left.map((i) => points[i])) <= 1e-12)
    fail("Degenerate face triangle");
  triangles.push(left.map((i) => face[i]));
  // The last ear can still be a sliver along a straight crease: flip its longest edge with
  // the neighbouring triangle when both new triangles keep their orientation.
  const at = new Map(face.map((id, i) => [id, points[i]]));
  for (let t = 0; t < triangles.length; t++) {
    const tri = triangles[t].map((id) => at.get(id));
    if (!tri.some((_, k) => straight(tri[(k + 2) % 3], tri[k], tri[(k + 1) % 3])))
      continue;
    const lengths = [0, 1, 2].map((k) => Math.hypot(tri[(k + 1) % 3][0] - tri[k][0], tri[(k + 1) % 3][1] - tri[k][1]));
    const k = lengths.indexOf(Math.max(...lengths)),
      p = triangles[t][k],
      q = triangles[t][(k + 1) % 3],
      r = triangles[t][(k + 2) % 3];
    const u = triangles.findIndex(
      (other, j) => j !== t && other.some((v, m) => v === q && other[(m + 1) % 3] === p),
    );
    if (u < 0) continue;
    const other = triangles[u],
      m = other.indexOf(q),
      s2 = other[(m + 2) % 3];
    const flipped = [
      [r, p, s2],
      [r, s2, q],
    ];
    if (
      flipped.every(
        (f) => sign * turn(...f.map((id) => at.get(id))) > 1e-12 && !straight(...f.map((id) => at.get(id))),
      )
    ) {
      triangles[t] = flipped[0];
      triangles[u] = flipped[1];
    }
  }
  return triangles;
}

const mesh = (vertices, faces, material) => ({
  vertices,
  faces: faces.map((vertices, i) => ({ id: `f${i}`, vertices, material })),
});
// Plain outlines ([x, y] points only) keep the original prism; anything else (arcs,
// curves, shapes, corner radii) goes through generators.js.
const plainOutline = (points) =>
  points === undefined ||
  (Array.isArray(points) &&
    points.every((p) => Array.isArray(p) && p.length === 2));

// A profile (bottom to top, x = distance from the Y axis) turned about +Y in `count`
// steps: quads between rows, fans at points on the axis, flat caps at open ends. A closed
// profile (a ring section, counter-clockwise) joins its last row to its first instead.
function latheRows(profile, count, material, { closed = false } = {}) {
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
  const spans = closed ? rows.length : rows.length - 1;
  for (let j = 0; j < spans; j++)
    for (let i = 0; i < count; i++) {
      const a = rows[j],
        b = rows[(j + 1) % rows.length],
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
  if (!closed) {
    if (rows[0].length > 1) faces.push([...rows[0]]);
    if (rows.at(-1).length > 1) faces.push([...rows.at(-1)].reverse());
  }
  return mesh(vertices, faces, material);
}

const signedArea = (pts) =>
  pts.reduce((sum, a, i) => {
    const b = pts[(i + 1) % pts.length];
    return sum + a[0] * b[1] - b[0] * a[1];
  }, 0) / 2;

// A closed (r, y) section, counter-clockwise, turned fully (rows) or partly (kernel, capped).
function turnSection(section, count, angle, material) {
  if (signedArea(section) < 0) section = [...section].reverse();
  if (angle >= 360) {
    // Sections touching the axis open there: start and end on it, bottom to top.
    const onAxis = section.map((p, i) => (p[0] === 0 ? i : -1)).filter((i) => i >= 0);
    if (!onAxis.length) return latheRows(section, count, material, { closed: true });
    const first = section.findIndex(
      (p, i) => p[0] === 0 && section[(i + 1) % section.length][0] !== 0,
    );
    const open = [...section.slice(first), ...section.slice(0, first)];
    const last = open.findIndex((p, i) => i > 0 && p[0] === 0);
    return latheRows(open.slice(0, last + 1), count, material);
  }
  return revolveContours([section], count, angle, material, "angle");
}

function wholeNumber(value, min, max, path) {
  const result = number(value, min, max, path);
  if (!Number.isInteger(result)) fail(`${path} must be a whole number`, path);
  return result;
}

// Round primitives (docs/workshop-agents.md "Shapes"). Options that existed before keep
// their original meshes (and face IDs); new ones (radiusTop, angle, innerRadius, round,
// latitude, axis, "auto" segments, torus, capsule) build the same kind of rows.
function roundShape(kind, options, material) {
  if (kind === "lathe") {
    const { points, radii } = expandOutline(options.profile, {
      path: "profile",
      min: 2,
      max: 64,
      closed: false,
    });
    let profile = roundOutline(
      points,
      radii.map((r) => r ?? 0),
      wholeNumber(options.roundSegments ?? 3, 1, 16, "roundSegments"),
      { open: true },
    );
    profile = profile.map((p, i) => [
      number(p[0], 0, 1000, `profile.${i}`),
      number(p[1], -1000, 1000, `profile.${i}`),
    ]);
    if (profile.length > 1024) fail("The lathe profile exceeds 1024 points", "profile");
    const count = segmentCount(options.segments, Math.max(...profile.map((p) => p[0])), 8);
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
    return latheRows(profile, count, material);
  }
  if (kind === "sphere") {
    // geodesic: an icosphere of that many splits (generators.js); the lathe sphere otherwise.
    if (options.geodesic !== undefined) return geodesicSphere(options, material);
    const radius = number(options.radius ?? 0.5, 0.001, 1000, "radius"),
      count = segmentCount(options.segments, radius, 8),
      rings =
        options.rings === "auto"
          ? Math.max(4, autoSegments(radius) / 2)
          : segments(options.rings, 6),
      angle = number(options.angle ?? 360, 1, 360, "angle"),
      latitude = options.latitude ?? [-90, 90];
    if (
      !Array.isArray(latitude) ||
      latitude.length !== 2 ||
      latitude.some((v) => !Number.isFinite(v) || v < -90 || v > 90) ||
      latitude[0] >= latitude[1]
    )
      fail("latitude is [from, to] in degrees, −90 ≤ from < to ≤ 90", "latitude");
    const [from, to] = latitude;
    if (angle === 360 && from === -90 && to === 90)
      return latheRows(
        Array.from({ length: rings + 1 }, (_, i) => [
          i === 0 || i === rings ? 0 : radius * Math.sin((Math.PI * i) / rings),
          -radius * Math.cos((Math.PI * i) / rings),
        ]),
        count,
        material,
      );
    // Part of a sphere: flat where it is cut, as a dome, bowl or wedge.
    const steps = Math.max(1, Math.round((rings * (to - from)) / 180)),
      at = (deg) => (deg * Math.PI) / 180;
    const meridian = Array.from({ length: steps + 1 }, (_, k) => {
      const lat = from + ((to - from) * k) / steps;
      return [Math.abs(lat) === 90 ? 0 : radius * Math.cos(at(lat)), radius * Math.sin(at(lat))];
    });
    const profile = [
      ...(from > -90 ? [[0, radius * Math.sin(at(from))]] : []),
      ...meridian,
      ...(to < 90 ? [[0, radius * Math.sin(at(to))]] : []),
    ];
    return angle === 360
      ? latheRows(profile, count, material)
      : turnSection(profile, count, angle, material);
  }
  if (kind === "cylinder" || kind === "cone") {
    const radius = number(options.radius ?? 0.5, 0.001, 1000, "radius"),
      top =
        options.radiusTop === undefined
          ? kind === "cone"
            ? 0
            : radius
          : number(options.radiusTop, 0, 1000, "radiusTop"),
      h = number(options.height ?? 1, 0.001, 1000, "height") / 2,
      count = segmentCount(options.segments, Math.max(radius, top), 8),
      angle = number(options.angle ?? 360, 1, 360, "angle"),
      inner =
        options.innerRadius === undefined
          ? 0
          : number(options.innerRadius, 0, 1000, "innerRadius"),
      round = number(options.round ?? 0, 0, 1000, "round"),
      roundSegments = wholeNumber(options.roundSegments ?? 3, 1, 16, "roundSegments");
    // rows: rings along the height (the rings a bend or a taper works across).
    const rows = options.rows === undefined ? 1 : wholeNumber(options.rows, 1, 64, "rows");
    if (angle === 360 && !inner && !round)
      return latheRows(
        Array.from({ length: rows + 1 }, (_, k) => [radius + ((top - radius) * k) / rows, -h + (2 * h * k) / rows]),
        count,
        material,
      );
    if (rows > 1) fail("rows applies to plain cylinders and cones (no innerRadius, round or angle)", "rows");
    let section, radii;
    if (inner) {
      // The bore runs parallel to the outside: the wall keeps its thickness.
      const innerTop = inner + (top - radius);
      if (inner >= radius || innerTop <= 0 || innerTop >= top)
        fail("innerRadius must leave a wall at both ends (radiusTop − radius + innerRadius > 0)", "innerRadius");
      section = [[inner, -h], [radius, -h], [top, h], [innerTop, h]];
      radii = [round, round, round, round];
    } else if (top > 0) {
      section = [[0, -h], [radius, -h], [top, h], [0, h]];
      radii = [0, round, round, 0];
    } else {
      section = [[0, -h], [radius, -h], [0, h]];
      radii = [0, round, 0];
    }
    return turnSection(roundOutline(section, radii, roundSegments), count, angle, material);
  }
  if (kind === "capsule") {
    const radius = number(options.radius ?? 0.25, 0.001, 1000, "radius"),
      height = number(options.height ?? 1, 0.002, 1000, "height");
    if (height < 2 * radius - 1e-9)
      fail("A capsule is at least as tall as it is wide (height ≥ 2 × radius)", "height");
    const count = segmentCount(options.segments ?? "auto", radius, 16),
      caps =
        options.rings === undefined || options.rings === "auto"
          ? Math.max(2, autoSegments(radius) / 4)
          : wholeNumber(options.rings, 1, 32, "rings"),
      straight = height / 2 - radius,
      profile = [[0, -height / 2]];
    for (let k = 1; k <= caps; k++) {
      const a = -Math.PI / 2 + ((Math.PI / 2) * k) / caps;
      profile.push([radius * Math.cos(a), -straight + radius * Math.sin(a)]);
    }
    for (let k = straight > 1e-9 ? 0 : 1; k < caps; k++) {
      const a = ((Math.PI / 2) * k) / caps;
      profile.push([radius * Math.cos(a), straight + radius * Math.sin(a)]);
    }
    profile.push([0, height / 2]);
    return latheRows(profile, count, material);
  }
  // Torus: a tube of radius `tube` around a ring of radius `radius` in the XZ plane.
  // Partial rings start on +X and turn like a positive rotation about +Y, with flat ends.
  const radius = number(options.radius ?? 0.4, 0.001, 1000, "radius"),
    tube = number(options.tube ?? 0.1, 0.0005, 1000, "tube");
  if (tube >= radius) fail("A torus tube must be thinner than its ring (tube < radius)", "tube");
  const angle = number(options.angle ?? 360, 1, 360, "angle"),
    around = segmentCount(options.segments ?? "auto", radius + tube, 24),
    sides = segmentCount(options.tubeSegments ?? "auto", tube, 12, "tubeSegments"),
    partial = angle < 360,
    steps = partial ? Math.max(1, Math.round((around * angle) / 360)) : around;
  const vertices = [],
    faces = [];
  for (let i = 0; i < (partial ? steps + 1 : steps); i++) {
    const phi = ((angle * Math.PI) / 180) * (i / steps),
      d = [Math.cos(phi), 0, -Math.sin(phi)];
    for (let j = 0; j < sides; j++) {
      const theta = (2 * Math.PI * j) / sides,
        c = Math.cos(theta),
        sn = Math.sin(theta);
      vertices.push([d[0] * (radius + tube * c), tube * sn, d[2] * (radius + tube * c)]);
    }
  }
  const v = (i, j) => (i % (partial ? steps + 1 : steps)) * sides + (j % sides);
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < sides; j++)
      faces.push([v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)]);
  if (partial) {
    faces.push(Array.from({ length: sides }, (_, j) => v(0, j)));
    faces.push(Array.from({ length: sides }, (_, j) => v(steps, sides - 1 - j)));
  }
  return mesh(vertices, faces, material);
}

// axis: "y" (default) keeps a round shape upright; "x" and "z" lay it along those axes.
function orient(result, axis = "y") {
  if (axis === "y") return result;
  if (axis !== "x" && axis !== "z") fail('axis is "x", "y" or "z"', "axis");
  result.vertices = result.vertices.map(([x, y, z]) =>
    axis === "x" ? [y, -x, z] : [x, -z, y],
  );
  return result;
}

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
  if (["sphere", "cylinder", "cone", "lathe", "torus", "capsule"].includes(kind))
    return orient(roundShape(kind, options, material), options.axis);
  // Holes, rounded corners, revolved sections and sweeps: generators.js.
  if (
    kind === "extrude" &&
    (options.holes?.length || options.round || !plainOutline(options.points))
  )
    return extrudeShape(options, material);
  if (kind === "revolve") return orient(revolveShape(options, material), options.axis);
  if (kind === "sweep") return sweepShape(options, material);
  if (kind === "loft") return loftShape(options, material);
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
