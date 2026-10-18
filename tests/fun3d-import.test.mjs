import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { createFun3d } from "../site/runtime/kit/fun3d.js";
import { createImporter, PROFILE } from "../site/runtime/kit/fun3d-import.js";
import { boxGLB } from "./helpers/models.mjs";

const fun3d = createFun3d({ THREE, encoder: MeshoptEncoder, decoder: MeshoptDecoder });
const importer = createImporter({ THREE, loader: new GLTFLoader(), fun3d, encoder: MeshoptEncoder });

// A library-style car: <id>_ROOT with static__ parts, pivot__material wheels and emitters.
function carGLB() {
  const base = boxGLB({ size: [1, 1, 1] });
  const length = new DataView(base.buffer).getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(base.subarray(20, 20 + length)));
  const mesh = (material) => ({ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material }] });
  const extra = {
    materials: [{ name: "mat_body", pbrMetallicRoughness: { baseColorFactor: [0.9, 0.7, 0.1, 1] } }, { name: "mat_light", pbrMetallicRoughness: { baseColorFactor: [1, 0.95, 0.8, 1] } }, { name: "mat_rubber", pbrMetallicRoughness: { baseColorFactor: [0.1, 0.1, 0.1, 1] } }, { name: "mat_glass", pbrMetallicRoughness: { baseColorFactor: [0.6, 0.8, 1, 0.3] }, alphaMode: "BLEND" }, { name: "mat_light_amber", pbrMetallicRoughness: { baseColorFactor: [0.8, 0.4, 0.1, 1] } }],
    meshes: [mesh(0), mesh(1), mesh(2), mesh(3), mesh(4)],
    nodes: [
      { name: "city_taxi_01_ROOT", children: [1, 2, 3, 4, 5, 7] },
      { name: "static__mat_body", mesh: 0, scale: [1.8, 0.6, 4.2], translation: [0, 0.4, 0] },
      { name: "static__mat_light", mesh: 1, scale: [0.2, 0.1, 0.05], translation: [0.6, 0.6, 2.1] },
      { name: "static__mat_glass", mesh: 3, scale: [1.6, 0.4, 1.2], translation: [0, 1.0, 0] },
      { name: "static__mat_light_amber", mesh: 4, scale: [0.1, 0.05, 0.05], translation: [0.85, 0.6, 2.1] },
      { name: "wheel_front_left", translation: [0.9, 0.33, 1.3], children: [6] },
      { name: "wheel_front_left__mat_rubber", mesh: 2, scale: [0.2, 0.66, 0.66], translation: [0, -0.33, 0] },
      { name: "wheel_rear_right", translation: [-0.9, 0.33, -1.3], children: [8] },
      { name: "wheel_rear_right__mat_rubber", mesh: 2, scale: [0.2, 0.66, 0.66], translation: [0, -0.33, 0] },
    ],
    scenes: [{ nodes: [0] }],
  };
  return boxGLB({ size: [1, 1, 1], extra: { ...extra, accessors: gltf.accessors, bufferViews: gltf.bufferViews } });
}

