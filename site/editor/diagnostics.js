import { triangulate, sub, cross, dot } from "./mesh.js";

// Surface diagnostics, independent of connectivity validation. Coordinates are
// normalized per mesh so millimeter assets and large props use the same tolerance.
// A shell is an edge-connected set of faces. A surface crossing itself within one shell
// is an error; separate shells that pass through each other (merged parts, joined
// pieces, a pole through a base) are a normal way to build low-poly models and only
// warn. Both have their own budget so overlapping parts never hide a real fault.
export function surfaceDiagnostics(
  mesh,
  { maxPairs = 2000000, maxIssues = 24, maxOverlaps = 24 } = {},
) {
  const lo = [0, 1, 2].map((k) => Math.min(...mesh.vertices.map((v) => v[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...mesh.vertices.map((v) => v[k])));
  const scale = Math.max(...hi.map((v, k) => v - lo[k]), 1e-12);
  const vertices = mesh.vertices.map((v) =>
    v.map((n, k) => (n - lo[k]) / scale),
  );
  // Shells first: they decide what an intersection means.
  const edges = new Map(),
    neighbors = new Map(mesh.faces.map((f) => [f.id, new Set()]));
  for (const f of mesh.faces)
    f.vertices.forEach((a, i) => {
      const b = f.vertices[(i + 1) % f.vertices.length],
        key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const es = edges.get(key) ?? [];
      es.push({ face: f.id, a, b });
      edges.set(key, es);
    });
  for (const es of edges.values())
    for (const a of es)
      for (const b of es) if (a !== b) neighbors.get(a.face).add(b.face);
  const shellOf = new Map(),
    shells = [];
  for (const face of mesh.faces) {
    if (shellOf.has(face.id)) continue;
    const shell = new Set(),
      todo = [face.id];
    while (todo.length) {
      const id = todo.pop();
      if (shell.has(id)) continue;
      shell.add(id);
      shellOf.set(id, shells.length);
      todo.push(...neighbors.get(id));
    }
    shells.push(shell);
  }
  // A face far smaller than the mesh can vanish in normalized coordinates; it cannot
  // cross anything, and project validation already judged it.
  const corners = (f) => {
    try {
      return triangulate(vertices, f.vertices);
    } catch {
      return [];
    }
  };
  const triangles = mesh.faces.flatMap((f) =>
    corners(f).map((ids) => {
      const p = ids.map((i) => vertices[i]);
      return {
        face: f.id,
        shell: shellOf.get(f.id),
        ids,
        p,
        min: [0, 1, 2].map((k) => Math.min(...p.map((v) => v[k]))),
        max: [0, 1, 2].map((k) => Math.max(...p.map((v) => v[k]))),
      };
    }),
  );
  const eps = 1e-8,
    issues = [],
    seen = new Set();
  let faults = 0,
    overlaps = 0;
  const add = (code, faces, extra = {}) => {
    const key = code + ":" + [...faces].sort().join(",");
    if (seen.has(key)) return;
    if (code === "shell-overlap" ? overlaps >= maxOverlaps : faults >= maxIssues)
      return;
    seen.add(key);
    if (code === "shell-overlap") overlaps++;
    else faults++;
    issues.push({ code, face: faces[0], faces, ...extra });
  };
  function hit(a, b, t) {
    const d = sub(b, a),
      e = sub(t[1], t[0]),
      f = sub(t[2], t[0]),
      h = cross(d, f),
      det = dot(e, h);
    if (Math.abs(det) < 1e-12) return null;
    const s = sub(a, t[0]),
      u = dot(s, h) / det,
      q = cross(s, e),
      v = dot(d, q) / det,
      r = dot(f, q) / det;
    if (u < -eps || v < -eps || u + v > 1 + eps || r <= eps || r >= 1 - eps)
      return null;
    return a.map((n, k) => n + r * d[k]);
  }
  // Coplanar area overlap, including duplicate faces. Shared boundaries are legal.
  function coplanar(a, b) {
    const n = cross(sub(a[1], a[0]), sub(a[2], a[0])),
      len = Math.hypot(...n);
    if (!len || b.some((p) => Math.abs(dot(n, sub(p, a[0]))) / len > eps))
      return false;
    const k = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs)));
    const p = a.map((v) => v.filter((_, i) => i !== k)),
      q = b.map((v) => v.filter((_, i) => i !== k));
    // Separating axis test with positive overlap on every axis.
    for (const t of [p, q])
      for (let i = 0; i < 3; i++) {
        const e = [t[(i + 1) % 3][0] - t[i][0], t[(i + 1) % 3][1] - t[i][1]],
          axis = [-e[1], e[0]],
          l = Math.hypot(...axis);
        const x = p.map((v) => (v[0] * axis[0] + v[1] * axis[1]) / l),
          y = q.map((v) => (v[0] * axis[0] + v[1] * axis[1]) / l);
        if (
          Math.min(Math.max(...x), Math.max(...y)) -
            Math.max(Math.min(...x), Math.min(...y)) <=
          eps
        )
          return false;
      }
    return true;
  }
  const sorted = [...triangles].sort((a, b) => a.min[0] - b.min[0]);
  let pairs = 0,
    crossPairs = 0,
    complete = true,
    overlapComplete = true;
  outer: for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i],
        b = sorted[j];
      if (b.min[0] > a.max[0] + eps) break;
      if (
        a.face === b.face ||
        [1, 2].some(
          (k) => a.max[k] < b.min[k] - eps || b.max[k] < a.min[k] - eps,
        )
      )
        continue;
      const across = a.shell !== b.shell;
      if (across) {
        // Overlapping parts only warn: stop looking once enough are reported.
        if (overlaps >= maxOverlaps) continue;
        if (++crossPairs > maxPairs) {
          overlapComplete = false;
          continue;
        }
      } else if (++pairs > maxPairs || faults >= maxIssues) {
        complete = faults >= maxIssues;
        if (!complete) break outer;
        continue;
      }
      let point = null;
      for (const [s, t] of [
        [a, b],
        [b, a],
      ])
        for (let k = 0; k < 3 && !point; k++) {
          const found = hit(s.p[k], s.p[(k + 1) % 3], t.p);
          // Touches at shared vertices/edges are normal manifold adjacency.
          if (
            found &&
            !a.ids
              .filter((id) => b.ids.includes(id))
              .some((id) => Math.hypot(...sub(found, vertices[id])) < eps)
          ) {
            const shared = a.ids.filter((id) => b.ids.includes(id));
            if (shared.length === 2) {
              const u = vertices[shared[0]],
                v = vertices[shared[1]];
              if (
                Math.hypot(...cross(sub(found, u), sub(v, u))) /
                  Math.hypot(...sub(v, u)) <
                eps
              )
                continue;
            }
            point = found;
          }
        }
      if (point || coplanar(a.p, b.p))
        add(
          across ? "shell-overlap" : "self-intersection",
          [a.face, b.face],
          point ? { point: point.map((n, k) => lo[k] + n * scale) } : {},
        );
    }
  // Connected closed shells: signed volume detects inward orientation. A nested
  // cavity may intentionally be inward, so report rather than silently flip it.
  const volumes = shells.map(() => 0),
    open = new Set();
  for (const es of edges.values())
    if (es.length !== 2 || es[0].a !== es[1].b) open.add(shellOf.get(es[0].face));
  for (const t of triangles)
    volumes[t.shell] += dot(t.p[0], cross(t.p[1], t.p[2])) / 6;
  shells.forEach((shell, index) => {
    if (open.has(index)) return;
    if (volumes[index] < -1e-12)
      add("inward-shell", [...shell], {
        signedVolume: volumes[index] * scale ** 3,
      });
    else if (Math.abs(volumes[index]) < 1e-12) add("zero-volume", [...shell]);
  });
  if (!complete)
    issues.push({
      code: "surface-check-incomplete",
      checkedPairs: pairs,
      limit: maxPairs,
    });
  return { issues, complete, overlapComplete, checkedPairs: pairs };
}
