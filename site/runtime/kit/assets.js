// Bundle-relative loading with cancellation, automatic ownership and loading progress.
// Pass the game context: createAssets(context). Bytes and decoded images come from the
// host's `readAsset` and `decodeImage` (docs/hosts.md); a context without them (older hosts,
// tests) falls back to fetch and createImageBitmap.
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif" };
export const mimeOf = (path) => MIME[new URL(path, "https://bundle.invalid/").pathname.split(".").pop().toLowerCase()] ?? "application/octet-stream";

/**
 * A Three.js texture for a decoded image: an ImageBitmap-like source, or { width, height, data }
 * pixels with the top row first (fun's decodeImage), which upload flipped as bitmaps do.
 */
export function textureFromImage(THREE, image) {
  if (image?.data && !image.close) {
    // The same sampling a bitmap texture gets, so both hosts draw alike (DataTexture defaults to nearest).
    const texture = new THREE.DataTexture(image.data, image.width, image.height);
    texture.flipY = true; texture.generateMipmaps = true; texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
    return texture;
  }
  return new THREE.Texture(image);
}

export function createAssets(context) {
  const { THREE, asset, signal, track, onCleanup } = context;
  const readAsset = context.readAsset ?? (async (path) => {
    const response = await fetch(asset(path), { signal });
    if (!response.ok) throw new Error(`Asset unavailable: ${path}`);
    return new Uint8Array(await response.arrayBuffer());
  });
  const decodeImage = context.decodeImage ?? ((bytes, { mime, ...options }) => createImageBitmap(new Blob([bytes], { type: mime }), options));
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
  const bytesOf = (path) => readAsset(path);
  // The bytes as an ArrayBuffer for the loaders: the view's own buffer when it covers it whole.
  const bufferOf = async (path) => { const b = await readAsset(path); return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
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
  // Loaders and their worker pools are created on first use and stay alive until the session ends.
  let ktx2 = null;
  function ktx2Loader() {
    ktx2 ??= import("../addons/KTX2Loader.js").then(({ KTX2Loader }) => {
      const loader = new KTX2Loader().setTranscoderPath(new URL("../addons/basis/", import.meta.url).href).detectSupport(context.renderer);
      onCleanup(() => loader.dispose());
      return loader;
    });
    return ktx2;
  }
  let loaders = null;
  async function gltfLoader() {
    loaders ??= (async () => {
      const [{ GLTFLoader }, { DRACOLoader }, { MeshoptDecoder }, ktx2] = await Promise.all([import("../addons/GLTFLoader.js"), import("../addons/DRACOLoader.js"), import("../addons/MeshoptDecoder.js"), ktx2Loader()]);
      const draco = new DRACOLoader().setDecoderPath(new URL("../addons/draco/", import.meta.url).href);
      onCleanup(() => draco.dispose());
      return new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
    })();
    return loaders;
  }

  return {
    get progress() { return total ? done / total : 1; },
    json: (path) => task(async () => JSON.parse(new TextDecoder().decode(await bytesOf(path)))),
    arrayBuffer: (path) => task(() => bufferOf(path)),
    // PNG/JPEG/WebP, or KTX2 (Basis Universal), which stays compressed in GPU memory: the
    // better choice for large textures. Colour textures are sRGB; pass NoColorSpace for data.
    texture: (path, { colorSpace = THREE.SRGBColorSpace } = {}) => task(async () => {
      if (/\.ktx2$/i.test(new URL(path, "https://bundle.invalid/").pathname)) {
        const [loader, data] = await Promise.all([ktx2Loader(), bufferOf(path)]);
        signal.throwIfAborted();
        const texture = track(await new Promise((resolve, reject) => loader.parse(data, resolve, reject)));
        texture.colorSpace = colorSpace;
        return texture;
      }
      // Straight alpha and no colour conversion, as Three.js expects of a texture source (its
      // ImageBitmapLoader asks the same); browsers would otherwise premultiply and darken soft edges.
      const image = await decodeImage(await bytesOf(path), { mime: mimeOf(path), imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" });
      if (typeof image.close === "function") onCleanup(() => image.close());
      const texture = track(textureFromImage(THREE, image));
      texture.flipY = false;
      texture.colorSpace = colorSpace;
      texture.needsUpdate = true;
      return texture;
    }),
    // glTF/GLB with optional Draco or meshopt meshes and KTX2 textures. Returns the parsed result;
    // add result.scene to the game scene. All its resources are released at teardown.
    gltf: (path) => task(async () => {
      const [loader, data] = await Promise.all([gltfLoader(), bufferOf(path)]);
      signal.throwIfAborted();
      const url = asset(path);
      const result = await loader.parseAsync(data, url.slice(0, url.lastIndexOf("/") + 1));
      trackScene(result.scene);
      return result;
    }),
  };
}
