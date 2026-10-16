import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { models } from "../site/runtime/kit/vision.js";

// Builds the platform's MediaPipe runtime into dist/runtime/vision/<hash>/: the pinned
// @mediapipe/tasks-vision library and wasm, and the models from sources/mediapipe/.
// Its address changes with its content, so browsers and the service worker cache it forever.
export async function buildVision(root, output) {
  const library = new URL("node_modules/@mediapipe/tasks-vision/", root);
  const files = [
    ["vision_bundle.mjs", withoutTelemetry(await readFile(new URL("vision_bundle.mjs", library), "utf8"))],
    ["vision_wasm_internal.js", await readFile(new URL("wasm/vision_wasm_internal.js", library))],
    ["vision_wasm_internal.wasm", await readFile(new URL("wasm/vision_wasm_internal.wasm", library))],
    ["LICENSE.txt", await readFile(new URL("config/mediapipe-LICENSE.txt", root))],
  ];
  for (const name of models) {
    try { files.push([`models/${name}.bin`, await readFile(new URL(`sources/mediapipe/${name}.bin`, root))]); }
    catch (error) {
      if (error.code === "ENOENT") throw new Error(`sources/mediapipe/${name}.bin is missing; run npm run assets.`);
      throw error;
    }
  }
  const hash = createHash("sha256");
  for (const [name, body] of files) hash.update(name).update("\0").update(body).update("\0");
  const version = hash.digest("hex").slice(0, 16);
  const directory = new URL(`runtime/vision/${version}/`, output);
  for (const [name, body] of files) {
    const target = new URL(name, directory);
    await mkdir(new URL("./", target), { recursive: true });
    await writeFile(target, body);
  }
  const kit = new URL("runtime/kit/vision.js", output);
  const source = await readFile(kit, "utf8");
  if (!/^const VERSION = "source";$/m.test(source)) throw new Error("kit/vision.js lost its VERSION line.");
  await writeFile(kit, source.replace(/^const VERSION = "source";$/m, `const VERSION = ${JSON.stringify(version)};`));
  return version;
}

// Tasks Vision reports usage to Google every minute, with no option to turn it off. The player's
// CSP would block the request; this also keeps it from being attempted. A new MediaPipe version
// fails the build here until the patch is checked again. The source map is not shipped.
function withoutTelemetry(source) {
  const flush = "flush(t,e){if(this.error)";
  const count = (text) => source.split(text).length - 1;
  if (count(flush) !== 1 || count("https://odml.pa.googleapis.com/v1/log") !== 1) {
    throw new Error("@mediapipe/tasks-vision changed its usage logger; update withoutTelemetry() in scripts/vision.mjs.");
  }
  return source.replace(flush, "flush(t,e){if(t?.(),!0)return;if(this.error)").replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n");
}
