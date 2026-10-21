// Shape edits (docs/model-editor.md "Deformers, displacement, smoothing and subdivision"):
// deform tapers, bends, twists, shears or stretches a mesh along an axis; displace moves
// its vertices along their normals or a direction by a constant, a noise field, a gradient
// or a formula; smooth relaxes them; subdivide refines the faces (Catmull–Clark or linear).
// All but subdivide keep the topology, so face IDs and component references stay valid.
// Positions are in the part's local metres unless the command's space is world, and every
// edit takes a falloff (proportional editing): selected vertices move fully, the others by
// their distance to the nearest selected one.
import { fail, number, vector, normal, triangulate, add, sub, mul, dot, cross } from "./mesh.js";
import { meshEdges, edgeKey } from "./topology.js";
import { boundsOf } from "./spatial.js";

export const SHAPE_EDITS = ["deform", "controlDeform", "displace", "smooth", "subdivide", "triangulate", "sculpt"];
export const DEFORM_KINDS = ["taper", "bend", "twist", "shear", "stretch"];
export const DISPLACE_MODES = ["uniform", "noise", "gradient", "formula"];
export const FALLOFF_SHAPES = [
  "smooth",
  "sphere",
  "root",
  "sharp",
  "linear",
  "constant",
  "inverseSquare",
];
// Formula variables per vertex: position, normal, position within the bounds (0–1), the
// distance from the axis line (r), the parameter along the axis range (t), the angle around
// the axis in degrees (a) and the noise field.
export const FORMULA_VARIABLES = ["x", "y", "z", "nx", "ny", "nz", "u", "v", "w", "r", "t", "a", "noise"];
// Formula functions and how many arguments each takes. Angles are degrees.
export const FORMULA_FUNCTIONS = {
  add: [2, 8],
  sub: [2, 2],
  mul: [2, 8],
  div: [2, 2],
  pow: [2, 2],
  mod: [2, 2],
  min: [2, 8],
  max: [2, 8],
  abs: [1, 1],
  sign: [1, 1],
  sqrt: [1, 1],
  floor: [1, 1],
  round: [1, 1],
  sin: [1, 1],
  cos: [1, 1],
  atan2: [2, 2],
  clamp: [3, 3],
  smoothstep: [3, 3],
  lerp: [3, 3],
};

