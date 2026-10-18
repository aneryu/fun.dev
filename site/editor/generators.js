// Shape generators beyond the basic primitives: extrusions with holes and rounded corners,
// revolved sections and profiles swept along a path. mesh.js primitive() dispatches here,
// so recipes, assemblies, boolean shapes and saved projects all rebuild them.
import { fail, number, add, sub, mul, dot, cross } from "./mesh.js";
import { kernel } from "./kernel.js";
import { polygonize } from "./solid.js";

function count(value, min, max, path) {
  const result = number(value, min, max, path);
  if (!Number.isInteger(result)) fail(`${path} must be an integer`, path);
  return result;
}
function points2(value, min, max, path) {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail(`${path} needs ${min}–${max} [x, y] points`, path);
  return value.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 2)
      fail(`Invalid ${path} point`, `${path}.${i}`);
    return [
      number(p[0], -1000, 1000, `${path}.${i}`),
      number(p[1], -1000, 1000, `${path}.${i}`),
    ];
  });
}
function points3(value, min, max, path) {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail(`${path} needs ${min}–${max} [x, y, z] points`, path);
  return value.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 3)
      fail(`Invalid ${path} point`, `${path}.${i}`);
    return p.map((v) => number(v, -1000, 1000, `${path}.${i}`));
  });
}
const area = (pts) =>
  pts.reduce((sum, a, i) => {
    const b = pts[(i + 1) % pts.length];
    return sum + a[0] * b[1] - b[0] * a[1];
  }, 0) / 2;
const flag = (value, fallback, path) => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(`${path} must be true or false`, path);
  return value;
};

// Segments for a full circle of this radius: the chord stays within 2 mm of the true
// circle, in steps of four (so quarters meet the axes), 8 to 64.
export function autoSegments(radius) {
  const tolerance = 0.002;
  if (!(radius > tolerance / 2)) return 8;
  const n = Math.PI / Math.acos(Math.max(-1, 1 - tolerance / radius));
  return Math.min(64, Math.max(8, Math.ceil(n / 4) * 4));
}
// A segment count: an integer, or "auto" for the radius at hand.
export function segmentCount(value, radius, fallback, path = "segments", min = 3) {
  if (value === "auto") return Math.max(min, autoSegments(radius));
  return count(value ?? fallback, min, 64, path);
}
// Arc samples for `angle` radians of a circle of this radius.
const arcSteps = (radius, angle, value, path) =>
  value === undefined || value === "auto"
    ? Math.max(1, Math.ceil((Math.abs(angle) / (2 * Math.PI)) * autoSegments(radius)))
    : count(value, 1, 64, path);

const pair = (value, path) => {
  if (!Array.isArray(value) || value.length !== 2)
    fail("Expected [x, y]", path);
  return value.map((v) => number(v, -1000, 1000, path));
};
const triple = (value, path) => {
  if (!Array.isArray(value) || value.length !== 3)
    fail("Expected [x, y, z]", path);
  return value.map((v) => number(v, -1000, 1000, path));
};

// Circle through three points (2D or 3D): centre, radius and the plane's unit normal.
function circleThrough(a, b, c, path) {
  const [p, q, r] = [a, b, c].map((v) => (v.length === 2 ? [...v, 0] : v));
  const ab = sub(q, p),
    ac = sub(r, p),
    n = cross(ab, ac),
    nn = dot(n, n);
  if (nn < 1e-18) fail("An arc's three points lie on a line", path);
  const centre = add(
    p,
    mul(
      add(mul(cross(n, ab), dot(ac, ac)), mul(cross(ac, n), dot(ab, ab))),
      1 / (2 * nn),
    ),
  );
  return { centre, radius: Math.hypot(...sub(p, centre)), normal: mul(n, 1 / Math.sqrt(nn)) };
}
// Rotates v about a unit axis through `centre` (Rodrigues).
function turn(v, centre, axis, angle) {
  return add(centre, rotate(sub(v, centre), axis, angle));
}
function bezierPoints(from, controls, to, steps) {
  const points = [from, ...controls, to],
    out = [];
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    let level = points;
    while (level.length > 1)
      level = level.slice(1).map((p, i) => add(mul(level[i], 1 - t), mul(p, t)));
    out.push(level[0]);
  }
  return out;
}

