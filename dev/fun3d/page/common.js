// Prototype harness: the runtime modules as a page imports them.
import * as THREE from "/runtime/three.js";
import { GLTFLoader } from "/runtime/addons/GLTFLoader.js";
import { DRACOLoader } from "/runtime/addons/DRACOLoader.js";
import { MeshoptDecoder } from "/runtime/addons/MeshoptDecoder.js";
import { MeshoptEncoder } from "/runtime/addons/MeshoptEncoder.js";
import { createFun3d } from "/runtime/kit/fun3d.js";
import { createImporter } from "/runtime/kit/fun3d-import.js";

await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
export { THREE };
export const loader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath("/runtime/addons/draco/")).setMeshoptDecoder(MeshoptDecoder);
export const fun3d = createFun3d({ THREE, encoder: MeshoptEncoder, decoder: MeshoptDecoder });
export const importer = createImporter({ THREE, loader, encoder: MeshoptEncoder });
export const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
