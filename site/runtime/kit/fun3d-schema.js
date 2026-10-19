// The .fun3d 1.0 manifest schema (docs/model-format.md §4–5) and its validator. The schema is a
// table of fields per entry type; `validateManifest` walks it, checks references and caps, and
// returns every problem it finds (empty means valid). Data-level checks that need decoded
// streams live in fun3d.js (`validateStreams`).

export const VERSION = "1.1";
export const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const EXTENSION = /^(?:fun3d|x\.[a-z0-9-]+)\.[A-Za-z0-9_.-]+$/;
export const FORMATS = {
  snorm16x4: [Int16Array, 4, true, 8], snorm8x4: [Int8Array, 4, true, 4], unorm16x2: [Uint16Array, 2, true, 4],
  unorm8x4: [Uint8Array, 4, true, 4], uint8x4: [Uint8Array, 4, false, 4],
  float32: [Float32Array, 1, false, 4], float32x2: [Float32Array, 2, false, 8], float32x3: [Float32Array, 3, false, 12], float32x4: [Float32Array, 4, false, 16],
  uint16: [Uint16Array, 1, false, 2], uint32: [Uint32Array, 1, false, 4], mat4: [Float32Array, 16, false, 64],
  uint8: [Uint8Array, 1, false, 1],
};
export const ATTRIBUTE_FORMATS = {
  position: ["snorm16x4", "float32x3"], normal: ["snorm8x4"], tangent: ["snorm8x4"], uv: ["unorm16x2", "float32x2"], uv1: ["unorm16x2", "float32x2"],
  color: ["unorm8x4"], skinIndex: ["uint8x4"], skinWeight: ["unorm8x4"],
};

/** The library profile's caps (§5). */
export const CAPS = Object.freeze({
  fileStored: 64 * 1024 * 1024, fileRaw: 256 * 1024 * 1024, json: 16 * 1024 * 1024, editing: 16 * 1024 * 1024, chunks: 64, streams: 4096, decoded: 256 * 1024 * 1024,
  nodes: 4096, geometries: 1024, materials: 256, images: 64, textures: 256, skeletons: 16, lights: 64,
  verticesPerGeometry: 4_000_000, trianglesPerGeometry: 8_000_000, vertices: 16_000_000, triangles: 32_000_000,
  buffersPerGeometry: 6, attributesPerGeometry: 11, vertexStride: 64,
  texelsPerImage: 4096 * 4096, texels: 64_000_000, bones: 128, influences: 4,
  morphTargetsPerGeometry: 128, morphTargetVertices: 1_000_000,
  clips: 256, tracksPerClip: 1024, keyframes: 4_000_000, eventsPerClip: 256,
  placementsPerNode: 65536, placements: 262144, socketsPerNode: 32, regionsPerNode: 16, variants: 64, refs: 256, extensionsBytes: 64 * 1024,
  // Scene data (docs/worlds.md): placed models' variants, a node's parameters, zones and paths.
  modelVariants: 16, paramsBytes: 4096, zones: 1024, zonePolygon: 256, pathPoints: 65536, pathEdges: 4096,
  shapes: 256, bodies: 256, constraints: 256, vehicles: 8, wheelsPerVehicle: 32, ragdollParts: 32, characters: 8,
  convexPoints: 256, meshTriangles: 100_000, intensity: 1000,
});

// Field specs: type (string | number | integer | boolean | array | object | id | color | enum),
// required, enum values, min/max, items (for arrays), fields (for objects).
const F = (type, extra = {}) => ({ type, ...extra });
const required = (type, extra = {}) => F(type, { required: true, ...extra });
const vector = (n, extra = {}) => F("array", { items: F("number"), length: n, ...extra });
const transform = F("object", { fields: { position: vector(3), rotation: F("quaternion"), scale: vector(3, { min: 1e-9 }) } });
const streamRef = (formats, extra = {}) => required("object", { fields: { stream: required("id"), format: required("enum", { values: formats }) }, ...extra });
const frame = F("object", { fields: { position: vector(3), rotation: F("quaternion") } });

