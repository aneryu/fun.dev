// .fun3d, fun.dev's model format (docs/model-format.md): files in, Three.js objects out, and back.
// The module takes its dependencies so the same code runs in browsers, workers and Node:
//
//   const fun3d = createFun3d({ THREE, decoder: MeshoptDecoder, materials });   // materials: kit/materials.js builder (optional)
//   const model = await fun3d.load(bytes);          // { root, nodes, geometries, animations, manifest, warnings, dispose }
//   scene.add(model.root);
//   const problems = await fun3d.validate(bytes);   // [] when the file is valid
//   const bytes = await fun3d.write(root, { animations, physics, asset });   // from Three.js objects (needs the encoder)
//
// Release 1 (§10) loads meshes, placements, skins, morph targets and node-channel clips and
// keeps the rest of the manifest for later releases, warning about what it ignores; files with
// references are refused.

import { ContainerError, packChunks, parseJSON, scanChunks, stripEditing, unpackChunks } from "./fun3d-container.js";
import { CAPS, FORMATS, VERSION, skeletonHash, validateManifest } from "./fun3d-schema.js";
import { createWriter } from "./fun3d-write.js";
import { textureFromImage } from "./assets.js";

export { CAPS, VERSION, packChunks, stripEditing, unpackChunks };

const FILTERS = { octahedral: "OCTAHEDRAL", quaternion: "QUATERNION" };
const WRAP = { repeat: "RepeatWrapping", clamp: "ClampToEdgeWrapping", mirror: "MirroredRepeatWrapping" };
const FILTER = { nearest: "NearestFilter", linear: "LinearFilter", "nearest-mipmap-nearest": "NearestMipmapNearestFilter", "linear-mipmap-nearest": "LinearMipmapNearestFilter", "nearest-mipmap-linear": "NearestMipmapLinearFilter", "linear-mipmap-linear": "LinearMipmapLinearFilter" };
const IGNORED = { lod: "lod groups", variants: "variants" };

/** Width and height from an encoded image's header, or null when the header is not one we read. */
export function imageSize(bytes, mime) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (mime === "image/png" && bytes.length >= 24 && ascii(1, 3) === "PNG") return [view.getUint32(16), view.getUint32(20)];
  if (mime === "image/jpeg" && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue; }
      const length = view.getUint16(offset + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) return [view.getUint16(offset + 7), view.getUint16(offset + 5)];
      offset += 2 + length;
    }
    return null;
  }
  if (mime === "image/webp" && bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
    if (chunk === "VP8L") { const b = view.getUint32(21, true); return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1]; }
    if (chunk === "VP8X") return [(view.getUint32(24, true) & 0xffffff) + 1, (view.getUint32(27, true) & 0xffffff) + 1];
    return null;
  }
  if (mime === "image/ktx2" && bytes.length >= 28 && bytes[0] === 0xab && ascii(1, 6) === "KTX 20") return [view.getUint32(20, true), view.getUint32(24, true)];
  return null;
}

