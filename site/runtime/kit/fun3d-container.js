// The .fun3d container (docs/model-format.md §3): a signature and chunks. Each chunk is a
// 16-byte header (type, flags, stored length, raw length) and data padded to 4 bytes. The
// JSON chunk comes first; BIN chunks follow; chunks flagged editing come last and are what a
// runtime file leaves out. Inflation stops at the declared raw length.

export const SIGNATURE = Uint8Array.of(0x89, 0x46, 0x55, 0x4e, 0x33, 0x44, 0x0d, 0x0a); // \x89FUN3D\r\n
export const DEFLATE = 1, EDITING = 2;
const RESERVED = ~(DEFLATE | EDITING) >>> 0;
const TYPES = new Set(["JSON", "BIN ", "EDIT"]);

export class ContainerError extends Error {}

const typeCode = (type) => [...type].reduce((n, c, i) => n | (c.charCodeAt(0) << (8 * i)), 0) >>> 0;
const typeName = (code) => String.fromCharCode(code & 255, (code >> 8) & 255, (code >> 16) & 255, code >>> 24);
const padding = (length) => (4 - (length % 4)) % 4;

async function through(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/** Inflates `bytes`, refusing output that is not exactly `rawLength` long. */
export async function inflate(bytes, rawLength) {
  const out = await through(bytes, new DecompressionStream("deflate-raw"));
  if (out.length !== rawLength) throw new ContainerError(`A chunk inflated to ${out.length} bytes, not the declared ${rawLength}`);
  return out;
}

export const deflate = (bytes) => through(bytes, new CompressionStream("deflate-raw"));

/** chunks: [{ type, bytes, deflate?, editing? }] in file order → the file's bytes. */
export async function packChunks(chunks) {
  const parts = [SIGNATURE];
  for (const chunk of chunks) {
    if (!TYPES.has(chunk.type)) throw new ContainerError(`Unknown chunk type "${chunk.type}"`);
    const data = chunk.deflate ? await deflate(chunk.bytes) : chunk.bytes;
    const head = new DataView(new ArrayBuffer(16));
    head.setUint32(0, typeCode(chunk.type), true);
    head.setUint32(4, (chunk.deflate ? DEFLATE : 0) | (chunk.editing || chunk.type === "EDIT" ? EDITING : 0), true);
    head.setUint32(8, data.length, true);
    head.setUint32(12, chunk.bytes.length, true);
    parts.push(new Uint8Array(head.buffer), data, new Uint8Array(padding(data.length)));
  }
  return concat(parts);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

/** The chunk table of a file without decoding anything; enforces the layout rules. */
export function scanChunks(bytes, { maxRaw = 256 * 1024 * 1024, maxChunks = 64 } = {}) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new ContainerError("Not a .fun3d file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), chunks = [];
  let offset = 8, totalRaw = 0, editingSeen = false;
  while (offset < bytes.length) {
    if (offset + 16 > bytes.length) throw new ContainerError("Truncated chunk header");
    const type = typeName(view.getUint32(offset, true)), flags = view.getUint32(offset + 4, true);
    const storedLength = view.getUint32(offset + 8, true), rawLength = view.getUint32(offset + 12, true);
    if (flags & RESERVED) throw new ContainerError(`Chunk "${type}" sets reserved flag bits`);
    if (!(flags & DEFLATE) && storedLength !== rawLength) throw new ContainerError(`Chunk "${type}" is not compressed but declares different stored and raw lengths`);
    if (offset + 16 + storedLength > bytes.length) throw new ContainerError(`Chunk "${type}" runs past the end of the file`);
    const editing = !!(flags & EDITING);
    if (type === "EDIT" && !editing) throw new ContainerError("EDIT chunks carry the editing flag");
    if (type === "JSON" && editing) throw new ContainerError("The JSON chunk is never an editing chunk");
    if (editing) editingSeen = true;
    else if (editingSeen) throw new ContainerError("Runtime chunks follow an editing chunk");
    chunks.push({ type, flags, editing, start: offset, end: offset + 16 + storedLength + padding(storedLength), data: bytes.subarray(offset + 16, offset + 16 + storedLength), rawLength });
    totalRaw += rawLength;
    if (totalRaw > maxRaw) throw new ContainerError(`The file declares more than ${maxRaw} raw bytes`);
    if (chunks.length > maxChunks) throw new ContainerError(`More than ${maxChunks} chunks`);
    offset = chunks.at(-1).end;
  }
  if (!chunks.length || chunks[0].type !== "JSON") throw new ContainerError("A .fun3d file starts with its JSON chunk");
  if (chunks.filter((c) => c.type === "JSON").length !== 1) throw new ContainerError("Exactly one JSON chunk");
  return { bytes, chunks };
}

/** Chunks with their data inflated (runtime chunks only unless `editing`). */
export async function unpackChunks(bytes, { editing = false, maxJSON = 16 * 1024 * 1024, ...limits } = {}) {
  const { chunks } = scanChunks(bytes, limits);
  const wanted = chunks.filter((c) => editing || !c.editing);
  if (chunks[0].rawLength > maxJSON) throw new ContainerError(`The JSON chunk declares ${chunks[0].rawLength} bytes, above ${maxJSON}`);
  return Promise.all(wanted.map(async (c) => ({ type: c.type, editing: c.editing, bytes: c.flags & DEFLATE ? await inflate(c.data, c.rawLength) : c.data })));
}

/** The runtime file: the same bytes without editing chunks, made without decoding. */
export function stripEditing(bytes) {
  const { bytes: all, chunks } = scanChunks(bytes);
  return concat([all.subarray(0, 8), ...chunks.filter((c) => !c.editing).map((c) => all.subarray(c.start, c.end))]);
}

/** JSON.parse without prototype keys, for manifests and editing documents from uploads. */
export function parseJSON(text) {
  return JSON.parse(text, (key, value) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
    return value;
  });
}
