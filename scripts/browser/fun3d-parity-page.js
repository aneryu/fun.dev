// The parity render (docs/model-format.md §8), run inside a page by scripts/browser/fun3d-parity.mjs:
// a GLB and its .fun3d drawn with Three.js's own materials under the same lights and cameras,
// compared pixel for pixel over three views. Returns per-model scores and small side-by-side
// pictures of the worst pairs.
import * as THREE from "/runtime/three.js";
import { GLTFLoader } from "/runtime/addons/GLTFLoader.js";
import { MeshoptDecoder } from "/runtime/addons/MeshoptDecoder.js";
import { createFun3d } from "/runtime/kit/fun3d.js";

const SIZE = 256;
const VIEWS = [[1, 0.8, 1.3], [-1.2, 0.5, -0.9], [0.3, 1.6, 0.4]];

export async function run({ files, worst = 50 }) {
  await MeshoptDecoder.ready;
  const renderer = new THREE.WebGPURenderer({ canvas: document.createElement("canvas"), antialias: false });
  await renderer.init();
  renderer.setSize(SIZE, SIZE, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.info.autoReset = false;
  const backend = renderer.backend.isWebGPUBackend ? "webgpu" : "webgl";
  const target = new THREE.RenderTarget(SIZE, SIZE);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const fun3d = createFun3d({ THREE, decoder: MeshoptDecoder });
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  const makeScene = () => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#8c949c");
    const sun = new THREE.DirectionalLight("#fff4e0", 2.8);
    sun.position.set(4, 7, 5);
    scene.add(sun, new THREE.HemisphereLight("#b9c9e0", "#6a5f4e", 1.4));
    return scene;
  };
  async function snapshot(scene) {
    renderer.setRenderTarget(target);
    await renderer.renderAsync(scene, camera);
    const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE);
    renderer.setRenderTarget(null);
    let pixels = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (pixels.length !== SIZE * SIZE * 4) {
      const rowBytes = pixels.length / SIZE, tight = new Uint8Array(SIZE * SIZE * 4);
      for (let y = 0; y < SIZE; y++) tight.set(pixels.subarray(y * rowBytes, y * rowBytes + SIZE * 4), y * SIZE * 4);
      pixels = tight;
    }
    return pixels;
  }
  const frame = (object) => {
    const box = new THREE.Box3().setFromObject(object), center = box.getCenter(new THREE.Vector3()), radius = Math.max(1e-3, box.getSize(new THREE.Vector3()).length() / 2);
    return { center, radius };
  };
  const diff = (a, b) => { let sum = 0, big = 0; for (let i = 0; i < a.length; i += 4) { const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); sum += d; if (d > 48) big++; } return { mean: sum / (a.length / 4) / 3, big: big / (a.length / 4) }; };
  const results = [], keep = [];
  for (const file of files) {
    const entry = { id: file.id, views: [] };
    try {
      const [glb, bytes] = await Promise.all([fetch(`/fun3d-parity/files/${file.id}.glb`).then((r) => r.arrayBuffer()), fetch(`/fun3d-parity/files/${file.id}.fun3d`).then((r) => r.arrayBuffer())]);
      const gltf = await loader.parseAsync(glb, "");
      const model = await fun3d.load(new Uint8Array(bytes), { warn: () => {} });
      const sceneA = makeScene(), sceneB = makeScene();
      sceneA.add(gltf.scene);
      sceneB.add(model.root);
      const { center, radius } = frame(gltf.scene);
      const shots = [];
      for (const view of VIEWS) {
        camera.position.set(center.x + view[0] * radius * 2.6, center.y + view[1] * radius * 2.6, center.z + view[2] * radius * 2.6);
        camera.near = radius * 0.05; camera.far = radius * 20;
        camera.lookAt(center);
        camera.updateProjectionMatrix();
        const a = await snapshot(sceneA), b = await snapshot(sceneB);
        const score = diff(a, b);
        entry.views.push(score);
        shots.push([a, b]);
      }
      entry.mean = entry.views.reduce((n, v) => n + v.mean, 0) / entry.views.length;
      entry.big = Math.max(...entry.views.map((v) => v.big));
      entry.triangles = { glb: countTriangles(gltf.scene), fun3d: countTriangles(model.root) };
      keep.push({ id: file.id, mean: entry.mean, shots: shots[0] });
      keep.sort((x, y) => y.mean - x.mean);
      if (keep.length > worst) keep.pop();
      model.dispose();
      gltf.scene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); for (const m of [o.material].flat()) m.dispose(); } });
    } catch (error) { entry.error = error.message; }
    results.push(entry);
  }
  // A contact sheet of the worst pairs: GLB left, .fun3d right, score below.
  const columns = 5, rows = Math.ceil(keep.length / columns), cell = SIZE / 2;
  const canvas = new OffscreenCanvas(columns * (cell * 2 + 8), rows * (cell + 24)), context = canvas.getContext("2d");
  context.fillStyle = "#222"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = "12px sans-serif"; context.fillStyle = "#fff";
  const draw = async (pixels, x, y) => {
    const flipped = new Uint8ClampedArray(pixels.length);
    for (let row = 0; row < SIZE; row++) flipped.set(pixels.subarray(row * SIZE * 4, (row + 1) * SIZE * 4), backend === "webgl" ? (SIZE - 1 - row) * SIZE * 4 : row * SIZE * 4);
    const bitmap = await createImageBitmap(new ImageData(flipped, SIZE, SIZE));
    context.drawImage(bitmap, x, y, cell, cell);
  };
  for (const [i, item] of keep.entries()) {
    const x = (i % columns) * (cell * 2 + 8), y = Math.floor(i / columns) * (cell + 24);
    await draw(item.shots[0], x, y);
    await draw(item.shots[1], x + cell, y);
    context.fillText(`${item.id} ${item.mean.toFixed(2)}`, x + 2, y + cell + 14);
  }
  const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  let text = "";
  for (let i = 0; i < png.length; i += 0x8000) text += String.fromCharCode(...png.subarray(i, i + 0x8000));
  renderer.dispose();
  return { backend, results, sheet: btoa(text) };
}

function countTriangles(object) {
  let n = 0;
  object.traverse((o) => { if (o.isMesh) { const g = o.geometry; n += (g.index ? g.index.count : g.getAttribute("position").count) / 3 * (o.isInstancedMesh ? o.count : 1); } });
  return Math.round(n);
}
