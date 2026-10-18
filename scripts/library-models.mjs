import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { blobPath, cached, cacheRoot, formatLock, parseLock, storeBlob } from "./blobs.mjs";

// Library models a game declares in game.json, `"models": { "<id>": "v<NNN>" }` (docs/models.md).
// Each becomes a runtime file served as a content-addressed blob, so a release pins the exact
// file, the service worker caches it with the game, and asset() finds it:
// - `"modelFormat": "glb"` (default): the approved model.glb at models/<id>.glb;
// - `"modelFormat": "fun3d"`: the model converted through the library profile at
//   models/<id>@<version>.fun3d (docs/model-format.md §8). Conversion runs here, once per
//   (source, converter), cached locally; games/<id>/models.lock records every derived file.
// A model's page data (library/<id>.json) and its file are cached locally, so builds also work
// offline once fetched.
const ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const VERSION = /^v\d{3}$/;
export const FORMATS = ["glb", "fun3d"];
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

export function checkModels(models, format = undefined) {
  if (format !== undefined && !FORMATS.includes(format)) throw new Error(`modelFormat must be one of ${FORMATS.join(", ")}.`);
  if (models === undefined) return;
  if (!models || typeof models !== "object" || Array.isArray(models) || Object.keys(models).length > 200) throw new Error("models must map up to 200 library model ids to versions.");
  for (const [id, version] of Object.entries(models)) {
    if (!ID.test(id) || typeof version !== "string" || !VERSION.test(version)) throw new Error(`models: "${id}" must map a library id to a version like "v001".`);
  }
}

/** The public index of listed models (library/index.zh.json), cached locally like page data. */
export async function fetchIndex() {
  const copy = join(cacheRoot, "library", "index.zh.json");
  try {
    const response = await fetch(`${libraryOrigin()}/library/index.zh.json`, { cache: "no-store", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    await mkdir(dirname(copy), { recursive: true });
    await writeFile(copy, text);
    return JSON.parse(text);
  } catch (error) {
    try { return JSON.parse(await readFile(copy, "utf8")); }
    catch { throw new Error(`models: the library index is unavailable (${error.message}) and not cached yet.`); }
  }
}

/** An approved version's model.glb: { hash, body, type, detail }, fetched into the blob cache once. */
export async function fetchSource(id, version) {
  const detail = await loadDetail(id), entry = detail?.versions?.find((v) => v.version === version), file = entry?.files?.["model.glb"];
  if (!file) throw new Error(`models: ${id} ${version} is not an approved library model (see https://fun.dev/models/${id}).`);
  const hash = file.sha256;
  if (!await cached(hash)) {
    const response = await fetch(`${libraryOrigin()}/blobs/${hash}.glb`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`models: ${id} ${version} could not be downloaded (HTTP ${response.status}).`);
    await storeBlob(hash, Buffer.from(await response.arrayBuffer()));
  }
  return { hash, body: await readFile(blobPath(hash)), type: detail.type ?? "prop", detail };
}

// Derived files by (source hash, converter): a small index in the blob cache names the derived
// blob, so later builds (and offline ones) skip the conversion.
async function derive(id, version, source) {
  const { converterStamp, createConverter } = await import("./fun3d-convert.mjs");
  const stamp = await converterStamp(), index = join(cacheRoot, "derived", stamp.slice(7, 23), source.hash);
  try {
    const { hash, size } = JSON.parse(await readFile(index, "utf8"));
    if (await cached(hash)) return { hash, size, body: await readFile(blobPath(hash)) };
  } catch { /* not derived yet */ }
  const { bytes, report } = await createConverter().convert(source.body, { type: source.type, name: id, hash: `sha256:${source.hash}` });
  const hash = createHash("sha256").update(bytes).digest("hex");
  await storeBlob(hash, Buffer.from(bytes));
  await mkdir(dirname(index), { recursive: true });
  await writeFile(index, JSON.stringify({ hash, size: bytes.length, report }));
  return { hash, size: bytes.length, body: Buffer.from(bytes) };
}

/** The runtime files for a game's declared models: [{ path, body, type, hash, blob }]. */
export async function resolveModels(models, { format = "glb", lockPath = null } = {}) {
  const entries = Object.entries(models ?? {});
  if (!entries.length) return [];
  const files = [];
  for (const [id, version] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const source = await fetchSource(id, version);
    if (format === "fun3d") {
      const derived = await derive(id, version, source);
      files.push({ path: `models/${id}@${version}.fun3d`, body: derived.body, type: "application/octet-stream", hash: derived.hash, blob: `${derived.hash}.fun3d` });
    } else files.push({ path: `models/${id}.glb`, body: source.body, type: "model/gltf-binary", hash: source.hash, blob: `${source.hash}.glb` });
  }
  if (format === "fun3d" && lockPath) await writeModelsLock(lockPath, files);
  return files;
}

// games/<id>/models.lock: "<sha256> <size> <path>" per derived file (the assets.lock format) under
// a line naming the converter, rewritten whenever the derived set changes (commit it with game.json).
async function writeModelsLock(lockPath, files) {
  const { converterStamp } = await import("./fun3d-convert.mjs");
  const entries = new Map(files.map((f) => [f.path, { hash: f.hash, size: f.body.length }]));
  const text = `# library models derived by fundev-library@1, converter ${await converterStamp()}\n${formatLock(entries)}`;
  let current = null;
  try { current = await readFile(lockPath, "utf8"); } catch { /* first build */ }
  if (current !== text) {
    if (current !== null) parseLock(current, "models.lock");
    await writeFile(lockPath, text);
    console.log(`models: ${lockPath} updated (${entries.size} derived files).`);
  }
}
