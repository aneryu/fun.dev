import { readFile, lstat } from "node:fs/promises";
import { dirname, resolve, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { API_VERSION, validateCatalog } from "../site/catalog.js";

const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream", ".wasm": "application/wasm", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav" };
const digest = (body) => createHash("sha256").update(body).digest("hex");

export async function prepareRelease(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { files, ...game } = manifest;
  if (Object.keys(game).some((key) => !["id", "version", "apiVersion", "title", "description", "category", "platforms", "orientation", "howToPlay", "cover", "keepAwake"].includes(key))) throw new Error("Unexpected manifest field.");
  validateCatalog([game]);
  if (game.apiVersion !== API_VERSION) throw new Error(`apiVersion must be ${API_VERSION} for this platform.`);
  if (game.cover !== undefined && !files?.includes?.(game.cover)) throw new Error("cover must be listed in files.");
  if (!Array.isArray(files) || !files.includes("game.js") || files.length > 4096 || new Set(files).size !== files.length) throw new Error("files must list game.js and unique runtime files (maximum 4096).");
  const root = dirname(resolve(manifestPath));
  const assets = [];
  let total = 0;
  for (const path of [...files].sort()) {
    if (typeof path !== "string" || !/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(path) || path.split("/").some((part) => !part || part.startsWith(".") || ["dev", "node_modules"].includes(part)) || ["package.json", "package-lock.json", "game.json", "files.json"].includes(path) || !types[extname(path)]) throw new Error(`Invalid runtime file: ${path}`);
    let target = root;
    for (const part of path.split("/")) {
      target = join(target, part);
      if ((await lstat(target)).isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${path}`);
    }
    const info = await lstat(target);
    total += info.size;
    if (!info.isFile() || total > 64 * 1024 * 1024) throw new Error("Bundle must contain files totalling at most 64 MiB.");
    const body = await readFile(target);
    assets.push({ path, body, type: types[extname(path)], hash: digest(body) });
  }
  const release = digest(JSON.stringify(assets.map(({ path, hash }) => [path, hash])));
  const paths = new Set(files);
  for (const asset of assets.filter((file) => /\.m?js$/.test(file.path))) {
    for (const match of asset.body.toString().matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g)) {
      const reference = match[1];
      const target = new URL(reference, `https://bundle.invalid/${asset.path}`);
      if (!reference.startsWith(".") || target.origin !== "https://bundle.invalid" || target.search || target.hash || !paths.has(target.pathname.slice(1))) throw new Error(`Unlisted or external module in ${asset.path}: ${reference}`);
    }
  }
  return { game: { ...game, release }, assets, total };
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
  // files.json lets the site's service worker cache a whole release for offline play.
  const fileList = Buffer.from(JSON.stringify({ files: assets.map((asset) => asset.path) }));
  for (const asset of [...assets, { path: "files.json", body: fileList, type: "application/json", hash: digest(fileList) }]) {
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
