// Many .fun3d models in one draw (docs/model-format.md#batching): every rigid part of every
// model added becomes an instance of one BatchedMesh with one palette material, so a street
// of props costs one draw call (plus one for glass) and one shader.
//
//   const batch = createBatch({ THREE, TSL });
//   const lamp = batch.add(loaded, matrix);      // loaded = await fun3d.load(bytes)
//   scene.add(batch.object);
//   batch.roles.set("light", 2);                 // every headlight and window in the batch

export function createBatch({ THREE, TSL }, { instances = 8192, vertices = 1 << 20, indices = 3 << 20, entries = 1024 } = {}) {
  const { attribute, textureLoad, ivec2, int, uniformArray, select, normalGeometry, normalView, normalFlat } = TSL;
  // Palette: three texels per entry — colour + roughness, emission + metalness, role + opacity.
  const data = new Float32Array(entries * 3 * 4), texture = new THREE.DataTexture(data, entries * 3, 1, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  const roleNames = ["none"], roleValues = [1];
  const roleIntensity = uniformArray(new Array(16).fill(1), "float");
  let used = 0;
  const cache = new Map();
  function entry(m) {
    const key = JSON.stringify(m);
    if (cache.has(key)) return cache.get(key);
    if (used >= entries) throw new Error("Palette full");
    const color = new THREE.Color(m.color ?? "#ffffff"), emissive = new THREE.Color(m.emissive ?? "#000000").multiplyScalar(m.emissiveIntensity ?? (m.emissive ? 1 : 0));
    let role = 0;
    if (m.type === "light") {
      const name = m.role.replace(/_.*/, "");
      role = roleNames.indexOf(name);
      if (role < 0) { role = roleNames.length; roleNames.push(name); }
      if (!m.emissive) emissive.copy(color);
    }
    data.set([color.r, color.g, color.b, m.roughness ?? 1, emissive.r, emissive.g, emissive.b, m.metalness ?? 0, role, m.opacity ?? 1, 0, 0], used * 12);
    texture.needsUpdate = true;
    cache.set(key, used);
    return used++;
  }
  function material(transparent) {
    const fm = attribute("palette", "vec2");
    const index = fm.x.mul(65535).round().toInt().mul(3);
    const a = textureLoad(texture, ivec2(index, int(0))), b = textureLoad(texture, ivec2(index.add(1), int(0))), c = textureLoad(texture, ivec2(index.add(2), int(0)));
    const m = new THREE.MeshStandardNodeMaterial({ transparent });
    // Flat faces carry no normal (zero): their normal comes from screen-space derivatives.
    m.normalNode = select(normalGeometry.length().greaterThan(0.5), normalView, normalFlat);
    m.colorNode = a.rgb;
    m.roughnessNode = a.a;
    m.metalnessNode = b.a;
    m.emissiveNode = b.rgb.mul(roleIntensity.element(c.r.round().toInt()));
    if (transparent) { m.opacityNode = c.g; m.depthWrite = false; }
    return m;
  }
  const opaque = new THREE.BatchedMesh(instances, vertices, indices, material(false));
  const glass = new THREE.BatchedMesh(Math.max(64, instances >> 4), vertices >> 3, indices >> 3, material(true));
  for (const b of [opaque, glass]) { b.castShadow = b.receiveShadow = true; b.sortObjects = false; }
  glass.sortObjects = true;
  glass.visible = false;
  const object = new THREE.Group();
  object.add(opaque, glass);

  // Each part geometry enters each batch once; models reuse it.
  const added = new WeakMap();
  function geometryIn(batch, geometry, slots, range) {
    const key = `${batch.uuid}:${range[0]}`;
    let ids = added.get(geometry);
    if (!ids) added.set(geometry, (ids = {}));
    if (ids[key] !== undefined) return ids[key];
    const position = geometry.getAttribute("position"), local = geometry.getAttribute("materialIndex");
    const palette = new Uint16Array(position.count * 2);
    for (let v = 0; v < position.count; v++) palette[v * 2] = slots[local ? local.getX(v) : 0];
    const part = new THREE.BufferGeometry();
    part.setAttribute("position", position);
    part.setAttribute("normal", geometry.getAttribute("normal") ?? new THREE.BufferAttribute(new Int8Array(position.count * 4), 4, true));
    part.setAttribute("palette", new THREE.BufferAttribute(palette, 2, true));
    const index = geometry.index.array.subarray(range[0], range[1]);
    part.setIndex(new THREE.BufferAttribute(Uint32Array.from(index), 1));
    part.computeBoundingBox();
    part.computeBoundingSphere();
    return (ids[key] = batch.addGeometry(part));
  }

  return {
    object,
    roles: { set(name, value) { const i = roleNames.indexOf(name); if (i > 0) roleIntensity.array[i] = value; } },
    /** Adds a loaded model's rigid parts at `matrix`; returns the instances by part name. */
    add(model, matrix = new THREE.Matrix4()) {
      const root = model.scene, parts = [];
      root.updateMatrixWorld(true);
      const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
      root.traverse((o) => {
        if (!o.isMesh || o.isSkinnedMesh || !o.visible || !o.geometry.userData.fun3d?.quantization) return;
        let hidden = false;
        for (let p = o; p; p = p.parent) if (!p.visible) hidden = true;
        if (hidden) return;
        const materials = [o.material].flat().map((m) => ({ ...m.userData.fun3d, color: `#${m.color.getHexString()}`, roughness: m.roughness, metalness: m.metalness, emissive: m.emissive?.getHex() ? `#${m.emissive.getHexString()}` : undefined, emissiveIntensity: m.emissiveIntensity, opacity: m.opacity, glass: m.isMeshPhysicalMaterial && m.transmission > 0 }));
        const slots = materials.map(entry);
        // Opaque triangles first, then glass (the converter orders them so).
        const groups = o.geometry.groups.length ? o.geometry.groups : [{ start: 0, count: o.geometry.index.count, materialIndex: 0 }];
        const firstGlass = groups.find((g) => materials[g.materialIndex].glass || (materials[g.materialIndex].opacity ?? 1) < 1);
        const split = firstGlass ? firstGlass.start : o.geometry.index.count;
        const local = new THREE.Matrix4().multiplyMatrices(rootInverse, o.matrixWorld);
        const part = { name: (o.parent?.userData.fun3dMesh === o ? o.parent.name : o.name), local, instances: [] };
        if (split > 0) part.instances.push([opaque, opaque.addInstance(geometryIn(opaque, o.geometry, slots, [0, split]))]);
        if (split < o.geometry.index.count) {
          part.instances.push([glass, glass.addInstance(geometryIn(glass, o.geometry, slots, [split, o.geometry.index.count]))]);
          glass.visible = true;
        }
        parts.push(part);
      });
      const handle = {
        parts,
        setMatrix(m) {
          for (const part of parts) {
            const world = new THREE.Matrix4().multiplyMatrices(m, part.local);
            for (const [batch, id] of part.instances) batch.setMatrixAt(id, world);
          }
        },
      };
      handle.setMatrix(matrix);
      return handle;
    },
  };
}
