// Device-only blob storage, one namespace per game. Unlike progress it is never
// transferred, exported or synced: use it for things that must stay on this device
// (e.g. a photo the player picked).
const DATABASE = "fun.dev.device";
const STORE = "blobs";
const KEY = /^[a-z0-9-]{1,32}$/;
export const DEVICE_STORAGE_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, keys: 8 });

function request(target) {
  return new Promise((resolve, reject) => {
    target.onsuccess = () => resolve(target.result);
    target.onerror = () => reject(target.error);
  });
}

export function createDeviceStorage(gameId, { indexedDB = globalThis.indexedDB } = {}) {
  let database = null;
  const open = () => {
    if (!database) {
      const opening = indexedDB.open(DATABASE, 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
      database = request(opening);
    }
    return database;
  };
  const prefix = `${gameId}/`;
  const check = (key) => { if (typeof key !== "string" || !KEY.test(key)) throw new TypeError("Keys use 1–32 lowercase letters, digits or hyphens."); };
  async function run(mode, action) {
    const db = await open();
    const transaction = db.transaction(STORE, mode);
    const done = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Device storage failed."));
    });
    const result = await action(transaction.objectStore(STORE));
    await done;
    return result;
  }
  return Object.freeze({
    async get(key) {
      check(key);
      return (await run("readonly", (store) => request(store.get(prefix + key)))) ?? null;
    },
    async set(key, blob) {
      check(key);
      if (!(blob instanceof Blob)) throw new TypeError("Device storage holds Blobs.");
      if (blob.size > DEVICE_STORAGE_LIMITS.bytes) throw new RangeError("Blob is larger than 2 MiB.");
      await run("readwrite", async (store) => {
        const keys = await request(store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)));
        if (!keys.includes(prefix + key) && keys.length >= DEVICE_STORAGE_LIMITS.keys) throw new RangeError("At most 8 device storage keys per game.");
        return request(store.put(blob, prefix + key));
      });
    },
    async delete(key) {
      check(key);
      await run("readwrite", (store) => request(store.delete(prefix + key)));
    },
  });
}
