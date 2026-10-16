import * as THREE from "/runtime/three.js";
import { GLTFLoader } from "/runtime/addons/GLTFLoader.js";
import { OrbitControls } from "/runtime/addons/OrbitControls.js";

// A turntable for one library model (docs/models.md): drag to turn, pinch or scroll to zoom.
// It renders only while something moves, and turns by itself unless motion is reduced.
export function createViewer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff7d6, 0x5c5133, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  controls.autoRotateSpeed = 1.5;
  controls.addEventListener("start", () => { controls.autoRotate = false; });
  let model = null, frame = 0, disposed = false;

  function resize() {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    request();
  }
  function request() {
    if (!frame && !disposed) frame = requestAnimationFrame(render);
  }
  function render() {
    frame = 0;
    const moved = controls.update();
    renderer.render(scene, camera);
    if (moved || controls.autoRotate) request();
  }
  controls.addEventListener("change", request);
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  function release(object) {
    object?.traverse((node) => {
      node.geometry?.dispose();
      for (const material of [node.material].flat().filter(Boolean)) {
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      }
    });
  }

  return {
    /** Loads a GLB and frames it; resolves when it is shown. */
    async load(url) {
      const gltf = await new GLTFLoader().loadAsync(url);
      if (disposed) { release(gltf.scene); return; }
      if (model) { scene.remove(model); release(model); }
      model = gltf.scene;
      scene.add(model);
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3()), radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
      const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1;
      camera.position.copy(center).add(new THREE.Vector3(0.9, 0.55, 1.2).normalize().multiplyScalar(distance));
      camera.near = distance / 100;
      camera.far = distance * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.minDistance = radius * 0.5;
      controls.maxDistance = distance * 4;
      controls.update();
      resize();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      release(model);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
