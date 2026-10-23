// Writing .fun3d files from Three.js objects (docs/model-format.md §4): the importer, the
// workshop and tests write; games only read. Object names are node ids (mapped by the profile's
// id rule, §6, and refused when they collide); geometry, material and texture ids come from
// their names. Positions quantize to 14 bits within the bounds (floats above 20 m), normals and
// tangents to 8 bits, texture coordinates in [0, 1] to 12 bits; buffers group by element type;
// index and vertex streams use the meshopt codecs when the encoder is given. The manifest is
// validated against the schema before packing, so a bad input fails here, not in a game.

import { packChunks } from "./fun3d-container.js";
import { FORMATS, VERSION, idFromName, skeletonHash, validateManifest } from "./fun3d-schema.js";

const round = (n, digits = 6) => Number(n.toFixed(digits));
const bytesOf = (typed) => new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
const hex = (color) => `#${color.getHexString()}`;
const QUANTIZE_LIMIT = 20;
// JS enumerates integer-like object keys numerically, not in target-index order.
const morphNames = mesh => Object.entries(mesh?.morphTargetDictionary ?? {})
  .sort((a, b) => a[1] - b[1]).map(([name]) => name);

// A chunk's bytes, every stream 4-byte aligned.
class Chunk {
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

export function createWriter({ THREE, encoder = null }) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  async function write(root, { kind = "model", asset = {}, animations = [], physics = null, rig = null, edit = null, quantize = true, positionPrecision = quantize ? "quantized" : "float32", compress = true, uses = [], requires = [], extensions = null, refs = [] } = {}) {
    if (!root?.isObject3D) throw new TypeError("write needs an Object3D");
    if (!["quantized", "float32"].includes(positionPrecision)) throw new TypeError("positionPrecision must be quantized or float32");
    const floatPositions = positionPrecision === "float32";
    if (encoder) await encoder.ready;
    const bin = new Chunk(), stored = new Chunk();
    const manifest = {
      fun3d: VERSION, kind, asset: { generator: `fun.dev fun3d ${VERSION}`, ...asset }, uses: [...uses], requires,
      streams: [], nodes: [], geometries: [], materials: [], images: [], textures: [], skeletons: [], animations: [], physics: {}, variants: [],
      refs: refs.map((r) => ({ id: r.id, model: r.model })), extensions: {},
    };

    const streamBuckets = new Map();
    function stream(typed, { count, stride, mode = null, store = false }) {
      let data = bytesOf(typed), codec;
      if (!store && encoder && count > 0 && mode === "triangles" && count % 3 === 0 && (stride === 2 || stride === 4)) { data = encoder.encodeIndexBuffer(data, count, stride); codec = "meshopt"; }
      else if (!store && encoder && count > 0 && mode === "attributes" && stride % 4 === 0 && stride <= 64) { data = encoder.encodeVertexBuffer(data, count, stride); codec = "meshopt"; }
      // Animation tracks often repeat the same times and values across parts.
      // Share identical encoded streams, retaining the format's existing caps.
      // Hashing selects a bucket only; byte equality resolves every collision.
      let hash = 2166136261;
      for (const byte of data) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
      const key = `${store}:${count}:${stride}:${codec ?? "raw"}:${codec ? mode : ""}:${data.length}:${hash}`;
      const bucket = streamBuckets.get(key) ?? [];
      for (const previous of bucket) if (data.every((byte, i) => byte === previous.data[i])) return previous.id;
      const id = `s${manifest.streams.length}`, target = store ? stored : bin;
      manifest.streams.push({ id, chunk: store ? 1 : 0, offset: target.append(data), length: data.length, count, stride, ...(codec ? { codec, mode } : {}) });
      bucket.push({ id, data }); streamBuckets.set(key, bucket);
      return id;
    }

    // Ids: names through the profile rule; collisions within a table are refused for nodes and
    // suffixed for the rest.
    const idCache = new Map();
    const idOf = async (name) => { if (!idCache.has(name)) idCache.set(name, await idFromName(name)); return idCache.get(name); };
    const unique = (taken, id) => { let candidate = id, n = 2; while (taken.has(candidate)) candidate = `${id.slice(0, 64 - String(n).length - 1)}_${n++}`; taken.add(candidate); return candidate; };

    // Nodes: every object except the unnamed meshes the loader hangs under pivots.
    const objects = [];
    root.traverse((object) => { if (object.parent?.userData.mesh !== object) objects.push(object); });
    const nodeIds = new Map(), takenNodes = new Set();
    for (const object of objects) {
      if (!object.name) throw new Error(`every node needs a name (an unnamed ${object.type} under "${object.parent?.name ?? "the root"}")`);
      const id = await idOf(object.name);
      if (takenNodes.has(id)) throw new Error(`two nodes map to the id "${id}"`);
      takenNodes.add(id);
      nodeIds.set(object, id);
    }

    // ---- textures and materials ----
    const imageIds = new Map(), textureIds = new Map(), takenTextures = new Set(), takenImages = new Set();
    async function writeImage(mime, bytes) {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
      if (imageIds.has(digest)) return imageIds.get(digest);
      const id = unique(takenImages, `img_${digest.slice(0, 8)}`);
      manifest.images.push({ id, stream: stream(bytes, { count: bytes.length, stride: 1, store: true }), mime });
      imageIds.set(digest, id);
      return id;
    }
    async function sourceOf(texture) {
      const source = texture.userData?.fun3dSource ?? texture.source?.userData?.fun3dSource;
      if (source?.bytes) return source;
      const image = texture.image;
      if (typeof OffscreenCanvas === "undefined" || !image?.width) throw new Error(`texture "${texture.name}" has no encoded source`);
      const canvas = new OffscreenCanvas(image.width, image.height);
      canvas.getContext("2d").drawImage(image, 0, 0);
      return { mime: "image/webp", bytes: new Uint8Array(await (await canvas.convertToBlob({ type: "image/webp", quality: 0.92 })).arrayBuffer()) };
    }
    const wrapName = { [THREE.RepeatWrapping]: "repeat", [THREE.ClampToEdgeWrapping]: "clamp", [THREE.MirroredRepeatWrapping]: "mirror" };
    const filterName = { [THREE.NearestFilter]: "nearest", [THREE.LinearFilter]: "linear", [THREE.NearestMipmapNearestFilter]: "nearest-mipmap-nearest", [THREE.LinearMipmapNearestFilter]: "linear-mipmap-nearest", [THREE.NearestMipmapLinearFilter]: "nearest-mipmap-linear", [THREE.LinearMipmapLinearFilter]: "linear-mipmap-linear" };
    async function writeTexture(texture, colorSpace) {
      const key = texture.source ?? texture;
      const sampler = { wrap: [wrapName[texture.wrapS] ?? "repeat", wrapName[texture.wrapT] ?? "repeat"], minFilter: filterName[texture.minFilter] ?? "linear-mipmap-linear", magFilter: filterName[texture.magFilter] ?? "linear", anisotropy: Math.max(1, Math.round(texture.anisotropy || 1)) };
      const dedupe = `${key.uuid}|${colorSpace}|${JSON.stringify(sampler)}`;
      if (textureIds.has(dedupe)) return textureIds.get(dedupe);
      const { mime, bytes } = await sourceOf(texture);
      const id = unique(takenTextures, await idOf(texture.name || `tex_${manifest.textures.length}`));
      manifest.textures.push({ id, image: await writeImage(mime, bytes), colorSpace, sampler });
      textureIds.set(dedupe, id);
      return id;
    }
    async function mapOf(texture, colorSpace, extra = {}) {
      const map = { texture: await writeTexture(texture, colorSpace), ...extra };
      if (texture.channel) map.uv = texture.channel;
      if (texture.offset.x || texture.offset.y || texture.repeat.x !== 1 || texture.repeat.y !== 1 || texture.rotation) map.transform = { offset: texture.offset.toArray().map((n) => round(n)), scale: texture.repeat.toArray().map((n) => round(n)), rotation: round(texture.rotation) };
      return map;
    }
    const materialIds = new Map(), takenMaterials = new Set();
    async function writeMaterial(material) {
      if (materialIds.has(material)) return materialIds.get(material);
      const custom = material.userData?.fun3d ?? {};
      const id = unique(takenMaterials, custom.id ?? (material.name ? await idOf(material.name) : `mat_${manifest.materials.length}`));
      const model = custom.model ?? (material.isMeshBasicMaterial ? "unlit" : "pbr");
      if (model === "pbr" && material.ior !== undefined && material.ior !== 1.5 && !(material.transmission > 0))
        throw new Error("Non-default opaque IOR is not supported by .fun3d writing");
      const desc = { id, ...(material.name && material.name !== id ? { name: material.name } : {}), model, color: hex(material.color ?? new THREE.Color("#ffffff")) };
      if (material.alphaTest > 0) desc.alpha = { mode: "mask", cutoff: round(material.alphaTest, 4), opacity: round(material.opacity, 4) };
      else if (material.transparent) desc.alpha = { mode: "blend", opacity: round(material.opacity, 4) };
      if (material.side === THREE.DoubleSide) desc.side = "double";
      if (model === "pbr" && "roughness" in material) desc.pbr = { roughness: round(material.roughness, 4), metalness: round(material.metalness ?? 0, 4) };
      const maps = {};
      if (material.map) maps.color = await mapOf(material.map, "srgb");
      if (model === "pbr") {
        if (material.normalMap) maps.normal = await mapOf(material.normalMap, "linear", { scale: round(material.normalScale?.x ?? 1, 4) });
        if (material.metalnessMap || material.roughnessMap) maps.metalRough = await mapOf(material.metalnessMap ?? material.roughnessMap, "linear");
        if (material.aoMap) maps.occlusion = await mapOf(material.aoMap, "linear", { strength: round(material.aoMapIntensity ?? 1, 4) });
      }
      if (material.alphaMap) maps.alpha = await mapOf(material.alphaMap, "linear");
      if (Object.keys(maps).length) desc.maps = maps;
      const features = { ...(custom.features ?? {}) };
      if (!features.emitter && material.emissive && (material.emissive.getHex() !== 0 || material.emissiveMap)) {
        features.emitter = { role: custom.role ?? "emissive", color: hex(material.emissive), intensity: round(material.emissiveIntensity ?? 1, 4) };
      }
      if (features.emitter && material.emissiveMap && !features.emitter.map) features.emitter.map = await mapOf(material.emissiveMap, "srgb");
      if (!features.transmission && model === "pbr" && material.transmission > 0) {
        features.transmission = { amount: round(material.transmission, 4), ior: round(material.ior ?? 1.5, 4), thickness: round(material.thickness ?? 0, 4), attenuation: hex(material.attenuationColor ?? new THREE.Color("#ffffff")), attenuationDistance: Number.isFinite(material.attenuationDistance) ? round(material.attenuationDistance, 4) : 0 };
      }
      if (Object.keys(features).length) desc.features = features;
      manifest.materials.push(desc);
      materialIds.set(material, id);
      return id;
    }

    // ---- geometries ----
    const geometryIds = new Map(), takenGeometries = new Set();
    // Positions in metres whatever the attribute's storage.
    function metres(geometry) {
      const source = geometry.getAttribute("position"), d = geometry.userData.fun3d?.dequantize, out = new Float32Array(source.count * 3);
      for (let i = 0; i < source.count; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = d ? d.offset[k] + source.getComponent(i, k) * d.scale : source.getComponent(i, k);
      return out;
    }
    async function writeGeometry(geometry, nodeId, morphNames) {
      if (geometryIds.has(geometry)) return geometryIds.get(geometry);
      // Names go through the id rule; ids already given (userData, the node's id) are used as they are.
      const id = unique(takenGeometries, geometry.userData.fun3d?.id ?? (geometry.name ? await idOf(geometry.name) : nodeId));
      const positions = metres(geometry), count = positions.length / 3;
      if (!count) throw new Error(`geometry "${id}" has no vertices`);
      const box = new THREE.Box3().setFromArray(positions);
      const out = { id, vertices: count, buffers: [] };
      const groups = [];
      // Attribute values, as functions of vertex and component, grouped by element type.
      const sets = { Int16Array: [], Int8Array: [], Uint16Array: [], Uint8Array: [], skinIndex: [], Float32Array: [] };
      const size = box.getSize(new THREE.Vector3()), extent = Math.max(size.x, size.y, size.z);
      const decode = {};
      if (!floatPositions && extent <= QUANTIZE_LIMIT) {
        const center = box.getCenter(new THREE.Vector3()), half = Math.max(extent, 1e-9) / 2;
        sets.Int16Array.push({ name: "position", format: "snorm16x4", bytes: 8, get: (i, k) => (k < 3 ? clamp(Math.round(((positions[i * 3 + k] - center.getComponent(k)) / half) * 8191), -8191, 8191) * 4 : 0) });
        decode.position = { offset: center.toArray().map((v) => round(v)), scale: round((half * 32767) / 32764, 9) };
      } else sets.Float32Array.push({ name: "position", format: "float32x3", bytes: 12, get: (i, k) => positions[i * 3 + k] });
      for (const [name, attribute] of Object.entries(geometry.attributes)) {
        if (name === "position") continue;
        const n = attribute.count;
        if (n !== count) throw new Error(`geometry "${id}" attribute ${name} has ${n} values for ${count} vertices`);
        if (name === "normal") sets.Int8Array.push({ name, format: "snorm8x4", bytes: 4, get: (i, k) => (k < 3 ? Math.round(clamp(attribute.getComponent(i, k), -1, 1) * 127) : 0) });
        else if (name === "tangent") sets.Int8Array.push({ name, format: "snorm8x4", bytes: 4, get: (i, k) => Math.round(clamp(attribute.getComponent(i, k), -1, 1) * 127) });
        else if (name === "uv" || name === "uv1") {
          let unit = attribute.itemSize === 2;
          for (let i = 0; unit && i < n; i++) { const u = attribute.getX(i), v = attribute.getY(i); if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) unit = false; }
          if (unit) sets.Uint16Array.push({ name, format: "unorm16x2", bytes: 4, get: (i, k) => Math.min(65535, Math.round(attribute.getComponent(i, k) * 4095) * 16) });
          else sets.Float32Array.push({ name, format: "float32x2", bytes: 8, get: (i, k) => attribute.getComponent(i, k) });
        } else if (name === "color") sets.Uint8Array.push({ name, format: "unorm8x4", bytes: 4, get: (i, k) => (k < attribute.itemSize ? Math.round(clamp(attribute.getComponent(i, k), 0, 1) * 255) : 255) });
        else if (name === "skinIndex") sets.skinIndex.push({ name, format: "uint8x4", bytes: 4, get: (i, k) => { const j = attribute.getComponent(i, k); if (j > 255) throw new Error(`geometry "${id}" uses more than 256 bones`); return j; } });
        else if (name === "skinWeight") {
          // 8-bit weights that still sum to 255.
          const weights = new Uint8Array(n * 4);
          for (let i = 0; i < n; i++) {
            const w = [0, 1, 2, 3].map((k) => Math.max(0, attribute.getComponent(i, k))), sum = w.reduce((a, b) => a + b, 0) || 1;
            const r = w.map((v) => Math.round((v / sum) * 255));
            r[r.indexOf(Math.max(...r))] += 255 - r.reduce((a, b) => a + b, 0);
            weights.set(r, i * 4);
          }
          sets.Uint8Array.push({ name, format: "unorm8x4", bytes: 4, get: (i, k) => weights[i * 4 + k] });
        } else if (name.startsWith("_") && attribute.itemSize <= 4) sets.Float32Array.push({ name, format: attribute.itemSize === 1 ? "float32" : `float32x${attribute.itemSize}`, bytes: attribute.itemSize * 4, get: (i, k) => attribute.getComponent(i, k) });
        else if (name === "materialIndex" || name === "uv2" || name === "uv3") continue;
        else throw new Error(`geometry "${id}" has an attribute the format does not carry: ${name} (custom attributes start with _)`);
      }
      const Types = { Int16Array, Int8Array, Uint16Array, Uint8Array, skinIndex: Uint8Array, Float32Array };
      for (const [type, attributes] of Object.entries(sets)) {
        if (!attributes.length) continue;
        const Type = Types[type], stride = attributes.reduce((s, a) => s + a.bytes, 0), per = Type.BYTES_PER_ELEMENT;
        const data = new Type((count * stride) / per), entry = { stream: null, attributes: {} };
        let offset = 0;
        for (const a of attributes) {
          const components = a.bytes / per, base = offset / per;
          for (let i = 0; i < count; i++) for (let k = 0; k < components; k++) data[(i * stride) / per + base + k] = a.get(i, k);
          entry.attributes[a.name] = { format: a.format, offset };
          offset += a.bytes;
        }
        entry.stream = stream(data, { count, stride, mode: "attributes" });
        out.buffers.push(entry);
      }
      if (Object.keys(decode).length) out.decode = decode;
      // The index, with triangles reordered so every group is one contiguous run.
      const index = geometry.index ? Array.from({ length: geometry.index.count }, (_, i) => geometry.index.getX(i)) : Array.from({ length: count }, (_, i) => i);
      const sourceGroups = geometry.groups.length ? geometry.groups : [{ start: 0, count: index.length, materialIndex: 0 }];
      const ordered = [];
      let start = 0;
      for (const group of sourceGroups) {
        const n = Math.min(group.count === Infinity ? index.length - group.start : group.count, index.length - group.start);
        if (n <= 0) continue;
        if (n % 3) throw new Error(`geometry "${id}" has a group that is not whole triangles`);
        for (let i = group.start; i < group.start + n; i++) ordered.push(index[i]);
        groups.push({ start, count: n, materialIndex: group.materialIndex ?? 0, flat: !!group.flat });
        start += n;
      }
      if (!ordered.length) throw new Error(`geometry "${id}" has no triangles`);
      const wide = count > 65535, ix = wide ? Uint32Array.from(ordered) : Uint16Array.from(ordered);
      out.index = { stream: stream(ix, { count: ix.length, stride: wide ? 4 : 2, mode: "triangles" }), format: wide ? "uint32" : "uint16" };
      out.groups = groups; // material slots are filled by the node (they depend on its materials)
      if (geometry.morphAttributes.position?.length) {
        const targets = geometry.morphAttributes.position, normals = geometry.morphAttributes.normal ?? [], relative = geometry.morphTargetsRelative !== false;
        const deltas = targets.map((target) => { const d = new Float32Array(count * 3); for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) d[i * 3 + k] = target.getComponent(i, k) - (relative ? 0 : positions[i * 3 + k]); return d; });
        let max = 0;
        for (const d of deltas) for (let i = 0; i < d.length; i++) max = Math.max(max, Math.abs(d[i]));
        const scale = max || 1;
        out.morph = { decode: { scale: round(scale, 9) }, targets: [] };
        for (const [t, d] of deltas.entries()) {
          const indices = [];
          for (let i = 0; i < count; i++) if (Math.abs(d[i * 3]) + Math.abs(d[i * 3 + 1]) + Math.abs(d[i * 3 + 2]) > (floatPositions ? 0 : 1e-9)) indices.push(i);
          const components = floatPositions ? 3 : 4;
          const q = floatPositions ? new Float32Array(indices.length * 3) : new Int16Array(indices.length * 4);
          indices.forEach((v, j) => { for (let k = 0; k < 3; k++) q[j * components + k] = floatPositions ? d[v * 3 + k] : Math.round((d[v * 3 + k] / scale) * 32767); });
          const name = targets[t].name || morphNames?.[t] || `target_${t}`;
          const target = { id: unique(new Set(out.morph.targets.map((x) => x.id)), await idOf(name)),
            sparse: { indices: { stream: stream(wide ? Uint32Array.from(indices) : Uint16Array.from(indices), { count: indices.length, stride: wide ? 4 : 2 }), format: wide ? "uint32" : "uint16" } },
            position: { stream: stream(q, { count: indices.length, stride: floatPositions ? 12 : 8, mode: "attributes" }), format: floatPositions ? "float32x3" : "snorm16x4" } };
          if (normals[t]) {
            const nq = new Int8Array(indices.length * 4);
            indices.forEach((v, j) => { for (let k = 0; k < 3; k++) nq[j * 4 + k] = Math.round(clamp(normals[t].getComponent(v, k) / 2, -1, 1) * 127); });
            target.normal = { stream: stream(nq, { count: indices.length, stride: 4, mode: "attributes" }), format: "snorm8x4" };
          }
          out.morph.targets.push(target);
        }
      }
      out.bounds = { min: box.min.toArray().map((n) => round(n)), max: box.max.toArray().map((n) => round(n)) };
      manifest.geometries.push(out);
      geometryIds.set(geometry, id);
      return id;
    }

