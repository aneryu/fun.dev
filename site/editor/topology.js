import {
  add,
  sub,
  mul,
  dot,
  cross,
  normal,
  triangulate,
  number,
  fail,
} from "./mesh.js";

export const edgeKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
export function meshEdges(mesh) {
  const edges = new Map();
  for (const face of mesh.faces)
    face.vertices.forEach((a, i) => {
      const b = face.vertices[(i + 1) % face.vertices.length],
        id = edgeKey(a, b);
      if (!edges.has(id))
        edges.set(id, {
          id,
          vertices: [Math.min(a, b), Math.max(a, b)],
          sides: [],
        });
      edges.get(id).sides.push({ face: face.id, a, b, index: i });
    });
  return [...edges.values()];
}
const unit = (v) => mul(v, 1 / Math.hypot(...v));
const near = (a, b) => Math.hypot(...sub(a, b)) < 1e-8;
function nextFace(mesh) {
  const ids = new Set(mesh.faces.map((f) => f.id));
  let i = 0;
  return () => {
    while (ids.has(`f${i}`)) i++;
    const id = `f${i++}`;
    ids.add(id);
    return id;
  };
}
function compact(mesh) {
  const used = [...new Set(mesh.faces.flatMap((f) => f.vertices))],
    map = new Map(used.map((v, i) => [v, i]));
  mesh.vertices = used.map((i) => mesh.vertices[i]);
  for (const f of mesh.faces) f.vertices = f.vertices.map((i) => map.get(i));
}
function checkClosed(mesh) {
  for (const e of meshEdges(mesh))
    if (e.sides.length !== 2 || e.sides[0].a !== e.sides[1].b)
      fail("Selected-edge bevel needs a closed, consistently oriented mesh");
}

