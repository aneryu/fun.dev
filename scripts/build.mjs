import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build, transform } from "esbuild";
import { gameOrigin } from "./game-origin.mjs";
import { loadLocalGames, localCatalog } from "./local-games.mjs";
import { validateCatalog } from "../site/catalog.js";
import { addOriginToHeaders } from "./csp.mjs";
import { sharePages } from "./share-pages.mjs";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { relative } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const output = new URL("dist/", root);
const origin = gameOrigin(process.env.FUNDEV_GAME_ORIGIN);
await rm(output, { recursive: true, force: true });
await cp(new URL("site/", root), output, { recursive: true });
const vendor = new URL("vendor/three/", output);
await mkdir(vendor, { recursive: true });
for (const name of ["three.module.js", "three.core.js"]) {
  const source = await readFile(new URL(`node_modules/three/build/${name}`, root), "utf8");
  const result = await transform(source, { loader: "js", minify: true, target: "es2022", legalComments: "eof" });
  await writeFile(new URL(name, vendor), result.code);
}
await cp(new URL("node_modules/three/LICENSE", root), new URL("LICENSE.txt", vendor));
// Shared loaders at the pinned Three.js version; their `three` import resolves to the platform runtime.
const addons = new URL("runtime/addons/", output);
await build({
  entryPoints: Object.fromEntries(["GLTFLoader", "DRACOLoader", "KTX2Loader"].map((name) => [name, fileURLToPath(new URL(`node_modules/three/examples/jsm/loaders/${name}.js`, root))])),
  outdir: fileURLToPath(addons), bundle: true, format: "esm", minify: true, target: "es2022", legalComments: "eof", logLevel: "warning",
  plugins: [{ name: "platform-three", setup(builder) { builder.onResolve({ filter: /^three$/ }, () => ({ path: "/runtime/three.js", external: true })); } }],
});
// Decoders load only when a game uses Draco or KTX2.
for (const [directory, files] of [["draco", ["draco_wasm_wrapper.js", "draco_decoder.wasm"]], ["basis", ["basis_transcoder.js", "basis_transcoder.wasm"]]]) {
  await mkdir(new URL(`${directory}/`, addons), { recursive: true });
  for (const file of files) await cp(new URL(`node_modules/three/examples/jsm/libs/${directory}/${file}`, root), new URL(`${directory}/${file}`, addons));
}
const skillFiles = ["SKILL.md", "agents/openai.yaml", "assets/game.js", "references/runtime.md", "references/release.md", "references/security.md"];
const skillOutput = new URL("skills/fun-dev-games/", output);
for (const file of skillFiles) {
  const target = new URL(file, skillOutput);
  await mkdir(new URL("./", target), { recursive: true });
  await cp(new URL(`skills/fun-dev-games/${file}`, root), target);
}
execFileSync("tar", ["-czf", fileURLToPath(new URL("skills/fun-dev-games.tar.gz", output)), "-C", fileURLToPath(new URL("skills/", output)), ...skillFiles.map((file) => `fun-dev-games/${file}`)]);
await writeFile(new URL("game-source.js", output), `export const gameOrigin = ${JSON.stringify(origin)};\n`);
await writeFile(new URL("progress-config.js", output), `export const transferProgress = ${process.env.FUNDEV_TRANSFER === "1"};\n`);
await writeFile(new URL("pwa-config.js", output), `export const serviceWorker = ${process.env.FUNDEV_NO_SW !== "1"};\n`);
let catalog = [];
if (!origin) {
  // Local previews bundle each game's listed runtime files; development files stay in games/<id>/.
  const releases = await loadLocalGames();
  for (const { game, assets } of releases) {
    for (const asset of assets) {
      const target = new URL(`games/${game.id}/${game.version}/${asset.path}`, output);
      await mkdir(new URL("./", target), { recursive: true });
      await writeFile(target, asset.body);
    }
    // The same file list the publisher writes beside each release, for offline caching.
    await writeFile(new URL(`games/${game.id}/${game.version}/files.json`, output), JSON.stringify({ files: assets.map((asset) => asset.path) }));
  }
  catalog = localCatalog(releases);
  await writeFile(new URL("games.json", output), JSON.stringify(catalog, null, 2) + "\n");
} else {
  // The deployed website bundles no registry or games; it reads them from the R2 origin.
  const path = new URL("_headers", output);
  await writeFile(path, addOriginToHeaders(await readFile(path, "utf8"), origin));
  // Share pages need the live catalog; without it, the 404 page forwards share links.
  try {
    const response = await fetch(`${origin}/games.json`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    catalog = validateCatalog(await response.json());
  } catch (error) { console.warn(`Share pages skipped: catalog unavailable (${error.message}).`); }
}
for (const page of sharePages(catalog, { origin })) {
  const target = new URL(page.path, output);
  await mkdir(new URL("./", target), { recursive: true });
  await writeFile(target, page.html);
}

// The service worker precaches the platform shell as one versioned set.
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}
const outputPath = fileURLToPath(output);
const shell = (await files(output))
  .map((file) => `/${relative(outputPath, fileURLToPath(file)).split("\\").join("/")}`)
  .filter((path) => !/^\/(?:games\/[^/]+\/|s\/|skills\/|runtime\/addons\/(?:draco|basis)\/|vendor\/three\/LICENSE|_headers|robots\.txt|sitemap\.xml|games\.json|sw\.js)/.test(path))
  .map((path) => path.replace(/(?:^|\/)index\.html$/, "/").replace(/^\/\//, "/"))
  .sort();
const hash = createHash("sha256");
for (const path of shell) hash.update(path).update(await readFile(new URL(`.${path.endsWith("/") ? `${path}index.html` : path}`, output)));
const worker = new URL("sw.js", output);
await writeFile(worker, (await readFile(worker, "utf8")).replace(/^const BUILD = .*$/m, `const BUILD = ${JSON.stringify({ version: hash.digest("hex").slice(0, 16), shell, gameOrigin: origin })};`));
console.log("Built dist/ with the pinned, locally served Three.js runtime.");