const AXES = ["x", "y", "z"];
function axisIndex(value, path = "axis") {
  const k = AXES.indexOf(value ?? "y");
  if (k < 0) fail(`${path} is "x", "y" or "z"`, path);
  return k;
}
const lateral = (k) => [[1, 2], [0, 2], [0, 1]][k];
const unit = (v, path) => {
  const length = Math.hypot(...v);
  if (length < 1e-12) fail("Expected a direction with a length", path);
  return mul(v, 1 / length);
};
function whole(value, min, max, path) {
  const result = number(value, min, max, path);
  if (!Number.isInteger(result)) fail(`${path} must be a whole number`, path);
  return result;
}
const centroid = (points) => mul(points.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / points.length);
const keyOf = (v) => v.map((x) => Math.round(x * 1e6)).join(",");
// Vertices at one position (unwelded seams) act as one point for normals and smoothing.
function positionGroups(vertices) {
  const groups = new Map();
  vertices.forEach((v, i) => {
    const key = keyOf(v);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  return groups;
}

// ---- Falloff (proportional editing) ----
export function normalizeFalloff(value, path = "falloff") {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") value = { radius: value };
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("falloff is { radius, shape }", path);
  const radius = number(value.radius, 0.0001, 10000, `${path}.radius`),
    shape = value.shape ?? "smooth";
  if (!FALLOFF_SHAPES.includes(shape))
    fail(`falloff.shape is one of ${FALLOFF_SHAPES.join(", ")}`, `${path}.shape`);
  return { radius, shape };
}
// The weight of a vertex at x = distance / radius (0 at a selected vertex, 1 at the edge).
export function falloffWeight(shape, x) {
  const s = Math.max(0, 1 - x);
  switch (shape) {
    case "sharp":
      return s * s;
    case "root":
      return Math.sqrt(s);
    case "linear":
      return s;
    case "constant":
      return 1;
    case "sphere":
      return Math.sqrt(Math.max(0, 2 * s - s * s));
    case "inverseSquare":
      return s * (2 - s);
    default:
      return 3 * s * s - 2 * s * s * s;
  }
}
// Weights per vertex: 1 for the selected, falling off with the distance to the nearest
// selected vertex within the radius, 0 beyond; `nearest` is that vertex's index (−1 beyond).
export function falloffWeights(points, selected, falloff) {
  const n = points.length,
    weights = new Float64Array(n),
    nearest = new Int32Array(n).fill(-1),
    isSelected = new Uint8Array(n);
  for (const i of selected) {
    weights[i] = 1;
    nearest[i] = i;
    isSelected[i] = 1;
  }
  if (!falloff) return { weights, nearest };
  const { radius, shape } = falloff,
    cells = new Map(),
    cell = (p) => p.map((v) => Math.floor(v / radius));
  for (const i of selected) {
    const key = cell(points[i]).join(",");
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(i);
  }
  for (let i = 0; i < n; i++) {
    if (isSelected[i]) continue;
    const p = points[i],
      c = cell(p);
    let best = Infinity,
      who = -1;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of cells.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? []) {
            const d = Math.hypot(p[0] - points[j][0], p[1] - points[j][1], p[2] - points[j][2]);
            if (d < best) {
              best = d;
              who = j;
            }
          }
    if (who >= 0 && best < radius) {
      weights[i] = falloffWeight(shape, best / radius);
      nearest[i] = who;
    }
  }
  return { weights, nearest };
}

// ---- Normals ----
// One normal per vertex: the angle-weighted mean of its faces' normals, shared by vertices
// at the same position so seams do not split.
export function vertexNormals(mesh) {
  const sums = mesh.vertices.map(() => [0, 0, 0]);
  for (const face of mesh.faces) {
    let n;
    try {
      n = normal(mesh.vertices, face.vertices);
    } catch {
      continue;
    }
    const m = face.vertices.length;
    face.vertices.forEach((index, k) => {
      const p = mesh.vertices[index],
        u = sub(mesh.vertices[face.vertices[(k + m - 1) % m]], p),
        w = sub(mesh.vertices[face.vertices[(k + 1) % m]], p),
        lengths = Math.hypot(...u) * Math.hypot(...w),
        angle = lengths > 0 ? Math.acos(Math.max(-1, Math.min(1, dot(u, w) / lengths))) : 0;
      sums[index] = add(sums[index], mul(n, angle));
    });
  }
  const groups = positionGroups(mesh.vertices),
    merged = new Map();
  for (const indices of groups.values()) {
    const sum = indices.length > 1 ? indices.reduce((s, i) => add(s, sums[i]), [0, 0, 0]) : sums[indices[0]],
      length = Math.hypot(...sum),
      n = length > 1e-12 ? mul(sum, 1 / length) : [0, 1, 0];
    for (const i of indices) merged.set(i, n);
  }
  return mesh.vertices.map((_, i) => merged.get(i));
}

// ---- Noise ----
function lattice(ix, iy, iz, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 1103515245) + Math.imul(iz, 668265263) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const ease = (t) => t * t * (3 - 2 * t);
export function valueNoise3(x, y, z, seed = 1) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z),
    fx = ease(x - ix),
    fy = ease(y - iy),
    fz = ease(z - iz);
  const at = (dx, dy, dz) => lattice(ix + dx, iy + dy, iz + dz, seed);
  const x00 = at(0, 0, 0) * (1 - fx) + at(1, 0, 0) * fx,
    x10 = at(0, 1, 0) * (1 - fx) + at(1, 1, 0) * fx,
    x01 = at(0, 0, 1) * (1 - fx) + at(1, 0, 1) * fx,
    x11 = at(0, 1, 1) * (1 - fx) + at(1, 1, 1) * fx;
  return (x00 * (1 - fy) + x10 * fy) * (1 - fz) + (x01 * (1 - fy) + x11 * fy) * fz;
}
/** Fractal value noise in −1..1 over metres: scale is the largest feature's size. */
export function fbm3(x, y, z, { scale = 1, octaves = 3, persistence = 0.5, lacunarity = 2, seed = 1 } = {}) {
  let sum = 0,
    amplitude = 1,
    frequency = 1 / scale,
    norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += (valueNoise3(x * frequency + o * 17.17, y * frequency + o * 7.31, z * frequency - o * 31.3, seed + o * 1013) * 2 - 1) * amplitude;
    norm += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }
  return sum / norm;
}
export function seedNumber(seed, path = "seed") {
  if (seed === undefined || seed === null) return 1;
  if (typeof seed === "number") return number(seed, 0, 4294967295, path) | 0;
  if (typeof seed !== "string") fail("seed is a number or a string", path);
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return h | 0;
}
function normalizeNoise(value, seed) {
  if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value)))
    fail("noise is { scale, octaves, persistence, seed }", "noise");
  const v = value ?? {};
  return {
    scale: number(v.scale ?? 1, 0.001, 10000, "noise.scale"),
    octaves: whole(v.octaves ?? 3, 1, 8, "noise.octaves"),
    persistence: number(v.persistence ?? 0.5, 0, 1, "noise.persistence"),
    lacunarity: number(v.lacunarity ?? 2, 1, 4, "noise.lacunarity"),
    seed: seedNumber(v.seed ?? seed, v.seed !== undefined ? "noise.seed" : "seed"),
  };
}

