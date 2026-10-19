// Editable polygon meshes <-> kernel solids, and triangles -> editable polygons.
// Polygons are what people and agents select, paint and extrude; the kernel and GLB files
// only know triangles, so every kernel result and import passes through polygonize().
import { fail, triangulate, normal, sub, cross, dot } from "./mesh.js";
import { kernel } from "./kernel.js";

const round = (v) => Math.round(v * 1e6) / 1e6 || 0;

// Kernel input: one closed, consistently oriented solid. faceID keeps the source polygon of
// every triangle, so results can recover polygons and materials.
export function toSolid(mesh, matrix = null) {
  const { Manifold, Mesh } = kernel();
  // A reserved original ID lets results trace every triangle back to this input.
  const id = Manifold.reserveIDs(1);
  const positions = new Float32Array(mesh.vertices.length * 3);
  mesh.vertices.forEach((v, i) => {
    const p = matrix ? apply(matrix, v) : v;
    positions.set(p, i * 3);
  });
  // A reflecting placement turns the solid inside out unless the winding flips too.
  const flip =
    matrix &&
    matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9]) -
      matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9]) +
      matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5]) <
      0;
  const triangles = [],
    faceIDs = [];
  mesh.faces.forEach((face, index) => {
    for (const t of triangulate(mesh.vertices, face.vertices)) {
      triangles.push(...(flip ? [t[0], t[2], t[1]] : t));
      faceIDs.push(index);
    }
  });
  const input = new Mesh({
    numProp: 3,
    vertProperties: positions,
    triVerts: new Uint32Array(triangles),
    faceID: new Uint32Array(faceIDs),
    runIndex: new Uint32Array([0, triangles.length]),
    runOriginalID: new Uint32Array([id]),
  });
  input.merge();
  let solid;
  try {
    solid = new Manifold(input);
  } catch {
    fail(
      "This operation needs a closed solid; fill holes or weld the mesh first",
    );
  }
  if (solid.status() !== "NoError") {
    solid.delete();
    fail(
      "This operation needs a closed solid; fill holes or weld the mesh first",
    );
  }
  solid.sourceID = id;
  return solid;
}

