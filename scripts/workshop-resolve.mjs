// Module resolution for the workshop's page modules in Node (development, unbundled): the
// page imports Three.js and its addons by site paths; here they come from node_modules.
// The bundled tool resolves the same paths at build time (scripts/build-three.mjs).
const root = new URL("../", import.meta.url);
const map = {
  "/runtime/three.js": "three/webgpu",
  "/vendor/three/three.webgpu.js": "three/webgpu",
  "/workshop/tools.js": new URL("scripts/editor-tools.js", root).href,
};
export async function resolve(specifier, context, next) {
  return next(map[specifier] ?? specifier, context);
}
