import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { openDraft } from "../site/workshop/draft.js";
import { emptyProject } from "../site/workshop/document.js";

const key = "fun.dev.editor.project.v2:test";
async function fixture(t, saved, journal, readError = false) {
  const factory = new IDBFactory(),
    values = new Map(),
    events = [];
  if (journal !== undefined) values.set(key, journal);
  const globals = {
    indexedDB: factory,
    location: { href: "http://localhost/workshop/?draft=test" },
    localStorage: {
      getItem(k) {
        events.push("journal:read");
        return values.get(k) ?? null;
      },
      setItem(k, v) {
        events.push("journal:write");
        values.set(k, v);
      },
    },
    navigator: {
      locks: {
        async request(name, options, callback) {
          events.push("lock");
          await callback({ name });
        },
      },
    },
    window: { addEventListener() {} },
  };
  const descriptors = new Map(
    Object.keys(globals).map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  for (const [k, value] of Object.entries(globals))
    Object.defineProperty(globalThis, k, { configurable: true, value });
  const db = await new Promise((resolve, reject) => {
    const r = factory.open("fun.dev.model-editor", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("drafts");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const access = (mode, fn) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction("drafts", mode),
        r = fn(tx.objectStore("drafts"));
      tx.oncomplete = () => resolve(r.result);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  if (saved !== undefined)
    await access("readwrite", (s) => s.put(saved, "test"));
  const originalOpen = factory.open.bind(factory);
  factory.open = (...args) => {
    events.push("db:open");
    if (readError) {
      const request = { error: new Error("Storage temporarily unavailable") };
      queueMicrotask(() => request.onerror());
      return request;
    }
    return originalOpen(...args);
  };
  let draft;
  t.after(() => {
    draft?.dispose();
    db.close();
    for (const [k, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete globalThis[k];
    }
  });
  draft = await openDraft(emptyProject("Fallback"));
  return {
    draft,
    values,
    events,
    read: () => access("readonly", (s) => s.get("test")),
  };
}
const original = () => ({
  project: emptyProject("Important model"),
  revision: 7,
});

test("startup locks before reads and waits for evaluation before persisting", async (t) => {
  const saved = original(),
    f = await fixture(t, saved);
  assert.ok(f.events.indexOf("lock") < f.events.indexOf("db:open"));
  assert.ok(f.events.indexOf("lock") < f.events.indexOf("journal:read"));
  await f.draft.flush();
  assert.equal(f.values.has(key), false);
  assert.deepEqual(await f.read(), saved);
  f.draft.activate();
  await f.draft.flush();
  assert.deepEqual(JSON.parse(f.values.get(key)), saved);
  assert.equal(f.draft.persistence.persistedRevision, 7);
  f.draft.assert(7);
  f.draft.save(emptyProject("Edited"), 8);
  assert.equal((await f.draft.flush()).state, "saved");
  assert.equal((await f.read()).project.name, "Edited");
});

test("broken journal protects the intact database and exact source bytes", async (t) => {
  const saved = original(),
    broken = '{"project":',
    f = await fixture(t, saved, broken);
  assert.equal(f.draft.record.project.name, "Important model");
  assert.equal(f.draft.record.revision, 7);
  assert.equal(f.draft.writable, false);
  assert.equal(f.draft.recoverySources.journal, broken);
  assert.deepEqual(f.draft.recoverySources.indexedDB, saved);
  assert.throws(() => f.draft.assert(7), { code: "recovery" });
  assert.throws(() => f.draft.save(emptyProject(), 8), { code: "recovery" });
  f.draft.activate();
  assert.equal((await f.draft.flush()).state, "recovery");
  assert.deepEqual(await f.read(), saved);
  assert.equal(f.values.get(key), broken);
  f.draft.recovery.code = "mutated";
  f.draft.recoverySources.indexedDB.project.name = "mutated";
  assert.equal(f.draft.recovery.code, "draft_recovery");
  assert.equal(
    f.draft.recoverySources.indexedDB.project.name,
    "Important model",
  );
});

test("failed initial database reads never replace unknown originals with a default", async (t) => {
  const saved = original(),
    f = await fixture(t, saved, undefined, true);
  assert.equal(f.draft.writable, false);
  assert.equal(f.draft.record.project.name, "Recovery");
  assert.equal(f.draft.recovery.code, "draft_read");
  f.draft.activate();
  await assert.rejects(() => f.draft.flush(), { code: "storage" });
  assert.equal(f.values.has(key), false);
  assert.deepEqual(await f.read(), saved);
});

test("invalid metadata is readable in recovery without rewriting originals", async (t) => {
  const saved = {
      ...original(),
      receipts: [null],
      activity: [{ label: "Damaged log", revision: 7, fields: [null] }],
      checkpoints: [null],
    },
    f = await fixture(t, saved);
  assert.equal(f.draft.writable, false);
  for (const field of ["receipts", "activity", "checkpoints"])
    assert.deepEqual(f.draft.record[field], []);
  assert.deepEqual(f.draft.recoverySources.indexedDB, saved);
  f.draft.activate();
  await f.draft.flush();
  assert.deepEqual(await f.read(), saved);
});

test("newer journal retains checkpoints and compacts historical receipts", async (t) => {
  const saved = {
    ...original(),
    checkpoints: [{ id: "before", name: "Before", ...original() }],
    receipts: [
      [
        "edit",
        {
          signature: "sig",
          result: {
            revision: 7,
            results: [
              { op: "create", mesh: "large" },
              { index: 1, op: "duplicate", idMap: { old: "new" } },
            ],
          },
        },
      ],
    ],
  };
  const next = { project: emptyProject("Latest"), revision: 8 },
    f = await fixture(t, saved, JSON.stringify(next));
  assert.equal(f.draft.recovery, null);
  assert.equal(f.draft.record.project.name, "Latest");
  assert.deepEqual(f.draft.record.checkpoints, saved.checkpoints);
  assert.deepEqual(f.draft.record.receipts[0][1].result.results, [
    { index: 1, op: "duplicate", idMap: { old: "new" } },
  ]);
  f.draft.activate();
  await f.draft.flush();
  assert.equal((await f.read()).revision, 8);
});

test("invalid database envelope cannot override a usable journal", async (t) => {
  const saved = { project: null, revision: 9 },
    journal = JSON.stringify(original()),
    f = await fixture(t, saved, journal);
  assert.equal(f.draft.record.project.name, "Important model");
  assert.equal(f.draft.writable, false);
  f.draft.activate();
  await f.draft.flush();
  assert.deepEqual(await f.read(), saved);
  assert.equal(f.values.get(key), journal);
});

test("same-revision disagreements preserve both sources", async (t) => {
  const saved = original(),
    journal = JSON.stringify({ ...saved, project: emptyProject("Other") }),
    f = await fixture(t, saved, journal);
  assert.equal(f.draft.writable, false);
  assert.equal(f.draft.recoverySources.journal, journal);
  assert.deepEqual(f.draft.recoverySources.indexedDB, saved);
});

test("unrecoverable records show an empty recovery document, not a sample", async (t) => {
  const f = await fixture(t, false, "null");
  assert.equal(f.draft.record.project.name, "Recovery");
  assert.equal(f.draft.record.project.nodes.length, 0);
  assert.equal(f.draft.writable, false);
  assert.equal(f.draft.recoverySources.indexedDB, false);
  assert.equal(f.draft.recoverySources.journal, "null");
});

test("evaluation quarantine happens before any migration write", async (t) => {
  const saved = original(),
    f = await fixture(t, saved);
  f.draft.quarantine({ code: "geometry", message: "Cannot rebuild" });
  f.draft.activate();
  await f.draft.flush();
  assert.equal(f.values.has(key), false);
  assert.deepEqual(await f.read(), saved);
});

test("journal corruption during a session blocks the next mutation", async (t) => {
  const saved = original(),
    f = await fixture(t, saved);
  f.draft.activate();
  await f.draft.flush();
  const persisted = await f.read();
  f.values.set(key, JSON.stringify({ revision: 7, project: null }));
  assert.throws(() => f.draft.assert(7), { code: "recovery" });
  assert.deepEqual(f.draft.recoverySources.current.project, saved.project);
  await f.draft.flush();
  assert.deepEqual(await f.read(), persisted);
  assert.equal(JSON.parse(f.values.get(key)).project, null);
});