export const SCHEMA = {
  root: {
    fun3d: required("string"), kind: required("enum", { values: ["model", "animations"] }),
    asset: required("object", { fields: { name: F("string", { max: 200 }), generator: F("string", { max: 200 }), source: F("object", { fields: {
      kind: required("enum", { values: ["glb", "edit", "runtime"] }), hash: F("string"), converter: F("string"), profile: F("string"), type: F("string"), tool: F("string", { nullable: true }) } }) } }),
    uses: F("array", { items: F("extension") }), requires: F("array", { items: F("extension") }),
    streams: F("array"), nodes: F("array"), geometries: F("array"), materials: F("array"), images: F("array"), textures: F("array"),
    skeletons: F("array"), animations: F("array"), physics: F("object"), variants: F("array"), refs: F("array"), extensions: F("object"),
  },
  stream: {
    id: required("id"), chunk: required("integer", { min: 0 }), offset: required("integer", { min: 0 }), length: required("integer", { min: 0 }),
    count: required("integer", { min: 0 }), stride: required("integer", { min: 1, max: 256 }),
    codec: F("enum", { values: ["meshopt"] }), mode: F("enum", { values: ["attributes", "triangles"] }),
    filter: F("enum", { values: ["octahedral", "quaternion"] }), filterBits: F("integer", { min: 4, max: 16 }),
  },
  node: {
    id: required("id"), name: F("string", { max: 200 }), parent: F("id"), transform, visible: F("boolean"), tags: F("array", { items: F("string", { max: 64 }) }),
    sockets: F("map", { fields: frame.fields }), regions: F("array", { items: F("id") }), hides: F("array", { items: F("id") }),
    mesh: F("object", { fields: { geometry: required("id"), materials: required("array", { items: F("id"), min: 1 }), shadow: F("enum", { values: ["both", "cast", "receive", "none"] }), morphWeights: F("array", { items: F("number", { min: 0, max: 1 }) }) } }),
    skin: F("id"),
    placements: F("object", { fields: { count: required("integer", { min: 1 }), transforms: streamRef(["mat4"]), tint: F("object", { fields: { stream: required("id"), format: required("enum", { values: ["unorm8x4"] }) } }) } }),
    light: F("object", { fields: { type: required("enum", { values: ["point", "spot"] }), color: F("color"), intensity: required("number", { min: 0, max: CAPS.intensity }), range: F("number", { min: 0 }), cone: vector(2, { min: 0, max: Math.PI }), importance: F("number", { min: 0, max: 1 }) } }),
    lod: F("object", { fields: { levels: required("array", { min: 1, items: F("object", { fields: { screenSize: required("number", { min: 0, max: 1 }), children: required("array", { items: F("id") }) } }) }) } }),
    // A copy of a referenced library model (1.1): the whole model under this node.
    model: F("object", { fields: { ref: required("id"), variants: F("map", { items: F("string", { max: 64 }) }), tint: F("array", { items: F("number", { min: 0, max: 1 }), min: 3, max: 4 }) } }),
    extensions: F("object"),
  },
  geometry: {
    id: required("id"), vertices: required("integer", { min: 1, max: CAPS.verticesPerGeometry }),
    buffers: required("array", { min: 1, max: CAPS.buffersPerGeometry, items: F("object", { fields: { stream: required("id"), attributes: required("map", { fields: { format: required("enum", { values: Object.keys(FORMATS) }), offset: required("integer", { min: 0 }) } }) } }) }),
    decode: F("map", { fields: { offset: F("array", { items: F("number") }), scale: F("any") } }),
    index: streamRef(["uint16", "uint32"]),
    groups: required("array", { min: 1, items: F("object", { fields: { start: required("integer", { min: 0 }), count: required("integer", { min: 3 }), material: required("integer", { min: 0, max: 255 }), flat: F("boolean") } }) }),
    lods: F("array", { items: F("object", { fields: { error: required("number", { min: 0 }), index: streamRef(["uint16", "uint32"]), groups: required("array", { min: 1 }) } }) }),
    morph: F("object", { fields: { decode: F("object", { fields: { scale: required("number", { min: 0 }) } }), targets: required("array", { min: 1, max: CAPS.morphTargetsPerGeometry, items: F("object", { fields: {
      id: required("id"), sparse: required("object", { fields: { indices: streamRef(["uint16", "uint32"]) } }), position: streamRef(["snorm16x4", "float32x3"]), normal: F("object", { fields: { stream: required("id"), format: required("enum", { values: ["snorm8x4"] }) } }) } }) }) } }),
    bounds: required("object", { fields: { min: vector(3, { required: true }), max: vector(3, { required: true }) } }),
    extensions: F("object"),
  },
  material: {
    id: required("id"), name: F("string", { max: 200 }), model: F("enum", { values: ["pbr", "unlit"] }), color: F("color"),
    alpha: F("object", { fields: { mode: F("enum", { values: ["opaque", "mask", "blend"] }), cutoff: F("number", { min: 0, max: 1 }), opacity: F("number", { min: 0, max: 1 }) } }),
    side: F("enum", { values: ["front", "double"] }),
    pbr: F("object", { fields: { roughness: F("number", { min: 0, max: 1 }), metalness: F("number", { min: 0, max: 1 }) } }),
    maps: F("map", { fields: { texture: required("id"), uv: F("integer", { min: 0, max: 1 }), scale: F("number"), transform: F("object", { fields: { offset: vector(2), scale: vector(2), rotation: F("number") } }) } }),
    features: F("object"),
  },
  image: { id: required("id"), stream: F("id"), mime: F("enum", { values: ["image/webp", "image/png", "image/jpeg", "image/ktx2"] }), ref: F("id"), entry: F("id") },
  texture: {
    id: required("id"), image: F("id"), ref: F("id"), entry: F("id"), colorSpace: F("enum", { values: ["srgb", "linear"] }),
    sampler: F("object", { fields: { wrap: F("array", { items: F("enum", { values: ["repeat", "clamp", "mirror"] }), length: 2 }),
      minFilter: F("enum", { values: ["nearest", "linear", "nearest-mipmap-nearest", "linear-mipmap-nearest", "nearest-mipmap-linear", "linear-mipmap-linear"] }),
      magFilter: F("enum", { values: ["nearest", "linear"] }), anisotropy: F("integer", { min: 1, max: 16 }) } }),
  },
  skeleton: {
    id: required("id"), bones: required("array", { min: 1, max: CAPS.bones, items: F("id") }), inverseBinds: streamRef(["mat4"]), hash: F("string"),
    ref: F("id"), entry: F("id"),
    rig: F("object", { fields: { name: required("string", { max: 64 }), version: F("integer", { min: 1 }), rest: F("enum", { values: ["T", "A"] }), height: F("number", { min: 0.01, max: 100 }), roles: F("map", { items: F("id") }) } }),
  },
  animation: {
    id: required("id"), name: F("string", { max: 200 }), duration: required("number", { min: 0 }), loop: F("enum", { values: ["repeat", "once"] }),
    blend: F("enum", { values: ["normal", "additive"] }), mask: F("array", { items: F("string") }), root: F("object", { fields: { node: required("string"), motion: F("enum", { values: ["inplace", "extract"] }) } }),
    tracks: required("array", { max: CAPS.tracksPerClip, items: F("object", { fields: {
      node: F("id"), material: F("id"), channel: required("string", { max: 100 }), interpolation: F("enum", { values: ["linear", "step"] }),
      times: required("object", { fields: { stream: F("id"), start: F("number", { min: 0 }), fps: F("number", { min: 0.001 }), count: F("integer", { min: 1 }) } }),
      values: required("object", { fields: { stream: required("id"), format: required("enum", { values: ["float32", "float32x3", "snorm16x4"] }) } }) } }) }),
    events: F("array", { max: CAPS.eventsPerClip, items: F("object", { fields: { time: required("number", { min: 0 }), name: required("string", { max: 64 }), data: F("object") } }) }),
  },
  shape: {
    id: required("id"), type: required("enum", { values: ["box", "sphere", "capsule", "cylinder", "convex", "mesh", "compound"] }),
    halfExtents: vector(3, { min: 0 }), radius: F("number", { min: 0 }), halfHeight: F("number", { min: 0 }), points: F("object", { fields: { stream: required("id"), format: required("enum", { values: ["float32x3"] }) } }),
    geometry: F("id"), children: F("array", { items: F("object", { fields: { shape: required("id"), position: vector(3), rotation: F("quaternion") } }) }),
  },
  body: {
    id: required("id"), node: required("id"), shape: required("id"), motion: F("enum", { values: ["static", "kinematic", "dynamic"] }), layer: F("enum", { values: ["static", "moving", "debris", "sensor"] }),
    mass: F("number", { min: 0 }), centerOfMass: vector(3), friction: F("number", { min: 0 }), restitution: F("number", { min: 0, max: 1 }),
    damping: F("object", { fields: { linear: F("number", { min: 0 }), angular: F("number", { min: 0 }) } }), gravity: F("number"), ccd: F("boolean"), sensor: F("boolean"), sleep: F("boolean"), active: F("boolean"), switchable: F("boolean"),
  },
  constraint: {
    id: required("id"), type: required("enum", { values: ["fixed", "point", "hinge", "slider", "swingTwist"] }), bodies: required("array", { length: 2, items: F("id", { nullable: true }) }),
    frame: F("object", { fields: { position: vector(3), axis: vector(3), normal: vector(3) } }), limits: F("any"), limitSpring: F("object"), motor: F("object"), break: F("object", { fields: { force: F("number", { min: 0 }), torque: F("number", { min: 0 }) } }),
  },
  vehicle: {
    id: required("id"), type: required("enum", { values: ["wheeled"] }), body: required("id"),
    wheels: required("array", { min: 1, max: CAPS.wheelsPerVehicle, items: F("object", { fields: { id: required("id"), node: required("id"), radius: required("number", { min: 0.01 }), width: required("number", { min: 0.01 }),
      suspension: F("object", { fields: { min: F("number", { min: 0 }), max: F("number", { min: 0 }), rest: F("number", { min: 0 }), frequency: F("number", { min: 0 }), damping: F("number", { min: 0 }) } }),
      steer: F("number", { min: 0, max: Math.PI / 2 }), brake: F("number", { min: 0 }), handbrake: F("number", { min: 0 }) } }) }),
    engine: F("object", { fields: { maxTorque: F("number", { min: 0 }), minRPM: F("number", { min: 0 }), maxRPM: F("number", { min: 0 }) } }),
    transmission: F("object", { fields: { gears: F("array", { items: F("number") }), reverse: F("array", { items: F("number") }) } }),
    differentials: F("array", { items: F("object", { fields: { wheels: required("array", { length: 2, items: F("id") }), ratio: F("number"), split: F("number", { min: 0, max: 1 }), engineShare: F("number", { min: 0, max: 1 }), limitedSlip: F("number", { min: 1 }) } }) }),
    antiRoll: F("array", { items: F("object", { fields: { wheels: required("array", { length: 2, items: F("id") }), stiffness: F("number", { min: 0 }) } }) }),
  },
  ragdoll: { id: required("id"), skeleton: required("id"), parts: required("array", { min: 1, max: CAPS.ragdollParts }) },
  character: { id: required("id"), node: required("id"), shape: required("id"), offset: vector(3), mass: F("number", { min: 0 }), maxSlope: F("number", { min: 0, max: Math.PI / 2 }), stepHeight: F("number", { min: 0 }) },
  variant: { id: required("id"), axis: required("id"), overrides: required("array", { items: F("object", { fields: { node: required("id"), materials: F("array", { items: F("id") }), geometry: F("id"), visible: F("boolean"), morphWeights: F("array", { items: F("number") }) } }) }) },
  ref: { id: required("id"), model: required("string", { pattern: /^[a-z0-9]+(?:_[a-z0-9]+)*@v\d{3}$/ }) },
};

