import { assert, snapshot, ProgressError } from "./format.js";
import { packet } from "./transfer.js";
const read = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const freshIdentity = (generation = 1) => ({ bucket: `local-${crypto.randomUUID()}`, profileId: crypto.randomUUID(), generation, state: "active", pending: null });
const slot = (identity, game) => ({ key: `${identity.bucket}/${game}`, bucket: identity.bucket, gameId: game, seq: 0, snapshot: null, writerGeneration: 0, review: !!identity.legacyUnknown });
const candidates = row => [row.snapshot, row.inflight?.body?.snapshot, row.conflict?.remote?.snapshot, row.conflict?.inflight?.body?.snapshot, row.conflict?.resolution?.selected].filter(Boolean);
export function openLocal(name = "fun.dev.progress", indexedDB = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) { reject(new ProgressError("storage_unavailable")); return; }
    const request = indexedDB.open(name, 2);
    let abandoned = false;
    const timeout = setTimeout(() => { abandoned = true; reject(new ProgressError("storage_blocked")); }, 3000);
    request.onupgradeneeded = event => {
      const db = request.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("slots")) db.createObjectStore("slots", { keyPath: "key" });
      const archives = db.createObjectStore("archives", { keyPath: "key" });
      if (event.oldVersion === 1) {
        const tx = request.transaction, slots = tx.objectStore("slots"), meta = tx.objectStore("meta");
        const cursor = slots.openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          const old = item.value;
          archives.put(old);
          item.update({ key: old.key, bucket: old.bucket, gameId: old.gameId, seq: old.seq || 0, snapshot: old.snapshot || null,
            writerGeneration: (old.writerGeneration || 0) + 1, updatedAt: old.updatedAt, review: !old.snapshot && !old.confirmed });
          item.continue();
        };
        const identity = meta.get("identity");
        identity.onsuccess = () => {
          const old = identity.result;
          if (!old) return;
          meta.put(old, "legacyIdentity");
          meta.put({ bucket: old.bucket, profileId: crypto.randomUUID(), generation: old.generation + 1,
            state: "active", pending: null, legacy: true, legacyUnknown: !!old.accountId || !!old.pending }, "identity");
        };
      }
    };
    request.onerror = () => { clearTimeout(timeout); reject(new ProgressError("storage_unavailable")); };
    request.onblocked = () => { abandoned = true; clearTimeout(timeout); reject(new ProgressError("storage_blocked")); };
    request.onsuccess = () => {
      clearTimeout(timeout);
      const db = request.result;
      if (abandoned) { db.close(); return; }
      db.onversionchange = () => db.close();
      resolve(new LocalProgress(db));
    };
  });
}
export class LocalProgress {
  constructor(db) { this.db = db; }
  transaction(callback, mode = "readwrite") {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(["meta", "slots", "archives"], mode);
      let result, failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || new ProgressError("storage_unavailable"));
      tx.onerror = () => {};
      Promise.resolve().then(() => callback(tx.objectStore("meta"), tx.objectStore("slots"), tx.objectStore("archives"))).then(value => { result = value; }, error => {
        failure = error; try { tx.abort(); } catch { reject(error); }
      });
    });
  }
  identity() {
    return this.transaction(async meta => {
      const value = await read(meta.get("identity")) || freshIdentity();
      meta.put(value, "identity"); return value;
    });
  }
  async current(meta, identity, writable = false) {
    const current = await read(meta.get("identity"));
    assert(current.generation === identity.generation && current.bucket === identity.bucket, "identity_mismatch", 409);
    if (writable) assert(current.state === "active" && !current.pending, "profile_frozen", 409);
    return current;
  }
  edit(identity, game, callback, writer = null) {
    return this.transaction(async (meta, slots) => {
      await this.current(meta, identity, true);
      const row = await read(slots.get(`${identity.bucket}/${game}`)) || slot(identity, game);
      if (writer !== null) assert(row.writerGeneration === writer, "writer_changed", 409);
      const value = callback(row); slots.put(row); return value ?? row;
    });
  }
  get(identity, game) { return this.transaction(async (_, slots) => read(slots.get(`${identity.bucket}/${game}`)), "readonly"); }
  claim(identity, game) { return this.edit(identity, game, row => { row.writerGeneration++; }); }
  save(identity, game, writer, value) {
    const captured = snapshot(value);
    return this.edit(identity, game, row => {
      assert(!row.review, "legacy_unknown");
      assert(!row.snapshot || captured.schemaVersion >= row.snapshot.schemaVersion, "newer_schema");
      row.snapshot = captured; row.seq++; row.updatedAt = Date.now(); return { sequence: row.seq };
    }, writer);
  }
  all() { return this.transaction(async (_, slots) => read(slots.getAll()), "readonly"); }
  archiveRows() { return this.transaction(async (_, __, archives) => read(archives.getAll()), "readonly"); }
  async beginOutgoing(identity, pending) {
    return this.transaction(async (meta, slots, archives) => {
      const current = await this.current(meta, identity, true);
      const rows = (await read(slots.getAll())).filter(x => x.bucket === identity.bucket);
      assert(rows.every(row => !row.review), "legacy_unknown");
      const alternatives = (await read(archives.getAll())).filter(x => x.bucket === identity.bucket).flatMap(row => candidates(row).map(value => ({ gameId: row.gameId, snapshot: value })));
      const saves = rows.map(row => ({ gameId: row.gameId, snapshot: row.snapshot }));
      const seen = new Set(saves.map(x => JSON.stringify(x)));
      const unique = alternatives.filter(x => { const key = JSON.stringify(x); if (seen.has(key)) return false; seen.add(key); return true; });
      const payload = JSON.stringify(packet({ format: "fun.dev.transfer", version: 1, profileId: current.profileId, saves, alternatives: unique }));
      const next = { ...current, generation: current.generation + 1, state: "outgoing", pending: { ...pending, payload } };
      meta.put(next, "identity"); return next;
    });
  }
  beginIncoming(identity, pending) {
    return this.transaction(async meta => {
      const current = await this.current(meta, identity);
      assert(!current.pending && ["active", "moved"].includes(current.state), "profile_frozen");
      const next = { ...current, generation: current.generation + 1, state: "incoming", pending: { ...pending, previousState: current.state } };
      meta.put(next, "identity"); return next;
    });
  }
  updatePending(identity, change) {
    return this.transaction(async meta => {
      const current = await this.current(meta, identity);
      assert(current.pending?.id === identity.pending?.id, "identity_mismatch", 409);
      change(current.pending); meta.put(current, "identity"); return current;
    });
  }
  stage(identity, value, digest) {
    const captured = packet(value);
    return this.transaction(async (meta, slots, archives) => {
      const current = await this.current(meta, identity);
      assert(current.state === "incoming", "profile_frozen");
      const bucket = `received-${current.pending.id}`;
      for (const entry of captured.saves) slots.put({ ...slot({ bucket }, entry.gameId), snapshot: entry.snapshot, seq: entry.snapshot ? 1 : 0 });
      captured.alternatives.forEach((entry, index) => archives.put({ ...entry, bucket, key: `${bucket}/alternative-${index}` }));
      current.pending.staged = { bucket, profileId: captured.profileId, digest };
      meta.put(current, "identity"); return current;
    });
  }
  finish(identity, result) {
    return this.transaction(async meta => {
      const current = await this.current(meta, identity);
      assert(current.pending?.id === result.id, "identity_mismatch", 409);
      assert(["committed", "cancelled", "expired"].includes(result.state), "transfer_unknown");
      let next = { ...current, pending: null, generation: current.generation + 1, state: "active" };
      if (current.state === "outgoing") {
        assert(current.pending.digest === result.digest, "transfer_mismatch");
        if (result.state === "committed") next.state = "moved";
      } else {
        assert(current.state === "incoming", "profile_frozen");
        next.state = current.pending.previousState || "active";
        if (result.state === "committed") {
          const staged = current.pending.staged;
          assert(staged && staged.digest === result.digest, "transfer_unknown");
          meta.put({ ...current, state: "archived", pending: null }, `archive:${current.bucket}`);
          next = { bucket: staged.bucket, profileId: staged.profileId, state: "active", pending: null, generation: next.generation };
        }
      }
      meta.put(next, "identity"); return next;
    });
  }
  newIdentity(identity) {
    return this.transaction(async meta => {
      const current = await this.current(meta, identity);
      // Uncertain transfers remain archived and frozen. A new profile has a new ID.
      meta.put(current, `archive:${current.bucket}`);
      const next = freshIdentity(current.generation + 1); meta.put(next, "identity"); return next;
    });
  }
  clearBucket(identity) {
    return this.transaction(async (meta, slots, archives) => {
      const current = await this.current(meta, identity);
      assert(!current.pending, "profile_frozen");
      for (const store of [slots, archives]) for (const row of await read(store.getAll())) if (row.bucket === identity.bucket) store.delete(row.key);
      const next = freshIdentity(current.generation + 1); meta.put(next, "identity"); return next;
    });
  }
  close() { this.db.close(); }
}
export { candidates as legacySnapshots };
