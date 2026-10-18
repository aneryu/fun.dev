import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { createFun3d, stripEditing, unpackChunks } from "../site/runtime/kit/fun3d.js";
import { DEFLATE, EDITING, SIGNATURE, packChunks, scanChunks } from "../site/runtime/kit/fun3d-container.js";
import { idFromName, validateManifest } from "../site/runtime/kit/fun3d-schema.js";

const fun3d = createFun3d({ THREE, encoder: MeshoptEncoder, decoder: MeshoptDecoder });
const close = (a, b, tolerance, message) => assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);
const text = (s) => new TextEncoder().encode(s);

function crate() {
  const root = new THREE.Group();
  root.name = "crate_01";
  const wood = new THREE.MeshStandardMaterial({ name: "mat_wood", color: "#c89969", roughness: 0.8 });
  const steel = new THREE.MeshStandardMaterial({ name: "mat_steel", color: "#8c9399", roughness: 0.35, metalness: 1 });
  const lamp = new THREE.MeshStandardMaterial({ name: "mat_light", color: "#fff0c8", emissive: "#fff0c8", emissiveIntensity: 3 });
  lamp.userData.fun3d = { features: { emitter: { role: "headlight", color: "#fff0c8", intensity: 3 } } };
  const box = new THREE.BoxGeometry(1.2, 0.6, 0.8);
  box.translate(0, 0.3, 0);
  const body = new THREE.Mesh(box, [wood, steel, wood, wood, steel, wood]);
  body.name = "static";
  root.add(body);
  const hinge = new THREE.Group();
  hinge.name = "lid_hinge";
  hinge.position.set(0, 0.6, -0.4);
  hinge.rotation.x = -0.3;
  hinge.userData.sockets = { handle: { position: [0, 0.05, 0.8], rotation: [0, 0, 0, 1] } };
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.05, 0.8).translate(0, 0.025, 0.4), wood);
  lid.name = "lid";
  lid.userData.tags = ["lid"];
  hinge.add(lid);
  root.add(hinge);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), lamp);
  bulb.name = "bulb";
  bulb.position.set(0, 0.7, 0);
  root.add(bulb);
  const studs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.03, 6, 4), steel, 3);
  studs.name = "studs";
  for (let i = 0; i < 3; i++) studs.setMatrixAt(i, new THREE.Matrix4().makeTranslation(-0.4 + i * 0.4, 0.6, 0.41));
  studs.setColorAt(0, new THREE.Color(1, 0, 0));
  studs.setColorAt(1, new THREE.Color(0, 1, 0));
  studs.setColorAt(2, new THREE.Color(0, 0, 1));
  root.add(studs);
  return root;
}

function worm() {
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
  const bulge = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) if (position.getY(i) > 0.4 && position.getY(i) < 0.6) { bulge[i * 3] = position.getX(i) * 0.5; bulge[i * 3 + 2] = position.getZ(i) * 0.5; }
  geometry.morphAttributes.position = [new THREE.BufferAttribute(bulge, 3)];
  geometry.morphAttributes.position[0].name = "bulge";
  geometry.morphTargetsRelative = true;
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
  clip.userData = { loop: "once", events: [{ time: 0.5, name: "peak" }] };
  return { root, clip };
}