// ---- Formulas ----
// A formula is data: a number, { $var: "x" } or { $expr: "mul", args: [...] }. Recipe
// parameters ({ $param }) are substituted before the formula runs.
export function formula(node, vars, path = "expr", depth = 0) {
  if (depth > 32) fail("Formula nesting limit exceeded", path);
  if (typeof node === "number") {
    if (!Number.isFinite(node)) fail("Formula numbers must be finite", path);
    return node;
  }
  if (node && typeof node === "object" && !Array.isArray(node)) {
    if ("$var" in node) {
      if (!Object.hasOwn(vars, node.$var))
        fail(`Unknown formula variable ${node.$var}; use ${FORMULA_VARIABLES.join(", ")}`, path);
      return vars[node.$var];
    }
    if ("$expr" in node) {
      const spec = FORMULA_FUNCTIONS[node.$expr];
      if (!spec) fail(`Unknown formula function ${node.$expr}; use ${Object.keys(FORMULA_FUNCTIONS).join(", ")}`, path);
      if (!Array.isArray(node.args) || node.args.length < spec[0] || node.args.length > spec[1])
        fail(`${node.$expr} takes ${spec[0] === spec[1] ? spec[0] : `${spec[0]}–${spec[1]}`} arguments`, path);
      const a = node.args.map((arg, i) => formula(arg, vars, `${path}.args.${i}`, depth + 1));
      const rad = Math.PI / 180;
      switch (node.$expr) {
        case "add":
          return a.reduce((s, v) => s + v, 0);
        case "sub":
          return a[0] - a[1];
        case "mul":
          return a.reduce((s, v) => s * v, 1);
        case "div":
          return a[0] / a[1];
        case "pow":
          return a[0] ** a[1];
        case "mod":
          return a[0] - a[1] * Math.floor(a[0] / a[1]);
        case "min":
          return Math.min(...a);
        case "max":
          return Math.max(...a);
        case "abs":
          return Math.abs(a[0]);
        case "sign":
          return Math.sign(a[0]);
        case "sqrt":
          return Math.sqrt(a[0]);
        case "floor":
          return Math.floor(a[0]);
        case "round":
          return Math.round(a[0]);
        case "sin":
          return Math.sin(a[0] * rad);
        case "cos":
          return Math.cos(a[0] * rad);
        case "atan2":
          return Math.atan2(a[0], a[1]) / rad;
        case "clamp":
          return Math.min(a[2], Math.max(a[1], a[0]));
        case "smoothstep": {
          const t = Math.min(1, Math.max(0, (a[2] - a[0]) / (a[1] - a[0])));
          return t * t * (3 - 2 * t);
        }
        case "lerp":
          return a[0] + (a[1] - a[0]) * a[2];
      }
    }
  }
  fail("A formula is a number, { $var } or { $expr, args }", path);
}

