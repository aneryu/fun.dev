// Runs the runtime kit on fun, the native runtime (docs/hosts.md): writes a small .fun3d model,
// bundles scripts/fun-probe/entry.mjs with this checkout's Three.js, runs it on fun's graphics
// runner, prints each step's result and converts the captured frames to PNG.
//
//   node scripts/fun-probe.mjs [--out DIR]          # the graphics runner (development build)
//   node scripts/fun-probe.mjs --app [--out DIR]    # the application host: a window under Xvfb (product build)
//   node scripts/fun-probe.mjs --host [--out DIR]   # the sample game through the fun host adapter, in a window
//   FUN_ROOT (default ../fun), FUN_BIN (default $FUN_ROOT/build/linux-arm64/dev/bin/fun),
//   FUN_V8_MANIFEST (default $FUN_ROOT/.deps/linux-arm64/packages/V8/manifest.json),
//   VK_DRIVER_FILES (default the NVIDIA ICD when present).
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import * as THREE from "three";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { createFun3d } from "../site/runtime/kit/fun3d.js";

const root = new URL("../", import.meta.url);
const outArg = process.argv.indexOf("--out");
const out = resolve(outArg > 0 ? process.argv[outArg + 1] : fileURLToPath(new URL("test-results/fun-probe/", root)));
const funRoot = process.env.FUN_ROOT ?? fileURLToPath(new URL("../fun/", root));
const hostMode = process.argv.includes("--host");
const app = process.argv.includes("--app") || hostMode;
const funBin = process.env.FUN_BIN ?? `${funRoot}/build/linux-arm64/${app ? "product" : "dev"}/bin/fun`;
const manifest = process.env.FUN_V8_MANIFEST ?? `${funRoot}/.deps/linux-arm64/packages/V8/manifest.json`;
if (!existsSync(funBin)) { console.error(`fun binary not found: ${funBin}`); process.exit(2); }
await mkdir(out, { recursive: true });

const table = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
/** An RGBA PNG from a pixel function. */
function png(w, h, pixel) {
  const rows = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}


/** A ring with a soft alpha edge, straight alpha. */
function badgePNG(size = 64) {
  return png(size, size, (x, y) => {
    const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
    const ring = Math.max(0, 1 - Math.abs(d - 0.7) / 0.25);
    const a = Math.round(255 * Math.min(1, ring * 1.4));
    return [240, 60, 90, a];
  });
}

// A model with several materials, emission and a hull, written once raw and once with meshopt.
function lamp() {
  const group = new THREE.Group(); group.name = "street_lamp";
  const metal = new THREE.MeshStandardMaterial({ name: "mat_metal", color: "#4a5560", roughness: 0.4, metalness: 1 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 2.4, 12).translate(0, 1.2, 0), metal); post.name = "post";
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.05).translate(0.3, 2.35, 0), metal); arm.name = "arm";
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.18).translate(0.55, 2.3, 0), new THREE.MeshStandardMaterial({ name: "mat_lamp", color: "#fff1c4", emissive: "#ffe9a8", emissiveIntensity: 4 })); head.name = "head";
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.1, 12).translate(0, 0.05, 0), new THREE.MeshStandardMaterial({ name: "mat_stone", color: "#8d8a80", roughness: 0.9 })); base.name = "base";
  group.add(post, arm, head, base);
  return group;
}
const physics = { shapes: [{ id: "post", type: "box", halfExtents: [0.2, 1.2, 0.2] }], bodies: [{ id: "lamp", node: "street_lamp", shape: "post", motion: "dynamic", mass: 12 }] };
const here = new URL("./", import.meta.url);
await writeFile(new URL("fun-probe/model.fun3d", here), await createFun3d({ THREE }).write(lamp(), { kind: "model", physics }));
await MeshoptEncoder.ready;
await writeFile(new URL("fun-probe/model-meshopt.fun3d", here), await createFun3d({ THREE, encoder: MeshoptEncoder }).write(lamp(), { kind: "model" }));
await mkdir(`${out}/assets`, { recursive: true });
await mkdir(`${out}/data`, { recursive: true, mode: 0o700 });
await writeFile(`${out}/assets/swatch.png`, png(4, 4, (x, y) => [x < 2 ? 220 : 40, y < 2 ? 200 : 60, 90, 255]));
// The sample game reads its files as a bundle would: under assets/.
await mkdir(`${out}/assets/assets`, { recursive: true });
await writeFile(`${out}/assets/assets/swatch.png`, png(8, 8, (x, y) => [((x >> 1) + (y >> 1)) % 2 ? 230 : 60, 120, ((x >> 1) + (y >> 1)) % 2 ? 60 : 200, 255]));
await writeFile(`${out}/assets/assets/model.fun3d`, await readFile(new URL("fun-probe/model.fun3d", here)));
await writeFile(`${out}/assets/assets/badge.png`, badgePNG());

