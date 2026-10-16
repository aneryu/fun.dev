import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build, transform } from "esbuild";
import { gameOrigin } from "./game-origin.mjs";
import { loadLocalGames, localCatalog } from "./local-games.mjs";
import { fileIndex } from "./game-release.mjs";
import { buildVision } from "./vision.mjs";
import { validateCatalog } from "../site/catalog.js";
import { addOriginToHeaders } from "./csp.mjs";
import { gamePages, sitemap } from "./game-pages.mjs";
import { chooseLocale, messages } from "../site/i18n.js";
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
await buildVision(root, output);
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
// Language before the first paint. Translated pages load this classic script twice: in <head> it
// picks the language and, when that is not the static Chinese, hides the marked texts; at the
// end of <body> it translates them and the language menu and shows them again. A visitor never
// sees one language flash to the other, however the HTML arrives. i18n.js takes over later.
const staticMessages = Object.fromEntries(Object.entries(messages).map(([locale, table]) =>
  [locale, Object.fromEntries(Object.entries(table).filter(([, value]) => typeof value === "string"))]));
await writeFile(new URL("i18n-boot.js", output), `(() => {
  const messages = ${JSON.stringify(staticMessages)};
  const chooseLocale = ${chooseLocale.toString()};
  let saved = null;
  try { saved = localStorage.getItem("fun.dev.language"); } catch { /* Preferences are optional. */ }
  const query = new URLSearchParams(location.search).get("lang");
  const preference = ["zh", "en"].includes(query) ? query : ["zh", "en"].includes(saved) ? saved : "auto";
  const locale = chooseLocale(preference, null, navigator.languages || []);
  const text = messages[locale];
  const root = document.documentElement;
  root.lang = locale === "zh" ? "zh-CN" : "en";
  if (!document.body) { if (locale !== "zh") root.dataset.i18nPending = ""; return; }
  for (const node of document.querySelectorAll("[data-i18n]")) if (text[node.dataset.i18n]) node.textContent = text[node.dataset.i18n];
  for (const [attribute, key] of [["aria-label", "i18nAria"], ["placeholder", "i18nPlaceholder"], ["content", "i18nContent"]]) {
    for (const node of document.querySelectorAll("[data-" + key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase()) + "]")) {
      if (text[node.dataset[key]]) node.setAttribute(attribute, text[node.dataset[key]]);
    }
  }
  const toggle = document.querySelector("#language-toggle");
  if (toggle) toggle.value = preference;
  delete root.dataset.i18nPending;
})();
`);
let catalog = [];
if (!origin) {
  // Local previews bundle each game's listed runtime files; development files stay in games/<id>/.
  const releases = await loadLocalGames();
  for (const { game, assets } of releases) {
    // The same layout the publisher uses: assets/ files as content-addressed blobs, code and
    // the cover under the version.
    for (const asset of assets) {
      const paths = [...(asset.blob ? [`blobs/${asset.blob}`] : []), ...(!asset.blob || asset.path === game.cover ? [`games/${game.id}/${game.version}/${asset.path}`] : [])];
      for (const path of paths) {
        const target = new URL(path, output);
        await mkdir(new URL("./", target), { recursive: true });
        await writeFile(target, asset.body);
      }
    }
    await writeFile(new URL(`games/${game.id}/${game.version}/files.json`, output), JSON.stringify(fileIndex(assets)));
  }
  catalog = localCatalog(releases);
  await writeFile(new URL("games.json", output), JSON.stringify(catalog, null, 2) + "\n");
} else {
  // The deployed website bundles no registry or games; it reads them from the R2 origin.
  const path = new URL("_headers", output);
  await writeFile(path, addOriginToHeaders(await readFile(path, "utf8"), origin));
  // Game pages need the live catalog: without them no game could be played, so a deploy stops.
  const response = await fetch(`${origin}/games.json`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Game pages need the live catalog: HTTP ${response.status}`);
  catalog = validateCatalog(await response.json());
}
// Each game's page at /games/<id> is the player template with its meta; the template itself is
// not a page.
const template = new URL("player/index.html", output);
for (const page of gamePages(catalog, await readFile(template, "utf8"), { origin })) {
  const target = new URL(page.path, output);
  await mkdir(new URL("./", target), { recursive: true });
  await writeFile(target, page.html);
}
await rm(template);
await writeFile(new URL("sitemap.xml", output), sitemap(catalog));

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
  .filter((path) => !/^\/(?:games\/[^/]+\/|blobs\/|skills\/|runtime\/vision\/|runtime\/addons\/(?:draco|basis)\/|vendor\/three\/LICENSE|_headers|_redirects|robots\.txt|sitemap\.xml|games\.json|sw\.js)/.test(path))
  .map((path) => path.replace(/(?:^|\/)index\.html$/, "/").replace(/^\/\//, "/").replace(/^(\/games(?:\/[^/]+)?)\.html$/, "$1"))
  .sort();
// Cached under the addresses pages are visited at: "/x/" for x/index.html, "/games" and
// "/games/<id>" for the lobby and game pages.
const fileOf = (path) => (path.endsWith("/") ? `${path}index.html` : /^\/games(?:\/[^/.]+)?$/.test(path) ? `${path}.html` : path);
const hash = createHash("sha256");
for (const path of shell) hash.update(path).update(await readFile(new URL(`.${fileOf(path)}`, output)));
const worker = new URL("sw.js", output);
await writeFile(worker, (await readFile(worker, "utf8")).replace(/^const BUILD = .*$/m, `const BUILD = ${JSON.stringify({ version: hash.digest("hex").slice(0, 16), shell, gameOrigin: origin })};`));
console.log("Built dist/ with the pinned, locally served Three.js runtime.");
