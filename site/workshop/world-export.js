// A world (docs/worlds.md §3.2): world.json, the tiles the project cuts into (tiles.js),
// their far files, the data file with the markers, zones, paths and runtime rules, the
// project as its source, and the .fun3d files of every placed model, downloaded from the
// library by content so the bundle is complete offline.
import { libraryBlobURL } from "./library.js";
import { exportTile, sceneBounds } from "./tile.js";
import { cutTiles, farProject } from "./tiles.js";
import { projectFile } from "./project-file.js";
import { ModelError } from "./mesh.js";

const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes));
export const worldId = (name) =>
  (String(name).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "world");

export const DEFAULT_ENVIRONMENT = {
  sun: [{ time: 0.5, direction: [-0.4, -0.8, 0.45], intensity: 3, color: "#fff1dc" }],
  sky: { zenith: "#7fb3e6", horizon: "#dbe7f0", ground: "#6b6b66" },
  fog: null,
};
export const TILE_LIMIT = 4096;

const unionBounds = (list) => ({
  min: [0, 1, 2].map((i) => Math.min(...list.map((b) => b.min[i]))),
  max: [0, 1, 2].map((i) => Math.max(...list.map((b) => b.max[i]))),
});

/**
 * `far` tunes the far files: `minSize` (metres across a part must be to show at a distance,
 * 8 by default), `step` (terrain samples merged, 4), or `false` for none.
 */
export async function exportWorld(project, { name = project.name, runtime = [], far = {} } = {}) {
  const id = worldId(name);
  const { grid, tiles: cuts, data: dataProject } = cutTiles(project);
  if (cuts.length > TILE_LIMIT) throw new ModelError(`The world cuts into ${cuts.length} tiles; the limit is ${TILE_LIMIT}`, "limit");
  // Every placed model's runtime file, once.
  const wanted = new Map();
  const missing = [];
  const needed = [...project.nodes.filter((n) => n.place).map((n) => n.place), ...runtime.flatMap(({ records }) => records)];
  for (const place of needed) {
    if (wanted.has(place.model)) continue;
    if (!place.derived) {
      if (!missing.includes(place.model)) missing.push(place.model);
      continue;
    }
    wanted.set(place.model, place.derived);
  }
  if (missing.length) {
    const error = new ModelError(`No .fun3d yet for ${missing.join(", ")}`, "not_found", "models");
    error.suggestion = "The library converts approved versions; ask for the conversion or place another version.";
    throw error;
  }
  const files = [];
  const tileEntries = [], tileReports = [];
  // No tile setting: one tile around the origin, sized to the scene.
  const whole = sceneBounds(project);
  const size = grid?.size ?? [
    Math.max(1, Math.ceil(2 * Math.max(Math.abs(whole.min[0]), Math.abs(whole.max[0])) + 1)),
    Math.max(1, Math.ceil(2 * Math.max(Math.abs(whole.min[2]), Math.abs(whole.max[2])) + 1)),
  ];
  for (const cut of cuts) {
    const { x, z } = cut;
    // Far first: the near tile's record names it.
    let farEntry = null;
    const farSub = far === false ? null : farProject(cut.project, typeof far === "object" && far ? far : {});
    if (farSub) {
      const { bytes } = await exportTile(farSub, { name: `${name} ${x}_${z} far`, world: { id, x, z, size, level: "far" }, physics: false, edit: false });
      const path = `tiles/${x}_${z}.far.fun3d`;
      files.push({ path, bytes });
      farEntry = { file: path, sha256: await sha256(bytes), bytes: bytes.length };
    }
    const path = `tiles/${x}_${z}.fun3d`;
    const { bytes, report } = await exportTile(cut.project, { name: `${name} ${x}_${z}`, world: { id, x, z, size, far: farEntry?.file ?? null }, edit: false });
    files.push({ path, bytes });
    tileEntries.push({ x, z, file: path, sha256: await sha256(bytes), bytes: bytes.length, bounds: report.bounds, ...(farEntry ? { far: farEntry } : {}) });
    tileReports.push({ x, z, bytes: bytes.length, far: farEntry?.bytes ?? null, ...report });
  }
  const bounds = tileEntries.length ? unionBounds(tileEntries.map((t) => t.bounds)) : whole;
  // The data file: markers, zones, paths and the runtime rules of the whole world.
  let dataEntry = null, dataReport = null;
  if (dataProject.nodes.length || runtime.length) {
    const { bytes, report } = await exportTile(dataProject, { name: `${name} data`, runtime, source: project, world: { id, size, bounds, data: true }, physics: false, edit: false });
    files.push({ path: "world.fun3d", bytes });
    dataEntry = { file: "world.fun3d", sha256: await sha256(bytes), bytes: bytes.length };
    dataReport = { markers: report.markers, zones: report.zones, paths: report.paths, rules: report.rules, bytes: bytes.length };
  }
  // The source: the project in its container, to reopen in the workshop.
  const sourceBytes = await projectFile(project);
  files.push({ path: "world.funmodel.glb", bytes: sourceBytes });
  const source = { file: "world.funmodel.glb", sha256: await sha256(sourceBytes), bytes: sourceBytes.length };
  const models = {};
  for (const [model, derived] of wanted) {
    let data;
    try {
      const response = await fetch(libraryBlobURL("model.fun3d", derived), { credentials: "omit", signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data = new Uint8Array(await response.arrayBuffer());
    } catch (e) {
      throw new ModelError(`Could not download ${model}: ${e.message}`, "library");
    }
    const digest = await sha256(data);
    if (digest !== derived) throw new ModelError(`${model} did not match its checksum`, "library");
    const path = `models/${model}.fun3d`;
    files.push({ path, bytes: data });
    models[model] = { file: path, sha256: digest, bytes: data.length };
  }
  const manifest = {
    format: "fun.dev/world",
    version: 1,
    id,
    name,
    tile: { size, ...(project.tile?.span ? { span: [...project.tile.span] } : {}) },
    bounds,
    tiles: tileEntries,
    ...(dataEntry ? { data: dataEntry } : {}),
    models,
    environment: DEFAULT_ENVIRONMENT,
    ...(runtime.length ? { rules: { runtime: runtime.map(({ rule }) => rule.id) } } : {}),
    source,
  };
  files.unshift({ path: "world.json", bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  const report = {
    bounds,
    tiles: tileReports,
    data: dataReport,
    models: Object.keys(models).length,
    bytes: files.reduce((n, f) => n + f.bytes.length, 0),
  };
  return { manifest, files, report };
}
