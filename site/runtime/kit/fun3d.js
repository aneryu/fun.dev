// .fun3d, fun.dev's native model format (docs/model-format.md): Three.js objects in and out.
// A file is a signature and chunks. The JSON chunk describes nodes, geometries, materials,
// textures, skins, animations and physics; BIN chunks hold their data in WebGPU vertex formats
// (meshopt-coded, then deflated); EDIT chunks carry the workshop's editable document and are
// dropped from the copies games download.
//
// The module takes its dependencies so the same code runs in browsers, workers and Node:
//   const fun3d = createFun3d({ THREE, encoder: MeshoptEncoder, decoder: MeshoptDecoder });
//   const bytes = await fun3d.write(object, { animations, physics, edit });
//   const { scene, animations, physics } = await fun3d.load(bytes);

const SIGNATURE = Uint8Array.of(0x89, 0x46, 0x55, 0x4e, 0x33, 0x44, 0x0d, 0x0a); // \x89FUN3D\r\n
const DEFLATE = 1, EDITING = 2;
export const VERSION = 1;

// WebGPU vertex formats: typed array, components, normalized. mat4 holds matrices.
export const FORMATS = {
  float32: [Float32Array, 1, false], float32x2: [Float32Array, 2, false], float32x3: [Float32Array, 3, false],
  float32x4: [Float32Array, 4, false], mat4: [Float32Array, 16, false],
  snorm16x2: [Int16Array, 2, true], snorm16x4: [Int16Array, 4, true],
  unorm16x2: [Uint16Array, 2, true], unorm16x4: [Uint16Array, 4, true],
  snorm8x4: [Int8Array, 4, true], unorm8x4: [Uint8Array, 4, true],
  uint8x4: [Uint8Array, 4, false], uint16x2: [Uint16Array, 2, false], uint16x4: [Uint16Array, 4, false],
  uint16: [Uint16Array, 1, false], uint32: [Uint32Array, 1, false],
};

// ---- container ----

async function transform(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
const typeCode = (type) => [...type].reduce((n, c, i) => n | (c.charCodeAt(0) << (8 * i)), 0) >>> 0;
const typeName = (code) => String.fromCharCode(code & 255, (code >> 8) & 255, (code >> 16) & 255, code >>> 24);

/** chunks: [{ type: "JSON" | "BIN " | "EDIT" | "EBIN", bytes, deflate?, editing? }] → file bytes. */
export async function packChunks(chunks) {
  const parts = [SIGNATURE];
  for (const chunk of chunks) {
    const data = chunk.deflate ? await transform(chunk.bytes, new CompressionStream("deflate-raw")) : chunk.bytes;
    const head = new DataView(new ArrayBuffer(12));
    head.setUint32(0, typeCode(chunk.type), true);
    head.setUint32(4, (chunk.deflate ? DEFLATE : 0) | (chunk.editing ? EDITING : 0), true);
    head.setUint32(8, data.length, true);
    parts.push(new Uint8Array(head.buffer), data, new Uint8Array((4 - (data.length % 4)) % 4));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

function scanChunks(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error("Not a .fun3d file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset + 8, true);
    chunks.push({ type: typeName(view.getUint32(offset, true)), flags: view.getUint32(offset + 4, true), start: offset, data: bytes.subarray(offset + 12, offset + 12 + length) });
    offset += 12 + length + ((4 - (length % 4)) % 4);
  }
  return { bytes, chunks };
}

/** Chunks with their data inflated; editing chunks only when asked for. */
export async function unpackChunks(bytes, { editing = false } = {}) {
  const { chunks } = scanChunks(bytes);
  return Promise.all(chunks.filter((c) => editing || !(c.flags & EDITING)).map(async (c) => ({
    type: c.type, editing: !!(c.flags & EDITING),
    bytes: c.flags & DEFLATE ? await transform(c.data, new DecompressionStream("deflate-raw")) : c.data,
  })));
}

/** The runtime copy games download: the same file without its editing chunks. */
export function stripEditing(bytes) {
  const { bytes: all, chunks } = scanChunks(bytes);
  const keep = [all.subarray(0, 8)];
  chunks.forEach((c, i) => {
    if (c.flags & EDITING) return;
    const end = i + 1 < chunks.length ? chunks[i + 1].start : all.length;
    keep.push(all.subarray(c.start, end));
  });
  const out = new Uint8Array(keep.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of keep) { out.set(p, offset); offset += p.length; }
  return out;
}

class Bytes {
  constructor() { this.parts = []; this.length = 0; }
  append(bytes) {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) { this.parts.push(new Uint8Array(pad)); this.length += pad; }
    const offset = this.length;
    this.parts.push(bytes);
    this.length += bytes.length;
    return offset;
  }
  bytes() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const p of this.parts) { out.set(p, offset); offset += p.length; }
    return out;
  }
}

