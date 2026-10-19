// The sample game through the fun host adapter (docs/hosts.md): what a published fun app's
// entry looks like. fun's modules are imported here and handed to the adapter; the runtime kit
// modules the game may ask for are bundled behind runtime(name). start() is not awaited at top
// level. After 40 frames the probe captures a PNG, reports and quits.
import * as THREE from "three/webgpu";
import { Window } from "fun:window";
import * as app from "fun:app";
import * as assets from "fun:assets";
import { createCanvas } from "fun:canvas";
import * as gpu from "fun:gpu";
import * as debug from "fun:debug";
import { createFunHost } from "../../site/runtime/fun/host.js";
import * as game from "./game.js";

// three/webgpu exports TSL, as the web player's THREE does.
const runtimeModules = {
  "kit/assets.js": () => import("../../site/runtime/kit/assets.js"),
  "kit/text.js": () => import("../../site/runtime/kit/text.js"),
  "kit/input.js": () => import("../../site/runtime/kit/input.js"),
  "kit/fun3d.js": () => import("../../site/runtime/kit/fun3d.js"),
  "kit/materials.js": () => import("../../site/runtime/kit/materials.js"),
  "kit/post.js": () => import("../../site/runtime/kit/post.js"),
  "kit/physics.js": () => Promise.all([import("../../site/runtime/kit/physics.js"), import("jolt-physics")]).then(([m, jolt]) => ({ ...m, createPhysics: (options = {}) => m.createPhysics({ loadJolt: () => jolt.default(), ...options }) })),
  "addons/GTAONode.js": () => import("three/examples/jsm/tsl/display/GTAONode.js"),
  "addons/BloomNode.js": () => import("three/examples/jsm/tsl/display/BloomNode.js"),
};
const log = (o) => console.log("probe " + JSON.stringify(o));
const results = [];
const host = createFunHost({
  fun: { Window, app, assets, createCanvas, gpu, debug }, THREE, module: game,
  manifest: { id: "fun-probe-game", title: { zh: "探针游戏", en: "Probe game" } }, locale: "zh", width: 512, height: 384,
  runtimeModules, storage: globalThis.navigator?.storage ?? null, onError: (error) => results.push({ step: "host error", ok: false, ms: 0, error: String(error?.stack || error).split("\n").slice(0, 3).join(" | ") }),
});
host.registerDebug();
const t0 = performance.now();
host.start().then(async (ok) => {
  results.push({ step: "host.start (createGame through the adapter)", ok: !!ok, ms: +(performance.now() - t0).toFixed(1), value: ok ? { frames: host.frames } : null });
  app.print(`fun-probe host: started ${ok}`);
  if (!ok) return finish();
  const wait = (frames) => new Promise((resolve, reject) => {
    const until = performance.now() + 8000;
    const poll = () => (host.frames >= frames ? resolve() : performance.now() > until ? reject(new Error(`only ${host.frames} frames`)) : setTimeout(poll, 20));
    poll();
  });
  try { await wait(20); host.setOption("tint", true); host.setLocale("en"); results.push({ step: "20 frames, then option + locale", ok: true, ms: 0, value: host.stats() }); }
  catch (e) { results.push({ step: "20 frames", ok: false, ms: 0, error: e.message }); }
  try {
    host.menu("open");
    const paused = host.paused && host.menuOpen;
    await new Promise((r) => setTimeout(r, 100));
    const receipt = await host.capture("menu.png");
    host.menu("close");
    results.push({ step: "platform menu: open pauses, captured, close resumes", ok: paused && !host.paused && !host.menuOpen, ms: 0, value: { png: receipt.path } });
  } catch (e) { results.push({ step: "platform menu", ok: false, ms: 0, error: e.message }); }
  try { await wait(40); const receipt = await host.capture("frame-0040.png"); results.push({ step: "40 frames, capture PNG", ok: true, ms: 0, value: { frames: host.frames, png: receipt.path, share: host.shareText() } }); }
  catch (e) { results.push({ step: "40 frames, capture", ok: false, ms: 0, error: e.message }); }
  host.setPaused(true); const f = host.frames; await new Promise((r) => setTimeout(r, 120));
  results.push({ step: "pause stops frames", ok: host.frames === f, ms: 0, value: { frames: host.frames } });
  finish();
}).catch((e) => { results.push({ step: "host.start", ok: false, ms: 0, error: String(e) }); finish(); });
function finish() {
  let stats = {};
  try { stats = gpu.dispatch("stats", 0, {}); } catch (e) { stats = { error: e.message }; }
  log({ results, globals: { AudioContext: typeof globalThis.AudioContext }, stats: { draws: stats.draws, uncapturederrors: stats.uncapturederrors, error: stats.error } });
  host.stop();
  app.print("fun-probe host done");
  app.quit();
}
