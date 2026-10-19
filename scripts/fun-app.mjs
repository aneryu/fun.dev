// A game bundle as a fun application (docs/hosts.md, "Delivery to fun"): the publisher's fun
// output. From a game.json it validates and collects the release like the web publisher
// (scripts/game-release.mjs), writes every non-code runtime file as a fun asset, and bundles
// the game's code with the fun host adapter and the runtime kit into one app.mjs.
//
//   node scripts/fun-app.mjs <game.json> [--out DIR] [--capture-at N] [--locale zh|en]
//   fun --bundle DIR/app.mjs --assets DIR/assets.json
//
// --capture-at N makes the app write frame-N.png to fun's artifact directory and quit after
// it: a self-check for agents (see scripts/fun-probe.mjs --game).
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { prepareRelease } from "./game-release.mjs";

const root = new URL("../", import.meta.url);
const here = fileURLToPath(root);
const CODE = /\.m?js$/;

export async function buildFunApp(manifestPath, { out, captureAt = null, locale = "zh" } = {}) {
  const release = await prepareRelease(manifestPath);
  const { game } = release;
  out = resolve(out ?? join(here, "dist", "fun", game.id));
  const gameRoot = dirname(resolve(manifestPath));
  await mkdir(join(out, "files"), { recursive: true });

  // Assets: every runtime file that is not code, by its bundle path, as fun's manifest lists them.
  const assets = [];
  for (const asset of release.assets) {
    if (CODE.test(asset.path)) continue;
    const target = join(out, "files", asset.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, asset.body);
    assets.push({ name: asset.path, source: target, bytes: asset.body.length, sha256: createHash("sha256").update(asset.body).digest("hex") });
  }
  await writeFile(join(out, "assets.json"), JSON.stringify({ assets }, null, 2));
  await writeFile(join(out, "game.json"), JSON.stringify(game, null, 2));

  // The entry: fun's modules, the adapter, the game, and every runtime module a game may ask for.
  const kit = (await readdir(join(here, "site/runtime/kit"))).filter((n) => n.endsWith(".js")).sort();
  const addons = { GLTFLoader: "loaders/GLTFLoader.js", DRACOLoader: "loaders/DRACOLoader.js", KTX2Loader: "loaders/KTX2Loader.js", MeshoptDecoder: "libs/meshopt_decoder.module.js", GTAONode: "tsl/display/GTAONode.js", BloomNode: "tsl/display/BloomNode.js" };
  // kit/physics.js loads Jolt by URL on the web; on fun the single-file build is bundled and
  // handed in as loadJolt, so a game's createPhysics({ THREE, scene }) works unchanged.
  const runtimeModules = [
    ...kit.map((n) => n === "physics.js"
      ? `  "kit/physics.js": () => Promise.all([import(${JSON.stringify(join(here, "site/runtime/kit/physics.js"))}), import("jolt-physics")]).then(([m, jolt]) => ({ ...m, createPhysics: (options = {}) => m.createPhysics({ loadJolt: () => jolt.default(), ...options }) })),`
      : `  "kit/${n}": () => import(${JSON.stringify(join(here, "site/runtime/kit", n))}),`),
    ...Object.entries(addons).map(([n, p]) => `  "addons/${n}.js": () => import(${JSON.stringify(join(here, "node_modules/three/examples/jsm", p))}),`),
  ].join("\n");
  const size = game.orientation === "portrait" ? [720, 1280] : [1280, 720];
  const entry = `import * as THREE from "three/webgpu";
import { Window } from "fun:window";
import * as app from "fun:app";
import * as assets from "fun:assets";
import { createCanvas } from "fun:canvas";
import * as gpu from "fun:gpu";
import * as debug from "fun:debug";
import { createFunHost } from ${JSON.stringify(join(here, "site/runtime/fun/host.js"))};
import * as game from ${JSON.stringify(join(gameRoot, "game.js"))};
const manifest = ${JSON.stringify(game)};
const runtimeModules = {
${runtimeModules}
};
const host = createFunHost({ fun: { Window, app, assets, createCanvas, gpu, debug }, THREE, module: game, manifest, locale: ${JSON.stringify(locale)}, width: ${size[0]}, height: ${size[1]}, runtimeModules });
host.registerDebug();
host.start().then((ok) => {
  app.print(\`fun app \${manifest.id} \${manifest.version}: \${ok ? "running" : "failed to start"}\`);
  if (!ok) { host.stop(); app.quit(); }
  ${captureAt === null ? "" : `else {
    // After N frames, or 5 s for on-demand games that draw only when invalidated.
    const until = performance.now() + 5000;
    const poll = () => host.frames >= ${captureAt} || performance.now() > until
      ? host.capture("frame-${captureAt}.png").then((r) => app.print("captured " + r.path + " after " + host.frames + " frames"), (e) => app.print("capture failed: " + e.message)).finally(() => { host.stop(); app.quit(); })
      : setTimeout(poll, 20);
    poll();
  }`}
});
`;
  await writeFile(join(out, "entry.mjs"), entry);

  const { build } = await import("esbuild");
  const three = (name) => join(here, "node_modules/three/build", name);
  const result = await build({
    bundle: true, format: "esm", target: "esnext", platform: "neutral", mainFields: ["module", "main"], conditions: ["import"],
    external: ["fun:*", "node:*"], loader: { ".wasm": "binary" }, logLevel: "warning", metafile: true,
    entryPoints: [join(out, "entry.mjs")], outfile: join(out, "app.mjs"), nodePaths: [join(here, "node_modules")],
    plugins: [{ name: "site", setup(b) {
      b.onResolve({ filter: /^\/vendor\/three\/three\.webgpu\.js$|^\/runtime\/three\.js$/ }, () => ({ path: three("three.webgpu.js") }));
      b.onResolve({ filter: /^\/runtime\/tsl\.js$/ }, () => ({ path: three("three.tsl.js") }));
      b.onResolve({ filter: /^jolt-physics\/dist\// }, (args) => ({ path: join(here, "node_modules", args.path) }));
      // The site's addons/ are built from Three.js examples (scripts/build-three.mjs); the kit's lazy imports map back.
      b.onResolve({ filter: /(^|\/)addons\/[A-Za-z0-9]+\.js$/ }, (args) => {
        const name = args.path.split("/").pop().replace(/\.js$/, "");
        return addons[name] ? { path: join(here, "node_modules/three/examples/jsm", addons[name]) } : null;
      });
      // Game code must not import platform modules: the contract keeps bundles self-contained.
      b.onResolve({ filter: /^\/(runtime|vendor|editor)\// }, (args) => (args.importer.startsWith(gameRoot) ? { errors: [{ text: `Game code imports a platform module: ${args.path}` }] } : null));
    } }],
  });
  const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
  return { out, game, assets: assets.length, appBytes: bytes, command: `fun --bundle ${join(out, "app.mjs")} --assets ${join(out, "assets.json")}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const manifestPath = args.find((a) => a.endsWith("game.json"));
  if (!manifestPath) { console.error("usage: node scripts/fun-app.mjs <game.json> [--out DIR] [--capture-at N] [--locale zh|en]"); process.exit(2); }
  const captureAt = option("--capture-at");
  if (captureAt !== undefined && !Number.isInteger(Number(captureAt))) { console.error("--capture-at needs a frame number."); process.exit(2); }
  const result = await buildFunApp(manifestPath, { out: option("--out"), captureAt: captureAt === undefined ? null : Number(captureAt), locale: option("--locale") ?? "zh" });
  console.log(`${result.game.id} ${result.game.version}: ${result.assets} assets, app.mjs ${(result.appBytes / 1048576).toFixed(1)} MB → ${result.out}\n${result.command}`);
}
