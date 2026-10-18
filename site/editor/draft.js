import { ModelError, emptyProject } from "./document.js";

const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const revision = (v) => Number.isSafeInteger(v) && v >= 0;
const envelope = (v) => object(v) && object(v.project) && revision(v.revision);
const optionalList = (value, valid) =>
  value === undefined || (Array.isArray(value) && value.every(valid));
const string = (value) => typeof value === "string";
function readMetadata(record) {
  let damaged = false;
  const list = (key, valid) => {
    const items = record[key] === undefined ? [] : record[key];
    if (!Array.isArray(items)) {
      damaged = true;
      return [];
    }
    return items.filter((item) => {
      const ok = valid(item);
      if (!ok) damaged = true;
      return ok;
    });
  };
  const checkpoints = list(
    "checkpoints",
    (c) =>
      object(c) &&
      typeof c.id === "string" &&
      typeof c.name === "string" &&
      envelope(c),
  );
  const activity = list(
    "activity",
    (a) =>
      object(a) &&
      string(a.label) &&
      revision(a.revision) &&
      ["changed", "removed", "affected", "detachedRecipes"].every((key) =>
        optionalList(a[key], string),
      ) &&
      optionalList(a.fields, (field) => object(field) && string(field.path)) &&
      optionalList(a.issues, (issue) => object(issue) && string(issue.code)) &&
      (a.error === undefined || (object(a.error) && string(a.error.message))),
  );
  const receipts = list(
    "receipts",
    (pair) =>
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === "string" &&
      object(pair[1]) &&
      typeof pair[1].signature === "string" &&
      object(pair[1].result) &&
      revision(pair[1].result.revision) &&
      ["changed", "removed", "materials"].every(
        (key) =>
          pair[1].result[key] === undefined ||
          (Array.isArray(pair[1].result[key]) &&
            pair[1].result[key].every((id) => typeof id === "string")),
      ) &&
      (pair[1].result.results === undefined ||
        (Array.isArray(pair[1].result.results) &&
          pair[1].result.results.every(
            (r) =>
              object(r) &&
              (!r.idMap ||
                (object(r.idMap) &&
                  Object.values(r.idMap).every(
                    (id) => typeof id === "string",
                  ))),
          ))),
  )
    .slice(-32)
    .map(([id, entry]) => [
      id,
      {
        signature: entry.signature,
        result: {
          revision: entry.result.revision,
          stats: entry.result.stats,
          changed: entry.result.changed,
          removed: entry.result.removed,
          materials: entry.result.materials,
          operationId: id,
          results: (entry.result.results ?? [])
            .filter((r) => r.idMap)
            .map(({ index, op, idMap }) => ({ index, op, idMap })),
        },
      },
    ]);
  return { record: { ...record, checkpoints, activity, receipts }, damaged };
}

