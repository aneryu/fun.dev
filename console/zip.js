// Reads the files of a .zip (stored or deflated entries, no ZIP64) in the browser with the
// built-in DecompressionStream. Returns [{ path, bytes }], directories left out.
export async function readZip(blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let end = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index--) {
    if (view.getUint32(index, true) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw new Error("not a zip file");
  const count = view.getUint16(end + 10, true);
  let pointer = view.getUint32(end + 16, true);
  if (count === 0xffff || pointer === 0xffffffff) throw new Error("ZIP64 archives are not supported; split the upload");
  const decoder = new TextDecoder();
  const files = [];
  for (let entry = 0; entry < count; entry++) {
    if (view.getUint32(pointer, true) !== 0x02014b50) throw new Error("damaged zip directory");
    const method = view.getUint16(pointer + 10, true), compressed = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true), extraLength = view.getUint16(pointer + 30, true), commentLength = view.getUint16(pointer + 32, true);
    const local = view.getUint32(pointer + 42, true);
    const path = decoder.decode(buffer.subarray(pointer + 46, pointer + 46 + nameLength));
    pointer += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith("/")) continue;
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`damaged entry ${path}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = buffer.subarray(start, start + compressed);
    let bytes;
    if (method === 0) bytes = data.slice();
    else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    else throw new Error(`${path}: unsupported compression method ${method}`);
    files.push({ path, bytes });
  }
  return files;
}

// Groups files by their <id>/<version>/<file> path ending (any folders above are ignored).
export function groupVersions(files) {
  const versions = new Map();
  for (const { path, bytes } of files) {
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 3 || parts.some((part) => part === "__MACOSX") || [".DS_Store", "Thumbs.db", "desktop.ini"].includes(parts.at(-1))) continue;
    const [id, version, name] = parts.slice(-3);
    if (!/^v\d{3}$/.test(version)) continue;
    const key = `${id}/${version}`;
    if (!versions.has(key)) versions.set(key, { id, version, meta: null, files: [] });
    const entry = versions.get(key);
    if (name === "meta.json") entry.meta = new TextDecoder().decode(bytes);
    else entry.files.push({ name, bytes });
  }
  return [...versions.values()].sort((a, b) => `${a.id}/${a.version}`.localeCompare(`${b.id}/${b.version}`));
}