// Outlines and paths (docs/workshop-agents.md "Outlines and paths"). A list of points
// ([x, y], or [x, y, r] with its own corner radius) and segments that continue from the
// last point: { arc: { center, angle } } turns about a centre (degrees, + counter-clockwise;
// in 3D about `axis`, with `rise` along it for a helix), { arc: { through, to } } passes
// three points, { bezier: { controls, to } } is a quadratic or cubic curve. A whole 2D
// outline may be one shape instead: { circle }, { ellipse }, { rect }, { polygon }.
// Returns { points, radii } with radii per point (generated curve points have none).
export function expandOutline(value, { path, dims = 2, min = 3, max = 64, closed = true } = {}) {
  if (value && !Array.isArray(value) && typeof value === "object") {
    if (dims !== 2) fail(`${path} takes points and segments`, path);
    return shapeOutline(value, path);
  }
  if (!Array.isArray(value) || value.length < (min === 2 ? 2 : 1) || value.length > max)
    fail(`${path} needs up to ${max} points and segments`, path);
  const points = [],
    radii = [];
  const point = dims === 2 ? pair : triple;
  value.forEach((item, i) => {
    const at = `${path}.${i}`;
    if (Array.isArray(item)) {
      if (item.length === dims + 1) {
        points.push(point(item.slice(0, dims), at));
        radii.push(number(item[dims], 0, 1000, at));
      } else {
        points.push(point(item, at));
        radii.push(undefined);
      }
      return;
    }
    if (!points.length) fail(`${path} starts with a point`, at);
    const last = dims === 2 ? [...points.at(-1), 0] : points.at(-1);
    const keep = (v) => (dims === 2 ? [v[0], v[1]] : v);
    let made = [];
    if (item?.arc && item.arc.center !== undefined) {
      const centre = dims === 2 ? [...pair(item.arc.center, `${at}.arc.center`), 0] : triple(item.arc.center, `${at}.arc.center`);
      const axisValue = dims === 2 ? [0, 0, 1] : triple(item.arc.axis ?? [0, 1, 0], `${at}.arc.axis`);
      const axis = mul(axisValue, 1 / (Math.hypot(...axisValue) || fail("An arc axis needs a length", `${at}.arc.axis`)));
      const angle = (number(item.arc.angle, -3600, 3600, `${at}.arc.angle`) * Math.PI) / 180;
      const rise = dims === 3 ? number(item.arc.rise ?? 0, -1000, 1000, `${at}.arc.rise`) : 0;
      const offset = sub(last, centre),
        radius = Math.hypot(...sub(offset, mul(axis, dot(offset, axis))));
      if (radius < 1e-9) fail("An arc starts at its own centre", at);
      const steps = arcSteps(radius, angle, item.arc.segments, `${at}.arc.segments`);
      for (let k = 1; k <= steps; k++)
        made.push(add(turn(last, centre, axis, (angle * k) / steps), mul(axis, (rise * k) / steps)));
    } else if (item?.arc && item.arc.through !== undefined) {
      const through = dims === 2 ? [...pair(item.arc.through, `${at}.arc.through`), 0] : triple(item.arc.through, `${at}.arc.through`),
        to = dims === 2 ? [...pair(item.arc.to, `${at}.arc.to`), 0] : triple(item.arc.to, `${at}.arc.to`);
      const { centre, radius, normal } = circleThrough(last, through, to, at);
      // The arc runs from the last point past `through` to `to`, about the plane's normal.
      const angleOf = (v) => {
        const a = sub(last, centre),
          b = sub(v, centre);
        let t = Math.atan2(dot(cross(a, b), normal), dot(a, b));
        if (t < 0) t += 2 * Math.PI;
        return t;
      };
      const total = angleOf(to);
      const steps = arcSteps(radius, total, item.arc.segments, `${at}.arc.segments`);
      for (let k = 1; k < steps; k++) made.push(turn(last, centre, normal, (total * k) / steps));
      made.push(to);
    } else if (item?.bezier) {
      const controls = item.bezier.controls;
      if (!Array.isArray(controls) || controls.length < 1 || controls.length > 2)
        fail("A bezier has one or two control points", `${at}.bezier.controls`);
      const c = controls.map((v, k) => (dims === 2 ? [...pair(v, `${at}.bezier.controls.${k}`), 0] : triple(v, `${at}.bezier.controls.${k}`)));
      const to = dims === 2 ? [...pair(item.bezier.to, `${at}.bezier.to`), 0] : triple(item.bezier.to, `${at}.bezier.to`);
      const steps = item.bezier.segments === undefined || item.bezier.segments === "auto" ? 12 : count(item.bezier.segments, 1, 64, `${at}.bezier.segments`);
      made = bezierPoints(last, c, to, steps);
    } else fail("Expected a point, { arc } or { bezier }", at);
    for (const v of made) {
      points.push(keep(v));
      radii.push(0);
    }
  });
  // Drop repeats, and the closing point of a closed outline.
  const same = (a, b) => Math.hypot(...sub(a, b)) < 1e-9;
  const outP = [],
    outR = [];
  points.forEach((p, i) => {
    if (outP.length && same(outP.at(-1), p)) {
      if (radii[i] !== undefined && radii[i] !== 0) outR[outR.length - 1] = radii[i];
      return;
    }
    outP.push(p);
    outR.push(radii[i]);
  });
  if (closed && outP.length > 1 && same(outP[0], outP.at(-1))) {
    outP.pop();
    outR.pop();
  }
  if (outP.length < min) fail(`${path} needs at least ${min} distinct points`, path);
  if (outP.length > 1024) fail(`${path} exceeds 1024 points once curves are sampled`, path);
  return { points: outP, radii: outR };
}

