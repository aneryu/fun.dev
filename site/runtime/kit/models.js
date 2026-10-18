// Placing loaded .fun3d models in a scene (docs/model-format.md §7): every copy gets its own
// node tree (an Object3D per node, same ids, `copy.node(id)`), rigid batchable parts join one
// BatchedMesh per vertex layout with a palette material, placements become InstancedMeshes,
// skinned and textured parts are drawn alone, and geometry LOD levels switch by projected error.
//
//   const models = createModels({ THREE, TSL, materials, scene });
//   const car = models.place(taxi, { position: [2, 0, 0] });   // taxi = await fun3d.load(bytes)
//   car.tint = [1, 0.2, 0.2];                                  // materials with the tint feature
//   car.node("wheel_fl"); car.socket("hub");                   // Object3Ds; sockets are attached frames
//   models.update(camera, viewport);                           // each frame, before rendering
//   car.remove();
//
// Batched copies mirror their nodes' world matrices: static copies when placed and on
// `copy.sync()`, live copies (`copy.live = true`; physics sets it for dynamic bodies) every update.

export function createModels({ THREE, TSL = null, materials = null, scene, warn = (message) => console.warn(`models: ${message}`), lodPixels = 1.5, batch: batching = !!materials } = {}) {
  if (!scene) throw new TypeError("createModels needs the scene");
  if (batching && !materials) throw new TypeError("batching needs the materials builder");
  const batches = new Map(), copies = new Set();
  const matrix = new THREE.Matrix4(), matrix2 = new THREE.Matrix4(), vector = new THREE.Vector3(), sphere = new THREE.Sphere();

  // ---- batches: one per vertex layout and blend mode ----
  function signatureOf(geometry) {
    return Object.entries(geometry.attributes).map(([name, a]) => `${name}:${a.array.constructor.name}:${a.itemSize}:${a.normalized ? 1 : 0}`).sort().join("|");
  }
  function batchFor(geometry, transparent) {
    const key = `${signatureOf(geometry)}|${transparent}`;
    if (batches.has(key)) return batches.get(key);
    const palette = materials.palette();
    const mesh = new THREE.BatchedMesh(1024, 1 << 18, 1 << 19, palette.material({ transparent, vertexColors: geometry.hasAttribute("color") }));
    mesh.name = `batch ${batches.size}`;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.sortObjects = transparent;
    mesh.perObjectFrustumCulled = true;
    scene.add(mesh);
    const batch = { mesh, palette, geometries: new Map(), instances: 0, vertices: 0, indices: 0, maxInstances: 1024, maxVertices: 1 << 18, maxIndices: 1 << 19 };
    batches.set(key, batch);
    return batch;
  }
  // A geometry (one LOD level, one blend half) enters a batch once; copies reuse it. Entries
  // are keyed by identity: ids repeat across files.
  function geometryIn(batch, entry, level, range, slotOf) {
    const key = `${level}|${range[0]}`;
    let ids = batch.geometries.get(entry);
    if (!ids) batch.geometries.set(entry, (ids = new Map()));
    if (ids.has(key)) return ids.get(key);
    const source = level ? entry.lods[level - 1].geometry : entry.geometry, position = source.getAttribute("position");
    const part = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(source.attributes)) part.setAttribute(name, attribute);
    // The per-vertex material slot, from the groups of this level.
    const palette = new Uint8Array(position.count * 4), groups = level ? entry.lods[level - 1].groups : entry.groups, index = source.index.array;
    for (const group of groups) for (let i = group.start; i < group.start + group.count; i++) palette[index[i] * 4] = slotOf(group.material);
    part.setAttribute("palette", new THREE.BufferAttribute(palette, 4, true));
    part.setIndex(new THREE.BufferAttribute(index.slice(range[0], range[1]), 1));
    part.boundingBox = source.boundingBox;
    part.boundingSphere = source.boundingSphere;
    if (batch.vertices + position.count > batch.maxVertices || batch.indices + part.index.count > batch.maxIndices) {
      batch.maxVertices = Math.max(batch.maxVertices * 2, batch.vertices + position.count);
      batch.maxIndices = Math.max(batch.maxIndices * 2, batch.indices + part.index.count);
      batch.mesh.setGeometrySize(batch.maxVertices, batch.maxIndices);
    }
    const id = batch.mesh.addGeometry(part);
    batch.vertices += position.count;
    batch.indices += part.index.count;
    ids.set(key, id);
    return id;
  }
  function instanceIn(batch, geometryId) {
    if (batch.instances + 1 > batch.maxInstances) { batch.maxInstances *= 2; batch.mesh.setInstanceCount(batch.maxInstances); }
    batch.instances++;
    return batch.mesh.addInstance(geometryId);
  }

  // The first group of a geometry whose material blends: triangles before it are opaque.
  function blendSplit(file, n, entry) {
    const group = entry.groups.find((g) => file.materials.get(n.mesh.materials[g.material]).alpha.mode === "blend");
    return group ? group.start : entry.index.length;
  }

  // ---- copies ----
  function place(file, { position = null, rotation = null, scale = null, matrix: at = null, batch: wantBatch = "auto", tint = null } = {}) {
    const manifest = file.manifest, nodes = new Map(), parts = [], lodParts = [], singles = [];
    const bones = new Set(manifest.skeletons.flatMap((s) => s.bones));
    const useBatch = batching && wantBatch !== false;
    let root = null;
    // Nodes, with meshes decided per node.
    for (const n of manifest.nodes) {
      const original = file.nodes.get(n.id);
      let object;
      const entry = n.mesh ? file.geometries.get(n.mesh.geometry) : null;
      const descs = n.mesh ? n.mesh.materials.map((id) => file.materials.get(id)) : null;
      const batchable = entry && useBatch && !n.skin && !n.placements && !entry.desc.morph && descs.every(materials.batchable);
      if (n.mesh && n.skin) {
        object = original.clone(false);
        object.skeleton = null; // rebound below with this copy's bones
      } else if (batchable) {
        object = bones.has(n.id) ? new THREE.Bone() : new THREE.Object3D();
        const slots = descs.map((d) => d);
        const split = blendSplit(file, n, entry);
        const part = { node: object, entry, instances: [], levels: [] };
        const levels = [null, ...entry.lods.map((_, i) => i + 1)];
        for (const level of levels) {
          const source = level ? entry.lods[level - 1].geometry : entry.geometry, count = source.index.count;
          const levelSplit = level ? count : split; // LOD levels of blended parts stay in the blend batch as a whole
          const ids = [];
          if (levelSplit > 0) {
            const batch = batchFor(source, false), base = batch.palette.block(slots);
            ids.push({ batch, geometry: geometryIn(batch, entry, level, [0, levelSplit], (slot) => slot), base });
          }
          if (levelSplit < count) {
            const batch = batchFor(source, true), base = batch.palette.block(slots);
            ids.push({ batch, geometry: geometryIn(batch, entry, level, [levelSplit, count], (slot) => slot), base });
          }
          part.levels.push(ids);
        }
        // Instances start on level 0; LOD switching swaps their geometry ids.
        part.instances = part.levels[0].map(({ batch, geometry, base }) => {
          const instance = instanceIn(batch, geometry);
          batch.palette.copy(instance, base, tint);
          return { batch, instance, base, level: 0 };
        });
        parts.push(part);
        if (entry.lods.length) lodParts.push(part);
      } else {
        object = original.clone(false);
        if (n.mesh) {
          const mesh = original.userData.mesh.clone();
          mesh.geometry = original.userData.mesh.geometry;
          object.add(mesh);
          object.userData.mesh = mesh;
          singles.push({ node: object, mesh, entry });
          if (entry?.lods.length) lodParts.push({ node: object, entry, mesh });
        }
      }
      object.name = n.id;
      object.userData = { ...original.userData, mesh: object.userData.mesh };
      if (n.transform && !n.placements) { object.position.copy(original.position); object.quaternion.copy(original.quaternion); object.scale.copy(original.scale); }
      object.visible = original.visible;
      nodes.set(n.id, object);
      if (n.parent !== undefined) nodes.get(n.parent).add(object);
      else root = object;
    }
    // Skeletons for this copy's bones.
    for (const s of manifest.skeletons) {
      const source = file.skeletons.get(s.id);
      const skeleton = new THREE.Skeleton(s.bones.map((id) => nodes.get(id)), source.boneInverses.map((m) => m.clone()));
      for (const n of manifest.nodes) if (n.skin === s.id && n.mesh) nodes.get(n.id).bind(skeleton, new THREE.Matrix4());
    }
    if (at) at.decompose(root.position, root.quaternion, root.scale);
    if (position) root.position.fromArray(position);
    if (rotation) root.quaternion.fromArray(rotation);
    if (scale) root.scale.setScalar(scale);
    scene.add(root);
    root.updateMatrixWorld(true);

    const copy = {
      file, root, nodes, parts, singles, live: false, hasLod: lodParts.length > 0,
      manifest, geometries: file.geometries, animations: file.animations, physicsData: file.physicsData, placements: file.placements,
      node: (id) => nodes.get(id) ?? null,
      /** An Object3D at the socket's frame, created on first use under its node. */
      socket(id) {
        for (const [nodeId, sockets] of Object.entries(file.manifest.nodes.reduce((all, n) => (n.sockets ? { ...all, [n.id]: n.sockets } : all), {}))) {
          if (!sockets[id]) continue;
          const node = nodes.get(nodeId), existing = node.children.find((c) => c.userData.socket === id);
          if (existing) return existing;
          const frame = new THREE.Object3D();
          frame.userData.socket = id;
          frame.position.fromArray(sockets[id].position ?? [0, 0, 0]);
          frame.quaternion.fromArray(sockets[id].rotation ?? [0, 0, 0, 1]);
          node.add(frame);
          return frame;
        }
        return null;
      },
      /** Writes the batch instances' matrices from the nodes (static copies do this when moved). */
      sync() {
        root.updateMatrixWorld(true);
        for (const part of parts) {
          part.node.updateWorldMatrix(false, false);
          const d = part.entry.dequantize;
          matrix.copy(part.node.matrixWorld);
          if (d) matrix.multiply(matrix2.compose(vector.fromArray(d.offset), new THREE.Quaternion(), new THREE.Vector3().setScalar(d.scale)));
          for (const { batch, instance } of part.instances) {
            batch.mesh.setMatrixAt(instance, matrix);
            batch.mesh.setVisibleAt(instance, visibleUp(part.node));
          }
        }
      },
      get tint() { return copy._tint; },
      set tint(value) {
        copy._tint = value;
        for (const part of parts) for (const { batch, instance, base } of part.instances) batch.palette.copy(instance, base, value);
        for (const single of singles) {
          const list = [single.mesh.material].flat();
          for (const m of list) if (m.userData.fun3d?.tint) m.userData.fun3d.tint.value.setRGB(...(value ?? [1, 1, 1]));
        }
      },
      remove() {
        copies.delete(copy);
        for (const part of parts) for (const { batch, instance } of part.instances) { batch.mesh.deleteInstance(instance); batch.instances--; }
        root.removeFromParent();
      },
    };
    copy._tint = tint;
    if (tint) for (const single of singles) {
      // Tinted singles need their own materials (each holds a tint uniform).
      const list = [single.mesh.material].flat().map((m) => (m.userData.fun3d?.tint && materials ? materials.build(file.materials.get(m.userData.fun3d.id), { flat: m.userData.fun3d.flat, vertexColors: m.vertexColors, texture: file.textureFor }) : m));
      single.mesh.material = Array.isArray(single.mesh.material) ? list : list[0];
      copy.tint = tint;
    }
    copy.sync();
    copies.add(copy);
    return copy;
  }

  function visibleUp(object) {
    for (let o = object; o; o = o.parent) if (!o.visible) return false;
    return true;
  }

  // The LOD level a part should show: the coarsest whose error projects below `lodPixels`.
  function levelFor(entry, worldMatrix, camera, height) {
    sphere.copy(entry.geometry.boundingSphere).applyMatrix4(worldMatrix);
    const distance = Math.max(1e-3, sphere.center.distanceTo(camera.position) - sphere.radius);
    const perPixel = camera.isPerspectiveCamera ? (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / height : (camera.top - camera.bottom) / camera.zoom / height;
    let level = 0;
    for (let i = 0; i < entry.lods.length; i++) if (entry.lods[i].error * sphere.radius / perPixel <= lodPixels) level = i + 1;
    return level;
  }

  return {
    batches, copies, place,
    roles: materials?.roles ?? { set() {}, get: () => 1 },
    /** Each frame before rendering: live copies' batch matrices, LOD levels. */
    update(camera, { height = 1080 } = {}) {
      for (const copy of copies) {
        if (copy.live) copy.sync();
        if (!copy.hasLod) continue;
        copy.root.updateMatrixWorld(true);
        for (const part of copy.parts) {
          if (!part.entry.lods.length) continue;
          const level = levelFor(part.entry, part.node.matrixWorld, camera, height);
          part.instances.forEach((inst, i) => {
            if (inst.level === level) return;
            inst.batch.mesh.setGeometryIdAt(inst.instance, part.levels[level][i].geometry);
            inst.level = level;
          });
        }
        for (const single of copy.singles) {
          if (!single.entry?.lods.length) continue;
          const level = levelFor(single.entry, single.node.matrixWorld, camera, height);
          const geometry = level ? single.entry.lods[level - 1].geometry : single.entry.geometry;
          if (single.mesh.geometry !== geometry) single.mesh.geometry = geometry;
        }
      }
    },
    dispose() {
      for (const copy of [...copies]) copy.remove();
      for (const batch of batches.values()) { batch.mesh.removeFromParent(); batch.mesh.dispose(); batch.mesh.material.dispose(); batch.palette.dispose(); }
      batches.clear();
    },
  };
}
