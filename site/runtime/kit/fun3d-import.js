// GLB → .fun3d: what the console does to every upload and the workshop to every import.
// GLTFLoader reads the file; this module normalizes the result the way .fun3d expects it and
// derives roles and physics from the library's naming conventions (docs/models.md):
// - static parts (`static__<material>` under the root) merge into one part, `static`;
// - every other mesh node merges its primitives into one geometry with one group per material;
// - flat faces are welded and lose their normals (the renderer derives them);
// - texture coordinates go when no material uses a texture;
// - materials named mat_light*, mat_signal*, mat_window*, mat_lamp* become light materials
//   with that role; transmissive ones glass;
// - physics: props get a convex hull, pieces their mesh, vehicles (wheel_* nodes) a Jolt
//   wheeled vehicle, characters a capsule and a ragdoll.
//
//   const importer = createImporter({ THREE, loader, encoder });
//   const { root, animations, physics, rig, kind } = await importer.importGLB(bytes, { type });
//   const file = await fun3d.write(root, { kind, animations, physics, rig });

const LIGHT = /^mat_(light|signal|window|lamp|screen|beacon)/;

// Ragdoll parts: logical part → bone per rig, its parent part, the bone its capsule reaches
// and joint limits (radians: swing cone, twist range).
const RIGS = {
  ue: {
    test: (names) => names.has("pelvis") && names.has("spine_01") && names.has("thigh_l"),
    bones: { pelvis: "pelvis", spine: "spine_01", chest: "spine_03", head: "head", upperarm_l: "upperarm_l", lowerarm_l: "lowerarm_l", upperarm_r: "upperarm_r", lowerarm_r: "lowerarm_r", thigh_l: "thigh_l", calf_l: "calf_l", thigh_r: "thigh_r", calf_r: "calf_r", hand_l: "hand_l", hand_r: "hand_r", foot_l: "foot_l", foot_r: "foot_r", neck: "neck_01" },
  },
  mixamo: {
    test: (names) => names.has("mixamorigHips"),
    bones: { pelvis: "mixamorigHips", spine: "mixamorigSpine", chest: "mixamorigSpine2", head: "mixamorigHead", upperarm_l: "mixamorigLeftArm", lowerarm_l: "mixamorigLeftForeArm", upperarm_r: "mixamorigRightArm", lowerarm_r: "mixamorigRightForeArm", thigh_l: "mixamorigLeftUpLeg", calf_l: "mixamorigLeftLeg", thigh_r: "mixamorigRightUpLeg", calf_r: "mixamorigRightLeg", hand_l: "mixamorigLeftHand", hand_r: "mixamorigRightHand", foot_l: "mixamorigLeftFoot", foot_r: "mixamorigRightFoot", neck: "mixamorigNeck" },
  },
};
const RAGDOLL = [
  // part, parent, capsule end, radius (m), mass share, swing cone, twist min, twist max
  ["pelvis", null, "spine", 0.13, 0.16, 0, 0, 0],
  ["spine", "pelvis", "chest", 0.13, 0.14, 0.35, -0.25, 0.25],
  ["chest", "spine", "neck", 0.15, 0.2, 0.35, -0.25, 0.25],
  ["head", "chest", null, 0.1, 0.08, 0.6, -0.6, 0.6],
  ["upperarm_l", "chest", "lowerarm_l", 0.05, 0.03, 1.4, -0.8, 0.8],
  ["lowerarm_l", "upperarm_l", "hand_l", 0.04, 0.025, 1.2, -0.3, 0.3],
  ["upperarm_r", "chest", "lowerarm_r", 0.05, 0.03, 1.4, -0.8, 0.8],
  ["lowerarm_r", "upperarm_r", "hand_r", 0.04, 0.025, 1.2, -0.3, 0.3],
  ["thigh_l", "pelvis", "calf_l", 0.075, 0.1, 1.0, -0.4, 0.4],
  ["calf_l", "thigh_l", "foot_l", 0.06, 0.05, 1.1, -0.1, 0.1],
  ["thigh_r", "pelvis", "calf_r", 0.075, 0.1, 1.0, -0.4, 0.4],
  ["calf_r", "thigh_r", "foot_r", 0.06, 0.05, 1.1, -0.1, 0.1],
];

