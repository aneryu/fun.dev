// GLB → .fun3d through the library profile fundev-library@1 (docs/model-format.md §6): what the
// maintenance script does to every approved version. GLTFLoader reads the file; this module
// turns the library's conventions into explicit data and writes through kit/fun3d.js:
// - `static__<material>` nodes merge into one node `static`; `<pivot>__<material>` children
//   merge into their pivot; other mesh nodes merge their primitives;
// - flat faces weld and lose their normals (`groups[].flat`); unused texture coordinates go;
// - material names map to emitter roles (mat_signal* → signal, mat_window* → window, mat_lamp* →
//   lamp, mat_screen* → screen, mat_beacon* → beacon; on vehicles mat_light → headlight,
//   mat_light_red → taillight, mat_light_amber → indicator, elsewhere mat_light* → lamp);
//   mat_body gets tint; transmissive materials transmission;
// - physics by library type: props a switchable convex hull (collider* nodes when present),
//   pieces their mesh, vehicles a wheeled vehicle from wheel_* nodes (drive, brakes and centre of
//   mass by mass class), characters a capsule and a ragdoll from the rig's roles; mass from a
//   density table.
//
//   const importer = createImporter({ THREE, loader, fun3d });
//   const { bytes, manifest, report } = await importer.importGLB(glb, { type: "vehicle", name: "city_taxi_01", hash });

import { idFromName as idOf } from "./fun3d-schema.js";

export const PROFILE = "fundev-library@1";
// Emitter roles by material name. Vehicles (typed so, or with three or more wheel_* nodes) read
// mat_light* as their lights; on anything else those names are lamps.
const ROLES = [[/^mat_signal/, "signal"], [/^mat_window/, "window"], [/^mat_lamp/, "lamp"], [/^mat_screen/, "screen"], [/^mat_beacon/, "beacon"]];
const VEHICLE_ROLES = [[/^mat_light_red/, "taillight"], [/^mat_light_(?:amber|orange|yellow)/, "indicator"], [/^mat_light(?:$|_white|_front)/, "headlight"], [/^mat_light/, "lamp"]];
const OTHER_ROLES = [[/^mat_light/, "lamp"]];
const DENSITY = { prop: 300, vehicle: 100 };
// Humanoid rigs the library carries: role → bone name, so animation packs bind by role.
const RIGS = {
  mixamo: { test: (names) => names.has("mixamorig:Hips") || names.has("mixamorigHips"), prefix: (names) => (names.has("mixamorig:Hips") ? "mixamorig:" : "mixamorig"), roles: {
    hips: "Hips", spine: "Spine", chest: "Spine1", upperChest: "Spine2", neck: "Neck", head: "Head",
    leftShoulder: "LeftShoulder", leftUpperArm: "LeftArm", leftLowerArm: "LeftForeArm", leftHand: "LeftHand", leftUpperLeg: "LeftUpLeg", leftLowerLeg: "LeftLeg", leftFoot: "LeftFoot", leftToes: "LeftToeBase",
    rightShoulder: "RightShoulder", rightUpperArm: "RightArm", rightLowerArm: "RightForeArm", rightHand: "RightHand", rightUpperLeg: "RightUpLeg", rightLowerLeg: "RightLeg", rightFoot: "RightFoot", rightToes: "RightToeBase" } },
  ue: { test: (names) => names.has("pelvis") && names.has("spine_01") && names.has("thigh_l"), prefix: () => "", roles: {
    hips: "pelvis", spine: "spine_01", chest: "spine_02", upperChest: "spine_03", neck: "neck_01", head: "head",
    leftShoulder: "clavicle_l", leftUpperArm: "upperarm_l", leftLowerArm: "lowerarm_l", leftHand: "hand_l", leftUpperLeg: "thigh_l", leftLowerLeg: "calf_l", leftFoot: "foot_l", leftToes: "ball_l",
    rightShoulder: "clavicle_r", rightUpperArm: "upperarm_r", rightLowerArm: "lowerarm_r", rightHand: "hand_r", rightUpperLeg: "thigh_r", rightLowerLeg: "calf_r", rightFoot: "foot_r", rightToes: "ball_r" } },
};
// Ragdoll parts by role: part, parent part, the role its capsule reaches, radius, mass share, limits.
const RAGDOLL = [
  ["pelvis", null, "hips", "spine", 0.13, 0.16, null],
  ["spine", "pelvis", "spine", "chest", 0.13, 0.14, { normalCone: 0.35, planeCone: 0.35, twist: [-0.25, 0.25] }],
  ["chest", "spine", "chest", "neck", 0.15, 0.2, { normalCone: 0.35, planeCone: 0.35, twist: [-0.25, 0.25] }],
  ["head", "chest", "head", null, 0.1, 0.08, { normalCone: 0.6, planeCone: 0.6, twist: [-0.6, 0.6] }],
  ["upperarm_l", "chest", "leftUpperArm", "leftLowerArm", 0.05, 0.03, { normalCone: 1.4, planeCone: 1.4, twist: [-0.8, 0.8] }],
  ["lowerarm_l", "upperarm_l", "leftLowerArm", "leftHand", 0.04, 0.025, { normalCone: 1.2, planeCone: 1.2, twist: [-0.3, 0.3] }],
  ["upperarm_r", "chest", "rightUpperArm", "rightLowerArm", 0.05, 0.03, { normalCone: 1.4, planeCone: 1.4, twist: [-0.8, 0.8] }],
  ["lowerarm_r", "upperarm_r", "rightLowerArm", "rightHand", 0.04, 0.025, { normalCone: 1.2, planeCone: 1.2, twist: [-0.3, 0.3] }],
  ["thigh_l", "pelvis", "leftUpperLeg", "leftLowerLeg", 0.075, 0.1, { normalCone: 1.0, planeCone: 1.0, twist: [-0.4, 0.4] }],
  ["calf_l", "thigh_l", "leftLowerLeg", "leftFoot", 0.06, 0.05, { normalCone: 1.1, planeCone: 1.1, twist: [-0.1, 0.1] }],
  ["thigh_r", "pelvis", "rightUpperLeg", "rightLowerLeg", 0.075, 0.1, { normalCone: 1.0, planeCone: 1.0, twist: [-0.4, 0.4] }],
  ["calf_r", "thigh_r", "rightLowerLeg", "rightFoot", 0.06, 0.05, { normalCone: 1.1, planeCone: 1.1, twist: [-0.1, 0.1] }],
];
const round = (n, digits = 5) => Number(n.toFixed(digits));