// Offset only selected polygon edges. Unbeveled edges share their trimmed end
// points; remaining corner boundaries are capped with oriented triangles.
// Works on locally convex faces of concave solids, including inset recesses.
export function bevelEdges(mesh, selection, distance) {
  number(distance, 0.00001, 1000);
  checkClosed(mesh);
  const edges = meshEdges(mesh),
    selected = new Set(selection),
    byEdge = new Map(edges.map((e) => [e.id, e]));
  if (!selected.size || [...selected].some((id) => !byEdge.has(id)))
    fail("Select valid edges to bevel");
  const old = structuredClone(mesh),
    corners = new Map(),
    next = nextFace(mesh);
  for (const face of old.faces) {
    const n = normal(old.vertices, face.vertices);
    if (
      face.vertices.some(
        (i) =>
          Math.abs(
            dot(sub(old.vertices[i], old.vertices[face.vertices[0]]), n),
          ) > 1e-7,
      )
    )
      fail("Bevel needs planar faces");
    corners.set(
      face.id,
      face.vertices.map((v, i, vs) => {
        const prev = vs[(i + vs.length - 1) % vs.length],
          after = vs[(i + 1) % vs.length],
          p = old.vertices[v];
        const a = selected.has(edgeKey(prev, v)) ? distance : 0,
          b = selected.has(edgeKey(v, after)) ? distance : 0;
        if (!a && !b) return [...p];
        const incoming = unit(sub(p, old.vertices[prev])),
          outgoing = unit(sub(old.vertices[after], p));
        const u = cross(n, incoming),
          w = cross(n, outgoing),
          c = dot(u, w),
          det = 1 - c * c;
        if (dot(cross(incoming, outgoing), n) < -1e-8 || det < 1e-10)
          fail(
            "Bevel needs convex, non-collinear corners around the selected edges",
          );
        return add(
          p,
          add(mul(u, (a - c * b) / det), mul(w, (b - c * a) / det)),
        );
      }),
    );
  }
  const cuts = new Map();
  for (const e of edges.filter((e) => !selected.has(e.id))) {
    const points = e.vertices.map((v) => {
      const original = old.vertices[v];
      return e.sides
        .map((s) => {
          const f = old.faces.find((f) => f.id === s.face);
          return corners.get(f.id)[f.vertices.indexOf(v)];
        })
        .sort(
          (a, b) =>
            Math.hypot(...sub(b, original)) - Math.hypot(...sub(a, original)),
        )[0];
    });
    if (
      dot(
        sub(points[1], points[0]),
        sub(old.vertices[e.vertices[1]], old.vertices[e.vertices[0]]),
      ) <= 1e-10
    )
      fail("Bevel is too wide for the adjacent edges");
    cuts.set(e.id, new Map(e.vertices.map((v, i) => [v, points[i]])));
  }
  const vertices = [],
    index = (p) => {
      let i = vertices.findIndex((v) => near(v, p));
      if (i < 0) {
        i = vertices.length;
        vertices.push(p);
      }
      return i;
    },
    cornerIds = new Map(),
    faces = [];
  for (const face of old.faces) {
    const result = [];
    face.vertices.forEach((v, i, vs) => {
      const prev = edgeKey(vs[(i + vs.length - 1) % vs.length], v),
        after = edgeKey(v, vs[(i + 1) % vs.length]);
      const p = corners.get(face.id)[i];
      let points;
      if (selected.has(prev) && selected.has(after)) points = [p];
      else if (selected.has(prev)) points = [cuts.get(after).get(v)];
      else if (selected.has(after)) points = [cuts.get(prev).get(v)];
      else points = [cuts.get(prev).get(v), cuts.get(after).get(v)];
      const ids = [...new Set(points.map(index))];
      cornerIds.set(`${face.id}/${v}`, ids);
      result.push(...ids);
    });
    if (new Set(result).size !== result.length)
      fail("Bevel is too wide for this face");
    const originalNormal = normal(old.vertices, face.vertices);
    if (dot(normal(vertices, result), originalNormal) < 0.99999)
      fail("Bevel is too wide or creates a non-planar face");
    // Every new corner must stay inside its original convex face.
    for (let i = 0; i < face.vertices.length; i++) {
      const p = old.vertices[face.vertices[i]],
        q = old.vertices[face.vertices[(i + 1) % face.vertices.length]];
      if (
        result.some(
          (v) =>
            dot(cross(sub(q, p), sub(vertices[v], p)), originalNormal) < -1e-8,
        )
      )
        fail("Bevel crosses an adjacent edge; reduce its width");
    }
    triangulate(vertices, result);
    faces.push({ ...face, vertices: result });
  }
  for (const id of selected) {
    const [a, b] = byEdge.get(id).sides;
    const vs = [
      cornerIds.get(`${a.face}/${a.b}`)[0],
      cornerIds.get(`${a.face}/${a.a}`)[0],
      cornerIds.get(`${b.face}/${b.b}`)[0],
      cornerIds.get(`${b.face}/${b.a}`)[0],
    ];
    if (new Set(vs).size < 4)
      fail("Cannot bevel a coplanar edge; choose a crease");
    triangulate(vertices, vs);
    faces.push({
      id: next(),
      vertices: vs,
      material: old.faces.find((f) => f.id === a.face).material,
    });
  }
  const boundary = meshEdges({ vertices, faces })
    .filter((e) => e.sides.length === 1)
    .map((e) => e.sides[0]);
  while (boundary.length) {
    const start = boundary.shift(),
      loop = [start.b, start.a];
    let current = start.a;
    while (current !== loop[0]) {
      const i = boundary.findIndex((e) => e.b === current);
      if (i < 0) fail("Bevel cannot close this corner");
      const e = boundary.splice(i, 1)[0];
      current = e.a;
      if (current !== loop[0]) loop.push(current);
      if (loop.length > 64) fail("Bevel corner is too complex");
    }
    if (loop.length < 3) fail("Degenerate bevel corner");
    for (const triangle of triangulate(vertices, loop))
      faces.push({
        id: next(),
        vertices: triangle,
        material: faces.find((f) => f.id === start.face).material,
      });
  }
  const result = { vertices, faces };
  checkClosed(result);
  compact(result);
  mesh.vertices = result.vertices;
  mesh.faces = result.faces;
}

