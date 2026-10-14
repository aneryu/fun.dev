// Step 1 of the model pipeline: decode EXT_meshopt_compression (e.g. gltfpack/Tripo output)
// into a plain GLB, because Blender here lacks the meshopt bridge and the platform has no decoder.
//   node dev/decode-meshopt.mjs model.glb /tmp/plain.glb
import { readFileSync, writeFileSync } from "node:fs";
const { MeshoptDecoder } = await import(process.argv[4] ?? new URL("../../../node_modules/three/examples/jsm/libs/meshopt_decoder.module.js", import.meta.url));
await MeshoptDecoder.ready;
const data = readFileSync(process.argv[2]);
const jsonLen = data.readUInt32LE(12);
const json = JSON.parse(data.subarray(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
const bin = data.subarray(binStart, binStart + data.readUInt32LE(20 + jsonLen));
const chunks = []; let offset = 0;
const pad = (n) => (n + 3) & ~3;
for (const view of json.bufferViews) {
  const ext = view.extensions?.EXT_meshopt_compression;
  let bytes;
  if (ext) {
    bytes = new Uint8Array(ext.count * ext.byteStride);
    const src = bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
    MeshoptDecoder.decodeGltfBuffer(bytes, ext.count, ext.byteStride, src, ext.mode, ext.filter ?? "NONE");
    if (ext.byteStride && ext.mode === "ATTRIBUTES") view.byteStride = ext.byteStride;
    delete view.extensions;
  } else {
    if (view.buffer !== 0) throw new Error("unexpected uncompressed view on fallback buffer");
    bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  }
  view.buffer = 0; view.byteOffset = offset; view.byteLength = bytes.length;
  chunks.push(Buffer.from(bytes), Buffer.alloc(pad(bytes.length) - bytes.length));
  offset = pad(offset + bytes.length);
}
json.buffers = [{ byteLength: offset }];
json.extensionsUsed = json.extensionsUsed.filter((e) => e !== "EXT_meshopt_compression");
json.extensionsRequired = json.extensionsRequired.filter((e) => e !== "EXT_meshopt_compression");
let jsonBuf = Buffer.from(JSON.stringify(json));
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad(jsonBuf.length) - jsonBuf.length, 0x20)]);
const binBuf = Buffer.concat(chunks);
const header = Buffer.alloc(12); header.write("glTF"); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len); b.write(type, 4); return b; };
writeFileSync(process.argv[3], Buffer.concat([header, ch(jsonBuf.length, "JSON"), jsonBuf, ch(binBuf.length, "BIN\0"), binBuf]));
console.log("wrote", process.argv[3], 12 + 16 + jsonBuf.length + binBuf.length, "bytes");