// ---- The axis range shared by deform and displace ----
function axialSetup(mesh, command, selected, { range = true } = {}) {
  const k = axisIndex(command.axis),
    [u, v] = lateral(k),
    bounds = boundsOf(selected.map((i) => mesh.vertices[i])),
    from = command.from === undefined ? bounds.min[k] : number(command.from, -10000, 10000, "from"),
    to = command.to === undefined ? bounds.max[k] : number(command.to, -10000, 10000, "to");
  const flat = to - from < 1e-9;
  if (flat && range)
    fail(
      command.from === undefined && command.to === undefined
        ? "The selection has no extent along the axis; give from and to, or another axis"
        : "to must be above from: the range along the axis",
      "to",
    );
  const pivot = command.pivot === undefined ? bounds.center : vector(command.pivot, "pivot"),
    power = number(command.power ?? 1, 0.05, 20, "power"),
    raw = (a) => (flat ? 0 : Math.min(1, Math.max(0, (a - from) / (to - from)))),
    t = (a) => raw(a) ** power;
  return { k, u, v, from, to, pivot, power, raw, t, bounds };
}

// Planar within 1% of the face's size (about a degree between its triangles): curved
// sweeps, lofts and subdivided surfaces keep such quads; validation warns beyond it.
export function facePlanar(vertices, face) {
  if (face.length <= 3) return true;
  let n;
  try {
    n = normal(vertices, face);
  } catch {
    return true;
  }
  const origin = vertices[face[0]],
    extent = Math.max(...face.map((i) => Math.hypot(...sub(vertices[i], origin)))),
    tolerance = Math.max(1e-5, 0.01 * extent);
  return !face.some((i) => Math.abs(dot(sub(vertices[i], origin), n)) > tolerance);
}
export const nonplanarCount = (mesh) => mesh.faces.filter((f) => !facePlanar(mesh.vertices, f.vertices)).length;

// Triangulates faces (every face, or the selected ones) the way export does, so a bent or
// displaced quad renders as the two triangles the author chose rather than as an export's.
export function triangulateFaces(mesh, command) {
  const chosen = command.faces ? new Set(command.faces) : null;
  if (chosen) for (const id of chosen) if (!mesh.faces.some((f) => f.id === id)) fail(`Unknown face: ${id}`, "faces");
  const used = new Set(mesh.faces.map((f) => f.id));
  let next = 0;
  const fresh = () => {
    while (used.has(`f${next}`)) next++;
    const id = `f${next++}`;
    used.add(id);
    return id;
  };
  const out = [];
  let split = 0;
  for (const face of mesh.faces) {
    if (face.vertices.length === 3 || (chosen && !chosen.has(face.id))) {
      out.push(face);
      continue;
    }
    triangulate(mesh.vertices, face.vertices).forEach((t, i) =>
      out.push({ id: i === 0 ? face.id : fresh(), vertices: t, material: face.material }),
    );
    split++;
  }
  mesh.faces = out;
  return { triangulated: split, faces: out.length, unchanged: split === 0 };
}