export function createFun3d({ THREE, decoder = null, encoder = null, materials = null, ktx2 = null, decodeImage = null } = {}) {
  // Encoded images become textures through the host's decoder (docs/hosts.md); without one,
  // browsers use createImageBitmap and other hosts get a texture that remembers its source.
  decodeImage ??= typeof createImageBitmap === "function"
    ? (bytes, { mime, ...options }) => createImageBitmap(new Blob([bytes], { type: mime }), options)
    : null;
  if (!THREE) throw new TypeError("createFun3d needs THREE");
  const writer = createWriter({ THREE, encoder });

  // ---- reading ----

  /** The manifest and BIN chunks of a file, validated against the schema; `problems` is non-empty for invalid files. */
  async function read(bytes, { editing = false } = {}) {
    const chunks = await unpackChunks(bytes, { editing, maxRaw: CAPS.fileRaw, maxChunks: CAPS.chunks, maxJSON: CAPS.json });
    const manifest = parseJSON(new TextDecoder().decode(chunks[0].bytes));
    const bins = chunks.filter((c) => c.type === "BIN ").map((c) => (c.bytes.byteOffset % 4 ? c.bytes.slice() : c.bytes));
    const problems = validateManifest(manifest, { chunks: bins.length });
    for (const s of manifest.streams ?? []) {
      if (typeof s.chunk === "number" && bins[s.chunk] && s.offset + s.length > bins[s.chunk].length) problems.push(`stream "${s.id}" runs past its chunk`);
    }
    let edit = null;
    const section = chunks.find((c) => c.type === "EDIT");
    if (section) {
      if (section.bytes.length > CAPS.editing) problems.push("the editing section is larger than the cap");
      else edit = parseJSON(new TextDecoder().decode(section.bytes));
    }
    return { manifest, bins, edit, problems };
  }

  // Streams decode on first use; the sum of their decoded sizes was checked by the schema.
  function openStreams(manifest, bins) {
    const byId = new Map((manifest.streams ?? []).map((s) => [s.id, s])), cache = new Map();
    const bytes = (id) => {
      if (cache.has(id)) return cache.get(id);
      const s = byId.get(id);
      if (!s) throw new Error(`unknown stream "${id}"`);
      const source = bins[s.chunk].subarray(s.offset, s.offset + s.length);
      let out = source;
      if (s.codec === "meshopt") {
        if (!decoder) throw new Error("this file needs the meshopt decoder");
        out = new Uint8Array(s.count * s.stride);
        if (s.mode === "triangles") decoder.decodeIndexBuffer(out, s.count, s.stride, source);
        else decoder.decodeVertexBuffer(out, s.count, s.stride, source, s.filter ? FILTERS[s.filter] : undefined);
      }
      cache.set(id, out);
      return out;
    };
    return {
      desc: (id) => byId.get(id),
      bytes,
      typed(id, Type) { const b = bytes(id); return new Type(b.buffer, b.byteOffset, b.byteLength / Type.BYTES_PER_ELEMENT); },
      of(ref) { return this.typed(ref.stream, FORMATS[ref.format][0]); },
    };
  }

  /** Every problem with a file: the schema, then the data every stream decodes to. */
  async function validate(bytes) {
    let read_;
    try { read_ = await read(bytes, { editing: true }); }
    catch (error) { return [error instanceof ContainerError || error instanceof SyntaxError ? error.message : `cannot read: ${error.message}`]; }
    const { manifest, bins, problems } = read_;
    if (problems.length) return problems;
    if (decoder) await decoder.ready;
    const out = [], streams = openStreams(manifest, bins);
    const finite = (array, what) => { for (let i = 0; i < array.length; i++) if (!Number.isFinite(array[i])) { out.push(`${what} has a non-finite value at ${i}`); return false; } return true; };
    try {
      const geometries = new Map((manifest.geometries ?? []).map((g) => [g.id, g]));
      for (const g of geometries.values()) {
        const index = streams.of(g.index);
        for (let i = 0; i < index.length; i++) if (index[i] >= g.vertices) { out.push(`geometry "${g.id}" index ${i} is out of range`); break; }
        for (const lod of g.lods ?? []) { const li = streams.of(lod.index); for (let i = 0; i < li.length; i++) if (li[i] >= g.vertices) { out.push(`geometry "${g.id}" lod index is out of range`); break; } }
        for (const buffer of g.buffers) {
          for (const [name, a] of Object.entries(buffer.attributes)) {
            if (FORMATS[a.format][0] === Float32Array) finite(streams.typed(buffer.stream, Float32Array), `geometry "${g.id}" ${name}`);
            if (name === "skinWeight") {
              const s = streams.desc(buffer.stream), data = streams.typed(buffer.stream, Uint8Array);
              for (let v = 0; v < g.vertices; v++) { const o = v * s.stride + a.offset; if (data[o] + data[o + 1] + data[o + 2] + data[o + 3] !== 255) { out.push(`geometry "${g.id}" skin weights do not sum to 255 at vertex ${v}`); break; } }
            }
          }
        }
        for (const target of g.morph?.targets ?? []) { const si = streams.of(target.sparse.indices); for (let i = 0; i < si.length; i++) if (si[i] >= g.vertices) { out.push(`geometry "${g.id}" morph ${target.id} index is out of range`); break; } }
      }
      const bones = new Map((manifest.skeletons ?? []).map((s) => [s.id, s.bones.length]));
      for (const n of manifest.nodes ?? []) {
        if (n.placements) {
          const m = streams.of(n.placements.transforms);
          if (finite(m, `node "${n.id}" placements`)) {
            const matrix = new THREE.Matrix4();
            for (let i = 0; i < n.placements.count; i++) { matrix.fromArray(m, i * 16); if (matrix.determinant() <= 0) { out.push(`node "${n.id}" placement ${i} is mirrored or degenerate`); break; } }
          }
        }
        if (n.skin && n.mesh) {
          const g = geometries.get(n.mesh.geometry), count = bones.get(n.skin);
          for (const buffer of g?.buffers ?? []) if (buffer.attributes.skinIndex) { const data = streams.typed(buffer.stream, Uint8Array); for (let i = 0; i < data.length; i++) if (data[i] >= count) { out.push(`node "${n.id}" skin index ${data[i]} exceeds the skeleton`); break; } }
        }
      }
      for (const s of manifest.skeletons ?? []) {
        finite(streams.of(s.inverseBinds), `skeleton "${s.id}" inverse binds`);
        if (s.hash) { const hash = await hashSkeleton(s, streams, manifest); if (hash !== s.hash) out.push(`skeleton "${s.id}" hash does not recompute`); }
      }
      for (const a of manifest.animations ?? []) for (const [k, t] of a.tracks.entries()) {
        if (t.times.stream !== undefined) {
          const times = streams.typed(t.times.stream, Float32Array);
          if (finite(times, `animation "${a.id}" track ${k} times`)) {
            for (let i = 0; i < times.length; i++) if (times[i] > a.duration + 1e-6 || (i && times[i] < times[i - 1])) { out.push(`animation "${a.id}" track ${k} times are not ascending within the duration`); break; }
          }
        }
        const values = streams.of(t.values);
        if (values instanceof Float32Array) finite(values, `animation "${a.id}" track ${k} values`);
        else for (let i = 0; i < values.length; i += 4) { const l = Math.hypot(values[i], values[i + 1], values[i + 2], values[i + 3]) / 32767; if (Math.abs(l - 1) > 0.01) { out.push(`animation "${a.id}" track ${k} has a non-unit quaternion`); break; } }
      }
      let texels = 0;
      for (const i of manifest.images ?? []) {
        if (i.ref) continue;
        const size = imageSize(streams.bytes(i.stream), i.mime);
        if (!size) { out.push(`image "${i.id}" is not a readable ${i.mime}`); continue; }
        if (size[0] * size[1] > CAPS.texelsPerImage) out.push(`image "${i.id}" has more than ${CAPS.texelsPerImage} texels`);
        texels += size[0] * size[1];
      }
      if (texels > CAPS.texels) out.push(`images have more than ${CAPS.texels} texels in all`);
      for (const s of manifest.physics?.shapes ?? []) {
        if (s.type !== "convex") continue;
        const p = streams.of(s.points);
        if (!finite(p, `shape "${s.id}" points`)) continue;
        if (!spans3D(p)) out.push(`shape "${s.id}" points are coplanar`);
      }
    } catch (error) { out.push(`data: ${error.message}`); }
    return out;
  }

  // Four points not on one plane: the volume of some tetrahedron is above a tolerance.
  function spans3D(p) {
    const n = p.length / 3;
    if (n < 4) return false;
    const a = new THREE.Vector3(p[0], p[1], p[2]), ab = new THREE.Vector3(), ac = new THREE.Vector3(), ad = new THREE.Vector3(), cross = new THREE.Vector3();
    let b = -1;
    for (let i = 1; i < n; i++) { ab.set(p[i * 3] - a.x, p[i * 3 + 1] - a.y, p[i * 3 + 2] - a.z); if (ab.lengthSq() > 1e-12) { b = i; break; } }
    if (b < 0) return false;
    let c = -1;
    for (let i = b + 1; i < n; i++) { ac.set(p[i * 3] - a.x, p[i * 3 + 1] - a.y, p[i * 3 + 2] - a.z); cross.crossVectors(ab, ac); if (cross.lengthSq() > 1e-12) { c = i; break; } }
    if (c < 0) return false;
    for (let i = 1; i < n; i++) { ad.set(p[i * 3] - a.x, p[i * 3 + 1] - a.y, p[i * 3 + 2] - a.z); if (Math.abs(cross.dot(ad)) > 1e-9) return true; }
    return false;
  }

  // The skeleton's identity for references, from the bone ids, rest transforms and inverse binds.
  function hashSkeleton(skeleton, streams, manifest) {
    const nodes = new Map((manifest.nodes ?? []).map((n) => [n.id, n]));
    const transforms = skeleton.bones.map((id) => { const t = nodes.get(id)?.transform ?? {}; return [t.position ?? [0, 0, 0], t.rotation ?? [0, 0, 0, 1], t.scale ?? [1, 1, 1]]; });
    return skeletonHash(skeleton.bones, transforms, streams.of(skeleton.inverseBinds));
  }

  // ---- loading ----

  const normalizeMaterial = (m) => ({
    id: m.id, name: m.name ?? m.id, model: m.model ?? "pbr", color: m.color ?? "#ffffff",
    alpha: { mode: "opaque", cutoff: 0.5, opacity: 1, ...m.alpha }, side: m.side ?? "front",
    pbr: { roughness: 1, metalness: 0, ...m.pbr }, maps: m.maps ?? {}, features: m.features ?? {},
  });

  // Three.js's own material classes, for Node, the parity viewer and games without the TSL
  // builder: roles and tints do not apply here.
  function classicMaterial(desc, { flat, vertexColors, texture, warn }) {
    const options = { name: desc.name, color: new THREE.Color(desc.color), side: desc.side === "double" ? THREE.DoubleSide : THREE.FrontSide, vertexColors };
    const material = desc.model === "unlit" ? new THREE.MeshBasicMaterial(options) : new THREE.MeshStandardMaterial({ ...options, roughness: desc.pbr.roughness, metalness: desc.pbr.metalness, flatShading: flat });
    const maps = desc.maps;
    if (maps.color) material.map = texture(maps.color, "srgb");
    if (desc.model === "pbr") {
      if (maps.normal) { material.normalMap = texture(maps.normal); material.normalScale.setScalar(maps.normal.scale ?? 1); }
      if (maps.metalRough) material.metalnessMap = material.roughnessMap = texture(maps.metalRough);
      if (maps.occlusion) material.aoMap = texture(maps.occlusion);
    }
    if (maps.alpha) material.alphaMap = texture(maps.alpha);
    const emitter = desc.features.emitter;
    if (emitter && material.emissive) {
      material.emissive.set(emitter.color ?? "#ffffff");
      material.emissiveIntensity = emitter.intensity ?? 1;
      if (emitter.map) material.emissiveMap = texture(emitter.map, "srgb");
    }
    for (const name of Object.keys(desc.features)) if (!["emitter", "tint"].includes(name)) warn(`material "${desc.id}": feature ${name} is not in this release; rendered without it`);
    if (desc.alpha.mode === "mask") material.alphaTest = desc.alpha.cutoff;
    if (desc.alpha.mode === "blend") { material.transparent = true; material.opacity = desc.alpha.opacity; material.depthWrite = false; }
    material.userData.fun3d = { id: desc.id, flat };
    return material;
  }

  async function decodeTexture(image, desc, warn) {
    if (image.mime === "image/ktx2") {
      if (!ktx2) { warn(`texture "${desc.id}": KTX2 needs the KTX2 loader; a white texture stands in`); return new THREE.Texture(); }
      const buffer = image.bytes.buffer.slice(image.bytes.byteOffset, image.bytes.byteOffset + image.bytes.byteLength);
      return new Promise((resolve, reject) => ktx2.parse(buffer, resolve, reject));
    }
    if (!decodeImage) { const t = new THREE.Texture(); t.userData.fun3dSource = { mime: image.mime, bytes: image.bytes }; return t; }
    const decoded = await decodeImage(image.bytes, { mime: image.mime, imageOrientation: "none", colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const texture = textureFromImage(THREE, decoded);
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * Three.js objects for a file. Every node is an Object3D named by its id (`nodes`); rigid
   * meshes are unnamed children carrying the dequantizing transform; skinned meshes are the
   * nodes themselves. `materials` builds from kit/materials.js when given to createFun3d.
   */
  async function load(bytes, { warn = (message) => console.warn(`fun3d: ${message}`), keepSources = false, materials: builder = materials } = {}) {
    if (decoder) await decoder.ready;
    const { manifest, bins, problems } = await read(bytes);
    if (problems.length) throw new Error(`invalid .fun3d: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}`);
    if (manifest.refs?.length) throw new Error("files with references are not in this release");
    for (const name of manifest.requires ?? []) throw new Error(`this file requires the extension ${name}, which this runtime does not have`);
    const streams = openStreams(manifest, bins), warnings = [];
    const note = (message) => { warnings.push(message); warn(message); };
    const disposables = [];

    // Images and textures.
    const images = new Map();
    for (const i of manifest.images ?? []) images.set(i.id, { id: i.id, mime: i.mime, bytes: streams.bytes(i.stream) });
    const textures = new Map();
    for (const t of manifest.textures ?? []) {
      const image = images.get(t.image), texture = await decodeTexture(image, t, note);
      texture.name = t.id;
      texture.flipY = false;
      texture.colorSpace = t.colorSpace === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      const sampler = t.sampler ?? {};
      [texture.wrapS, texture.wrapT] = (sampler.wrap ?? ["repeat", "repeat"]).map((w) => THREE[WRAP[w]]);
      texture.minFilter = THREE[FILTER[sampler.minFilter ?? "linear-mipmap-linear"]];
      texture.magFilter = THREE[FILTER[sampler.magFilter ?? "linear"]];
      texture.generateMipmaps = (sampler.minFilter ?? "linear-mipmap-linear").includes("mipmap");
      texture.anisotropy = sampler.anisotropy ?? 1;
      if (keepSources) texture.userData.fun3dSource = { mime: image.mime, bytes: image.bytes };
      textures.set(t.id, texture);
      disposables.push(texture);
    }
    // A map's uv set and transform live on the texture in Three.js, so a texture used with
    // several settings is cloned (clones share the image).
    const variants = new Map();
    const textureFor = (map, colorSpace = null) => {
      const base = textures.get(map.texture);
      const key = `${map.texture}|${map.uv ?? 0}|${JSON.stringify(map.transform ?? null)}|${colorSpace}`;
      if (variants.has(key)) return variants.get(key);
      let texture = base;
      if (map.uv || map.transform) {
        texture = base.clone();
        texture.channel = map.uv ?? 0;
        if (map.transform) { texture.offset.fromArray(map.transform.offset ?? [0, 0]); texture.repeat.fromArray(map.transform.scale ?? [1, 1]); texture.rotation = map.transform.rotation ?? 0; }
        disposables.push(texture);
      }
      variants.set(key, texture);
      return texture;
    };

    // Materials: one descriptor per id, Three.js materials per (id, flat, vertex colours) on demand.
    const materialDescs = new Map((manifest.materials ?? []).map((m) => [m.id, normalizeMaterial(m)]));
    const materialObjects = new Map();
    const materialFor = (id, { flat, vertexColors }) => {
      const key = `${id}|${flat}|${vertexColors}`;
      if (materialObjects.has(key)) return materialObjects.get(key);
      const desc = materialDescs.get(id);
      const material = builder ? builder.build(desc, { flat, vertexColors, texture: textureFor, warn: note }) : classicMaterial(desc, { flat, vertexColors, texture: textureFor, warn: note });
      materialObjects.set(key, material);
      disposables.push(material);
      return material;
    };

    // Geometries.
    const skinnedGeometries = new Set((manifest.nodes ?? []).filter((n) => n.skin && n.mesh).map((n) => n.mesh.geometry));
    const geometries = new Map();
    for (const g of manifest.geometries ?? []) {
      const geometry = new THREE.BufferGeometry();
      geometry.name = g.id;
      let hasColor = false;
      for (const buffer of g.buffers) {
        const s = streams.desc(buffer.stream), entries = Object.entries(buffer.attributes);
        const [Type] = FORMATS[entries[0][1].format], typed = streams.typed(buffer.stream, Type);
        const single = entries.length === 1 && entries[0][1].offset === 0 && FORMATS[entries[0][1].format][3] === s.stride;
        const interleaved = single ? null : new THREE.InterleavedBuffer(typed, s.stride / Type.BYTES_PER_ELEMENT);
        for (const [name, a] of entries) {
          const [, size, normalized] = FORMATS[a.format];
          const attribute = single ? new THREE.BufferAttribute(typed, size, normalized) : new THREE.InterleavedBufferAttribute(interleaved, size, a.offset / Type.BYTES_PER_ELEMENT, normalized);
          if (name === "skinIndex") attribute.gpuType = THREE.IntType;
          if (name === "color") hasColor = true;
          geometry.setAttribute(name, attribute);
        }
      }
      const index = streams.of(g.index);
      geometry.setIndex(new THREE.BufferAttribute(index, 1));
      g.groups.forEach((group, i) => geometry.addGroup(group.start, group.count, i));
      // Quantized positions stay on the GPU under a dequantizing transform, except for skinned
      // and morphed meshes, which deform in metres.
      const decode = g.decode?.position ?? null, expand = decode && (skinnedGeometries.has(g.id) || g.morph);
      let dequantize = decode && !expand ? { offset: decode.offset, scale: decode.scale } : null;
      let positions = null;
      const positionsOf = () => {
        if (positions) return positions;
        const source = geometry.getAttribute("position"), out = new Float32Array(g.vertices * 3);
        for (let i = 0; i < g.vertices; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = decode ? decode.offset[k] + source.getComponent(i, k) * decode.scale : source.getComponent(i, k);
        return (positions = out);
      };
      if (expand) {
        geometry.setAttribute("position", new THREE.BufferAttribute(positionsOf(), 3));
        dequantize = null;
      }
      if (g.morph) {
        const scale = g.morph.decode?.scale ?? 1;
        // Sparse deltas become dense arrays: position = stored × scale / 32767 (or floats),
        // normal deltas = stored × 2 / 127.
        const dense = (target, ref, components, factor) => {
          const indices = streams.of(target.sparse.indices), values = streams.of(ref), out = new Float32Array(g.vertices * 3);
          for (let i = 0; i < indices.length; i++) for (let k = 0; k < 3; k++) out[indices[i] * 3 + k] = values[i * components + k] * factor;
          return out;
        };
        geometry.morphAttributes.position = g.morph.targets.map((t) => Object.assign(new THREE.BufferAttribute(dense(t, t.position, t.position.format === "snorm16x4" ? 4 : 3, t.position.format === "snorm16x4" ? scale / 32767 : 1), 3), { name: t.id }));
        if (g.morph.targets.every((t) => t.normal)) geometry.morphAttributes.normal = g.morph.targets.map((t) => new THREE.BufferAttribute(dense(t, t.normal, 4, 2 / 127), 3));
        geometry.morphTargetsRelative = true;
      }
      const box = new THREE.Box3(new THREE.Vector3(...g.bounds.min), new THREE.Vector3(...g.bounds.max));
      if (dequantize) { box.min.sub(new THREE.Vector3(...dequantize.offset)).divideScalar(dequantize.scale); box.max.sub(new THREE.Vector3(...dequantize.offset)).divideScalar(dequantize.scale); }
      const setBounds = (target) => { target.boundingBox = box.clone(); target.boundingSphere = box.getBoundingSphere(new THREE.Sphere()); };
      setBounds(geometry);
      const lods = (g.lods ?? []).map((lod) => {
        const level = new THREE.BufferGeometry();
        level.name = `${g.id}#${lod.error}`;
        for (const [name, attribute] of Object.entries(geometry.attributes)) level.setAttribute(name, attribute);
        level.setIndex(new THREE.BufferAttribute(streams.of(lod.index), 1));
        lod.groups.forEach((group, i) => level.addGroup(group.start, group.count, i));
        setBounds(level);
        return { error: lod.error, geometry: level, groups: lod.groups };
      });
      geometry.userData.fun3d = { id: g.id, groups: g.groups, dequantize };
      const slots = 1 + Math.max(...g.groups.map((group) => group.material));
      geometries.set(g.id, { id: g.id, desc: g, geometry, lods, groups: g.groups, index, slots, hasColor, dequantize, positions: positionsOf, dispose() { geometry.dispose(); for (const l of lods) l.geometry.dispose(); } });
    }

    // Nodes.
    const boneIds = new Set((manifest.skeletons ?? []).flatMap((s) => s.bones));
    const nodes = new Map(), placements = new Map(), lights = [];
    const ignored = new Set();
    for (const n of manifest.nodes) {
      let object;
      const mesh = n.mesh ? geometries.get(n.mesh.geometry) : null;
      const materialsOf = (groups) => {
        const list = groups.map((group) => materialFor(n.mesh.materials[group.material], { flat: !!group.flat, vertexColors: mesh.hasColor }));
        return list.length === 1 ? list[0] : list;
      };
      if (n.mesh && n.skin) {
        object = new THREE.SkinnedMesh(mesh.geometry, materialsOf(mesh.groups));
      } else if (n.mesh && n.placements) {
        object = new THREE.Object3D();
        const transforms = streams.of(n.placements.transforms), count = n.placements.count;
        const instanced = new THREE.InstancedMesh(mesh.geometry, materialsOf(mesh.groups), count);
        const m = new THREE.Matrix4(), d = mesh.dequantize ? new THREE.Matrix4().compose(new THREE.Vector3(...mesh.dequantize.offset), new THREE.Quaternion(), new THREE.Vector3().setScalar(mesh.dequantize.scale)) : null;
        for (let i = 0; i < count; i++) { m.fromArray(transforms, i * 16); if (d) m.multiply(d); instanced.setMatrixAt(i, m); }
        let tint = null;
        if (n.placements.tint) {
          tint = streams.of(n.placements.tint);
          const color = new THREE.Color();
          for (let i = 0; i < count; i++) instanced.setColorAt(i, color.setRGB(tint[i * 4] / 255, tint[i * 4 + 1] / 255, tint[i * 4 + 2] / 255));
        }
        placements.set(n.id, { count, transforms, tint });
        object.userData.placements = placements.get(n.id);
        object.add(instanced);
        object.userData.mesh = instanced;
      } else if (n.mesh) {
        object = boneIds.has(n.id) ? new THREE.Bone() : new THREE.Object3D();
        const child = new THREE.Mesh(mesh.geometry, materialsOf(mesh.groups));
        if (mesh.dequantize) { child.position.fromArray(mesh.dequantize.offset); child.scale.setScalar(mesh.dequantize.scale); }
        object.add(child);
        object.userData.mesh = child;
      } else object = boneIds.has(n.id) ? new THREE.Bone() : new THREE.Object3D();
      if (n.mesh) {
        const target = object.userData.mesh ?? object, shadow = n.mesh.shadow ?? "both";
        target.castShadow = shadow === "both" || shadow === "cast";
        target.receiveShadow = shadow === "both" || shadow === "receive";
        if (mesh.desc.morph) { target.morphTargetDictionary = Object.fromEntries(mesh.desc.morph.targets.map((t, i) => [t.id, i])); target.morphTargetInfluences = n.mesh.morphWeights ? [...n.mesh.morphWeights] : mesh.desc.morph.targets.map(() => 0); }
        target.userData.fun3d = { node: n.id, geometry: n.mesh.geometry, lods: mesh.lods };
      }
      object.name = n.id;
      object.userData.name = n.name ?? n.id;
      if (n.transform && !n.placements) {
        if (n.transform.position) object.position.fromArray(n.transform.position);
        if (n.transform.rotation) object.quaternion.fromArray(n.transform.rotation);
        if (n.transform.scale) object.scale.fromArray(n.transform.scale);
      }
      if (n.visible === false) object.visible = false;
      if (n.tags) object.userData.tags = [...n.tags];
      if (n.sockets) object.userData.sockets = structuredClone(n.sockets);
      // A light is intent: kit/lights.js lends real lights to the best candidates (§4.1).
      if (n.light) { object.userData.light = { type: n.light.type, color: n.light.color ?? "#ffffff", intensity: n.light.intensity, range: n.light.range ?? 0, cone: n.light.cone ?? [0.5, 0.6], importance: n.light.importance ?? 0.5 }; lights.push({ node: n.id, ...object.userData.light }); }
      for (const key of Object.keys(IGNORED)) if (n[key] !== undefined) ignored.add(IGNORED[key]);
      nodes.set(n.id, object);
      if (n.parent !== undefined) nodes.get(n.parent).add(object);
    }
    if (manifest.variants?.length) ignored.add("variants");
    for (const what of ignored) note(`${what} are not in this release; ignored`);
    const root = nodes.get(manifest.nodes[0].id);
    root.updateMatrixWorld(true);

    // Skeletons and skins: bound with the identity in attached mode, as GLTFLoader does.
    const skeletons = new Map();
    for (const s of manifest.skeletons ?? []) {
      const binds = streams.of(s.inverseBinds);
      const skeleton = new THREE.Skeleton(s.bones.map((id) => nodes.get(id)), s.bones.map((_, j) => new THREE.Matrix4().fromArray(binds, j * 16)));
      skeleton.userData = { id: s.id, rig: s.rig ?? null, hash: s.hash ?? null };
      skeletons.set(s.id, skeleton);
      disposables.push(skeleton);
    }
    const identity = new THREE.Matrix4();
    for (const n of manifest.nodes) if (n.skin && n.mesh) nodes.get(n.id).bind(skeletons.get(n.skin), identity);

    // Clips: node channels only in this release.
    const animations = [];
    for (const a of manifest.animations ?? []) {
      const tracks = [], skipped = new Set();
      for (const t of a.tracks) {
        if (t.material !== undefined || t.channel.startsWith("light.")) { skipped.add(t.material !== undefined ? "material channels" : "light channels"); continue; }
        const times = t.times.stream !== undefined ? Float32Array.from(streams.typed(t.times.stream, Float32Array)) : Float32Array.from({ length: t.times.count }, (_, i) => (t.times.start ?? 0) + i / t.times.fps);
        const raw = streams.of(t.values);
        const values = raw instanceof Int16Array ? Float32Array.from(raw, (v) => Math.max(-1, v / 32767)) : Float32Array.from(raw);
        const interpolation = t.interpolation === "step" ? THREE.InterpolateDiscrete : THREE.InterpolateLinear;
        const path = `${t.node}.`;
        if (t.channel === "rotation") tracks.push(new THREE.QuaternionKeyframeTrack(`${path}quaternion`, times, values, interpolation));
        else if (t.channel === "position" || t.channel === "scale") tracks.push(new THREE.VectorKeyframeTrack(path + t.channel, times, values, interpolation));
        else if (t.channel === "visible") tracks.push(new THREE.BooleanKeyframeTrack(`${path}visible`, times, Array.from(values, (v) => v > 0.5)));
        else if (t.channel.startsWith("morph:")) {
          const target = t.channel.slice(6), object = nodes.get(t.node), mesh = object?.userData.mesh ?? object;
          const index = mesh?.morphTargetDictionary?.[target];
          if (index === undefined) { skipped.add(`morph target ${target}`); continue; }
          tracks.push(new THREE.NumberKeyframeTrack(`${path}morphTargetInfluences[${index}]`, times, values, interpolation));
        } else skipped.add(`channel ${t.channel}`);
      }
      for (const what of skipped) note(`animation "${a.id}": ${what} are not in this release; skipped`);
      const clip = new THREE.AnimationClip(a.id, a.duration, tracks);
      clip.userData = { name: a.name ?? a.id, loop: a.loop ?? "repeat", blend: a.blend ?? "normal", mask: a.mask ?? null, root: a.root ?? null, events: a.events ?? [] };
      animations.push(clip);
    }

    // Physics data the kit needs beyond the manifest: hull points.
    const physicsData = { points: new Map() };
    for (const s of manifest.physics?.shapes ?? []) if (s.type === "convex") physicsData.points.set(s.id, streams.of(s.points));

    const model = {
      manifest, kind: manifest.kind, asset: manifest.asset, root, nodes, geometries, materials: materialDescs, textures, images, skeletons, animations, placements, lights, physicsData, warnings,
      node: (id) => nodes.get(id) ?? null,
      clip: (id) => animations.find((c) => c.name === id) ?? null,
      textureFor,
      dispose() {
        for (const g of geometries.values()) g.dispose();
        for (const d of disposables) d.dispose?.();
        root.removeFromParent();
      },
    };
    model.file = model;
    return model;
  }

  return {
    read, validate, load,
    /** A .fun3d from Three.js objects; see fun3d-write.js. */
    write: (root, options) => writer.write(root, options),
    stripEditing,
  };
}
