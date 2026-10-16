import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { blobPath, cached, cacheRoot, storeBlob } from "./blobs.mjs";

// Library models a game declares in game.json, `"models": { "<id>": "v<NNN>" }` (docs/models.md).
// Each becomes the runtime file models/<id>.glb, served as the model's content-addressed blob, so
// a release pins the exact file, the service worker caches it with the game, and asset() finds it.
// A model's page data (library/<id>.json) and its file are cached locally, so builds also work
// offline once fetched.
const ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const VERSION = /^v\d{3}$/;
export const libraryOrigin = () => process.env.FUNDEV_MODELS_ORIGIN || "https://games.fun.dev";
const details = new Map();

async function loadDetail(id) {
  if (!details.has(id)) details.set(id, (async () => {
    const copy = join(cacheRoot, "library", `${id}.json`);
    try {
      const response = await fetch(`${libraryOrigin()}/library/${id}.json`, { cache: "no-store", signal: AbortSignal.timeout(20000) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      await mkdir(dirname(copy), { recursive: true });
      await writeFile(copy, text);
      return JSON.parse(text);
    } catch (error) {
      try { return JSON.parse(await readFile(copy, "utf8")); }
      catch { throw new Error(`models: ${id} is unavailable (${error.message}) and not cached yet.`); }
    }
  })());
  return details.get(id);
}

// Tests start over as a new process would.
export function forgetCatalog() { details.clear(); }

export function checkModels(models) {
  if (models === undefined) return;
  if (!models || typeof models !== "object" || Array.isArray(models) || Object.keys(models).length > 200) throw new Error("models must map up to 200 library model ids to versions.");
  for (const [id, version] of Object.entries(models)) {
    if (!ID.test(id) || typeof version !== "string" || !VERSION.test(version)) throw new Error(`models: "${id}" must map a library id to a version like "v001".`);
  }
}

/** The runtime files for a game's declared models: [{ path, body, type, hash, blob }]. */
export async function resolveModels(models) {
  const entries = Object.entries(models ?? {});
  if (!entries.length) return [];
  const files = [];
  for (const [id, version] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const file = (await loadDetail(id))?.versions?.find((entry) => entry.version === version)?.files?.["model.glb"];
    if (!file) throw new Error(`models: ${id} ${version} is not an approved library model (see https://fun.dev/models/${id}).`);
    const hash = file.sha256;
    if (!await cached(hash)) {
      const response = await fetch(`${libraryOrigin()}/blobs/${hash}.glb`, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`models: ${id} ${version} could not be downloaded (HTTP ${response.status}).`);
      await storeBlob(hash, Buffer.from(await response.arrayBuffer()));
    }
    files.push({ path: `models/${id}.glb`, body: await readFile(blobPath(hash)), type: "model/gltf-binary", hash, blob: `${hash}.glb` });
  }
  return files;
}
