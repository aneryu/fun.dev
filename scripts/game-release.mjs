import { readFile, lstat } from "node:fs/promises";
import { dirname, resolve, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { API_VERSION, validateCatalog } from "../site/catalog.js";
import { checkConvert, checkModels, deriveBytes, resolveModels } from "./library-models.mjs";

const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".fun3d": "application/octet-stream", ".bin": "application/octet-stream", ".wasm": "application/wasm", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".txt": "text/plain; charset=utf-8" };
const digest = (body) => createHash("sha256").update(body).digest("hex");

export async function prepareRelease(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // models (library models by version), modelFormat and convert (bundled GLBs derived to .fun3d)
  // are resolved into runtime files below, not published.
  const { files, models, modelFormat, convert, ...game } = manifest;
  if (Object.keys(game).some((key) => !["id", "version", "apiVersion", "title", "description", "category", "platforms", "orientation", "howToPlay", "cover", "keepAwake", "recording"].includes(key))) throw new Error("Unexpected manifest field.");
  validateCatalog([game]);
  if (game.apiVersion !== API_VERSION) throw new Error(`apiVersion must be ${API_VERSION} for this platform.`);
  if (game.cover !== undefined && !files?.includes?.(game.cover)) throw new Error("cover must be listed in files.");
  checkModels(models, modelFormat);
  const conversions = checkConvert(convert, Array.isArray(files) ? files : []);
  if (Array.isArray(files) && files.some((path) => typeof path === "string" && path.startsWith("models/"))) throw new Error("models/ is reserved for library models declared in models.");
  if (!Array.isArray(files) || !files.includes("game.js") || files.length > 4096 || new Set(files).size !== files.length) throw new Error("files must list game.js and unique runtime files (maximum 4096).");
  const root = dirname(resolve(manifestPath));
  const assets = [];
  let total = 0;
  for (const path of [...files].sort()) {
    if (typeof path !== "string" || !/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(path) || path.split("/").some((part) => !part || part.startsWith(".") || ["dev", "node_modules"].includes(part)) || ["package.json", "package-lock.json", "game.json", "files.json"].includes(path) || !types[extname(path)]) throw new Error(`Invalid runtime file: ${path}`);
    let target = root;
    const missing = (error) => {
      if (error.code === "ENOENT" && path.startsWith("assets/")) throw new Error(`${path} is missing; run npm run assets.`);
      throw error;
    };
    for (const part of path.split("/")) {
      target = join(target, part);
      if ((await lstat(target).catch(missing)).isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${path}`);
    }
    const info = await lstat(target);
    total += info.size;
    // No limit on a whole bundle; each file is one R2 upload (no multipart), which Wrangler caps.
    if (!info.isFile() || info.size > 300 * 1024 * 1024) throw new Error(`Runtime files must be regular files of at most 300 MiB: ${path}`);
    const body = await readFile(target);
    const hash = digest(body);
    // Files under assets/ are content-addressed blobs shared across versions and games.
    assets.push({ path, body, type: types[extname(path)], hash, ...(path.startsWith("assets/") ? { blob: `${hash}${extname(path)}` } : {}) });
  }
  // Library models: content-addressed blobs like assets/ files, pinned by version.
  for (const model of await resolveModels(models, { format: modelFormat ?? "glb", lockPath: join(root, "models.lock") })) {
    total += model.body.length;
    assets.push(model);
  }
  // Bundled GLBs the game asked to convert: a .fun3d beside each (docs/model-format.md §8),
  // derived once per source and converter, served as a blob like the source.
  for (const rule of conversions) {
    for (const path of rule.matched) {
      const source = assets.find((asset) => asset.path === path), target = path.replace(/\.glb$/, ".fun3d");
      if (assets.some((asset) => asset.path === target)) throw new Error(`convert: ${target} is already a listed file.`);
      const derived = await deriveBytes(path.split("/").pop().replace(/\.glb$/, ""), rule.type, source.body, source.hash);
      total += derived.body.length;
      assets.push({ path: target, body: derived.body, type: "application/octet-stream", hash: derived.hash, ...(target.startsWith("assets/") ? { blob: `${derived.hash}.fun3d` } : {}) });
    }
  }
  // The same order as the listed files (plain code-unit sort), so other games' releases keep their hashes.
  if (models || conversions.length) assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const release = digest(JSON.stringify(assets.map(({ path, hash }) => [path, hash])));
  const paths = new Set(files);
  for (const asset of assets.filter((file) => /\.m?js$/.test(file.path))) {
    for (const match of asset.body.toString().matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g)) {
      const reference = match[1];
      const target = new URL(reference, `https://bundle.invalid/${asset.path}`);
      if (!reference.startsWith(".") || target.origin !== "https://bundle.invalid" || target.search || target.hash || !paths.has(target.pathname.slice(1))) throw new Error(`Unlisted or external module in ${asset.path}: ${reference}`);
      // Blobs are served by content hash, so relative paths into or out of assets/ break.
      if (asset.blob || target.pathname.startsWith("/assets/")) throw new Error(`Modules cannot import across assets/ (${asset.path}: ${reference}); load assets with import(asset(path)).`);
    }
  }
  return { game: { ...game, release }, assets, total };
}

// files.json: every runtime file (the service worker caches a release for offline play) and
// where each assets/ file is served from (the host resolves asset() through it).
export function fileIndex(assets) {
  return { files: assets.map((asset) => asset.path), blobs: Object.fromEntries(assets.filter((asset) => asset.blob).map((asset) => [asset.path, asset.blob])) };
}

async function readCatalog(store) {
  const object = await store.get("games.json");
  if (!object) return { games: [], etag: null };
  if (!object.etag) throw new Error("Catalog ETag missing; refusing an unconditional update.");
  const games = validateCatalog(JSON.parse(object.body.toString()));
  if (games.some((game) => !game.release)) throw new Error("Remote catalog has a non-immutable entry.");
  return { games, etag: object.etag };
}

async function updateCatalog(store, games, etag) {
  try {
    await store.put("games.json", Buffer.from(JSON.stringify(games, null, 2) + "\n"), {
      type: "application/json", cache: "no-store", ifMatch: etag, ifNoneMatch: etag ? undefined : "*",
    });
  } catch (error) {
    if (error.status === 412 || error.status === 409) throw new Error("Catalog changed during publication. No overwrite performed; inspect and retry.");
    throw error;
  }
}

export async function publishRelease(store, release) {
  const { games, etag } = await readCatalog(store);
  const { game, assets } = release;
  const index = games.findIndex((item) => item.id === game.id);
  // Files are content-addressed. Failed uploads cannot expose a partial release.
  const prefix = `games/${game.id}/${game.version}/${game.release}/`;
  for (const asset of assets.filter((file) => file.blob)) {
    const key = `blobs/${asset.blob}`;
    if (await store.exists(key)) continue;
    await store.put(key, asset.body, { type: asset.type, cache: "public, max-age=31536000, immutable" });
  }
  const fileList = Buffer.from(JSON.stringify(fileIndex(assets)));
  // Code, files.json and the cover (for lobby and share previews) stay under the release path.
  const released = assets.filter((asset) => !asset.blob || asset.path === game.cover);
  for (const asset of [...released, { path: "files.json", body: fileList, type: "application/json", hash: digest(fileList) }]) {
    const key = prefix + asset.path;
    try {
      await store.put(key, asset.body, { type: asset.type, cache: "public, max-age=31536000, immutable", ifNoneMatch: "*" });
    } catch (error) {
      if (error.status !== 412) throw error;
      const existing = await store.get(key);
      if (!existing || digest(existing.body) !== asset.hash) throw new Error(`Immutable object mismatch: ${key}`);
    }
  }
  if (index === -1) games.push(game);
  else games[index] = game;
  await updateCatalog(store, games, etag);
  return game;
}

export async function unregisterGame(store, id) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("Invalid game ID.");
  const { games, etag } = await readCatalog(store);
  if (!games.some((game) => game.id === id)) throw new Error("Game is not registered.");
  await updateCatalog(store, games.filter((game) => game.id !== id), etag);
}
