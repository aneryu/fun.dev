// The runtime kit on fun's graphics runner (docs/hosts.md, "Verification"): every kit feature a
// game uses, each as one step that passes or records its error, and the frames it draws saved
// for inspection. Bundled by scripts/fun-probe.mjs; the model is written by that script too.
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { createCanvas, pumpAnimationFrame } from "fun:canvas";
import { dispatch } from "fun:gpu";
import { done } from "fun:result";
import { createFun3d } from "../../site/runtime/kit/fun3d.js";
import { createMaterials } from "../../site/runtime/kit/materials.js";
import { createModels } from "../../site/runtime/kit/models.js";
import { createLightSlots } from "../../site/runtime/kit/lights.js";
import { createPost } from "../../site/runtime/kit/post.js";
import { createText } from "../../site/runtime/kit/text.js";
import { createPhysics } from "../../site/runtime/kit/physics.js";
import { createAnimator } from "../../site/runtime/kit/animation.js";
import { createFixedStep } from "../../site/runtime/kit/loop.js";
import { createRandom } from "../../site/runtime/kit/random.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
// The single-file build: the wasm is embedded and decoded without fetch, which fun has no need to offer.
import joltFactory from "jolt-physics";
import modelBytes from "./model.fun3d";
import meshoptBytes from "./model-meshopt.fun3d";

const W = 512, H = 384;
const results = [];
const log = (o) => console.log("probe " + JSON.stringify(o));
async function step(name, fn) {
  const t = performance.now();
  try { const value = await fn(); results.push({ step: name, ok: true, ms: +(performance.now() - t).toFixed(1), value: value ?? null }); }
  catch (error) { results.push({ step: name, ok: false, ms: +(performance.now() - t).toFixed(1), error: String(error?.stack || error).split("\n").slice(0, 3).join(" | ") }); }
}
const now = () => performance.now();
async function completeQueue(renderer) { const q = renderer.backend?.device?.queue; if (q?.onSubmittedWorkDone) await q.onSubmittedWorkDone(); }
let frame = 0;
async function capture(renderer, context, label) {
  await completeQueue(renderer);
  pumpAnimationFrame(now());
  const pixels = await dispatch("capture", context._id, { overlay: false });
  if (!(pixels instanceof ArrayBuffer) || pixels.byteLength !== W * H * 4) throw new Error("capture size " + pixels?.byteLength);
  const d = new Uint8Array(pixels); let drawn = 0; const bg = [d[0], d[1], d[2]];
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) drawn++;
  dispatch("saveFrame", 0, { index: frame, width: W, height: H }, pixels);
  log({ frame: frame++, label, drawnPixels: drawn, of: W * H });
}
const probeGlobals = {};
for (const n of ["WebAssembly", "DecompressionStream", "CompressionStream", "createImageBitmap", "OffscreenCanvas", "fetch", "AudioContext", "structuredClone", "crypto", "Worker", "atob"]) probeGlobals[n] = typeof globalThis[n];