function deformPositions(mesh, command, selected) {
  const kind = command.kind;
  if (!DEFORM_KINDS.includes(kind)) fail(`kind is one of ${DEFORM_KINDS.join(", ")}`, "kind");
  const s = axialSetup(mesh, command, selected),
    V = mesh.vertices;
  if (kind === "taper") {
    const amount = Array.isArray(command.amount) ? command.amount : [command.amount, command.amount];
    if (amount.length !== 2) fail("taper amount is a scale factor or [across, along] factors", "amount");
    amount.forEach((a) => number(a, 0, 100, "amount"));
    return V.map((p) => {
      const f = s.t(p[s.k]),
        q = [...p];
      q[s.u] = s.pivot[s.u] + (p[s.u] - s.pivot[s.u]) * (1 + (amount[0] - 1) * f);
      q[s.v] = s.pivot[s.v] + (p[s.v] - s.pivot[s.v]) * (1 + (amount[1] - 1) * f);
      return q;
    });
  }
  if (kind === "twist") {
    const angle = (number(command.angle, -3600, 3600, "angle") * Math.PI) / 180,
      axis = [0, 0, 0];
    axis[s.k] = 1;
    return V.map((p) => {
      const theta = angle * s.t(p[s.k]),
        d = sub(p, s.pivot);
      d[s.k] = 0;
      const c = Math.cos(theta),
        sn = Math.sin(theta),
        r = add(add(mul(d, c), mul(cross(axis, d), sn)), mul(axis, dot(axis, d) * (1 - c))),
        q = [...p];
      q[s.u] = s.pivot[s.u] + r[s.u];
      q[s.v] = s.pivot[s.v] + r[s.v];
      return q;
    });
  }
  const direction = command.direction === undefined ? s.u : axisIndex(command.direction, "direction");
  if (direction === s.k) fail("direction must differ from the axis", "direction");
  if (kind === "shear") {
    const amount = number(command.amount, -1000, 1000, "amount");
    return V.map((p) => {
      const q = [...p];
      q[direction] = p[direction] + amount * s.t(p[s.k]);
      return q;
    });
  }
  if (kind === "stretch") {
    const amount = number(command.amount, 0.01, 100, "amount"),
      length = s.to - s.from;
    return V.map((p) => {
      const a = p[s.k],
        q = [...p];
      q[s.k] = a <= s.from ? a : a >= s.to ? a + length * (amount - 1) : s.from + (a - s.from) * amount;
      return q;
    });
  }
  // bend: the range turns into an arc of `angle` degrees towards +direction; what lies beyond
  // the range continues straight along the arc's end tangent, what lies before it stays.
  const angle = number(command.angle, -360, 360, "angle");
  if (Math.abs(angle) < 0.01) fail("bend needs an angle (degrees, at least 0.01)", "angle");
  const theta = (angle * Math.PI) / 180,
    length = s.to - s.from,
    radius = length / theta;
  return V.map((p) => {
    const a = p[s.k];
    if (a <= s.from + 1e-12) return p;
    const d = p[direction] - s.pivot[direction],
      phi = theta * Math.min(1, (a - s.from) / length);
    let a2 = s.from + (radius - d) * Math.sin(phi),
      d2 = radius - (radius - d) * Math.cos(phi);
    if (a > s.to) {
      const extra = a - s.to;
      a2 += extra * Math.cos(theta);
      d2 += extra * Math.sin(theta);
    }
    const q = [...p];
    q[s.k] = a2;
    q[direction] = s.pivot[direction] + d2;
    return q;
  });
}

