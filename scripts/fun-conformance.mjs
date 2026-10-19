// Host conformance (docs/hosts.md, "Verification"): one game bundle rendered by the web player
// and by fun, the same frame compared pixel for pixel. Without a game.json it builds the demo
// (scripts/fun-probe/game.js with a model, a texture and HUD text, spin set to 0 so the scene
// is still). Masks exclude regions that legitimately differ (HUD text uses each host's fonts).
//
//   node scripts/fun-conformance.mjs [game.json] [--out DIR] [--mask x,y,w,h]... [--tolerance 8] [--strict]
//
// The web side uses Chromium through Playwright: WebGPU where the browser offers an adapter,
// otherwise the renderer's WebGL 2 backend (Linux ARM64 Chromium has no WebGPU; a strict run
// needs a browser with it). fun renders through Dawn. Writes web.png, fun.png, diff.png and
// side-by-side.png under the output directory and prints the agreement.
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
import sharp from "sharp";
import * as THREE from "three";
import { createFun3d } from "../site/runtime/kit/fun3d.js";
import { prepareRelease, fileIndex } from "./game-release.mjs";
import { localCatalog } from "./local-games.mjs";
import { gamePage } from "./game-pages.mjs";
import { buildFunApp } from "./fun-app.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = resolve(option("--out") ?? join(root, "test-results", "fun-conformance"));
const tolerance = Number(option("--tolerance") ?? 8);
const strict = args.includes("--strict");
const masks = args.flatMap((a, i) => (a === "--mask" ? [args[i + 1].split(",").map(Number)] : []));
let manifestPath = args.find((a) => a.endsWith("game.json"));
const W = 1280, H = 720;
const funRoot = process.env.FUN_ROOT ?? join(root, "..", "fun");
const funBin = process.env.FUN_BIN ?? `${funRoot}/build/linux-arm64/product/bin/fun`;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// The demo game: the probe's sample game as a bundle, with a still scene.
if (!manifestPath) {
  const game = join(out, "demo", "fun-demo");
  await mkdir(join(game, "assets"), { recursive: true });
  await cp(join(root, "scripts/fun-probe/game.js"), join(game, "game.js"));
  const { png, badge, lamp } = await demoAssets();
  await writeFile(join(game, "assets/swatch.png"), png);
  await writeFile(join(game, "assets/badge.png"), badge);
  await writeFile(join(game, "assets/model.fun3d"), await createFun3d({ THREE }).write(lamp, { kind: "model" }));
  await writeFile(join(game, "game.json"), JSON.stringify({
    id: "fun-demo", version: "1.0.0", apiVersion: 3, title: { zh: "宿主对比", en: "Host conformance" }, description: { zh: "同一游戏包在两个宿主上", en: "One bundle on two hosts" },
    category: { zh: "测试", en: "Test" }, platforms: ["desktop"], orientation: "landscape", howToPlay: { zh: "看", en: "Look" }, files: ["game.js", "assets/swatch.png", "assets/badge.png", "assets/model.fun3d"],
  }, null, 2));
  manifestPath = join(game, "game.json");
  if (!masks.length) masks.push([0, 0, 420, 160]); // the HUD labels: each host's fonts, and the web player's menu button and safe area
}
const release = await prepareRelease(manifestPath);
const { game } = release;
const stillSettings = { spin: 0 };

