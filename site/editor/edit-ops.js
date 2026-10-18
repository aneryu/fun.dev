// Mesh editing on editable polygons: delete, dissolve, weld, fill, bridge, connect and
// solidify change one part's mesh; separate and join move geometry between parts.
// Every operation either produces valid polygons or fails before the document changes.
import {
  fail,
  number,
  normal,
  triangulate,
  add,
  sub,
  mul,
  dot,
  cross,
} from "./mesh.js";
import { edgeKey, meshEdges } from "./topology.js";
import { splitPolygon } from "./solid.js";
import { multiply, inverse, worldMatrix, transformMesh } from "./spatial.js";

export const MESH_EDITS = [
  "deleteComponents",
  "dissolve",
  "weld",
  "fill",
  "bridge",
  "connect",
  "solidify",
];
// Distances (weld, solidify) are world meters unless space is "local".
export const DISTANCE_EDITS = ["weld", "solidify"];

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
  const used = [...new Set(mesh.faces.flatMap((f) => f.vertices))].sort(
      (a, b) => a - b,
    ),
    map = new Map(used.map((v, i) => [v, i]));
  mesh.vertices = used.map((i) => mesh.vertices[i]);
  for (const f of mesh.faces) f.vertices = f.vertices.map((i) => map.get(i));
}
function simple(vertices, polygon) {
  if (polygon.length < 3 || new Set(polygon).size !== polygon.length)
    return false;
  try {
    normal(vertices, polygon);
    triangulate(vertices, polygon);
    return true;
  } catch {
    return false;
  }
}
const unit = (v) => mul(v, 1 / Math.hypot(...v));
function faceById(mesh, id) {
  const face = mesh.faces.find((f) => f.id === id);
  if (!face) fail(`Unknown face: ${id}`);
  return face;
}
function checkEdges(mesh, edges) {
  const known = new Set(meshEdges(mesh).map((e) => e.id));
  for (const id of edges) if (!known.has(id)) fail(`Unknown edge: ${id}`);
}
function checkVertices(mesh, vertices) {
  for (const v of vertices)
    if (!Number.isInteger(v) || !mesh.vertices[v])
      fail(`Unknown vertex: ${v}`);
}

// The boundary of a set of faces as one loop, or null when it has a hole, a pinch or
// more than 64 corners. Internal vertices simply drop out.
function regionLoop(mesh, faces) {
  const directed = new Map();
  for (const f of faces)
    f.vertices.forEach((a, i) => {
      const b = f.vertices[(i + 1) % f.vertices.length];
      if (directed.has(`${b}>${a}`)) directed.delete(`${b}>${a}`);
      else directed.set(`${a}>${b}`, [a, b]);
    });
  const next = new Map();
  for (const [a, b] of directed.values()) {
    if (next.has(a)) return null;
    next.set(a, b);
  }
  if (!next.size) return null;
  const start = next.keys().next().value,
    loop = [];
  for (let v = start; ; v = next.get(v)) {
    if (v === undefined || loop.length > next.size) return null;
    loop.push(v);
    if (next.get(v) === start) break;
  }
  if (loop.length !== next.size || loop.length > 64) return null;
  return simple(mesh.vertices, loop) ? loop : null;
}

// Replace a group of faces by one polygon, keeping the first face's ID and material.
function mergeFaces(mesh, ids, loop) {
  const first = mesh.faces.find((f) => ids.has(f.id));
  first.vertices = loop;
  mesh.faces = mesh.faces.filter((f) => f === first || !ids.has(f.id));
}

function faceNormals(mesh) {
  return new Map(mesh.faces.map((f) => [f.id, normal(mesh.vertices, f.vertices)]));
}