function displacePositions(mesh, command, selected) {
  const amount = number(command.amount, -1000, 1000, "amount"),
    mode = command.mode ?? "uniform";
  if (!DISPLACE_MODES.includes(mode)) fail(`mode is one of ${DISPLACE_MODES.join(", ")}`, "mode");
  const s = axialSetup(mesh, command, selected, { range: mode === "gradient" }),
    along = command.along ?? "normal",
    normals = along === "normal" || mode === "formula" ? vertexNormals(mesh) : null,
    fixed =
      along === "normal"
        ? null
        : Array.isArray(along)
          ? unit(vector(along, "along"), "along")
          : (() => {
              const d = [0, 0, 0];
              d[axisIndex(along, "along")] = 1;
              return d;
            })(),
    noise = mode === "noise" || mode === "formula" ? normalizeNoise(command.noise, command.seed) : null,
    size = s.bounds.size;
  if (mode === "formula" && command.expr === undefined) fail("formula mode needs expr", "expr");
  if (mode !== "formula" && command.expr !== undefined) fail("expr belongs to formula mode", "expr");
  return mesh.vertices.map((p, i) => {
    let field = 1;
    if (mode === "noise") field = fbm3(p[0], p[1], p[2], noise);
    else if (mode === "gradient") field = s.t(p[s.k]);
    else if (mode === "formula") {
      const n = normals[i],
        du = p[s.u] - s.pivot[s.u],
        dv = p[s.v] - s.pivot[s.v];
      let a = (Math.atan2(dv, du) * 180) / Math.PI;
      if (a < 0) a += 360;
      field = formula(command.expr, {
        x: p[0],
        y: p[1],
        z: p[2],
        nx: n[0],
        ny: n[1],
        nz: n[2],
        u: size[0] > 1e-12 ? (p[0] - s.bounds.min[0]) / size[0] : 0,
        v: size[1] > 1e-12 ? (p[1] - s.bounds.min[1]) / size[1] : 0,
        w: size[2] > 1e-12 ? (p[2] - s.bounds.min[2]) / size[2] : 0,
        r: Math.hypot(du, dv),
        t: s.raw(p[s.k]),
        a,
        noise: fbm3(p[0], p[1], p[2], noise),
      });
      if (!Number.isFinite(field)) fail("The formula gave a non-finite value", "expr");
    }
    return add(p, mul(fixed ?? normals[i], amount * field));
  });
}

// Laplacian relaxation: each point moves towards the mean of its neighbours by `factor`
// per iteration; a point on an open boundary follows its boundary neighbours only, so a rim
// keeps its outline. volume: true follows every step with a slightly larger step back
// (Taubin), which smooths without shrinking.
function smoothPositions(mesh, command, weights) {
  const iterations = whole(command.iterations ?? 1, 1, 100, "iterations"),
    factor = number(command.factor ?? 0.5, 0, 1, "factor"),
    volume = command.volume === true;
  const groups = positionGroups(mesh.vertices),
    groupOf = new Map();
  for (const [key, indices] of groups) for (const i of indices) groupOf.set(i, key);
  const neighbours = new Map(),
    rim = new Map();
  const link = (map, a, b) => {
    if (!map.has(a)) map.set(a, new Set());
    map.get(a).add(b);
  };
  for (const e of meshEdges(mesh)) {
    const a = groupOf.get(e.vertices[0]),
      b = groupOf.get(e.vertices[1]);
    if (a === b) continue;
    link(neighbours, a, b);
    link(neighbours, b, a);
    if (e.sides.length === 1) {
      link(rim, a, b);
      link(rim, b, a);
    }
  }
  const positions = new Map([...groups].map(([key, indices]) => [key, mesh.vertices[indices[0]]])),
    weightOf = new Map([...groups].map(([key, indices]) => [key, Math.max(...indices.map((i) => weights[i]))]));
  const step = (lambda) => {
    const next = new Map();
    for (const [key, p] of positions) {
      const w = weightOf.get(key),
        around = rim.get(key) ?? neighbours.get(key);
      if (!(w > 0) || !around?.size) continue;
      const mean = centroid([...around].map((k) => positions.get(k)));
      next.set(key, add(p, mul(sub(mean, p), lambda * w)));
    }
    for (const [key, p] of next) positions.set(key, p);
  };
  for (let i = 0; i < iterations; i++) {
    step(factor);
    if (volume) step(-factor * 1.06);
  }
  return mesh.vertices.map((_, i) => positions.get(groupOf.get(i)));
}

