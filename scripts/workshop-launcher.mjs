#!/usr/bin/env node
// fundev-workshop.mjs: the fun.dev workshop for agents (https://fun.dev/editor/guide).
// This launcher fetches the current workshop (tools/workshop.json names one file by its
// content: the workshop's own modules, its software renderer and geometry kernel), checks its
// SHA-256, keeps it in a cache and runs it, so it always matches the live workshop. It needs
// Node 22 or newer and nothing else; offline it runs the newest cached workshop.
//   node fundev-workshop.mjs --guide | --run model.mjs | --mcp …   (--help for everything)
// FUNDEV_WORKSHOP_ORIGIN fetches from elsewhere (a local build); FUNDEV_WORKSHOP_CACHE sets the cache.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const origin = new URL(process.env.FUNDEV_WORKSHOP_ORIGIN || "https://static.fun.dev/tools/");
const caches = [
  process.env.FUNDEV_WORKSHOP_CACHE,
  join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "fundev-workshop"),
  join(tmpdir(), "fundev-workshop"),
].filter(Boolean);
const NAME = /^workshop-[0-9a-f]{16}\.mjs$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function writable(dir) {
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.probe-${process.pid}`);
    await writeFile(probe, "");
    await unlink(probe);
    return true;
  } catch {
    return false;
  }
}

async function workshop() {
  let manifest = null,
    failure = null;
  try {
    const response = await fetch(new URL("workshop.json", origin), { cache: "no-store", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifest = await response.json();
    if (!NAME.test(manifest.file) || !/^[0-9a-f]{64}$/.test(manifest.sha256)) throw new Error("unexpected workshop.json");
  } catch (error) {
    failure = error;
    manifest = null;
  }
  if (manifest) {
    for (const dir of caches)
      try {
        const path = join(dir, manifest.file);
        if (sha256(await readFile(path)) === manifest.sha256) return path;
      } catch {
        /* not cached here */
      }
    const response = await fetch(new URL(manifest.file, origin), { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Couldn't download the workshop: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== manifest.sha256) throw new Error("The workshop download did not match its checksum; run again");
    for (const dir of caches)
      if (await writable(dir)) {
        const path = join(dir, manifest.file);
        await writeFile(`${path}.${process.pid}.tmp`, bytes);
        await rename(`${path}.${process.pid}.tmp`, path);
        return path;
      }
    throw new Error("No writable cache directory for the workshop; set FUNDEV_WORKSHOP_CACHE");
  }
  // Offline: the newest workshop any cache holds.
  let newest = null;
  for (const dir of caches)
    try {
      for (const name of await readdir(dir))
        if (NAME.test(name)) {
          const path = join(dir, name),
            time = (await stat(path)).mtimeMs;
          if (!newest || time > newest.time) newest = { path, time };
        }
    } catch {
      /* no cache here */
    }
  if (!newest) throw new Error(`Couldn't fetch the workshop from ${origin} (${failure.message}) and none is cached`);
  process.stderr.write(`fundev-workshop: offline (${failure.message}); running the cached ${newest.path}\n`);
  return newest.path;
}

try {
  const { main } = await import(pathToFileURL(await workshop()).href);
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`fundev-workshop: ${error.message}\n`);
  process.exitCode = 1;
}