export function cutPlane(mesh, axis, offset) {
  const k = ["x", "y", "z"].indexOf(axis);
  if (k < 0) fail("Choose x, y or z");
  number(offset, -10000, 10000);
  const next = nextFace(mesh),
    intersections = new Map(),
    faces = [];
  const intersection = (a, b) => {
    const id = edgeKey(a, b);
    if (intersections.has(id)) return intersections.get(id);
    const p = mesh.vertices[a],
      q = mesh.vertices[b],
      t = (offset - p[k]) / (q[k] - p[k]);
    const i = mesh.vertices.length;
    mesh.vertices.push(add(p, mul(sub(q, p), t)));
    intersections.set(id, i);
    return i;
  };
  let split = 0;
  for (const face of mesh.faces) {
    const sides = face.vertices.map((i) => mesh.vertices[i][k] - offset);
    if (!sides.some((n) => n > 1e-8) || !sides.some((n) => n < -1e-8)) {
      faces.push(face);
      continue;
    }
    const halves = [[], []];
    let crossings = 0;
    face.vertices.forEach((a, i, vs) => {
      const b = vs[(i + 1) % vs.length],
        da = sides[i],
        db = sides[(i + 1) % vs.length];
      if (da >= -1e-8) halves[0].push(a);
      if (da <= 1e-8) halves[1].push(a);
      if (da * db < -1e-16) {
        const v = intersection(a, b);
        halves.forEach((h) => h.push(v));
        crossings++;
      }
    });
    if (crossings > 2)
      fail(
        "This cut crosses a concave face more than twice; choose a different plane",
      );
    halves.forEach((vertices, i) => {
      triangulate(mesh.vertices, vertices);
      faces.push({ ...face, id: i ? next() : face.id, vertices });
    });
    split++;
  }
  if (!split) fail("Cut plane does not cross any faces");
  mesh.faces = faces;
}

export function loopCut(mesh, edge, ratio = 0.5) {
  number(ratio, 0.01, 0.99);
  const edges = meshEdges(mesh),
    byEdge = new Map(edges.map((e) => [e.id, e]));
  if (!byEdge.has(edge)) fail("Select an edge for the loop cut");
  const next = nextFace(mesh),
    points = new Map(),
    splits = new Map(),
    queue = [];
  const setPoint = (id, p) => {
    if (points.has(id)) {
      if (!near(mesh.vertices[points.get(id)], p))
        fail("Loop orientation conflicts; use a centered cut");
      return;
    }
    points.set(id, mesh.vertices.length);
    mesh.vertices.push(p);
    queue.push(id);
  };
  const initial = byEdge.get(edge).vertices;
  setPoint(
    edge,
    add(
      mesh.vertices[initial[0]],
      mul(sub(mesh.vertices[initial[1]], mesh.vertices[initial[0]]), ratio),
    ),
  );
  while (queue.length) {
    const id = queue.shift(),
      e = byEdge.get(id);
    if (e.sides.length > 2) fail("Loop cut needs manifold edges");
    for (const side of e.sides) {
      if (splits.has(side.face)) continue;
      const f = mesh.faces.find((f) => f.id === side.face),
        vs = f.vertices;
      if (vs.length !== 4)
        fail("Loop cut needs a strip of quad faces; use a plane cut here");
      const i = side.index,
        a = mesh.vertices[vs[i]],
        b = mesh.vertices[vs[(i + 1) % 4]],
        t =
          Math.hypot(...sub(mesh.vertices[points.get(id)], a)) /
          Math.hypot(...sub(b, a));
      const c = vs[(i + 2) % 4],
        d = vs[(i + 3) % 4],
        opposite = edgeKey(c, d);
      setPoint(
        opposite,
        add(mesh.vertices[d], mul(sub(mesh.vertices[c], mesh.vertices[d]), t)),
      );
      const p = points.get(id),
        q = points.get(opposite);
      splits.set(f.id, [
        [vs[i], p, q, d],
        [p, vs[(i + 1) % 4], c, q],
      ]);
    }
  }
  mesh.faces = mesh.faces.flatMap((f) =>
    splits.has(f.id)
      ? splits
          .get(f.id)
          .map((vertices, i) => ({ ...f, id: i ? next() : f.id, vertices }))
      : f,
  );
}
