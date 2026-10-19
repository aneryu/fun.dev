// Per-game persistence on fun through `navigator.storage` (fun's data directory, one jail per
// entry): the contract's progress capability (docs/game-bundles.md, "Optional progress
// capability"), deviceStorage and the options' settings. Files under games/<id>/:
// progress.json, settings.json, device.json (the key index) and device/<key>. Writes go through
// createWritable(), which fun commits on close(), so a crash leaves the previous file intact.
import { ProgressError, snapshot } from "../../progress/format.js";

const KEY = /^[a-z0-9-]{1,32}$/;
export const DEVICE_STORAGE_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, keys: 8 });

async function readText(dir, name) {
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); }
  catch (error) { if (error?.name === "NotFoundError" || /not.?found/i.test(error?.message ?? "")) return null; throw error; }
}
async function readBytes(dir, name) {
  try { return new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer()); }
  catch (error) { if (error?.name === "NotFoundError" || /not.?found/i.test(error?.message ?? "")) return null; throw error; }
}
async function write(dir, name, data) {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(data);
  await writable.close();
}
const readJSON = async (dir, name) => { const text = await readText(dir, name); if (text === null) return null; try { return JSON.parse(text); } catch { return null; } };

/** Opens (creating) the game's directory and reads what createGame needs before it runs. */
export async function createFunStorage(storage, gameId) {
  if (typeof gameId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(gameId)) throw new TypeError("Game ids use lowercase letters, digits and hyphens.");
  const root = await storage.getDirectory();
  const dir = await (await root.getDirectoryHandle("games", { create: true })).getDirectoryHandle(gameId, { create: true });
  const saved = await readJSON(dir, "progress.json");
  const settings = (await readJSON(dir, "settings.json")) ?? {};
  let sequence = Number.isSafeInteger(saved?.sequence) ? saved.sequence : 0;
  let selected = saved?.snapshot ? { kind: "saved", snapshot: saved.snapshot } : { kind: "empty" };
  try { if (selected.kind === "saved") snapshot(selected.snapshot); } catch { selected = { kind: "empty" }; }
  let active = true;
  let queue = Promise.resolve();
  const enqueue = (work) => (queue = queue.then(work, work));

  const progress = Object.freeze({
    version: 1,
    load: async () => (active ? structuredClone(selected) : { kind: "unavailable", reason: "stale_context" }),
    save(value) {
      if (!active) return Promise.reject(new ProgressError("stale_context"));
      let captured;
      try { captured = snapshot(value); } catch (error) { return Promise.reject(error); }
      const next = ++sequence;
      return enqueue(async () => {
        await write(dir, "progress.json", JSON.stringify({ sequence: next, snapshot: captured }));
        return { sequence: next };
      });
    },
  });

  let deviceDir = null, index = null;
  const device = async () => {
    deviceDir ??= await dir.getDirectoryHandle("device", { create: true });
    index ??= (await readJSON(dir, "device.json")) ?? [];
    return deviceDir;
  };
  const check = (key) => { if (typeof key !== "string" || !KEY.test(key)) throw new TypeError("Keys use 1–32 lowercase letters, digits or hyphens."); };
  const deviceStorage = Object.freeze({
    async get(key) {
      check(key);
      const bytes = await readBytes(await device(), key);
      return bytes ? new Blob([bytes]) : null;
    },
    async set(key, blob) {
      check(key);
      if (!(blob instanceof Blob)) throw new TypeError("Device storage holds Blobs.");
      if (blob.size > DEVICE_STORAGE_LIMITS.bytes) throw new RangeError("Blob is larger than 2 MiB.");
      const d = await device();
      if (!index.includes(key) && index.length >= DEVICE_STORAGE_LIMITS.keys) throw new RangeError("At most 8 device storage keys per game.");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await enqueue(async () => {
        await write(d, key, bytes);
        if (!index.includes(key)) { index.push(key); await write(dir, "device.json", JSON.stringify(index)); }
      });
    },
    async delete(key) {
      check(key);
      const d = await device();
      await enqueue(async () => {
        try { await d.removeEntry(key); } catch { /* absent */ }
        if (index.includes(key)) { index.splice(index.indexOf(key), 1); await write(dir, "device.json", JSON.stringify(index)); }
      });
    },
  });

  const preferences = (await readJSON(dir, "preferences.json")) ?? {};
  return {
    progress, deviceStorage,
    settings: { load: () => settings, save: (values) => { Object.assign(settings, values); return enqueue(() => write(dir, "settings.json", JSON.stringify(values))); } },
    /** The player's own switches (muted, volume, locale), kept beside the game's settings. */
    preferences: { load: () => ({ ...preferences }), save: (values) => { Object.assign(preferences, values); return enqueue(() => write(dir, "preferences.json", JSON.stringify(preferences))); } },
    /** Forgets the save; the next launch starts empty. */
    resetProgress: () => enqueue(async () => { selected = { kind: "empty" }; sequence = 0; try { await dir.removeEntry("progress.json"); } catch { /* absent */ } }),
    /** Waits for queued writes; later saves are refused as stale. */
    async close() { active = false; await queue.catch(() => {}); },
  };
}
