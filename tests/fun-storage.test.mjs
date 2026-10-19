import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { register } from "node:module";

// The menu draws with the kit, whose modules import Three.js by site path; the workshop's Node resolver maps it.
register("../scripts/workshop-resolve.mjs", import.meta.url);
const { createFunStorage } = await import("../site/runtime/fun/storage.js");
const { createFunHost } = await import("../site/runtime/fun/host.js");

// An in-memory navigator.storage with fun's handle semantics: files commit on close().
function memoryStorage(files = new Map()) {
  const notFound = () => Object.assign(new Error("not found"), { name: "NotFoundError" });
  const directory = (prefix) => ({
    async getDirectoryHandle(name, { create } = {}) { return directory(`${prefix}${name}/`); },
    async getFileHandle(name, { create } = {}) {
      const path = prefix + name;
      if (!create && !files.has(path)) throw notFound();
      return {
        async getFile() { if (!files.has(path)) throw notFound(); const bytes = files.get(path); return { text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }; },
        async createWritable() { let staged = null; return { async write(data) { staged = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data); }, async close() { files.set(path, staged); } }; },
      };
    },
    async removeEntry(name) { if (!files.delete(prefix + name)) throw notFound(); },
  });
  return { files, getDirectory: async () => directory("/") };
}

test("progress saves and loads across launches, rejects bad snapshots", async () => {
  const storage = memoryStorage();
  let store = await createFunStorage(storage, "lamp");
  assert.deepEqual(await store.progress.load(), { kind: "empty" });
  assert.deepEqual(await store.progress.save({ schemaVersion: 1, data: { launches: 1 } }), { sequence: 1 });
  await assert.rejects(store.progress.save({ schemaVersion: 1, data: { bad: Infinity } }), (e) => e.code === "invalid_snapshot");
  await assert.rejects(store.progress.save({ data: {} }), (e) => e.code === "invalid_snapshot");
  await store.close();
  await assert.rejects(store.progress.save({ schemaVersion: 1, data: {} }), (e) => e.code === "stale_context");
  store = await createFunStorage(storage, "lamp");
  assert.deepEqual(await store.progress.load(), { kind: "saved", snapshot: { schemaVersion: 1, data: { launches: 1 } } });
  assert.deepEqual(await store.progress.save({ schemaVersion: 1, data: { launches: 2 } }), { sequence: 2 });
  assert.ok(storage.files.has("/games/lamp/progress.json"));
});

test("device storage keeps blobs within the limits; settings persist", async () => {
  const storage = memoryStorage();
  const store = await createFunStorage(storage, "lamp");
  assert.equal(await store.deviceStorage.get("photo"), null);
  await store.deviceStorage.set("photo", new Blob([new Uint8Array([1, 2, 3])]));
  assert.deepEqual([...new Uint8Array(await (await store.deviceStorage.get("photo")).arrayBuffer())], [1, 2, 3]);
  await assert.rejects(store.deviceStorage.set("BAD KEY", new Blob([])), TypeError);
  await assert.rejects(store.deviceStorage.set("big", new Blob([new Uint8Array(2 * 1024 * 1024 + 1)])), RangeError);
  for (let i = 0; i < 7; i++) await store.deviceStorage.set(`k${i}`, new Blob([new Uint8Array([i])]));
  await assert.rejects(store.deviceStorage.set("one-too-many", new Blob([])), RangeError);
  await store.deviceStorage.delete("photo");
  assert.equal(await store.deviceStorage.get("photo"), null);
  await store.deviceStorage.set("one-too-many", new Blob([]));
  assert.deepEqual(store.settings.load(), {});
  await store.settings.save({ speed: 3 });
  const again = await createFunStorage(storage, "lamp");
  assert.deepEqual(again.settings.load(), { speed: 3 });
});

test("the host gives games progress, deviceStorage and stored settings", async () => {
  const storage = memoryStorage();
  storage.files.set("/games/lamp/settings.json", new TextEncoder().encode('{"speed":4}'));
  const { Target, canvas2D } = await import("./fun-host.test.mjs");
  const canvas = Object.assign(new Target(), { width: 64, height: 64, clientWidth: 64, clientHeight: 64, getContext: () => ({}) });
  const fun = { Window: class { constructor() { this.canvas = canvas; } }, app: { print() {}, quit() {} }, assets: {}, createCanvas: canvas2D };
  let ctx;
  const host = createFunHost({
    fun, THREE, module: { options: [{ id: "speed", section: "settings", type: "range", min: 1, max: 5, step: 1, default: 2, label: { zh: "速", en: "Speed" } }], createGame(c) { ctx = c; return {}; } },
    manifest: { id: "lamp" }, storage, createRenderer: () => ({ init: async () => {}, setPixelRatio() {}, setSize() {}, render() {} }), requestFrame() {},
  });
  assert.equal(await host.start(), true);
  assert.equal(ctx.progress.version, 1);
  assert.equal(ctx.options.speed, 4, "settings restored before createGame");
  await ctx.progress.save({ schemaVersion: 1, data: { level: 2 } });
  await ctx.deviceStorage.set("shot", new Blob([new Uint8Array([7])]));
  host.setOption("speed", 5);
  host.setMuted(true); host.setVolume(0.4);
  await host.stop();
  assert.ok(storage.files.has("/games/lamp/progress.json"));
  assert.ok(storage.files.has("/games/lamp/device/shot"));
  assert.equal(JSON.parse(new TextDecoder().decode(storage.files.get("/games/lamp/settings.json"))).speed, 5);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(storage.files.get("/games/lamp/preferences.json"))), { muted: true, volume: 0.4, locale: "zh" });
  assert.ok(storage.files.has("/games/lamp/progress.json"));
  await store2(storage);
  await assert.rejects(ctx.progress.save({ schemaVersion: 1, data: {} }), (e) => e.code === "stale_context");
});

async function store2(storage) {
  const store = await createFunStorage(storage, "lamp");
  assert.equal((await store.progress.load()).kind, "saved");
  await store.resetProgress();
  assert.equal((await store.progress.load()).kind, "empty");
  assert.ok(!storage.files.has("/games/lamp/progress.json"), "reset removes the save");
}
