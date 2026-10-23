import { parseModelFile, writeGLB } from './glb.js';
import { textureBytes, TEXTURE_SLOTS } from './textures.js';

// Embed original image bytes after geometry export: no canvas resampling or JPEG recoding.
export function embedBaseColorTextures(glb, materials, presentation, ripple) {
  const byId = new Map(materials.filter(m => Object.keys(TEXTURE_SLOTS).some(k => m[k])).map(m => [m.id, m]));
  if (!byId.size && !presentation && !ripple) return glb;
  const { json, buffers } = parseModelFile(glb), chunks = [buffers[0] ?? new Uint8Array()];
  let length = chunks[0].length;
  if (presentation) json.extras = { ...json.extras, funPresentation: presentation };
  if (ripple) json.extras = { ...json.extras, funRipple: ripple };
  const seen = new Map(), images = new Map();
  for (const m of json.materials ?? []) {
    const material = byId.get(m.name);
    if (!material) continue;
    for (const slot of Object.keys(TEXTURE_SLOTS)) {
    const source = material[slot];
    if (!source) continue;
    const { uri, transform, ...settings } = source;
    const key = JSON.stringify({ uri, ...settings });
    let index = seen.get(key);
    if (index === undefined) {
      let image = images.get(uri);
      if (image === undefined) {
      const pad = (4 - length % 4) % 4;
      if (pad) { chunks.push(new Uint8Array(pad)); length += pad; }
      const bytes = textureBytes(source.uri);
      const bufferView = (json.bufferViews ??= []).length;
      json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
      chunks.push(bytes); length += bytes.length;
      image = (json.images ??= []).length;
      json.images.push({ bufferView, mimeType: source.uri.slice(5, source.uri.indexOf(';')) });
      images.set(uri, image);
      }
      const sampler = (json.samplers ??= []).length;
      json.samplers.push(settings);
      index = (json.textures ??= []).length;
      json.textures.push({ source: image, sampler });
      seen.set(key, index);
    }
    const info = { index, texCoord: 0 };
    if (transform) {
      info.extensions = { KHR_texture_transform: transform };
      json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), 'KHR_texture_transform'])];
    }
    if (slot === 'baseColorTexture') (m.pbrMetallicRoughness ??= {}).baseColorTexture = info;
    else if (slot === 'metalRoughTexture') (m.pbrMetallicRoughness ??= {}).metallicRoughnessTexture = info;
    else m[slot] = { ...info,
      ...(slot === 'normalTexture' ? { scale: material.normalScale ?? 1 } : {}),
      ...(slot === 'occlusionTexture' ? { strength: material.occlusionStrength ?? 1 } : {}) };
    }
  }
  const bin = new Uint8Array(length); let at = 0;
  for (const c of chunks) { bin.set(c, at); at += c.length; }
  json.buffers = [{ byteLength: length }];
  return writeGLB(json, bin);
}
