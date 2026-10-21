import { ModelError } from "./mesh.js";
import { quaternionRotation } from "./rotation-keys.js";
import { normalizeCharacter } from "./character.js";

const fail = (message, path, code = "invalid_glb") => {
  const error = new ModelError(message, code, path);
  error.retryable = false;
  error.suggestion = "Export TRS/morph tracks using LINEAR or STEP, at most 4096 keys per track and 120 seconds per clip. No animation was partially applied.";
  throw error;
};
export function importAnimations(json, read, nodesByIndex, processing, warn) {
  if (!json.animations?.length) return undefined;
  if (json.animations.length > 64) fail("At most 64 animation clips can be imported", "animations", "budget");
  const character = { version: 3, controls: [], values: {}, rest: {}, clips: [] }, names = new Set();
  for (const [index, animation] of json.animations.entries()) {
    const path = `animations.${index}`, tracks = [];
    if (!Array.isArray(animation.channels) || !Array.isArray(animation.samplers)) fail("Missing channels or samplers", path);
    if (!animation.channels.length) { warn("animations", `Empty animation ${index} was skipped`); continue; }
    let duration = 0;
    for (const [ci, channel] of animation.channels.entries()) {
      const cp = `${path}.channels.${ci}`, sampler = animation.samplers[channel.sampler];
      const node = nodesByIndex.get(channel.target?.node);
      if (!node) fail("Animation target is outside the imported scene or missing", cp);
      const type = channel.target.path, interpolation = sampler?.interpolation ?? "LINEAR";
      if (!["translation", "rotation", "scale", "weights"].includes(type))
        fail(`Unsupported animation path ${type}`, cp, "unsupported");
      if (!sampler || !["LINEAR", "STEP"].includes(interpolation))
        fail(`Unsupported animation interpolation ${interpolation}; no curve was approximated`, cp, "unsupported");
      const ia = json.accessors?.[sampler.input], oa = json.accessors?.[sampler.output];
      const width = type === "weights" ? node.morph?.targets.length : type === "rotation" ? 4 : 3;
      if (!width) fail("Weight animation has no imported morph targets", cp);
      if (!ia || ia.type !== "SCALAR" || ia.componentType !== 5126 || ia.count < 1 || ia.count > 4096 ||
          !oa || oa.componentType !== 5126 || oa.type !== (type === "weights" ? "SCALAR" : type === "rotation" ? "VEC4" : "VEC3") ||
          oa.count !== ia.count * (type === "weights" ? width : 1))
        fail("Animation accessors require matching FLOAT counts and valid scalar/vector types", cp);
      const times = Array.from(read(sampler.input)), values = Array.from(read(sampler.output));
      if (times.some((v, i) => !Number.isFinite(v) || v < 0 || v > 120 || (i && v <= times[i-1])) ||
          values.some(v => !Number.isFinite(v))) fail("Animation times must increase within 0–120 seconds and values must be finite", cp);
      duration = Math.max(duration, times.at(-1));
      character.rest[node.id] ??= { position: [...node.position], rotation: [...node.rotation], scale: [...node.scale],
        ...(node.morph ? { weights: { ...node.morph.weights } } : {}) };
      const keyValues = times.map((time, i) => {
        const value = values.slice(i*width, (i+1)*width);
        if (type === "rotation") {
          const norm = Math.hypot(...value);
          if (Math.abs(norm-1) > 1e-4) fail(`Rotation key ${i} quaternion length ${norm}; expected 1 ± 0.0001`, cp);
          return quaternionRotation(value);
        }
        if (type === "scale" && value.some(v => v <= 0)) fail("Animated scale must remain positive", cp, "unsupported");
        if (type === "weights" && value.some(v => v < 0 || v > 1)) fail("Editable morph weights must stay in 0–1", cp, "unsupported");
        return value;
      });
      if (type === "weights") node.morph.targets.forEach((target, k) => tracks.push({
        node: node.id, channel: "morph", target: target.name, interpolation: interpolation.toLowerCase(),
        keys: times.map((time, i) => ({ time, value: keyValues[i][k] })),
      }));
      else tracks.push({ node: node.id, channel: type === "translation" ? "position" : type,
        interpolation: type === "rotation" && interpolation === "LINEAR" ? "slerp" : interpolation.toLowerCase(),
        keys: times.map((time, i) => ({ time, value: keyValues[i] })) });
      if (tracks.length > 256) fail("Expanded animation exceeds 256 authoring tracks", path, "budget");
    }
    if (!duration) fail("Animation must have positive duration", path, "unsupported");
    const base = String(animation.name ?? `clip_${index}`).replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 48) || `clip_${index}`;
    let name = base, suffix = 1;
    while (names.has(name)) name = `${base}_${suffix++}`;
    names.add(name);
    character.clips.push({ name, duration, fps: Number.isInteger(animation.extras?.bakeFps) && animation.extras.bakeFps >= 1 && animation.extras.bakeFps <= 60 ? animation.extras.bakeFps : 30,
      loop: animation.extras?.loop === "repeat", tracks });
    processing.push({ animation: index, clip: name, preservedTracks: tracks.length, rotationInterpolation: "shortest-arc quaternion",
      loopSource: animation.extras?.loop ? "extras.loop" : "unspecified: play once" });
  }
  return character.clips.length ? normalizeCharacter(character, [...nodesByIndex.values()]) : undefined;
}
