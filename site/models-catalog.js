import { gameOrigin } from "./game-source.js";

// The public model catalog (docs/models.md), written by the console on every approval. Files are
// content-addressed blobs on the game origin; their addresses never change.
const ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{64}$/;
export const MODEL_TYPES = ["prop", "piece", "character", "creature", "animation", "scene", "world"];

export function blobURL(name, file, origin = gameOrigin) {
  return `${origin}/blobs/${file.sha256}.${name.split(".").pop()}`;
}

export function modelPath(model) {
  return `/models/${model.id}`;
}

export function validateModels(data) {
  if (!data || !Array.isArray(data.models)) throw new Error("models.json must contain a models array.");
  for (const model of data.models) {
    const valid = model && ID.test(model.id) && MODEL_TYPES.includes(model.type) && ["zh", "en"].every((locale) => typeof model.name?.[locale] === "string") &&
      (model.kit === null || ID.test(model.kit)) && Array.isArray(model.tags) && Array.isArray(model.versions) && model.versions.length &&
      model.versions.every((version) => /^v\d{3}$/.test(version.version) && SHA.test(version.files?.["model.glb"]?.sha256) &&
        Object.values(version.files).every((file) => SHA.test(file.sha256) && Number.isInteger(file.size)));
    if (!valid) throw new Error(`Invalid model entry: ${model?.id}`);
  }
  return data.models;
}

export async function loadModels(signal) {
  const response = await fetch(`${gameOrigin}/models.json`, { cache: "no-store", credentials: "omit", redirect: "error", signal });
  // The console writes the catalog at the first approval; until then the library is empty.
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Model catalog request failed: ${response.status}`);
  return validateModels(await response.json());
}

export function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatSize(size) {
  return size.map((value) => `${Number(value.toFixed(2))}`).join(" × ") + " m";
}
