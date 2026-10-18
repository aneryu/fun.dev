// The .fun3d browser checks, run inside a game page by scripts/browser/fun3d.mjs: synthetic
// models written, loaded, placed alone and in batches, rendered and compared; Jolt vehicles and
// bodies; clips; and real library files when the suite serves samples. Returns a JSON report.
import * as THREE from "/runtime/three.js";
import * as TSL from "/runtime/tsl.js";
import { MeshoptDecoder } from "/runtime/addons/MeshoptDecoder.js";
import { MeshoptEncoder } from "/editor/vendor/meshopt_encoder.js";
import { GLTFLoader } from "/runtime/addons/GLTFLoader.js";
import { createFun3d } from "/runtime/kit/fun3d.js";
import { createImporter } from "/runtime/kit/fun3d-import.js";
import { createMaterials } from "/runtime/kit/materials.js";
import { createModels } from "/runtime/kit/models.js";
import { createPhysics } from "/runtime/kit/physics.js";
import { createAnimator } from "/runtime/kit/animation.js";

const W = 480, H = 360;

function lampModel() {
  const root = new THREE.Group();
  root.name = "street_lamp";
  const iron = new THREE.MeshStandardMaterial({ name: "mat_iron", color: "#555a60", roughness: 0.7, metalness: 0.6 });
  const glow = new THREE.MeshStandardMaterial({ name: "mat_lamp", color: "#fff1c8", emissive: "#fff1c8", emissiveIntensity: 4 });
  glow.userData.fun3d = { features: { emitter: { role: "lamp", color: "#fff1c8", intensity: 4 } } };
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 3, 10).translate(0, 1.5, 0), iron);
  pole.name = "pole";
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.3).translate(0.25, 3, 0), [glow]);
  head.name = "head";
  root.add(pole, head);
  return root;
}

function crateModel() {
  const root = new THREE.Group();
  root.name = "crate";
  const body = new THREE.MeshStandardMaterial({ name: "mat_body", color: "#b98a56", roughness: 0.8 });
  body.userData.fun3d = { features: { tint: {} } };
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8).translate(0, 0.4, 0), body);
  box.name = "box";
  root.add(box);
  return { root, physics: { shapes: [{ id: "box", type: "box", halfExtents: [0.4, 0.4, 0.4] }], bodies: [{ id: "crate", node: "box", shape: "box", motion: "dynamic", mass: 20 }] } };
}

function carModel() {
  const root = new THREE.Group();
  root.name = "car";
  const paint = new THREE.MeshStandardMaterial({ name: "mat_body", color: "#d9b83a", roughness: 0.5 });
  paint.userData.fun3d = { features: { tint: {} } };
  const rubber = new THREE.MeshStandardMaterial({ name: "mat_rubber", color: "#202020", roughness: 0.9 });
  const lamp = new THREE.MeshStandardMaterial({ name: "mat_light", color: "#fff6dd", emissive: "#fff6dd", emissiveIntensity: 3 });
  lamp.userData.fun3d = { features: { emitter: { role: "headlight", color: "#fff6dd", intensity: 3 } } };
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 4.2).translate(0, 0.75, 0), paint);
  body.name = "body";
  const lights = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.15, 0.1).translate(0, 0.7, 2.1), lamp);
  lights.name = "lights";
  root.add(body, lights);
  const wheels = [["wheel_fl", 0.85, 1.4], ["wheel_fr", -0.85, 1.4], ["wheel_rl", 0.85, -1.4], ["wheel_rr", -0.85, -1.4]];
  for (const [name, x, z] of wheels) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 16).rotateZ(Math.PI / 2), rubber);
    wheel.name = name;
    wheel.position.set(x, 0.35, z);
    root.add(wheel);
  }
  const corners = [];
  for (const x of [-0.9, 0.9]) for (const y of [0.4, 1.1]) for (const z of [-2.1, 2.1]) corners.push(x, y, z);
  const physics = {
    shapes: [{ id: "hull", type: "convex", points: corners }],
    bodies: [{ id: "chassis", node: "car", shape: "hull", motion: "dynamic", mass: 1200, centerOfMass: [0, -0.2, 0], friction: 0.5 }],
    vehicles: [{ id: "car", type: "wheeled", body: "chassis", wheels: wheels.map(([id, x]) => ({ id, node: id, radius: 0.35, width: 0.25, suspension: { min: 0.05, max: 0.25, rest: 0.15, frequency: 1.6, damping: 0.5 }, ...(wheels.indexOf(wheels.find((w) => w[0] === id)) < 2 ? { steer: 0.6, brake: 1500 } : { brake: 1500, handbrake: 4000 }) })),
      engine: { maxTorque: 400, minRPM: 1000, maxRPM: 6000 }, differentials: [{ wheels: ["wheel_rl", "wheel_rr"], ratio: 3.42 }] }],
  };
  return { root, physics };
}

