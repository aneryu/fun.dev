import { gameOrigin } from "./game-source.js";

// The model library's public snapshots (docs/models.md), written by the server whenever what is
// listed changes: library/index.<locale>.json (one row per listed model) and library/<id>.json (a
// model's page data). Files are content-addressed blobs on the game origin.
const ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{64}$/;
export const MODEL_TYPES = ["prop", "piece", "vehicle", "character", "creature", "animation", "scene", "world"];

export function blobURL(name, sha256, origin = gameOrigin) {
  return `${origin}/blobs/${sha256}.${name.split(".").pop()}`;
}

export const thumbnailURL = (sha256) => (sha256 ? blobURL("thumbnail.png", sha256) : "");

export function modelPath(id) {
  return `/models/${id}`;
}

async function fetchJSON(path, signal) {
  const response = await fetch(`${gameOrigin}/library/${path}`, { credentials: "omit", redirect: "error", signal });
  // Nothing has been listed yet, or no such model.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Model library request failed: ${response.status}`);
  return response.json();
}

/** The listed models in one language: { kits: { id: text }, models: [{ id, name, description, type, kit, tags, size, version, thumbnail }] }. */
export async function loadIndex(locale, signal) {
  const data = await fetchJSON(`index.${locale}.json`, signal);
  if (!data) return { kits: {}, models: [] };
  if (!Array.isArray(data.fields) || !Array.isArray(data.models)) throw new Error("Invalid model index.");
  const at = Object.fromEntries(data.fields.map((field, index) => [field, index]));
  const models = data.models.map((row) => ({
    id: row[at.id], name: row[at.name], description: row[at.description], type: row[at.type], kit: row[at.kit] || null,
    tags: row[at.tags] ? row[at.tags].split(" ") : [], size: row[at.size], version: row[at.version], thumbnail: row[at.thumbnail] || null,
  }));
  for (const model of models) {
    if (!ID.test(model.id) || !MODEL_TYPES.includes(model.type) || typeof model.name !== "string" || typeof model.description !== "string" || (model.thumbnail && !SHA.test(model.thumbnail))) throw new Error(`Invalid model entry: ${model.id}`);
  }
  return { kits: data.kits ?? {}, models };
}

/** One model's page data in both languages with every approved version, or null. */
export async function loadModel(id, signal) {
  if (!ID.test(id)) return null;
  const model = await fetchJSON(`${id}.json`, signal);
  if (!model) return null;
  const text = (value) => ["zh", "en"].every((locale) => typeof value?.[locale] === "string");
  const valid = model.id === id && MODEL_TYPES.includes(model.type) && text(model.name) && Array.isArray(model.versions) && model.versions.length &&
    model.versions.every((version) => /^v\d{3}$/.test(version.version) && SHA.test(version.files?.["model.glb"]?.sha256) &&
      Object.values(version.files).every((file) => SHA.test(file.sha256) && Number.isInteger(file.size)));
  if (!valid) throw new Error(`Invalid model data: ${id}`);
  return model;
}

export function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatSize(size) {
  return size.map((value) => `${Number(value.toFixed(2))}`).join(" × ") + " m";
}
