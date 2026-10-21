// Read-only world-space surface inspection. Uses the same polygon triangulation and
// affine transforms as the editor; no viewport selection or document mutation.
import { Vector3, Triangle, Ray, Matrix4 } from "/runtime/three.js";
import { triangulate, ModelError } from "./mesh.js";
import { worldMatrix, point, inverse, nodeInfo, determinant } from "./spatial.js";
import { connectivityToken, topologyToken } from "./components.js";
import { describeChanges } from "./changes.js";
import { same, evaluateCommands } from "./document.js";
import { isDense, denseCounts } from "./dense.js";

const vector = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const fail = (message) => { throw new ModelError(message, "schema"); };
export function surfaceQuery(project, options = {}) {
  const { ids, at, ray, observation, pixel, path, spacing = 0.01, tolerance = 0.002, offset = 0 } = options;
  if (ids && (!ids.length || ids.some(id => !project.nodes.some(n => n.id === id)))) fail("Unknown target IDs");
  const selected = new Set(ids ?? project.nodes.map(n => n.id));
  for (let changed = true; changed;) {
    changed = false;
    for (const n of project.nodes) if (selected.has(n.parent) && !selected.has(n.id)) { selected.add(n.id); changed = true; }
  }
  const triangles = [];
  for (const node of project.nodes.filter(n => selected.has(n.id) && n.mesh)) {
    if (isDense(node.mesh) && denseCounts(node.mesh).triangles > 100000)
      fail("Surface query exceeds 100000 triangles; isolate a smaller target");
    const matrix = worldMatrix(project, node.id);
    const vertices = node.mesh.vertices.map(v => new Vector3(...point(matrix, v)));
    for (const face of node.mesh.faces) {
      for (const indices of triangulate(node.mesh.vertices, face.vertices))
        triangles.push({ node: node.id, face: face.id, indices, matrix, triangle: new Triangle(...indices.map(i => vertices[i])) });
      if (triangles.length > 100000) fail("Surface query exceeds 100000 triangles; isolate target parts");
    }
  }
  let maxDistance = Infinity, checks = 0;
  const nearest = (p, direction) => {
    const origin = new Vector3(...p), hitRay = direction && new Ray(origin, new Vector3(...direction).normalize());
    let best = null;
    for (const t of triangles) {
      if (++checks > 2000000) fail("Surface query exceeds two million triangle tests; isolate parts or increase spacing");
      const hit = hitRay ? hitRay.intersectTriangle(t.triangle.a, t.triangle.b, t.triangle.c, false, new Vector3()) : t.triangle.closestPointToPoint(origin, new Vector3());
      if (!hit) continue;
      const distance = hit.distanceTo(origin);
      if (distance > maxDistance) continue;
      if (best && distance >= best.distance) continue;
      const normal = t.triangle.getNormal(new Vector3());
      if (determinant(t.matrix) < 0) normal.negate();
      best = { node: t.node, face: t.face, vertices: t.indices, point: hit.toArray(),
        localPoint: point(inverse(t.matrix), hit.toArray()), normal: normal.toArray(), distance,
        normalDistance: origin.clone().sub(hit).dot(normal),
        offsetPoint: hit.clone().addScaledVector(normal, offset).toArray() };
    }
    return best ?? { hit: false, reason: triangles.length ? "ray-missed-target-surfaces" : "no-target-meshes" };
  };
  if (![spacing, tolerance, offset].every(Number.isFinite) || spacing <= 0 || tolerance < 0) fail("Invalid sampling distance");
  if (path) {
    if (path.length < 2 || !path.every(vector)) fail("path needs at least two world-space points");
    const samples = [];
    for (let segment = 0; segment < path.length - 1; segment++) {
      const a = new Vector3(...path[segment]), b = new Vector3(...path[segment + 1]);
      const steps = Math.max(1, Math.ceil(a.distanceTo(b) / spacing));
      if (samples.length + steps + 1 > 4096) fail("Contact sampling exceeds 4096 points; increase spacing");
      for (let i = segment ? 1 : 0; i <= steps; i++) {
        const source = a.clone().lerp(b, i / steps).toArray();
        samples.push({ segment, t: i / steps, source, ...nearest(source) });
      }
    }
    const gaps = samples.filter(s => s.distance === undefined || s.distance > tolerance);
    return { space: "world", units: "meters", kind: "sampled-contact", spacing, tolerance, samples,
      maxDistance: samples.some(s => s.distance === undefined) ? null : Math.max(...samples.map(s => s.distance)), gaps: gaps.length,
      ok: gaps.length === 0, coverage: { pathSegments: path.length - 1, samples: samples.length,
        continuousProof: false, penetrationVolume: false, minimumWallThickness: false } };
  }
  let origin = at, direction;
  if (observation || pixel) {
    const c = observation?.camera, width = observation?.width, height = observation?.height;
    const matrix16 = m => Array.isArray(m) && m.length === 16 && m.every(Number.isFinite);
    if (!matrix16(c?.worldMatrix) || !matrix16(c?.projectionMatrix) || !Array.isArray(pixel) || pixel.length !== 2 ||
        !pixel.every(Number.isFinite) || !(width > 0 && height > 0)) fail("Pixel query needs observation camera matrices, width and height");
    if (pixel[0] < 0 || pixel[1] < 0 || pixel[0] >= width || pixel[1] >= height)
      return { hit: false, reason: "pixel-outside-image", space: "world" };
    const unproject = new Matrix4().fromArray(c.worldMatrix).multiply(new Matrix4().fromArray(c.projectionMatrix).invert());
    const x = 2 * (pixel[0] + 0.5) / width - 1, y = 1 - 2 * (pixel[1] + 0.5) / height;
    const near = new Vector3(x, y, -1).applyMatrix4(unproject), far = new Vector3(x, y, 1).applyMatrix4(unproject);
    maxDistance = near.distanceTo(far);
    origin = near.toArray(); direction = far.sub(near).normalize().toArray();
  } else if (ray) { origin = ray.origin; direction = ray.direction; }
  if (!vector(origin) || (direction && (!vector(direction) || Math.hypot(...direction) < 1e-12))) fail("Expected world-space at or ray");
  return { space: "world", units: "meters", source: origin,
    ...(direction ? { rayDirection: direction } : {}), ...nearest(origin, direction) };
}