// Remove vertices that only sit between two collinear edges and are shared by every
// face around them, so neighbouring faces stay watertight.
function dropCollinear(mesh, candidates) {
  const users = new Map(),
    neighbours = new Map();
  for (const f of mesh.faces)
    f.vertices.forEach((v, i) => {
      if (!users.has(v)) users.set(v, []);
      users.get(v).push(f);
      const set = neighbours.get(v) ?? new Set();
      set.add(f.vertices[(i + 1) % f.vertices.length]);
      set.add(f.vertices[(i + f.vertices.length - 1) % f.vertices.length]);
      neighbours.set(v, set);
    });
  let removed = 0;
  for (const v of candidates) {
    const around = neighbours.get(v);
    if (!around || around.size !== 2) continue;
    const [a, b] = [...around],
      p = mesh.vertices[v],
      d1 = sub(p, mesh.vertices[a]),
      d2 = sub(mesh.vertices[b], p),
      l1 = Math.hypot(...d1),
      l2 = Math.hypot(...d2);
    if (
      !l1 ||
      !l2 ||
      dot(d1, d2) <= 0 ||
      Math.hypot(...cross(d1, d2)) / (l1 * l2) > 1e-9
    )
      continue;
    const faces = users.get(v);
    if (faces.some((f) => f.vertices.length <= 3)) continue;
    for (const f of faces) f.vertices = f.vertices.filter((i) => i !== v);
    // a and b are now neighbours of each other instead of v.
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      neighbours.get(x).delete(v);
      neighbours.get(x).add(y);
    }
    removed++;
  }
  return removed;
}

function deleteComponents(mesh, { faces, edges, vertices }) {
  const remove = new Set();
  if (faces) {
    for (const id of faces) remove.add(faceById(mesh, id).id);
  }
  if (edges) {
    checkEdges(mesh, edges);
    const set = new Set(edges);
    for (const f of mesh.faces)
      if (
        f.vertices.some((a, i) =>
          set.has(edgeKey(a, f.vertices[(i + 1) % f.vertices.length])),
        )
      )
        remove.add(f.id);
  }
  if (vertices) {
    checkVertices(mesh, vertices);
    const set = new Set(vertices);
    for (const f of mesh.faces)
      if (f.vertices.some((v) => set.has(v))) remove.add(f.id);
  }
  if (!remove.size) fail("Select faces, edges or vertices to delete");
  mesh.faces = mesh.faces.filter((f) => !remove.has(f.id));
  if (!mesh.faces.length)
    fail("Deleting every face leaves no mesh; delete the part instead");
  compact(mesh);
  return { deletedFaces: remove.size };
}

function dissolve(mesh, { edges, vertices, angle = 0.1 }) {
  number(angle, 0, 30, "angle");
  const limit = Math.cos((angle * Math.PI) / 180);
  if (vertices) return dissolveVertices(mesh, vertices);
  if (edges) {
    checkEdges(mesh, edges);
    const result = dissolvePass(mesh, limit, new Set(edges));
    if (!result.merged && !result.removed) fail("Nothing to dissolve");
    return { mergedFaces: result.merged, removedVertices: result.removed };
  }
  // Whole-mesh cleanup: merging frees corners (collinear points drop out), which lets
  // the next pass merge further, until nothing changes.
  let merged = 0,
    removed = 0;
  for (let pass = 0; pass < 32; pass++) {
    const result = dissolvePass(mesh, limit, null);
    merged += result.merged;
    removed += result.removed;
    if (!result.merged && !result.removed) break;
  }
  // An already clean mesh changes nothing.
  if (!merged && !removed)
    return { mergedFaces: 0, removedVertices: 0, unchanged: true };
  return { mergedFaces: merged, removedVertices: removed };
}

