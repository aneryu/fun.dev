// Reads what review needs from a GLB without rendering it (docs/models.md): the glTF JSON is
// checked for external references and unsupported required extensions, and the scene's
// bounding box and triangle count are computed from accessor bounds and node transforms.
export class GLBError extends Error {}

// Required extensions a plain GLTFLoader handles. Compressed files (Draco, KTX2, meshopt) need
// decoders the library pages do not load; compression is deferred (docs/assets.md, Later).
const SUPPORTED = new Set(["KHR_mesh_quantization", "KHR_texture_transform", "KHR_materials_unlit", "KHR_materials_emissive_strength", "KHR_lights_punctual"]);

/** @param {Uint8Array} bytes */
export function readGLB(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67) throw new GLBError("not a GLB file");
  if (view.getUint32(4, true) !== 2) throw new GLBError("only glTF 2.0 is supported");
  if (view.getUint32(8, true) !== bytes.length) throw new GLBError("the header length does not match the file");
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.length) throw new GLBError("the first chunk is not JSON");
  let json;
  try { json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))); }
  catch { throw new GLBError("the JSON chunk is not valid JSON"); }
  if (!json || typeof json !== "object" || json.asset?.version !== "2.0") throw new GLBError("asset.version must be 2.0");
  if ((json.buffers ?? []).some((buffer) => buffer.uri !== undefined)) throw new GLBError("buffers must be embedded, not referenced by uri");
  if ((json.images ?? []).some((image) => image.uri !== undefined)) throw new GLBError("images must be embedded, not referenced by uri");
  const unsupported = (json.extensionsRequired ?? []).filter((name) => !SUPPORTED.has(name));
  if (unsupported.length) throw new GLBError(`unsupported required extensions: ${unsupported.join(", ")}`);
  return json;
}

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  }
  return out;
}
function local(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = node.scale ?? [1, 1, 1], [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
const round = (value) => Math.round(value * 1e4) / 1e4;

/** Size, bounds (metres, glTF axes: x width, y height, z depth) and triangles of the default scene. */
export function glbStats(json) {
  const scene = json.scenes?.[json.scene ?? 0];
  if (!scene) throw new GLBError("the file has no scene");
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  const visit = (index, parent, depth) => {
    const node = json.nodes?.[index];
    if (!node || depth > 64) throw new GLBError("the node hierarchy is invalid");
    const world = multiply(parent, local(node));
    for (const primitive of json.meshes?.[node.mesh]?.primitives ?? []) {
      const position = json.accessors?.[primitive.attributes?.POSITION];
      if (!position?.min || !position?.max) throw new GLBError("POSITION accessors need min and max");
      for (let corner = 0; corner < 8; corner++) {
        const point = [0, 1, 2].map((axis) => (corner >> axis) & 1 ? position.max[axis] : position.min[axis]);
        for (let axis = 0; axis < 3; axis++) {
          const value = world[axis] * point[0] + world[4 + axis] * point[1] + world[8 + axis] * point[2] + world[12 + axis];
          min[axis] = Math.min(min[axis], value);
          max[axis] = Math.max(max[axis], value);
        }
      }
      const count = primitive.indices === undefined ? position.count : json.accessors?.[primitive.indices]?.count ?? 0;
      const mode = primitive.mode ?? 4;
      triangles += mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(count - 2, 0) : 0;
    }
    for (const child of node.children ?? []) visit(child, world, depth + 1);
  };
  for (const index of scene.nodes ?? []) visit(index, identity(), 0);
  if (min[0] === Infinity) throw new GLBError("the scene has no meshes");
  return { size: max.map((value, axis) => round(value - min[axis])), min: min.map(round), max: max.map(round), triangles };
}
