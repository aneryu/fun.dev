import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createRasterizer, resolve, toneMap } from "../site/editor/soft-renderer.js";

// The workshop's software renderer, checked against values the GPU path produces
// (SwiftShader WebGL through WebGPURenderer, 2026-10-19).
const raster = createRasterizer(THREE);
const environment = { top: 0xffffff, bottom: 0x657180, intensity: 1.8 };

function stage({ shadows = false } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#d7d9db");
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(-3, 7, 5);
  key.castShadow = shadows;
  key.shadow.mapSize.set(512, 512);
  key.shadow.bias = -0.0003;
  Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, far: 40 });
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key, key.target);
  return scene;
}
function front(size = 2) {
  const camera = new THREE.OrthographicCamera(-size, size, size, -size, 0.1, 100);
  camera.position.set(0, 0.5, 10);
  camera.lookAt(0, 0.5, 0);
  return camera;
}
function render(scene, camera, { width = 64, height = 64, ss = 1, shadows = false } = {}) {
  const frame = raster.draw(scene, camera, { width, height, ss, environment, shadows });
  const image = resolve(frame, 1);
  return (x, y) => [...image.pixels.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
}
const box = (color, position, options = {}) => {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, ...options }),
  );
  mesh.position.set(...position);
  return mesh;
};

test("the background and a grey face match the GPU path's tone mapping", () => {
  const out = [0, 0, 0];
  const bg = new THREE.Color("#d7d9db");
  toneMap(bg.r, bg.g, bg.b, 1, out, 0);
  assert.deepEqual(out, [212, 213, 214]);
  const scene = stage();
  scene.add(box("#808080", [0, 0.5, 0]));
  const at = render(scene, front());
  // A face towards the camera under the key light and the sky: the GPU drew 122,123,125.
  const [r, g, b] = at(32, 32);
  assert.ok(Math.abs(r - 122) <= 4 && Math.abs(g - 123) <= 4 && Math.abs(b - 125) <= 4, `${r},${g},${b}`);
  assert.deepEqual(at(1, 1), [212, 213, 214]);
});

test("nearer surfaces hide farther ones, whatever the drawing order", () => {
  const scene = stage();
  scene.add(box("#ff0000", [0, 0.5, 2]), box("#0000ff", [0, 0.5, 0]));
  let at = render(scene, front());
  assert.ok(at(32, 32)[0] > 150 && at(32, 32)[2] < 80, "red in front");
  scene.children.reverse();
  at = render(scene, front());
  assert.ok(at(32, 32)[0] > 150 && at(32, 32)[2] < 80, "still red in front");
});

test("one-sided faces cull from behind, also on mirrored parts", () => {
  const scene = stage();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: "#00ff00" }));
  plane.position.set(0, 0.5, 0);
  scene.add(plane);
  assert.ok(render(scene, front())(32, 32)[1] > 200, "seen from the front");
  plane.rotation.y = Math.PI;
  plane.updateMatrixWorld();
  assert.deepEqual(render(scene, front())(32, 32), [212, 213, 214], "culled from behind");
  // A mirror (negative determinant) turned back round faces the camera again.
  plane.scale.x = -1;
  assert.ok(render(scene, front())(32, 32)[1] > 200, "mirrored and turned: visible");
});

test("lines and points behind a part stay hidden; in front they show", () => {
  const scene = stage();
  scene.add(box("#808080", [0, 0.5, 0]));
  const line = (z) =>
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-2, 0.5, z), new THREE.Vector3(2, 0.5, z)]),
      new THREE.LineBasicMaterial({ color: "#ff0000" }),
    );
  const behind = line(-2);
  scene.add(behind);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.0006, 120);
  camera.position.set(0, 0.5, 6);
  camera.lookAt(0, 0.5, 0);
  let at = render(scene, camera);
  const y = 32;
  assert.ok(at(32, y)[0] < 160, `hidden behind the box: ${at(32, y)}`);
  assert.ok(at(2, y)[0] > 200, `visible beside it: ${at(2, y)}`);
  scene.remove(behind);
  scene.add(line(2));
  at = render(scene, camera);
  assert.ok(at(32, y)[0] > 200, `in front of the box: ${at(32, y)}`);
});

test("a transparent pane blends over what is behind it", () => {
  const scene = stage();
  scene.background = new THREE.Color("#000000");
  const pane = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.5 }),
  );
  pane.position.set(0, 0.5, 0);
  scene.add(pane);
  const [r] = render(scene, front())(32, 32);
  const half = [0, 0, 0];
  toneMap(0.5, 0.5, 0.5, 1, half, 0);
  assert.ok(Math.abs(r - half[0]) <= 1, `${r} vs ${half[0]}`);
});

test("the key light's shadow falls on the floor beside a part", () => {
  const scene = stage({ shadows: true });
  const part = box("#808080", [0, 0.5, 0]);
  part.castShadow = true;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: 0.16 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(part, floor);
  const camera = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 100);
  camera.position.set(0, 10, 0.001);
  camera.lookAt(0, 0, 0);
  const at = render(scene, camera, { shadows: true });
  // The light comes from −x, +y, +z: the top's shadow lands about (0.43, −0.71) further on,
  // so the floor at x 0.7, z −0.9 (pixel 39, 22) is in shadow; x −1.8, z 1.9 is open.
  const shaded = at(39, 22)[0],
    open = at(12, 52)[0];
  // Full shadow on the viewport's 16 % shadow floor takes the background from 212 to 204.
  assert.ok(shaded <= open - 6, `shadow ${shaded} vs open floor ${open}`);
});

test("supersampling smooths edges between the part and the background", () => {
  const scene = stage();
  const part = box("#000000", [0, 0.5, 0]);
  part.rotation.z = 0.3;
  scene.add(part);
  const frame = raster.draw(scene, front(), { width: 64, height: 64, ss: 2, environment, shadows: false });
  const image = resolve(frame, 1);
  // Two samples per side: edge pixels take three in-between steps of coverage.
  const values = new Set();
  for (let i = 0; i < image.pixels.length; i += 4) values.add(image.pixels[i]);
  const [low, high] = [Math.min(...values), Math.max(...values)];
  assert.ok([...values].filter((v) => v > low + 4 && v < high - 4).length >= 3, `edge steps: ${[...values]}`);
});

test("lines passing close to the eye are clipped to the screen, not dropped", () => {
  const scene = stage();
  scene.background = new THREE.Color("#000000");
  // A floor line running from behind the camera far ahead: huge on screen once projected.
  scene.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 9.999), new THREE.Vector3(0, 0, -50)]),
      new THREE.LineBasicMaterial({ color: "#ffffff" }),
    ),
  );
  const camera = new THREE.PerspectiveCamera(38, 1, 0.0006, 120);
  camera.position.set(0, 0.3, 10);
  camera.lookAt(0, 0, 0);
  const at = render(scene, camera);
  let lit = 0;
  for (let y = 0; y < 64; y++) if (at(32, y)[0] > 100 || at(31, y)[0] > 100) lit++;
  assert.ok(lit > 10, `the line crosses the lower screen: ${lit} rows`);
});
