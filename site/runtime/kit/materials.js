// Platform materials in TSL (docs/model-format.md §4.3): the shading models pbr and unlit and
// the core features emitter and tint, built the same way for a mesh drawn alone (`build`) and for
// a batch (`palette`), so a model renders alike in both. Emitter roles scale every emitter of
// that role at once (`roles.set("window", 0)` at day).
//
//   const materials = createMaterials({ THREE, TSL });
//   const fun3d = createFun3d({ THREE, decoder, materials });     // single meshes use materials.build
//   const palette = materials.palette();                           // one per batch (kit/models.js)
//   materials.roles.set("headlight", 0);

import { applyTransmission } from './material-features.js';
const ROLE_SLOTS = 32, PALETTE_WIDTH = 1024;

export function createMaterials({ THREE, TSL, transmission = 'physical' }) {
  if (!TSL) throw new TypeError("createMaterials needs TSL (three/tsl)");
  const { Fn, attribute, select, normalGeometry, normalView, normalFlat, materialColor, materialEmissive, vec3, vec4, float, int, ivec2, uniform, uniformArray, textureLoad, mix, batchIndirectIndex } = TSL;

  // Emitter roles: an intensity factor per role, shared by every material built here.
  const roleNames = ["none"], roleFactors = uniformArray(new Array(ROLE_SLOTS).fill(1), "float");
  const roles = {
    index(name) {
      let i = roleNames.indexOf(name);
      if (i < 0) { if (roleNames.length >= ROLE_SLOTS) return 0; i = roleNames.length; roleNames.push(name); }
      return i;
    },
    set(name, factor) { const i = roleNames.indexOf(name); if (i > 0) roleFactors.array[i] = factor; },
    get(name) { const i = roleNames.indexOf(name); return i > 0 ? roleFactors.array[i] : 1; },
    list: () => roleNames.slice(1),
  };

  // The copy's tint: the geometry's instanced "tint" attribute (placements) or the material's
  // own uniform (kit/models.js sets handle.tint through it).
  const tintOf = (tint) => Fn((builder) => (builder.geometry?.hasAttribute("tint") ? attribute("tint", "vec4").rgb : tint))();

  /** A NodeMaterial for a normalized descriptor; `texture(map, colorSpace)` resolves map textures. */
  function build(desc, { flat = false, vertexColors = false, texture, warn = () => {} } = {}) {
    const unlit = desc.model === "unlit";
    const material = unlit ? new THREE.MeshBasicNodeMaterial() : desc.features.transmission && transmission === 'physical'
      ? new THREE.MeshPhysicalNodeMaterial() : new THREE.MeshStandardNodeMaterial();
    applyTransmission(material, desc, transmission, warn);
    material.name = desc.name;
    material.color.set(desc.color);
    material.side = desc.side === "double" ? THREE.DoubleSide : THREE.FrontSide;
    material.vertexColors = vertexColors;
    material.flatShading = flat;
    const maps = desc.maps;
    if (maps.color) material.map = texture(maps.color, "srgb");
    if (!unlit) {
      material.roughness = desc.pbr.roughness;
      material.metalness = desc.pbr.metalness;
      if (maps.normal) { material.normalMap = texture(maps.normal); material.normalScale.setScalar(maps.normal.scale ?? 1); }
      if (maps.metalRough) material.metalnessMap = material.roughnessMap = texture(maps.metalRough);
      if (maps.occlusion) { material.aoMap = texture(maps.occlusion); material.aoMapIntensity = maps.occlusion.strength ?? 1; }
    }
    if (maps.alpha) material.alphaMap = texture(maps.alpha);
    if (desc.alpha.mode === "mask") material.alphaTest = desc.alpha.cutoff;
    material.opacity = desc.alpha.opacity;
    if (desc.alpha.mode === "blend") { material.transparent = true; material.opacity = desc.alpha.opacity; material.depthWrite = false; }
    const features = desc.features, info = { id: desc.id, flat, role: null, tint: null };
    if (features.tint) {
      info.tint = uniform(new THREE.Color(1, 1, 1));
      material.colorNode = materialColor.mul(tintOf(info.tint));
    }
    if (features.emitter) {
      const e = features.emitter, role = roles.index(e.role);
      info.role = e.role;
      const factor = roleFactors.element(int(role));
      if (unlit) {
        // Unlit emitters add their glow to the colour.
        const glow = vec3(...new THREE.Color(e.color ?? "#ffffff").toArray()).mul(e.intensity ?? 1).mul(factor);
        const base = material.colorNode ?? materialColor;
        material.colorNode = vec4(base.rgb.add(glow), base.a);
      } else {
        material.emissive.set(e.color ?? "#ffffff");
        material.emissiveIntensity = e.intensity ?? 1;
        if (e.map) material.emissiveMap = texture(e.map, "srgb");
        material.emissiveNode = materialEmissive.mul(factor);
      }
    }
    for (const name of Object.keys(features)) if (!["emitter", "tint", "transmission"].includes(name)) warn(`material "${desc.id}": feature ${name} is not in this release; rendered without it`);
    material.userData.fun3d = info;
    return material;
  }

  // Whether a descriptor can join a batch: pbr or unlit, no maps, no transmission.
  const batchable = (desc) => !Object.keys(desc.maps).length && Object.keys(desc.features).every(k => ['emitter','tint'].includes(k)) && !desc.features.emitter?.map;

  /**
   * A palette: material parameters in a texture, indexed per vertex by a local slot plus a
   * per-copy base, so one BatchedMesh draws every batchable material. Three texels per entry:
   * colour + roughness, emission + metalness, role + opacity + tint flag + unlit flag. One texel
   * per copy: tint and palette base.
   */
  function palette({ entries = 4096, copies = 4096 } = {}) {
    const rows = (texels) => Math.ceil(texels / PALETTE_WIDTH);
    const data = new Float32Array(PALETTE_WIDTH * rows(entries * 3) * 4), texture = new THREE.DataTexture(data, PALETTE_WIDTH, rows(entries * 3), THREE.RGBAFormat, THREE.FloatType);
    const copyData = new Float32Array(PALETTE_WIDTH * rows(copies) * 4), copyTexture = new THREE.DataTexture(copyData, PALETTE_WIDTH, rows(copies), THREE.RGBAFormat, THREE.FloatType);
    for (const t of [texture, copyTexture]) { t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; }
    copyData.fill(1);
    let used = 0;
    const blocks = new Map();
    const texel = (tex, index) => textureLoad(tex, ivec2(index.mod(PALETTE_WIDTH), index.div(PALETTE_WIDTH)));
    const color = new THREE.Color();
    function writeEntry(index, desc) {
      const unlit = desc.model === "unlit", e = desc.features.emitter;
      color.set(desc.color);
      const emissive = e ? new THREE.Color(e.color ?? "#ffffff").multiplyScalar(e.intensity ?? 1) : new THREE.Color(0, 0, 0);
      data.set([color.r, color.g, color.b, unlit ? 1 : desc.pbr.roughness, emissive.r, emissive.g, emissive.b, unlit ? 0 : desc.pbr.metalness, e ? roles.index(e.role) : 0, desc.alpha.mode === "blend" ? desc.alpha.opacity : 1, desc.features.tint ? 1 : 0, unlit ? 1 : 0], index * 12);
    }
    function material({ transparent = false, vertexColors = false } = {}) {
      const m = new THREE.MeshStandardNodeMaterial({ transparent, vertexColors });
      const slot = attribute("palette", "vec4");
      const copy = texel(copyTexture, int(batchIndirectIndex));
      const index = slot.x.mul(255).round().toInt().add(copy.a.toInt()).mul(3);
      const a = texel(texture, index), b = texel(texture, index.add(1)), c = texel(texture, index.add(2));
      const tint = mix(vec3(1, 1, 1), copy.rgb, c.b), base = a.rgb.mul(tint), unlit = c.a.greaterThan(0.5);
      // Unlit entries: black, fully metallic (no specular) with the colour as emission.
      m.colorNode = select(unlit, vec3(0, 0, 0), base);
      m.roughnessNode = select(unlit, float(1), a.a);
      m.metalnessNode = select(unlit, float(1), b.a);
      m.emissiveNode = select(unlit, base, b.rgb.mul(roleFactors.element(c.r.round().toInt())));
      // Flat groups carry zero normals: theirs come from screen-space derivatives.
      m.normalNode = select(normalGeometry.length().greaterThan(0.5), normalView, normalFlat);
      if (transparent) { m.opacityNode = c.g; m.depthWrite = false; }
      m.userData.fun3d = { palette: true };
      return m;
    }
    return {
      texture, copyTexture, roles,
      /** The palette base of a contiguous block for these descriptors (shared by every copy of the node). */
      block(descs) {
        const key = JSON.stringify(descs);
        if (blocks.has(key)) return blocks.get(key);
        if (used + descs.length > entries) throw new Error("the palette is full");
        const base = used;
        descs.forEach((desc, i) => writeEntry(base + i, desc));
        used += descs.length;
        texture.needsUpdate = true;
        blocks.set(key, base);
        return base;
      },
      /** Rewrites one entry of a block (animated parameters, release 2). */
      update(base, slot, desc) { writeEntry(base + slot, desc); texture.needsUpdate = true; },
      /** The copy's tint (linear rgb) and palette base, by batch instance id. */
      copy(instance, base, tint = null) {
        if (instance >= copies) throw new Error("too many copies for the palette");
        copyData.set([tint?.[0] ?? 1, tint?.[1] ?? 1, tint?.[2] ?? 1, base], instance * 4);
        copyTexture.needsUpdate = true;
      },
      material,
      dispose() { texture.dispose(); copyTexture.dispose(); },
    };
  }

  return { build, batchable, palette, roles, roleFactors };
}