// A whole outline as one shape, counter-clockwise.
function shapeOutline(value, path) {
  const centreOf = (spec) => (spec.center === undefined ? [0, 0] : pair(spec.center, `${path}.center`));
  if (value.circle !== undefined) {
    const spec = typeof value.circle === "number" ? { radius: value.circle } : value.circle;
    const r = number(spec.radius, 0.0001, 1000, `${path}.circle.radius`),
      c = centreOf(spec),
      n = segmentCount(spec.segments ?? "auto", r, 16, `${path}.circle.segments`);
    const points = Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)]);
    return { points, radii: points.map(() => 0) };
  }
  if (value.ellipse !== undefined) {
    const spec = Array.isArray(value.ellipse) ? { radii: value.ellipse } : value.ellipse;
    const [rx, ry] = pair(spec.radii, `${path}.ellipse.radii`).map((v) => number(v, 0.0001, 1000, `${path}.ellipse.radii`)),
      c = centreOf(spec),
      n = segmentCount(spec.segments ?? "auto", Math.max(rx, ry), 16, `${path}.ellipse.segments`);
    const points = Array.from({ length: n }, (_, i) => [c[0] + rx * Math.cos((2 * Math.PI * i) / n), c[1] + ry * Math.sin((2 * Math.PI * i) / n)]);
    return { points, radii: points.map(() => 0) };
  }
  if (value.rect !== undefined) {
    const spec = Array.isArray(value.rect) ? { size: value.rect } : value.rect;
    const [w, h] = pair(spec.size, `${path}.rect.size`).map((v) => number(v, 0.0001, 1000, `${path}.rect.size`) / 2),
      c = centreOf(spec),
      r = number(spec.round ?? 0, 0, 1000, `${path}.rect.round`);
    const points = [[c[0] - w, c[1] - h], [c[0] + w, c[1] - h], [c[0] + w, c[1] + h], [c[0] - w, c[1] + h]];
    return { points, radii: points.map(() => r) };
  }
  if (value.polygon !== undefined) {
    const spec = value.polygon;
    const sides = count(spec.sides, 3, 64, `${path}.polygon.sides`),
      r = number(spec.radius, 0.0001, 1000, `${path}.polygon.radius`),
      c = centreOf(spec);
    // A corner points up (+y): triangles stand on a side, hexagons have flat sides left and right.
    const points = Array.from({ length: sides }, (_, i) => {
      const a = Math.PI / 2 + (2 * Math.PI * i) / sides;
      return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
    });
    return { points, radii: points.map(() => number(spec.round ?? 0, 0, 1000, `${path}.polygon.round`)) };
  }
  fail("Expected points, or { circle }, { ellipse }, { rect } or { polygon }", path);
}