// Catmull–Clark on polygons with boundaries: a point per face, per edge and per vertex, and
// a quad per corner. Linear (smooth: false) keeps every point where it is.
function catmullClark(mesh, smooth) {
  const V = mesh.vertices,
    edges = meshEdges(mesh),
    edgeIndex = new Map(edges.map((e, i) => [e.id, i])),
    faceIndex = new Map(mesh.faces.map((f, i) => [f.id, i])),
    facePoints = mesh.faces.map((f) => centroid(f.vertices.map((i) => V[i]))),
    midpoints = edges.map((e) => centroid(e.vertices.map((i) => V[i]))),
    edgePoints = edges.map((e, i) =>
      !smooth || e.sides.length !== 2
        ? midpoints[i]
        : centroid([V[e.vertices[0]], V[e.vertices[1]], ...e.sides.map((s) => facePoints[faceIndex.get(s.face)])]),
    );
  const adjacentFaces = V.map(() => []),
    adjacentEdges = V.map(() => []),
    boundaryEdges = V.map(() => []);
  mesh.faces.forEach((f, fi) => f.vertices.forEach((v) => adjacentFaces[v].push(fi)));
  edges.forEach((e, ei) =>
    e.vertices.forEach((v) => {
      adjacentEdges[v].push(ei);
      if (e.sides.length === 1) boundaryEdges[v].push(ei);
    }),
  );
  const vertexPoints = V.map((p, i) => {
    if (!smooth || !adjacentFaces[i].length) return p;
    if (boundaryEdges[i].length) {
      if (boundaryEdges[i].length !== 2) return p;
      const [m1, m2] = boundaryEdges[i].map((ei) => midpoints[ei]);
      return add(mul(p, 0.5), mul(add(m1, m2), 0.25));
    }
    const n = adjacentEdges[i].length,
      F = centroid(adjacentFaces[i].map((fi) => facePoints[fi])),
      R = centroid(adjacentEdges[i].map((ei) => midpoints[ei]));
    return mul(add(add(F, mul(R, 2)), mul(p, n - 3)), 1 / n);
  });
  const EO = V.length,
    FO = V.length + edges.length,
    faces = [];
  let n = 0;
  mesh.faces.forEach((f, fi) => {
    const m = f.vertices.length;
    for (let k = 0; k < m; k++) {
      const a = f.vertices[k],
        b = f.vertices[(k + 1) % m],
        prev = f.vertices[(k + m - 1) % m];
      faces.push({
        id: `f${n++}`,
        vertices: [a, EO + edgeIndex.get(edgeKey(a, b)), FO + fi, EO + edgeIndex.get(edgeKey(prev, a))],
        material: f.material,
      });
    }
  });
  return { vertices: [...vertexPoints, ...edgePoints, ...facePoints], faces };
}
export function subdivideMesh(mesh, command, limits = { vertices: 30000, triangles: 50000 }) {
  const levels = whole(command.levels ?? 1, 1, 3, "levels"),
    smooth = command.smooth !== false;
  let vertices = mesh.vertices.length,
    faces = mesh.faces.length,
    edges = meshEdges(mesh).length,
    corners = mesh.faces.reduce((s, f) => s + f.vertices.length, 0);
  for (let l = 0; l < levels; l++) {
    vertices += edges + faces;
    faces = corners;
    edges = 2 * edges + corners;
    corners *= 4;
  }
  if (vertices > limits.vertices || faces * 2 > limits.triangles)
    fail(
      `Subdividing ${levels} level${levels > 1 ? "s" : ""} would give ${vertices} vertices and ${faces} faces; the caps are ${limits.vertices} and ${Math.floor(limits.triangles / 2)}. Use fewer levels or a simpler mesh`,
      "levels",
    );
  let result = mesh;
  for (let l = 0; l < levels; l++) result = catmullClark(result, smooth);
  mesh.vertices = result.vertices;
  mesh.faces = result.faces;
  return { faces: mesh.faces.length, vertices: mesh.vertices.length, levels };
}

