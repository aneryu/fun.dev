// MediaPipe Tasks Vision (Apache-2.0) at the platform's pinned version, with the platform's models.
// Nothing downloads until load() or a model is used, and the service worker caches it then.
//   const vision = await context.runtime("kit/vision.js");
//   const { FaceLandmarker } = await vision.load();
//   FaceLandmarker.createFromOptions(vision.fileset, { baseOptions: { modelAssetPath: vision.model("face_landmarker") } });

// The build replaces this line with the content hash of the vision runtime.
const VERSION = "source";

// Models served at /runtime/vision/<version>/models/<name>.bin, from sources/mediapipe/.
export const models = Object.freeze(["face_landmarker", "hair_segmenter", "selfie_segmenter"]);

const base = new URL(`../vision/${VERSION}/`, import.meta.url);

export const fileset = Object.freeze({
  wasmLoaderPath: new URL("vision_wasm_internal.js", base).href,
  wasmBinaryPath: new URL("vision_wasm_internal.wasm", base).href,
});

export function load() {
  return import(new URL("vision_bundle.mjs", base).href);
}

export function model(name) {
  if (!models.includes(name)) throw new TypeError(`Unknown vision model: ${name}`);
  return new URL(`models/${name}.bin`, base).href;
}