test("the container packs, scans, strips and refuses malformed layouts", async () => {
  const bytes = await packChunks([
    { type: "JSON", bytes: text('{"a":1}'), deflate: true },
    { type: "BIN ", bytes: new Uint8Array([1, 2, 3, 4, 5]), deflate: false },
    { type: "EDIT", bytes: text('{"tool":"x"}'), deflate: true, editing: true },
    { type: "BIN ", bytes: new Uint8Array(8), deflate: true, editing: true },
  ]);
  assert.deepEqual([...bytes.subarray(0, 8)], [...SIGNATURE]);
  const { chunks } = scanChunks(bytes);
  assert.deepEqual(chunks.map((c) => [c.type, c.editing, c.rawLength]), [["JSON", false, 7], ["BIN ", false, 5], ["EDIT", true, 12], ["BIN ", true, 8]]);
  assert.ok(chunks.every((c) => c.start % 4 === 0 && c.end % 4 === 0), "chunks are 4-byte aligned");
  const runtime = stripEditing(bytes);
  assert.deepEqual((await unpackChunks(runtime, { editing: true })).map((c) => [c.type, new TextDecoder().decode(c.bytes)]), [["JSON", '{"a":1}'], ["BIN ", "\x01\x02\x03\x04\x05"]]);
  assert.equal((await unpackChunks(bytes)).length, 2, "editing chunks are skipped unless asked for");
  // Reserved flag bits, lying raw lengths, editing before runtime chunks, JSON not first.
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const corrupt = (offset, value) => { const copy = bytes.slice(); new DataView(copy.buffer).setUint32(offset, value, true); return copy; };
  assert.throws(() => scanChunks(corrupt(8 + 4, DEFLATE | 4)), /reserved flag/);
  await assert.rejects(unpackChunks(corrupt(8 + 12, 99)), /inflated to/);
  assert.throws(() => scanChunks(corrupt(chunks[3].start + 4, DEFLATE)), /Runtime chunks follow an editing chunk/);
  assert.throws(() => scanChunks(new Uint8Array([...SIGNATURE, ...bytes.subarray(chunks[1].start, chunks[1].end)])), /starts with its JSON chunk/);
  assert.throws(() => scanChunks(bytes.subarray(0, 30)), /runs past the end/);
  assert.equal(view.getUint32(8, true), 0x4e4f534a, "JSON type code");
});

test("the schema validator catches structural problems and the id rule holds", async () => {
  const manifest = {
    fun3d: "1.0", kind: "model", asset: { name: "x" },
    streams: [{ id: "s0", chunk: 0, offset: 0, length: 24, count: 3, stride: 8 }, { id: "s1", chunk: 0, offset: 24, length: 6, count: 3, stride: 2 }],
    nodes: [{ id: "root" }, { id: "part", parent: "root", mesh: { geometry: "g", materials: ["m"] } }],
    geometries: [{ id: "g", vertices: 3, buffers: [{ stream: "s0", attributes: { position: { format: "snorm16x4", offset: 0 } } }], decode: { position: { offset: [0, 0, 0], scale: 1 } }, index: { stream: "s1", format: "uint16" }, groups: [{ start: 0, count: 3, material: 0 }], bounds: { min: [0, 0, 0], max: [1, 1, 1] } }],
    materials: [{ id: "m" }],
  };
  assert.deepEqual(validateManifest(manifest, { chunks: 1 }), []);
  const broken = (change) => { const copy = structuredClone(manifest); change(copy); return validateManifest(copy, { chunks: 1 }); };
  assert.match(broken((m) => { m.nodes[1].parent = "nobody"; })[0], /comes before its parent/);
  assert.match(broken((m) => { m.nodes[1].mesh.materials = ["m", "m"]; })[0], /2 entries for 1 group slots/);
  assert.match(broken((m) => { m.geometries[0].groups[0].count = 4; })[0], /not a multiple of 3/);
  assert.match(broken((m) => { m.streams[0].chunk = 3; })[0], /names BIN chunk 3/);
  assert.match(broken((m) => { m.nodes[1].mesh.materials = ["ghost"]; })[0], /unknown material "ghost"/);
  assert.match(broken((m) => { m.nodes.push({ id: "part", parent: "root" }); })[0], /repeats id "part"/);
  assert.match(broken((m) => { m.fun3d = "2.0"; })[0], /newer than this runtime/);
  assert.match(broken((m) => { m.requires = ["fun3d.magic"]; })[0], /uses does not/);
  assert.match(broken((m) => { m.nodes[1].light = { type: "point", intensity: 1 }; })[0], /both a mesh and a light/);
  assert.match(broken((m) => { m.materials[0].features = { "x.game.glow": {} }; })[0], /not listed in uses/);
  assert.equal(await idFromName("wheel_front_left"), "wheel_front_left");
  assert.match(await idFromName("mat body (red)"), /^mat_body_red-[0-9a-f]{6}$/);
  assert.match(await idFromName("机身"), /^node-[0-9a-f]{6}$/);
});

