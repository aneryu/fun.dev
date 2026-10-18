import { ModelError, normal, triangulate, sub, cross } from "./mesh.js";
import { meshEdges, edgeKey } from "./topology.js";
import { worldMatrix, point } from "./spatial.js";

export function topologyToken(mesh) {
  if (!mesh) return null;
  let a = 2166136261,
    b = 5381;
  const value = JSON.stringify([
    mesh.vertices,
    mesh.faces.map((f) => [f.id, f.vertices]),
  ]);
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ value.charCodeAt(i);
  }
  return `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
}
// A material binding may survive coordinate edits, but never a new segmentation.
export const connectivityToken = (mesh) =>
  topologyToken({ vertices: mesh.vertices.length, faces: mesh.faces });
export const componentRef = (
  node,
  kind,
  id,
  topology = topologyToken(node.mesh),
) => ({ node: node.id, kind, id, topology });
export function queryComponents(
  project,
  {
    id,
    kind = "faces",
    space = "world",
    normal: direction,
    normalTolerance = 0.01,
    at,
    boundary,
    crease,
    minLength = 0,
    maxLength = Infinity,
    largest = false,
    adjacentTo,
    loopFrom,
    limit = 1000,
    offset = 0,
    topology,
  } = {},
  { complete = false } = {},
) {
  const node = project.nodes.find((n) => n.id === id);
  if (!node?.mesh) throw new ModelError("Query needs a mesh", "invalid", "id");
  if (
    !["faces", "edges", "vertices"].includes(kind) ||
    !["local", "world"].includes(space)
  )
    throw new ModelError("Unknown query kind or space");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50000)
    throw new ModelError("Query limit must be 1–50000");
  if (!Number.isInteger(offset) || offset < 0 || offset > 200000)
    throw new ModelError("Query offset must be 0–200000");
  const m = worldMatrix(project, id),
    vertices = node.mesh.vertices.map((v) =>
      space === "world" ? point(m, v) : v,
    ),
    token = topologyToken(node.mesh);
  if (
    (topology && topology !== token) ||
    (!complete && offset > 0 && !topology)
  )
    throw new ModelError(
      "Pagination needs the current topology token; restart this query",
      "stale_component",
    );
  const ref = (id) => ({ node: node.id, kind, id, topology: token }),
    center = (vs) =>
      [0, 1, 2].map((k) => vs.reduce((s, v) => s + v[k], 0) / vs.length);
  const faces = node.mesh.faces.map((f) => ({
    id: f.id,
    ref: ref(f.id),
    center: center(f.vertices.map((i) => vertices[i])),
    normal: normal(vertices, f.vertices),
    area: triangulate(vertices, f.vertices).reduce(
      (s, [a, b, c]) =>
        s +
        Math.hypot(
          ...cross(
            sub(vertices[b], vertices[a]),
            sub(vertices[c], vertices[a]),
          ),
        ) /
          2,
      0,
    ),
    material: f.material,
  }));
  let values =
    kind === "faces"
      ? faces
      : kind === "vertices"
        ? vertices.map((v, i) => ({ id: i, ref: ref(i), center: v }))
        : meshEdges(node.mesh).map((e) => {
            const ends = e.vertices.map((i) => vertices[i]),
              ns = e.sides.map(
                (s) => faces.find((f) => f.id === s.face)?.normal,
              );
            return {
              id: e.id,
              ref: ref(e.id),
              center: center(ends),
              endpoints: ends,
              length: Math.hypot(...sub(...ends)),
              faces: e.sides.map((s) => s.face),
              angle:
                ns.length === 2
                  ? (Math.acos(
                      Math.max(
                        -1,
                        Math.min(
                          1,
                          ns[0].reduce((s, v, i) => s + v * ns[1][i], 0),
                        ),
                      ),
                    ) *
                      180) /
                    Math.PI
                  : null,
            };
          });
  if (direction) {
    if (kind !== "faces" || direction.length !== 3 || !Math.hypot(...direction))
      throw new ModelError("Normal query needs faces and a nonzero direction");
    const len = Math.hypot(...direction);
    values = values.filter(
      (v) =>
        v.normal.reduce((s, n, i) => s + (n * direction[i]) / len, 0) >=
        1 - normalTolerance,
    );
  }
  if (at) {
    const k = ["x", "y", "z"].indexOf(at.axis);
    if (k < 0 || !Number.isFinite(at.value))
      throw new ModelError("Invalid query plane");
    values = values.filter(
      (v) => Math.abs(v.center[k] - at.value) <= (at.tolerance ?? 1e-6),
    );
  }
  if (boundary) {
    const k = ["x", "y", "z"].indexOf(boundary.axis);
    if (k < 0 || !["min", "max"].includes(boundary.side))
      throw new ModelError("Invalid boundary plane");
    const value = Math[boundary.side](...vertices.map((v) => v[k]));
    values = values.filter((v) => {
      const points =
        kind === "edges"
          ? v.endpoints
          : kind === "faces"
            ? node.mesh.faces
                .find((f) => f.id === v.id)
                .vertices.map((i) => vertices[i])
            : [v.center];
      return points.every(
        (p) => Math.abs(p[k] - value) <= (boundary.tolerance ?? 1e-6),
      );
    });
  }
  if (kind === "edges")
    values = values.filter(
      (v) =>
        v.length >= minLength &&
        v.length <= maxLength &&
        (crease === undefined || (v.angle !== null && v.angle >= crease)),
    );
  if (adjacentTo) {
    const source = new Set(adjacentTo),
      edges = meshEdges(node.mesh);
    if ([...source].some((id) => !node.mesh.faces.some((f) => f.id === id)))
      throw new ModelError("Unknown adjacent face");
    const neighborFaces = new Set(
      edges
        .filter((e) => e.sides.some((s) => source.has(s.face)))
        .flatMap((e) => e.sides.map((s) => s.face)),
    );
    values = values.filter((v) =>
      kind === "faces"
        ? neighborFaces.has(v.id) && !source.has(v.id)
        : kind === "edges"
          ? v.faces.some((id) => source.has(id))
          : node.mesh.faces.some(
              (f) => source.has(f.id) && f.vertices.includes(v.id),
            ),
    );
  }
  if (loopFrom) {
    if (kind !== "edges") throw new ModelError("loopFrom queries edges only");
    if (
      typeof loopFrom !== "object" ||
      loopFrom.node !== id ||
      loopFrom.topology !== token
    )
      throw new ModelError(
        "Loop query needs a current edge reference",
        "stale_component",
      );
    const edges = meshEdges(node.mesh),
      byEdge = new Map(edges.map((e) => [e.id, e])),
      ring = new Set(),
      todo = [loopFrom.id];
    while (todo.length) {
      const key = todo.pop();
      if (ring.has(key)) continue;
      const e = byEdge.get(key);
      if (!e) throw new ModelError("Unknown ring edge");
      ring.add(key);
      for (const side of e.sides) {
        const face = node.mesh.faces.find((f) => f.id === side.face);
        if (face.vertices.length === 4)
          todo.push(
            edgeKey(
              face.vertices[(side.index + 2) % 4],
              face.vertices[(side.index + 3) % 4],
            ),
          );
      }
    }
    values = values.filter((v) => ring.has(v.id));
  }
  if (largest && kind === "faces")
    values = values.sort((a, b) => b.area - a.area).slice(0, 1);
  return {
    node: id,
    kind,
    topology: token,
    total: values.length,
    offset: complete ? 0 : offset,
    nextOffset:
      !complete && offset + limit < values.length ? offset + limit : null,
    truncated: !complete && (offset > 0 || values.length > limit),
    items: complete ? values : values.slice(offset, offset + limit),
  };
}
export function resolveComponents(
  project,
  input,
  { strict = false, selectionOnly = false } = {},
) {
  const c = structuredClone(input),
    node = project.nodes.find((n) => n.id === c.id);
  const allowed =
    {
      bevel: ["edges"],
      inset: ["faces"],
      extrude: ["faces"],
      paint: ["faces"],
      loopCut: ["edges"],
      vertices: ["vertices"],
      transform: ["faces", "edges", "vertices"],
    }[c.op] ?? [];
  const requireKind = (kind) => {
    if (selectionOnly) return;
    if (!allowed.includes(kind))
      throw new ModelError(
        `${c.op} does not accept ${kind}; expected ${allowed.join(" or ") || "no components"}`,
        "selection",
        "select.kind",
      );
  };
  if (c.select) {
    requireKind(c.select.kind ?? "faces");
    if (
      ["faces", "face", "edges", "edge", "vertices"].some(
        (k) => c[k] !== undefined,
      )
    )
      throw new ModelError(
        "Use a selector or explicit components, not both",
        "selection",
      );
    const result = queryComponents(project, { ...c.select, id: c.id });
    if (!result.items.length || result.truncated)
      throw new ModelError(
        "Selection is empty or truncated",
        "selection",
        `nodes.${c.id}`,
      );
    c[result.kind] = result.items.map((v) => v.ref);
    delete c.select;
  }
  const fields = ["faces", "face", "edges", "edge", "vertices"];
  for (const field of fields)
    if (c[field] !== undefined) {
      const kind = field.startsWith("face")
        ? "faces"
        : field.startsWith("edge")
          ? "edges"
          : "vertices";
      requireKind(kind);
      const values = Array.isArray(c[field]) ? c[field] : [c[field]],
        token = topologyToken(node?.mesh);
      if (!values.length && !selectionOnly)
        throw new ModelError(
          "Explicit component selection is empty",
          "selection",
        );
      const resolved = values.map((ref) => {
        const supplied =
          typeof ref === "object" && ref !== null ? ref.topology : c.topology;
        if (
          (strict && !supplied) ||
          (supplied && supplied !== token) ||
          (typeof ref === "object" && (ref.node !== c.id || ref.kind !== kind))
        )
          throw new ModelError(
            "Component reference expired or has no topology token; query the mesh again",
            "stale_component",
            `nodes.${c.id}.${field}`,
          );
        return typeof ref === "object" ? ref.id : ref;
      });
      c[field] = Array.isArray(c[field]) ? resolved : resolved[0];
    }
  if (c.op === "vertices" && c.changes) {
    const token = topologyToken(node?.mesh);
    if ((strict && !c.topology) || (c.topology && c.topology !== token))
      throw new ModelError(
        "Vertex edits need the current topology token",
        "stale_component",
        `nodes.${c.id}.vertices`,
      );
  }
  return c;
}