export function createImporter({ THREE, loader, fun3d, encoder = null }) {
  const textured = (material) => ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "alphaMap"].some((k) => material[k]);

  // The encoded bytes of every texture, so files keep the original WebP/PNG/KTX2.
  async function captureTextureSources(gltf) {
    const { parser } = gltf, json = parser.json, sources = new Map();
    for (const [object, association] of parser.associations) {
      if (!object?.isTexture || association?.textures === undefined) continue;
      const def = json.textures[association.textures];
      const source = def.extensions?.EXT_texture_webp?.source ?? def.extensions?.KHR_texture_basisu?.source ?? def.extensions?.EXT_texture_avif?.source ?? def.source;
      const image = json.images[source];
      if (image?.bufferView === undefined) continue;
      if (!sources.has(object.source.uuid)) sources.set(object.source.uuid, { mime: image.mimeType, bytes: new Uint8Array((await parser.getDependency("bufferView", image.bufferView)).slice(0)) });
    }
    gltf.scene.traverse((o) => { if (!o.isMesh) return; for (const m of [o.material].flat()) for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "alphaMap"]) { const t = m[key]; if (t && sources.has(t.source.uuid)) t.userData.fun3dSource = sources.get(t.source.uuid); } });
  }

  // Library conventions → features.
  function describeMaterial(material, vehicle) {
    const name = material.name ?? "", features = {};
    const role = [...ROLES, ...(vehicle ? VEHICLE_ROLES : OTHER_ROLES)].find(([pattern]) => pattern.test(name))?.[1];
    if (role) {
      const glow = material.emissive && material.emissive.getHex() !== 0 ? material.emissive : material.color;
      features.emitter = { role, color: `#${glow.getHexString()}`, intensity: round(material.emissiveIntensity || 1, 4) };
    }
    if (/^mat_body\b/.test(name)) features.tint = {};
    material.userData.fun3d = { features };
    return role ?? null;
  }

  // One welded geometry from several meshes (each with its materials), in `space`: triangles
  // sorted by material slot (opaque first, blended last) and flatness, vertices shared where
  // position, slot, normal and texture coordinate agree. Flat triangles keep no normal.
  function mergeMeshes(meshes, space) {
    const inverse = new THREE.Matrix4().copy(space).invert();
    const slots = [], inputs = [];
    let triangles = 0;
    for (const mesh of meshes) {
      const g = mesh.geometry, materials = [mesh.material].flat();
      const groups = g.groups.length ? g.groups : [{ start: 0, count: g.index ? g.index.count : g.getAttribute("position").count, materialIndex: 0 }];
      for (const group of groups) {
        const material = materials[group.materialIndex ?? 0] ?? materials[0];
        let slot = slots.indexOf(material);
        if (slot < 0) { slot = slots.length; slots.push(material); }
        const count = Math.min(group.count, (g.index ? g.index.count : g.getAttribute("position").count) - group.start);
        inputs.push({ mesh, group: { start: group.start, count }, slot });
        triangles += count / 3;
      }
    }
    const keepUV = slots.some(textured) && meshes.every((m) => m.geometry.getAttribute("uv"));
    const p = new Float32Array(triangles * 9), nrm = new Float32Array(triangles * 9), uv = keepUV ? new Float32Array(triangles * 6) : null;
    const slot = new Uint16Array(triangles), flat = new Uint8Array(triangles);
    const v = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), face = new THREE.Vector3();
    let t = 0;
    for (const input of inputs) {
      const g = input.mesh.geometry, matrix = new THREE.Matrix4().multiplyMatrices(inverse, input.mesh.matrixWorld), normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
      const position = g.getAttribute("position"), normal = g.getAttribute("normal"), texcoord = g.getAttribute("uv"), index = g.index;
      for (let i = input.group.start; i < input.group.start + input.group.count; i += 3, t++) {
        for (let k = 0; k < 3; k++) {
          const vi = index ? index.getX(i + k) : i + k;
          v.fromBufferAttribute(position, vi).applyMatrix4(matrix);
          p[t * 9 + k * 3] = v.x; p[t * 9 + k * 3 + 1] = v.y; p[t * 9 + k * 3 + 2] = v.z;
          if (normal) { n.fromBufferAttribute(normal, vi).applyMatrix3(normalMatrix).normalize(); nrm[t * 9 + k * 3] = n.x; nrm[t * 9 + k * 3 + 1] = n.y; nrm[t * 9 + k * 3 + 2] = n.z; }
          if (uv) { uv[t * 6 + k * 2] = texcoord.getX(vi); uv[t * 6 + k * 2 + 1] = texcoord.getY(vi); }
        }
        slot[t] = input.slot;
        // A face is flat when its vertex normals equal its face normal.
        e1.set(p[t * 9 + 3] - p[t * 9], p[t * 9 + 4] - p[t * 9 + 1], p[t * 9 + 5] - p[t * 9 + 2]);
        e2.set(p[t * 9 + 6] - p[t * 9], p[t * 9 + 7] - p[t * 9 + 1], p[t * 9 + 8] - p[t * 9 + 2]);
        face.crossVectors(e1, e2);
        if (face.lengthSq() < 1e-20 || !normal) flat[t] = 1;
        else { face.normalize(); flat[t] = [0, 1, 2].every((k) => face.x * nrm[t * 9 + k * 3] + face.y * nrm[t * 9 + k * 3 + 1] + face.z * nrm[t * 9 + k * 3 + 2] > 0.999) ? 1 : 0; }
      }
    }
    const smooth = flat.some((f) => !f);
    const blended = (m) => (m.transparent && m.opacity < 1) || m.transmission > 0;
    const order = slots.map((_, i) => i).sort((a, b) => blended(slots[a]) - blended(slots[b]) || a - b), rank = new Map(order.map((s, i) => [s, i]));
    const sorted = Array.from({ length: triangles }, (_, i) => i).sort((a, b) => rank.get(slot[a]) - rank.get(slot[b]) || flat[a] - flat[b] || a - b);
    const keys = new Map(), positions = [], normals = [], uvs = [], indices = new Uint32Array(triangles * 3);
    const groups = [];
    let last = null;
    for (const [j, tri] of sorted.entries()) {
      const groupKey = `${rank.get(slot[tri])}|${flat[tri]}`;
      if (groupKey !== last) { groups.push({ start: j * 3, count: 0, materialIndex: rank.get(slot[tri]), flat: !!flat[tri] }); last = groupKey; }
      groups.at(-1).count += 3;
      for (let k = 0; k < 3; k++) {
        const o = tri * 9 + k * 3;
        const key = `${Math.round(p[o] * 1e5)},${Math.round(p[o + 1] * 1e5)},${Math.round(p[o + 2] * 1e5)}|${rank.get(slot[tri])}|${flat[tri] ? "f" : `${Math.round(nrm[o] * 1e3)},${Math.round(nrm[o + 1] * 1e3)},${Math.round(nrm[o + 2] * 1e3)}`}|${uv ? `${Math.round(uv[tri * 6 + k * 2] * 1e5)},${Math.round(uv[tri * 6 + k * 2 + 1] * 1e5)}` : ""}`;
        let index = keys.get(key);
        if (index === undefined) {
          index = positions.length / 3;
          keys.set(key, index);
          positions.push(p[o], p[o + 1], p[o + 2]);
          if (smooth) { if (flat[tri]) normals.push(0, 0, 0); else normals.push(nrm[o], nrm[o + 1], nrm[o + 2]); }
          if (uv) uvs.push(uv[tri * 6 + k * 2], uv[tri * 6 + k * 2 + 1]);
        }
        indices[j * 3 + k] = index;
      }
    }
    // Vertex cache and fetch order (meshopt), which also compresses better.
    let count = positions.length / 3, remap = null;
    if (encoder?.reorderMesh && indices.length) [remap, count] = encoder.reorderMesh(indices, true, true);
    const reorder = (source, size) => {
      const out = new Float32Array(count * size);
      for (let i = 0; i < source.length / size; i++) { const target = remap ? remap[i] : i; if (target !== 0xffffffff) for (let k = 0; k < size; k++) out[target * size + k] = source[i * size + k]; }
      return out;
    };
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(reorder(positions, 3), 3));
    // Every merged geometry carries a normal attribute (zero where flat) so batches share one layout.
    geometry.setAttribute("normal", new THREE.BufferAttribute(smooth ? reorder(normals, 3) : new Float32Array(count * 3), 3));
    if (uv) geometry.setAttribute("uv", new THREE.BufferAttribute(reorder(uvs, 2), 2));
    geometry.setIndex(new THREE.BufferAttribute(count > 65535 ? indices : Uint16Array.from(indices), 1));
    for (const group of groups) { geometry.addGroup(group.start, group.count, group.materialIndex); geometry.groups.at(-1).flat = group.flat; }
    return { geometry, materials: order.map((s) => slots[s]) };
  }

  function bounds(object, filter = () => true) {
    const box = new THREE.Box3(), inverse = new THREE.Matrix4().copy(object.matrixWorld).invert(), v = new THREE.Vector3();
    object.traverse((o) => {
      if (!o.isMesh || !filter(o)) return;
      const p = o.geometry.getAttribute("position"), m = new THREE.Matrix4().multiplyMatrices(inverse, o.matrixWorld);
      for (let i = 0; i < p.count; i++) box.expandByPoint(v.fromBufferAttribute(p, i).applyMatrix4(m));
    });
    return box;
  }
  // Hull points in the object's space: the extremes along many directions (a hull needs few).
  function hullPoints(object, filter = () => true, limit = 128) {
    const inverse = new THREE.Matrix4().copy(object.matrixWorld).invert(), v = new THREE.Vector3(), points = [];
    object.traverse((o) => {
      if (!o.isMesh || !filter(o)) return;
      const p = o.geometry.getAttribute("position"), m = new THREE.Matrix4().multiplyMatrices(inverse, o.matrixWorld);
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m); points.push([v.x, v.y, v.z]); }
    });
    if (!points.length) return [];
    const keep = new Set();
    for (let k = 0; k < limit; k++) {
      const phi = Math.acos(1 - (2 * (k + 0.5)) / limit), theta = Math.PI * (1 + Math.sqrt(5)) * k;
      const d = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      let best = 0, score = -Infinity;
      for (let i = 0; i < points.length; i++) { const s = points[i][0] * d[0] + points[i][1] * d[1] + points[i][2] * d[2]; if (s > score) { score = s; best = i; } }
      keep.add(best);
    }
    return [...keep].flatMap((i) => points[i].map((n) => round(n)));
  }

  /** The object tree a GLB becomes, normalized by the profile; `write` turns it into a file. */
  async function normalizeGLB(bytes, { type }) {
    if (encoder) await encoder.ready;
    const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const gltf = await loader.parseAsync(buffer, "");
    await captureTextureSources(gltf);
    const scene = gltf.scene, associations = gltf.parser.associations, warnings = [];
    const root = scene.children.length === 1 && !scene.children[0].isMesh ? scene.children[0] : scene;
    if (root !== scene) { scene.remove(root); root.position.set(0, 0, 0); root.quaternion.identity(); root.scale.set(1, 1, 1); }
    if (!root.name) root.name = "root";
    root.updateMatrixWorld(true);
    const skinned = [], bones = [], meshes = [];
    root.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); if (o.isBone) bones.push(o); if (o.isMesh) meshes.push(o); });
    const boneNames = new Set(bones.map((b) => b.name));
    const rigName = Object.keys(RIGS).find((name) => RIGS[name].test(boneNames)) ?? null;
    const kind = !meshes.length && gltf.animations.length ? "animations" : "model";
    let wheelPivots = 0;
    root.traverse((o) => { if (/^wheel_/.test(o.name) && !/^wheel_.*__/.test(o.name)) wheelPivots++; });
    const vehicleClass = type === "vehicle" || wheelPivots >= 3;
    const roles = new Map();
    for (const mesh of meshes) for (const material of [mesh.material].flat()) { const role = describeMaterial(material, vehicleClass); if (role) roles.set(material.name, role); }

    // GLTFLoader turns a glTF mesh with several primitives into a group of meshes; those are one
    // part, so their primitives merge back into one geometry.
    const primitives = (node) => node.isMesh ? [node]
      : node.isGroup && node.children.length && node.children.every((c) => c.isMesh && !c.children.length && associations.get(c)?.primitives !== undefined && associations.get(c).meshes === associations.get(node.children[0]).meshes) ? node.children : null;
    if (!skinned.length) {
      const statics = root.children.filter((c) => /^static__/.test(c.name) && primitives(c));
      if (statics.length) {
        const { geometry, materials } = mergeMeshes(statics.flatMap(primitives), root.matrixWorld);
        for (const s of statics) root.remove(s);
        const part = new THREE.Mesh(geometry, materials.length === 1 ? materials[0] : materials);
        part.name = "static";
        root.add(part);
      }
      // A part split by material (`wheel_front_left__mat_rubber` under `wheel_front_left`) becomes one mesh: the pivot itself.
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
        part.userData.merged = true;
      }
      // Every other mesh node: its primitives welded into one geometry, its children kept.
      const parts = [];
      root.traverse((o) => { if (o !== root && o.name !== "static" && !o.userData.merged && primitives(o) && !(o.isMesh && o.parent !== root && primitives(o.parent))) parts.push(o); });
      for (const node of parts) {
        const { geometry, materials } = mergeMeshes(primitives(node), node.matrixWorld);
        const material = materials.length === 1 ? materials[0] : materials;
        if (node.isMesh) { node.geometry = geometry; node.material = material; continue; }
        const part = new THREE.Mesh(geometry, material);
        part.name = node.name;
        part.position.copy(node.position); part.quaternion.copy(node.quaternion); part.scale.copy(node.scale);
        for (const child of [...node.children].filter((c) => !primitives(node).includes(c))) part.add(child);
        node.parent.add(part);
        node.parent.remove(node);
      }
      root.traverse((o) => { delete o.userData.merged; if (/^collider/.test(o.name)) { o.visible = false; o.userData.tags = ["collider"]; } });
    } else {
      for (const mesh of skinned) if (![mesh.material].flat().some(textured)) mesh.geometry.deleteAttribute("uv");
      for (const mesh of skinned) { mesh.geometry.deleteAttribute("uv1"); mesh.geometry.deleteAttribute("uv2"); }
    }
    root.updateMatrixWorld(true);
    // Names without a stable id (empty) get one from their place.
    let unnamed = 0;
    root.traverse((o) => { if (!o.name && o.parent?.userData.mesh !== o) o.name = `node_${unnamed++}`; });
    const wheels = [];
    root.traverse((o) => { if (/^wheel_/.test(o.name) && !wheels.some((w) => w === o || w.getObjectById(o.id))) wheels.push(o); });
    const effectiveType = kind === "animations" ? "animations" : type === "vehicle" && !wheels.length ? "prop" : skinned.length && type !== "character" ? "character" : type;
    if (effectiveType !== type) warnings.push(`typed ${type}, converted as ${effectiveType}`);
    const rig = rigName && (skinned.length || kind === "animations") ? await rigOf(rigName, bones, root) : null;
    if (rig) for (const mesh of skinned) mesh.userData.fun3d = { ...mesh.userData.fun3d, rig, skeleton: "rig" };
    const physics = kind === "animations" ? null : await derivePhysics(root, effectiveType, { wheels, rig });
    return { root, animations: gltf.animations, physics, kind, type: effectiveType, rig, roles, warnings, wheels: wheels.map((w) => w.name) };
  }

  async function rigOf(name, bones, root) {
    const spec = RIGS[name], names = new Set(bones.map((b) => b.name)), prefix = spec.prefix(names);
    const roles = {};
    for (const [role, bone] of Object.entries(spec.roles)) if (names.has(prefix + bone)) roles[role] = await idOf(prefix + bone);
    const box = bounds(root);
    return { name, version: 1, rest: "T", height: round(Math.max(0.01, box.max.y - box.min.y), 3), roles };
  }

  async function derivePhysics(root, type, { wheels, rig }) {
    const colliders = [];
    root.traverse((o) => { if (o.isMesh && o.userData.tags?.includes("collider")) colliders.push(o); });
    const rootId = await idOf(root.name);
    const box = bounds(root, (o) => o.visible || colliders.includes(o)), size = box.getSize(new THREE.Vector3());
    const volume = Math.max(1e-6, size.x * size.y * size.z);
    if (type === "vehicle") {
      const inWheel = (o) => wheels.some((w) => w === o || w.getObjectById(o.id));
      const body = bounds(root, (o) => !inWheel(o) && o.visible), bodySize = body.getSize(new THREE.Vector3());
      const mass = Math.round(Math.max(50, bodySize.x * bodySize.y * bodySize.z * DENSITY.vehicle));
      const wheelDefs = [];
      for (const wheel of wheels) {
        const wbox = bounds(wheel), wsize = wbox.getSize(new THREE.Vector3());
        const centre = wheel.getWorldPosition(new THREE.Vector3());
        root.worldToLocal(centre);
        wheelDefs.push({ id: await idOf(wheel.name), node: await idOf(wheel.name), radius: round(Math.max(0.05, Math.max(wsize.y, wsize.z) / 2), 4), width: round(Math.max(0.05, wsize.x), 4),
          suspension: { min: 0.05, max: 0.25, rest: 0.15, frequency: 1.6, damping: 0.5 }, _x: centre.x, _z: centre.z });
      }
      // Brakes stop the vehicle at about 1 g whatever its mass; front wheels steer, rear ones hold the handbrake.
      for (const w of wheelDefs) {
        const brake = Math.max(1500, Math.round((mass * 9.81 * w.radius) / wheelDefs.length / 10) * 10);
        Object.assign(w, w._z > 0 ? { steer: 0.6, brake } : { brake, handbrake: Math.max(4000, brake) });
      }
      // Axles: wheels within 0.2 m along the length, front first; each drives through its outermost pair.
      const axles = [];
      for (const w of [...wheelDefs].sort((a, b) => b._z - a._z)) {
        const axle = axles.find((a) => Math.abs(a.z - w._z) < 0.2);
        if (axle) axle.wheels.push(w); else axles.push({ z: w._z, wheels: [w] });
      }
      const pairOf = (axle) => {
        const left = axle.wheels.filter((w) => w._x > 0).sort((a, b) => b._x - a._x)[0], right = axle.wheels.filter((w) => w._x <= 0).sort((a, b) => a._x - b._x)[0];
        return left && right ? [left.id, right.id] : null;
      };
      // Light vehicles drive the front axle; heavy ones (3 t and up, or more than four wheels) every axle behind it.
      const heavy = mass >= 3000 || wheelDefs.length > 4;
      let pairs = (heavy ? axles.filter((a) => a.z <= 0) : axles.filter((a) => a.z > 0).slice(0, 1)).map(pairOf).filter(Boolean);
      if (!pairs.length) pairs = axles.map(pairOf).filter(Boolean).slice(0, 1);
      const differentials = pairs.map((pair) => ({ wheels: pair, ratio: 3.42, split: 0.5, engineShare: round(1 / pairs.length, 4), limitedSlip: 1.4 }));
      for (const w of wheelDefs) { delete w._x; delete w._z; }
      return {
        shapes: [{ id: "hull", type: "convex", points: hullPoints(root, (o) => !inWheel(o) && o.visible) }],
        // The centre of mass sits a quarter of the body's height below the hull's: engines, frames and floors are low.
        bodies: [{ id: "chassis", node: rootId, shape: "hull", motion: "dynamic", layer: "moving", mass, centerOfMass: [0, round(-0.25 * bodySize.y, 3), 0], friction: 0.5, restitution: 0.1, damping: { linear: 0.05, angular: 0.05 } }],
        vehicles: [{ id: "car", type: "wheeled", body: "chassis", wheels: wheelDefs, engine: { maxTorque: Math.round(mass * 0.25), minRPM: 1000, maxRPM: 6000 }, transmission: { gears: [2.66, 1.78, 1.3, 1.0, 0.74], reverse: [-2.9] }, differentials, antiRoll: [] }],
      };
    }
    if (type === "character") {
      const height = Math.max(0.5, size.y), radius = round(Math.min(0.35, Math.max(0.15, size.x / 4)), 3);
      const out = {
        shapes: [{ id: "pill", type: "capsule", radius, halfHeight: round(Math.max(0.05, height / 2 - radius), 3) }],
        characters: [{ id: "walker", node: rootId, shape: "pill", offset: [0, round(height / 2, 3), 0], mass: 70, maxSlope: 0.8, stepHeight: 0.3 }],
      };
      if (rig) {
        const parts = RAGDOLL.filter(([, , role]) => rig.roles[role]).map(([id, parent, role, to, radius, share, limits]) => ({
          id, bone: `role:${role}`, ...(parent && rig.roles[RAGDOLL.find(([p]) => p === parent)[2]] ? { parent } : {}), ...(to && rig.roles[to] ? { to: `role:${to}` } : { length: 0.22 }), radius, mass: round(70 * share, 2), ...(limits ? { limits } : {}),
        }));
        if (parts.length) out.ragdolls = [{ id: "doll", skeleton: "rig", parts }];
      }
      return out;
    }
    if (type === "piece") {
      const staticNode = root.getObjectByName("static") ?? root.children.find((c) => c.isMesh);
      if (staticNode) return { shapes: [{ id: "walls", type: "mesh", geometry: await idOf(staticNode.geometry.name || staticNode.name) }], bodies: [{ id: "piece", node: await idOf(staticNode.name), shape: "walls", motion: "static" }] };
    }
    const points = hullPoints(root, colliders.length ? (o) => colliders.includes(o) : (o) => o.visible);
    if (points.length < 12) return null;
    return { shapes: [{ id: "hull", type: "convex", points }], bodies: [{ id: "body", node: rootId, shape: "hull", motion: "static", switchable: true, mass: Math.round(Math.max(1, volume * DENSITY.prop)) }] };
  }

  /** The .fun3d bytes of a GLB, with its manifest and a report of what the profile derived. */
  async function importGLB(bytes, { type = "prop", name = null, hash = null, converter = null, edit = null } = {}) {
    const normalized = await normalizeGLB(bytes, { type });
    const { root, animations, physics, kind, rig, roles, warnings } = normalized;
    const asset = { name: name ?? root.name, source: { kind: "glb", ...(hash ? { hash } : {}), ...(converter ? { converter } : {}), profile: PROFILE, type: normalized.type, tool: null } };
    const file = await fun3d.write(root, { kind, asset, animations, physics, rig, edit });
    const { manifest } = await fun3d.read(file);
    const report = {
      type: normalized.type, kind, rig: rig?.name ?? null, warnings,
      nodes: manifest.nodes.length, geometries: manifest.geometries.length, materials: manifest.materials.length, vertices: manifest.geometries.reduce((n, g) => n + g.vertices, 0),
      triangles: manifest.geometries.reduce((n, g) => n + manifest.streams.find((s) => s.id === g.index.stream).count / 3, 0),
      roles: Object.fromEntries(roles), wheels: normalized.wheels, hull: physics?.shapes?.find((s) => s.type === "convex")?.points.length / 3 || 0,
      mass: physics?.bodies?.[0]?.mass ?? null, bytes: file.length,
    };
    return { bytes: file, manifest, report };
  }

  return { importGLB, normalizeGLB, mergeMeshes };
}