export function createImporter({ THREE, loader, encoder }) {
  // The encoded bytes of every texture, so a .fun3d keeps the original WebP/PNG/KTX2.
  async function captureTextureSources(gltf) {
    const { parser } = gltf, json = parser.json;
    for (const [object, association] of parser.associations) {
      if (!object?.isTexture || association?.textures === undefined) continue;
      const def = json.textures[association.textures];
      const source = def.extensions?.EXT_texture_webp?.source ?? def.extensions?.KHR_texture_basisu?.source ?? def.extensions?.EXT_texture_avif?.source ?? def.source;
      const image = json.images[source];
      if (image?.bufferView === undefined) continue;
      const view = await parser.getDependency("bufferView", image.bufferView);
      object.userData.fun3dSource = { mime: image.mimeType, bytes: new Uint8Array(view.slice(0)) };
    }
  }

  const textured = (material) => ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "alphaMap"].some((k) => material[k]);

  // Library conventions → material types.
  function typeMaterial(material) {
    const name = material.name ?? "";
    if (LIGHT.test(name)) material.userData.fun3d = { type: "light", role: name.replace(/^mat_/, "") };
    else if (material.transmission > 0) material.userData.fun3d = { type: "glass" };
    return material;
  }

  // One welded geometry from several meshes (each with one material), in `space`.
  function mergeMeshes(meshes, space) {
    const slots = [], triangles = [];
    const inverse = new THREE.Matrix4().copy(space).invert();
    for (const mesh of meshes) {
      const matrix = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
      const g = mesh.geometry, position = g.getAttribute("position"), normal = g.getAttribute("normal"), uv = g.getAttribute("uv");
      const materials = [mesh.material].flat();
      const groups = g.groups.length ? g.groups : [{ start: 0, count: g.index ? g.index.count : position.count, materialIndex: 0 }];
      for (const group of groups) {
        const material = materials[group.materialIndex ?? 0];
        let slot = slots.indexOf(material);
        if (slot < 0) { slot = slots.length; slots.push(material); }
        for (let t = group.start; t < group.start + group.count; t += 3) {
          const ids = [0, 1, 2].map((k) => (g.index ? g.index.getX(t + k) : t + k));
          triangles.push({
            slot,
            p: ids.map((i) => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix)),
            n: normal ? ids.map((i) => new THREE.Vector3().fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize()) : null,
            uv: uv ? ids.map((i) => [uv.getX(i), uv.getY(i)]) : null,
          });
        }
      }
    }
    // A face is flat when its vertex normals equal its face normal.
    for (const t of triangles) {
      const face = new THREE.Vector3().subVectors(t.p[1], t.p[0]).cross(new THREE.Vector3().subVectors(t.p[2], t.p[0]));
      t.flat = face.lengthSq() < 1e-20 || !t.n || (face.normalize(), t.n.every((n) => n.dot(face) > 0.999));
    }
    const smooth = triangles.some((t) => !t.flat), keepUV = slots.some(textured) && triangles.every((t) => t.uv);
    // Opaque materials first, then blended and glass, so a batch can draw them in two passes.
    const blended = (m) => m.transparent || m.transmission > 0;
    const order = slots.map((_, i) => i).sort((a, b) => blended(slots[a]) - blended(slots[b]) || a - b);
    const rank = new Map(order.map((slot, i) => [slot, i]));
    triangles.sort((a, b) => rank.get(a.slot) - rank.get(b.slot));
    const key = new Map(), positions = [], normals = [], uvs = [], materialIndex = [], indices = [];
    for (const t of triangles) {
      const slot = rank.get(t.slot);
      for (let k = 0; k < 3; k++) {
        const p = t.p[k], n = smooth && !t.flat ? t.n[k] : null, uv = keepUV ? t.uv[k] : null;
        const id = `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}|${slot}|${n ? `${n.x.toFixed(4)},${n.y.toFixed(4)},${n.z.toFixed(4)}` : "f"}|${uv ? uv.map((v) => v.toFixed(5)).join(",") : ""}`;
        let index = key.get(id);
        if (index === undefined) {
          index = positions.length / 3;
          key.set(id, index);
          positions.push(p.x, p.y, p.z);
          if (smooth) {
            // Flat faces in a smooth mesh carry their face normal.
            const face = n ?? new THREE.Vector3().subVectors(t.p[1], t.p[0]).cross(new THREE.Vector3().subVectors(t.p[2], t.p[0])).normalize();
            normals.push(face.x, face.y, face.z);
          }
          if (keepUV) uvs.push(...uv);
          materialIndex.push(slot);
        }
        indices.push(index);
      }
    }
    // Vertex cache and fetch order (meshopt) also makes the file compress better.
    let index = Uint32Array.from(indices), count = positions.length / 3, remap = null;
    if (encoder?.reorderMesh && index.length) {
      [remap, count] = encoder.reorderMesh(index, true, false);
    }
    const reorder = (source, size) => {
      if (!remap) return Float32Array.from(source);
      const out = new Float32Array(count * size);
      for (let i = 0; i < source.length / size; i++) if (remap[i] !== 0xffffffff) for (let k = 0; k < size; k++) out[remap[i] * size + k] = source[i * size + k];
      return out;
    };
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(reorder(positions, 3), 3));
    if (smooth) geometry.setAttribute("normal", new THREE.BufferAttribute(reorder(normals, 3), 3));
    if (keepUV) geometry.setAttribute("uv", new THREE.BufferAttribute(reorder(uvs, 2), 2));
    if (slots.length > 1) geometry.setAttribute("materialIndex", new THREE.BufferAttribute(Uint8Array.from(reorder(materialIndex, 1)), 1));
    geometry.setIndex(new THREE.BufferAttribute(count > 65535 ? index : Uint16Array.from(index), 1));
    let start = 0;
    order.forEach((slot, i) => {
      const n = triangles.filter((t) => t.slot === slot).length * 3;
      geometry.addGroup(start, n, i);
      start += n;
    });
    return { geometry, materials: order.map((slot) => slots[slot]) };
  }

  async function importGLB(bytes, { type = null } = {}) {
    const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const gltf = await loader.parseAsync(buffer, "");
    await captureTextureSources(gltf);
    const scene = gltf.scene, associations = gltf.parser.associations;
    // The model's root: the glTF scene's only child (the library's <id>_ROOT), else the scene.
    const root = scene.children.length === 1 && !scene.children[0].isMesh ? scene.children[0] : scene;
    if (root !== scene) { scene.remove(root); root.position.set(0, 0, 0); root.quaternion.identity(); root.scale.set(1, 1, 1); }
    root.updateMatrixWorld(true);

    const skinned = [], bones = [], meshes = [], wheels = [];
    root.traverse((o) => {
      if (o.isSkinnedMesh) skinned.push(o);
      if (o.isBone) bones.push(o);
      if (o.isMesh) meshes.push(o);
      if (/^wheel_/.test(o.name)) wheels.push(o);
    });
    const boneNames = new Set(bones.map((b) => b.name));
    const rigName = Object.entries(RIGS).find(([, rig]) => rig.test(boneNames))?.[0] ?? (bones.length ? "custom" : null);
    const kind = !meshes.length && gltf.animations.length ? "animations" : "model";
    const role = kind === "animations" ? "animations" : skinned.length ? "character" : wheels.length ? "vehicle" : type === "piece" ? "piece" : "prop";
    for (const mesh of meshes) for (const material of [mesh.material].flat()) typeMaterial(material);

    // GLTFLoader turns a glTF mesh with several primitives into a group of meshes; those
    // groups are one part, so their primitives merge back into one geometry.
    const primitives = (node) => node.isMesh ? [node]
      : node.isGroup && node.children.length && node.children.every((c) => c.isMesh && !c.children.length && associations.get(c)?.primitives !== undefined
        && associations.get(c).meshes === associations.get(node.children[0]).meshes) ? node.children : null;
    if (!skinned.length) {
      // Static parts merge into one part in the root's space.
      const statics = root.children.filter((c) => /^static__/.test(c.name) && primitives(c));
      if (statics.length) {
        const { geometry, materials } = mergeMeshes(statics.flatMap(primitives), root.matrixWorld);
        for (const s of statics) root.remove(s);
        const part = new THREE.Mesh(geometry, materials.length === 1 ? materials[0] : materials);
        part.name = "static";
        part.userData.fun3d = { role: "static" };
        root.add(part);
      }
      // A moving part split by material (`wheel_front_left__mat_rubber` under
      // `wheel_front_left`, the library's convention) becomes one mesh: the pivot itself.
      const pivots = [];
      root.traverse((o) => { if (o !== root && !o.isMesh && o.children.some((c) => c.name.startsWith(`${o.name}__`) && primitives(c))) pivots.push(o); });
      for (const pivot of pivots) {
        const splits = pivot.children.filter((c) => c.name.startsWith(`${pivot.name}__`) && primitives(c));
        const { geometry, materials } = mergeMeshes(splits.flatMap(primitives), pivot.matrixWorld);
        const part = new THREE.Mesh(geometry, materials.length === 1 ? materials[0] : materials);
        part.name = pivot.name;
        part.position.copy(pivot.position); part.quaternion.copy(pivot.quaternion); part.scale.copy(pivot.scale);
        for (const child of pivot.children.filter((c) => !splits.includes(c))) part.add(child);
        pivot.parent.add(part);
        pivot.parent.remove(pivot);
        part.updateMatrixWorld(true);
        part.userData.fun3dMerged = true;
      }
      // Every other mesh node: its primitives welded into one geometry, its children kept.
      const parts = [];
      root.traverse((o) => { if (o !== root && o.name !== "static" && !o.userData.fun3dMerged && primitives(o) && !(o.isMesh && o.parent !== root && primitives(o.parent))) parts.push(o); });
      for (const node of parts) {
        const { geometry, materials } = mergeMeshes(primitives(node), node.matrixWorld);
        const material = materials.length === 1 ? materials[0] : materials;
        if (node.isMesh) { node.geometry = geometry; node.material = material; continue; }
        const part = new THREE.Mesh(geometry, material);
        part.name = node.name;
        part.position.copy(node.position); part.quaternion.copy(node.quaternion); part.scale.copy(node.scale);
        node.parent.add(part);
        node.parent.remove(node);
      }
      root.traverse((o) => {
        delete o.userData.fun3dMerged;
        if (/^collider/.test(o.name)) { o.visible = false; o.userData.fun3d = { role: "collider" }; }
        else if (o !== root && o.name && o.name !== "static" && !o.userData.fun3d) o.userData.fun3d = { role: "part" };
      });
    } else {
      // Characters: drop texture coordinates nobody samples; geometry stays as rigged.
      for (const mesh of skinned) if (![mesh.material].flat().some(textured)) mesh.geometry.deleteAttribute("uv");
    }
    root.updateMatrixWorld(true);
    // Wheels after merging (merged parts are new objects): the outermost wheel_* nodes.
    const wheelNodes = [];
    root.traverse((o) => { if (/^wheel_/.test(o.name) && !wheelNodes.some((w) => w.getObjectById(o.id))) wheelNodes.push(o); });
    const physics = derivePhysics(root, role, { wheels: wheelNodes, rigName });
    return { root, animations: gltf.animations, physics, rig: rigName, kind, role };
  }

  function bounds(object, filter = () => true) {
    const box = new THREE.Box3(), inverse = new THREE.Matrix4().copy(object.matrixWorld).invert(), v = new THREE.Vector3();
    object.traverse((o) => {
      if (!o.isMesh || !filter(o) || !o.visible && o.userData.fun3d?.role !== "collider") return;
      const p = o.geometry.getAttribute("position"), m = new THREE.Matrix4().multiplyMatrices(inverse, o.matrixWorld);
      for (let i = 0; i < p.count; i++) box.expandByPoint(v.fromBufferAttribute(p, i).applyMatrix4(m));
    });
    return box;
  }
  function hullPoints(object, filter = () => true, limit = 256) {
    const inverse = new THREE.Matrix4().copy(object.matrixWorld).invert(), v = new THREE.Vector3(), points = [];
    object.traverse((o) => {
      if (!o.isMesh || !filter(o)) return;
      const p = o.geometry.getAttribute("position"), m = new THREE.Matrix4().multiplyMatrices(inverse, o.matrixWorld);
      for (let i = 0; i < p.count; i++) points.push(v.fromBufferAttribute(p, i).applyMatrix4(m).toArray());
    });
    // Keep the extremes along many directions: a hull needs few points.
    if (points.length <= limit) return points.flat();
    const keep = new Set();
    for (let k = 0; k < limit; k++) {
      const phi = Math.acos(1 - (2 * (k + 0.5)) / limit), theta = Math.PI * (1 + Math.sqrt(5)) * k;
      const d = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      let best = 0, score = -Infinity;
      points.forEach((p, i) => { const s = p[0] * d[0] + p[1] * d[1] + p[2] * d[2]; if (s > score) { score = s; best = i; } });
      keep.add(best);
    }
    return [...keep].flatMap((i) => points[i].map((n) => +n.toFixed(5)));
  }

  function derivePhysics(root, role, { wheels, rigName }) {
    if (role === "animations") return null;
    const colliders = [];
    root.traverse((o) => { if (o.userData.fun3d?.role === "collider" && o.isMesh) colliders.push(o); });
    const shapeOf = (filter) => ({ type: "convex", points: hullPoints(root, filter) });
    if (role === "vehicle") {
      const body = bounds(root, (o) => !wheels.some((w) => w === o || w.getObjectById(o.id)));
      const size = body.getSize(new THREE.Vector3());
      const mass = Math.round(Math.max(50, size.x * size.y * size.z * 100));
      const wheelDefs = wheels.map((wheel) => {
        const box = bounds(wheel), wsize = box.getSize(new THREE.Vector3());
        const center = new THREE.Vector3(); wheel.getWorldPosition(center); root.worldToLocal(center);
        const front = center.z > 0;
        return { node: wheel.name, position: center.toArray().map((n) => +n.toFixed(4)), radius: +(Math.max(wsize.y, wsize.z) / 2).toFixed(4), width: +Math.max(0.05, wsize.x).toFixed(4),
          suspension: { min: 0.05, max: 0.25, frequency: 1.6, damping: 0.5 }, ...(front ? { steer: 0.6 } : {}), brake: 1500, ...(front ? {} : { handbrake: 4000 }) };
      });
      const index = (side, front) => wheelDefs.findIndex((w) => (w.position[0] > 0) === side && (w.position[2] > 0) === front);
      const differentials = [[index(true, true), index(false, true)]].filter(([l, r]) => l >= 0 && r >= 0)
        .map(([left, right]) => ({ left, right, ratio: 3.42, share: 1 }));
      return {
        shapes: [shapeOf((o) => !wheels.some((w) => w === o || w.getObjectById(o.id)))],
        bodies: [{ node: 0, shape: 0, motion: "dynamic", mass, friction: 0.5, restitution: 0.1 }],
        vehicles: [{ type: "wheeled", body: 0, wheels: wheelDefs, engine: { maxTorque: Math.round(mass * 0.25), minRPM: 1000, maxRPM: 6000 },
          transmission: { mode: "auto", gears: [2.66, 1.78, 1.3, 1.0, 0.74], reverse: [-2.9] }, differentials, antiRoll: [] }],
      };
    }
    if (role === "character") {
      const rig = RIGS[rigName];
      const box = bounds(root);
      const height = box.max.y - box.min.y, radius = Math.min(0.35, Math.max(0.15, (box.max.x - box.min.x) / 4));
      const out = {
        shapes: [{ type: "capsule", radius: +radius.toFixed(3), halfHeight: +Math.max(0.05, height / 2 - radius).toFixed(3) }],
        character: { shape: 0, offset: [0, +(height / 2).toFixed(3), 0], maxSlope: 0.8 },
      };
      if (rig) {
        const mass = 70;
        out.ragdolls = [{ parts: RAGDOLL.filter(([part]) => rig.bones[part]).map(([part, parent, end, r, share, cone, twistMin, twistMax]) => ({
          name: part, joint: rig.bones[part], ...(parent ? { parent } : {}), ...(end && rig.bones[end] ? { to: rig.bones[end] } : { length: 0.22 }),
          radius: r, mass: +(mass * share).toFixed(2), ...(parent ? { limits: { cone, twist: [twistMin, twistMax] } } : {}),
        })) }];
      }
      return out;
    }
    if (colliders.length) return { shapes: [shapeOf((o) => colliders.includes(o))], bodies: [{ node: 0, shape: 0, motion: "static" }] };
    // Pieces (walls, floors, stairs) collide as their visible mesh; props as a convex hull.
    if (role === "piece") return { shapes: [{ type: "mesh" }], bodies: [{ node: 0, shape: 0, motion: "static" }] };
    return { shapes: [shapeOf((o) => o.visible)], bodies: [{ node: 0, shape: 0, motion: "static" }] };
  }

  return { importGLB };
}
