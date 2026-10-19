// Scene data of a loaded tile (docs/worlds.md): the markers, zones and paths a game reads,
// each with its tags and the game's own parameters, in the tile's space. Behaviour stays in
// the game; this only answers where things are. No Three.js needed: positions are arrays.
//
//   const data = worldData(tile);                 // tile = await fun3d.load(bytes, { resolve })
//   for (const m of data.markers("spawn")) …      // { id, tags, params, position, rotation, node }
//   data.zone("safe_1").contains([x, y, z]);
//   const lap = data.path("lap"); lap.at(0.5); lap.nearest(p); lap.length

import { evaluateScatter } from "./scatter.js";
import { evaluateAssembly } from "./assemble.js";
import { evaluateLots } from "./lots.js";
import { navPath, walkableAt } from "./nav.js";
import { heightAt, surfaceAt } from "./terrain.js";
import { createHeap, cellAt, gridHeightAt, gridPath } from "./grid.js";

const ZONES = "fun3d.zones", PATHS = "fun3d.paths", PARAMS = "fun3d.params", RULES = "fun3d.rules";

function polygonContains(polygon, x, z) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// p rotated by the inverse of the unit quaternion q.
function unrotate(p, q) {
  const [x, y, z] = p, [qx, qy, qz, qw] = [-q[0], -q[1], -q[2], q[3]];
  const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
}

function zoneOf(z) {
  const shape = z.shape ?? {};
  let contains;
  if (shape.polygon) {
    const [y0, y1] = shape.y ?? [-Infinity, Infinity];
    contains = (p) => p[1] >= y0 && p[1] <= y1 && polygonContains(shape.polygon, p[0], p[2]);
  } else if (shape.box) {
    const { center = [0, 0, 0], halfExtents = [0, 0, 0], rotation = null } = shape.box;
    contains = (p) => {
      let d = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
      if (rotation) d = unrotate(d, rotation);
      return Math.abs(d[0]) <= halfExtents[0] && Math.abs(d[1]) <= halfExtents[1] && Math.abs(d[2]) <= halfExtents[2];
    };
  } else if (shape.sphere) {
    const { center = [0, 0, 0], radius = 0 } = shape.sphere;
    contains = (p) => Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) <= radius;
  } else contains = () => false;
  return { id: z.id, tags: [...(z.tags ?? [])], params: z.params ?? {}, shape, contains };
}

function pathOf(edge, points, profile = null) {
  const list = edge.points.map((i) => [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]]);
  if (edge.closed && list.length > 1) list.push([...list[0]]);
  const cumulative = [0];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    cumulative.push(cumulative[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const length = cumulative[cumulative.length - 1];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const path = {
    id: edge.id, kind: edge.kind ?? "data", tags: [...(edge.tags ?? [])], params: edge.params ?? {}, closed: !!edge.closed, points: list.map((p) => [...p]), length,
    profile, lanes: edge.lanes ?? profile?.lanes ?? null, width: profile?.width ?? null, oneway: !!edge.oneway, speed: edge.speed ?? null,
    /** The frame at a fraction of the length: position, tangent, right (horizontal) and up. */
    frame(t) {
      const { position, direction, segment } = path.at(t);
      const h = Math.hypot(direction[0], direction[2]) || 1, tangent = [direction[0] / h, 0, direction[2] / h];
      return { position, tangent, right: [-tangent[2], 0, tangent[0]], up: [0, 1, 0], segment };
    },
    /** The point at a fraction of the length (0–1), and the segment's direction. */
    at(t) {
      const target = Math.min(1, Math.max(0, t)) * length;
      for (let i = 1; i < list.length; i++)
        if (target <= cumulative[i] || i === list.length - 1) {
          const span = cumulative[i] - cumulative[i - 1] || 1, a = list[i - 1], b = list[i];
          const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], n = Math.hypot(...d) || 1;
          return { position: lerp(a, b, (target - cumulative[i - 1]) / span), direction: d.map((v) => v / n), segment: i - 1 };
        }
      return { position: [...list[0]], direction: [0, 0, 1], segment: 0 };
    },
    /** The closest point of the path to p: its position, fraction t, distance and segment. */
    nearest(p) {
      let best = { distance: Infinity, position: [...list[0]], t: 0, segment: 0 };
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i], d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        const u = l2 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / l2)) : 0;
        const q = lerp(a, b, u), distance = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        if (distance < best.distance) best = { distance, position: q, t: length ? (cumulative[i - 1] + u * (cumulative[i] - cumulative[i - 1])) / length : 0, segment: i - 1 };
      }
      return best;
    },
  };
  return path;
}

