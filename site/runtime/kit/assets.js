// Bundle-relative loading with cancellation, automatic ownership and loading progress.
// Pass the game context: createAssets(context).
export function createAssets(context) {
  const { THREE, asset, signal, track, onCleanup } = context;
  let total = 0;
  let done = 0;
  const report = () => context.reportLoading?.(total ? done / total : 0);
  async function task(work) {
    total++;
    report();
    try {
      const result = await work();
      signal.throwIfAborted();
      return result;
    } finally { done++; report(); }
  }
  async function fetchOk(path) {
    const response = await fetch(asset(path), { signal });
    if (!response.ok) throw new Error(`Asset unavailable: ${path}`);
    return response;
  }
  // Owns every disposable resource inside a loaded glTF scene.
  function trackScene(root) {
    root.traverse((object) => {
      if (object.geometry) track(object.geometry);
      for (const material of [object.material].flat().filter(Boolean)) {
        track(material);
        for (const value of Object.values(material)) if (value?.isTexture) track(value);
      }
      if (object.skeleton) track(object.skeleton);
    });
    return root;
  }
  let loaders = null;
  async function gltfLoader() {
    loaders ??= (async () => {
      const [{ GLTFLoader }, { DRACOLoader }, { KTX2Loader }] = await Promise.all([
        import("../addons/GLTFLoader.js"), import("../addons/DRACOLoader.js"), import("../addons/KTX2Loader.js"),
      ]);
      const draco = new DRACOLoader().setDecoderPath("/runtime/addons/draco/");
      const ktx2 = new KTX2Loader().setTranscoderPath("/runtime/addons/basis/").detectSupport(context.renderer);
      // Their worker pools stay alive until the session ends.
      onCleanup(() => { draco.dispose(); ktx2.dispose(); });
      return new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2);
    })();
    return loaders;
  }

  return {
    get progress() { return total ? done / total : 1; },
    json: (path) => task(async () => (await fetchOk(path)).json()),
    arrayBuffer: (path) => task(async () => (await fetchOk(path)).arrayBuffer()),
    texture: (path, { colorSpace = THREE.SRGBColorSpace } = {}) => task(async () => {
      const blob = await (await fetchOk(path)).blob();
      const bitmap = await createImageBitmap(blob, { imageOrientation: "flipY" });
      onCleanup(() => bitmap.close());
      const texture = track(new THREE.Texture(bitmap));
      texture.flipY = false;
      texture.colorSpace = colorSpace;
      texture.needsUpdate = true;
      return texture;
    }),
    // glTF/GLB with optional Draco meshes and KTX2 textures. Returns the parsed result;
    // add result.scene to the game scene. All its resources are released at teardown.
    gltf: (path) => task(async () => {
      const [loader, data] = await Promise.all([gltfLoader(), (await fetchOk(path)).arrayBuffer()]);
      signal.throwIfAborted();
      const url = asset(path);
      const result = await loader.parseAsync(data, url.slice(0, url.lastIndexOf("/") + 1));
      trackScene(result.scene);
      return result;
    }),
  };
}
