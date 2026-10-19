// Versioned studio setup: observation size never changes lighting or sampling.
export const STUDIO = Object.freeze({
  id: 'studio-v1', keyColor: 0xffffff, keyIntensity: 2.4,
  skyColor: 0xffffff, groundColor: 0x657180, environmentIntensity: 1.8,
  shadowMapSize: 1024, shadowBias: -0.0003,
});
export function previewQuality(options = {}, width, height) {
  const antialias = options.antialias ?? 'ssaa2';
  const scales = { native: 1, ssaa2: 2, ssaa4: 4 };
  const scale = Object.hasOwn(scales, antialias) ? scales[antialias] : null;
  if (!scale) throw new Error('Antialias must be native, ssaa2 or ssaa4');
  if (options.shadows !== undefined && typeof options.shadows !== 'boolean') throw new Error('Shadows must be boolean');
  if (options.lighting !== undefined && options.lighting !== 'studio') throw new Error('Unknown lighting preset');
  const exposure = options.exposure ?? 1;
  if (!Number.isFinite(exposure) || exposure < 0.1 || exposure > 4) throw new Error('Exposure must be 0.1–4');
  if (width * height * scale * scale > 16_777_216)
    throw new Error('Preview exceeds 16 million samples; lower size or choose a lower antialias setting');
  return { antialias, scale, shadows: options.shadows ?? true, lighting: 'studio', exposure };
}