// IndexedDB owns the complete draft. A compact synchronous project journal
// protects the interval between a UI edit and the asynchronous transaction.
export async function openDraft(fallback, onState = () => {}) {
  const id = new URL(location.href).searchParams.get("draft") ?? "default";
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error("Invalid draft ID");
  const key = `fun.dev.editor.project.v2:${id}`;
  let record = { project: fallback, revision: 0 },
    db,
    storageError = false,
    restoreError = false,
    recovery = null,
    writable = false,
    release,
    journalRevision = null,
    persistedRevision = null,
    generation = 0,
    savedGeneration = 0,
    queued = false,
    activated = false,
    restored = false,
    pending = Promise.resolve();
  let originals = { indexedDB: null, journal: null, legacy: null };
  let recoverySources = null;
  const readJournal = () => {
    const value = localStorage.getItem(key);
    if (value === null) return null;
    const parsed = JSON.parse(value);
    if (!envelope(parsed)) throw new SyntaxError("Invalid draft journal");
    return parsed;
  };
  const transaction = (mode, fn) =>
    new Promise((resolve, reject) => {
      if (!db) return reject(new Error("IndexedDB unavailable"));
      const tx = db.transaction("drafts", mode),
        request = fn(tx.objectStore("drafts"));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? new Error("Draft transaction failed"));
    });
  // The lock must precede reads: a departing writer may finish a newer save.
  await acquire();
  try {
    db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("fun.dev.model-editor", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("drafts");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.onversionchange = () => db.close();
    const saved = await transaction("readonly", (s) => s.get(id));
    originals.indexedDB = structuredClone(saved ?? null);
    if (envelope(saved)) {
      record = saved;
      restored = true;
      persistedRevision = saved.revision;
    } else if (saved !== undefined) restoreError = true;
  } catch (error) {
    storageError = true;
    restoreError = true;
    originals.indexedDBError = error.message ?? String(error);
    recovery = {
      code: "draft_read",
      message:
        "Couldn't read the saved draft. Originals are protected; restore storage access and retry.",
    };
  }
  try {
    originals.journal = localStorage.getItem(key);
    const journal =
      originals.journal === null ? null : JSON.parse(originals.journal);
    if (originals.journal !== null && !envelope(journal))
      throw new Error("Invalid draft journal");
    journalRevision = journal?.revision ?? null;
    if (
      journal &&
      (persistedRevision === null || journal.revision > record.revision)
    ) {
      // Old v2 records include metadata. A newer recovery journal only replaces
      // the project; retained checkpoints remain valid independent snapshots.
      record = { ...record, ...journal };
      restored = true;
    } else if (
      journal &&
      journal.revision === record.revision &&
      JSON.stringify(journal.project) !== JSON.stringify(record.project)
    ) {
      restoreError = true;
    } else if (!journal && persistedRevision === null && id === "default") {
      const old = (originals.legacy = localStorage.getItem(
        "fun.dev.editor.project.v1",
      ));
      if (old !== null) {
        record.project = JSON.parse(old);
        restored = true;
      }
    }
    if (
      !Number.isSafeInteger(record.revision) ||
      record.revision < 0 ||
      !record.project
    )
      throw new Error("Invalid draft");
  } catch {
    restoreError = true;
  }
  if (!envelope(record) || (restoreError && !restored)) {
    restoreError = true;
    record = { project: emptyProject("Recovery"), revision: 0 };
  }
  const metadata = readMetadata(record);
  if (metadata.damaged) restoreError = true;
  if (restoreError || record.recovery) {
    const reason = record.recovery ?? recovery;
    recovery =
      object(reason) &&
      typeof reason.code === "string" &&
      typeof reason.message === "string"
        ? reason
        : {
            code: "draft_recovery",
            message:
              "Saved records are damaged or disagree. Originals are protected; continue in a recovered copy.",
          };
    recoverySources = structuredClone(record.recoverySources ?? originals);
  }
  record = metadata.record;
  async function acquire() {
    if (!navigator.locks) return;
    await new Promise((resolve) => {
      navigator.locks
        .request(
          `fun.dev.editor:${id}`,
          { ifAvailable: true },
          async (lock) => {
            writable = !!lock;
            resolve();
            onState();
            if (lock)
              await new Promise((done) => {
                release = done;
              });
          },
        )
        .catch(() => {
          writable = false;
          resolve();
          onState();
        });
    });
  }
  function schedule() {
    if (recovery || !activated) return;
    generation++;
    // The journal contains no checkpoints, activity or geometry-rich receipts.
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ project: record.project, revision: record.revision }),
      );
      journalRevision = record.revision;
    } catch {
      /* IndexedDB can still commit; its result is authoritative. */
    }
    if (!queued) {
      queued = true;
      pending = pending.then(async () => {
        queued = false;
        const snapshot = structuredClone(record),
          ticket = generation;
        try {
          await transaction("readwrite", (s) => s.put(snapshot, id));
          persistedRevision = snapshot.revision;
          savedGeneration = ticket;
          storageError = false;
        } catch {
          storageError = true;
        }
        onState();
      });
    }
    onState();
  }
  const api = {
    id,
    get record() {
      return record;
    },
    get writable() {
      return writable && !recovery;
    },
    get recovery() {
      return structuredClone(recovery);
    },
    get recoverySources() {
      return structuredClone(recoverySources);
    },
    activate() {
      if (activated || recovery) return;
      activated = true;
      if (writable) schedule();
    },
    quarantine(error) {
      recovery = { code: error.code ?? "invalid", message: error.message };
      onState();
    },
    get storageError() {
      return storageError;
    },
    get persistence() {
      return {
        state: recovery
          ? "recovery"
          : storageError
            ? "failed"
            : savedGeneration < generation
              ? "pending"
              : "saved",
        revision: record.revision,
        persistedRevision,
        journalRevision,
        backend: "indexedDB",
      };
    },
    restoreError,
    assert(revision) {
      if (recovery)
        throw new ModelError(
          "Original draft is protected. Download it or recover a copy.",
          "recovery",
        );
      if (!writable)
        throw new ModelError(
          "This draft is open in another window. Close that editor and retry, or open an independent copy.",
          "readonly",
        );
      try {
        const saved = readJournal();
        if (saved && saved.revision !== journalRevision)
          throw new ModelError(
            "The saved draft changed. Reload before editing.",
            "conflict",
          );
      } catch (e) {
        if (e.code === "conflict") throw e;
        if (e instanceof SyntaxError) {
          recoverySources = {
            ...originals,
            journal: localStorage.getItem(key),
            current: structuredClone(record),
          };
          this.quarantine(
            new ModelError(
              "The draft journal changed to invalid data. Originals are protected.",
              "draft_recovery",
            ),
          );
          throw new ModelError(
            "Original draft is protected. Recover a copy before editing.",
            "recovery",
          );
        }
      }
      if (revision !== record.revision)
        throw new ModelError("The document revision changed", "conflict");
    },
    save(project, revision) {
      if (recovery)
        throw new ModelError("Original draft is protected", "recovery");
      record = { ...record, project, revision };
      schedule();
      return this.persistence;
    },
    setMetadata(metadata) {
      this.assert(record.revision);
      const next = { ...record, ...metadata };
      if (
        new TextEncoder().encode(JSON.stringify(next)).length >
        96 * 1024 * 1024
      )
        throw new ModelError("Draft with checkpoints exceeds 96 MB", "budget");
      record = next;
      schedule();
      return this.persistence;
    },
    async flush() {
      let target;
      do {
        target = pending;
        await target;
      } while (target !== pending);
      if (storageError) {
        const e = new ModelError(
          "Changes are applied but not saved; retry saving or download the project",
          "storage",
        );
        e.persistence = this.persistence;
        throw e;
      }
      return this.persistence;
    },
    async retry() {
      if (recovery) {
        location.reload();
        return;
      }
      if (!writable) {
        await acquire();
        if (writable) location.reload();
      } else {
        schedule();
        await this.flush();
      }
    },
    async copy(project) {
      const copyId = crypto.randomUUID(),
        next = new URL(location.href),
        tab = window.open("about:blank", "_blank");
      next.searchParams.set("draft", copyId);
      try {
        await transaction("readwrite", (s) =>
          s.put({ project, revision: 0 }, copyId),
        );
        if (tab) {
          tab.opener = null;
          tab.location.href = next.href;
        }
      } catch (e) {
        tab?.close();
        throw e;
      }
    },
    dispose() {
      release?.();
      writable = false;
      db?.close();
    },
  };
  window.addEventListener("beforeunload", (e) => {
    if (
      writable &&
      !recovery &&
      (storageError || savedGeneration < generation)
    ) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  return api;
}