// Fillets the corners of a closed outline: the arc is tangent to both edges and each
// corner uses at most half of its neighbouring edges, so fillets never overlap. Concave
// corners fill in, convex corners cut off. `radius` is one radius for every corner or a
// list per point (0 or undefined: keep the corner).
export function roundOutline(points, radius, segments, { open = false } = {}) {
  const radiusAt = (i) => (Array.isArray(radius) ? radius[i] ?? 0 : radius);
  if (!points.some((_, i) => radiusAt(i) > 0)) return points;
  const n = points.length,
    out = [];
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (!(radiusAt(i) > 0) || (open && (i === 0 || i === n - 1))) {
      out.push(p);
      continue;
    }
    const a = points[(i + n - 1) % n],
      b = points[(i + 1) % n],
      la = Math.hypot(a[0] - p[0], a[1] - p[1]),
      lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    if (la < 1e-9 || lb < 1e-9) fail("Repeated outline point", "points");
    const u = [(a[0] - p[0]) / la, (a[1] - p[1]) / la],
      v = [(b[0] - p[0]) / lb, (b[1] - p[1]) / lb],
      theta = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
    if (Math.PI - theta < 1e-6) {
      out.push(p); // A straight point has no corner to round.
      continue;
    }
    const half = theta / 2,
      t = Math.min(radiusAt(i) / Math.tan(half), la / 2, lb / 2),
      r = t * Math.tan(half),
      bisector = [u[0] + v[0], u[1] + v[1]],
      length = Math.hypot(...bisector),
      reach = r / Math.sin(half),
      c = [
        p[0] + (bisector[0] / length) * reach,
        p[1] + (bisector[1] / length) * reach,
      ];
    const from = Math.atan2(p[1] + u[1] * t - c[1], p[0] + u[0] * t - c[0]),
      to = Math.atan2(p[1] + v[1] * t - c[1], p[0] + v[0] * t - c[0]);
    let sweep = to - from;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    for (let k = 0; k <= segments; k++) {
      const angle = from + (sweep * k) / segments;
      out.push([c[0] + r * Math.cos(angle), c[1] + r * Math.sin(angle)]);
    }
  }
  // Fillets meeting at an edge midpoint leave a repeated point.
  return out.filter((p, i) => {
    const q = out[(i + 1) % out.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9;
  });
}

function rounding(options) {
  return {
    radius: number(options.round ?? 0, 0, 1000, "round"),
    segments: count(options.roundSegments ?? 3, 1, 16, "roundSegments"),
  };
}
// A closed contour: outline items expanded, corners rounded by their own radius or `round`.
export function contour(value, path, radius, segments) {
  const { points, radii } = expandOutline(value, { path });
  return roundOutline(
    points,
    radii.map((r) => r ?? radius),
    segments,
  );
}
function section(options, field, { minX } = {}) {
  const { radius, segments } = rounding(options);
  const outline = contour(options[field], field, radius, segments);
  const holes = options.holes ?? [];
  if (!Array.isArray(holes) || holes.length > 32)
    fail("holes needs up to 32 outlines", "holes");
  const contours = [
    outline,
    ...holes.map((h, i) => contour(h, `holes.${i}`, radius, segments)),
  ];
  if (minX !== undefined && contours.flat().some(([x]) => x < minX - 1e-9))
    fail(
      "Revolve sections lie at x ≥ 0 (x is the distance from the Y axis)",
      field,
    );
  return contours;
}

// The kernel builds a closed solid from contours; holes must sit inside the outline and
// apart from each other, which the filled area confirms.
function crossSection(contours, path) {
  const { CrossSection } = kernel();
  const shape = new CrossSection(contours, "EvenOdd");
  const expected =
    Math.abs(area(contours[0])) -
    contours.slice(1).reduce((s, c) => s + Math.abs(area(c)), 0);
  if (expected <= 1e-12 || Math.abs(shape.area() - expected) > 1e-6 * Math.max(1, expected)) {
    shape.delete();
    fail("Holes must lie inside the outline without touching each other", path);
  }
  return shape;
}

