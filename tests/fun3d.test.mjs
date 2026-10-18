import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { createFun3d, stripEditing, unpackChunks } from "../site/runtime/kit/fun3d.js";

const fun3d = createFun3d({ THREE, encoder: MeshoptEncoder, decoder: MeshoptDecoder });
const close = (a, b, tolerance, message) => assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);

function sample() {
  const root = new THREE.Group();
  root.name = "crate_01_ROOT";
  const wood = new THREE.MeshStandardMaterial({ name: "mat_wood", color: "#c89969", roughness: 0.8 });
  const steel = new THREE.MeshStandardMaterial({ name: "mat_steel", color: "#8c9399", roughness: 0.35, metalness: 1 });
  const box = new THREE.BoxGeometry(1.2, 0.6, 0.8);
  box.translate(0, 0.3, 0);
  const crate = new THREE.Mesh(box, [wood, steel, wood, wood, steel, wood]);
  crate.name = "static";
  root.add(crate);
  const hinge = new THREE.Group();
  hinge.name = "lid_hinge";
  hinge.position.set(0, 0.6, -0.4);
  hinge.rotation.x = -0.3;
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.05, 0.8).translate(0, 0.025, 0.4), wood);
  lid.name = "lid";
  hinge.add(lid);
  root.add(hinge);
  const studs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.03, 6, 4), steel, 3);
  studs.name = "studs";
  for (let i = 0; i < 3; i++) studs.setMatrixAt(i, new THREE.Matrix4().makeTranslation(-0.4 + i * 0.4, 0.6, 0.41));
  root.add(studs);
  return root;
}

function rigged() {
  const root = new THREE.Group();
  root.name = "worm";
  const geometry = new THREE.CylinderGeometry(0.1, 0.1, 1, 8, 4);
  geometry.translate(0, 0.5, 0);
  const position = geometry.getAttribute("position"), joints = [], weights = [];
  for (let i = 0; i < position.count; i++) {
    const w = Math.min(1, Math.max(0, position.getY(i)));
    joints.push(0, 1, 0, 0);
    weights.push(1 - w, w, 0, 0);
  }
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(joints, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
  geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(new Float32Array(position.count * 3).fill(0.01), 3)];
  geometry.morphAttributes.position[0].name = "bulge";
  const base = new THREE.Bone(), tip = new THREE.Bone();
  base.name = "mixamorig:Hips";
  tip.name = "mixamorig:Spine";
  tip.position.y = 0.5;
  base.add(tip);
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ name: "mat_skin", color: "#e0b090", roughness: 0.6 }));
  mesh.name = "body";
  mesh.updateMorphTargets();
  root.add(base, mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([base, tip]));
  const clip = new THREE.AnimationClip("bend", 1, [
    new THREE.QuaternionKeyframeTrack(`${THREE.PropertyBinding.sanitizeNodeName(tip.name)}.quaternion`, [0, 0.5, 1], [0, 0, 0, 1, 0, 0, 0.3826834, 0.9238795, 0, 0, 0, 1]),
    new THREE.VectorKeyframeTrack(`${THREE.PropertyBinding.sanitizeNodeName(base.name)}.position`, [0, 0.25, 0.75], [0, 0, 0, 0, 0.1, 0, 0, 0, 0]),
    new THREE.NumberKeyframeTrack("body.morphTargetInfluences[0]", [0, 0.5, 1], [0, 1, 0]),
  ]);
  return { root, clip };
}

