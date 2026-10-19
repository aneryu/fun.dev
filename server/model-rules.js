import { GLBError, glbSkeleton, glbStats, readGLB } from "./glb.js";

// Rules for library uploads (docs/models-upload.md), shared by the console Worker and its upload
// page and the upload tool, so a local check and the server agree.
export const ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const VERSION = /^v\d{3}$/;
export const FILE = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/;
const TAG = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Categories (docs/models.md). Props, pieces, vehicles and characters are accepted; the others are planned.
export const MODEL_TYPES = ["prop", "piece", "vehicle", "character", "creature", "animation", "scene", "world"];
export const SUPPORTED_TYPES = ["prop", "piece", "vehicle", "character"];
// Stored at upload in the public content-addressed store (docs/models.md); listing a version is
// what makes them part of the library. thumbnail.png is rendered by the upload page; the
// sources are a Blender file or a workshop project (a GLB carrying the editable project).
// Everything else (preview.png, qa.json, readme.md) stays private, for review only.
export const PUBLIC_FILES = ["model.glb", "thumbnail.png", "source.blend", "source.funmodel.glb"];
export const LIMITS = { "model.glb": 10 * 1024 * 1024 };
export const MAX_FILE = 50 * 1024 * 1024;
const PNG = [0x89, 0x50, 0x4e, 0x47];

export const validId = (value) => typeof value === "string" && value.length <= 64 && ID.test(value);
export const validFile = (value) => typeof value === "string" && value.length <= 64 && FILE.test(value);
// Two short sentences at most: what it is, how it looks, where it fits.
export function validDescription(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    ["zh", "en"].every((locale) => typeof value[locale] === "string" && value[locale].trim() && value[locale].length <= 300);
}
export function validName(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    ["zh", "en"].every((locale) => typeof value[locale] === "string" && value[locale].trim() && value[locale].length <= 100);
}
export function validKit(value) { return value === null || value === undefined || (typeof value === "string" && value.length <= 64 && ID.test(value)); }
export function validTags(value) { return value === undefined || (Array.isArray(value) && value.length <= 20 && value.every((tag) => typeof tag === "string" && TAG.test(tag))); }
// Tags every model would have, or that repeat the type or kit, say nothing; uploads drop them.
export const NOISE_TAGS = new Set(["low-poly", "lowpoly", "static", "modular", "architecture", "standalone", "nonfunctional", "empty", "prop", "piece", "character", "rigged", "mixamo"]);
export function cleanTags(tags = [], { type, kit } = {}) {
  return [...new Set(tags)].filter((tag) => !NOISE_TAGS.has(tag) && tag !== type && tag !== kit);
}

// Production jargon belongs in the maker's notes, not in names and descriptions people read.
const JARGON = /低多边形|低模|低面数|静态|视觉模型|视觉模块|视觉组件|外观模型|无品牌|占位|low[- ]?poly|\bstatic\b|visual (?:model|module)|placeholder|unbranded/i;
/** Which of name and description use production jargon. */
export function textIssues({ name, description } = {}) {
  return Object.entries({ name, description }).filter(([, value]) => value && [value.zh, value.en].some((text) => JARGON.test(text ?? ""))).map(([field]) => field);
}
const TEXT_WARNINGS = {
  name: "the name uses production jargon (low-poly, static, visual model…)",
  description: "the description uses production jargon; say what it is, how it looks, where it fits",
};
export const textWarnings = (meta) => textIssues(meta).map((field) => TEXT_WARNINGS[field]);

export function typeProblem(value) {
  if (SUPPORTED_TYPES.includes(value)) return null;
  return MODEL_TYPES.includes(value) ? `type ${value} is planned but not accepted yet` : `type must be one of ${SUPPORTED_TYPES.join(", ")}`;
}

// Characters (docs/models.md): the Mixamo skeleton, so any clip for it plays on any character.
export const CHARACTER_BONES = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
  ...["Left", "Right"].flatMap((side) => ["Shoulder", "Arm", "ForeArm", "Hand", "UpLeg", "Leg", "Foot", "ToeBase"].map((bone) => side + bone))];
