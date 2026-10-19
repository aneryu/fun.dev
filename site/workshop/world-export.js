// A one-tile world (docs/worlds.md §3.2): world.json, the tile, and the .fun3d files of every
// placed model, downloaded from the library by content so the bundle is complete offline.
import { libraryBlobURL } from "./library.js";
import { exportTile } from "./tile.js";
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

export async function exportWorld(project, { name = project.name, runtime = [] } = {}) {
  const { bytes, report } = await exportTile(project, { name, runtime });
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
  const files = [{ path: "tiles/0_0.fun3d", bytes }];
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
  const size = project.tile?.size ?? [
    Math.max(1, Math.ceil(2 * Math.max(Math.abs(report.bounds.min[0]), Math.abs(report.bounds.max[0])) + 1)),
    Math.max(1, Math.ceil(2 * Math.max(Math.abs(report.bounds.min[2]), Math.abs(report.bounds.max[2])) + 1)),
  ];
  const manifest = {
    format: "fun.dev/world",
    version: 1,
    id: worldId(name),
    name,
    tile: { size },
    bounds: report.bounds,
    tiles: [{ x: 0, z: 0, file: "tiles/0_0.fun3d", sha256: await sha256(bytes), bytes: bytes.length }],
    models,
    environment: DEFAULT_ENVIRONMENT,
    ...(runtime.length ? { rules: { runtime: runtime.map(({ rule }) => rule.id) } } : {}),
  };
  files.unshift({ path: "world.json", bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  return { manifest, files, report };
}