const { build } = await import("esbuild");
const three = (name) => fileURLToPath(new URL(`node_modules/three/build/${name}`, root));
const bundle = `${out}/probe.mjs`;
await build({
  bundle: true, format: "esm", target: "esnext", platform: "neutral", mainFields: ["module", "main"], conditions: ["import"],
  external: ["fun:*", "node:*"], loader: { ".fun3d": "binary", ".wasm": "binary" }, logLevel: "warning",
  entryPoints: [fileURLToPath(new URL(hostMode ? "fun-probe/host-entry.mjs" : app ? "fun-probe/app-entry.mjs" : "fun-probe/entry.mjs", here))], outfile: bundle,
  nodePaths: [fileURLToPath(new URL("node_modules", root))],
  plugins: [{ name: "site", setup(b) {
    b.onResolve({ filter: /^\/vendor\/three\/three\.webgpu\.js$|^\/runtime\/three\.js$/ }, () => ({ path: three("three.webgpu.js") }));
    b.onResolve({ filter: /^\/runtime\/tsl\.js$/ }, () => ({ path: three("three.tsl.js") }));
    // The site's addons/ are built from Three.js examples (scripts/build-three.mjs); map them back.
    const addons = { GLTFLoader: "loaders/GLTFLoader.js", DRACOLoader: "loaders/DRACOLoader.js", KTX2Loader: "loaders/KTX2Loader.js", MeshoptDecoder: "libs/meshopt_decoder.module.js", GTAONode: "tsl/display/GTAONode.js", BloomNode: "tsl/display/BloomNode.js" };
    b.onResolve({ filter: /(^|\/)addons\/[A-Za-z0-9]+\.js$/ }, (args) => {
      const name = args.path.split("/").pop().replace(/\.js$/, "");
      return addons[name] ? { path: fileURLToPath(new URL(`node_modules/three/examples/jsm/${addons[name]}`, root)) } : null;
    });
    // The package's exports map hides dist/; the wasm bytes are bundled for hosts without fetch.
    b.onResolve({ filter: /^jolt-physics\/dist\// }, (args) => ({ path: fileURLToPath(new URL(`node_modules/${args.path}`, root)) }));
  } }],
});

const env = { ...process.env };
if (!env.VK_DRIVER_FILES && existsSync("/usr/share/vulkan/icd.d/nvidia_icd.json")) env.VK_DRIVER_FILES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
const command = app
  ? ["xvfb-run", "-a", "-s", "-screen 0 1280x960x24", funBin, "--bundle", bundle, "--no-watch", "--run-seconds", "40", "--width", "512", "--height", "384", "--title", "fun-probe", "--asset-root", `${out}/assets`, "--artifact-root", out, "--data-root", `${out}/data`]
  : [funBin, "--test", "fun_graphics_runner", "--manifest", manifest, "--bundle", bundle, "--mode", "normal"];
if (app && !env.FUN_GRAPHICS_DISPLAY) env.FUN_GRAPHICS_DISPLAY = "1";
const run = spawnSync(command[0], command.slice(1), { cwd: out, env, encoding: "utf8", timeout: 300000, maxBuffer: 64 << 20 });
await writeFile(`${out}/run.log`, (run.stdout ?? "") + (run.stderr ?? ""));
let report = null;
for (const line of (run.stdout ?? "").split("\n")) {
  const text = line.replace(/^(log )+/, "");
  if (!text.startsWith("probe ")) continue;
  const entry = JSON.parse(text.slice(6));
  if (entry.results) report = entry;
  else if (entry.frame !== undefined) console.log(`frame ${entry.frame} ${entry.label}: ${entry.drawnPixels} drawn pixels`);
  else if (entry.warn) console.log(`warn: ${entry.warn}`);
}
if (!report) { console.error(`no probe report; exit ${run.status}. See ${out}/run.log`); process.exit(1); }
let failed = 0;
for (const r of report.results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.step.padEnd(36)} ${String(r.ms).padStart(7)} ms  ${r.ok ? JSON.stringify(r.value) ?? "" : r.error ?? JSON.stringify(r.value)}`);
}
console.log(`globals: ${Object.entries(report.globals).map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`gpu: draws ${report.stats.draws}, uncaptured errors ${report.stats.uncapturederrors}; runner exit ${run.status}`);

// PPM frames to PNG, for a look.
for (const name of (await readdir(out)).filter((n) => /^frame-\d{4}\.ppm$/.test(n)).sort()) {
  const ppm = await readFile(`${out}/${name}`);
  const header = ppm.toString("latin1", 0, 40).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
  const w = +header[1], h = +header[2], off = header[0].length;
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) ppm.copy(rows, y * (w * 3 + 1) + 1, off + y * w * 3, off + (y + 1) * w * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  await writeFile(`${out}/${name.replace(".ppm", ".png")}`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
}
console.log(`frames and log in ${out}`);
process.exit(failed ? 1 : 0);