    // ---- nodes ----
    const skeletonIds = new Map(), takenSkeletons = new Set(), skins = [], pendingHashes = [];
    for (const object of objects) {
      const id = nodeIds.get(object), node = { id };
      if (object.userData.name && object.userData.name !== id) node.name = object.userData.name;
      else if (object.name !== id) node.name = object.name;
      if (object !== root) node.parent = nodeIds.get(object.parent);
      const mesh = object.isMesh ? object : object.userData.mesh?.isMesh ? object.userData.mesh : null;
      const transform = {};
      if (!(mesh?.isInstancedMesh) && !object.userData.fun3dModel?.copies) {
        if (object.position.lengthSq() > 0) transform.position = object.position.toArray().map((n) => round(n));
        if (object.quaternion.w !== 1 || object.quaternion.x || object.quaternion.y || object.quaternion.z) transform.rotation = object.quaternion.toArray().map((n) => round(n, 7));
        if (object.scale.x !== 1 || object.scale.y !== 1 || object.scale.z !== 1) {
          if (object.scale.x <= 0 || object.scale.y <= 0 || object.scale.z <= 0) throw new Error(`node "${id}" has a non-positive scale; bake mirroring into the geometry`);
          transform.scale = object.scale.toArray().map((n) => round(n));
        }
        if (Object.keys(transform).length) node.transform = transform;
      }
      if (object.visible === false) node.visible = false;
      if (object.userData.tags?.length) node.tags = [...object.userData.tags];
      if (object.userData.sockets && Object.keys(object.userData.sockets).length) node.sockets = structuredClone(object.userData.sockets);
      // A placed library model (docs/worlds.md): a reference, never the model's geometry.
      if (object.userData.fun3dModel) {
        const { ref, variants, tint } = object.userData.fun3dModel;
        if (!manifest.refs.some((r) => r.id === ref)) throw new Error(`node "${id}" places the reference "${ref}" which refs does not name`);
        node.model = { ref, ...(variants && Object.keys(variants).length ? { variants: { ...variants } } : {}), ...(tint ? { tint: tint.map((n) => round(n, 4)) } : {}) };
        // Many copies: matrices in the node's parent space (replacing its own transform), tints per copy.
        const { copies, tints } = object.userData.fun3dModel;
        if (copies) {
          if (!ArrayBuffer.isView(copies) || copies.length % 16) throw new Error(`node "${id}": copies are a Float32Array of 4×4 matrices`);
          const count = copies.length / 16;
          node.placements = { count, transforms: { stream: stream(Float32Array.from(copies), { count, stride: 64, mode: "attributes" }), format: "mat4" } };
          if (tints) {
            if (tints.length !== count) throw new Error(`node "${id}": one tint per copy`);
            const bytes = new Uint8Array(count * 4);
            for (let i = 0; i < count; i++) { for (let k = 0; k < 3; k++) bytes[i * 4 + k] = Math.round(clamp(tints[i][k], 0, 1) * 255); bytes[i * 4 + 3] = 255; }
            node.placements.tint = { stream: stream(bytes, { count, stride: 4, mode: "attributes" }), format: "unorm8x4" };
          }
        }
      }
      const nodeExtensions = { ...(object.userData.extensions ?? {}) };
      if (object.userData.params && Object.keys(object.userData.params).length) nodeExtensions["fun3d.params"] = structuredClone(object.userData.params);
      if (Object.keys(nodeExtensions).length) node.extensions = nodeExtensions;
      if (mesh && !node.model) {
        const geometryId = await writeGeometry(mesh.geometry, id, morphNames(mesh));
        const entry = manifest.geometries.find((g) => g.id === geometryId);
        const list = [mesh.material].flat();
        // Slots: the distinct materials in the order the groups first use them.
        const slots = [], slotOf = new Map();
        const groups = entry.groups.map((group) => {
          const material = list[group.materialIndex] ?? list[0];
          if (!material) throw new Error(`node "${id}" has no material for a group`);
          if (!slotOf.has(material)) { slotOf.set(material, slots.length); slots.push(material); }
          return { start: group.start, count: group.count, material: slotOf.get(material), ...(group.flat || material.flatShading ? { flat: true } : {}) };
        });
        if (entry.materials === undefined) { entry.groups = groups; entry.materials = slots.length; }
        else if (entry.materials !== slots.length) throw new Error(`geometry "${geometryId}" is shared by nodes with different material counts`);
        node.mesh = { geometry: geometryId, materials: await Promise.all(slots.map(writeMaterial)) };
        const shadow = mesh.castShadow && mesh.receiveShadow ? "both" : mesh.castShadow ? "cast" : mesh.receiveShadow ? "receive" : "none";
        if (shadow !== "both") node.mesh.shadow = shadow;
        if (mesh.morphTargetInfluences?.some((w) => w)) node.mesh.morphWeights = mesh.morphTargetInfluences.map((w) => round(clamp(w, 0, 1), 4));
        if (mesh.isInstancedMesh) {
          const count = mesh.count, transforms = new Float32Array(count * 16), m = new THREE.Matrix4();
          const d = mesh.geometry.userData.fun3d?.dequantize;
          const inverse = d ? new THREE.Matrix4().compose(new THREE.Vector3(...d.offset), new THREE.Quaternion(), new THREE.Vector3().setScalar(d.scale)).invert() : null;
          const own = mesh === object ? object.matrix : new THREE.Matrix4().multiplyMatrices(object.matrix, mesh.matrix);
          for (let i = 0; i < count; i++) {
            mesh.getMatrixAt(i, m);
            if (inverse) m.multiply(inverse);
            m.premultiply(own);
            if (m.determinant() <= 0) throw new Error(`node "${id}" copy ${i} is mirrored`);
            m.toArray(transforms, i * 16);
          }
          node.placements = { count, transforms: { stream: stream(transforms, { count, stride: 64, mode: "attributes" }), format: "mat4" } };
          if (mesh.instanceColor) {
            const tint = new Uint8Array(count * 4);
            for (let i = 0; i < count; i++) { for (let k = 0; k < 3; k++) tint[i * 4 + k] = Math.round(clamp(mesh.instanceColor.getComponent(i, k), 0, 1) * 255); tint[i * 4 + 3] = 255; }
            node.placements.tint = { stream: stream(tint, { count, stride: 4, mode: "attributes" }), format: "unorm8x4" };
          }
        }
        if (mesh.isSkinnedMesh) {
          const skeleton = mesh.skeleton;
          if (!skeletonIds.has(skeleton)) {
            const sid = unique(takenSkeletons, mesh.userData.fun3d?.skeleton ?? skeleton.userData?.id ?? "rig");
            const bones = skeleton.bones.map((bone) => { const bid = nodeIds.get(bone); if (!bid) throw new Error(`bone "${bone.name}" of node "${id}" is outside the written object`); return bid; });
            const binds = new Float32Array(bones.length * 16);
            skeleton.boneInverses.forEach((m, j) => binds.set(m.elements, j * 16));
            const entry = { id: sid, bones, inverseBinds: { stream: stream(binds, { count: bones.length, stride: 64, mode: "attributes" }), format: "mat4" } };
            const rigDesc = mesh.userData.fun3d?.rig ?? skeleton.userData?.rig ?? rig;
            if (rigDesc) entry.rig = rigDesc;
            pendingHashes.push([entry, binds]);
            manifest.skeletons.push(entry);
            skeletonIds.set(skeleton, sid);
            skins.push(mesh);
          }
          node.skin = skeletonIds.get(skeleton);
        }
      }
      if (object.isLight) {
        if (!object.isPointLight && !object.isSpotLight) throw new Error(`node "${id}": only point and spot lights are carried`);
        node.light = { type: object.isSpotLight ? "spot" : "point", color: hex(object.color), intensity: round(Math.min(1000, object.intensity), 4), range: round(object.distance ?? 0, 4) };
        if (object.isSpotLight) node.light.cone = [round(object.angle * (1 - object.penumbra), 4), round(object.angle, 4)];
        if (object.userData.light?.importance !== undefined) node.light.importance = object.userData.light.importance;
      } else if (object.userData.light) {
        // A loaded file's light node: intent kept as data (kit/fun3d.js), written back as it was.
        const l = object.userData.light;
        node.light = { type: l.type, color: l.color, intensity: l.intensity, range: l.range ?? 0, ...(l.type === "spot" ? { cone: l.cone } : {}), importance: l.importance ?? 0.5 };
      }
      manifest.nodes.push(node);
    }
    for (const g of manifest.geometries) delete g.materials;
    // An animation pack carries its skeleton without a mesh: every bone, bound at its rest pose.
    if (kind === "animations" && !manifest.skeletons.length) {
      const bones = objects.filter((o) => o.isBone);
      if (!bones.length) throw new Error("an animation pack needs bones");
      root.updateMatrixWorld(true);
      const ids = bones.map((bone) => nodeIds.get(bone)), binds = new Float32Array(bones.length * 16);
      bones.forEach((bone, j) => binds.set(new THREE.Matrix4().copy(bone.matrixWorld).invert().elements, j * 16));
      const entry = { id: "rig", bones: ids, inverseBinds: { stream: stream(binds, { count: bones.length, stride: 64, mode: "attributes" }), format: "mat4" } };
      if (rig) entry.rig = rig;
      pendingHashes.push([entry, binds]);
      manifest.skeletons.push(entry);
    }
    // Skeleton hashes come from the written rest transforms, exactly as a reader recomputes them.
    const written = new Map(manifest.nodes.map((n) => [n.id, n.transform ?? {}]));
    for (const [entry, binds] of pendingHashes) {
      entry.hash = await skeletonHash(entry.bones, entry.bones.map((id) => { const t = written.get(id); return [t.position ?? [0, 0, 0], t.rotation ?? [0, 0, 0, 1], t.scale ?? [1, 1, 1]]; }), binds);
    }