function dissolvePass(mesh, limit, chosen) {
  const explicit = !!chosen,
    normals = faceNormals(mesh),
    all = meshEdges(mesh),
    byId = new Map(mesh.faces.map((f) => [f.id, f]));
  // Faces joined across an edge must be coplanar (within angle) and share a material.
  const candidates = all.filter((e) => {
    if (chosen && !chosen.has(e.id)) return false;
    if (e.sides.length !== 2 || e.sides[0].face === e.sides[1].face) return false;
    const [a, b] = e.sides.map((s) => s.face);
    if (dot(normals.get(a), normals.get(b)) < limit) {
      if (explicit)
        fail(
          `Dissolve joins coplanar faces; ${a} and ${b} meet at an angle along ${e.id}`,
        );
      return false;
    }
    if (!explicit && byId.get(a).material !== byId.get(b).material)
      return false;
    return true;
  });
  if (explicit && candidates.length !== chosen.size)
    fail("Dissolve needs edges shared by exactly two faces");
  // Union faces across candidate edges, then replace each group by one polygon.
  const parent = new Map(mesh.faces.map((f) => [f.id, f.id]));
  const find = (id) => {
    while (parent.get(id) !== id) id = parent.get(id);
    return id;
  };
  for (const e of candidates) {
    const [a, b] = e.sides.map((s) => find(s.face));
    if (a !== b) parent.set(b, a);
  }
  const groups = new Map();
  for (const f of mesh.faces) {
    const root = find(f.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(f);
  }
  const touched = new Set();
  let merged = 0;
  for (const faces of groups.values()) {
    if (faces.length < 2) continue;
    const loop = regionLoop(mesh, faces);
    if (loop) {
      faces.flatMap((f) => f.vertices).forEach((v) => touched.add(v));
      mergeFaces(mesh, new Set(faces.map((f) => f.id)), loop);
      merged += faces.length - 1;
      continue;
    }
    if (explicit)
      fail(
        "Dissolving these edges would leave a face with a hole, a pinch or more than 64 corners",
      );
    merged += growRegions(mesh, faces, candidates, touched);
  }
  const removed = dropCollinear(mesh, explicit ? touched : mesh.vertices.keys());
  compact(mesh);
  return { merged, removed };
}

// Limited dissolve inside a region that cannot become one face: absorb neighbours
// one at a time while the result stays a simple polygon.
function growRegions(mesh, faces, candidates, touched) {
  const ids = new Set(faces.map((f) => f.id)),
    byId = new Map(faces.map((f) => [f.id, f])),
    adjacency = new Map();
  for (const e of candidates) {
    const [a, b] = e.sides.map((s) => s.face);
    if (!ids.has(a) || !ids.has(b)) continue;
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      if (!adjacency.has(x)) adjacency.set(x, new Set());
      adjacency.get(x).add(y);
    }
  }
  const remaining = new Set(ids);
  let merged = 0;
  for (const seed of faces.map((f) => f.id)) {
    if (!remaining.has(seed)) continue;
    remaining.delete(seed);
    const group = [byId.get(seed)];
    for (let grown = true; grown; ) {
      grown = false;
      for (const member of [...group])
        for (const other of adjacency.get(member.id) ?? []) {
          if (!remaining.has(other)) continue;
          const face = byId.get(other),
            loop = regionLoop(mesh, [...group, face]);
          if (!loop) continue;
          remaining.delete(other);
          group.push(face);
          grown = true;
        }
    }
    if (group.length > 1) {
      group.flatMap((f) => f.vertices).forEach((v) => touched.add(v));
      mergeFaces(
        mesh,
        new Set(group.map((f) => f.id)),
        regionLoop(mesh, group),
      );
      merged += group.length - 1;
    }
  }
  return merged;
}

function dissolveVertices(mesh, vertices) {
  checkVertices(mesh, vertices);
  for (const v of new Set(vertices)) {
    const faces = mesh.faces.filter((f) => f.vertices.includes(v));
    if (!faces.length) continue;
    const around = new Set();
    for (const f of faces) {
      const i = f.vertices.indexOf(v),
        n = f.vertices.length;
      around.add(f.vertices[(i + 1) % n]);
      around.add(f.vertices[(i + n - 1) % n]);
    }
    if (around.size === 2) {
      // A vertex between two edges: drop it from the faces on both sides.
      for (const f of faces) {
        const next = f.vertices.filter((i) => i !== v);
        if (!simple(mesh.vertices, next))
          fail(`Dissolving vertex ${v} would collapse face ${f.id}`);
        f.vertices = next;
      }
      continue;
    }
    let loop = regionLoop(mesh, faces);
    if (loop?.includes(v)) loop = loop.filter((i) => i !== v);
    if (!loop || !simple(mesh.vertices, loop))
      fail(`Dissolving vertex ${v} would leave an invalid face`);
    mergeFaces(mesh, new Set(faces.map((f) => f.id)), loop);
  }
  compact(mesh);
  return { dissolvedVertices: new Set(vertices).size };
}

