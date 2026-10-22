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

// Mixamo joint names with or without the "mixamorig:" prefix (three.js drops the colon).
const MIXAMO = /^mixamorig:?/;

// Mixamo's joints by humanoid role (VRM 1.0 names), for files that name their joints that way.
const MIXAMO_ROLES = { hips: "Hips", spine: "Spine", chest: "Spine1", upperChest: "Spine2", neck: "Neck", head: "Head" };
for (const [side, s] of [["left", "Left"], ["right", "Right"]]) {
  Object.assign(MIXAMO_ROLES, { [`${side}Shoulder`]: `${s}Shoulder`, [`${side}UpperArm`]: `${s}Arm`, [`${side}LowerArm`]: `${s}ForeArm`, [`${side}Hand`]: `${s}Hand`,
    [`${side}UpperLeg`]: `${s}UpLeg`, [`${side}LowerLeg`]: `${s}Leg`, [`${side}Foot`]: `${s}Foot`, [`${side}Toes`]: `${s}ToeBase`,
    [`${side}ThumbMetacarpal`]: `${s}HandThumb1`, [`${side}ThumbProximal`]: `${s}HandThumb2`, [`${side}ThumbDistal`]: `${s}HandThumb3` });
  for (const f of ["Index", "Middle", "Ring", "Little"]) {
    const m = f === "Little" ? "Pinky" : f;
    Object.assign(MIXAMO_ROLES, { [`${side}${f}Proximal`]: `${s}Hand${m}1`, [`${side}${f}Intermediate`]: `${s}Hand${m}2`, [`${side}${f}Distal`]: `${s}Hand${m}3` });
  }
}

/**
 * The humanoid rig a skinned GLB declares: role → joint name, the declared rest pose ("T", "A" or
 * null) and where it came from. From VRM's `VRMC_vrm.humanoid.humanBones` (whose rest pose is a
 * T-pose by its specification), the skin's `extras.rig` ({ roles, rest }, as in .fun3d's `rig`),
 * or Mixamo joint names (a T-pose, as Mixamo rigs).
 */
function glbRig(json, skin, nameOf) {
  const bones = json.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (bones && typeof bones === "object") {
    const roles = {};
    for (const [role, bone] of Object.entries(bones)) if (Number.isInteger(bone?.node) && json.nodes?.[bone.node]) roles[role] = nameOf(bone.node);
    return { roles, rest: "T", source: "VRMC_vrm" };
  }
  const extra = skin.extras?.rig;
  if (extra && typeof extra === "object") {
    const roles = {};
    for (const [role, name] of Object.entries(extra.roles ?? {})) if (typeof name === "string") roles[role] = name;
    return { roles, rest: extra.rest === "T" || extra.rest === "A" ? extra.rest : null, source: "extras.rig" };
  }
  const joints = new Set((skin.joints ?? []).map(nameOf));
  if ((skin.joints ?? []).length && (skin.joints ?? []).every((index) => MIXAMO.test(json.nodes[index].name ?? ""))) {
    const roles = {};
    for (const [role, name] of Object.entries(MIXAMO_ROLES)) if (joints.has(name)) roles[role] = name;
    return { roles, rest: "T", source: "mixamo" };
  }
  return null;
}

/**
 * The skeleton of a skinned GLB, for the character rules: joint names (without the Mixamo
 * prefix), each joint's rest position (world, metres), its humanoid rig (null when it declares
 * none), whether any vertex has more than four influences, and the animation names. Null when the
 * file has no skin.
 */
export function glbSkeleton(json) {
  const skin = json.skins?.[0];
  if (!skin) return null;
  const parent = new Map();
  for (const [index, node] of (json.nodes ?? []).entries()) for (const child of node.children ?? []) parent.set(child, index);
  const worldOf = (index, depth = 0) => {
    if (depth > 64) throw new GLBError("the node hierarchy is invalid");
    const node = json.nodes?.[index];
    if (!node) throw new GLBError("the node hierarchy is invalid");
    return parent.has(index) ? multiply(worldOf(parent.get(index), depth + 1), local(node)) : local(node);
  };
  const nameOf = (index) => String(json.nodes[index].name ?? index).replace(MIXAMO, "");
  const joints = {};
  for (const index of skin.joints ?? []) {
    const world = worldOf(index);
    joints[nameOf(index)] = [world[12], world[13], world[14]].map(round);
  }
  return {
    count: (skin.joints ?? []).length,
    rig: glbRig(json, skin, nameOf),
    joints,
    moreInfluences: (json.meshes ?? []).some((mesh) => mesh.primitives.some((primitive) => primitive.attributes?.JOINTS_1 !== undefined)),
    animations: (json.animations ?? []).map((animation) => animation.name ?? ""),
  };
}

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