/** The profile id rule (§6): a slug of `[A-Za-z0-9_-]`, plus "-" and six hex digits of the name's SHA-256 whenever the slug lost anything. */
export async function idFromName(name) {
  const text = String(name ?? "");
  const slug = text.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 54);
  if (slug === text && slug.length) return slug;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const hex = Array.from(digest.subarray(0, 3), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${slug.replace(/^_+|_+$/g, "") || "node"}-${hex}`;
}

/** sha256 over bone ids, rest transforms ([position, rotation, scale] per bone) and inverse binds (§4.5), as "sha256:<hex>". */
export async function skeletonHash(bones, transforms, inverseBinds) {
  const parts = [];
  bones.forEach((id, i) => parts.push(id, JSON.stringify(transforms[i].map((v) => v.map((n) => Math.round(n * 1e6) / 1e6)))));
  parts.push(Array.from(inverseBinds, (n) => Math.round(n * 1e6) / 1e6).join(","));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n")));
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const isColor = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const isQuaternion = (v) => Array.isArray(v) && v.length === 4 && v.every(Number.isFinite) && Math.abs(Math.hypot(...v) - 1) <= 1e-3;

function checkField(value, spec, path, out) {
  if (value === undefined) { if (spec.required) out.push(`${path} is required`); return; }
  if (value === null) { if (!spec.nullable) out.push(`${path} is null`); return; }
  const fail = (why) => out.push(`${path} ${why}`);
  switch (spec.type) {
    case "any": return;
    case "string": if (typeof value !== "string") return fail("must be a string"); if (spec.max && value.length > spec.max) fail(`is longer than ${spec.max}`); if (spec.pattern && !spec.pattern.test(value)) fail("has the wrong form"); return;
    case "id": if (typeof value !== "string" || !ID.test(value)) return fail("must be an id: 1–64 characters of A–Z a–z 0–9 _ -"); return;
    case "extension": if (typeof value !== "string" || !EXTENSION.test(value)) return fail("must be an extension name (fun3d.<name> or x.<game>.<name>)"); return;
    case "color": if (!isColor(value)) fail("must be a colour #rrggbb"); return;
    case "quaternion": if (!isQuaternion(value)) fail("must be a unit quaternion [x, y, z, w]"); return;
    case "boolean": if (typeof value !== "boolean") fail("must be true or false"); return;
    case "number": case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return fail("must be a finite number");
      if (spec.type === "integer" && !Number.isInteger(value)) return fail("must be an integer");
      if (spec.min !== undefined && value < spec.min) fail(`is below ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) fail(`is above ${spec.max}`);
      return;
    case "enum": if (!spec.values.includes(value)) fail(`must be one of ${spec.values.join(", ")}`); return;
    case "array":
      if (!Array.isArray(value)) return fail("must be an array");
      if (spec.length !== undefined && value.length !== spec.length) fail(`must have ${spec.length} items`);
      if (spec.min !== undefined && value.length < spec.min) fail(`needs at least ${spec.min} items`);
      if (spec.max !== undefined && value.length > spec.max) fail(`has more than ${spec.max} items`);
      if (spec.items) value.forEach((item, i) => checkField(item, spec.items, `${path}[${i}]`, out));
      return;
    case "object":
      if (!value || typeof value !== "object" || Array.isArray(value)) return fail("must be an object");
      if (spec.fields) for (const [key, field] of Object.entries(spec.fields)) checkField(value[key], field, `${path}.${key}`, out);
      return;
    case "map":
      if (!value || typeof value !== "object" || Array.isArray(value)) return fail("must be an object");
      for (const [key, item] of Object.entries(value)) {
        if (!ID.test(key) && !/^(?:position|normal|tangent|uv|uv1|color|skinIndex|skinWeight|_[A-Za-z0-9_-]{1,62})$/.test(key)) out.push(`${path}.${key} is not an id`);
        checkField(item, spec.items ?? F("object", { fields: spec.fields }), `${path}.${key}`, out);
      }
      return;
    default: fail(`has an unknown spec ${spec.type}`);
  }
}

function checkTable(list, spec, name, out, { max } = {}) {
  if (!Array.isArray(list)) { out.push(`${name} must be an array`); return new Map(); }
  if (max !== undefined && list.length > max) out.push(`${name} has more than ${max} entries`);
  const ids = new Map();
  list.forEach((entry, i) => {
    const path = `${name}[${i}]`;
    checkField(entry, F("object", { fields: spec }), path, out);
    if (entry && typeof entry === "object" && typeof entry.id === "string") {
      if (ids.has(entry.id)) out.push(`${path} repeats id "${entry.id}"`);
      ids.set(entry.id, entry);
    }
  });
  return ids;
}