function weld(mesh, { distance = 1e-5, vertices }) {
  const d = number(distance, 0, 1000, "distance");
  if (vertices) checkVertices(mesh, vertices);
  const candidates = vertices
      ? [...new Set(vertices)]
      : mesh.vertices.map((_, i) => i),
    cell = Math.max(d, 1e-9),
    grid = new Map(),
    parent = new Map(candidates.map((i) => [i, i]));
  const find = (i) => {
    while (parent.get(i) !== i) i = parent.get(i);
    return i;
  };
  for (const i of candidates) {
    const p = mesh.vertices[i],
      key = p.map((v) => Math.floor(v / cell));
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++)
          for (const j of grid.get(`${key[0] + x},${key[1] + y},${key[2] + z}`) ?? [])
            if (Math.hypot(...sub(p, mesh.vertices[j])) <= d) {
              const a = find(i),
                b = find(j);
              if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
            }
    const k = key.join(",");
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  // Each cluster moves to its centre.
  const clusters = new Map();
  for (const i of candidates) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  }
  let merged = 0;
  const target = new Map();
  for (const [root, members] of clusters) {
    if (members.length < 2) continue;
    merged += members.length - 1;
    mesh.vertices[root] = mul(
      members.reduce((s, i) => add(s, mesh.vertices[i]), [0, 0, 0]),
      1 / members.length,
    );
    for (const i of members) target.set(i, root);
  }
  if (!merged) return { mergedVertices: 0, unchanged: true };
  const faces = [],
    seen = new Map();
  for (const f of mesh.faces) {
    const loop = [];
    for (const v of f.vertices.map((i) => target.get(i) ?? i))
      if (loop.at(-1) !== v) loop.push(v);
    while (loop.length > 1 && loop[0] === loop.at(-1)) loop.pop();
    if (loop.length < 3) continue;
    if (new Set(loop).size !== loop.length)
      fail(`Welding would pinch face ${f.id}; weld fewer vertices or a smaller distance`);
    try {
      normal(mesh.vertices, loop);
    } catch {
      continue; // Collapsed to zero area.
    }
    // Coincident faces: identical ones collapse to one; opposite ones (two surfaces
    // welded face to face) both disappear.
    const key = [...loop].sort((a, b) => a - b).join(",");
    const twin = seen.get(key);
    if (twin) {
      const same = rotationOf(twin.vertices, loop);
      if (!same) twin.removed = true;
      continue;
    }
    const face = { ...f, vertices: loop };
    seen.set(key, face);
    faces.push(face);
  }
  mesh.faces = faces.filter((f) => !f.removed);
  if (!mesh.faces.length) fail("Welding collapses the whole mesh");
  compact(mesh);
  return { mergedVertices: merged };
}
// True when b is a's cycle in the same direction.
function rotationOf(a, b) {
  const i = b.indexOf(a[0]);
  return i >= 0 && a.every((v, k) => b[(i + k) % b.length] === v);
}

// Directed boundary edges as the existing faces use them.
function boundary(mesh) {
  const directed = new Map();
  for (const f of mesh.faces)
    f.vertices.forEach((a, i) => {
      const b = f.vertices[(i + 1) % f.vertices.length];
      if (directed.has(`${b}>${a}`)) directed.delete(`${b}>${a}`);
      else directed.set(`${a}>${b}`, { a, b, face: f });
    });
  return [...directed.values()];
}
// Boundary loops in the direction the existing faces use them.
function boundaryLoops(mesh) {
  const edges = boundary(mesh),
    next = new Map();
  for (const e of edges) {
    if (next.has(e.a))
      fail(`The open boundary is pinched at vertex ${e.a}; split the mesh first`);
    next.set(e.a, e);
  }
  const loops = [],
    seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    for (let v = start; !seen.has(v); v = next.get(v)?.b) {
      if (v === undefined) fail("Open boundary does not close");
      seen.add(v);
      loop.push(next.get(v));
    }
    loops.push(loop);
  }
  return loops;
}