// Kernel triangles regroup into planar regions, then into editable polygons.
function solidMesh(solid, material) {
  const result = solid.getMesh(),
    positions = [];
  for (let i = 0; i < result.vertProperties.length / result.numProp; i++)
    positions.push(
      [0, 1, 2].map((k) => result.vertProperties[i * result.numProp + k]),
    );
  const merged = new Map();
  for (let i = 0; i < result.mergeFromVert.length; i++)
    merged.set(result.mergeFromVert[i], result.mergeToVert[i]);
  const triangles = [];
  for (let t = 0; t < result.triVerts.length; t += 3)
    triangles.push(
      [0, 1, 2].map((k) => merged.get(result.triVerts[t + k]) ?? result.triVerts[t + k]),
    );
  const groups = planarGroups(positions, triangles);
  return polygonize(
    positions,
    triangles,
    groups,
    triangles.map(() => material),
  );
}

// Triangles join a region across shared edges when their planes agree.
export function planarGroups(positions, triangles) {
  const normals = triangles.map(([a, b, c]) => {
    const n = cross(sub(positions[b], positions[a]), sub(positions[c], positions[a])),
      length = Math.hypot(...n);
    return length > 1e-14 ? mul(n, 1 / length) : null;
  });
  const parent = triangles.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const owner = new Map();
  triangles.forEach((t, i) =>
    t.forEach((a, k) => {
      const b = t[(k + 1) % 3],
        key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (!owner.has(key)) return owner.set(key, i);
      const j = owner.get(key),
        n = normals[i],
        m = normals[j];
      if (
        !n ||
        !m ||
        (dot(n, m) > 1 - 1e-7 &&
          Math.abs(dot(n, sub(positions[triangles[j][0]], positions[t[0]]))) < 1e-6)
      )
        parent[find(i)] = find(j);
    }),
  );
  return triangles.map((_, i) => find(i));
}

function prism(outline, depth, material) {
  const vertices = [-depth / 2, depth / 2].flatMap((z) =>
    outline.map(([x, y]) => [x, y, z]),
  );
  const n = outline.length,
    base = outline.map((_, i) => i);
  return {
    vertices,
    faces: [
      [...base].reverse(),
      base.map((i) => i + n),
      ...base.map((i) => [i, (i + 1) % n, ((i + 1) % n) + n, i + n]),
    ].map((vertices, i) => ({ id: `f${i}`, vertices, material })),
  };
}

// extrude with holes or rounded corners. A rounded outline without holes keeps the plain
// prism layout (caps f0/f1, then sides) while it fits one 64-corner cap.
export function extrudeShape(options, material) {
  const depth = number(options.depth ?? 0.5, 0.001, 1000, "depth");
  const contours = section(options, "points");
  if (area(contours[0]) < 0) contours[0].reverse();
  if (contours.length === 1 && contours[0].length <= 64)
    return prism(contours[0], depth, material);
  const shape = crossSection(contours, "holes");
  const solid = shape.extrude(depth, 0, 0, [1, 1], true);
  shape.delete();
  try {
    return solidMesh(solid, material);
  } finally {
    solid.delete();
  }
}

// A closed section (x = distance from the axis, y = height) turned around +Y. Partial
// angles start on +X, turn like a positive rotation about +Y and get end caps.
export function revolveShape(options, material) {
  const contours = section(options, "profile", { minX: 0 });
  const radius = Math.max(...contours.flat().map(([x]) => x)),
    segments = segmentCount(options.segments, radius, 12),
    angle = number(options.angle ?? 360, 1, 360, "angle");
  return revolveContours(contours, segments, angle, material, "profile");
}
// Closed (x ≥ 0, y) contours turned about +Y by the kernel; partial angles get end caps.
export function revolveContours(contours, segments, angle, material, path = "profile") {
  const shape = crossSection(contours, path);
  // segments count a full circle, as for cylinders and lathes; the kernel counts the arc.
  const arc = angle >= 360 ? segments : Math.max(3, Math.round((segments * angle) / 360));
  // The kernel revolves around its Y axis and returns that axis as Z: turn Z back to Y.
  const revolved = shape.revolve(arc, angle),
    solid = revolved.rotate([-90, 0, 0]);
  shape.delete();
  revolved.delete();
  try {
    return solidMesh(solid, material);
  } finally {
    solid.delete();
  }
}