    // ---- animations ----
    const takenClips = new Set();
    const byName = new Map(objects.map((o) => [THREE.PropertyBinding.sanitizeNodeName(o.name), o]));
    for (const clip of animations) {
      const tracks = [];
      const channels = clip.tracks.flatMap(track => {
        const parsed = THREE.PropertyBinding.parseTrackName(track.name);
        if (parsed.propertyName !== "morphTargetInfluences" || parsed.propertyIndex !== undefined) return [{ track }];
        const size = track.getValueSize();
        return Array.from({ length: size }, (_, i) => ({ morphIndex: i, track: new THREE.NumberKeyframeTrack(
          `${track.name}[${i}]`, track.times,
          Float32Array.from(track.times, (_, k) => track.values[k * size + i]), track.getInterpolation()) }));
      });
      for (const { track, morphIndex } of channels) {
        const parsed = THREE.PropertyBinding.parseTrackName(track.name);
        const object = byName.get(parsed.nodeName) ?? objects.find((o) => o.uuid === parsed.nodeName);
        if (!object) throw new Error(`clip "${clip.name}" track "${track.name}" names no node`);
        const nodeId = nodeIds.get(object);
        const times = track.times, size = track.getValueSize();
        const step = times.length > 1 ? times[1] - times[0] : 0;
        const uniform = times.length > 2 && step > 0 && times.every((t, i) => Math.abs(t - (times[0] + i * step)) < 1e-4);
        let channel, values;
        if (parsed.propertyName === "quaternion") { channel = "rotation"; values = { stream: stream(Int16Array.from(track.values, (v) => Math.round(clamp(v, -1, 1) * 32767)), { count: times.length, stride: 8, mode: "attributes" }), format: "snorm16x4" }; }
        else if (parsed.propertyName === "position" || parsed.propertyName === "scale") { channel = parsed.propertyName; values = { stream: stream(Float32Array.from(track.values), { count: times.length, stride: 12, mode: "attributes" }), format: "float32x3" }; }
        else if (parsed.propertyName === "visible") { channel = "visible"; values = { stream: stream(Float32Array.from(track.values, (v) => (v ? 1 : 0)), { count: times.length, stride: 4, mode: "attributes" }), format: "float32" }; }
        else if (parsed.propertyName === "morphTargetInfluences") {
          const mesh = object.isMesh ? object : object.userData.mesh, names = morphNames(mesh);
          // Explicit tracks follow Three's name-first PropertyBinding rule.
          // Packed tracks carry their numeric component separately so a target
          // named "0" cannot reinterpret the synthesized component index.
          const name = morphIndex !== undefined ? names[morphIndex]
            : Object.hasOwn(mesh?.morphTargetDictionary ?? {}, parsed.propertyIndex) ? parsed.propertyIndex
            : Number.isInteger(Number(parsed.propertyIndex)) ? names[Number(parsed.propertyIndex)] : parsed.propertyIndex;
          if (!name) throw new Error(`clip "${clip.name}" track "${track.name}" names no morph target`);
          channel = `morph:${await idOf(name)}`;
          values = { stream: stream(Float32Array.from(track.values), { count: times.length, stride: 4, mode: "attributes" }), format: "float32" };
        } else if (parsed.propertyName === "intensity" && object.isLight) { channel = "light.intensity"; values = { stream: stream(Float32Array.from(track.values), { count: times.length, stride: 4, mode: "attributes" }), format: "float32" }; }
        else if (parsed.propertyName === "color" && object.isLight && size === 3) { channel = "light.color"; values = { stream: stream(Float32Array.from(track.values), { count: times.length, stride: 12, mode: "attributes" }), format: "float32x3" }; }
        else throw new Error(`clip "${clip.name}" track "${track.name}": the format has no channel for ${parsed.propertyName}`);
        const entry = { node: nodeId, channel, times: uniform ? { start: round(times[0]), fps: round(1 / step, 4), count: times.length } : { stream: stream(Float32Array.from(times), { count: times.length, stride: 4 }) }, values };
        if (track.getInterpolation() === THREE.InterpolateDiscrete || channel === "visible") entry.interpolation = "step";
        tracks.push(entry);
      }
      const meta = clip.userData ?? {};
      const id = unique(takenClips, await idOf(clip.name || `clip_${manifest.animations.length}`));
      const entry = { id, ...(clip.name && clip.name !== id ? { name: clip.name } : {}), duration: round(Math.max(0, clip.duration)), tracks };
      if (meta.loop && meta.loop !== "repeat") entry.loop = meta.loop;
      if (meta.blend && meta.blend !== "normal") entry.blend = meta.blend;
      if (meta.mask) entry.mask = [...meta.mask];
      if (meta.root) entry.root = { ...meta.root };
      if (meta.events?.length) entry.events = structuredClone(meta.events);
      manifest.animations.push(entry);
    }

