// Keep GLB parsing, simplification and polygon recovery off the UI thread.
import { importModel } from './import-glb.js';
import { MeshoptSimplifier } from '/workshop/vendor/meshopt_simplifier.js';
self.onmessage = async ({ data: { bytes, options } }) => {
  try {
    await MeshoptSimplifier.ready;
    self.postMessage({ result: importModel(bytes, { ...options, simplifier: MeshoptSimplifier }) });
  } catch (error) {
    self.postMessage({ error: { message: error.message, code: error.code } });
  }
};
