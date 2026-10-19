import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import { bundleWorkshop } from "./workshop-bundle.mjs";

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
  // The agent tool for machines without this repository: the workshop as one Node file named
  // by its content (scripts/workshop-bundle.mjs), tools/workshop.json naming it, and the
  // launcher fundev-workshop.mjs that fetches, checks, caches and runs it.
  const bytes = await bundleWorkshop(root),
    digest = createHash("sha256").update(bytes).digest("hex"),
    file = `workshop-${digest.slice(0, 16)}.mjs`;
  const tools = new URL("tools/", output);
  await rm(tools, { recursive: true, force: true });
  await mkdir(tools, { recursive: true });
  await writeFile(new URL(file, tools), bytes);
  await writeFile(new URL("workshop.json", tools), JSON.stringify({ file, sha256: digest, bytes: bytes.length }) + "\n");
  await build({
    entryPoints: [fileURLToPath(new URL("scripts/workshop-launcher.mjs", root))], outfile: fileURLToPath(new URL("fundev-workshop.mjs", tools)),
    bundle: true, platform: "node", format: "esm", target: "node22", legalComments: "eof", logLevel: "error",
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
  // .fun3d writers (the workshop, the converter page) compress geometry with meshopt's encoder, an
  // ES module with its WebAssembly inlined; games only decode, so it lives with the editor.
  await cp(new URL("node_modules/meshoptimizer/meshopt_encoder.js", root), new URL("meshopt_encoder.js", kernel));
  await cp(new URL("node_modules/meshoptimizer/LICENSE.md", root), new URL("meshoptimizer-LICENSE.txt", kernel));
}