function apply(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// Kernel output -> editable mesh. sources maps a reserved original ID to
// { materials: [material per faceID], fallback } so every triangle keeps its material.
export function fromSolid(solid, sources) {
  const result = solid.getMesh(),
    count = result.vertProperties.length / result.numProp,
    positions = [];
  for (let i = 0; i < count; i++)
    positions.push([0, 1, 2].map((k) => result.vertProperties[i * result.numProp + k]));
  // Vertices the kernel split only for properties are one point.
  const merged = new Map();
  for (let i = 0; i < result.mergeFromVert.length; i++)
    merged.set(result.mergeFromVert[i], result.mergeToVert[i]);
  const triangles = [],
    groups = [],
    materials = [];
  let run = 0;
  for (let t = 0; t < result.triVerts.length / 3; t++) {
    while (run + 1 < result.runIndex.length && t * 3 >= result.runIndex[run + 1]) run++;
    const id = result.runOriginalID[run],
      source = sources.get(id),
      face = result.faceID[t];
    triangles.push([0, 1, 2].map((k) => {
      const v = result.triVerts[t * 3 + k];
      return merged.get(v) ?? v;
    }));
    groups.push(`${id}/${face}`);
    materials.push(source?.materials?.[face] ?? source?.fallback);
  }
  return polygonize(positions, triangles, groups, materials);
}

// Triangles sharing a group key (one source polygon, or one coplanar region) merge back
// into polygons: one face per simple region; where a region has holes or more than 64
// corners, the fewest simple pieces that region growing finds. Shared vertices keep the
// result watertight.
export function polygonize(positions, triangles, groups, materials) {
  // Weld coincident points (micrometre grid): the kernel can emit separate vertices at one
  // position, which would otherwise repeat inside a polygon.
  const vertices = [],
    canonical = new Map(),
    index = positions.map((p) => {
      const q = p.map(round),
        key = q.join(",");
      if (!canonical.has(key)) {
        canonical.set(key, vertices.length);
        vertices.push(q);
      }
      return canonical.get(key);
    });
  const welded = triangles.map((t) => t.map((v) => index[v]));
  const byGroup = new Map();
  welded.forEach((t, i) => {
    if (new Set(t).size < 3) return;
    const key = `${groups[i]}|${materials[i]}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(i);
  });
  const faces = [];
  for (const indices of byGroup.values()) {
    const material = materials[indices[0]];
    for (const component of components(indices, welded)) {
      const loops = boundaryLoops(component, welded);
      const polygon = loops.length === 1 && loops[0].length <= 64 ? loops[0] : null;
      if (polygon && simple(vertices, polygon)) faces.push({ vertices: polygon, material });
      else
        for (const piece of simplePieces(vertices, component, welded))
          faces.push({ vertices: piece, material });
    }
  }
  // Compact unused vertices and give faces stable sequential IDs.
  const used = [...new Set(faces.flatMap((f) => f.vertices))].sort((a, b) => a - b),
    map = new Map(used.map((v, i) => [v, i]));
  return {
    vertices: used.map((i) => vertices[i]),
    faces: faces.map((f, i) => ({
      id: `f${i}`,
      vertices: f.vertices.map((v) => map.get(v)),
      material: f.material,
    })),
  };
}

const edgeKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
function components(indices, triangles) {
  const parent = new Map(indices.map((i) => [i, i]));
  const find = (i) => {
    while (parent.get(i) !== i) {
      parent.set(i, parent.get(parent.get(i)));
      i = parent.get(i);
    }
    return i;
  };
  const owner = new Map();
  for (const i of indices)
    triangles[i].forEach((a, k) => {
      const key = edgeKey(a, triangles[i][(k + 1) % 3]);
      if (owner.has(key)) parent.set(find(i), find(owner.get(key)));
      else owner.set(key, i);
    });
  const result = new Map();
  for (const i of indices) {
    const root = find(i);
    if (!result.has(root)) result.set(root, []);
    result.get(root).push(i);
  }
  return [...result.values()];
}

// Directed boundary edges follow triangle winding, so loops come out counter-clockwise
// around the region and clockwise around holes.
function boundaryLoops(component, triangles) {
  const directed = new Map();
  for (const i of component)
    triangles[i].forEach((a, k) => {
      const b = triangles[i][(k + 1) % 3];
      const reverse = `${b}>${a}`;
      if (directed.has(reverse)) directed.delete(reverse);
      else directed.set(`${a}>${b}`, [a, b]);
    });
  const next = new Map();
  for (const [a, b] of directed.values()) {
    if (next.has(a)) return [null, null]; // A pinched vertex: grow simple pieces.
    next.set(a, b);
  }
  const loops = [],
    seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    for (let v = start; !seen.has(v); v = next.get(v)) {
      if (v === undefined) return [null, null];
      seen.add(v);
      loop.push(v);
    }
    loops.push(loop);
  }
  return loops;
}

function simple(vertices, polygon) {
  if (new Set(polygon).size !== polygon.length) return false;
  try {
    normal(vertices, polygon);
    triangulate(vertices, polygon);
    return true;
  } catch {
    return false;
  }
}

// Region growing: absorb neighbouring triangles while the polygon stays simple and within
// 64 corners. Concave pieces are fine; the editor triangulates them by ear clipping.
function simplePieces(vertices, component, triangles) {
  const remaining = new Set(component),
    byEdge = new Map();
  for (const i of component)
    triangles[i].forEach((a, k) => byEdge.set(`${a}>${triangles[i][(k + 1) % 3]}`, i));
  const pieces = [];
  for (const seed of component) {
    if (!remaining.has(seed)) continue;
    remaining.delete(seed);
    let polygon = [...triangles[seed]];
    for (let grown = true; grown; ) {
      grown = false;
      for (let k = 0; k < polygon.length && !grown; k++) {
        const a = polygon[k],
          b = polygon[(k + 1) % polygon.length],
          t = byEdge.get(`${b}>${a}`);
        if (t === undefined || !remaining.has(t)) continue;
        const union = join(polygon, triangles[t], a, b);
        if (union && union.length <= 64 && simple(vertices, union)) {
          polygon = union;
          remaining.delete(t);
          grown = true;
        }
      }
    }
    if (simple(vertices, polygon)) pieces.push(polygon);
  }
  return pieces;
}

// Two polygons sharing edge a-b (opposite directions) become one polygon.
function join(p, q, a, b) {
  const rotate = (poly, from, to) => {
    const i = poly.findIndex((v, k) => v === from && poly[(k + 1) % poly.length] === to);
    return i < 0 ? null : [...poly.slice(i + 1), ...poly.slice(0, i + 1)];
  };
  let first = rotate(p, a, b),
    second = rotate(q, b, a);
  if (!first || !second) {
    first = rotate(p, b, a);
    second = rotate(q, a, b);
  }
  if (!first || !second) return null;
  // first runs b … a, second runs a … b: drop each shared end once.
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

// One loop of existing vertices -> simple polygons of at most 64 corners (ear clipping in
// the loop's dominant plane, then region growing). Used to fill holes that a single face
// cannot cover.
export function splitPolygon(vertices, loop) {
  const triangles = triangulate(vertices, loop);
  return simplePieces(
    vertices,
    triangles.map((_, i) => i),
    triangles,
  );
}