// Runs one shape edit on a mesh in place. `selected` lists the vertex indices that move
// fully (every vertex when absent); the rest follow by the falloff.
function controlPositions(mesh, command) {
  if (!Array.isArray(command.handles) || !command.handles.length || command.handles.length > 64)
    fail("controlDeform needs 1–64 handles", "handles");
  const axis = command.mirrorAxis === undefined ? -1 : ["x", "y", "z"].indexOf(command.mirrorAxis);
  if (command.mirrorAxis !== undefined && axis < 0) fail("mirrorAxis is x, y or z", "mirrorAxis");
  const handles = command.handles.flatMap((h, i) => {
    if (!h || typeof h !== "object") fail("Expected a control handle with center, radius and delta", `handles.${i}`);
    const center = vector(h.center, `handles.${i}.center`), delta = vector(h.delta, `handles.${i}.delta`);
    const radius = number(h.radius, 1e-8, 10000, `handles.${i}.radius`);
    const result = [{ center, delta, radius }];
    if (axis >= 0 && Math.abs(center[axis]) > 1e-10)
      result.push({ center: center.map((v, k) => k === axis ? -v : v),
        delta: delta.map((v, k) => k === axis ? -v : v), radius });
    else if (axis >= 0 && Math.abs(delta[axis]) > 1e-10)
      fail("A handle on the mirror plane cannot move across that plane", `handles.${i}.delta`);
    return result;
  });
  if (handles.length * mesh.vertices.length > 2000000) fail("Control deformation exceeds two million vertex/handle pairs", "handles");
  return mesh.vertices.map(p => handles.reduce((q, h) => {
    const t = Math.hypot(...p.map((v, k) => v - h.center[k])) / h.radius;
    if (t >= 1) return q;
    const w = (1 - t) ** 4 * (4 * t + 1);
    return q.map((v, k) => v + h.delta[k] * w);
  }, [...p]));
}

export function shapeMesh(mesh, command, { limits, planarity = true } = {}) {
  if (command.op === "subdivide") return subdivideMesh(mesh, command, limits);
  if (command.op === "triangulate") return triangulateFaces(mesh, command);
  const all = mesh.vertices.map((_, i) => i),
    selected = command.selected ?? all,
    falloff = normalizeFalloff(command.falloff),
    { weights } = falloffWeights(mesh.vertices, selected, falloff);
  if (command.op === "smooth") {
    const positions = smoothPositions(mesh, command, weights);
    let count = 0;
    mesh.vertices = mesh.vertices.map((p, i) => {
      if (!(weights[i] > 0)) return p;
      count++;
      return positions[i].map((v) => v || 0);
    });
    return { affectedVertices: count };
  }
  const moved = command.op === "controlDeform" ? controlPositions(mesh, command)
    : command.op === "deform" ? deformPositions(mesh, command, selected) : displacePositions(mesh, command, selected);
  let count = 0;
  mesh.vertices = mesh.vertices.map((p, i) => {
    const w = weights[i];
    if (!(w > 0)) return p;
    count++;
    const q = w >= 1 ? moved[i] : add(p, mul(sub(moved[i], p), w));
    if (q.some((v) => !Number.isFinite(v) || Math.abs(v) > 10000)) fail("The edit moves a vertex out of range (±10000 m)", "amount");
    return q.map((v) => v || 0);
  });
  // Bent quads: the author can split them (triangulate) or leave them to export's choice.
  // (Dense meshes never warn about planarity, so they are not counted.)
  const nonplanar = planarity ? nonplanarCount(mesh) : 0;
  return {
    affectedVertices: count,
    ...(nonplanar
      ? { nonplanarFaces: nonplanar, suggestion: `${nonplanar} faces are no longer flat; triangulate the part (or the faces) to fix their folds, or leave them for export to split` }
      : {}),
  };
}

// Proportional editing for transform and vertices: every vertex moves towards
// `targetOf(i, p, nearest)` (its full-weight destination: the transformed point, or the
// nearest selected vertex's displacement added to it) by its falloff weight. `points` are the
// positions distances are measured in (the command's space).
export function proportionalMove(mesh, points, selected, targetOf, falloff) {
  const { weights, nearest } = falloffWeights(points, selected, falloff);
  let count = 0;
  mesh.vertices = mesh.vertices.map((p, i) => {
    const w = weights[i];
    if (!(w > 0)) return p;
    count++;
    const target = targetOf(i, p, nearest[i]);
    return (w >= 1 ? target : add(p, mul(sub(target, p), w))).map((v) => v || 0);
  });
  return count;
}
