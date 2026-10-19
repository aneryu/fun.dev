// The geometry kernel inside the bundled tool: manifold-3d (Apache-2.0) and its WebAssembly bytes.
import Module from "manifold-3d";
import wasmBinary from "manifold-3d/manifold.wasm";
export const kernel = { module: Module, wasmBinary };
