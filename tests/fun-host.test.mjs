import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { register } from "node:module";

// The menu draws with the kit, whose modules import Three.js by site path; the workshop's Node resolver maps it.
register("../scripts/workshop-resolve.mjs", import.meta.url);
const { API_VERSION, assetKey, createFunHost, flipRows } = await import("../site/runtime/fun/host.js");

// The fun host adapter (docs/hosts.md) against stand-ins for fun's modules and a fake renderer:
// the context a game receives, the lifecycle order, frames, pause, options and teardown.
// An EventTarget with capture ordering and stopImmediatePropagation, as fun's canvas has.
export class Target {
  #listeners = [];
  addEventListener(type, fn, options = {}) { this.#listeners.push({ type, fn, capture: options === true || !!options.capture }); options.signal?.addEventListener?.("abort", () => this.removeEventListener(type, fn)); }
  removeEventListener(type, fn) { this.#listeners = this.#listeners.filter((l) => l.type !== type || l.fn !== fn); }
  dispatch(type, event = {}) {
    let stopped = false;
    const e = { type, ...event, stopImmediatePropagation: () => { stopped = true; } };
    for (const phase of [true, false]) for (const l of this.#listeners.filter((l) => l.type === type && l.capture === phase)) { if (stopped) return e; l.fn(e); }
    return e;
  }
}
// A 2D context that measures and draws nothing, enough for the kit's text labels.
export const canvas2D = (width = 1, height = 1, created = null) => {
  const c = { width, height, lastText: "" };
  created?.push(c);
  c.getContext = () => ({ font: "", fillStyle: "", textBaseline: "", textAlign: "", measureText: (t) => ({ width: String(t).length * 10 }), fillText(t) { c.lastText = t; }, fillRect() {}, clearRect() {}, setTransform() {}, dispose() { c.disposed = true; } });
  return c;
};
function funStub({ images = {}, files = {} } = {}) {
  const printed = [];
  const canvas = Object.assign(new Target(), { width: 640, height: 360, clientWidth: 640, clientHeight: 360, getContext: () => ({ _id: 7 }), getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }), focus() { this.focused = true; } });
  const registered = {}, created = [];
  return {
    printed, canvas, registered, created,
    fun: {
      Window: class { constructor(options) { this.options = options; this.canvas = canvas; } },
      app: { print: (t) => printed.push(t), quit: () => printed.push("<quit>") },
      assets: {
        readBytes: (name) => { if (!files[name]) throw new Error("missing " + name); return files[name].buffer.slice(files[name].byteOffset, files[name].byteOffset + files[name].byteLength); },
        decodeImage: (bytes) => images[bytes.length] ?? (() => { throw new Error("image decode failed"); })(),
      },
      createCanvas: (w, h) => canvas2D(w, h, created),
      gpu: { dispatch: (op) => (op === "capture" ? Promise.resolve(new ArrayBuffer(640 * 360 * 4)) : {}) },
      debug: { register: (name, fn) => { registered[name] = fn; }, writeImage: (name, desc) => ({ path: "/art/" + name, ...desc }) },
    },
  };
}
function fakeRenderer() {
  const calls = [];
  return { calls, info: { render: { drawCalls: 3, triangles: 12 } }, init: async () => calls.push("init"), setPixelRatio: (r) => calls.push(["dpr", r]), setSize: (w, h) => calls.push(["size", w, h]), render: () => calls.push("render"), compileAsync: async () => calls.push("compile") };
}
function ticker() {
  const queue = [];
  let time = 0;
  return { requestFrame: (fn) => queue.push(fn), now: () => time, tick(ms = 16) { time += ms; const fns = queue.splice(0); for (const fn of fns) fn(time); return fns.length; } };
}

test("assetKey keeps paths inside the bundle", () => {
  assert.equal(assetKey("assets/ball.webp?x=1"), "assets/ball.webp");
  assert.equal(assetKey("./a/b.png"), "a/b.png");
  for (const bad of ["/etc/passwd", "../x", "a/../../b", "a\\b", ""]) assert.throws(() => assetKey(bad));
});

test("flipRows reverses row order", () => {
  const data = new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  assert.deepEqual([...flipRows(data, 1, 3)], [3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1]);
});

test("a game gets the contract's context and lifecycle on fun", async () => {
  const png = new Uint8Array([9, 9, 9]);
  const stub = funStub({ files: { "assets/x.png": png, "data.json": new TextEncoder().encode('{"a":1}') }, images: { 3: { width: 2, height: 2, data: new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]).buffer } } });
  const renderer = fakeRenderer();
  const clock = ticker();
  const events = [];
  let ctx;
  const module = {
    options: [{ id: "speed", section: "settings", type: "range", min: 1, max: 5, step: 1, default: 2, label: { zh: "速", en: "Speed" } }, { id: "god", section: "cheats", type: "toggle", label: { zh: "无敌", en: "God" } }],
    async createGame(context) {
      ctx = context;
      events.push("create");
      return {
        update(delta, elapsed) { events.push(["update", +delta.toFixed(3), +elapsed.toFixed(3)]); },
        resize(view) { events.push(["resize", view.width, view.height]); },
        pause() { events.push("pause"); }, resume() { events.push("resume"); },
        localeChanged(l) { events.push(["locale", l]); }, optionChanged(id, value) { events.push(["option", id, value]); },
        shareText: () => "  shared  ", dispose() { events.push("dispose"); },
      };
    },
  };
  const host = createFunHost({ fun: stub.fun, THREE, module, manifest: { id: "probe", title: { zh: "探针", en: "Probe" } }, locale: "zh", createRenderer: () => renderer, requestFrame: clock.requestFrame, runtimeModules: { "kit/x.js": async () => ({ x: 1 }) } });
  assert.equal(await host.start(), true);
  assert.equal(ctx.apiVersion, API_VERSION);
  assert.equal(ctx.locale, "zh");
  assert.equal(ctx.graphics.backend, "webgpu");
  assert.deepEqual(ctx.viewport, { width: 640, height: 360, pixelRatio: 1, safeArea: { top: 56, right: 0, bottom: 0, left: 0 } }, "the menu button reserves the top safe area, as on the web");
  assert.equal(ctx.asset("assets/x.png"), "assets/x.png");
  assert.deepEqual([...await ctx.readAsset("assets/x.png")], [9, 9, 9]);
  const image = await ctx.decodeImage(png, { imageOrientation: "flipY" });
  assert.deepEqual([image.width, image.height, [...image.data.slice(0, 4)]], [2, 2, [3, 3, 3, 3]], "rows flipped for flipY");
  assert.deepEqual(await ctx.runtime("kit/x.js"), { x: 1 });
  await assert.rejects(ctx.runtime("kit/nope.js"), TypeError);
  assert.equal(ctx.options.speed, 2);
  assert.equal(ctx.cheatsUsed, false);
  assert.deepEqual(events.slice(0, 3), ["create", ["locale", "zh"], ["resize", 640, 360]]);
  assert.equal(events[3], "resume");
  // Frames: delta 0 first, then clamped to 0.05.
  clock.tick(16); clock.tick(16); clock.tick(500);
  const updates = events.filter((e) => e[0] === "update");
  assert.deepEqual(updates.map((u) => u[1]), [0, 0.016, 0.05]);
  assert.equal(host.frames, 3);
  assert.equal(renderer.calls.filter((c) => c === "render").length >= 4, true, "resize draws once, frames draw");
  // Options: settings coerce, cheats mark the session.
  host.setOption("speed", 9);
  assert.equal(ctx.options.speed, 5);
  host.setOption("god", true);
  assert.equal(ctx.cheatsUsed, true);
  assert.deepEqual(events.filter((e) => e[0] === "option"), [["option", "speed", 5], ["option", "god", true]]);
  ctx.updateOption("speed", { max: 3 });
  assert.equal(ctx.options.speed, 3);
  // Pause stops frames; resume restarts with delta 0.
  host.setPaused(true);
  assert.equal(clock.tick(16), 1, "the pending frame callback returns without updating");
  assert.equal(host.frames, 3);
  host.setPaused(false);
  clock.tick(16);
  assert.equal(events.at(-1)[1], 0);
  assert.equal(host.shareText(), "shared");
  assert.deepEqual(host.stats().calls, 3);
  // Capture goes through fun:gpu and fun:debug; debug RPC registers the game methods.
  const receipt = await host.capture("shot.png");
  assert.equal(receipt.path, "/art/shot.png");
  assert.equal(host.registerDebug(), true);
  assert.deepEqual(Object.keys(stub.registered).sort(), ["game.capture", "game.key", "game.locale", "game.menu", "game.option", "game.pause", "game.quit", "game.reset", "game.restart", "game.resume", "game.stats"]);
  // Stop disposes the game once and aborts the signal.
  host.stop();
  assert.equal(ctx.signal.aborted, true);
  assert.equal(events.filter((e) => e === "dispose").length, 1);
  host.stop();
  assert.equal(events.filter((e) => e === "dispose").length, 1);
});

