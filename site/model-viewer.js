import * as THREE from "/runtime/three.js";
import { GLTFLoader } from "/runtime/addons/GLTFLoader.js";
import { OrbitControls } from "/runtime/addons/OrbitControls.js";

// The library's one look (docs/models.md): the turntable on model pages and in the console, and
// the thumbnails rendered at upload, share these lights, background and framing.
const BACKGROUND = 0xfff7d6;
const VIEW = new THREE.Vector3(0.9, 0.55, 1.2).normalize();

function stage() {
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  return { scene, camera: new THREE.PerspectiveCamera(35, 1, 0.01, 1000) };
}

// Ambient light as a sky above a ground: on painted surfaces it is exactly a hemisphere light, and
// as an environment it gives metal and glass something to reflect (without one, full metal renders
// black). Needs an initialized renderer; dispose the result.
function sky(renderer, top = 0xfff7d6, bottom = 0x5c5133, intensity = 2.2) {
  const scene = new THREE.Scene();
  for (const [color, start] of [[top, 0], [bottom, Math.PI / 2]])
    scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 8, 0, Math.PI * 2, start, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity / Math.PI), side: THREE.DoubleSide }),
    ));
  const generator = new THREE.PMREMGenerator(renderer);
  const target = generator.fromScene(scene, 0, 0.1, 10, { size: 128 });
  generator.dispose();
  release(scene);
  return target;
}

// Points the camera at the model from the front-right, above, with the whole box in view.
function frame(camera, object) {
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3()), radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1;
  camera.position.copy(center).addScaledVector(VIEW, distance);
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return { center, radius, distance };
}

// Characters carry a one-frame `pose_display` clip (docs/models.md); the library shows it instead
// of the T-pose they are rigged in. Bounds are measured on the posed skin.
function pose(gltf) {
  const clip = gltf.animations.find((item) => item.name === "pose_display");
  if (!clip) return;
  const mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(clip).play();
  mixer.update(0);
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((node) => {
    if (!node.isSkinnedMesh) return;
    node.skeleton.update();
    node.computeBoundingBox();
    node.computeBoundingSphere();
  });
}

function release(object) {
  object?.traverse((node) => {
    node.geometry?.dispose();
    for (const material of [node.material].flat().filter(Boolean)) {
      for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
      material.dispose();
    }
  });
}

/** A square PNG of a GLB (bytes) in the library's look; resolves to PNG bytes. */
export async function renderThumbnail(bytes, size = 512) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  // The same engine as the games: WebGPU where available, otherwise its WebGL 2 backend.
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setClearColor(BACKGROUND, 1);
  const { scene, camera } = stage();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let gltf = null, environment = null;
  try {
    await renderer.init();
    environment = sky(renderer);
    scene.environment = environment.texture;
    gltf = await new GLTFLoader().parseAsync(buffer, "");
    pose(gltf);
    scene.add(gltf.scene);
    frame(camera, gltf.scene);
    // Shaders compile before the frame that is read, so the render and the read share one task.
    await renderer.compileAsync(scene, camera);
    renderer.render(scene, camera);
    const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    release(gltf?.scene);
    environment?.dispose();
    void renderer.dispose();
  }
}

// A turntable for one model: drag to turn, pinch or scroll to zoom. It renders only while
// something moves, and turns by itself unless motion is reduced.
export function createViewer(container) {
  const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const ready = renderer.init();
  container.append(renderer.domElement);
  const { scene, camera } = stage();
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  controls.autoRotateSpeed = 1.5;
  controls.addEventListener("start", () => { controls.autoRotate = false; });
  let model = null, frameRequest = 0, disposed = false, initialized = false, environment = null;
  ready.then(() => {
    if (disposed) return;
    environment = sky(renderer);
    scene.environment = environment.texture;
    initialized = true;
    request();
  }, () => {});

  function resize() {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    request();
  }
  function request() {
    if (!frameRequest && !disposed && initialized) frameRequest = requestAnimationFrame(render);
  }
  function render() {
    frameRequest = 0;
    const moved = controls.update();
    renderer.render(scene, camera);
    if (moved || controls.autoRotate) request();
  }
  controls.addEventListener("change", request);
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  return {
    /** Loads a GLB and frames it; resolves when it is shown. */
    async load(url) {
      const [gltf] = await Promise.all([new GLTFLoader().loadAsync(url), ready]);
      if (disposed) { release(gltf.scene); return; }
      if (model) { scene.remove(model); release(model); }
      pose(gltf);
      model = gltf.scene;
      scene.add(model);
      const { center, radius, distance } = frame(camera, model);
      controls.target.copy(center);
      controls.minDistance = radius * 0.5;
      controls.maxDistance = distance * 4;
      controls.update();
      resize();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frameRequest);
      observer.disconnect();
      controls.dispose();
      release(model);
      environment?.dispose();
      void renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
