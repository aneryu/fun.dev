// Embedded material textures. Network image URLs are deliberately not project data.
import { ModelError } from './mesh.js';
export const TEXTURE_SLOTS = {
  baseColorTexture: ['map', 'srgb'], normalTexture: ['normalMap', 'linear'],
  metalRoughTexture: ['roughnessMap', 'linear'], occlusionTexture: ['aoMap', 'linear'],
  emissiveTexture: ['emissiveMap', 'srgb'],
};
const bad = (message, path = 'baseColorTexture') => { throw new ModelError(message, 'unsupported_texture', path); };
const enc = bytes => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};
export function textureBytes(uri) {
  const text = uri.slice(uri.indexOf(',') + 1);
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}
export function normalizeTexture(value) {
  if (!value || typeof value !== 'object' || typeof value.uri !== 'string' ||
      !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.uri) || value.uri.length > 28 * 1024 * 1024)
    bad('Use an embedded PNG or JPEG texture, at most 20 MiB');
  const bytes = textureBytes(value.uri), png = value.uri.startsWith('data:image/png;');
  if (png ? !(bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) : !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255))
    bad('Texture MIME type and image signature disagree');
  const out = { uri: value.uri };
  if ((value.texCoord ?? 0) !== 0) bad('Only TEXCOORD_0 is supported by editable conversion');
  if (value.transform !== undefined) {
    const t = value.transform;
    if (!t || Object.keys(t).some(k => !['offset', 'scale', 'rotation'].includes(k))) bad('Invalid UV transform');
    const pair = (v, fallback) => {
      if (v === undefined) return fallback;
      if (!Array.isArray(v) || v.length !== 2 || v.some(n => !Number.isFinite(n))) bad('Invalid UV transform');
      return [...v];
    };
    if (!Number.isFinite(t.rotation ?? 0)) bad('Invalid UV rotation');
    out.transform = { offset: pair(t.offset, [0, 0]), scale: pair(t.scale, [1, 1]), rotation: t.rotation ?? 0 };
  }
  for (const [key, fallback, allowed] of [
    ['wrapS', 10497, [33071, 33648, 10497]], ['wrapT', 10497, [33071, 33648, 10497]],
    ['magFilter', 9729, [9728, 9729]], ['minFilter', 9987, [9728, 9729, 9984, 9985, 9986, 9987]],
  ]) {
    const n = value[key] ?? fallback;
    if (!allowed.includes(n)) bad(`Invalid texture ${key}`);
    out[key] = n;
  }
  return out;
}
export function importTexture(json, buffers, info) {
  if (!info) return undefined;
  const transform = info.extensions?.KHR_texture_transform;
  if ((transform?.texCoord ?? info.texCoord ?? 0) !== 0)
    bad('Only TEXCOORD_0 is supported; bake the UV set before importing');
  if (Object.keys(info.extensions ?? {}).some(k => k !== 'KHR_texture_transform')) bad('Unsupported texture-info extension');
  const texture = json.textures?.[info.index], image = json.images?.[texture?.source];
  if (!texture || !image || texture.extensions) bad('Missing or unsupported base-colour texture');
  let uri = image.uri;
  if (image.bufferView !== undefined) {
    const view = json.bufferViews?.[image.bufferView], buffer = buffers[view?.buffer];
    if (!view || !buffer || !Number.isInteger(view.byteLength) || view.byteLength < 0 ||
        (view.byteOffset ?? 0) < 0 || (view.byteOffset ?? 0) + view.byteLength > buffer.length)
      bad('Texture buffer view is out of range');
    uri = `data:${image.mimeType};base64,${enc(buffer.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength))}`;
  }
  if (texture.sampler !== undefined && !json.samplers?.[texture.sampler]) bad('Missing texture sampler');
  const { texCoord, ...uvTransform } = transform ?? {};
  return normalizeTexture({ uri, ...(json.samplers?.[texture.sampler] ?? {}), ...(transform ? { transform: uvTransform } : {}) });
}

export function normalizeMeshAttributes(mesh, count) {
  const result = {};
  for (const [key, size] of [['uvs', 2], ['normals', 3]]) {
    if (mesh[key] === undefined) continue;
    if (!Array.isArray(mesh[key]) || mesh[key].length !== count || mesh[key].some(v =>
      !Array.isArray(v) || v.length !== size || v.some(n => !Number.isFinite(n))))
      bad(`Mesh ${key} must contain one finite ${size}-component value per vertex`, `mesh.${key}`);
    result[key] = mesh[key].map(v => [...v]);
  }
  return result;
}