/**
 * A network of the paths of one kind (or carrying one tag; every non-data path when none is
 * given): edges welded where their points coincide, one-way edges directed. `route(a, b)`
 * finds the shortest way between the network points nearest to a and b.
 */
export function buildNetwork(paths, kind) {
  const edges = paths.filter((p) => (kind === undefined ? p.kind !== "data" : p.kind === kind || p.tags.includes(kind)));
  const key = (p) => `${Math.round(p[0] * 1000)}|${Math.round(p[1] * 1000)}|${Math.round(p[2] * 1000)}`;
  const nodes = new Map();
  const nodeOf = (p) => { const k = key(p); if (!nodes.has(k)) nodes.set(k, { key: k, position: [...p], links: [] }); return nodes.get(k); };
  for (const e of edges)
    for (let i = 1; i < e.points.length; i++) {
      const a = nodeOf(e.points[i - 1]), b = nodeOf(e.points[i]), d = Math.hypot(b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]);
      a.links.push({ to: b, length: d, edge: e.id });
      if (!e.oneway) b.links.push({ to: a, length: d, edge: e.id });
    }
  const nearest = (p) => {
    let best = null, bestD = Infinity;
    for (const n of nodes.values()) { const d = Math.hypot(n.position[0] - p[0], n.position[1] - p[1], n.position[2] - p[2]); if (d < bestD) { bestD = d; best = n; } }
    return best;
  };
  return {
    kind: kind ?? null,
    edges: edges.map((e) => e.id),
    size: nodes.size,
    /** The network point nearest to p. */
    nearest: (p) => nearest(p)?.position ?? null,
    route(from, to) {
      const start = nearest(from), goal = nearest(to);
      if (!start || !goal) return { found: false, points: [], length: 0, edges: [] };
      const dist = new Map([[start.key, 0]]), came = new Map(), heap = createHeap();
      heap.push(0, start);
      while (heap.size) {
        const [d, n] = heap.pop();
        if (n === goal) break;
        if (d > dist.get(n.key)) continue;
        for (const link of n.links) {
          const nd = d + link.length;
          if (nd < (dist.get(link.to.key) ?? Infinity)) { dist.set(link.to.key, nd); came.set(link.to.key, { from: n, edge: link.edge }); heap.push(nd, link.to); }
        }
      }
      if (!dist.has(goal.key)) return { found: false, points: [], length: 0, edges: [] };
      const points = [], used = [];
      for (let n = goal; n; n = came.get(n.key)?.from) {
        points.push([...n.position]);
        const step = came.get(n.key);
        if (step && used[used.length - 1] !== step.edge) used.push(step.edge);
      }
      return { found: true, points: points.reverse(), length: dist.get(goal.key), edges: used.reverse() };
    },
  };
}

/**
 * The scene data of a loaded tile or model (or a placed copy of one). A world passes its own
 * `height` and `surface` so the file's runtime rules sit on terrain in other tiles.
 */
