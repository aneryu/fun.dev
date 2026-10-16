import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Binary files stay out of Git. A collection is a directory of real files plus a lock committed
// to Git: one "<sha256> <size> <path>" line per file, sorted by path, so parallel branches that
// add files merge line by line. Contents live in a local content-addressed cache shared by every
// checkout on this machine; the coordinator backs them up to a private R2 bucket.
export const root = fileURLToPath(new URL("../", import.meta.url));
export const cacheRoot = process.env.FUNDEV_BLOBS || join(homedir(), ".cache", "fundev-blobs");
const statePath = (base) => join(base, ".assets-state.json");

// games/<id>/assets/ (lock games/<id>/assets.lock, paths like "assets/x.glb") and the shared
// sources/ library (lock sources/sources.lock).
export async function collections(base = root) {
  const list = [];
  for (const entry of (await readdir(join(base, "games"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const game = join(base, "games", entry.name);
    const present = await exists(join(game, "assets")) || await exists(join(game, "assets.lock"));
    if (present) list.push({ name: `games/${entry.name}`, base: game, directory: "assets", lock: join(game, "assets.lock") });
  }
  list.push({ name: "sources", base: join(base, "sources"), directory: "", lock: join(base, "sources", "sources.lock"), skip: new Set(["README.md", "sources.lock"]) });
  return list;
}

export function parseLock(text, name = "lock") {
  const entries = new Map();
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim() || line.startsWith("#")) continue;
    const match = line.match(/^([a-f0-9]{64}) (\d+) (\S(?:.*\S)?)$/);
    if (!match) throw new Error(`${name}:${index + 1}: expected "<sha256> <size> <path>".`);
    const [, hash, size, path] = match;
    if (entries.has(path)) {
      throw new Error(`${name}: ${path} is listed twice (two branches changed it). Keep one line, then run npm run assets.`);
    }
    entries.set(path, { hash, size: Number(size) });
  }
  return entries;
}

export function formatLock(entries) {
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, { hash, size }]) => `${hash} ${size} ${path}\n`).join("");
}

export async function readLock(collection) {
  try { return parseLock(await readFile(collection.lock, "utf8"), relative(root, collection.lock)); }
  catch (error) { if (error.code === "ENOENT") return new Map(); throw error; }
}

export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

export const blobPath = (hash) => join(cacheRoot, hash.slice(0, 2), hash);

async function exists(path) { return stat(path).then(() => true, () => false); }
export const cached = (hash) => exists(blobPath(hash));

// Writes through a temporary name: concurrent checkouts may store the same blob at once.
export async function storeBlob(hash, from) {
  const target = blobPath(hash);
  if (await exists(target)) return;
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  if (typeof from === "string") await copyFile(from, temporary, constants.COPYFILE_FICLONE);
  else await writeFile(temporary, from);
  if (await hashFile(temporary) !== hash) { await rm(temporary, { force: true }); throw new Error(`Blob ${hash} does not match its content.`); }
  await rename(temporary, target);
}

async function restoreBlob(hash, path) {
  if (!await cached(hash)) return false;
  await mkdir(dirname(path), { recursive: true });
  await copyFile(blobPath(hash), path, constants.COPYFILE_FICLONE);
  return true;
}

