// The runtime kit under fun's application host (docs/hosts.md): a real window, the kit's
// seams on fun's modules (fun:assets for bytes and images, the window canvas for 2D text),
// input events, and frames captured from the window. Run by scripts/fun-probe.mjs --app.
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { Window } from "fun:window";
import { print, quit } from "fun:app";
import { readBytes, decodeImage } from "fun:assets";
import { dispatch } from "fun:gpu";
import { writeImage } from "fun:debug";
import { createCanvas } from "fun:canvas";
import { createFun3d } from "../../site/runtime/kit/fun3d.js";
import { createMaterials } from "../../site/runtime/kit/materials.js";
import { createAssets, textureFromImage } from "../../site/runtime/kit/assets.js";
import { createText } from "../../site/runtime/kit/text.js";
import { createPointer, createActions } from "../../site/runtime/kit/input.js";
import modelBytes from "./model.fun3d";

const W = 512, H = 384;
const results = [];
const log = (o) => console.log("probe " + JSON.stringify(o));
async function step(name, fn) {
  const t = performance.now();
  try { const value = await fn(); results.push({ step: name, ok: true, ms: +(performance.now() - t).toFixed(1), value: value ?? null }); }
  catch (error) { results.push({ step: name, ok: false, ms: +(performance.now() - t).toFixed(1), error: String(error?.stack || error).split("\n").slice(0, 3).join(" | ") }); }
  print(`fun-probe step: ${name}: ${results.at(-1).ok ? "ok" : "FAIL"}`);
}
const probeGlobals = {};
for (const n of ["WebAssembly", "DecompressionStream", "CompressionStream", "createImageBitmap", "OffscreenCanvas", "fetch", "AudioContext", "structuredClone", "crypto", "atob", "requestAnimationFrame", "navigator", "self", "document", "window"]) probeGlobals[n] = typeof globalThis[n];
probeGlobals["navigator.storage"] = typeof navigator?.storage;

let appWindow, canvas, renderer, context;
await step("window + renderer", async () => {
  appWindow = new Window({ title: "fun-probe", width: W, height: H });
  canvas = appWindow.canvas;
  renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.setSize(canvas.width, canvas.height, false);
  context = canvas.getContext("webgpu");
  return { width: canvas.width, height: canvas.height, client: [canvas.clientWidth, canvas.clientHeight] };
});
const scene = new THREE.Scene(); scene.background = new THREE.Color("#dfe7f0");
const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 100); camera.position.set(4, 3, 7); camera.lookAt(0, 1.3, 0);
scene.add(new THREE.HemisphereLight("#ffffff", "#6b7280", 1.2));
const sun = new THREE.DirectionalLight("#fff4e0", 2.5); sun.position.set(3, 5, 2); scene.add(sun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(4, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#9aa6b2" }));
scene.add(ground);

// The fun host's seams, as the fun host adapter will provide them to games.
const hostContext = {
  THREE, signal: new AbortController().signal, track: (r) => r, onCleanup: () => {},
  asset: (path) => path,
  readAsset: async (path) => new Uint8Array(readBytes(path)),
  decodeImage: async (bytes, { mime } = {}) => { const { width, height, data } = decodeImage(bytes); return { width, height, data: new Uint8Array(data) }; },
  createCanvas2D: (w, h) => createCanvas(w, h),
  renderer, reportLoading: () => {},
};
let model;
await step("fun3d.load + render", async () => {
  model = await createFun3d({ THREE, materials: createMaterials({ THREE, TSL }) }).load(modelBytes, { warn: (w) => log({ warn: w }) });
  scene.add(model.root);
  renderer.render(scene, camera);
  return { nodes: model.nodes?.size ?? Object.keys(model.nodes ?? {}).length };
});
await step("assets.texture via fun:assets readBytes + decodeImage", async () => {
  const assets = createAssets(hostContext);
  const texture = await assets.texture("swatch.png");
  ground.material.map = texture; ground.material.needsUpdate = true;
  renderer.render(scene, camera);
  return { image: texture.image?.width + "x" + texture.image?.height, isDataTexture: !!texture.isDataTexture };
});
let label;
await step("text label on the window canvas", async () => {
  label = createText({ text: "fun 应用宿主", size: 28, sprite: true, background: "#ffffff", color: "#1a1a1a", padding: 6, unitsPerPixel: 0.01 }, { createCanvas2D: hostContext.createCanvas2D });
  label.object.position.set(0, 2.9, 0); scene.add(label.object);
  renderer.render(scene, camera);
  return { width: label.width, height: label.height };
});
const events = [];
await step("input listeners (kit/input.js on the window canvas)", async () => {
  const pointer = createPointer(canvas, { width: W, height: H, pixelRatio: 1 }, { signal: hostContext.signal });
  const actions = createActions({ jump: { keys: ["Space"] } }, { canvas, signal: hostContext.signal });
  for (const type of ["pointerdown", "pointerup", "keydown", "resize", "focus", "blur"]) canvas.addEventListener(type, (e) => events.push(type));
  return { pointer: Object.keys(pointer).slice(0, 5), actions: Object.keys(actions).slice(0, 5) };
});
// Frames through requestAnimationFrame, as three's setAnimationLoop does through `self`. The
// host starts driving frames only after this module's top-level evaluation has finished, so the
// loop is scheduled, not awaited; the report and quit() happen from inside it. A capture at frame
// 20 is written as PNG by fun:debug (the app device is host-owned: no saveFrame, no dispose).
let frames = 0, captured = null, loopError = null;
function finish() {
  results.push({ step: "30 rAF frames, capture at 20 as PNG", ok: !loopError && !!captured, ms: 0, value: loopError ? { error: loopError, frames } : { frames, ...captured } });
  label?.dispose();
  let stats = {};
  try { stats = dispatch("stats", 0, {}); } catch (e) { stats = { error: e.message }; }
  log({ results, globals: probeGlobals, events: [...new Set(events)], stats: { draws: stats.draws, uncapturederrors: stats.uncapturederrors, error: stats.error } });
  print("fun-probe app done");
  quit();
}
const stop = setTimeout(() => { loopError ??= `only ${frames} frames in 8 s`; finish(); }, 8000);
const tick = async () => {
  try {
    model.root.rotation.y += 0.02;
    renderer.render(scene, camera);
    frames++;
    if (frames === 20) {
      const pixels = await dispatch("capture", context._id, { overlay: false });
      const d = new Uint8Array(pixels); let drawn = 0; const bg = [d[0], d[1], d[2]];
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) drawn++;
      captured = { bytes: pixels.byteLength, drawn };
      try { captured.png = writeImage("frame-0020.png", { width: W, height: H, format: "bgra8unorm", alphaMode: "opaque", origin: "top-left", frame: 20, metadata: {} }, pixels).path; }
      catch (e) { captured.png = "error: " + e.message; }
    }
    if (frames >= 30) { clearTimeout(stop); finish(); return; }
    requestAnimationFrame(tick);
  } catch (e) { loopError = String(e?.stack || e).split("\n").slice(0, 2).join(" | "); clearTimeout(stop); finish(); }
};
requestAnimationFrame(tick);