export function scopeReport(before, after, protectedIds = [], allowed, protectedVertices = {}) {
  if (protectedIds.some(id => !before.nodes.some(n => n.id === id)))
    fail("Protected part must exist in the baseline");
  const diff = describeChanges(before, after);
  const ids = new Set([...before.nodes, ...after.nodes].map(n => n.id));
  const changed = [...ids].filter(id => {
    const a = before.nodes.find(n => n.id === id), b = after.nodes.find(n => n.id === id);
    return !same(a, b) || (a && b && !same(worldMatrix(before, id), worldMatrix(after, id)));
  });
  const protectedSet = new Set(protectedIds);
  for (const p of [before, after]) for (let more = true; more;) {
    more = false;
    for (const n of p.nodes) if (protectedSet.has(n.parent) && !protectedSet.has(n.id)) { protectedSet.add(n.id); more = true; }
  }
  const affected = new Set([...changed, ...diff.affected]);
  const violations = [...protectedSet].filter(id => affected.has(id));
  const scopeIssues = [];
  const parameterChanges = [];
  if (!protectedVertices || typeof protectedVertices !== "object" || Array.isArray(protectedVertices))
    fail("protectedVertices must map node IDs to vertex indices");
  for (const [id, indices] of Object.entries(protectedVertices)) {
    const node = before.nodes.find(n => n.id === id), next = after.nodes.find(n => n.id === id);
    if (!node?.mesh || !Array.isArray(indices) || indices.some(i => !Number.isSafeInteger(i) || i < 0 || i >= node.mesh.vertices.length))
      fail(`Invalid protected vertex region for ${id}`);
    if (!next?.mesh || connectivityToken(node.mesh) !== connectivityToken(next.mesh)) {
      scopeIssues.push({ code: "protected-topology", node: id, vertices: indices });
      continue;
    }
    const a = worldMatrix(before, id), b = worldMatrix(after, id);
    const changed = indices.filter(i => !same(point(a, node.mesh.vertices[i]), point(b, next.mesh.vertices[i])));
    if (changed.length) scopeIssues.push({ code: "protected-vertices", node: id, vertices: changed, space: "world" });
  }
  if (allowed !== undefined) {
    if (!allowed || typeof allowed !== "object" || Array.isArray(allowed)) fail("allowed must be an object");
    for (const key of Object.keys(allowed))
      if (!["nodes", "followers", "vertices", "parameters", "assemblyParameters", "characterValues", "projectFields"].includes(key)) fail(`Unknown allowed field: ${key}`);
    for (const key of ["nodes", "followers", "projectFields"])
      if (allowed[key] !== undefined && (!Array.isArray(allowed[key]) || allowed[key].some(x => typeof x !== "string")))
        fail(`allowed.${key} must be an array of strings`);
    const grants = new Set([...(allowed.nodes ?? []), ...(allowed.followers ?? [])]);
    const parameters = allowed.parameters ?? {};
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters))
      fail("allowed.parameters must map recipe node IDs to parameter names");
    const commands = [];
    const constrainedFields = new Set();
    const assemblyParameters = allowed.assemblyParameters ?? {};
    if (!assemblyParameters || typeof assemblyParameters !== "object" || Array.isArray(assemblyParameters))
      fail("allowed.assemblyParameters must map assembly roots to parameter names");
    for (const [root, names] of Object.entries(assemblyParameters)) {
      const assembly = before.assemblies?.find(a => a.root === root);
      const next = after.assemblies?.find(a => a.root === root);
      if (!assembly || !Array.isArray(names) || !names.length || names.length > 128 ||
          new Set(names).size !== names.length || names.some(name => typeof name !== "string" ||
            !assembly.parameters[name] || assembly.parameters[name].expression))
        fail(`Invalid editable assembly parameter grant for ${root}`);
      const values = {};
      for (const name of names) {
        if (!next?.parameters[name]) {
          scopeIssues.push({ code: "scope-parameter-missing", root, parameter: name });
          continue;
        }
        const value = next.parameters[name].value;
        if (!same(value, assembly.parameters[name].value)) {
          values[name] = value;
          parameterChanges.push({ root, parameter: name, before: assembly.parameters[name].value, after: value });
        }
      }
      if (Object.keys(values).length)
        commands.push({ op: "assemblyParameters", root, values, ...(assembly.source ? { override: true } : {}) });
      constrainedFields.add("assemblies");
    }
    const controlNames = allowed.characterValues ?? [];
    if (!Array.isArray(controlNames) || controlNames.length > 64 || new Set(controlNames).size !== controlNames.length ||
        controlNames.some(id => typeof id !== "string" || !before.character?.controls.some(c => c.id === id)))
      fail("allowed.characterValues must name existing character controls");
    if (controlNames.length) {
      const values = {};
      for (const id of controlNames) {
        const value = after.character?.values[id] ?? 0;
        const previous = before.character.values[id] ?? 0;
        if (!same(after.character?.values[id], before.character.values[id])) values[id] = value;
        if (!same(value, previous)) parameterChanges.push({ control: id, before: previous, after: value });
      }
      if (Object.keys(values).length || (before.character.pose && !after.character?.pose))
        commands.push({ op: "characterValues", values });
      constrainedFields.add("character");
    }
    for (const [id, names] of Object.entries(parameters)) {
      const node = before.nodes.find(n => n.id === id), next = after.nodes.find(n => n.id === id);
      if (!node?.recipe || !Array.isArray(names) || !names.length || names.length > 128 ||
          new Set(names).size !== names.length || names.some(name => typeof name !== "string" ||
            !node.recipe.parameters[name] || node.recipe.parameters[name].expression))
        fail(`Invalid editable recipe parameter grant for ${id}`);
      grants.add(id);
      const values = {};
      for (const name of names) {
        if (!next?.recipe?.parameters[name]) {
          scopeIssues.push({ code: "scope-parameter-missing", node: id, parameter: name });
          continue;
        }
        values[name] = next.recipe.parameters[name].value;
        if (!same(values[name], node.recipe.parameters[name].value))
          parameterChanges.push({ node: id, parameter: name, before: node.recipe.parameters[name].value, after: values[name] });
      }
      commands.push({ op: "recipeParameters", id, values });
    }
    if (commands.length || constrainedFields.size) {
      try {
        const predicted = commands.length ? evaluateCommands(before, commands) : before;
        for (const id of Object.keys(parameters)) {
          const expected = predicted.nodes.find(n => n.id === id), actual = after.nodes.find(n => n.id === id);
          if (!same(expected, actual) || (actual && !same(worldMatrix(predicted, id), worldMatrix(after, id))))
            scopeIssues.push({ code: "scope-parameter-output", node: id,
              message: "Candidate differs from changing only the granted recipe values; definitions, transforms and other fields must stay unchanged" });
        }
        for (const field of constrainedFields)
          if (!same(predicted[field], after[field]))
            scopeIssues.push({ code: "scope-parameter-definition", path: field,
              message: "Only granted values may change; bindings, rest poses, clips and other definitions must stay unchanged" });
        for (const node of predicted.nodes) {
          const original = before.nodes.find(n => n.id === node.id);
          const follower = (allowed.followers ?? []).includes(node.id);
          if (!follower && (!constrainedFields.size ||
              (same(original, node) && same(worldMatrix(before, node.id), worldMatrix(predicted, node.id))))) continue;
          const actual = after.nodes.find(n => n.id === node.id);
          if (!same(node, actual) || (actual && !same(worldMatrix(predicted, node.id), worldMatrix(after, node.id))))
            scopeIssues.push({ code: "scope-parameter-output", node: node.id,
              message: "Driven output differs from evaluating only the granted parameter/control values" });
        }
      } catch (e) {
        scopeIssues.push({ code: "scope-parameter-evaluation", message: e.message, path: e.path });
      }
    }
    const regions = allowed.vertices ?? {};
    if (!regions || typeof regions !== "object" || Array.isArray(regions)) fail("allowed.vertices must map node IDs to vertex indices");
    for (const [id, indices] of Object.entries(regions)) {
      const node = before.nodes.find(n => n.id === id);
      if (!node?.mesh || !Array.isArray(indices) || indices.some(i => !Number.isSafeInteger(i) || i < 0 || i >= node.mesh.vertices.length))
        fail(`Invalid vertex region for ${id}`);
      grants.add(id);
      const next = after.nodes.find(n => n.id === id);
      if (!next?.mesh || connectivityToken(node.mesh) !== connectivityToken(next.mesh)) {
        scopeIssues.push({ code: "scope-topology", node: id, space: "local" });
        continue;
      }
      const selected = new Set(indices);
      const outside = node.mesh.vertices.flatMap((v, i) =>
        !selected.has(i) && !same(v, next.mesh.vertices[i]) ? [i] : []);
      if (outside.length) scopeIssues.push({ code: "scope-vertices", node: id, vertices: outside, space: "local" });
      const withoutVertices = n => ({ ...n, mesh: { ...n.mesh, vertices: [] } });
      if (!same(withoutVertices(node), withoutVertices(next)) ||
          !same(worldMatrix(before, id), worldMatrix(after, id)))
        scopeIssues.push({ code: "scope-node-fields", node: id, space: "world" });
    }
    for (const id of affected)
      if (!grants.has(id)) scopeIssues.push({ code: "scope-node", node: id });
    const fields = new Set(allowed.projectFields ?? []);
    for (const field of constrainedFields) fields.add(field);
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      if (key !== "nodes" && !fields.has(key) && !same(before[key], after[key]))
        scopeIssues.push({ code: "scope-project-field", path: key });
  }
  return { ...diff, changed, protectedIds, protectedVertices, violations, scopeIssues, parameterChanges, allowed: allowed ?? null,
    ok: !violations.length && !scopeIssues.length,
    nodes: changed.map(id => {
      const a = before.nodes.find(n => n.id === id), b = after.nodes.find(n => n.id === id);
      const token = n => n?.mesh ? connectivityToken(n.mesh) : null;
      const topologyChanged = !a || !b || token(a) !== token(b);
      return { id, topologyChanged, geometryChanged: topologyToken(a?.mesh) !== topologyToken(b?.mesh),
        invalidatesPreviousReferences: topologyToken(a?.mesh) !== topologyToken(b?.mesh),
        previousReferenceToken: topologyToken(a?.mesh), referenceToken: topologyToken(b?.mesh),
        beforeBounds: a ? nodeInfo(before, id, { components: false }).bounds : null,
        afterBounds: b ? nodeInfo(after, id, { components: false }).bounds : null };
    }) };
}