function fill(mesh, { edges, material }) {
  if (edges) checkEdges(mesh, edges);
  const wanted = edges ? new Set(edges) : null;
  const loops = boundaryLoops(mesh).filter(
    (loop) => !wanted || loop.some((e) => wanted.has(edgeKey(e.a, e.b))),
  );
  if (!loops.length)
    fail(wanted ? "The selected edges are not on an open boundary" : "No open boundary to fill");
  const next = nextFace(mesh),
    created = [];
  for (const loop of loops) {
    // The new face runs against its neighbours: b -> a for every boundary edge a -> b.
    const polygon = loop.map((e) => e.b).reverse(),
      paint = material ?? loop[0].face.material;
    let pieces;
    if (polygon.length <= 64 && simple(mesh.vertices, polygon)) pieces = [polygon];
    else {
      try {
        pieces = splitPolygon(mesh.vertices, polygon);
      } catch {
        fail("Cannot fill this boundary: it overlaps itself in its plane");
      }
    }
    for (const vertices of pieces) {
      const id = next();
      mesh.faces.push({ id, vertices, material: paint });
      created.push(id);
    }
  }
  return { filledLoops: loops.length, faces: created };
}

function bridge(mesh, { faces, edges }) {
  let a, b, paint;
  if (faces) {
    if (faces.length !== 2) fail("Bridge needs exactly two faces");
    const [fa, fb] = faces.map((id) => faceById(mesh, id));
    if (fa === fb) fail("Bridge needs two different faces");
    if (fa.vertices.some((v) => fb.vertices.includes(v)))
      fail("Bridge needs faces that share no vertex");
    if (fa.vertices.length !== fb.vertices.length)
      fail("Bridge needs faces with the same number of corners");
    paint = fa.material;
    mesh.faces = mesh.faces.filter((f) => f !== fa && f !== fb);
    // After removal the neighbours run each loop backwards.
    a = [...fa.vertices].reverse();
    b = [...fb.vertices].reverse();
  } else {
    if (!edges?.length) fail("Bridge needs two faces or two boundary loops");
    checkEdges(mesh, edges);
    const keys = new Set(edges),
      loops = boundaryLoops(mesh).filter((loop) =>
        loop.some((e) => keys.has(edgeKey(e.a, e.b))),
      );
    if (loops.length !== 2) fail("Select edges on exactly two open boundary loops");
    if (loops[0].length !== loops[1].length)
      fail("Bridge needs loops with the same number of corners");
    [a, b] = loops.map((loop) => loop.map((e) => e.a));
    paint = loops[0][0].face.material;
  }
  const n = a.length;
  // Pair a[i] with b[(k - i) mod n]; pick the rotation with the shortest rungs.
  let best = 0,
    bestCost = Infinity;
  for (let k = 0; k < n; k++) {
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const d = sub(mesh.vertices[a[i]], mesh.vertices[b[(((k - i) % n) + n) % n]]);
      cost += dot(d, d);
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = k;
    }
  }
  const pair = (i) => b[(((best - i) % n) + n) % n];
  const existing = new Set(meshEdges(mesh).map((e) => e.id));
  for (let i = 0; i < n; i++)
    if (existing.has(edgeKey(a[i], pair(i))))
      fail("These loops are already connected");
  const next = nextFace(mesh),
    created = [];
  for (let i = 0; i < n; i++) {
    const id = next();
    mesh.faces.push({
      id,
      vertices: [a[(i + 1) % n], a[i], pair(i), pair(i + 1)],
      material: paint,
    });
    created.push(id);
  }
  compact(mesh);
  return { faces: created };
}