export function worldData(model, { height: worldHeight = null, surface: worldSurface = null } = {}) {
  const manifest = model.manifest, extensions = model.extensions ?? manifest.extensions ?? {}, streams = model.streams ?? model.file?.streams ?? null;
  model.root.updateMatrixWorld(true);
  const markers = [];
  for (const n of manifest.nodes ?? []) {
    const tags = n.tags ?? [], params = n.extensions?.[PARAMS];
    if (!tags.length && !params) continue;
    const object = model.nodes.get(n.id);
    if (n.placements && model.placements?.get(n.id)) {
      // One marker per copy, in the tile's space.
      const { count, transforms } = model.placements.get(n.id), parent = object.parent?.matrixWorld?.elements ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      for (let i = 0; i < count; i++) {
        const t = transforms.subarray(i * 16, i * 16 + 16);
        const x = parent[0] * t[12] + parent[4] * t[13] + parent[8] * t[14] + parent[12], y = parent[1] * t[12] + parent[5] * t[13] + parent[9] * t[14] + parent[13], z = parent[2] * t[12] + parent[6] * t[13] + parent[10] * t[14] + parent[14];
        markers.push({ id: `${n.id}#${i}`, tags: [...tags], params: params ?? {}, position: [x, y, z], rotation: [0, 0, 0, 1], node: object, copy: i });
      }
      continue;
    }
    const e = object.matrixWorld.elements;
    // Position and rotation in the tile's space (the root sits at the origin when loaded).
    const sx = Math.hypot(e[0], e[1], e[2]) || 1, sy = Math.hypot(e[4], e[5], e[6]) || 1, sz = Math.hypot(e[8], e[9], e[10]) || 1;
    const m00 = e[0] / sx, m01 = e[4] / sy, m02 = e[8] / sz, m10 = e[1] / sx, m11 = e[5] / sy, m12 = e[9] / sz, m20 = e[2] / sx, m21 = e[6] / sy, m22 = e[10] / sz;
    const trace = m00 + m11 + m22;
    let q;
    if (trace > 0) { const s = 0.5 / Math.sqrt(trace + 1); q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]; }
    else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
    else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
    else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
    markers.push({ id: n.id, tags: [...tags], params: params ?? {}, position: [e[12], e[13], e[14]], rotation: q, node: object });
  }
  const zones = (extensions[ZONES] ?? []).map(zoneOf);
  const paths = [];
  const table = extensions[PATHS];
  const profiles = table?.profiles ?? [];
  if (table?.points?.stream !== undefined && streams) {
    const points = streams.of(table.points);
    for (const edge of table.edges ?? []) paths.push(pathOf(edge, points, profiles.find((p) => p.id === edge.profile) ?? null));
  }
  const byTag = (list, tag) => (tag === undefined ? [...list] : list.filter((x) => x.tags.includes(tag)));
  // Terrains: the fields as typed arrays, asked by world x and z.
  const terrains = (extensions["fun3d.terrain"] ?? []).map((t) => ({
    node: t.node, origin: t.origin, cell: t.cell, samples: t.samples, surfaceTable: t.surfaceTable, water: t.water ?? null,
    heights: streams ? streams.of(t.heights) : new Float32Array(t.samples[0] * t.samples[1]),
    surfaces: t.surfaces && streams ? streams.of(t.surfaces) : null,
  }));
  // Grids: cell maps with types and levels, asked by world x and z.
  const grids = (extensions["fun3d.grid"] ?? []).map((g) => ({
    node: g.node, origin: g.origin, cell: g.cell, size: g.size, step: g.step ?? 1, types: g.types,
    cells: streams ? streams.of(g.cells) : new Uint8Array(g.size[0] * g.size[1]),
    levels: g.levels && streams ? streams.of(g.levels) : null,
  }));
  const height = (x, z) => {
    for (const t of terrains) { const h = heightAt(t, x, z); if (h !== null) return h; }
    for (const g of grids) { const h = gridHeightAt(g, x, z); if (h !== null) return h; }
    return null;
  };
  // The walkable raster the workshop baked (fun3d.navgrid): where an agent may stand, and walks.
  const navRecord = extensions["fun3d.navgrid"] ?? null;
  const navgrid = navRecord && streams ? { cell: navRecord.cell, origin: navRecord.origin, size: navRecord.size, radius: navRecord.radius ?? 0, climb: navRecord.climb ?? 0.5, areas: navRecord.areas ?? [], cells: streams.of(navRecord.cells), heights: navRecord.heights ? streams.of(navRecord.heights) : null } : null;
  const walkable = (x, z) => (navgrid ? walkableAt(navgrid, x, z) : false);
  const walk = (a, b, options = {}) => (navgrid ? navPath(navgrid, a, b, { climb: navgrid.climb, ...options }) : { found: false, points: [], length: 0, cells: 0 });
  const surface = (x, z) => { for (const t of terrains) { const s = surfaceAt(t, x, z); if (s) return s; } return null; };
  /** The grid cell under a world point ({ col, row, type, level, height, grid }), null off every grid. */
  const cell = (x, z) => { for (const g of grids) { const c = cellAt(g, x, z); if (c) return { ...c, grid: g.node }; } return null; };
  /** A path over the grid holding both points: { found, cells, points, length }. */
  const gridRoute = (a, b, options) => { for (const g of grids) if (cellAt(g, a[0], a[2]) && cellAt(g, b[0], b[2])) return gridPath(g, a, b, options); return { found: false, cells: [], points: [], length: 0 }; };
  // Rules sit on this file's terrains, then on the world's (other tiles) when it gave them.
  const ruleHeight = worldHeight ? (x, z) => height(x, z) ?? worldHeight(x, z) : height;
  const ruleSurface = worldSurface ? (x, z) => surface(x, z) ?? worldSurface(x, z) : surface;
  // Rules the workshop left for play time (bake: false): the same evaluators, the tile's
  // paths and zones as their inputs, rows in the tile's space, per model.
  const rules = extensions[RULES] ?? [];
  const polygonOf = (zone) => {
    const shape = zone.shape ?? {};
    if (shape.polygon) return shape.polygon;
    if (shape.box) {
      const { center = [0, 0, 0], halfExtents = [0, 0, 0] } = shape.box;
      return [[center[0] - halfExtents[0], center[2] - halfExtents[2]], [center[0] + halfExtents[0], center[2] - halfExtents[2]], [center[0] + halfExtents[0], center[2] + halfExtents[2]], [center[0] - halfExtents[0], center[2] + halfExtents[2]]];
    }
    if (shape.sphere) { const { center = [0, 0, 0], radius = 0 } = shape.sphere, out = []; for (let i = 0; i < 32; i++) out.push([center[0] + radius * Math.cos((i / 32) * Math.PI * 2), center[2] + radius * Math.sin((i / 32) * Math.PI * 2)]); return out; }
    return [];
  };
  const inputsOf = (rule) => {
    const inputs = { paths: {}, polygons: {}, zoneY: {}, avoid: { paths: [], polygons: [], boxes: [...(rule.avoid?.boxes ?? [])] }, height: ruleHeight, surface: (x, z) => ruleSurface(x, z)?.id ?? null, cellType: (x, z) => cell(x, z)?.type?.id ?? null };
    const path = (id) => { const p = paths.find((x) => x.id === id); if (!p) throw new Error(`rule ${rule.id}: the tile has no path ${id}`); return { points: p.points.slice(0, p.closed ? -1 : undefined), closed: p.closed }; };
    const zone = (id) => { const z = zones.find((x) => x.id === id); if (!z) throw new Error(`rule ${rule.id}: the tile has no zone ${id}`); return z; };
    if (rule.kind === "assemble") { if (rule.bounds) inputs.polygons[rule.bounds] = polygonOf(zone(rule.bounds)); }
    else if (rule.kind === "lots") {
      const ids = rule.on.paths ?? paths.filter((p) => p.tags.includes(rule.on.tag)).map((p) => p.id);
      for (const id of ids) inputs.paths[id] = path(id);
      if (rule.bounds) inputs.polygons[rule.bounds] = polygonOf(zone(rule.bounds));
    } else {
      if (rule.on.path !== undefined) inputs.paths[rule.on.path] = path(rule.on.path);
      if (rule.on.zone !== undefined) { const z = zone(rule.on.zone); inputs.polygons[rule.on.zone] = polygonOf(z); inputs.zoneY[rule.on.zone] = z.shape?.y ?? [0, 0]; }
    }
    for (const a of rule.avoid?.paths ?? []) inputs.avoid.paths.push({ ...path(a.path), width: a.width });
    for (const id of rule.avoid?.polygons ?? []) inputs.avoid.polygons.push(polygonOf(zone(id)));
    return inputs;
  };
  const run = (id, { seed } = {}) => {
    const rule = rules.find((r) => r.id === id);
    if (!rule) throw new Error(`the tile has no rule ${id}`);
    const inputs = inputsOf(rule), models = rule.kind === "assemble" ? rule.pieces : rule.candidates;
    let rows, tints = models.map(() => null), report = {};
    if (rule.kind === "assemble") {
      const result = evaluateAssembly({ ...rule, bounds: rule.bounds ? inputs.polygons[rule.bounds] : undefined, avoid: inputs.avoid }, rule.pieces, seed ?? rule.seed);
      rows = result.rows;
      report = { placed: result.placed, open: result.open, stuck: result.stuck };
    } else if (rule.kind === "lots") {
      const result = evaluateLots(rule, inputs, seed ?? rule.seed);
      rows = result.rows;
      report = { lots: result.lots };
    } else ({ rows, tints } = evaluateScatter(rule, inputs, seed ?? rule.seed));
    return {
      id: rule.id, kind: rule.kind, tags: [...(rule.tags ?? [])], ...report,
      placed: models.map((m, i) => ({ model: m.model, rows: rows[i], tints: tints[i] })).filter((p) => p.rows.length),
    };
  };
  return {
    rules: () => rules.map((r) => ({ id: r.id, kind: r.kind, tags: [...(r.tags ?? [])], models: (r.kind === "assemble" ? r.pieces : r.candidates).map((m) => m.model) })),
    run,
    terrains: () => terrains.map((t) => ({ node: t.node, origin: t.origin, cell: t.cell, samples: t.samples, surfaceTable: t.surfaceTable, water: t.water })),
    grids: () => grids.map((g) => ({ node: g.node, origin: g.origin, cell: g.cell, size: g.size, step: g.step, types: g.types })),
    cell,
    gridPath: gridRoute,
    /** The baked walkable raster ({ cell, origin, size, radius, climb, areas, cells, heights }), or null. */
    navgrid: () => navgrid,
    /** Whether an agent may stand at a world point (false without a raster). */
    walkable,
    /** The shortest walk between two world points over the raster: { found, points, length }. */
    walk,
    /** The terrain's height under a world point, null off every terrain. */
    height,
    /** The terrain surface under a world point ({ id, color, friction, tags }), null off every terrain. */
    surface,
    markers: (tag) => byTag(markers, tag),
    marker: (id) => markers.find((m) => m.id === id) ?? null,
    zones: (tag) => byTag(zones, tag),
    zone: (id) => zones.find((z) => z.id === id) ?? null,
    /** The zones containing a point. */
    zonesAt: (p) => zones.filter((z) => z.contains(p)),
    paths: (tag) => byTag(paths, tag),
    path: (id) => paths.find((p) => p.id === id) ?? null,
    profiles: () => profiles.map((p) => ({ ...p })),
    /** The paths of one kind (or tag) as a routable network; every non-data path when none is given. */
    network: (kind) => buildNetwork(paths, kind),
    tile: extensions["fun3d.tile"] ?? null,
  };
}