export const CHARACTER_LIMITS = { joints: 64 };
export const DISPLAY_POSE = "pose_display";

/** Why a GLB is not a library character (empty when it is one). `json` is the parsed glTF. */
export function characterProblems(json) {
  const skeleton = glbSkeleton(json);
  if (!skeleton) return ["a character needs a skinned mesh on the Mixamo skeleton"];
  const problems = [];
  if (!skeleton.mixamo) problems.push("joints need Mixamo names (mixamorig:Hips, mixamorig:Spine, …)");
  const missing = CHARACTER_BONES.filter((bone) => !skeleton.joints[bone]);
  if (missing.length) problems.push(`the skeleton lacks ${missing.join(", ")}`);
  if (skeleton.count > CHARACTER_LIMITS.joints) problems.push(`${skeleton.count} joints; at most ${CHARACTER_LIMITS.joints}`);
  if (skeleton.moreInfluences) problems.push("at most 4 joint influences per vertex (no JOINTS_1)");
  if (!missing.length) {
    // Rest pose: a T-pose facing +Z, so the character's left hand is out at +x, level with the shoulder.
    for (const [side, sign] of [["Left", 1], ["Right", -1]]) {
      const arm = skeleton.joints[side + "Arm"], hand = skeleton.joints[side + "Hand"];
      const out = (hand[0] - arm[0]) * sign, length = Math.hypot(hand[0] - arm[0], hand[1] - arm[1], hand[2] - arm[2]);
      if (out < 0.8 * length) problems.push(`the rest pose must be a T-pose facing +z (the ${side.toLowerCase()} arm does not point to ${sign > 0 ? "+" : "-"}x)`);
    }
  }
  return problems;
}

/** Character notes that do not block: the display pose used by thumbnails and pages. */
export function characterWarnings(json) {
  const skeleton = glbSkeleton(json);
  return skeleton && !skeleton.animations.includes(DISPLAY_POSE) ? [`no ${DISPLAY_POSE} animation: pages show the T-pose`] : [];
}

/** Review notes on a character version from its stored stats (problems block approval). */
export function characterStatsWarnings(type, stats) {
  if (type !== "character" || !stats) return [];
  if (!stats.character) return ["a character needs a skinned mesh on the Mixamo skeleton"];
  return [...stats.character.problems, ...(stats.character.display ? [] : [`no ${DISPLAY_POSE} animation: pages show the T-pose`])];
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
    if (!validDescription(data.description)) problems.push("meta.json: description needs zh and en texts (at most 300 characters): what it is, how it looks, where it fits");
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
  const extra = [];
  const glb = files.find((file) => file.name === "model.glb");
  if (!glb) problems.push("model.glb is missing");
  else {
    try {
      const json = readGLB(glb.bytes);
      stats = glbStats(json);
      if (data?.type === "character") {
        problems.push(...characterProblems(json).map((problem) => `model.glb: ${problem}`));
        extra.push(...characterWarnings(json));
      }
    } catch (error) { if (error instanceof GLBError) problems.push(`model.glb: ${error.message}`); else throw error; }
  }
  // A workshop source opens editable in /workshop/; without its project it is only another GLB.
  const workshop = files.find((file) => file.name === "source.funmodel.glb");
  if (workshop) {
    try {
      if (!readGLB(workshop.bytes).extensions?.FUNDEV_workshop) extra.push("source.funmodel.glb has no workshop project; it opens as a plain import");
    } catch (error) { if (error instanceof GLBError) problems.push(`source.funmodel.glb: ${error.message}`); else throw error; }
  }
  for (const name of ["thumbnail.png", "preview.png"]) {
    const image = files.find((file) => file.name === name);
    if (image && !PNG.every((byte, index) => image.bytes[index] === byte)) problems.push(`${name} is not a PNG`);
  }
  // The upload page renders thumbnail.png when the browser can; otherwise review adds it.
  const later = files.some((file) => file.name === "thumbnail.png") ? [] : ["no thumbnail yet: it is rendered during review"];
  return { meta: data, files: accepted, stats, problems, warnings: [...(stats ? placementWarnings(stats) : []), ...extra, ...textWarnings(data ?? {}), ...later] };
}