/** Problems with a manifest (an array of strings; empty when valid). `chunks` is the BIN count. */
export function validateManifest(manifest, { chunks = Infinity, caps = CAPS } = {}) {
  const out = [];
  if (!manifest || typeof manifest !== "object") return ["The manifest must be an object"];
  checkField(manifest, F("object", { fields: SCHEMA.root }), "manifest", out);
  if (typeof manifest.fun3d === "string" && !/^\d+\.\d+$/.test(manifest.fun3d)) out.push("manifest.fun3d must be major.minor");
  else if (typeof manifest.fun3d === "string" && Number(manifest.fun3d.split(".")[0]) > Number(VERSION.split(".")[0])) out.push(`manifest.fun3d ${manifest.fun3d} is newer than this runtime reads (${VERSION})`);
  const uses = new Set(manifest.uses ?? []);
  for (const name of manifest.requires ?? []) if (!uses.has(name)) out.push(`requires lists "${name}" which uses does not`);
  if (manifest.extensions && JSON.stringify(manifest.extensions).length > caps.extensionsBytes) out.push("extensions are larger than the cap");

  const streams = checkTable(manifest.streams ?? [], SCHEMA.stream, "streams", out, { max: caps.streams });
  let decoded = 0;
  for (const s of streams.values()) {
    if (s.chunk >= chunks) out.push(`stream "${s.id}" names BIN chunk ${s.chunk} which the file lacks`);
    if (s.offset % 4) out.push(`stream "${s.id}" is not 4-byte aligned`);
    if (!s.codec && s.length !== s.count * s.stride) out.push(`stream "${s.id}" length is not count × stride`);
    if (s.codec === "meshopt" && !s.mode) out.push(`stream "${s.id}" has a codec but no mode`);
    if (s.mode === "attributes" && (s.stride % 4 || s.stride > caps.vertexStride)) out.push(`stream "${s.id}" attribute stride must be a multiple of 4 up to ${caps.vertexStride}`);
    if (s.mode === "triangles" && (s.count % 3 || ![2, 4].includes(s.stride))) out.push(`stream "${s.id}" triangle stream needs a count divisible by 3 and 16- or 32-bit indices`);
    if (s.filter && !s.filterBits) out.push(`stream "${s.id}" has a filter without filterBits`);
    decoded += s.count * s.stride;
  }
  if (decoded > caps.decoded) out.push(`streams decode to ${decoded} bytes, above ${caps.decoded}`);
  const stream = (id, path) => { if (id !== undefined && !streams.has(id)) out.push(`${path} names unknown stream "${id}"`); return streams.get(id); };

  const refs = checkTable(manifest.refs ?? [], SCHEMA.ref, "refs", out, { max: caps.refs });
  const nodes = checkTable(manifest.nodes ?? [], SCHEMA.node, "nodes", out, { max: caps.nodes });
  const geometries = checkTable(manifest.geometries ?? [], SCHEMA.geometry, "geometries", out, { max: caps.geometries });
  const materials = checkTable(manifest.materials ?? [], SCHEMA.material, "materials", out, { max: caps.materials });
  const images = checkTable(manifest.images ?? [], SCHEMA.image, "images", out, { max: caps.images });
  const textures = checkTable(manifest.textures ?? [], SCHEMA.texture, "textures", out, { max: caps.textures });
  const skeletons = checkTable(manifest.skeletons ?? [], SCHEMA.skeleton, "skeletons", out, { max: caps.skeletons });
  const animations = checkTable(manifest.animations ?? [], SCHEMA.animation, "animations", out, { max: caps.clips });
  const physics = manifest.physics ?? {};
  const shapes = checkTable(physics.shapes ?? [], SCHEMA.shape, "physics.shapes", out, { max: caps.shapes });
  const bodies = checkTable(physics.bodies ?? [], SCHEMA.body, "physics.bodies", out, { max: caps.bodies });
  const constraints = checkTable(physics.constraints ?? [], SCHEMA.constraint, "physics.constraints", out, { max: caps.constraints });
  const vehicles = checkTable(physics.vehicles ?? [], SCHEMA.vehicle, "physics.vehicles", out, { max: caps.vehicles });
  const ragdolls = checkTable(physics.ragdolls ?? [], SCHEMA.ragdoll, "physics.ragdolls", out);
  const characters = checkTable(physics.characters ?? [], SCHEMA.character, "physics.characters", out, { max: caps.characters });
  checkTable(manifest.variants ?? [], SCHEMA.variant, "variants", out, { max: caps.variants });
  const ref = (table, id, path, what) => { if (id !== undefined && !table.has(id)) out.push(`${path} names unknown ${what} "${id}"`); };

  // Nodes: depth-first order, a tree, combinations, placements, lights.
  const nodeList = manifest.nodes ?? [];
  let lights = 0, placements = 0, bodiesOnNodes = new Map();
  for (const b of bodies.values()) bodiesOnNodes.set(b.node, (bodiesOnNodes.get(b.node) ?? 0) + 1);
  if (nodeList.length && nodeList[0].parent !== undefined) out.push("nodes[0] is the root and has no parent");
  const seen = new Set();
  nodeList.forEach((node, i) => {
    const path = `nodes[${i}]`;
    if (i > 0) {
      if (node.parent === undefined) out.push(`${path} needs a parent`);
      else if (!seen.has(node.parent)) out.push(`${path} comes before its parent (nodes are depth-first)`);
    }
    seen.add(node.id);
    if (node.mesh) {
      const g = geometries.get(node.mesh.geometry);
      ref(geometries, node.mesh.geometry, `${path}.mesh.geometry`, "geometry");
      node.mesh.materials.forEach((m, k) => ref(materials, m, `${path}.mesh.materials[${k}]`, "material"));
      if (g) {
        const slots = new Set((g.groups ?? []).map((group) => group.material));
        if (node.mesh.materials.length !== slots.size) out.push(`${path}.mesh.materials has ${node.mesh.materials.length} entries for ${slots.size} group slots`);
        if (node.mesh.morphWeights && node.mesh.morphWeights.length !== (g.morph?.targets?.length ?? 0)) out.push(`${path}.mesh.morphWeights has the wrong length`);
        for (const m of node.mesh.materials) {
          const material = materials.get(m);
          for (const [slot, map] of Object.entries(material?.maps ?? {})) {
            const set = map.uv ? `uv${map.uv}` : "uv";
            if (!(g.buffers ?? []).some((b) => b.attributes?.[set])) out.push(`${path} uses material "${m}" whose ${slot} map samples ${set}, which geometry "${g.id}" lacks`);
          }
        }
      }
      if (node.light) out.push(`${path} has both a mesh and a light`);
      if (node.lod) out.push(`${path} has both a mesh and a lod`);
    }
    if (node.skin) { ref(skeletons, node.skin, `${path}.skin`, "skeleton"); if (!node.mesh) out.push(`${path} has a skin without a mesh`); if (node.placements || node.lod) out.push(`${path} skinned nodes have no placements or lod`); if (bodiesOnNodes.has(node.id)) out.push(`${path} skinned nodes carry no body`); }
    if (node.placements) {
      placements += node.placements.count;
      if (node.placements.count > caps.placementsPerNode) out.push(`${path} has more than ${caps.placementsPerNode} placements`);
      const t = stream(node.placements.transforms?.stream, `${path}.placements.transforms`);
      if (t && t.count !== node.placements.count) out.push(`${path}.placements.transforms has ${t.count} matrices for ${node.placements.count} copies`);
      if (node.placements.tint) { const tint = stream(node.placements.tint.stream, `${path}.placements.tint`); if (tint && tint.count !== node.placements.count) out.push(`${path}.placements.tint count differs from the copies`); }
      if (node.light || node.lod || node.skin) out.push(`${path} placed nodes have no light, lod or skin`);
      if (nodeList.some((n) => n.parent === node.id)) out.push(`${path} placed nodes have no children`);
      const body = [...bodies.values()].find((b) => b.node === node.id);
      if (body && (body.motion ?? "static") !== "static") out.push(`${path} a placed node's body is static`);
    }
    if (node.light) {
      lights++;
      if (node.light.type === "spot" && !node.light.cone) out.push(`${path}.light spots need a cone`);
      if (node.light.cone && node.light.cone[0] > node.light.cone[1]) out.push(`${path}.light.cone inner is wider than outer`);
      if (bodiesOnNodes.has(node.id)) out.push(`${path} lights carry no body`);
    }
    if (node.lod) {
      const children = new Set(nodeList.filter((n) => n.parent === node.id).map((n) => n.id));
      let last = Infinity;
      node.lod.levels.forEach((level, k) => {
        if (level.screenSize > last) out.push(`${path}.lod.levels[${k}] is not in descending order`);
        last = level.screenSize;
        for (const c of level.children) if (!children.has(c)) out.push(`${path}.lod.levels[${k}] names "${c}" which is not a child`);
      });
    }
    if (node.model) {
      ref(refs, node.model.ref, `${path}.model.ref`, "ref");
      if (node.mesh || node.skin || node.light || node.lod) out.push(`${path} a placed model has no mesh, skin, light or lod of its own`);
      if (node.model.variants && Object.keys(node.model.variants).length > caps.modelVariants) out.push(`${path}.model.variants has more than ${caps.modelVariants} axes`);
    }
    if (node.extensions) {
      for (const name of Object.keys(node.extensions)) if (!uses.has(name)) out.push(`${path} uses the extension "${name}" which uses does not list`);
      const params = node.extensions["fun3d.params"];
      if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) out.push(`${path}.extensions["fun3d.params"] is an object`);
      else if (params !== undefined && JSON.stringify(params).length > caps.paramsBytes) out.push(`${path}.extensions["fun3d.params"] is larger than ${caps.paramsBytes} bytes`);
    }
    if ((node.sockets && Object.keys(node.sockets).length > caps.socketsPerNode)) out.push(`${path} has more than ${caps.socketsPerNode} sockets`);
    if ((node.regions?.length ?? 0) > caps.regionsPerNode) out.push(`${path} has more than ${caps.regionsPerNode} regions`);
    if ((bodiesOnNodes.get(node.id) ?? 0) > 1) out.push(`${path} carries more than one body`);
  });
  if (lights > caps.lights) out.push(`more than ${caps.lights} lights`);
  if (placements > caps.placements) out.push(`more than ${caps.placements} placements in all`);
  validateSceneExtensions(manifest, { uses, streams, nodes, caps, out });
  const bones = new Set([...skeletons.values()].flatMap((s) => s.bones));
  for (const b of bodies.values()) if (bones.has(b.node) && !ragdolls.size) out.push(`physics.bodies "${b.id}" sits on a bone`);

  // Geometries: streams, formats, strides, groups, caps.
  let vertices = 0, triangles = 0, morphVertices = 0;
  for (const g of geometries.values()) {
    const path = `geometries "${g.id}"`;
    const names = new Set();
    let attributes = 0;
    for (const [bi, buffer] of (g.buffers ?? []).entries()) {
      const s = stream(buffer.stream, `${path}.buffers[${bi}]`);
      let type = null;
      for (const [name, attribute] of Object.entries(buffer.attributes ?? {})) {
        attributes++;
        if (names.has(name)) out.push(`${path} repeats attribute ${name}`);
        names.add(name);
        const format = FORMATS[attribute.format];
        if (!format) continue;
        if (ATTRIBUTE_FORMATS[name] && !ATTRIBUTE_FORMATS[name].includes(attribute.format)) out.push(`${path}.${name} cannot be ${attribute.format}`);
        if (attribute.offset % 4) out.push(`${path}.${name} offset is not a multiple of 4`);
        if (type && type !== format[0]) out.push(`${path}.buffers[${bi}] mixes element types`);
        type = format[0];
        if (s && attribute.offset + format[3] > s.stride) out.push(`${path}.${name} runs past the buffer stride`);
        if (name === "skinIndex" && Object.keys(buffer.attributes).length > 1) out.push(`${path}.skinIndex must be a buffer of its own`);
      }
      if (s && s.count < g.vertices) out.push(`${path}.buffers[${bi}] has ${s.count} vertices, fewer than ${g.vertices}`);
    }
    if (attributes > caps.attributesPerGeometry) out.push(`${path} has more than ${caps.attributesPerGeometry} attributes`);
    if (!names.has("position")) out.push(`${path} has no position`);
    if (names.has("skinIndex") !== names.has("skinWeight")) out.push(`${path} needs both skinIndex and skinWeight`);
    for (const name of names) if (name === "position" && g.buffers.some((b) => b.attributes.position?.format === "snorm16x4") && !g.decode?.position) out.push(`${path} quantized positions need decode.position`);
    const index = stream(g.index?.stream, `${path}.index`);
    const count = index?.count ?? 0;
    if (index && index.mode && index.mode !== "triangles") out.push(`${path}.index stream is not a triangle stream`);
    if (count % 3) out.push(`${path}.index count is not a multiple of 3`);
    let slotMax = -1, end = 0;
    for (const [k, group] of (g.groups ?? []).entries()) {
      if (group.start !== end) out.push(`${path}.groups[${k}] does not start where the previous group ends`);
      end = group.start + group.count;
      if (group.count % 3) out.push(`${path}.groups[${k}] count is not a multiple of 3`);
      if (group.material > slotMax + 1) out.push(`${path}.groups[${k}] skips a material slot`);
      slotMax = Math.max(slotMax, group.material);
    }
    if (end !== count) out.push(`${path}.groups do not cover the index stream (${end} of ${count})`);
    vertices += g.vertices; triangles += count / 3;
    if (count / 3 > caps.trianglesPerGeometry) out.push(`${path} has more than ${caps.trianglesPerGeometry} triangles`);
    let lastError = -1;
    for (const [k, lod] of (g.lods ?? []).entries()) {
      if (lod.error < lastError) out.push(`${path}.lods[${k}] errors are not ascending`);
      lastError = lod.error;
      const ls = stream(lod.index?.stream, `${path}.lods[${k}].index`);
      if (ls) triangles += ls.count / 3;
      const covered = (lod.groups ?? []).reduce((n, group) => n + group.count, 0);
      if (ls && covered !== ls.count) out.push(`${path}.lods[${k}].groups do not cover its index stream`);
    }
    for (const target of g.morph?.targets ?? []) {
      const si = stream(target.sparse?.indices?.stream, `${path}.morph ${target.id} indices`), sp = stream(target.position?.stream, `${path}.morph ${target.id} position`);
      if (si && sp && si.count !== sp.count) out.push(`${path}.morph ${target.id} has mismatched index and position counts`);
      if (target.normal) { const sn = stream(target.normal.stream, `${path}.morph ${target.id} normal`); if (sn && si && sn.count !== si.count) out.push(`${path}.morph ${target.id} has mismatched normal count`); }
      morphVertices += g.vertices;
    }
    if (g.morph && !g.morph.decode && g.morph.targets.some((t) => t.position.format === "snorm16x4")) out.push(`${path}.morph quantized deltas need morph.decode`);
    const bounds = g.bounds;
    if (bounds && bounds.min.some((v, k) => v > bounds.max[k])) out.push(`${path}.bounds min exceeds max`);
  }
  if (vertices > caps.vertices) out.push(`more than ${caps.vertices} vertices in all`);
  if (triangles > caps.triangles) out.push(`more than ${caps.triangles} triangles in all`);
  if (morphVertices > caps.morphTargetVertices) out.push(`morph targets × vertices exceed ${caps.morphTargetVertices}`);

  // Materials, images, textures.
  for (const m of materials.values()) {
    const path = `materials "${m.id}"`;
    for (const [slot, map] of Object.entries(m.maps ?? {})) {
      if (!["color", "normal", "metalRough", "occlusion", "alpha"].includes(slot)) out.push(`${path}.maps.${slot} is not a map slot`);
      ref(textures, map.texture, `${path}.maps.${slot}.texture`, "texture");
      if ((m.model ?? "pbr") === "unlit" && !["color", "alpha"].includes(slot)) out.push(`${path} unlit materials take only color and alpha maps`);
    }
    for (const [name, feature] of Object.entries(m.features ?? {})) {
      if (!["emitter", "tint", "transmission"].includes(name) && !EXTENSION.test(name)) out.push(`${path}.features.${name} is neither a core feature nor an extension name`);
      if (name === "emitter") {
        if (typeof feature?.role !== "string") out.push(`${path}.features.emitter needs a role`);
        if (feature?.intensity !== undefined && !(feature.intensity >= 0 && feature.intensity <= caps.intensity)) out.push(`${path}.features.emitter.intensity is out of range`);
        if (feature?.map) ref(textures, feature.map.texture, `${path}.features.emitter.map.texture`, "texture");
      }
      if (name === "transmission" && (m.model ?? "pbr") === "unlit") out.push(`${path} transmission needs the pbr model`);
      if (EXTENSION.test(name) && !uses.has(name)) out.push(`${path}.features.${name} is not listed in uses`);
    }
  }
  for (const i of images.values()) {
    if (i.ref) { ref(refs, i.ref, `images "${i.id}".ref`, "ref"); if (!i.entry) out.push(`images "${i.id}" needs an entry with its ref`); }
    else { if (!i.mime) out.push(`images "${i.id}" needs a mime`); const s = stream(i.stream, `images "${i.id}".stream`); if (s && (s.codec || s.stride !== 1)) out.push(`images "${i.id}" stream must be raw bytes`); }
  }
  for (const t of textures.values()) {
    if (t.ref) { ref(refs, t.ref, `textures "${t.id}".ref`, "ref"); if (!t.entry) out.push(`textures "${t.id}" needs an entry with its ref`); }
    else ref(images, t.image, `textures "${t.id}".image`, "image");
  }

  // Skeletons and skins.
  for (const s of skeletons.values()) {
    const path = `skeletons "${s.id}"`;
    if (s.ref) { ref(refs, s.ref, `${path}.ref`, "ref"); if (!s.entry || !s.hash) out.push(`${path} needs entry and hash with its ref`); }
    else for (const b of s.bones) ref(nodes, b, `${path}.bones`, "node");
    const ib = stream(s.inverseBinds?.stream, `${path}.inverseBinds`);
    if (ib && ib.count !== s.bones.length) out.push(`${path}.inverseBinds count differs from the bones`);
    if (new Set(s.bones).size !== s.bones.length) out.push(`${path} repeats a bone`);
    if (s.rig?.roles) for (const [role, bone] of Object.entries(s.rig.roles)) if (!s.bones.includes(bone)) out.push(`${path}.rig.roles.${role} names "${bone}" which is not a bone`);
  }
  if (manifest.kind === "animations") {
    if (skeletons.size !== 1) out.push("an animation pack has exactly one skeleton");
    if (!(manifest.animations?.length)) out.push("an animation pack needs animations");
    for (const key of ["geometries", "materials", "images", "textures", "variants"]) if (manifest[key]?.length) out.push(`an animation pack has no ${key}`);
    if (manifest.physics && Object.keys(manifest.physics).length) out.push("an animation pack has no physics");
    for (const n of nodeList) if (n.mesh || n.placements || n.light) out.push(`an animation pack's nodes are bones only ("${n.id}")`);
  } else if (manifest.kind === "model" && !nodeList.length) out.push("a model needs nodes");

  // Animations.
  let keyframes = 0;
  for (const a of animations.values()) {
    const path = `animations "${a.id}"`;
    for (const [k, t] of (a.tracks ?? []).entries()) {
      const tp = `${path}.tracks[${k}]`;
      if ((t.node === undefined) === (t.material === undefined)) out.push(`${tp} names exactly one of node or material`);
      if (t.node !== undefined && manifest.kind !== "animations") ref(nodes, t.node, `${tp}.node`, "node");
      if (t.material !== undefined) ref(materials, t.material, `${tp}.material`, "material");
      const node = t.node !== undefined;
      const ok = node ? /^(?:position|rotation|scale|visible|morph:[A-Za-z0-9_-]{1,64}|light\.(?:intensity|color))$/.test(t.channel) : /^(?:color|alpha\.opacity|pbr\.(?:roughness|metalness)|emitter\.(?:intensity|color)|(?:fun3d|x\.[a-z0-9-]+)\.[A-Za-z0-9_.-]+)$/.test(t.channel);
      if (!ok) out.push(`${tp}.channel "${t.channel}" is not a ${node ? "node" : "material"} channel`);
      const expect = t.channel === "rotation" ? "snorm16x4" : /^(?:position|scale|light\.color|color|emitter\.color)$/.test(t.channel) ? "float32x3" : "float32";
      if (t.values?.format && t.values.format !== expect) out.push(`${tp}.values must be ${expect}`);
      const vs = stream(t.values?.stream, `${tp}.values`);
      let count;
      if (t.times?.stream !== undefined) { const ts = stream(t.times.stream, `${tp}.times`); count = ts?.count; if (ts && ts.stride !== 4) out.push(`${tp}.times must be float32`); }
      else if (t.times && t.times.fps && t.times.count) { count = t.times.count; if ((t.times.start ?? 0) + (count - 1) / t.times.fps > a.duration + 1e-6) out.push(`${tp} keyframes run past the duration`); }
      else out.push(`${tp}.times needs a stream or start, fps and count`);
      if (vs && count !== undefined && vs.count !== count) out.push(`${tp} has ${vs.count} values for ${count} times`);
      if (count) keyframes += count;
    }
    for (const [k, e] of (a.events ?? []).entries()) {
      if (e.time > a.duration) out.push(`${path}.events[${k}] is after the duration`);
      if (e.data && JSON.stringify(e.data).length > 1024) out.push(`${path}.events[${k}].data is larger than 1 KB`);
    }
    if (a.root?.node && manifest.kind !== "animations") ref(nodes, a.root.node, `${path}.root.node`, "node");
  }
  if (keyframes > caps.keyframes) out.push(`more than ${caps.keyframes} keyframes`);

  // Physics.
  for (const s of shapes.values()) {
    const path = `physics.shapes "${s.id}"`;
    const needs = { box: ["halfExtents"], sphere: ["radius"], capsule: ["halfHeight", "radius"], cylinder: ["halfHeight", "radius"], convex: ["points"], mesh: ["geometry"], compound: ["children"] }[s.type] ?? [];
    for (const key of needs) if (s[key] === undefined) out.push(`${path} ${s.type} needs ${key}`);
    if (s.type === "convex") { const ps = stream(s.points?.stream, `${path}.points`); if (ps && (ps.count < 4 || ps.count > caps.convexPoints)) out.push(`${path} needs 4–${caps.convexPoints} points`); }
    if (s.type === "mesh") { ref(geometries, s.geometry, `${path}.geometry`, "geometry"); const g = geometries.get(s.geometry); const is = g && streams.get(g.index?.stream); if (is && is.count / 3 > caps.meshTriangles) out.push(`${path} mesh has more than ${caps.meshTriangles} triangles`); }
    if (s.type === "compound") for (const [k, c] of (s.children ?? []).entries()) { ref(shapes, c.shape, `${path}.children[${k}].shape`, "shape"); if (shapes.get(c.shape)?.type === "compound") out.push(`${path}.children[${k}] nests a compound`); }
  }
  for (const b of bodies.values()) {
    const path = `physics.bodies "${b.id}"`;
    ref(nodes, b.node, `${path}.node`, "node"); ref(shapes, b.shape, `${path}.shape`, "shape");
    const shape = shapes.get(b.shape);
    if (shape?.type === "mesh" && (b.motion ?? "static") !== "static") out.push(`${path} mesh shapes belong to static bodies`);
    if (b.switchable && (b.motion ?? "static") !== "static") out.push(`${path} switchable applies to static bodies`);
  }
  for (const c of constraints.values()) {
    const path = `physics.constraints "${c.id}"`;
    c.bodies.forEach((b, k) => { if (b !== null) ref(bodies, b, `${path}.bodies[${k}]`, "body"); });
    if (c.bodies[1] === null) out.push(`${path} the second body cannot be the world`);
    if (["hinge", "slider", "swingTwist"].includes(c.type) && !c.frame) out.push(`${path} ${c.type} needs a frame`);
  }
  for (const v of vehicles.values()) {
    const path = `physics.vehicles "${v.id}"`;
    ref(bodies, v.body, `${path}.body`, "body");
    if (bodies.get(v.body) && (bodies.get(v.body).motion ?? "static") !== "dynamic") out.push(`${path} the body must be dynamic`);
    const wheels = new Set();
    for (const [k, w] of v.wheels.entries()) {
      if (wheels.has(w.id)) out.push(`${path}.wheels[${k}] repeats id "${w.id}"`);
      wheels.add(w.id);
      ref(nodes, w.node, `${path}.wheels[${k}].node`, "node");
      const s = w.suspension;
      if (s && ((s.min ?? 0.05) > (s.max ?? 0.25) || (s.rest !== undefined && (s.rest < (s.min ?? 0.05) || s.rest > (s.max ?? 0.25))))) out.push(`${path}.wheels[${k}].suspension needs min ≤ rest ≤ max`);
    }
    for (const list of [v.differentials ?? [], v.antiRoll ?? []]) for (const d of list) for (const w of d.wheels) if (!wheels.has(w)) out.push(`${path} names unknown wheel "${w}"`);
  }
  for (const r of ragdolls.values()) ref(skeletons, r.skeleton, `physics.ragdolls "${r.id}".skeleton`, "skeleton");
  for (const c of characters.values()) { ref(nodes, c.node, `physics.characters "${c.id}".node`, "node"); ref(shapes, c.shape, `physics.characters "${c.id}".shape`, "shape"); }
  for (const v of manifest.variants ?? []) {
    const axes = new Map();
    for (const [k, o] of (v.overrides ?? []).entries()) { ref(nodes, o.node, `variants "${v.id}".overrides[${k}].node`, "node"); if (o.geometry) ref(geometries, o.geometry, `variants "${v.id}".overrides[${k}].geometry`, "geometry"); for (const m of o.materials ?? []) ref(materials, m, `variants "${v.id}".overrides[${k}].materials`, "material"); }
    axes.set(v.axis, 1);
  }
  return out;
}