const canvas = createCanvas(W, H);
let renderer, context;
await step("renderer.init", async () => {
  renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.setSize(W, H, false);
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  context = canvas.getContext("webgpu");
  pumpAnimationFrame(now());
  return { backend: renderer.backend?.constructor?.name };
});
const scene = new THREE.Scene(); scene.background = new THREE.Color("#dfe7f0");
const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 100); camera.position.set(4, 3, 7); camera.lookAt(0, 1.3, 0);
scene.add(new THREE.HemisphereLight("#ffffff", "#6b7280", 1.2));
const sun = new THREE.DirectionalLight("#fff4e0", 2.5); sun.position.set(3, 5, 2); scene.add(sun);
scene.add(new THREE.Mesh(new THREE.CircleGeometry(4, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#9aa6b2" })));

let fun3d, materials, model;
await step("materials (TSL)", async () => { materials = createMaterials({ THREE, TSL }); return Object.keys(materials); });
await step("fun3d.load", async () => {
  fun3d = createFun3d({ THREE, materials });
  model = await fun3d.load(modelBytes, { warn: (m) => log({ warn: m }) });
  return { nodes: model.nodes?.size ?? Object.keys(model.nodes ?? {}).length, warnings: model.warnings?.length };
});
await step("render", async () => { scene.add(model.root); renderer.render(scene, camera); await capture(renderer, context, "model"); });
await step("render x3", async () => {
  for (let i = 0; i < 3; i++) { model.root.rotation.y += 0.4; renderer.render(scene, camera); await completeQueue(renderer); pumpAnimationFrame(now()); }
  await capture(renderer, context, "rotated");
});
await step("models.place batched x12", async () => {
  const models = createModels({ THREE, TSL, materials, scene, warn: (m) => log({ warn: "models: " + m }) });
  const rand = createRandom(7);
  for (let i = 0; i < 12; i++) models.place(model, { position: [(i % 4) - 1.5 + rand.float(-0.2, 0.2), 0, Math.floor(i / 4) - 1], batch: true });
  models.update(camera, { height: H });
  renderer.render(scene, camera);
  await capture(renderer, context, "batched");
});
await step("light slots", async () => {
  const slots = createLightSlots({ THREE, scene, kind: "point", count: 4, shadows: 0, tier: "high" });
  slots.update(1 / 60, camera.position, [{ id: "a", x: 1, y: 1, z: 1, intensity: 300, range: 6, color: "#ffb060" }, { id: "b", x: -1, y: 1, z: -1, intensity: 200, range: 6, color: "#60a0ff" }]);
  renderer.render(scene, camera);
  await capture(renderer, context, "light-slots");
  slots.dispose();
});
await step("post (ao, bloom, grade)", async () => {
  const addons = { "addons/GTAONode.js": () => import("three/examples/jsm/tsl/display/GTAONode.js"), "addons/BloomNode.js": () => import("three/examples/jsm/tsl/display/BloomNode.js") };
  let pipeline = null;
  const ctx = { THREE, signal: new AbortController().signal, track: (r) => r, onCleanup: () => {}, renderer, scene, camera, graphics: { backend: "webgpu", tier: "high" }, runtime: (n) => addons[n]?.() ?? Promise.reject(new Error("no runtime module " + n)), setRenderPipeline: (p) => { pipeline = p; }, viewport: { width: W, height: H, pixelRatio: 1 } };
  const post = await createPost(ctx, { ao: true, bloom: { strength: 0.6 }, grade: { saturation: 1.1 } });
  pipeline.render(); await completeQueue(renderer); pumpAnimationFrame(now());
  pipeline.render();
  await capture(renderer, context, "post");
  post.dispose?.();
});
await step("fun3d.load (meshopt streams, WebAssembly decoder)", async () => {
  const m = await createFun3d({ THREE, materials, decoder: MeshoptDecoder }).load(meshoptBytes, { warn: (w) => log({ warn: w }) });
  return { nodes: m.nodes?.size ?? Object.keys(m.nodes ?? {}).length };
});
await step("text drawn on a 2D canvas, rendered as a sprite", async () => {
  const label = createText({ text: "功德 +1 fun", size: 28, sprite: true, background: "#ffffff", color: "#1a1a1a", padding: 6, unitsPerPixel: 0.01 }, { createCanvas2D: (w, h) => createCanvas(w, h) });
  label.object.position.set(0, 2.9, 0);
  scene.add(label.object);
  renderer.render(scene, camera);
  await capture(renderer, context, "text");
  label.dispose();
  return { width: label.width, height: label.height };
});
await step("animation kit", async () => Object.keys(createAnimator({ THREE }, model)));
await step("fixed step", async () => { const s = createFixedStep({ step: 1 / 60 }); let n = 0; s.advance(0.1, () => n++); return { steps: n }; });
await step("physics: Jolt (single-file WebAssembly), a body falls", async () => {
  const physics = await createPhysics({ THREE, scene, loadJolt: () => joltFactory() });
  const body = physics.add(model);
  physics.addStatic({ type: "box", halfExtents: [20, 0.5, 20] }, { position: [0, -0.5, 0] });
  const before = model.root.position.y;
  for (let i = 0; i < 60; i++) physics.step(1 / 60);
  const after = model.root.position.y;
  physics.dispose();
  return { bodies: Object.keys(body ?? {}).slice(0, 4), before: +before.toFixed(3), after: +after.toFixed(3) };
});
await step("fun3d.write", async () => (await fun3d.write(model.root)).length);
const stats = dispatch("stats", 0, {});
log({ results, globals: probeGlobals, stats: { draws: stats.draws, uncapturederrors: stats.uncapturederrors } });
renderer.dispose();
done();
