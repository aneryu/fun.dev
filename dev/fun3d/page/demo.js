// Prototype scene: library props batched, the taxi as a Jolt vehicle, a character playing an
// animation pack and then falling as a ragdoll. Driven step by step by dev/fun3d/demo.mjs.
import { THREE, fun3d } from "./common.js";
import * as TSL from "/runtime/tsl.js";
import { createPhysics } from "/runtime/kit/physics.js";
import { createBatch } from "/runtime/kit/models.js";

const width = 1280, height = 720;
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: new URLSearchParams(location.search).has("gl") });
renderer.setSize(width, height);
renderer.shadowMap.enabled = true;
document.body.append(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfe3ef);

// The workshop's ambient: a sky over a ground as an environment, plus a sun with shadows.
const sky = new THREE.Scene();
for (const [color, start] of [[0xffffff, 0], [0x8a8f7a, Math.PI / 2]])
  sky.add(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 8, 0, Math.PI * 2, start, Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.6 / Math.PI), side: THREE.DoubleSide })));
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(sky, 0, 0.1, 10, { size: 128 }).texture;
const sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
sun.position.set(-30, 50, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, far: 160 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

const physics = await createPhysics({ THREE });
const ground = new THREE.Mesh(new THREE.BoxGeometry(120, 0.2, 120), new THREE.MeshStandardMaterial({ color: 0x9fae8c, roughness: 0.95 }));
ground.position.y = -0.1;
ground.receiveShadow = true;
scene.add(ground);
physics.addBox([0, -0.1, 0], [60, 0.1, 60]);
const road = new THREE.Mesh(new THREE.BoxGeometry(9, 0.02, 120), new THREE.MeshStandardMaterial({ color: 0x5b5f63, roughness: 0.9 }));
road.position.y = 0.01;
road.receiveShadow = true;
scene.add(road);

const names = ["city_taxi_01", "police_patrol_car_01", "fire_hydrant_01", "street_lamp_01", "restaurant_double_sink_01", "clockout_player", "clockout_anims-male"];
const t0 = performance.now();
const files = Object.fromEntries(await Promise.all(names.map(async (n) => [n, new Uint8Array(await (await fetch(`/demo/out/${n}.fun3d`)).arrayBuffer())])));
const load = (n) => fun3d.load(files[n]);
const models = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await load(n)])));
const loadMs = performance.now() - t0;

// Street furniture: one batch, static hulls from each model's physics.
const batch = createBatch({ THREE, TSL });
scene.add(batch.object);
let props = 0;
function place(name, x, z, yaw = 0) {
  const fresh = models[name];
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
  batch.add(fresh, m);
  fresh.scene.position.set(x, 0, z);
  fresh.scene.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  fresh.scene.updateMatrixWorld(true);
  physics.add(fresh, { motion: "static" });
  props++;
}
for (let z = -54; z <= 54; z += 9) {
  place("street_lamp_01", -5.6, z, Math.PI / 2);
  place("street_lamp_01", 5.6, z + 4.5, -Math.PI / 2);
  place("fire_hydrant_01", -6.4, z + 3, 0);
  if (Math.abs(z) > 12) place("police_patrol_car_01", 7.6, z, Math.PI);
  place("restaurant_double_sink_01", -9, z + 6, Math.PI / 2);
}
batch.roles.set("light", 3);

// A stack of crates on the road.
const crates = [];
const crateMaterial = new THREE.MeshStandardMaterial({ color: 0xc89969, roughness: 0.8 });
for (let row = 0; row < 3; row++) for (let i = 0; i < 4 - row; i++) {
  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), crateMaterial);
  crate.position.set(-1.2 + i * 0.82 + row * 0.41, 0.4 + row * 0.81, 14);
  crate.castShadow = crate.receiveShadow = true;
  scene.add(crate);
  physics.addBox(null, [0.4, 0.4, 0.4], { motion: "dynamic", mass: 25, object: crate });
  crates.push(crate);
}

// The taxi: a Jolt wheeled vehicle built from its .fun3d physics.
const taxi = models.city_taxi_01;
taxi.scene.position.set(1.8, 0.6, -18);
taxi.scene.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
scene.add(taxi.scene);
taxi.scene.updateMatrixWorld(true);
const car = physics.add(taxi);

// The character: clips from the animation pack (same rig), then a ragdoll.
const person = models.clockout_player;
person.scene.position.set(-2.5, 0, 6);
person.scene.rotation.y = Math.PI / 2;
person.scene.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; o.frustumCulled = false; } });
scene.add(person.scene);
const clips = models["clockout_anims-male"].animations;
const mixer = new THREE.AnimationMixer(person.scene);
const walk = mixer.clipAction(clips.find((c) => c.name === "walk"));
walk.play();
const body = physics.add(person);

const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 400);
let time = 0, frames = 0;
const dt = 1 / 60;
function script(t) {
  // Straight into the crates, then brake and turn.
  car.vehicle.drive({ throttle: t > 0.5 && t < 6.5 ? 0.8 : 0, steer: t > 7 ? 0.4 : 0, brake: t > 6.5 && t < 7.5 ? 0.6 : 0 });
  if (t > 2 && !body.ragdoll.active) {
    mixer.stopAllAction();
    body.ragdoll.activate({ velocity: [1.5, 0, 0] });
  }
}
window.step = (seconds) => {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    script(time);
    if (!body.ragdoll.active) mixer.update(dt);
    physics.step(dt);
    time += dt;
    frames++;
  }
  return { time: +time.toFixed(2), speed: +car.vehicle.speed.toFixed(2), gear: car.vehicle.gear, rpm: Math.round(car.vehicle.rpm), taxi: taxi.scene.position.toArray().map((v) => +v.toFixed(2)), crate: crates.at(-1).position.toArray().map((v) => +v.toFixed(2)) };
};
window.view = (name) => {
  const target = new THREE.Vector3();
  if (name === "overview") { camera.position.set(28, 26, -34); target.set(0, 0, 0); }
  else if (name === "chase") {
    taxi.scene.getWorldPosition(target);
    const back = new THREE.Vector3(0, 0, -1).applyQuaternion(taxi.scene.quaternion);
    camera.position.copy(target).addScaledVector(back, 8).add(new THREE.Vector3(2.5, 3.2, 0));
    target.y += 0.8;
  } else if (name === "person") {
    person.scene.getObjectByName("pelvis").getWorldPosition(target);
    camera.position.copy(target).add(new THREE.Vector3(2.4, 1.3, 2.8));
  }
  camera.lookAt(target);
  renderer.info.reset();
  renderer.render(scene, camera);
  return { draws: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles };
};
window.info = { loadMs: Math.round(loadMs), props, sizes: Object.fromEntries(names.map((n) => [n, files[n].length])), backend: renderer.backend.isWebGPUBackend ? "webgpu" : "webgl2" };
window.ready = true;