// Web: a copy of dist with the game injected the way the build injects local games.
console.log("web: rendering in Chromium …");
const dist = join(root, "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("dist/ is missing; run npm run build first.");
const web = join(out, "web-dist");
await cp(dist, web, { recursive: true });
for (const asset of release.assets) {
  const paths = [...(asset.blob ? [`blobs/${asset.blob}`] : []), ...(!asset.blob || asset.path === game.cover ? [`games/${game.id}/${game.version}/${asset.path}`] : [])];
  for (const path of paths) { await mkdir(dirname(join(web, path)), { recursive: true }); await writeFile(join(web, path), asset.body); }
}
await writeFile(join(web, `games/${game.id}/${game.version}/files.json`), JSON.stringify(fileIndex(release.assets)));
await writeFile(join(web, "games.json"), JSON.stringify(localCatalog([release])));
// The game's page, as the build writes one per game (/games/<id> serves games/<id>.html).
await writeFile(join(web, `games/${game.id}.html`), gamePage(await readFile(join(root, "site/player/index.html"), "utf8"), game));
const { launch, serve, running } = await import("./browser/harness.mjs");
const server = await serve(web);
let webBackend = "?";
try {
  let browser = await launch({ webgpu: true });
  let page = await browser.newPage();
  const hasGPU = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter?.()));
  if (!hasGPU) { await browser.close(); browser = await launch(); }
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await context.addInitScript(([id, settings]) => localStorage.setItem(`fun.dev.settings.${id}`, JSON.stringify(settings)), [game.id, stillSettings]);
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${server.base}/games/${game.id}?lang=zh&debug=1`);
  await running(page);
  await page.waitForTimeout(2500);
  webBackend = await page.evaluate(() => document.querySelector("#debug-panel")?.textContent.match(/\b(webgpu|webgl)\b/)?.[1] ?? "?");
  await page.evaluate(() => { document.querySelector("#debug-panel")?.remove(); });
  await page.locator(".game-surface canvas").screenshot({ path: join(out, "web.png") });
  if (errors.length) console.log("web page errors:", errors.join(" | "));
  await browser.close();
} finally { server.close(); }

// fun: the publisher's app with a capture baked in, a data directory seeded with the settings.
console.log("fun: rendering through Dawn …");
const app = await buildFunApp(manifestPath, { out: join(out, "fun-app"), captureAt: 30 });
const data = join(out, "fun-data"), run = join(out, "fun-run");
await mkdir(join(data, "games", game.id), { recursive: true, mode: 0o700 });
await writeFile(join(data, "games", game.id, "settings.json"), JSON.stringify(stillSettings));
await mkdir(run, { recursive: true });
const env = { ...process.env, FUN_GRAPHICS_DISPLAY: "1" };
if (!env.VK_DRIVER_FILES && existsSync("/usr/share/vulkan/icd.d/nvidia_icd.json")) env.VK_DRIVER_FILES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
const result = spawnSync("xvfb-run", ["-a", "-s", `-screen 0 ${W}x${H + 240}x24`, funBin, "--bundle", join(app.out, "app.mjs"), "--assets", join(app.out, "assets.json"), "--no-watch", "--run-seconds", "60", "--artifact-root", run, "--data-root", data], { env, encoding: "utf8", timeout: 120000, maxBuffer: 64 << 20 });
await writeFile(join(run, "run.log"), (result.stdout ?? "") + (result.stderr ?? ""));
const captured = (result.stdout ?? "").match(/captured (\S+\.png)/)?.[1];
if (!captured) throw new Error(`fun did not capture a frame (exit ${result.status}); see ${run}/run.log`);
await cp(captured, join(out, "fun.png"));

// Compare.
const raw = async (file) => { const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, width: info.width, height: info.height }; };
const a = await raw(join(out, "web.png")), b = await raw(join(out, "fun.png"));
if (a.width !== b.width || a.height !== b.height) throw new Error(`sizes differ: web ${a.width}x${a.height}, fun ${b.width}x${b.height}`);
const masked = (x, y) => masks.some(([mx, my, mw, mh]) => x >= mx && x < mx + mw && y >= my && y < my + mh);
const diff = Buffer.alloc(a.width * a.height * 4);
let compared = 0, within = 0, within24 = 0, sum = 0, worst = 0;
for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
  const i = (y * a.width + x) * 4;
  if (masked(x, y)) { diff[i] = 40; diff[i + 1] = 40; diff[i + 2] = 80; diff[i + 3] = 255; continue; }
  const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
  compared++; sum += d; if (d <= tolerance) within++; if (d <= 24) within24++; if (d > worst) worst = d;
  const v = Math.min(255, d * 4); diff[i] = v; diff[i + 1] = v; diff[i + 2] = v; diff[i + 3] = 255;
}
await sharp(diff, { raw: { width: a.width, height: a.height, channels: 4 } }).png().toFile(join(out, "diff.png"));
await sharp({ create: { width: a.width * 2, height: a.height, channels: 4, background: "#000" } })
  .composite([{ input: join(out, "web.png"), left: 0, top: 0 }, { input: join(out, "fun.png"), left: a.width, top: 0 }]).png().toFile(join(out, "side-by-side.png"));
const pct = (n) => `${(100 * n / compared).toFixed(2)}%`;
console.log(`game ${game.id} ${game.version}, ${a.width}x${a.height}, web backend ${webBackend}, fun backend webgpu (Dawn)`);
console.log(`compared ${compared} pixels (${masks.length} mask${masks.length === 1 ? "" : "s"}): within ${tolerance}: ${pct(within)}; within 24: ${pct(within24)}; mean |diff| ${(sum / compared).toFixed(2)}; worst ${worst}`);
console.log(`images: ${out}/{web,fun,diff,side-by-side}.png`);
if (strict && within / compared < 0.99) { console.log("strict: less than 99% of pixels agree"); process.exit(1); }

async function demoAssets() {
  const { deflateSync } = await import("node:zlib");
  const table = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (buf) => { let c = -1; for (const x of buf) c = table[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const td = Buffer.concat([Buffer.from(type), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const w = 8, h = 8, rows = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set(((x >> 1) + (y >> 1)) % 2 ? [230, 120, 60, 255] : [60, 120, 200, 255], y * (w * 4 + 1) + 1 + x * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  // A ring with a soft alpha edge, straight alpha: the hosts must agree on transparent textures.
  const bs = 64, brows = Buffer.alloc((bs * 4 + 1) * bs);
  for (let y = 0; y < bs; y++) for (let x = 0; x < bs; x++) { const d = Math.hypot(x + 0.5 - bs / 2, y + 0.5 - bs / 2) / (bs / 2); const ring = Math.max(0, 1 - Math.abs(d - 0.7) / 0.25); brows.set([240, 60, 90, Math.round(255 * Math.min(1, ring * 1.4))], y * (bs * 4 + 1) + 1 + x * 4); }
  const bihdr = Buffer.alloc(13); bihdr.writeUInt32BE(bs, 0); bihdr.writeUInt32BE(bs, 4); bihdr[8] = 8; bihdr[9] = 6;
  const badge = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", bihdr), chunk("IDAT", deflateSync(brows)), chunk("IEND", Buffer.alloc(0))]);
  const lamp = new THREE.Group(); lamp.name = "street_lamp";
  const metal = new THREE.MeshStandardMaterial({ name: "mat_metal", color: "#4a5560", roughness: 0.4, metalness: 1 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 2.4, 12).translate(0, 1.2, 0), metal); post.name = "post";
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.05).translate(0.3, 2.35, 0), metal); arm.name = "arm";
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.18).translate(0.55, 2.3, 0), new THREE.MeshStandardMaterial({ name: "mat_lamp", color: "#fff1c4", emissive: "#ffe9a8", emissiveIntensity: 4 })); head.name = "head";
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.1, 12).translate(0, 0.05, 0), new THREE.MeshStandardMaterial({ name: "mat_stone", color: "#8d8a80", roughness: 0.9 })); base.name = "base";
  lamp.add(post, arm, head, base);
  return { png, badge, lamp };
}
