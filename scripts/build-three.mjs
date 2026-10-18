import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

// Both the complete site and the independent editor preview use exactly these artifacts.
export async function buildThree(root, output) {
  const vendor = new URL("vendor/three/", output);
  await mkdir(vendor, { recursive: true });
  for (const name of ["three.core.js", "three.webgpu.js"]) {
    const source = await readFile(new URL(`node_modules/three/build/${name}`, root), "utf8");
    const result = await transform(source, { loader: "js", minify: true, target: "es2022", legalComments: "eof" });
    await writeFile(new URL(name, vendor), result.code);
  }
  await cp(new URL("node_modules/three/LICENSE", root), new URL("LICENSE.txt", vendor));
  const platform = { name: "platform-three", setup(builder) {
    builder.onResolve({ filter: /^three(?:\/webgpu)?$/ }, () => ({ path: "/runtime/three.js", external: true }));
    builder.onResolve({ filter: /^three\/tsl$/ }, () => ({ path: "/runtime/tsl.js", external: true }));
  } };
  await build({
    entryPoints: { tsl: fileURLToPath(new URL("node_modules/three/build/three.tsl.js", root)) },
    outdir: fileURLToPath(new URL("runtime/", output)), bundle: true, format: "esm", minify: true, target: "es2022", legalComments: "eof", logLevel: "warning", plugins: [platform],
  });
  await build({
    entryPoints: [fileURLToPath(new URL("scripts/editor-tools.js", root))], outfile: fileURLToPath(new URL("editor/tools.js", output)),
    bundle: true, format: "esm", minify: true, target: "es2022", legalComments: "eof", logLevel: "warning", plugins: [platform],
  });
  // The agent tool for machines without this repository: the CLI/MCP adapter in one file,
  // driving the published workshop. It needs only Playwright beside it. Imports of
  // /editor/... run inside the page, so they stay as they are.
  await build({
    entryPoints: [fileURLToPath(new URL("scripts/editor-agent.mjs", root))], outfile: fileURLToPath(new URL("tools/fundev-workshop.mjs", output)),
    bundle: true, platform: "node", format: "esm", target: "node22", external: ["playwright", "/editor/*"], legalComments: "eof", logLevel: "error",
    define: {
      "process.env.FUNDEV_WORKSHOP_URL": JSON.stringify("https://fun.dev/editor/"),
      // --guide prints the quick reference without the repository.
      "process.env.FUNDEV_WORKSHOP_GUIDE": JSON.stringify(await readFile(new URL("docs/workshop-agents.md", root), "utf8")),
    },
  });
  // The workshop's geometry kernel (manifold-3d): its ES module finds the .wasm beside it.
  const kernel = new URL("editor/vendor/", output);
  await mkdir(kernel, { recursive: true });
  for (const [from, to] of [["manifold.js", "manifold.js"], ["manifold.wasm", "manifold.wasm"], ["LICENSE", "manifold-LICENSE.txt"]])
    await cp(new URL(`node_modules/manifold-3d/${from}`, root), new URL(to, kernel));
  const addons = new URL("runtime/addons/", output);
  await build({
    entryPoints: Object.fromEntries(["loaders/GLTFLoader", "loaders/DRACOLoader", "loaders/KTX2Loader", "controls/OrbitControls", "tsl/display/BloomNode", "tsl/display/GTAONode", "libs/meshopt_decoder.module:MeshoptDecoder"]
      .map((entry) => { const [path, name = path.split("/").at(-1)] = entry.split(":"); return [name, fileURLToPath(new URL(`node_modules/three/examples/jsm/${path}.js`, root))]; })),
    outdir: fileURLToPath(addons), bundle: true, format: "esm", minify: true, target: "es2022", legalComments: "eof", logLevel: "warning", plugins: [platform],
  });
  for (const [directory, files] of [["draco", ["draco_wasm_wrapper.js", "draco_decoder.wasm"]], ["basis", ["basis_transcoder.js", "basis_transcoder.wasm"]]]) {
    await mkdir(new URL(`${directory}/`, addons), { recursive: true });
    for (const file of files) await cp(new URL(`node_modules/three/examples/jsm/libs/${directory}/${file}`, root), new URL(`${directory}/${file}`, addons));
  }
}
