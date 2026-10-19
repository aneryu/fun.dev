// Copies of loaded objects (docs/worlds.md): a placed model's tree under a tile's node, or
// the nested tree of a copy the placer makes. Three.js's clone() would serialise every
// node's cached mesh (userData.mesh) through JSON; this copies what a loaded file has:
// transforms, names, visibility, meshes and instanced meshes sharing geometry and materials,
// plain userData, and the mesh links themselves.
export function cloneObjects(THREE, source) {
  let copy;
  if (source.isInstancedMesh) {
    copy = new THREE.InstancedMesh(source.geometry, source.material, source.count);
    copy.instanceMatrix.copy(source.instanceMatrix);
    if (source.instanceColor) copy.instanceColor = source.instanceColor.clone();
  } else if (source.isMesh) copy = new THREE.Mesh(source.geometry, source.material);
  else copy = new THREE.Object3D();
  copy.name = source.name;
  copy.position.copy(source.position);
  copy.quaternion.copy(source.quaternion);
  copy.scale.copy(source.scale);
  copy.visible = source.visible;
  copy.castShadow = source.castShadow;
  copy.receiveShadow = source.receiveShadow;
  copy.renderOrder = source.renderOrder;
  if (source.isMesh) {
    if (source.morphTargetInfluences) copy.morphTargetInfluences = [...source.morphTargetInfluences];
    if (source.morphTargetDictionary) copy.morphTargetDictionary = { ...source.morphTargetDictionary };
  }
  const { mesh, ...plain } = source.userData;
  copy.userData = structuredClone(plain);
  for (const child of source.children) {
    const c = cloneObjects(THREE, child);
    copy.add(c);
    if (child === mesh) copy.userData.mesh = c;
  }
  return copy;
}
