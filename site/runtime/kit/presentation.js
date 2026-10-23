// Data-only target scene settings. Studio inspection remains a separate view.
import { createLightSlots } from './lights.js';
import { createPost } from './post.js';

const record = (v, keys, path) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new TypeError(`Invalid ${path}`);
};
const number = (v, min, max, path) => {
  if (!Number.isFinite(v) || v < min || v > max) throw new TypeError(`Invalid ${path}`);
  return v;
};
const vector = (v, min, max, path) => {
  if (!Array.isArray(v) || v.length !== 3) throw new TypeError(`Invalid ${path}`);
  return v.map(n => number(n, min, max, path));
};
export function normalizePresentation(value) {
  record(value, ['version', 'camera', 'exposure', 'background', 'environment', 'lights', 'post'], 'presentation');
  if (value.version !== 1) throw new TypeError('Unsupported presentation version');
  const color = c => { if (!/^#[a-f\d]{6}$/i.test(c)) throw new TypeError('Invalid color'); return c; };
  const c = value.camera ?? {};
  record(c, ['position', 'target', 'fov'], 'camera');
  const e = value.environment ?? {};
  record(e, ['sky', 'ground', 'key', 'intensity'], 'environment');
  const lights = value.lights ?? [];
  if (!Array.isArray(lights) || lights.length > 8) throw new TypeError('At most eight light slots');
  const post = value.post ?? {};
  record(post, ['ao', 'bloom', 'saturation', 'samples'], 'post');
  if (post.ao !== undefined && typeof post.ao !== 'boolean') throw new TypeError('Invalid AO');
  if (post.samples !== undefined && ![0,4].includes(post.samples)) throw new TypeError('Post samples must be 0 or 4');
  return {
    version: 1, camera: { position: vector(c.position ?? [4, 3, 5], -10000, 10000, 'camera.position'), target: vector(c.target ?? [0, 0, 0], -10000, 10000, 'camera.target'), fov: number(c.fov ?? 40, 5, 120, 'camera.fov') },
    exposure: number(value.exposure ?? 1, .01, 10, 'exposure'), background: color(value.background ?? '#fff7d6'),
    environment: { sky: vector(e.sky ?? [.25, .35, .5], 0, 100, 'environment.sky'), ground: vector(e.ground ?? [.08, .06, .04], 0, 100, 'environment.ground'), key: vector(e.key ?? [8, 7, 5], 0, 100, 'environment.key'), intensity: number(e.intensity ?? 1, 0, 10, 'environment.intensity') },
    lights: lights.map((l, i) => { record(l, ['position', 'color', 'intensity', 'range'], `lights.${i}`); return { position: vector(l.position, -10000, 10000, 'light.position'), color: color(l.color ?? '#ffffff'), intensity: number(l.intensity ?? 30, 0, 1000, 'light.intensity'), range: number(l.range ?? 20, 0, 10000, 'light.range') }; }),
    post: { ao: post.ao ?? false, bloom: number(post.bloom ?? 0, 0, 3, 'post.bloom'), saturation: number(post.saturation ?? 1, 0, 2, 'post.saturation'), samples: post.samples ?? 4 },
  };
}

export async function createPresentation(context, value) {
  const config = normalizePresentation(value), { THREE, scene, camera, renderer } = context;
  const previous = { environment: scene.environment, intensity: scene.environmentIntensity, background: scene.background, exposure: renderer.toneMappingExposure };
  const disposables = [];
  // Small, original floating-point HDR panorama: radiance is not clamped to 1.
  const width = 64, height = 32, data = new Float32Array(width * height * 4), e = config.environment;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const t = y / (height - 1), softbox = Math.exp(-((x - 18) ** 2 / 30 + (y - 9) ** 2 / 12));
    for (let k = 0; k < 3; k++) data[(y * width + x) * 4 + k] = e.sky[k] * (1 - t) + e.ground[k] * t + e.key[k] * softbox;
    data[(y * width + x) * 4 + 3] = 1;
  }
  const environment = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  environment.mapping = THREE.EquirectangularReflectionMapping; environment.needsUpdate = true;
  disposables.push(environment);
  scene.environment = environment; scene.environmentIntensity = e.intensity;
  scene.background = new THREE.Color(config.background); renderer.toneMappingExposure = config.exposure;
  camera.position.fromArray(config.camera.position); camera.lookAt(...config.camera.target); camera.fov = config.camera.fov; camera.updateProjectionMatrix();
  const slots = createLightSlots({ THREE, scene, count: config.lights.length, shadows: 0, fade: 0 });
  const candidates = config.lights.map((l, i) => ({ id: `presentation_${i}`, x: l.position[0], y: l.position[1], z: l.position[2], ...l }));
  slots.update(1, camera.position, candidates);
  let post, disposed = false;
  const dispose = () => {
    if (disposed) return; disposed = true;
    post?.dispose(); slots.dispose();
    scene.environment = previous.environment; scene.environmentIntensity = previous.intensity; scene.background = previous.background; renderer.toneMappingExposure = previous.exposure;
    for (const resource of new Set(disposables)) resource.dispose?.();
  };
  try {
    if (config.post.ao || config.post.bloom || config.post.saturation !== 1) post = await createPost({ ...context, track: resource => { disposables.push(resource); return resource; } }, {
      ao: config.post.ao, bloom: config.post.bloom ? { strength: config.post.bloom } : false, grade: { saturation: config.post.saturation }, samples: config.post.samples,
    });
    context.signal?.throwIfAborted();
    return { config, environment, post, slots, dispose, update(dt) { slots.update(dt, camera.position, candidates); } };
  } catch (error) { dispose(); throw error; }
}
