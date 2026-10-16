import { GLBError, glbStats, readGLB } from "./glb.js";

// Rules for library uploads (docs/models-api.md), shared by the upload API, the console's upload
// page and the upload tool, so a local check and the server agree.
export const ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const VERSION = /^v\d{3}$/;
export const FILE = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/;
const TAG = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Categories (docs/models.md). Only the static ones are accepted so far; the others are planned.
export const MODEL_TYPES = ["prop", "piece", "character", "creature", "animation", "scene", "world"];
export const SUPPORTED_TYPES = ["prop", "piece"];
// Published with an approved version; other uploads (qa.json, README.md, more previews) stay private.
export const PUBLIC_FILES = ["model.glb", "preview.png", "source.blend"];
export const LIMITS = { "model.glb": 10 * 1024 * 1024 };
export const MAX_FILE = 50 * 1024 * 1024;
const PNG = [0x89, 0x50, 0x4e, 0x47];

export const validId = (value) => typeof value === "string" && value.length <= 64 && ID.test(value);
export const validFile = (value) => typeof value === "string" && value.length <= 64 && FILE.test(value);
export function validName(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    ["zh", "en"].every((locale) => typeof value[locale] === "string" && value[locale].trim() && value[locale].length <= 100);
}
export function validKit(value) { return value === null || value === undefined || (typeof value === "string" && value.length <= 64 && ID.test(value)); }
export function validTags(value) { return value === undefined || (Array.isArray(value) && value.length <= 20 && value.every((tag) => typeof tag === "string" && TAG.test(tag))); }
export function typeProblem(value) {
  if (SUPPORTED_TYPES.includes(value)) return null;
  return MODEL_TYPES.includes(value) ? `type ${value} is planned but not accepted yet` : `type must be one of ${SUPPORTED_TYPES.join(", ")}`;
}

/** The production spec's placement: standing on y = 0, centred on x and z. */
export function placementWarnings(stats) {
  const warnings = [];
  if (Math.abs(stats.min[1]) > 0.001) warnings.push(`lowest point at y = ${stats.min[1]} m, not on the floor`);
  for (const [axis, index] of [["x", 0], ["z", 2]]) {
    const center = (stats.min[index] + stats.max[index]) / 2;
    if (Math.abs(center) > 0.01) warnings.push(`${axis} centre is ${center.toFixed(3)} m off`);
  }
  return warnings;
}

/**
 * Checks one prepared version before upload. `meta` is the text of meta.json (or null when
 * missing); `files` are the other files as { name, bytes }. Problems block the upload.
 */
export function inspectVersion({ id, version, meta, files }) {
  const problems = [];
  if (!validId(id)) problems.push(`id ${id}: use <name>_<NN>, lowercase letters, digits and _`);
  if (!VERSION.test(version)) problems.push(`version ${version}: use v and three digits`);
  let data = null;
  if (meta === null) problems.push("meta.json is missing");
  else {
    try { data = JSON.parse(meta); } catch { problems.push("meta.json is not valid JSON"); }
    if (data !== null && (typeof data !== "object" || Array.isArray(data))) { problems.push("meta.json must be an object"); data = null; }
  }
  if (data) {
    if (!validName(data.name)) problems.push("meta.json: name needs non-empty zh and en texts (at most 100 characters)");
    const type = typeProblem(data.type);
    if (type) problems.push(`meta.json: ${type}`);
    if (!validKit(data.kit ?? null)) problems.push("meta.json: kit uses lowercase letters, digits and _");
    if (!validTags(data.tags)) problems.push("meta.json: tags are up to 20 lowercase words");
  }
  const accepted = [];
  for (const file of files) {
    const limit = LIMITS[file.name] ?? MAX_FILE;
    if (!validFile(file.name)) problems.push(`${file.name}: file names use lowercase letters, digits, ., _ and -`);
    else if (file.bytes.length > limit) problems.push(`${file.name}: larger than ${limit} bytes`);
    else accepted.push(file);
  }
  let stats = null;
  const glb = files.find((file) => file.name === "model.glb");
  if (!glb) problems.push("model.glb is missing");
  else {
    try { stats = glbStats(readGLB(glb.bytes)); }
    catch (error) { if (error instanceof GLBError) problems.push(`model.glb: ${error.message}`); else throw error; }
  }
  const preview = files.find((file) => file.name === "preview.png");
  if (!preview) problems.push("preview.png is missing");
  else if (!PNG.every((byte, index) => preview.bytes[index] === byte)) problems.push("preview.png is not a PNG");
  return { meta: data, files: accepted, stats, problems, warnings: stats ? placementWarnings(stats) : [] };
}