const round = (n, digits = 6) => +n.toFixed(digits);
const bytesOf = (typed) => new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);

export function createFun3d({ THREE, encoder, decoder }) {
  const sanitize = (name) => THREE.PropertyBinding.sanitizeNodeName(name ?? "");

  // ---- writing ----

  async function write(root, { kind = "model", name = root.name, animations = [], physics = null, rig = null, edit = null, quantize = true, compress = true } = {}) {
    if (encoder) await encoder.ready;
    const main = new Bytes(), stored = new Bytes();
    const manifest = { format: "fun3d", version: VERSION, kind, name: name || undefined, generator: "fun.dev fun3d 1",
      buffers: [], streams: [], nodes: [], geometries: [], materials: [], textures: [], skins: [], animations: [] };

    function stream(typed, { count, stride, mode = "attributes", store = false }) {
      let data = bytesOf(typed), codec;
      if (!store && encoder && count > 0 && mode === "triangles" && count % 3 === 0) {
        data = encoder.encodeIndexBuffer(data, count, stride);
        codec = "meshopt-triangles";
      } else if (!store && encoder && count > 0 && mode === "attributes" && stride % 4 === 0 && stride <= 256) {
        data = encoder.encodeVertexBuffer(data, count, stride);
        codec = "meshopt-attributes";
      }
      const target = store ? stored : main;
      manifest.streams.push({ buffer: store ? 1 : 0, offset: target.append(data), length: data.length, count, stride, ...(codec ? { codec } : {}) });
      return manifest.streams.length - 1;
    }

    // Nodes, depth first; the root is node 0.
    const nodeIndex = new Map(), objects = [];
    root.traverse((object) => { nodeIndex.set(object, objects.length); objects.push(object); });

    const geometryIndex = new Map(), materialIndex = new Map(), textureIndex = new Map(), images = [];
    function writeGeometry(geometry, { skinned }) {
      const key = `${geometry.uuid}:${skinned}`;
      if (geometryIndex.has(key)) return geometryIndex.get(key);
      const position = geometry.getAttribute("position");
      const count = position.count, out = { vertices: count, attributes: {} };
      const box = new THREE.Box3().setFromBufferAttribute(position);
      out.bounds = { min: box.min.toArray().map((n) => round(n)), max: box.max.toArray().map((n) => round(n)) };
      const morphed = !!geometry.morphAttributes.position?.length;
      // 16-bit positions in the bounds, one scale for all axes (normals stay valid). Rigid
      // meshes keep them on the GPU; skinned and morphed ones are expanded when loaded.
      const quantized = quantize;
      for (const [attributeName, attribute] of Object.entries(geometry.attributes)) {
        const n = attribute.count;
        if (attributeName === "position") {
          if (quantized) {
            const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
            const scale = Math.max(size.x, size.y, size.z, 1e-9) / 2;
            const q = new Int16Array(n * 4);
            for (let i = 0; i < n; i++)
              for (let k = 0; k < 3; k++)
                q[i * 4 + k] = Math.max(-8191, Math.min(8191, Math.round(((attribute.getComponent(i, k) - center.getComponent(k)) / scale) * 8191))) * 4;
            out.attributes.position = { stream: stream(q, { count: n, stride: 8 }), format: "snorm16x4" };
            // snorm16 decodes q / 32767; positions keep 14 bits (q is a multiple of 4).
            out.quantization = { offset: center.toArray().map((v) => round(v)), scale: round((scale * 32767) / 32764, 9) };
          } else {
            const f = new Float32Array(n * 3);
            for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) f[i * 3 + k] = attribute.getComponent(i, k);
            out.attributes.position = { stream: stream(f, { count: n, stride: 12 }), format: "float32x3" };
          }
        } else if (attributeName === "normal") {
          const wide = morphed, q = wide ? new Int16Array(n * 4) : new Int8Array(n * 4), max = wide ? 32767 : 127;
          for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) q[i * 4 + k] = Math.round(Math.max(-1, Math.min(1, attribute.getComponent(i, k))) * max);
          out.attributes.normal = { stream: stream(q, { count: n, stride: wide ? 8 : 4 }), format: wide ? "snorm16x4" : "snorm8x4" };
        } else if (attributeName === "skinIndex") {
          const joints = new Uint16Array(n * 4);
          for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) joints[i * 4 + k] = attribute.getComponent(i, k);
          const wide = joints.some((j) => j > 255), q = wide ? joints : Uint8Array.from(joints);
          out.attributes.skinIndex = { stream: stream(q, { count: n, stride: wide ? 8 : 4 }), format: wide ? "uint16x4" : "uint8x4" };
        } else if (attributeName === "skinWeight") {
          // 8-bit weights that still sum to exactly 255.
          const q = new Uint8Array(n * 4);
          for (let i = 0; i < n; i++) {
            const w = [0, 1, 2, 3].map((k) => attribute.getComponent(i, k)), sum = w.reduce((a, b) => a + b, 0) || 1;
            const r = w.map((v) => Math.round((v / sum) * 255));
            r[r.indexOf(Math.max(...r))] += 255 - r.reduce((a, b) => a + b, 0);
            q.set(r, i * 4);
          }
          out.attributes.skinWeight = { stream: stream(q, { count: n, stride: 4 }), format: "unorm8x4" };
        } else if (attributeName === "color") {
          const q = new Uint8Array(n * 4);
          for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) q[i * 4 + k] = k < attribute.itemSize ? Math.round(Math.max(0, Math.min(1, attribute.getComponent(i, k))) * 255) : 255;
          out.attributes.color = { stream: stream(q, { count: n, stride: 4 }), format: "unorm8x4" };
        } else if (attributeName === "materialIndex") {
          const q = new Uint8Array(n * 4);
          for (let i = 0; i < n; i++) q[i * 4] = attribute.getX(i);
          out.attributes.material = { stream: stream(q, { count: n, stride: 4 }), format: "uint8x4" };
        } else if (/^uv\d?$/.test(attributeName) && attribute.itemSize === 2 && [...Array(n).keys()].every((i) => { const u = attribute.getX(i), v = attribute.getY(i); return u >= 0 && u <= 1 && v >= 0 && v <= 1; })) {
          const q = new Uint16Array(n * 2);
          // 12 bits of precision (1/4096 of the texture), low bits zero.
          for (let i = 0; i < n; i++) { q[i * 2] = Math.min(65535, Math.round(attribute.getX(i) * 4095) * 16); q[i * 2 + 1] = Math.min(65535, Math.round(attribute.getY(i) * 4095) * 16); }
          out.attributes[attributeName] = { stream: stream(q, { count: n, stride: 4 }), format: "unorm16x2" };
        } else {
          // Other texture coordinates and anything else: 32-bit floats.
          const size = attribute.itemSize, f = new Float32Array(n * size);
          for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) f[i * size + k] = attribute.getComponent(i, k);
          out.attributes[attributeName] = { stream: stream(f, { count: n, stride: size * 4 }), format: size === 1 ? "float32" : `float32x${size}` };
        }
      }
      if (geometry.index) {
        const wide = count > 65535, ix = wide ? new Uint32Array(geometry.index.count) : new Uint16Array(geometry.index.count);
        for (let i = 0; i < ix.length; i++) ix[i] = geometry.index.getX(i);
        out.index = { stream: stream(ix, { count: ix.length, stride: wide ? 4 : 2, mode: "triangles" }), format: wide ? "uint32" : "uint16" };
      }
      if (geometry.groups.length) out.groups = geometry.groups.map(({ start, count, materialIndex }) => ({ start, count, material: materialIndex ?? 0 }));
      if (morphed) {
        const names = geometry.userData.targetNames ?? [];
        out.morphTargets = geometry.morphAttributes.position.map((attribute, t) => {
          const f = new Float32Array(attribute.count * 3);
          for (let i = 0; i < attribute.count; i++) for (let k = 0; k < 3; k++) f[i * 3 + k] = attribute.getComponent(i, k);
          const target = { name: attribute.name || names[t] || `target_${t}`, position: { stream: stream(f, { count: attribute.count, stride: 12 }), format: "float32x3" } };
          const normal = geometry.morphAttributes.normal?.[t];
          if (normal) {
            const g = new Float32Array(normal.count * 3);
            for (let i = 0; i < normal.count; i++) for (let k = 0; k < 3; k++) g[i * 3 + k] = normal.getComponent(i, k);
            target.normal = { stream: stream(g, { count: normal.count, stride: 12 }), format: "float32x3" };
          }
          return target;
        });
        if (geometry.morphTargetsRelative === false) out.morphAbsolute = true;
      }
      manifest.geometries.push(out);
      geometryIndex.set(key, manifest.geometries.length - 1);
      return manifest.geometries.length - 1;
    }

    async function writeTexture(texture) {
      if (textureIndex.has(texture)) return textureIndex.get(texture);
      let { mime, bytes } = texture.userData?.fun3dSource ?? {};
      if (!bytes) {
        // Encode what the browser decoded (lossy but complete): WebP from the image.
        const image = texture.image;
        if (typeof OffscreenCanvas === "undefined" || !image?.width) throw new Error(`Texture "${texture.name}" has no encoded source`);
        const canvas = new OffscreenCanvas(image.width, image.height);
        canvas.getContext("2d").drawImage(image, 0, 0);
        mime = "image/webp";
        bytes = new Uint8Array(await (await canvas.convertToBlob({ type: mime, quality: 0.92 })).arrayBuffer());
      }
      const wrap = (w) => ({ [THREE.RepeatWrapping]: "repeat", [THREE.ClampToEdgeWrapping]: "clamp", [THREE.MirroredRepeatWrapping]: "mirror" })[w];
      // Several textures (other samplers or colour spaces) may share one image.
      let image = images.find((e) => e.bytes.length === bytes.length && e.bytes.every((b, i) => b === bytes[i]));
      if (!image) images.push(image = { bytes, stream: stream(bytes, { count: bytes.length, stride: 1, store: true }) });
      manifest.textures.push({
        stream: image.stream, mime,
        colorSpace: texture.colorSpace === THREE.SRGBColorSpace ? "srgb" : "linear",
        wrap: [wrap(texture.wrapS), wrap(texture.wrapT)], ...(texture.flipY ? { flipY: true } : {}),
        ...(texture.name ? { name: texture.name } : {}),
      });
      textureIndex.set(texture, manifest.textures.length - 1);
      return manifest.textures.length - 1;
    }

    async function writeMaterial(material) {
      if (materialIndex.has(material)) return materialIndex.get(material);
      const custom = material.userData?.fun3d ?? {};
      const type = custom.type ?? (material.isMeshPhysicalMaterial && material.transmission > 0 ? "glass" : material.isMeshToonMaterial ? "toon" : material.isMeshBasicMaterial ? "unlit" : "standard");
      const out = { type, ...(material.name ? { name: material.name } : {}), color: `#${material.color.getHexString()}` };
      if ("roughness" in material) out.roughness = round(material.roughness, 4);
      if (material.metalness) out.metalness = round(material.metalness, 4);
      if (material.emissive && material.emissive.getHex() !== 0) { out.emissive = `#${material.emissive.getHexString()}`; out.emissiveIntensity = round(material.emissiveIntensity, 4); }
      if (material.transparent && material.opacity < 1) out.opacity = round(material.opacity, 4);
      if (material.alphaTest) out.alphaTest = round(material.alphaTest, 4);
      if (material.side === THREE.DoubleSide) out.side = "double";
      if (type === "glass") Object.assign(out, { transmission: round(material.transmission, 4), ior: round(material.ior, 4), thickness: round(material.thickness, 4) });
      const maps = {};
      for (const [key, slot] of [["map", "color"], ["normalMap", "normal"], ["roughnessMap", "metallicRoughness"], ["aoMap", "occlusion"], ["emissiveMap", "emissive"], ["alphaMap", "alpha"]])
        if (material[key]) maps[slot] = await writeTexture(material[key]);
      if (Object.keys(maps).length) out.maps = maps;
      Object.assign(out, Object.fromEntries(Object.entries(custom).filter(([k]) => k !== "type")));
      manifest.materials.push(out);
      materialIndex.set(material, manifest.materials.length - 1);
      return manifest.materials.length - 1;
    }

    const skinIndex = new Map();
    for (const [i, object] of objects.entries()) {
      const node = {};
      if (object.name) node.name = object.name;
      if (i > 0) node.parent = nodeIndex.get(object.parent);
      if (object.position.lengthSq() > 0) node.position = object.position.toArray().map((n) => round(n));
      if (object.quaternion.w !== 1) node.quaternion = object.quaternion.toArray().map((n) => round(n, 7));
      if (object.scale.x !== 1 || object.scale.y !== 1 || object.scale.z !== 1) node.scale = object.scale.toArray().map((n) => round(n));
      if (object.isBone) node.bone = true;
      if (!object.visible) node.hidden = true;
      if (object.userData?.fun3d?.role) node.role = object.userData.fun3d.role;
      if (object.isMesh) {
        const materials = await Promise.all([object.material].flat().map(writeMaterial));
        node.mesh = { geometry: writeGeometry(object.geometry, { skinned: !!object.isSkinnedMesh }), material: materials.length === 1 ? materials[0] : materials };
        if (object.castShadow) node.mesh.castShadow = true;
        if (object.receiveShadow) node.mesh.receiveShadow = true;
        if (object.isInstancedMesh) node.mesh.instances = { stream: stream(object.instanceMatrix.array.slice(0, object.count * 16), { count: object.count, stride: 64 }), format: "mat4" };
        if (object.isSkinnedMesh) {
          const skeleton = object.skeleton;
          if (!skinIndex.has(skeleton)) {
            const joints = skeleton.bones.map((bone) => {
              if (!nodeIndex.has(bone)) throw new Error(`Bone "${bone.name}" is outside the exported object`);
              return nodeIndex.get(bone);
            });
            const matrices = new Float32Array(joints.length * 16);
            skeleton.boneInverses.forEach((m, j) => matrices.set(m.elements, j * 16));
            manifest.skins.push({ joints, inverseBindMatrices: { stream: stream(matrices, { count: joints.length, stride: 64 }), format: "mat4" }, ...(rig ? { rig } : {}) });
            skinIndex.set(skeleton, manifest.skins.length - 1);
          }
          node.skin = skinIndex.get(skeleton);
        }
        if (object.morphTargetDictionary) node.mesh.morph = Object.keys(object.morphTargetDictionary);
      }
      manifest.nodes.push(node);
    }

    // Animation tracks address nodes by index; the loader names them as Three.js expects.
    const byName = new Map(objects.map((o, i) => [sanitize(o.name), i]).filter(([n]) => n).reverse());
    for (const clip of animations) {
      const tracks = [];
      for (const track of clip.tracks) {
        const parsed = THREE.PropertyBinding.parseTrackName(track.name);
        const node = byName.get(parsed.nodeName);
        if (node === undefined) continue;
        const path = parsed.propertyName === "morphTargetInfluences" ? `morph${parsed.propertyIndex !== undefined ? `:${parsed.propertyIndex}` : ""}` : parsed.propertyName;
        const times = track.times, size = track.getValueSize();
        const step = times.length > 1 ? times[1] - times[0] : 0;
        const uniform = times.length > 2 && times.every((t, i) => Math.abs(t - (times[0] + i * step)) < 1e-4);
        tracks.push({
          node, path, ...(track.getInterpolation() === THREE.InterpolateDiscrete ? { interpolation: "step" } : {}),
          times: uniform ? { start: round(times[0]), fps: round(1 / step, 4), count: times.length } : { stream: stream(Float32Array.from(times), { count: times.length, stride: 4 }), format: "float32" },
          // Rotations as 16-bit unit quaternions; everything else as 32-bit floats.
          values: path === "quaternion"
            ? { stream: stream(Int16Array.from(track.values, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767)), { count: times.length, stride: 8 }), format: "snorm16x4" }
            : { stream: stream(Float32Array.from(track.values), { count: times.length, stride: size * 4 }), format: size === 1 ? "float32" : `float32x${size}` },
        });
      }
      manifest.animations.push({ name: clip.name, duration: round(clip.duration), tracks });
    }

    if (physics) manifest.physics = resolvePhysics(physics, (name) => {
      const index = objects.findIndex((o) => o.name === name || sanitize(o.name) === sanitize(name));
      if (index < 0) throw new Error(`Physics refers to unknown node "${name}"`);
      return index;
    });

    for (const key of ["geometries", "materials", "textures", "skins", "animations"]) if (!manifest[key].length) delete manifest[key];
    manifest.buffers.push({ byteLength: main.length });
    if (stored.length) manifest.buffers.push({ byteLength: stored.length });
    const chunks = [
      { type: "JSON", bytes: new TextEncoder().encode(JSON.stringify(manifest)), deflate: compress },
      { type: "BIN ", bytes: main.bytes(), deflate: compress },
    ];
    if (stored.length) chunks.push({ type: "BIN ", bytes: stored.bytes(), deflate: false });
    if (edit) chunks.push({ type: "EDIT", bytes: new TextEncoder().encode(JSON.stringify(edit)), deflate: true, editing: true });
    return packChunks(chunks);
  }

  // Physics descriptors name nodes; the file stores node indices.
  function resolvePhysics(physics, nodeOf) {
    const out = structuredClone(physics);
    const fix = (value) => {
      if (Array.isArray(value)) return value.forEach(fix);
      if (!value || typeof value !== "object") return;
      for (const [key, v] of Object.entries(value)) {
        if (["node", "joint", "to"].includes(key) && typeof v === "string") value[key] = nodeOf(v);
        else fix(v);
      }
    };
    fix(out);
    return out;
  }

  // ---- reading ----

  async function read(bytes, { editing = false } = {}) {
    const chunks = await unpackChunks(bytes, { editing });
    const json = chunks.find((c) => c.type === "JSON");
    if (!json) throw new Error("A .fun3d file starts with its JSON chunk");
    const manifest = JSON.parse(new TextDecoder().decode(json.bytes));
    if (manifest.format !== "fun3d") throw new Error("Not a .fun3d manifest");
    if (manifest.version > VERSION) throw new Error(`.fun3d version ${manifest.version} needs a newer runtime (this one reads ${VERSION})`);
    const buffers = chunks.filter((c) => c.type === "BIN ").map((c) => c.bytes);
    const edit = chunks.find((c) => c.type === "EDIT");
    return { manifest, buffers, edit: edit ? JSON.parse(new TextDecoder().decode(edit.bytes)) : null };
  }

  async function load(bytes, { editing = false } = {}) {
    if (decoder) await decoder.ready;
    const { manifest, buffers, edit } = await read(bytes, { editing });
    const decoded = new Map();
    function data(index) {
      if (decoded.has(index)) return decoded.get(index);
      const s = manifest.streams[index], source = buffers[s.buffer].subarray(s.offset, s.offset + s.length);
      let out = source;
      if (s.codec === "meshopt-attributes") { out = new Uint8Array(s.count * s.stride); decoder.decodeVertexBuffer(out, s.count, s.stride, source); }
      else if (s.codec === "meshopt-triangles") { out = new Uint8Array(s.count * s.stride); decoder.decodeIndexBuffer(out, s.count, s.stride, source); }
      else if (s.offset % 4) out = source.slice();
      decoded.set(index, out);
      return out;
    }
    function typed({ stream, format }) {
      const [Type] = FORMATS[format], bytes = data(stream);
      return new Type(bytes.buffer, bytes.byteOffset, bytes.byteLength / Type.BYTES_PER_ELEMENT);
    }
    const attributeOf = (desc) => {
      const [, size, normalized] = FORMATS[desc.format];
      return new THREE.BufferAttribute(typed(desc), size, normalized);
    };

    const geometries = (manifest.geometries ?? []).map((g) => {
      const geometry = new THREE.BufferGeometry();
      for (const [name, desc] of Object.entries(g.attributes)) geometry.setAttribute(name === "material" ? "materialIndex" : name, attributeOf(desc));
      if (g.index) geometry.setIndex(new THREE.BufferAttribute(typed(g.index), 1));
      for (const group of g.groups ?? []) geometry.addGroup(group.start, group.count, group.material);
      if (g.morphTargets) {
        geometry.morphAttributes.position = g.morphTargets.map((t) => Object.assign(attributeOf(t.position), { name: t.name }));
        if (g.morphTargets.every((t) => t.normal)) geometry.morphAttributes.normal = g.morphTargets.map((t) => attributeOf(t.normal));
        geometry.morphTargetsRelative = !g.morphAbsolute;
      }
      geometry.userData.fun3d = { quantization: g.quantization, bounds: g.bounds };
      if (!g.quantization) {
        geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...g.bounds.min), new THREE.Vector3(...g.bounds.max));
        geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
      } else geometry.computeBoundingSphere();
      return geometry;
    });

    const textures = await Promise.all((manifest.textures ?? []).map(async (t) => {
      const bytes = data(t.stream);
      let texture;
      if (typeof createImageBitmap === "function" && t.mime !== "image/ktx2") {
        const bitmap = await createImageBitmap(new Blob([bytes], { type: t.mime }), { imageOrientation: t.flipY ? "flipY" : "none", colorSpaceConversion: "none", premultiplyAlpha: "none" });
        texture = new THREE.Texture(bitmap);
        texture.needsUpdate = true;
      } else {
        texture = new THREE.Texture();
        texture.userData.fun3dSource = { mime: t.mime, bytes };
      }
      texture.flipY = false;
      texture.colorSpace = t.colorSpace === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      const wrap = { repeat: THREE.RepeatWrapping, clamp: THREE.ClampToEdgeWrapping, mirror: THREE.MirroredRepeatWrapping };
      [texture.wrapS, texture.wrapT] = (t.wrap ?? ["repeat", "repeat"]).map((w) => wrap[w]);
      if (t.name) texture.name = t.name;
      if (texture.userData.fun3dSource === undefined) texture.userData.fun3dSource = { mime: t.mime, bytes };
      return texture;
    }));

    // Materials: Three.js classes for every type; types Three.js lacks (lights with roles,
    // wind) carry their parameters in userData.fun3d for the runtime's TSL materials.
    const materialCache = new Map();
    function material(index, { flat, skinned, morphed, colors }) {
      const key = `${index}:${flat}:${skinned}:${morphed}:${colors}`;
      if (materialCache.has(key)) return materialCache.get(key);
      const m = manifest.materials[index];
      const options = { name: m.name ?? "", color: new THREE.Color(m.color ?? "#ffffff") };
      let material;
      if (m.type === "glass") material = new THREE.MeshPhysicalMaterial({ ...options, roughness: m.roughness ?? 0.05, metalness: m.metalness ?? 0, transmission: m.transmission ?? 1, ior: m.ior ?? 1.5, thickness: m.thickness ?? 0 });
      else if (m.type === "unlit") material = new THREE.MeshBasicMaterial(options);
      else if (m.type === "toon") material = new THREE.MeshToonMaterial(options);
      else material = new THREE.MeshStandardMaterial({ ...options, roughness: m.roughness ?? 1, metalness: m.metalness ?? 0 });
      if (m.emissive) { material.emissive?.set(m.emissive); if ("emissiveIntensity" in material) material.emissiveIntensity = m.emissiveIntensity ?? 1; }
      if (m.opacity !== undefined && m.opacity < 1) Object.assign(material, { transparent: true, opacity: m.opacity, depthWrite: false });
      if (m.alphaTest) material.alphaTest = m.alphaTest;
      if (m.side === "double") material.side = THREE.DoubleSide;
      const maps = m.maps ?? {};
      if (maps.color !== undefined) material.map = textures[maps.color];
      if (maps.normal !== undefined) material.normalMap = textures[maps.normal];
      if (maps.metallicRoughness !== undefined) material.roughnessMap = material.metalnessMap = textures[maps.metallicRoughness];
      if (maps.occlusion !== undefined) material.aoMap = textures[maps.occlusion];
      if (maps.emissive !== undefined) material.emissiveMap = textures[maps.emissive];
      if (maps.alpha !== undefined) material.alphaMap = textures[maps.alpha];
      if (flat) material.flatShading = true;
      if (colors) material.vertexColors = true;
      const extra = Object.fromEntries(Object.entries(m).filter(([k]) => !["name", "color", "roughness", "metalness", "emissive", "emissiveIntensity", "opacity", "alphaTest", "side", "maps", "transmission", "ior", "thickness"].includes(k)));
      material.userData.fun3d = extra;
      materialCache.set(key, material);
      return material;
    }

    // Skinned and morphed meshes take float positions (skinning and morphing work in model space).
    const expand = new Set(manifest.nodes.filter((n) => n.mesh && (n.skin !== undefined || manifest.geometries[n.mesh.geometry].morphTargets)).map((n) => n.mesh.geometry));
    for (const index of expand) {
      const g = manifest.geometries[index], q = g.quantization;
      if (!q) continue;
      const geometry = geometries[index], source = geometry.getAttribute("position"), f = new Float32Array(source.count * 3);
      for (let i = 0; i < source.count; i++) for (let k = 0; k < 3; k++) f[i * 3 + k] = q.offset[k] + source.getComponent(i, k) * q.scale;
      geometry.setAttribute("position", new THREE.BufferAttribute(f, 3));
      geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...g.bounds.min), new THREE.Vector3(...g.bounds.max));
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
      g.quantization = undefined;
    }
    const objects = manifest.nodes.map((node) => {
      let object;
      if (node.bone) object = new THREE.Bone();
      else if (node.mesh) {
        const g = manifest.geometries[node.mesh.geometry], geometry = geometries[node.mesh.geometry];
        const flags = { flat: !g.attributes.normal, skinned: node.skin !== undefined, morphed: !!g.morphTargets, colors: !!g.attributes.color };
        const materials = [node.mesh.material].flat().map((i) => material(i, flags));
        const mat = Array.isArray(node.mesh.material) ? materials : materials[0];
        let mesh;
        if (node.skin !== undefined) mesh = new THREE.SkinnedMesh(geometry, mat);
        else if (node.mesh.instances) {
          const matrices = typed(node.mesh.instances);
          mesh = new THREE.InstancedMesh(geometry, mat, node.mesh.instances.count ?? matrices.length / 16);
          mesh.instanceMatrix.array.set(matrices);
        } else mesh = new THREE.Mesh(geometry, mat);
        if (node.mesh.castShadow) mesh.castShadow = true;
        if (node.mesh.receiveShadow) mesh.receiveShadow = true;
        if (g.morphTargets) {
          mesh.morphTargetDictionary = Object.fromEntries(g.morphTargets.map((t, i) => [t.name, i]));
          mesh.morphTargetInfluences = g.morphTargets.map(() => 0);
        }
        const q = g.quantization;
        if (q && mesh.isInstancedMesh) {
          // Instances dequantize through their own matrices.
          const d = new THREE.Matrix4().compose(new THREE.Vector3(...q.offset), new THREE.Quaternion(), new THREE.Vector3(q.scale, q.scale, q.scale)), m = new THREE.Matrix4();
          for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, m); mesh.setMatrixAt(i, m.multiply(d)); }
          object = mesh;
        } else if (q) {
          // The node keeps its own transform (a pivot); a child mesh dequantizes.
          object = new THREE.Object3D();
          mesh.position.fromArray(q.offset);
          mesh.scale.setScalar(q.scale);
          object.add(mesh);
          object.userData.fun3dMesh = mesh;
        } else object = mesh;
      } else object = new THREE.Object3D();
      object.name = sanitize(node.name ?? "");
      if (node.position) object.position.fromArray(node.position);
      if (node.quaternion) object.quaternion.fromArray(node.quaternion);
      if (node.scale) object.scale.fromArray(node.scale);
      if (node.hidden) object.visible = false;
      if (node.role) object.userData.fun3d = { role: node.role };
      return object;
    });
    manifest.nodes.forEach((node, i) => { if (node.parent !== undefined) objects[node.parent].add(objects[i]); });
    const scene = objects[0];
    scene.updateMatrixWorld(true);

    const skeletons = (manifest.skins ?? []).map((skin) => {
      const matrices = typed(skin.inverseBindMatrices);
      const inverses = skin.joints.map((_, j) => new THREE.Matrix4().fromArray(matrices, j * 16));
      return new THREE.Skeleton(skin.joints.map((j) => objects[j]), inverses);
    });
    manifest.nodes.forEach((node, i) => {
      if (node.skin !== undefined) objects[i].bind(skeletons[node.skin], objects[i].matrixWorld);
    });

    const InterpolantFor = { linear: THREE.InterpolateLinear, step: THREE.InterpolateDiscrete };
    const animations = (manifest.animations ?? []).map((clip) => new THREE.AnimationClip(clip.name, clip.duration, clip.tracks.map((t) => {
      const target = objects[t.node].name;
      const times = t.times.stream !== undefined ? Float32Array.from(typed(t.times)) : Float32Array.from({ length: t.times.count }, (_, i) => t.times.start + i / t.times.fps);
      const raw = typed(t.values), [, , normalized] = FORMATS[t.values.format];
      const values = normalized ? Float32Array.from(raw, (v) => Math.max(v / 32767, -1)) : Float32Array.from(raw);
      const interpolation = InterpolantFor[t.interpolation ?? "linear"];
      if (t.path === "quaternion") return new THREE.QuaternionKeyframeTrack(`${target}.quaternion`, times, values, interpolation);
      if (t.path === "position" || t.path === "scale") return new THREE.VectorKeyframeTrack(`${target}.${t.path}`, times, values, interpolation);
      if (t.path.startsWith("morph")) {
        const index = t.path.split(":")[1];
        return new THREE.NumberKeyframeTrack(`${target}.morphTargetInfluences${index !== undefined ? `[${index}]` : ""}`, times, values, interpolation);
      }
      return new THREE.NumberKeyframeTrack(`${target}.${t.path}`, times, values, interpolation);
    })));

    // Physics descriptors with node indices resolved to the loaded objects.
    let physics = null;
    if (manifest.physics) {
      physics = structuredClone(manifest.physics);
      const fix = (value) => {
        if (Array.isArray(value)) return value.forEach(fix);
        if (!value || typeof value !== "object") return;
        for (const [key, v] of Object.entries(value)) {
          if (["node", "joint", "to"].includes(key) && Number.isInteger(v)) value[key] = objects[v];
          else if (key === "points" && v?.stream !== undefined) value[key] = typed(v);
          else fix(v);
        }
      };
      fix(physics);
    }

    return { scene, animations, physics, skeletons, manifest, edit, objects };
  }

  return { write, read, load };
}