test("a library vehicle converts through the profile: merged parts, roles, tint and a wheeled vehicle", async () => {
  const { bytes, manifest, report } = await importer.importGLB(carGLB(), { type: "vehicle", name: "city_taxi_01", hash: "sha256:0" });
  assert.deepEqual(await fun3d.validate(bytes), []);
  assert.equal(manifest.asset.source.profile, PROFILE);
  assert.equal(manifest.asset.source.type, "vehicle");
  assert.deepEqual(manifest.nodes.map((n) => n.id), ["city_taxi_01_ROOT", "static", "wheel_front_left", "wheel_rear_right"]);
  const statics = manifest.nodes.find((n) => n.id === "static");
  assert.deepEqual(statics.mesh.materials, ["mat_body", "mat_light", "mat_light_amber", "mat_glass"], "opaque slots first, blended last");
  const geometry = manifest.geometries.find((g) => g.id === statics.mesh.geometry);
  assert.ok(geometry.groups.every((g) => g.flat), "box faces are flat");
  assert.equal(geometry.vertices, 32, "flat boxes weld to 8 vertices per material");
  assert.ok(geometry.buffers.some((b) => b.attributes.normal), "merged geometries keep a normal attribute for the batch layout");
  const materials = Object.fromEntries(manifest.materials.map((m) => [m.id, m]));
  assert.deepEqual(materials.mat_light.features.emitter, { role: "headlight", color: "#fff9e7", intensity: 1 }, "colours are sRGB hex");
  assert.equal(materials.mat_light_amber.features.emitter.role, "indicator");
  assert.deepEqual(materials.mat_body.features, { tint: {} });
  assert.equal(materials.mat_glass.alpha.mode, "blend");
  const wheel = manifest.nodes.find((n) => n.id === "wheel_front_left");
  assert.deepEqual(wheel.transform.position, [0.9, 0.33, 1.3]);
  assert.equal(wheel.mesh.materials[0], "mat_rubber");
  const vehicle = manifest.physics.vehicles[0];
  assert.equal(manifest.physics.bodies[0].motion, "dynamic");
  assert.deepEqual(vehicle.wheels.map((w) => [w.id, w.steer ?? 0, w.handbrake ?? 0]), [["wheel_front_left", 0.6, 0], ["wheel_rear_right", 0, 4000]]);
  assert.ok(Math.abs(vehicle.wheels[0].radius - 0.33) < 0.01, `wheel radius ${vehicle.wheels[0].radius}`);
  assert.equal(report.type, "vehicle");
  assert.deepEqual(report.roles, { mat_light: "headlight", mat_light_amber: "indicator" });
  assert.ok(report.hull >= 8 && report.mass > 50, `hull ${report.hull}, mass ${report.mass}`);
  const model = await fun3d.load(bytes);
  assert.ok(model.node("wheel_front_left").userData.mesh.isMesh);
  assert.deepEqual(model.warnings, []);
});

// A skinned box on a Mixamo-named skeleton in the scene, as the library's characters are.
function riggedGLB() {
  const joints = { Hips: [null, [0, 1, 0]], Spine: ["Hips", [0, 0.1, 0]], Spine1: ["Spine", [0, 0.1, 0]], Spine2: ["Spine1", [0, 0.1, 0]], Neck: ["Spine2", [0, 0.2, 0]], Head: ["Neck", [0, 0.1, 0]] };
  for (const [side, sign] of [["Left", 1], ["Right", -1]]) {
    Object.assign(joints, { [`${side}Shoulder`]: ["Spine2", [sign * 0.05, 0.15, 0]], [`${side}Arm`]: [`${side}Shoulder`, [sign * 0.13, 0, 0]], [`${side}ForeArm`]: [`${side}Arm`, [sign * 0.27, 0, 0]], [`${side}Hand`]: [`${side}ForeArm`, [sign * 0.25, 0, 0]],
      [`${side}UpLeg`]: ["Hips", [sign * 0.1, -0.05, 0]], [`${side}Leg`]: [`${side}UpLeg`, [0, -0.45, 0]], [`${side}Foot`]: [`${side}Leg`, [0, -0.42, 0]], [`${side}ToeBase`]: [`${side}Foot`, [0, -0.06, 0.1]] });
  }
  const names = Object.keys(joints), index = (name) => 2 + names.indexOf(name);
  const nodes = [{ name: "commuter_01_ROOT", children: [1, index("Hips")] }, { name: "body", mesh: 0, skin: 0 }, ...names.map((name) => ({ name: `mixamorig:${name}`, translation: joints[name][1], children: names.filter((c) => joints[c][0] === name).map(index) }))];
  nodes.forEach((n) => { if (n.children && !n.children.length) delete n.children; });
  const positions = new Float32Array([-0.25, 0, -0.15, 0.25, 0, -0.15, 0.25, 0, 0.15, -0.25, 0, 0.15, -0.25, 1.7, -0.15, 0.25, 1.7, -0.15, 0.25, 1.7, 0.15, -0.25, 1.7, 0.15]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
  const skinIndex = new Uint8Array(8 * 4), skinWeight = new Float32Array(8 * 4);
  for (let i = 0; i < 8; i++) { skinIndex[i * 4] = i < 4 ? names.indexOf("LeftFoot") : names.indexOf("Head"); skinWeight[i * 4] = 1; }
  const binds = new Float32Array(names.length * 16);
  for (let j = 0; j < names.length; j++) binds.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], j * 16);
  const parts = [positions, indices, skinIndex, skinWeight, binds].map((a) => new Uint8Array(a.buffer));
  const views = [], binary = new Uint8Array(parts.reduce((n, p) => n + Math.ceil(p.length / 4) * 4, 0));
  let offset = 0;
  for (const p of parts) { views.push({ buffer: 0, byteOffset: offset, byteLength: p.length }); binary.set(p, offset); offset += Math.ceil(p.length / 4) * 4; }
  const gltf = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3 }, indices: 1, material: 0 }] }],
    materials: [{ name: "mat_skin", pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.5, 1] } }],
    skins: [{ joints: names.map(index), inverseBindMatrices: 4 }],
    animations: [{ name: "pose_display", channels: [], samplers: [] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-0.25, 0, -0.15], max: [0.25, 1.7, 0.15] },
      { bufferView: 1, componentType: 5123, count: 36, type: "SCALAR" },
      { bufferView: 2, componentType: 5121, count: 8, type: "VEC4" },
      { bufferView: 3, componentType: 5126, count: 8, type: "VEC4" },
      { bufferView: 4, componentType: 5126, count: names.length, type: "MAT4" },
    ],
    bufferViews: views, buffers: [{ byteLength: binary.length }],
  };
  let text = JSON.stringify(gltf);
  while (text.length % 4) text += " ";
  const json = new TextEncoder().encode(text), out = new Uint8Array(28 + json.length + binary.length), view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, out.length, true);
  view.setUint32(12, json.length, true); view.setUint32(16, 0x4e4f534a, true); out.set(json, 20);
  view.setUint32(20 + json.length, binary.length, true); view.setUint32(24 + json.length, 0x004e4942, true); out.set(binary, 28 + json.length);
  return out;
}