test("a createGame error stops the host and reports it", async () => {
  const stub = funStub();
  const errors = [];
  const host = createFunHost({ fun: stub.fun, THREE, module: { createGame() { throw new Error("boom"); } }, createRenderer: fakeRenderer, requestFrame: () => {}, onError: (e) => errors.push(e.message) });
  assert.equal(await host.start(), false);
  assert.deepEqual(errors, ["boom"]);
  assert.equal(host.signal.aborted, true);
});

test("on-demand games render only when invalidated", async () => {
  const stub = funStub();
  const clock = ticker();
  let ctx, updates = 0;
  const host = createFunHost({ fun: stub.fun, THREE, module: { createGame(c) { ctx = c; return { renderMode: "on-demand", update() { updates++; return false; } }; } }, createRenderer: fakeRenderer, requestFrame: clock.requestFrame });
  await host.start();
  clock.tick(); clock.tick(); clock.tick();
  assert.equal(updates, 1, "one frame, then the loop waits");
  ctx.invalidate();
  clock.tick();
  assert.equal(updates, 2);
});

test("the platform menu pauses, takes input, restarts and quits", async () => {
  const stub = funStub();
  const clock = ticker();
  const events = [];
  let launches = 0;
  const module = {
    options: [{ id: "speed", section: "settings", type: "range", min: 1, max: 5, step: 1, default: 2, label: { zh: "速", en: "Speed" } }],
    createGame(context) { launches++; events.push(["create", context.launchReason]); context.canvas.addEventListener("pointerdown", () => events.push("game-pointer")); return { pause() { events.push("pause"); }, resume() { events.push("resume"); }, optionChanged(id, v) { events.push(["option", id, v]); } }; },
  };
  globalThis.devicePixelRatio = 3;
  const host = createFunHost({ fun: stub.fun, THREE, module, manifest: { id: "lamp" }, createRenderer: fakeRenderer, requestFrame: clock.requestFrame });
  assert.equal(await host.start(), true);
  delete globalThis.devicePixelRatio;
  assert.equal(host.stats().pixelRatio, 2, "the pixel ratio is capped at 2, as on desktop web");
  assert.equal(stub.canvas.focused, true, "the canvas asks for keyboard focus");
  clock.tick();
  assert.equal(host.frames, 1);
  // A tap on the menu button opens the menu and pauses; the game does not see that tap.
  stub.canvas.dispatch("pointerdown", { clientX: 30, clientY: 28, pointerId: 1 });
  assert.equal(host.menuOpen, true);
  assert.equal(host.paused, true);
  assert.deepEqual(events.filter((e) => e === "pause" || e === "game-pointer"), ["pause"]);
  clock.tick();
  assert.equal(host.frames, 1, "no frames while paused");
  // Rows: resume, restart, sound, volume, language, speed, quit (no progress without storage). The first row resumes.
  stub.canvas.dispatch("pointerdown", { clientX: 200, clientY: 90, pointerId: 1 });
  assert.equal(host.menuOpen, false);
  assert.equal(events.at(-1), "resume");
  // Escape toggles; arrows and Enter pick "sound" (row 3) and mute.
  stub.canvas.dispatch("keydown", { code: "Escape" });
  assert.equal(host.menuOpen, true);
  stub.canvas.dispatch("keydown", { code: "ArrowDown" }); stub.canvas.dispatch("keydown", { code: "ArrowDown" }); stub.canvas.dispatch("keydown", { code: "Enter" });
  assert.equal(host.preferences.muted, true);
  // Row 6 (speed) adjusts with the arrows through the game's option.
  for (let i = 0; i < 3; i++) stub.canvas.dispatch("keydown", { code: "ArrowDown" });
  stub.canvas.dispatch("keydown", { code: "ArrowRight" });
  assert.deepEqual(events.at(-1), ["option", "speed", 3]);
  // A game pointer while the menu is open never reaches the game.
  stub.canvas.dispatch("pointerdown", { clientX: 600, clientY: 300, pointerId: 2 });
  assert.ok(!events.includes("game-pointer"));
  // Restart: a new session with launchReason "restart".
  assert.equal(await host.restart(), true);
  assert.equal(launches, 2);
  assert.deepEqual(events.filter((e) => e[0] === "create"), [["create", "open"], ["create", "restart"]]);
  assert.equal(host.menuOpen, false);
  clock.tick();
  assert.equal(host.frames, 2);
  // The game sees pointers again when the menu is closed.
  stub.canvas.dispatch("pointerdown", { clientX: 600, clientY: 300, pointerId: 3 });
  assert.ok(events.includes("game-pointer"));
  // Focus loss pauses without the menu; focus resumes.
  stub.canvas.dispatch("blur");
  assert.equal(host.paused, true); assert.equal(host.menuOpen, false);
  stub.canvas.dispatch("focus");
  assert.equal(host.paused, false);
  await host.quit();
  assert.equal(stub.printed.at(-1), "<quit>");
});

test("a string option label shows as itself in the menu", async () => {
  const stub = funStub();
  const module = { options: [{ id: "lvl", section: "settings", type: "choice", default: "a", label: "关卡", choices: [{ value: "a", label: "一" }, { value: "b", label: "二" }] }], createGame() { return {}; } };
  const host = createFunHost({ fun: stub.fun, THREE, module, createRenderer: fakeRenderer, requestFrame() {} });
  await host.start();
  host.menu("open");
  const labels = stub.created.map((c) => c.lastText);
  assert.ok(labels.includes("关卡：一"), labels.join(" | "));
});