function connect(mesh, { vertices }) {
  if (!vertices || vertices.length !== 2 || vertices[0] === vertices[1])
    fail("Connect needs two different vertices");
  checkVertices(mesh, vertices);
  const [a, b] = vertices;
  const face = mesh.faces.find((f) => {
    const i = f.vertices.indexOf(a),
      j = f.vertices.indexOf(b),
      n = f.vertices.length;
    return i >= 0 && j >= 0 && (i - j + n) % n !== 1 && (j - i + n) % n !== 1;
  });
  if (!face)
    fail("Pick two vertices of one face that are not already joined by an edge");
  const n = face.vertices.length,
    i = face.vertices.indexOf(a),
    j = face.vertices.indexOf(b),
    walk = (from, to) => {
      const out = [];
      for (let k = from; ; k = (k + 1) % n) {
        out.push(face.vertices[k]);
        if (k === to) return out;
      }
    };
  const first = walk(i, j),
    second = walk(j, i),
    original = normal(mesh.vertices, face.vertices);
  for (const half of [first, second])
    if (
      !simple(mesh.vertices, half) ||
      dot(normal(mesh.vertices, half), original) < 0.99
    )
      fail("The new edge would run outside the face");
  face.vertices = first;
  const id = nextFace(mesh)();
  mesh.faces.push({ id, vertices: second, material: face.material });
  return { faces: [face.id, id] };
}

function solidify(mesh, { thickness, offset = -1 }) {
  const t = number(thickness, 1e-6, 1000, "thickness"),
    o = number(offset, -1, 1, "offset");
  for (const e of meshEdges(mesh))
    if (e.sides.length > 2) fail("Solidify needs a manifold surface");
  compact(mesh);
  const count = mesh.vertices.length,
    sums = mesh.vertices.map(() => [0, 0, 0]),
    faceNormal = new Map();
  for (const f of mesh.faces) {
    const n = normal(mesh.vertices, f.vertices);
    faceNormal.set(f, n);
    f.vertices.forEach((v, i) => {
      const prev = mesh.vertices[f.vertices[(i + f.vertices.length - 1) % f.vertices.length]],
        next = mesh.vertices[f.vertices[(i + 1) % f.vertices.length]],
        p = mesh.vertices[v];
      const angle = Math.acos(
        Math.max(-1, Math.min(1, dot(unit(sub(prev, p)), unit(sub(next, p))))),
      );
      sums[v] = add(sums[v], mul(n, angle));
    });
  }
  // Even thickness: stretch each offset so every adjacent face moves by the thickness.
  const directions = sums.map((s, v) => {
    const length = Math.hypot(...s);
    if (length < 1e-12) fail(`Vertex ${v} has no direction to thicken along`);
    const n = mul(s, 1 / length);
    let least = 1;
    for (const f of mesh.faces)
      if (f.vertices.includes(v)) least = Math.min(least, dot(n, faceNormal.get(f)));
    return mul(n, 1 / Math.max(0.5, least));
  });
  const outer = (1 + o) / 2,
    inner = (1 - o) / 2,
    original = mesh.vertices;
  mesh.vertices = [
    ...original.map((p, v) => add(p, mul(directions[v], t * outer))),
    ...original.map((p, v) => sub(p, mul(directions[v], t * inner))),
  ];
  const edges = boundary({ vertices: original, faces: mesh.faces }),
    next = nextFace(mesh),
    copies = mesh.faces.map((f) => ({
      id: next(),
      vertices: [...f.vertices].reverse().map((v) => v + count),
      material: f.material,
    }));
  const sides = edges.map(({ a, b, face }) => ({
    id: next(),
    vertices: [b, a, a + count, b + count],
    material: face.material,
  }));
  mesh.faces.push(...copies, ...sides);
  return { thickness: t, sideFaces: sides.length };
}

export function editMesh(mesh, command) {
  switch (command.op) {
    case "deleteComponents":
      return deleteComponents(mesh, command);
    case "dissolve":
      return dissolve(mesh, command);
    case "weld":
      return weld(mesh, command);
    case "fill":
      return fill(mesh, command);
    case "bridge":
      return bridge(mesh, command);
    case "connect":
      return connect(mesh, command);
    case "solidify":
      return solidify(mesh, command);
  }
  fail(`Unknown mesh edit: ${command.op}`);
}