test("a character converts with its rig roles, capsule and ragdoll; a prop gets a switchable hull", async () => {
  const { bytes, manifest, report } = await importer.importGLB(riggedGLB(), { type: "character", name: "commuter_01" });
  assert.deepEqual(await fun3d.validate(bytes), []);
  assert.equal(report.rig, "mixamo");
  const skeleton = manifest.skeletons[0];
  assert.equal(skeleton.rig.name, "mixamo");
  assert.ok(skeleton.rig.roles.hips && skeleton.bones.includes(skeleton.rig.roles.hips));
  assert.ok(skeleton.rig.roles.leftFoot, "the limb chain maps");
  assert.equal(manifest.physics.characters[0].shape, "pill");
  assert.ok(manifest.physics.ragdolls[0].parts.length >= 10);
  assert.equal(manifest.animations.length, 1, "pose_display is kept as a clip");
  const model = await fun3d.load(bytes);
  assert.ok(model.node("body").isSkinnedMesh);
  assert.equal(model.node("body").skeleton.bones.length, 22);
  assert.ok(model.warnings.some((w) => /ragdolls|characters/.test(w)) === false, "the loader leaves physics warnings to kit/physics.js");
  // Light names on things that are not vehicles are lamps, not headlights.
  const shopfront = await importer.importGLB(boxGLB({ size: [1, 2, 1], extra: { materials: [{ name: "mat_light_red" }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }] } }), { type: "prop", name: "shopfront" });
  assert.equal(shopfront.manifest.materials[0].features.emitter.role, "lamp");
  // A lamp-role emitter gets a spot shining down from it, sized by its height, as intent for light slots.
  const lamp = await importer.importGLB(boxGLB({ size: [0.4, 0.2, 0.4], lift: 6, extra: { materials: [{ name: "mat_lamp" }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }] } }), { type: "prop", name: "lamp_head" });
  assert.deepEqual(await fun3d.validate(lamp.bytes), []);
  const light = lamp.manifest.nodes.find((n) => n.light);
  assert.ok(light, "a light node");
  assert.equal(light.light.type, "spot");
  assert.ok(light.light.intensity > 75 && light.light.intensity < 130, `about 2.5 cd per square metre of height: ${light.light.intensity}`);
  assert.deepEqual(light.transform.rotation.map((v) => Math.round(v * 1000) / 1000), [-0.707, 0, 0, 0.707], "turned to shine down");
  const loaded = await fun3d.load(lamp.bytes);
  assert.equal(loaded.lights.length, 1);
  assert.equal(loaded.lights[0].node, light.id);
  assert.deepEqual(loaded.warnings, [], "lights are data, not ignored");
  const prop = await importer.importGLB(boxGLB({ size: [1, 2, 1] }), { type: "prop", name: "crate" });
  assert.deepEqual(await fun3d.validate(prop.bytes), []);
  assert.equal(prop.manifest.physics.bodies[0].switchable, true);
  assert.equal(prop.manifest.physics.bodies[0].mass, 600, "300 kg/m³ of the bounding box");
  assert.equal(prop.manifest.nodes[0].id, "root");
});
