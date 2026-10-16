import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Builds the review console's static files (console/) into dist-console/ for the console Worker
// (wrangler.console.jsonc, docs/models.md). The model viewer and Three.js are bundled in, so the
// console needs nothing from the public site.
const root = new URL("../", import.meta.url);
const output = new URL("dist-console/", root);
const three = (path) => fileURLToPath(new URL(`node_modules/three/${path}`, root));
const runtime = { "/runtime/three.js": three("build/three.module.js"), "/runtime/addons/GLTFLoader.js": three("examples/jsm/loaders/GLTFLoader.js"), "/runtime/addons/OrbitControls.js": three("examples/jsm/controls/OrbitControls.js") };
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ["index.html", "console.css", "_headers"]) await cp(new URL(`console/${name}`, root), new URL(name, output));
await build({
  entryPoints: [fileURLToPath(new URL("console/console.js", root))], outfile: fileURLToPath(new URL("console.js", output)),
  bundle: true, format: "esm", minify: true, target: "es2022", legalComments: "eof", logLevel: "warning",
  plugins: [{ name: "platform-runtime", setup(builder) {
    builder.onResolve({ filter: /^\/runtime\// }, (args) => ({ path: runtime[args.path] ?? args.path }));
    builder.onResolve({ filter: /^three$/ }, () => ({ path: runtime["/runtime/three.js"] }));
  } }],
});
console.log("Built dist-console/ for the console Worker.");