const vector3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const isId = (v) => typeof v === "string" && ID.test(v);
const small = (value, cap) => JSON.stringify(value ?? null).length <= cap;
/** The scene extensions of docs/worlds.md: zones, paths (with their point stream) and the tile record. */
function validateSceneExtensions(manifest, { uses, streams, nodes, caps, out }) {
  const extensions = manifest.extensions ?? {};
  for (const name of Object.keys(extensions)) if (!uses.has(name)) out.push(`extensions uses "${name}" which uses does not list`);
  const streamRef = (ref, path, formats) => {
    if (!ref || typeof ref !== "object" || !isId(ref.stream) || !formats.includes(ref.format)) { out.push(`${path} needs { stream, format } with a format of ${formats.join(", ")}`); return null; }
    if (!streams.has(ref.stream)) { out.push(`${path} names unknown stream "${ref.stream}"`); return null; }
    return streams.get(ref.stream);
  };
  const tagsAndParams = (entry, path) => {
    if (entry.tags !== undefined && (!Array.isArray(entry.tags) || entry.tags.some((t) => typeof t !== "string" || !t.length || t.length > 64))) out.push(`${path}.tags are strings of 1–64 characters`);
    if (entry.params !== undefined && (!entry.params || typeof entry.params !== "object" || Array.isArray(entry.params) || !small(entry.params, caps.paramsBytes))) out.push(`${path}.params is an object up to ${caps.paramsBytes} bytes`);
  };
  const zones = extensions["fun3d.zones"];
  if (zones !== undefined) {
    if (!Array.isArray(zones) || zones.length > caps.zones) out.push(`extensions["fun3d.zones"] is an array of up to ${caps.zones} zones`);
    else {
      const ids = new Set();
      zones.forEach((z, i) => {
        const path = `extensions["fun3d.zones"][${i}]`;
        if (!z || typeof z !== "object" || !isId(z.id)) { out.push(`${path} needs an id`); return; }
        if (ids.has(z.id)) out.push(`${path} repeats the id "${z.id}"`);
        ids.add(z.id);
        tagsAndParams(z, path);
        const shape = z.shape ?? {};
        if (shape.polygon) {
          if (!Array.isArray(shape.polygon) || shape.polygon.length < 3 || shape.polygon.length > caps.zonePolygon || shape.polygon.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) out.push(`${path}.shape.polygon is 3–${caps.zonePolygon} [x, z] points`);
          if (shape.y !== undefined && (!Array.isArray(shape.y) || shape.y.length !== 2 || !shape.y.every(Number.isFinite) || shape.y[1] < shape.y[0])) out.push(`${path}.shape.y is [bottom, top]`);
        } else if (shape.box) {
          if (!vector3(shape.box.center) || !vector3(shape.box.halfExtents) || shape.box.halfExtents.some((v) => v < 0)) out.push(`${path}.shape.box needs center and halfExtents`);
          if (shape.box.rotation !== undefined && !isQuaternion(shape.box.rotation)) out.push(`${path}.shape.box.rotation is a unit quaternion`);
        } else if (shape.sphere) {
          if (!vector3(shape.sphere.center) || !(shape.sphere.radius >= 0)) out.push(`${path}.shape.sphere needs center and radius`);
        } else out.push(`${path}.shape is a polygon, a box or a sphere`);
      });
    }
  }
  const paths = extensions["fun3d.paths"];
  if (paths !== undefined) {
    if (!paths || typeof paths !== "object") out.push(`extensions["fun3d.paths"] is an object`);
    else {
      const points = streamRef(paths.points, `extensions["fun3d.paths"].points`, ["float32x3"]);
      if (points && points.count > caps.pathPoints) out.push(`extensions["fun3d.paths"] has more than ${caps.pathPoints} points`);
      for (const [name, ref] of Object.entries(paths.attributes ?? {})) {
        const s = streamRef(ref, `extensions["fun3d.paths"].attributes.${name}`, ["float32"]);
        if (s && points && s.count !== points.count) out.push(`extensions["fun3d.paths"].attributes.${name} has ${s.count} values for ${points.count} points`);
      }
      if (!Array.isArray(paths.edges) || paths.edges.length > caps.pathEdges) out.push(`extensions["fun3d.paths"].edges is an array of up to ${caps.pathEdges} edges`);
      else {
        const ids = new Set();
        paths.edges.forEach((e, i) => {
          const path = `extensions["fun3d.paths"].edges[${i}]`;
          if (!e || typeof e !== "object" || !isId(e.id)) { out.push(`${path} needs an id`); return; }
          if (ids.has(e.id)) out.push(`${path} repeats the id "${e.id}"`);
          ids.add(e.id);
          tagsAndParams(e, path);
          if (!Array.isArray(e.points) || e.points.length < 2 || e.points.some((k) => !Number.isInteger(k) || k < 0 || (points && k >= points.count))) out.push(`${path}.points indexes at least two of the table's points`);
          if (e.kind !== undefined && typeof e.kind !== "string") out.push(`${path}.kind is a string`);
        });
      }
    }
  }
  const terrains = extensions["fun3d.terrain"];
  if (terrains !== undefined) {
    if (!Array.isArray(terrains) || terrains.length > 16) out.push(`extensions["fun3d.terrain"] is an array of up to 16 terrains`);
    else terrains.forEach((t, i) => {
      const path = `extensions["fun3d.terrain"][${i}]`;
      if (!t || typeof t !== "object" || !isId(t.node) || !nodes.has(t.node)) { out.push(`${path} names a node`); return; }
      if (!vector3(t.origin) || !(t.cell > 0) || !Array.isArray(t.samples) || t.samples.length !== 2 || t.samples.some((v) => !Number.isInteger(v) || v < 2 || v > 4097)) out.push(`${path} needs origin, cell and samples [columns, rows]`);
      const heights = streamRef(t.heights, `${path}.heights`, ["float32"]);
      if (heights && Array.isArray(t.samples) && heights.count !== t.samples[0] * t.samples[1]) out.push(`${path}.heights has ${heights.count} values for ${t.samples[0]} × ${t.samples[1]} samples`);
      if (t.surfaces !== undefined) {
        const surfaces = streamRef(t.surfaces, `${path}.surfaces`, ["uint8"]);
        if (surfaces && Array.isArray(t.samples) && surfaces.count !== (t.samples[0] - 1) * (t.samples[1] - 1)) out.push(`${path}.surfaces has one value per cell`);
      }
      if (!Array.isArray(t.surfaceTable) || !t.surfaceTable.length || t.surfaceTable.length > 16 || t.surfaceTable.some((s) => !s || typeof s.id !== "string")) out.push(`${path}.surfaceTable has 1–16 surfaces with ids`);
    });
  }
  const rules = extensions["fun3d.rules"];
  if (rules !== undefined) {
    if (!Array.isArray(rules) || rules.length > 64) out.push(`extensions["fun3d.rules"] is an array of up to 64 rules`);
    else {
      const ids = new Set();
      rules.forEach((r, i) => {
        const path = `extensions["fun3d.rules"][${i}]`;
        if (!r || typeof r !== "object" || !isId(r.id) || !["scatter", "assemble"].includes(r.kind)) { out.push(`${path} needs an id and a kind of scatter or assemble`); return; }
        if (ids.has(r.id)) out.push(`${path} repeats the id "${r.id}"`);
        ids.add(r.id);
        const models = r.kind === "assemble" ? r.pieces : r.candidates;
        if (!Array.isArray(models) || !models.length || models.some((m) => !m || typeof m.model !== "string")) out.push(`${path} needs ${r.kind === "assemble" ? "pieces" : "candidates"} with models`);
      });
    }
  }
  const tile = extensions["fun3d.tile"];
  if (tile !== undefined) {
    if (!tile || typeof tile !== "object") out.push(`extensions["fun3d.tile"] is an object`);
    else {
      if (tile.bounds !== undefined && (!tile.bounds || !vector3(tile.bounds.min) || !vector3(tile.bounds.max))) out.push(`extensions["fun3d.tile"].bounds needs min and max`);
      if (tile.size !== undefined && (!Array.isArray(tile.size) || tile.size.length !== 2 || !tile.size.every((v) => v > 0))) out.push(`extensions["fun3d.tile"].size is [width, depth]`);
      // A tile of a world (docs/worlds.md §3.2): the world's id, its coordinates, its far file.
      if (tile.world !== undefined && typeof tile.world !== "string") out.push(`extensions["fun3d.tile"].world is the world's id`);
      if ((tile.x !== undefined || tile.z !== undefined) && !(Number.isInteger(tile.x) && Number.isInteger(tile.z))) out.push(`extensions["fun3d.tile"].x and z are integers`);
      if (tile.far !== undefined && tile.far !== null && typeof tile.far !== "string") out.push(`extensions["fun3d.tile"].far names the far file`);
      if (tile.level !== undefined && tile.level !== "far") out.push(`extensions["fun3d.tile"].level is "far" or absent`);
    }
  }
  void nodes;
}
