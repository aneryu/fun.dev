import * as THREE from "/runtime/three.js";
import { GLTFLoader } from "/runtime/addons/GLTFLoader.js";
import { OrbitControls } from "/runtime/addons/OrbitControls.js";

// The library's one look (docs/models.md): the turntable on model pages and in the console, and
// the thumbnails rendered at upload, share these lights, background and framing.
const BACKGROUND = 0xfff7d6;
const VIEW = new THREE.Vector3(0.9, 0.55, 1.2).normalize();

function stage() {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff7d6, 0x5c5133, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  return { scene, camera: new THREE.PerspectiveCamera(35, 1, 0.01, 1000) };
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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(BACKGROUND, 1);
  const { scene, camera } = stage();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new GLTFLoader().parseAsync(buffer, "");
  try {
    scene.add(gltf.scene);
    frame(camera, gltf.scene);
    renderer.render(scene, camera);
    const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    release(gltf.scene);
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

// A turntable for one model: drag to turn, pinch or scroll to zoom. It renders only while
// something moves, and turns by itself unless motion is reduced.
export function createViewer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.append(renderer.domElement);
  const { scene, camera } = stage();
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  controls.autoRotateSpeed = 1.5;
  controls.addEventListener("start", () => { controls.autoRotate = false; });
  let model = null, frameRequest = 0, disposed = false;

  function resize() {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    request();
  }
  function request() {
    if (!frameRequest && !disposed) frameRequest = requestAnimationFrame(render);
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
      const gltf = await new GLTFLoader().loadAsync(url);
      if (disposed) { release(gltf.scene); return; }
      if (model) { scene.remove(model); release(model); }
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
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