test("static parts, materials, instances and physics survive a round trip", async () => {
  const root = sample();
  root.updateMatrixWorld(true);
  const physics = { bodies: [{ node: "static", motion: "static", shape: 0 }], shapes: [{ type: "box", halfExtents: [0.6, 0.3, 0.4] }] };
  const bytes = await fun3d.write(root, { physics, edit: { format: "fun.dev/model", version: 1, project: { name: "crate" } } });
  const loaded = await fun3d.load(bytes);
  const scene = loaded.scene;
  assert.equal(scene.name, "crate_01_ROOT");
  // A quantized part keeps its node as the pivot and dequantizes in a child mesh.
  const hinge = scene.getObjectByName("lid_hinge");
  close(hinge.rotation.x, -0.3, 1e-6, "pivot rotation");
  const lid = scene.getObjectByName("lid"), lidMesh = lid.userData.fun3dMesh;
  assert.ok(lidMesh.geometry.getAttribute("position").array instanceof Int16Array);
  // World-space vertices match the original within the quantization step.
  scene.updateMatrixWorld(true);
  const original = sample(); original.updateMatrixWorld(true);
  const source = original.getObjectByName("lid"), src = source.geometry.getAttribute("position"), out = lidMesh.geometry.getAttribute("position");
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let i = 0; i < src.count; i++) {
    a.fromBufferAttribute(src, i).applyMatrix4(source.matrixWorld);
    b.fromBufferAttribute(out, i).applyMatrix4(lidMesh.matrixWorld);
    assert.ok(a.distanceTo(b) < 1e-4, `vertex ${i}: ${a.toArray()} vs ${b.toArray()}`);
  }
  // Multi-material groups and material parameters.
  const crate = scene.getObjectByName("static").userData.fun3dMesh;
  assert.equal(crate.material.length, 6);
  assert.deepEqual(crate.material.map((m) => m.name), ["mat_wood", "mat_steel", "mat_wood", "mat_wood", "mat_steel", "mat_wood"]);
  assert.equal(crate.material[0], crate.material[2], "one material object per file material");
  assert.equal(crate.material[1].name, "mat_steel");
  assert.equal(crate.material[1].metalness, 1);
  assert.equal(crate.material[1].color.getHexString(), "8c9399");
  // Instances dequantize through their matrices.
  const studs = scene.getObjectByName("studs");
  assert.equal(studs.count, 3);
  const m = new THREE.Matrix4(); studs.getMatrixAt(2, m);
  const center = new THREE.Vector3(0, 0, 0).applyMatrix4(m);
  close(center.x, 0.4, 1e-4, "instance x");
  // Physics names resolve to the loaded objects.
  assert.equal(loaded.physics.bodies[0].node, scene.getObjectByName("static"));
  // The editing section is read only on request and stripped for games.
  assert.equal(loaded.edit, null);
  assert.equal((await fun3d.load(bytes, { editing: true })).edit.project.name, "crate");
  const runtime = stripEditing(bytes);
  assert.ok(runtime.length < bytes.length);
  assert.deepEqual((await unpackChunks(runtime, { editing: true })).map((c) => c.type), ["JSON", "BIN "]);
  assert.equal((await fun3d.load(runtime)).scene.name, "crate_01_ROOT");
});

test("skins, morph targets and animation clips survive a round trip", async () => {
  const { root, clip } = rigged();
  const bytes = await fun3d.write(root, { animations: [clip], rig: "test" });
  const { scene, animations, manifest } = await fun3d.load(bytes);
  assert.equal(manifest.skins[0].rig, "test");
  const body = scene.getObjectByName("body");
  assert.ok(body.isSkinnedMesh);
  assert.deepEqual(body.skeleton.bones.map((bone) => bone.name), ["mixamorigHips", "mixamorigSpine"]);
  assert.ok(body.geometry.getAttribute("position").array instanceof Float32Array, "skinned meshes keep float positions");
  const weights = body.geometry.getAttribute("skinWeight");
  for (let i = 0; i < weights.count; i++) close(weights.getX(i) + weights.getY(i) + weights.getZ(i) + weights.getW(i), 1, 1e-6, "weights sum");
  assert.deepEqual(body.morphTargetDictionary, { bulge: 0 });
  assert.equal(animations[0].name, "bend");
  assert.deepEqual(animations[0].tracks.map((t) => t.name), clip.tracks.map((t) => t.name));
  for (const [i, track] of animations[0].tracks.entries()) {
    assert.deepEqual([...track.times], [...clip.tracks[i].times]);
    track.values.forEach((v, k) => close(v, clip.tracks[i].values[k], 1e-4, `${track.name} value ${k}`));
  }
  // The clip plays on the loaded skeleton by name.
  const mixer = new THREE.AnimationMixer(scene);
  mixer.clipAction(animations[0]).play();
  mixer.update(0.5);
  close(scene.getObjectByName("mixamorigSpine").quaternion.z, 0.3826834, 1e-4, "animated bone");
  close(body.morphTargetInfluences[0], 1, 1e-5, "animated morph");
});

test("files reject what they cannot be", async () => {
  await assert.rejects(fun3d.load(new Uint8Array(16)), /Not a .fun3d file/);
});