async function walk(directory, base, skip, files = new Map()) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return files; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const name = relative(base, path).split("\\").join("/");
    if (entry.name.startsWith(".") || skip?.has(name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not stored: ${relative(root, path)}`);
    if (entry.isDirectory()) await walk(path, base, skip, files);
    else if (entry.isFile()) {
      if (/\s/.test(name)) throw new Error(`File names must not contain spaces: ${relative(base, path)}`);
      files.set(name, path);
    }
  }
  return files;
}

async function loadState(base) {
  try { return JSON.parse(await readFile(statePath(base), "utf8")); } catch { return {}; }
}

// Three-way sync between the files on disk, the lock and the state of the last sync in this
// checkout: whichever side changed since then wins; both changing is a conflict.
//   mode "sync"    update locks from local edits and files from lock changes
//   mode "restore" only bring files up to date with the locks (npm run dev)
//   mode "check"   change nothing; report differences (npm run verify)
// prefer: "lock" | "local" resolves conflicts.
export async function sync({ mode = "sync", prefer = null, log = console.log, base = root } = {}) {
  const state = await loadState(base);
  const problems = [];
  const changes = [];
  const missing = [];
  for (const collection of await collections(base)) {
    const lock = await readLock(collection);
    const known = state[collection.name] ?? {};
    const files = await walk(join(collection.base, collection.directory), collection.base, collection.skip);
    const local = new Map();
    for (const [path, file] of files) {
      const info = await stat(file);
      const previous = known[path];
      const hash = previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs ? previous.hash : await hashFile(file);
      local.set(path, { hash, size: info.size, mtimeMs: info.mtimeMs, file });
    }
    const next = new Map(lock);
    const seen = {};
    for (const path of new Set([...lock.keys(), ...local.keys()])) {
      const l = local.get(path)?.hash ?? null;
      const k = lock.get(path)?.hash ?? null;
      const s = known[path]?.hash ?? null;
      const label = `${collection.name}/${path}`;
      const file = join(collection.base, path);
      let take = null; // "lock" or "local"
      if (l === k) take = "same";
      else if (l === s && s !== null || l === null && s === null) take = "lock";
      else if (k === s && s !== null || k === null && s === null) take = "local";
      else if (prefer) take = prefer;
      else { problems.push(`${label}: changed both here and in the lock. Run npm run assets -- --use-lock or --use-local.`); if (l) seen[path] = known[path]; continue; }
      if (take === "same") {
        if (l) {
          if (mode === "sync") await storeBlob(l, local.get(path).file);
          seen[path] = { hash: l, size: local.get(path).size, mtimeMs: local.get(path).mtimeMs };
        }
        continue;
      }
      if (mode === "check") { changes.push(`${label}: ${l === null ? "missing on disk" : k === null ? "not in the lock" : "differs from the lock"}`); continue; }
      if (take === "lock") {
        if (k === null) { await rm(file, { force: true }); changes.push(`removed ${label}`); continue; }
        if (!await restoreBlob(k, file)) { missing.push(label); continue; }
        const info = await stat(file);
        seen[path] = { hash: k, size: info.size, mtimeMs: info.mtimeMs };
        changes.push(`restored ${label}`);
      } else {
        if (mode === "restore") { if (known[path]) seen[path] = known[path]; continue; }
        if (l === null) { next.delete(path); changes.push(`unlisted ${label}`); continue; }
        const entry = local.get(path);
        await storeBlob(l, entry.file);
        next.set(path, { hash: l, size: entry.size });
        seen[path] = { hash: l, size: entry.size, mtimeMs: entry.mtimeMs };
        changes.push(`${k === null ? "added" : "updated"} ${label}`);
      }
    }
    if (mode === "sync") {
      const text = formatLock(next);
      const previous = await readFile(collection.lock, "utf8").catch(() => null);
      if (text !== previous && (next.size || previous !== null)) {
        await mkdir(dirname(collection.lock), { recursive: true });
        await writeFile(collection.lock, text);
      }
    }
    state[collection.name] = seen;
  }
  if (mode !== "check") await writeFile(statePath(base), JSON.stringify(state, null, 1) + "\n");
  for (const change of changes) log(`  ${change}`);
  if (missing.length) problems.push(`Not in the local blob cache (${cacheRoot}): ${missing.join(", ")}. The coordinator can fetch them with npm run assets -- --pull.`);
  return { changes, problems };
}

// Every blob referenced by a lock in this checkout.
export async function referenced(base = root) {
  const hashes = new Map();
  for (const collection of await collections(base)) {
    for (const [path, entry] of await readLock(collection)) hashes.set(entry.hash, { ...entry, label: `${collection.name}/${path}` });
  }
  return hashes;
}