test("static parts, materials, placements, sockets and physics survive a round trip", async () => {
  const root = crate();
  root.updateMatrixWorld(true);
  const physics = {
    shapes: [{ id: "box", type: "box", halfExtents: [0.6, 0.3, 0.4] }, { id: "hull", type: "convex", points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }],
    bodies: [{ id: "crate", node: "static", shape: "box", motion: "dynamic", mass: 25 }, { id: "lid", node: "lid", shape: "hull", motion: "static" }],
  };
  const asset = { name: "crate_01", source: { kind: "glb", hash: "sha256:abc", converter: "sha256:def", profile: "fundev-library@1", type: "prop" } };
  const bytes = await fun3d.write(root, { physics, asset, edit: { tool: "fun.dev/workshop", version: 3, document: { name: "crate" } } });
  assert.deepEqual(await fun3d.validate(bytes), []);
  assert.deepEqual(await fun3d.write(root, { physics, asset }), stripEditing(bytes), "writing is deterministic and the runtime file is the file without its editing chunk");
  const model = await fun3d.load(bytes);
  assert.equal(model.root.name, "crate_01");
  assert.equal(model.asset.source.type, "prop");
  assert.deepEqual(model.warnings, []);
  // A rigid part keeps its node as the pivot and dequantizes in an unnamed child mesh.
  const hinge = model.node("lid_hinge");
  close(hinge.rotation.x, -0.3, 1e-6, "pivot rotation");
  assert.deepEqual(hinge.userData.sockets.handle.position, [0, 0.05, 0.8]);
  const lid = model.node("lid"), lidMesh = lid.userData.mesh;
  assert.equal(lidMesh.name, "");
  assert.deepEqual(lid.userData.tags, ["lid"]);
  assert.ok(lidMesh.geometry.getAttribute("position").array instanceof Int16Array);
  assert.ok(lidMesh.geometry.getAttribute("normal").array instanceof Int8Array);
  model.root.updateMatrixWorld(true);
  const original = crate();
  original.updateMatrixWorld(true);
  const source = original.getObjectByName("lid"), src = source.geometry.getAttribute("position"), out = lidMesh.geometry.getAttribute("position");
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let i = 0; i < src.count; i++) {
    a.fromBufferAttribute(src, i).applyMatrix4(source.matrixWorld);
    b.fromBufferAttribute(out, i).applyMatrix4(lidMesh.matrixWorld);
    assert.ok(a.distanceTo(b) < 2e-4, `vertex ${i}: ${a.toArray()} vs ${b.toArray()}`);
  }
  // Unnamed geometries take their node's id; shared ones are written once.
  assert.deepEqual(model.manifest.geometries.map((g) => g.id), ["static", "lid", "bulb", "studs"]);
  // A node whose name is longer than the id rule keeps one id for itself and its unnamed geometry.
  const long = crate();
  long.getObjectByName("lid").name = "lid_with_a_very_long_descriptive_name_that_exceeds_fifty_four_characters";
  const longManifest = (await fun3d.read(await fun3d.write(long))).manifest;
  const longNode = longManifest.nodes.find((n) => n.name?.startsWith("lid_with"));
  assert.match(longNode.id, /^lid_with_a_very_long_descriptive_name_that_exceeds_fif-[0-9a-f]{6}$/);
  assert.equal(longNode.mesh.geometry, longNode.id);
  // Material slots collapse to the distinct materials; groups become contiguous runs.
  const body = model.node("static").userData.mesh;
  assert.deepEqual(model.manifest.nodes.find((n) => n.id === "static").mesh.materials, ["mat_wood", "mat_steel"]);
  assert.equal(body.material.length, 6);
  assert.equal(body.material[0], body.material[2], "one Three.js material per file material and variant");
  assert.equal(body.material[1].metalness, 1);
  assert.equal(body.material[1].color.getHexString(), "8c9399");
  const emitter = model.materials.get("mat_light").features.emitter;
  assert.deepEqual(emitter, { role: "headlight", color: "#fff0c8", intensity: 3 });
  assert.equal(model.node("bulb").userData.mesh.material.emissiveIntensity, 3);
  // Placements: copies in the parent's space, tints per copy.
  const studs = model.node("studs"), instanced = studs.userData.mesh;
  assert.equal(instanced.count, 3);
  assert.deepEqual([...model.placements.get("studs").tint.subarray(4, 8)], [0, 255, 0, 255]);
  const m = new THREE.Matrix4();
  instanced.getMatrixAt(2, m);
  close(new THREE.Vector3().applyMatrix4(m).x, 0.4, 1e-4, "instance x");
  // Physics stays by id; hull points decode to floats.
  assert.equal(model.manifest.physics.bodies[1].node, "lid");
  assert.deepEqual([...model.physicsData.points.get("hull")], [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  // Editing section: read on request, stripped for games.
  assert.equal((await fun3d.read(bytes)).edit, null);
  assert.equal((await fun3d.read(bytes, { editing: true })).edit.document.name, "crate");
  assert.deepEqual((await unpackChunks(stripEditing(bytes), { editing: true })).map((c) => c.type), ["JSON", "BIN "]);
  model.dispose();
});

test("skins, morph targets and clips survive a round trip and play by id", async () => {
  const { root, clip } = worm();
  // Names the id rule changes (a colon is lost) get the hash suffix, as in the library's Mixamo rigs.
  const hips = await idFromName("mixamorig:Hips"), spine = await idFromName("mixamorig:Spine");
  assert.match(hips, /^mixamorig_Hips-[0-9a-f]{6}$/);
  const bytes = await fun3d.write(root, { animations: [clip], rig: { name: "mixamo", version: 1, roles: { hips, spine } } });
  assert.deepEqual(await fun3d.validate(bytes), []);
  const model = await fun3d.load(bytes);
  assert.deepEqual(model.manifest.skeletons[0].bones, [hips, spine]);
  assert.equal(model.manifest.skeletons[0].rig.roles.hips, hips);
  assert.match(model.manifest.skeletons[0].hash, /^sha256:[0-9a-f]{64}$/);
  const body = model.node("body");
  assert.ok(body.isSkinnedMesh && body.name === "body");
  assert.ok(body.geometry.getAttribute("position").array instanceof Float32Array, "skinned meshes keep float positions");
  assert.equal(body.geometry.getAttribute("skinIndex").gpuType, THREE.IntType);
  const weights = body.geometry.getAttribute("skinWeight");
  for (let i = 0; i < weights.count; i++) close(weights.getX(i) + weights.getY(i) + weights.getZ(i) + weights.getW(i), 1, 1e-6, "weights sum");
  assert.deepEqual(body.morphTargetDictionary, { bulge: 0 });
  const delta = body.geometry.morphAttributes.position[0], originalDelta = root.getObjectByName("body").geometry.morphAttributes.position[0];
  for (let i = 0; i < delta.count; i++) close(delta.getX(i), originalDelta.getX(i), 1e-5, `morph delta ${i}`);
  const [loaded] = model.animations;
  assert.equal(loaded.name, "bend");
  assert.deepEqual(loaded.userData.loop, "once");
  assert.deepEqual(loaded.userData.events, [{ time: 0.5, name: "peak" }]);
  assert.deepEqual(loaded.tracks.map((t) => t.name), [`${spine}.quaternion`, `${hips}.position`, "body.morphTargetInfluences[0]"]);
  for (const [i, track] of loaded.tracks.entries()) {
    assert.deepEqual([...track.times], [...clip.tracks[i].times]);
    track.values.forEach((v, k) => close(v, clip.tracks[i].values[k], 1e-4, `${track.name} value ${k}`));
  }
  const mixer = new THREE.AnimationMixer(model.root);
  mixer.clipAction(loaded).play();
  mixer.update(0.5);
  close(model.node(spine).quaternion.z, 0.3826834, 1e-4, "animated bone");
  close(body.morphTargetInfluences[0], 1, 1e-5, "animated morph");
});

test("files reject what they cannot be", async () => {
  await assert.rejects(fun3d.load(new Uint8Array(16)), /Not a .fun3d file/);
  assert.match((await fun3d.validate(new Uint8Array(16)))[0], /Not a .fun3d file/);
  const root = crate();
  const bytes = await fun3d.write(root);
  // A corrupted index points past the vertices.
  const { manifest, bins } = await fun3d.read(bytes);
  const index = manifest.geometries[0].index, s = manifest.streams.find((x) => x.id === index.stream);
  const broken = await packChunks([{ type: "JSON", bytes: text(JSON.stringify({ ...manifest, streams: manifest.streams.map((x) => (x.id === s.id ? { ...x, codec: undefined, mode: undefined, length: x.count * x.stride } : x)) })), deflate: true }, { type: "BIN ", bytes: new Uint8Array(bins[0].length + s.count * s.stride).fill(255), deflate: true }]);
  const problems = await fun3d.validate(broken);
  assert.ok(problems.some((p) => /out of range|runs past|non-finite|coplanar|readable/.test(p)), problems.join("\n"));
  // Names that collide after the id rule are refused; unnamed objects too.
  const twin = crate();
  twin.children[0].name = "lid hinge";
  twin.children[1].name = "lid hinge";
  await assert.rejects(fun3d.write(twin), /two nodes map to the id/);
  const nameless = crate();
  nameless.add(new THREE.Object3D());
  await assert.rejects(fun3d.write(nameless), /every node needs a name/);
  // A file whose extension is required is refused by name; references are refused in this release.
  const required = await packChunks([{ type: "JSON", bytes: text(JSON.stringify({ ...manifest, uses: ["fun3d.magic"], requires: ["fun3d.magic"] })), deflate: true }, { type: "BIN ", bytes: bins[0], deflate: true }]);
  await assert.rejects(fun3d.load(required), /requires the extension fun3d.magic/);
});

test("geometry LOD levels load as index-only geometries sharing the vertices", async () => {
  const root = crate();
  const { manifest, bins } = await fun3d.read(await fun3d.write(root));
  // A coarser level that reuses level 0's index stream (valid: levels only need their own index).
  const g = manifest.geometries.find((x) => x.id === "lid");
  g.lods = [{ error: 0.05, index: g.index, groups: g.groups.map(({ start, count, material }) => ({ start, count, material })) }];
  const bytes = await packChunks([{ type: "JSON", bytes: text(JSON.stringify(manifest)), deflate: true }, { type: "BIN ", bytes: bins[0], deflate: true }]);
  assert.deepEqual(await fun3d.validate(bytes), []);
  const model = await fun3d.load(bytes);
  const entry = model.geometries.get("lid");
  assert.equal(entry.lods.length, 1);
  assert.equal(entry.lods[0].error, 0.05);
  assert.equal(entry.lods[0].geometry.getAttribute("position"), entry.geometry.getAttribute("position"), "levels share vertex attributes");
  assert.equal(entry.lods[0].geometry.index.count, entry.geometry.index.count);
  assert.ok(entry.lods[0].geometry.boundingSphere.radius > 0);
});