// Centripetal Catmull–Rom through the path points (no cusps or self-loops on uneven
// spacing); open ends extend by reflection.
function catmullRom(points, closed, per) {
  const n = points.length,
    at = (i) =>
      closed
        ? points[(i + n) % n]
        : i < 0
          ? sub(mul(points[0], 2), points[1])
          : i >= n
            ? sub(mul(points[n - 1], 2), points[n - 2])
            : points[i],
    out = [];
  for (let s = 0; s < (closed ? n : n - 1); s++) {
    const p = [at(s - 1), at(s), at(s + 1), at(s + 2)],
      knot = (a, b) => Math.max(Math.hypot(...sub(b, a)) ** 0.5, 1e-9),
      t = [0];
    for (let k = 1; k < 4; k++) t.push(t[k - 1] + knot(p[k - 1], p[k]));
    const lerp = (a, b, ta, tb, x) =>
      add(mul(a, (tb - x) / (tb - ta)), mul(b, (x - ta) / (tb - ta)));
    for (let k = 0; k < per; k++) {
      const x = t[1] + ((t[2] - t[1]) * k) / per,
        a1 = lerp(p[0], p[1], t[0], t[1], x),
        a2 = lerp(p[1], p[2], t[1], t[2], x),
        a3 = lerp(p[2], p[3], t[2], t[3], x),
        b1 = lerp(a1, a2, t[0], t[2], x),
        b2 = lerp(a2, a3, t[1], t[3], x);
      out.push(lerp(b1, b2, t[1], t[2], x));
    }
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}
const unit = (v) => {
  const length = Math.hypot(...v);
  if (length < 1e-12) fail("The sweep path has repeated points", "path");
  return mul(v, 1 / length);
};
function rotate(v, axis, angle) {
  // Rodrigues' rotation of v about a unit axis.
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return add(
    add(mul(v, c), mul(cross(axis, v), s)),
    mul(axis, dot(axis, v) * (1 - c)),
  );
}

// A closed profile swept along a path. Frames are rotation-minimising (double reflection),
// so the profile never flips or twists on a 3D path; sharp polyline corners are mitred to
// keep the full thickness. Profile x runs along the frame's side, y along its up vector;
// a level path keeps up = +Y.
export function sweepShape(options, material) {
  const { radius, segments } = rounding(options);
  let profile = contour(options.profile, "profile", radius, segments);
  if (profile.length > 64)
    fail("The profile exceeds 64 points once rounded and sampled; lower roundSegments or segments", "profile");
  if (area(profile) < 0) profile = [...profile].reverse();
  const closed = flag(options.closed, false, "closed"),
    caps = flag(options.caps, true, "caps") && !closed,
    smooth = flag(options.smooth, false, "smooth"),
    per = count(options.pathSegments ?? 6, 1, 32, "pathSegments");
  let path = expandOutline(options.path, { path: "path", dims: 3, min: 2, max: 256, closed: false }).points;
  if (closed && path.length < 3) fail("A closed path needs 3 points", "path");
  if (smooth && path.length > 2) path = catmullRom(path, closed, per);
  path = path.filter(
    (p, i) =>
      i === 0 ||
      Math.hypot(...sub(p, path[i - 1])) > 1e-9,
  );
  if (closed && Math.hypot(...sub(path[0], path.at(-1))) < 1e-9) path.pop();
  if (path.length < 2) fail("The sweep path needs two distinct points", "path");
  if (path.length > 1024) fail("The sweep path exceeds 1024 samples", "path");
  const scaleEnd = Array.isArray(options.scale)
    ? options.scale
    : [options.scale ?? 1, options.scale ?? 1];
  if (scaleEnd.length !== 2) fail("scale is a number or [x, y]", "scale");
  scaleEnd.forEach((v) => number(v, 0.001, 1000, "scale"));
  const m = path.length,
    segmentsCount = closed ? m : m - 1,
    dirs = Array.from({ length: segmentsCount }, (_, i) =>
      unit(sub(path[(i + 1) % m], path[i])),
    );
  // Tangents bisect the corners; mitres stretch the profile along the bend.
  const tangents = [],
    mitres = [];
  for (let i = 0; i < m; i++) {
    const before = closed ? dirs[(i + m - 1) % m] : dirs[i - 1],
      after = closed ? dirs[i] : dirs[i] ?? dirs[i - 1];
    if (!before || (!closed && i === m - 1)) {
      tangents.push(before ?? after);
      mitres.push(null);
      continue;
    }
    const sum = add(before, after),
      length = Math.hypot(...sum);
    if (length < 1e-6) fail("The sweep path turns back on itself", "path");
    const t = mul(sum, 1 / length),
      cosHalf = dot(t, after);
    if (cosHalf < 0.25) fail("The sweep path turns more than 150° at a corner", "path");
    const bend = sub(after, before),
      bendLength = Math.hypot(...bend);
    tangents.push(t);
    mitres.push(
      bendLength > 1e-9
        ? { direction: mul(bend, 1 / bendLength), factor: 1 / cosHalf }
        : null,
    );
  }
  // Initial up: world +Y made perpendicular to the first tangent (+Z for vertical starts).
  const t0 = tangents[0],
    hint = Math.abs(t0[1]) > 0.999 ? [0, 0, -Math.sign(t0[1])] : [0, 1, 0];
  const ups = [unit(sub(hint, mul(t0, dot(hint, t0))))];
  for (let i = 0; i < (closed ? m : m - 1); i++) {
    const j = (i + 1) % m,
      v1 = sub(path[j], path[i]),
      c1 = dot(v1, v1),
      r = ups[i],
      rL = sub(r, mul(v1, (2 / c1) * dot(v1, r))),
      tL = sub(tangents[i], mul(v1, (2 / c1) * dot(v1, tangents[i]))),
      v2 = sub(tangents[j], tL),
      c2 = dot(v2, v2);
    ups.push(unit(c2 < 1e-20 ? rL : sub(rL, mul(v2, (2 / c2) * dot(v2, rL)))));
  }
  const lengths = [0];
  for (let i = 1; i < m; i++)
    lengths.push(lengths[i - 1] + Math.hypot(...sub(path[i], path[i - 1])));
  const total = lengths.at(-1) + (closed ? Math.hypot(...sub(path[0], path[m - 1])) : 0);
  if (closed) {
    // Transport around the loop leaves a twist; spread its correction along the length.
    const back = ups.pop(),
      twist = Math.atan2(dot(cross(back, ups[0]), tangents[0]), dot(back, ups[0]));
    for (let i = 1; i < m; i++)
      ups[i] = rotate(ups[i], tangents[i], (twist * lengths[i]) / total);
  }
  const vertices = [],
    n = profile.length;
  for (let i = 0; i < m; i++) {
    const t = tangents[i],
      up = ups[i],
      side = unit(cross(up, t)),
      f = closed ? 0 : lengths[i] / lengths.at(-1),
      sx = 1 + (scaleEnd[0] - 1) * f,
      sy = 1 + (scaleEnd[1] - 1) * f;
    for (const [x, y] of profile) {
      let w = add(mul(side, x * sx), mul(up, y * sy));
      const mitre = mitres[i];
      if (mitre) w = add(w, mul(mitre.direction, dot(w, mitre.direction) * (mitre.factor - 1)));
      vertices.push(add(path[i], w));
    }
  }
  const ring = (i) => profile.map((_, k) => i * n + k),
    faces = [];
  if (caps) faces.push([...ring(0)].reverse(), ring(m - 1));
  for (let i = 0; i < segmentsCount; i++) {
    const a = ring(i),
      b = ring((i + 1) % m);
    for (let k = 0; k < n; k++)
      faces.push([a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]]);
  }
  return {
    vertices,
    faces: faces.map((vertices, i) => ({ id: `f${i}`, vertices, material })),
  };
}
