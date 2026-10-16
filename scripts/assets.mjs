import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { blobPath, cached, cacheRoot, referenced, storeBlob, sync } from "./blobs.mjs";

// npm run assets                 sync games/<id>/assets/ and sources/ with their locks
// npm run assets -- --use-lock   resolve conflicts with the lock (or --use-local)
// npm run assets -- --check      change nothing; fail when files and locks differ
// Coordinator only (Wrangler, private bucket R2_SOURCES_BUCKET, default fundev-sources):
// npm run assets -- --push       back up every referenced blob not yet uploaded from this machine
// npm run assets -- --pull       fetch referenced blobs missing from the local cache, then sync
const bucket = process.env.R2_SOURCES_BUCKET || "fundev-sources";
const pushedList = join(cacheRoot, `pushed-${bucket}.txt`);

async function privateStore() {
  const { createWranglerStore } = await import("./r2-wrangler-store.mjs");
  return createWranglerStore(bucket);
}

// Referenced blobs this machine has not backed up yet.
export async function pendingBackups() {
  const pushed = new Set((await readFile(pushedList, "utf8").catch(() => "")).split("\n").filter(Boolean));
  return [...(await referenced()).entries()].filter(([hash]) => !pushed.has(hash));
}

export async function pushBlobs({ log = console.log } = {}) {
  const pending = await pendingBackups();
  if (!pending.length) return 0;
  const store = await privateStore();
  try {
    for (const [hash, { label, size }] of pending) {
      if (!await cached(hash)) throw new Error(`${label} is not in the local blob cache; run npm run assets first.`);
      await store.put(`blobs/${hash}`, await readFile(blobPath(hash)), { type: "application/octet-stream" });
      await appendFile(pushedList, `${hash}\n`);
      log(`  backed up ${label} (${(size / 1048576).toFixed(1)} MB)`);
    }
  } finally { store.close(); }
  return pending.length;
}

async function pullBlobs() {
  const missing = [];
  for (const [hash, entry] of await referenced()) if (!await cached(hash)) missing.push([hash, entry]);
  if (!missing.length) return;
  const store = await privateStore();
  try {
    for (const [hash, { label }] of missing) {
      const object = await store.get(`blobs/${hash}`);
      if (!object) throw new Error(`${label} is not in the ${bucket} bucket.`);
      await storeBlob(hash, object.body);
      console.log(`  fetched ${label}`);
    }
  } finally { store.close(); }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const flags = process.argv.slice(2);
  const known = ["--use-lock", "--use-local", "--check", "--push", "--pull"];
  if (flags.some((flag) => !known.includes(flag)) || (flags.includes("--use-lock") && flags.includes("--use-local"))) {
    console.error(`Usage: npm run assets [-- ${known.join(" | ")}]`);
    process.exit(1);
  }
  try {
    if (flags.includes("--pull")) await pullBlobs();
    const prefer = flags.includes("--use-lock") ? "lock" : flags.includes("--use-local") ? "local" : null;
    const { changes, problems } = await sync({ mode: flags.includes("--check") ? "check" : "sync", prefer });
    if (problems.length) throw new Error(problems.join("\n"));
    if (flags.includes("--check") && changes.length) throw new Error("Files and locks differ. Run npm run assets, then commit the locks.");
    if (flags.includes("--push")) console.log(`Backed up ${await pushBlobs()} blobs to ${bucket}.`);
    const locksChanged = changes.some((change) => /^(?:added|updated|unlisted) /.test(change));
    console.log(locksChanged && !flags.includes("--check") ? "Assets synced; commit the changed locks." : "Assets match their locks.");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