function walkerModel() {
  const root = new THREE.Group();
  root.name = "walker";
  const geometry = new THREE.CylinderGeometry(0.15, 0.15, 1.6, 10, 6).translate(0, 0.8, 0);
  const position = geometry.getAttribute("position"), joints = [], weights = [];
  for (let i = 0; i < position.count; i++) { const w = Math.min(1, Math.max(0, position.getY(i) - 0.8)); joints.push(0, 1, 0, 0); weights.push(1 - w, w, 0, 0); }
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(joints, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
  const hips = new THREE.Bone(), spine = new THREE.Bone();
  hips.name = "hips"; spine.name = "spine"; spine.position.y = 0.8; hips.add(spine);
  const skin = new THREE.MeshStandardMaterial({ name: "mat_skin", color: "#d9a785", roughness: 0.6 });
  const mesh = new THREE.SkinnedMesh(geometry, skin);
  mesh.name = "body";
  root.add(hips, mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([hips, spine]));
  const clip = new THREE.AnimationClip("bend", 1, [new THREE.QuaternionKeyframeTrack("spine.quaternion", [0, 0.5, 1], [0, 0, 0, 1, 0, 0, 0.3826834, 0.9238795, 0, 0, 0, 1])]);
  return { root, clip };
}

const mean = (a, b) => { let sum = 0, big = 0; for (let i = 0; i < a.length; i++) { if (i % 4 === 3) continue; const d = Math.abs(a[i] - b[i]); sum += d; if (d > 24) big++; } return { mean: sum / (a.length * 0.75), big: big / (a.length * 0.75) }; };

export async function run({ samples = [] } = {}) {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const report = { warnings: [], samples: [] };
  const warn = (message) => report.warnings.push(message);
  const renderer = new THREE.WebGPURenderer({ canvas: document.createElement("canvas"), antialias: false });
  await renderer.init();
  renderer.setSize(W, H, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  report.backend = renderer.backend.isWebGPUBackend ? "webgpu" : "webgl";
  const target = new THREE.RenderTarget(W, H);
  renderer.info.autoReset = false;
  async function snapshot(scene, camera) {
    renderer.info.reset();
    renderer.setRenderTarget(target);
    await renderer.renderAsync(scene, camera);
    const calls = renderer.info.render.drawCalls, triangles = renderer.info.render.triangles;
    const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, W, H);
    renderer.setRenderTarget(null);
    let pixels = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (pixels.length !== W * H * 4) {
      // WebGPU pads rows to 256 bytes.
      const rowBytes = pixels.length / H, tight = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) tight.set(pixels.subarray(y * rowBytes, y * rowBytes + W * 4), y * W * 4);
      pixels = tight;
    }
    return { pixels, calls, triangles };
  }
  // A PNG of a snapshot, for test-results/.
  async function png(pixels) {
    // Readback rows run bottom-up on WebGL; the PNG is written top-down.
    const flipped = new Uint8ClampedArray(pixels.length);
    for (let y = 0; y < H; y++) flipped.set(pixels.subarray(y * W * 4, (y + 1) * W * 4), (H - 1 - y) * W * 4);
    const canvas = new OffscreenCanvas(W, H), context = canvas.getContext("2d");
    context.putImageData(new ImageData(report.backend === "webgl" ? flipped : new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), W, H), 0, 0);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    let text = "";
    for (const b of bytes) text += String.fromCharCode(b);
    return btoa(text);
  }
  const makeScene = () => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#30343a");
    const sun = new THREE.DirectionalLight("#fff4e0", 4);
    sun.position.set(5, 8, 4);
    sun.castShadow = true;
    scene.add(sun, new THREE.HemisphereLight("#9ab4d6", "#5a5040", 1.5));
    return scene;
  };
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
  camera.position.set(6, 4, 9);
  camera.lookAt(0, 1, 0);
  const materials = createMaterials({ THREE, TSL });
  const fun3d = createFun3d({ THREE, encoder: MeshoptEncoder, decoder: MeshoptDecoder, materials });

  // Files.
  const lampBytes = await fun3d.write(lampModel());
  const crate = crateModel(), crateBytes = await fun3d.write(crate.root, { physics: crate.physics });
  const car = carModel(), carBytes = await fun3d.write(car.root, { physics: car.physics });
  const walker = walkerModel(), walkerBytes = await fun3d.write(walker.root, { animations: [walker.clip] });
  report.sizes = { lamp: lampBytes.length, crate: crateBytes.length, car: carBytes.length, walker: walkerBytes.length };
  for (const [name, bytes] of Object.entries({ lamp: lampBytes, crate: crateBytes, car: carBytes, walker: walkerBytes })) {
    const problems = await fun3d.validate(bytes);
    if (problems.length) throw new Error(`${name}: ${problems.join("; ")}`);
  }
  const load = async (bytes) => fun3d.load(bytes, { warn });
  const files = { lamp: await load(lampBytes), crate: await load(crateBytes), car: await load(carBytes), walker: await load(walkerBytes) };

  // Batched and single placements of the same street render alike.
  const placements = [["lamp", [-3, 0, -2]], ["lamp", [0, 0, -2]], ["lamp", [3, 0, -2]], ["crate", [-2, 0, 1], [1, 0.3, 0.3]], ["crate", [2, 0, 1], [0.3, 0.4, 1]], ["car", [0, 0, 2]], ["walker", [-4, 0, 2]]];
  const street = async (batch) => {
    const scene = makeScene();
    const models = createModels({ THREE, TSL, materials, scene, warn });
    for (const [name, position, tint] of placements) models.place(files[name], { position, tint: tint ?? null, batch });
    models.update(camera, { height: H });
    return { scene, models };
  };
  // Each model alone, batched and single, to localize differences.
  report.each = {};
  for (const name of Object.keys(files)) {
    const shots = [];
    for (const batch of [true, false]) {
      const scene = makeScene(), models = createModels({ THREE, TSL, materials, scene, warn });
      models.place(files[name], { position: [0, 0, 0], tint: name === "crate" ? [1, 0.3, 0.3] : null, batch });
      models.update(camera, { height: H });
      shots.push(await snapshot(scene, camera));
      models.dispose();
    }
    report.each[name] = { ...mean(shots[0].pixels, shots[1].pixels), batchedTriangles: shots[0].triangles, singleTriangles: shots[1].triangles, batchedCalls: shots[0].calls, singleCalls: shots[1].calls };
    report.images ??= {};
    report.images[`${name}-batched`] = await png(shots[0].pixels);
    report.images[`${name}-single`] = await png(shots[1].pixels);
  }
  const batched = await street(true), single = await street(false);
  const shotBatched = await snapshot(batched.scene, camera), shotSingle = await snapshot(single.scene, camera);
  report.parity = { ...mean(shotBatched.pixels, shotSingle.pixels), batchedCalls: shotBatched.calls, singleCalls: shotSingle.calls, batches: batched.models.batches.size, triangles: shotBatched.triangles, singleTriangles: shotSingle.triangles };
  Object.assign(report.images, { batched: await png(shotBatched.pixels), single: await png(shotSingle.pixels) });
  // Roles: dimming lamps and headlights changes the batched picture, in both paths alike.
  materials.roles.set("lamp", 0);
  materials.roles.set("headlight", 0);
  const dimBatched = await snapshot(batched.scene, camera), dimSingle = await snapshot(single.scene, camera);
  report.roles = { changed: mean(shotBatched.pixels, dimBatched.pixels).mean, parity: mean(dimBatched.pixels, dimSingle.pixels).mean };
  materials.roles.set("lamp", 1);
  materials.roles.set("headlight", 1);
  // Tint: a red crate differs from a blue one.
  const copies = [...batched.models.copies];
  const red = copies.find((c) => c.file === files.crate);
  const before = await snapshot(batched.scene, camera);
  red.tint = [0.2, 0.2, 1];
  report.tint = mean(before.pixels, (await snapshot(batched.scene, camera)).pixels).mean;
  red.tint = [1, 0.3, 0.3];
  single.models.dispose();

  // Physics: the car drives forward on a ground slab; the crate falls and rests.
  const physics = await createPhysics({ THREE, scene: batched.scene, warn });
  physics.addStatic({ type: "box", halfExtents: [60, 0.5, 60] }, { position: [0, -0.5, 0], friction: 0.9 });
  const carCopy = copies.find((c) => c.file === files.car), crateCopy = copies.find((c) => c.file === files.crate);
  crateCopy.root.position.y = 3;
  crateCopy.sync();
  const carHandle = physics.add(carCopy), crateHandle = physics.add(crateCopy);
  carCopy.live = crateCopy.live = true;
  const vehicle = carHandle.vehicles.get("car");
  const startZ = carCopy.node("car").position.z, wheel = carCopy.node("wheel_rl"), wheelStart = wheel.quaternion.clone();
  for (let i = 0; i < 240; i++) { vehicle.drive({ throttle: 1 }); physics.step(1 / 60); }
  batched.models.update(camera, { height: H });
  report.physics = { drove: carCopy.node("car").position.z - startZ, speed: vehicle.speed, gear: vehicle.gear, wheelTurned: 1 - Math.abs(wheel.quaternion.dot(wheelStart)), crateY: crateCopy.node("box").position.y, crateActive: crateHandle.bodies.get("crate").active, bodies: carHandle.bodies.size };
  const afterDrive = await snapshot(batched.scene, camera);
  report.physics.moved = mean(before.pixels, afterDrive.pixels).mean;
  report.images.driven = await png(afterDrive.pixels);
  physics.dispose();

  // Clips play on a placed copy's own skeleton.
  const walkerCopy = copies.find((c) => c.file === files.walker);
  const animator = createAnimator({ THREE }, walkerCopy);
  animator.play("bend", { fade: 0 });
  animator.update(0.5);
  report.animation = { clips: animator.clips(), spineZ: walkerCopy.node("spine").quaternion.z, original: files.walker.node("spine").quaternion.z };
  animator.dispose();

  // Real library files: GLB → .fun3d in the browser, loaded, batched and drawn.
  if (samples.length) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const importer = createImporter({ THREE, loader, fun3d, encoder: MeshoptEncoder });
    for (const sample of samples) {
      const entry = { name: sample.name, type: sample.type };
      try {
        const glb = new Uint8Array(await (await fetch(`/fun3d-check/samples/${sample.name}.glb`)).arrayBuffer());
        const started = performance.now();
        const { bytes, report: converted } = await importer.importGLB(glb, { type: sample.type, name: sample.name, hash: "sha256:sample" });
        entry.convertMs = Math.round(performance.now() - started);
        entry.glb = glb.length; entry.fun3d = bytes.length; entry.report = converted;
        entry.problems = await fun3d.validate(bytes);
        const model = await load(bytes);
        const scene = makeScene(), models = createModels({ THREE, TSL, materials, scene, warn });
        const copy = models.place(model, { position: [0, 0, 0] }), alone = models.place(model, { position: [3, 0, 0], batch: false });
        models.update(camera, { height: H });
        const shot = await snapshot(scene, camera);
        entry.triangles = shot.triangles; entry.calls = shot.calls; entry.warnings = model.warnings;
        copy.remove(); alone.remove(); models.dispose(); model.dispose();
      } catch (error) { entry.error = error.message; }
      report.samples.push(entry);
    }
  }
  batched.models.dispose();
  for (const file of Object.values(files)) file.dispose();
  renderer.dispose();
  return report;
}
