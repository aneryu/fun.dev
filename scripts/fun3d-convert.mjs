import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { createFun3d } from "../site/runtime/kit/fun3d.js";
import { createImporter, PROFILE } from "../site/runtime/kit/fun3d-import.js";

// The converter (docs/model-format.md §8) in Node: the runtime kit's importer and writer, with
// GLTFLoader's texture decoding replaced by placeholders (the file keeps the encoded bytes, so
// nothing needs decoding). A converter is identified by the hash of the modules it runs, so a
// derived file is fixed for its (source, converter, profile).
const root = new URL("../", import.meta.url);
// GLTFLoader reaches URL.createObjectURL through `self`, which Node lacks.
globalThis.self ??= globalThis;
const KIT = ["fun3d.js", "fun3d-write.js", "fun3d-schema.js", "fun3d-container.js", "fun3d-import.js"];
let stamp = null;

/** "sha256:<hex>" over the kit modules, the profile and the pinned dependencies. */
export async function converterStamp() {
  if (stamp) return stamp;
  const hash = createHash("sha256");
  for (const name of KIT) hash.update(name).update("\0").update(await readFile(new URL(`site/runtime/kit/${name}`, root))).update("\0");
  const versions = await Promise.all(["three", "meshoptimizer"].map(async (name) => JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, root), "utf8")).version));
  hash.update(PROFILE).update("\0").update(versions.join(","));
  return (stamp = `sha256:${hash.digest("hex")}`);
}

// Textures resolve to empty Texture objects: the importer keeps their encoded bytes itself.
class PlaceholderLoader {
  load(url, onLoad) { const texture = new THREE.Texture(); queueMicrotask(() => onLoad(texture)); return texture; }
  loadAsync() { return Promise.resolve(new THREE.Texture()); }
}

export function createConverter() {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  loader.setKTX2Loader(new PlaceholderLoader());
  loader.register((parser) => { parser.textureLoader = new PlaceholderLoader(); return { name: "fun3d-placeholder-textures" }; });
  const fun3d = createFun3d({ THREE, encoder: MeshoptEncoder, decoder: MeshoptDecoder });
  const importer = createImporter({ THREE, loader, fun3d, encoder: MeshoptEncoder });
  return {
    fun3d, importer,
    /** GLB bytes → { bytes, manifest, report } through the library profile. */
    async convert(glb, { type = "prop", name = null, hash = null, edit = null } = {}) {
      const source = hash ?? `sha256:${createHash("sha256").update(glb).digest("hex")}`;
      return importer.importGLB(glb, { type, name, hash: source, converter: await converterStamp(), edit });
    },
  };
}