/**
 * A world streamed from its manifest (docs/worlds.md §3.2 and §7): the data file first, then
 * tiles by distance from the focus, far files beyond, static bodies with the near tiles.
 * Paths are joined to the manifest's directory; `read` and `json` take the joined path
 * (the assets kit's arrayBuffer and json fit), fetch is the default.
 *
 *   const world = await createWorld({ fun3d, models, physics, read: assets.arrayBuffer, json: assets.json }, "worlds/island/world.json");
 *   world.focus(car.position);                     // each frame: what to load, swap and drop
 *   await world.settle();                          // loading screens and tests
 *   world.height(x, z); world.markers("spawn"); world.zone("safe_1").contains(p); world.run("floor", { seed });
 *   world.dispose();
 */
export async function createWorld(context, url, options = {}) {
  const { fun3d, models, physics = null, warn = (message) => console.warn(`world: ${message}`) } = context;
  if (!fun3d?.load || !models?.place) throw new Error("createWorld needs the fun3d loader and the models placer");
  const base = url.slice(0, url.lastIndexOf("/") + 1);
  const fetchOk = async (path) => {
    const response = await (context.fetch ?? globalThis.fetch)(path);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response;
  };
  const readBytes = context.read ?? (async (path) => new Uint8Array(await (await fetchOk(path)).arrayBuffer()));
  const readJson = context.json ?? (async (path) => (await fetchOk(path)).json());
  const manifest = await readJson(url);
  if (manifest?.format !== "fun.dev/world" || manifest.version !== 1) throw new Error(`${url} is not a fun.dev/world version 1 manifest`);
  const [w, d] = manifest.tile?.size ?? [1, 1], span = Math.max(w, d);
  const { radius = span, far: farRadius = span * 4, hysteresis = 0.25, concurrency = 2, onTile = null } = options;
  let disposed = false;

  // Referenced models, loaded once each from the manifest's closure.
  const modelFiles = new Map();
  const resolve = (model) => {
    if (!modelFiles.has(model))
      modelFiles.set(model, (async () => {
        const entry = manifest.models?.[model];
        if (!entry) throw new Error(`the world does not list the model ${model}`);
        return fun3d.load(await readBytes(base + entry.file), { resolve, warn });
      })());
    return modelFiles.get(model);
  };

  const tiles = (manifest.tiles ?? []).map((t) => ({ x: t.x, z: t.z, entry: t, state: "none", want: "none", distance: Infinity, near: null, far: null, loading: null, failed: null }));
  const byKey = new Map(tiles.map((t) => [`${t.x}_${t.z}`, t]));
  // Terrain queries: the near tiles answer first, then the far ones (coarser).
  const height = (x, z) => {
    for (const t of tiles) if (t.near) { const h = t.near.data.height(x, z); if (h !== null) return h; }
    for (const t of tiles) if (t.far && !t.near) { const h = t.far.data.height(x, z); if (h !== null) return h; }
    return null;
  };
  const surface = (x, z) => {
    for (const t of tiles) if (t.near) { const s = t.near.data.surface(x, z); if (s) return s; }
    for (const t of tiles) if (t.far && !t.near) { const s = t.far.data.surface(x, z); if (s) return s; }
    return null;
  };

  // The data file: markers, zones, paths and runtime rules of the whole world, loaded first.
  let dataFile = null, data = null;
  if (manifest.data?.file) {
    dataFile = await fun3d.load(await readBytes(base + manifest.data.file), { resolve, warn });
    data = worldData(dataFile, { height, surface });
  }

  const show = (file, level) => {
    const copy = models.place(file);
    const bodies = level === "near" && physics && file.manifest.physics?.bodies?.length ? physics.add(copy) : null;
    return { file, copy, bodies, data: worldData(copy, { height, surface }) };
  };
  const hide = (shown) => {
    shown.bodies?.remove();
    shown.copy.remove();
    shown.file.dispose();
  };
  const status = (t) => ({ x: t.x, z: t.z, state: t.state, want: t.want, distance: t.distance, loading: t.loading, far: !!t.entry.far });
  // Makes a tile's state follow its want without loading: drops, and swaps once both are here.
  const reconcile = (t) => {
    const drop = (level) => { if (t[level]) { hide(t[level]); t[level] = null; } };
    const before = t.state;
    if (t.want === "near") { if (t.near) { drop("far"); t.state = "near"; } }
    else if (t.want === "far") {
      if (t.far) { drop("near"); t.state = "far"; }
      else if (!t.entry.far || t.failed === "far") { drop("near"); t.state = "none"; }
    } else { drop("near"); drop("far"); t.state = "none"; }
    if (t.state !== before) onTile?.(status(t));
  };
  const needsLoad = (t) => t.want !== "none" && !t[t.want] && !t.loading && t.failed !== t.want && (t.want === "near" || !!t.entry.far);
  let inFlight = 0;
  const waiting = [];
  const start = (t) => {
    const level = t.want, entry = level === "near" ? t.entry : t.entry.far;
    t.loading = level;
    inFlight++;
    (async () => {
      let file = null;
      try {
        file = await fun3d.load(await readBytes(base + entry.file), { resolve, warn });
        if (disposed || t.want !== level) file.dispose();
        else t[level] = show(file, level);
      } catch (error) {
        t.failed = level;
        warn(`tile ${t.x}_${t.z} (${level}): ${error.message ?? error}`);
      } finally {
        t.loading = null;
        inFlight--;
        if (!disposed) { reconcile(t); pump(); }
      }
    })();
  };
  const pump = () => {
    const queue = tiles.filter(needsLoad).sort((a, b) => a.distance - b.distance);
    while (inFlight < concurrency && queue.length) start(queue.shift());
    if (!inFlight) for (const done of waiting.splice(0)) done();
  };
  let fx = 0, fz = 0;
  const update = () => {
    if (disposed) return;
    for (const t of tiles) {
      const dx = Math.max(0, Math.abs(fx - t.x * w) - w / 2), dz = Math.max(0, Math.abs(fz - t.z * d) - d / 2);
      t.distance = Math.hypot(dx, dz);
      // Hysteresis: a tile keeps its level a little beyond the radius that admitted it.
      const within = (limit, held) => t.distance <= limit * (held ? 1 + hysteresis : 1);
      const level = within(radius, t.state === "near") ? "near" : within(farRadius, t.state !== "none") ? "far" : "none";
      if (level !== t.want) { t.want = level; if (t.failed && t.failed !== level) t.failed = null; }
      reconcile(t);
    }
    pump();
  };

  const nearData = () => tiles.filter((t) => t.near).map((t) => t.near.data);
  const all = (pick) => [...(data ? pick(data) : []), ...nearData().flatMap(pick)];
  const first = (pick) => { for (const source of [data, ...nearData()]) { const found = source && pick(source); if (found) return found; } return null; };
  return {
    manifest, id: manifest.id, name: manifest.name, bounds: manifest.bounds ?? null, environment: manifest.environment ?? null, size: [w, d], radius, far: farRadius,
    /** The world's own data (markers, zones, paths, rules), or null for a world without a data file. */
    data,
    /** Sets the point tiles stream around (an array or a Vector3) and applies it. */
    focus(position) { fx = position.x ?? position[0] ?? 0; fz = position.z ?? position[2] ?? 0; update(); },
    update,
    /** Resolves once nothing is loading for the current focus. */
    settle: () => new Promise((done) => { pump(); if (!inFlight) done(); else waiting.push(done); }),
    tiles: () => tiles.map(status),
    /** A tile's status and, when shown, its near or far copy and data. */
    tile(x, z) { const t = byKey.get(`${x}_${z}`); return t ? { ...status(t), near: t.near ? { copy: t.near.copy, data: t.near.data } : null, farCopy: t.far ? { copy: t.far.copy, data: t.far.data } : null } : null; },
    height, surface,
    /** The grid cell under a world point, from the near tiles first. */
    cell(x, z) { for (const t of tiles) if (t.near) { const c = t.near.data.cell(x, z); if (c) return c; } for (const t of tiles) if (t.far && !t.near) { const c = t.far.data.cell(x, z); if (c) return c; } return null; },
    /** A grid path within one near tile's grid holding both points. */
    gridPath(a, b, options) { for (const t of tiles) if (t.near) { const r = t.near.data.gridPath(a, b, options); if (r.found) return r; } return { found: false, cells: [], points: [], length: 0 }; },
    /** Whether an agent may stand at a world point, by the near tiles' rasters. */
    walkable(x, z) { for (const t of tiles) if (t.near && t.near.data.walkable(x, z)) return true; return false; },
    /** A walk within one near tile's raster holding both points (across tiles: later). */
    walk(a, b, options) { for (const t of tiles) if (t.near) { const r = t.near.data.walk(a, b, options); if (r.found) return r; } return { found: false, points: [], length: 0, cells: 0 }; },
    markers: (tag) => all((s) => s.markers(tag)),
    marker: (id) => first((s) => s.marker(id)),
    zones: (tag) => all((s) => s.zones(tag)),
    zone: (id) => first((s) => s.zone(id)),
    zonesAt: (p) => all((s) => s.zonesAt(p)),
    paths: (tag) => all((s) => s.paths(tag)),
    path: (id) => first((s) => s.path(id)),
    /** A routable network over the data file's and the near tiles' paths; build it once the tiles you need are in. */
    network: (kind) => buildNetwork(all((s) => s.paths()), kind),
    rules: () => (data ? data.rules() : []),
    run(id, options) { if (!data) throw new Error("the world has no data file, so no rules"); return data.run(id, options); },
    dispose() {
      disposed = true;
      for (const t of tiles) { if (t.near) hide(t.near); if (t.far) hide(t.far); t.near = t.far = null; t.state = "none"; }
      dataFile?.dispose();
      for (const pending of modelFiles.values()) pending.then((file) => file.dispose(), () => {});
      modelFiles.clear();
      for (const done of waiting.splice(0)) done();
    },
  };
}
