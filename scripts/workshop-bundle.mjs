import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The workshop for Node as one file (docs/model-editor.md "Agents without the repository"):
// the CLI / MCP adapter, the page's own modules, the software renderer, Three.js, manifold-3d
// and its WebAssembly. The site publishes it as tools/workshop-<hash>.mjs behind the launcher;
// the npm package fundev-workshop ships it as workshop.mjs. Page paths resolve to their sources
// here; imports of /editor/... inside page.evaluate run in the page and stay as they are, and
// Playwright is loaded only for --browser.
export async function bundleWorkshop(root) {
  const sitePaths = { name: "workshop-site-paths", setup(builder) {
    const three = fileURLToPath(new URL("node_modules/three/build/three.webgpu.js", root));
    builder.onResolve({ filter: /^\/(runtime\/three|vendor\/three\/three\.webgpu)\.js$/ }, () => ({ path: three }));
    builder.onResolve({ filter: /^\/editor\/tools\.js$/ }, () => ({ path: fileURLToPath(new URL("scripts/editor-tools.js", root)) }));
    builder.onResolve({ filter: /\/workshop-kernel\.mjs$/ }, () => ({ path: fileURLToPath(new URL("scripts/workshop-kernel-bundle.mjs", root)) }));
  } };
  const workshop = await build({
    entryPoints: [fileURLToPath(new URL("scripts/editor-agent.mjs", root))], write: false,
    bundle: true, platform: "node", format: "esm", target: "node22", external: ["playwright", "/editor/*"], minify: true, legalComments: "eof", logLevel: "error",
    loader: { ".wasm": "binary" }, plugins: [sitePaths],
    // A CommonJS dependency may still call require (Node built-ins): give the bundle one.
    banner: { js: 'import { createRequire as __workshopRequire } from "node:module"; const require = __workshopRequire(import.meta.url);' },
    define: {
      __WORKSHOP_BUNDLED__: "true",
      "process.env.FUNDEV_WORKSHOP_URL": JSON.stringify("https://fun.dev/editor/"),
      // --guide prints the quick reference without the repository.
      "process.env.FUNDEV_WORKSHOP_GUIDE": JSON.stringify(await readFile(new URL("docs/workshop-agents.md", root), "utf8")),
    },
  });
  return workshop.outputFiles[0].contents;
}
