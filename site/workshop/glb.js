// GLB reading and writing for the workshop. A project file is an ordinary GLB of the model
// that also carries the editable document in a FUNDEV_workshop extension: any viewer shows
// it, and the workshop restores every recipe, link and assembly from it.
import { ModelError } from "./mesh.js";
import { isDense, denseData } from "./dense.js";

const DENSE_ARRAYS = ["positions", "offsets", "indices", "faceMaterials"];

export const WORKSHOP_EXTENSION = "FUNDEV_workshop";
const MAGIC = 0x46546c67,
  JSON_CHUNK = 0x4e4f534a,
  BIN_CHUNK = 0x004e4942;
const fail = (message, code = "invalid_glb") => {
  throw new ModelError(message, code, "data");
};

export const isGLB = (bytes) =>
  bytes.length >= 12 &&
  new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === MAGIC;

// { json, buffers }: a GLB, or a .gltf JSON file whose buffers are embedded data: URIs.
export function parseModelFile(bytes) {
  if (!(bytes instanceof Uint8Array)) fail("Expected file bytes");
  let json,
    bin = null;
  if (isGLB(bytes)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) !== 2) fail("Only glTF 2.0 files are supported");
    if (view.getUint32(8, true) > bytes.length) fail("The GLB file is truncated");
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset, true),
        type = view.getUint32(offset + 4, true),
        data = bytes.subarray(offset + 8, offset + 8 + length);
      if (data.length !== length) fail("The GLB file is truncated");
      if (type === JSON_CHUNK && json === undefined) {
        try {
          json = JSON.parse(new TextDecoder().decode(data));
        } catch {
          fail("The GLB JSON chunk is not valid JSON");
        }
      } else if (type === BIN_CHUNK && !bin) bin = data;
      offset += 8 + length;
    }
    if (json === undefined) fail("The GLB file has no JSON chunk");
  } else {
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      fail("Not a GLB or glTF file");
    }
  }
  if (json?.asset?.version !== "2.0") fail("Only glTF 2.0 files are supported");
  const buffers = (json.buffers ?? []).map((buffer, index) => {
    if (buffer.uri === undefined) {
      if (index === 0 && bin) return bin;
      fail("A glTF buffer has no data");
    }
    const match = /^data:[^;,]*;base64,(.*)$/s.exec(buffer.uri);
    if (!match) fail("Buffers must be embedded; open a GLB file instead");
    return fromBase64(match[1]);
  });
  return { json, buffers };
}

export function writeGLB(json, bin = null) {
  const text = new TextEncoder().encode(JSON.stringify(json)),
    jsonLength = Math.ceil(text.length / 4) * 4,
    binLength = bin ? Math.ceil(bin.length / 4) * 4 : 0,
    total = 20 + jsonLength + (bin ? 8 + binLength : 0),
    out = new Uint8Array(total),
    view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  if (bin) {
    const at = 20 + jsonLength;
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, BIN_CHUNK, true);
    out.set(bin, at + 8);
  }
  return out;
}

// The editable project, or null for a plain model. Dense meshes keep their arrays in the
// file's binary chunk: { bufferView } refs, resolved from `buffers` (parseModelFile's).
export function workshopProject(json, buffers = []) {
  const stored = json?.extensions?.[WORKSHOP_EXTENSION];
  if (stored === undefined) return null;
  if (!stored || typeof stored !== "object" || !stored.project)
    fail("The workshop project in this file is damaged", "invalid_project");
  const project = structuredClone(stored.project);
  for (const node of Array.isArray(project.nodes) ? project.nodes : []) {
    const d = node?.mesh?.dense;
    if (!d || typeof d !== "object") continue;
    for (const key of DENSE_ARRAYS) {
      const ref = d[key];
      if (!ref || typeof ref !== "object" || !Number.isInteger(ref.bufferView)) continue;
      const view = json.bufferViews?.[ref.bufferView],
        buffer = buffers[view?.buffer ?? 0];
      if (!view || !buffer || (view.byteOffset ?? 0) + view.byteLength > buffer.byteLength)
        fail("The workshop project's mesh data is missing from the file", "invalid_project");
      d[key] = buffer.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    }
  }
  return project;
}

// Adds the editable project to a GLB of the model. Viewers ignore the extension; it is used,
// never required.
export function withWorkshopProject(glb, project) {
  const { json, buffers } = parseModelFile(glb);
  // Dense meshes' arrays go into the binary chunk after the model's data (8-byte aligned),
  // as buffer views no accessor uses; the extension refers to them.
  const chunks = [buffers[0] ?? new Uint8Array(0)];
  let length = chunks[0].byteLength;
  const views = (json.bufferViews ??= []);
  const stored = {
    ...project,
    nodes: (project.nodes ?? []).map((node) => {
      if (!isDense(node.mesh)) return node;
      const d = denseData(node.mesh),
        dense = { materials: [...d.materials] };
      for (const key of DENSE_ARRAYS) {
        const pad = (8 - (length % 8)) % 8;
        if (pad) {
          chunks.push(new Uint8Array(pad));
          length += pad;
        }
        const array = d[key];
        views.push({ buffer: 0, byteOffset: length, byteLength: array.byteLength, name: `${node.id}.${key}` });
        dense[key] = { bufferView: views.length - 1 };
        chunks.push(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
        length += array.byteLength;
      }
      return { ...node, mesh: { dense } };
    }),
  };
  if (!views.length) delete json.bufferViews;
  let bin = chunks[0];
  if (chunks.length > 1) {
    bin = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      bin.set(c, at);
      at += c.byteLength;
    }
    if (json.buffers?.length) json.buffers[0].byteLength = length;
    else json.buffers = [{ byteLength: length }];
  }
  json.extensions = {
    ...json.extensions,
    [WORKSHOP_EXTENSION]: {
      format: stored.format,
      version: stored.version,
      project: stored,
    },
  };
  json.extensionsUsed = [
    ...new Set([...(json.extensionsUsed ?? []), WORKSHOP_EXTENSION]),
  ];
  return writeGLB(json, bin.byteLength ? bin : null);
}

export function toBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export function fromBase64(text) {
  if (typeof text !== "string") fail("Expected base64 file data");
  let binary;
  try {
    binary = atob(text);
  } catch {
    fail("The file data is not valid base64");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// GLTFExporter leaves meshes unnamed; tools that read meshes[].name (as Blender's exports
// provide) get the name of the first node using each mesh.
export function nameMeshes(glb) {
  const { json, buffers } = parseModelFile(glb);
  for (const node of json.nodes ?? [])
    if (node.mesh !== undefined && json.meshes?.[node.mesh] && !json.meshes[node.mesh].name)
      json.meshes[node.mesh].name = node.name;
  return writeGLB(json, buffers[0] ?? null);
}
