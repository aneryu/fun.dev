// The solid-geometry kernel: manifold-3d (Apache-2.0), a WebAssembly build of Manifold.
// It runs booleans, outlines with holes and other solid operations. The page loads it
// once before window.funEditor opens, so commands stay synchronous.
import { ModelError } from "./mesh.js";

let module = null,
  loading = null;
// Node (tests, local tools) resolves the package; the page loads the copy that the build
// places next to the editor.
const source =
  typeof window === "undefined" ? "manifold-3d" : "/workshop/vendor/manifold.js";

// A bundled Node tool hands over the module and its WebAssembly bytes ({ module, wasmBinary }).
export function loadKernel({ module: provided, ...options } = {}) {
  loading ??= (provided ? Promise.resolve({ default: provided }) : import(source)).then(async ({ default: Module }) => {
    const wasm = await Module(options);
    wasm.setup();
    module = wasm;
    return wasm;
  });
  return loading;
}

export function kernel() {
  if (!module)
    throw new ModelError(
      "The geometry kernel is still loading; retry in a moment",
      "kernel_loading",
    );
  return module;
}

export const kernelReady = () => !!module;