    // ---- physics ----
    if (physics) {
      const out = structuredClone({ ...physics, shapes: undefined });
      delete out.shapes;
      out.shapes = (physics.shapes ?? []).map((s) => {
        if (s.type !== "convex") return structuredClone(s);
        const points = Float32Array.from(s.points?.stream ? [] : s.points ?? []);
        if (s.points?.stream) throw new Error(`shape "${s.id}": give convex points as an array`);
        const { points: _, ...rest } = s;
        return { ...rest, points: { stream: stream(points, { count: points.length / 3, stride: 12, mode: "attributes" }), format: "float32x3" } };
      });
      manifest.physics = out;
    }

    // ---- extensions ----
    // Values of the form { stream: TypedArray, format } become streams (a path table's points).
    const withStreams = (value, path) => {
      if (Array.isArray(value)) return value.map((v, i) => withStreams(v, `${path}[${i}]`));
      if (value && typeof value === "object") {
        if (ArrayBuffer.isView(value.stream) && typeof value.format === "string") {
          const format = FORMATS[value.format];
          if (!format) throw new Error(`${path}: unknown stream format ${value.format}`);
          const [Type, components, , stride] = format;
          if (!(value.stream instanceof Type)) throw new Error(`${path}: a ${value.format} stream is a ${Type.name}`);
          const count = value.stream.length / components;
          if (!Number.isInteger(count)) throw new Error(`${path}: the stream's length is not a multiple of ${components}`);
          return { stream: stream(value.stream, { count, stride, mode: stride % 4 === 0 && stride <= 64 && count > 0 ? "attributes" : null }), format: value.format };
        }
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withStreams(v, `${path}.${k}`)]));
      }
      return value;
    };
    manifest.extensions = withStreams(extensions ?? {}, "extensions");
    const used = new Set(manifest.uses);
    for (const name of Object.keys(manifest.extensions)) used.add(name);
    for (const n of manifest.nodes) for (const name of Object.keys(n.extensions ?? {})) used.add(name);
    manifest.uses = [...used];

    const chunks = [bin.length, stored.length].filter((n, i) => i === 0 || n).length;
    const problems = validateManifest(manifest, { chunks });
    if (problems.length) throw new Error(`the written manifest is invalid: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? ` (+${problems.length - 3})` : ""}`);
    const parts = [
      { type: "JSON", bytes: new TextEncoder().encode(JSON.stringify(manifest)), deflate: compress },
      { type: "BIN ", bytes: bin.bytes(), deflate: compress },
    ];
    if (stored.length) parts.push({ type: "BIN ", bytes: stored.bytes(), deflate: false });
    if (edit) parts.push({ type: "EDIT", bytes: new TextEncoder().encode(JSON.stringify(edit)), deflate: true, editing: true });
    return packChunks(parts);
  }

  return { write };
}
