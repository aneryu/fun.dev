// Runtime integration example, not a game listed in the production catalog.
export function createGame({ THREE, scene, camera, track, reducedMotion }) {
  scene.background = new THREE.Color(0xffd43b);
  camera.position.set(0, 0, 4);
  const geometry = track(new THREE.BoxGeometry(1.4, 1.4, 1.4));
  const material = track(new THREE.MeshNormalMaterial());
  const cube = new THREE.Mesh(geometry, material);
  cube.rotation.set(0.4, 0.6, 0);
  scene.add(cube);
  return {
    resize({ width, height }) {
      camera.position.z = 3.5 / Math.min(1, width / height);
    },
    update(delta) {
      if (!reducedMotion) { cube.rotation.x += delta * 0.3; cube.rotation.y += delta * 0.5; }
    },
    dispose() { scene.remove(cube); },
  };
}