// separate: selected faces, or every loose part after the first, become new parts with
// the source's parent and transform.
export function separateParts(project, node, command, identifier) {
  if (!node.mesh) fail("Separate needs a mesh part");
  const groups = [];
  if (command.loose) {
    if (command.faces) fail("Use faces or loose, not both", "faces");
    const parent = new Map(node.mesh.faces.map((f) => [f.id, f.id])),
      owner = new Map();
    const find = (id) => {
      while (parent.get(id) !== id) id = parent.get(id);
      return id;
    };
    for (const f of node.mesh.faces)
      for (const v of f.vertices) {
        if (owner.has(v)) {
          const a = find(owner.get(v)),
            b = find(f.id);
          if (a !== b) parent.set(b, a);
        } else owner.set(v, f.id);
      }
    const parts = new Map();
    for (const f of node.mesh.faces) {
      const root = find(f.id);
      if (!parts.has(root)) parts.set(root, new Set());
      parts.get(root).add(f.id);
    }
    if (parts.size < 2) fail("This part is one connected piece");
    groups.push(...[...parts.values()].slice(1));
  } else {
    if (!command.faces?.length) fail("Separate needs faces or loose:true", "faces");
    for (const id of command.faces) faceById(node.mesh, id);
    groups.push(new Set(command.faces));
  }
  const ids = groups.map((_, i) =>
    identifier(i ? `${command.newId}-${i + 1}` : command.newId, "newId"),
  );
  for (const id of ids)
    if (project.nodes.some((n) => n.id === id)) fail(`ID already exists: ${id}`, "newId");
  const taken = new Set(groups.flatMap((g) => [...g]));
  if (taken.size === node.mesh.faces.length)
    fail("Separating every face leaves the source empty; rename or duplicate instead");
  const created = groups.map((group, i) => {
    const mesh = {
      vertices: node.mesh.vertices.map((v) => [...v]),
      faces: node.mesh.faces
        .filter((f) => group.has(f.id))
        .map((f) => ({ ...f, vertices: [...f.vertices] })),
    };
    compact(mesh);
    return {
      id: ids[i],
      name: ids[i],
      parent: node.parent,
      position: [...node.position],
      rotation: [...node.rotation],
      scale: [...node.scale],
      mesh,
    };
  });
  node.mesh.faces = node.mesh.faces.filter((f) => !taken.has(f.id));
  compact(node.mesh);
  delete node.generator;
  delete node.recipe;
  project.nodes.splice(project.nodes.indexOf(node) + 1, 0, ...created);
  return { created: ids };
}

// join: other parts' geometry moves into this part's coordinates; they are consumed.
export function joinParts(project, node, command) {
  if (!node.mesh) fail("Join needs a mesh part to receive the geometry");
  if (!Array.isArray(command.with) || !command.with.length)
    fail("join needs part IDs in with", "with");
  const tools = [...new Set(command.with)],
    local = inverse(worldMatrix(project, node.id)),
    next = nextFace(node.mesh);
  for (const id of tools) {
    const tool = project.nodes.find((n) => n.id === id);
    if (!tool?.mesh) fail(`Join needs mesh parts: ${id}`, "with");
    if (id === node.id) fail("A part cannot join itself", "with");
    for (let p = node.parent; p; p = project.nodes.find((n) => n.id === p)?.parent)
      if (p === id) fail(`A joined part cannot contain the target: ${id}`, "with");
    const mesh = structuredClone(tool.mesh);
    transformMesh(mesh, multiply(local, worldMatrix(project, id)));
    const base = node.mesh.vertices.length;
    node.mesh.vertices.push(...mesh.vertices);
    for (const f of mesh.faces)
      node.mesh.faces.push({
        id: next(),
        vertices: f.vertices.map((v) => v + base),
        material: f.material,
      });
  }
  delete node.generator;
  delete node.recipe;
  return { consumed: tools };
}
