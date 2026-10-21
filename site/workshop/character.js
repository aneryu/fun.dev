// Persisted controls and clips, independent of renderer. Metres, XYZ Euler
// degrees, dimensionless scale and 0..1 morph/control weights.
import { ModelError, vector } from "./mesh.js";
import { slerpRotation } from "./rotation-keys.js";

const fail = (message, path = "character") => { throw new ModelError(message, "character", path); };
const clone = value => structuredClone(value);
const named = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const channelValue = (channel, value) => channel === "morph" || channel === "control"
  ? (Number.isFinite(value) && value >= 0 && value <= 1 ? value : fail("Weights must be 0..1"))
  : vector(value);
function target(nodes, binding) {
  const n = nodes.find(n => n.id === binding.node);
  if (!n) fail(`Missing driven node ${binding.node}`);
  if (!["position", "rotation", "scale", "morph"].includes(binding.channel)) fail("Unknown character channel");
  if (n.symmetry || n.instanceOf) fail("Character channels require independent nodes");
  if (binding.channel === "morph" && !n.morph?.targets.some(t => t.name === binding.target))
    fail(`Missing morph ${binding.node}.${binding.target}`);
  if (n.attachment && (n.attachment.mode === "deform" || binding.channel === "position" ||
      (n.attachment.mode === "frame" && ["rotation", "scale"].includes(binding.channel))))
    fail(`Character ${binding.channel} on ${n.id} is driven by a surface attachment; drive its target or a child pivot`, `nodes.${n.id}.attachment`);
  return n;
}
export function normalizeCharacter(input, nodes) {
  if (input === undefined) return undefined;
  if (!input || ![1, 2, 3].includes(input.version)) fail("Unsupported character data version");
  const c = clone(input);
  if (c.pose === undefined) delete c.pose;
  if (!Array.isArray(c.controls) || c.controls.length > 64 || !Array.isArray(c.clips) || c.clips.length > 64 ||
      !c.rest || !c.values || typeof c.values !== "object") fail("Invalid character controls/clips/rest");
  const ids = new Set();
  for (const control of c.controls) {
    if (!named(control.id) || ids.has(control.id) || !Array.isArray(control.bindings) || !control.bindings.length || control.bindings.length > 256)
      fail("Controls need unique names and 1–256 bindings");
    ids.add(control.id);
    for (const b of control.bindings) {
      target(nodes, b);
      if (b.channel === "morph") {
        if (!Number.isFinite(b.gain) || b.gain < -1 || b.gain > 1) fail("Morph gain is -1..1");
      } else b.delta = vector(b.delta);
    }
  }
  for (const [id, value] of Object.entries(c.values)) {
    if (!ids.has(id)) fail(`Unknown control ${id}`);
    channelValue("control", value);
  }
  for (const control of c.controls) for (const b of control.bindings)
    if (b.attenuateBy !== undefined && (c.version < 2 || !ids.has(b.attenuateBy)))
      fail(`Binding ${control.id}:${b.node} needs character version 2 and an existing attenuation control ${b.attenuateBy}`);
  const clipNames = new Set();
  for (const clip of c.clips) {
    if (!named(clip.name) || clipNames.has(clip.name) || !Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 120 ||
        !Number.isInteger(clip.fps) || clip.fps < 1 || clip.fps > 60 ||
        typeof clip.loop !== "boolean" || !Array.isArray(clip.tracks) || clip.tracks.length > 256)
      fail("Clips need a unique name, duration (0,120], fps 1–60 and up to 256 tracks");
    clipNames.add(clip.name);
    const tracks = new Set();
    for (const t of clip.tracks) {
      if (t.control) {
        if (!ids.has(t.control)) fail(`Clip references missing control ${t.control}`);
        if (t.node || t.channel !== "control") fail("Control tracks cannot also target nodes");
      } else target(nodes, t);
      const key = `${t.control ?? t.node}:${t.channel}:${t.target ?? ""}`;
      if (tracks.has(key)) fail("Duplicate clip channel"); tracks.add(key);
      if (!["linear", "step", "slerp"].includes(t.interpolation) || !Array.isArray(t.keys) || !t.keys.length || t.keys.length > 4096)
        fail("Track needs 1–4096 keys and linear/step/slerp interpolation");
      if (t.interpolation === "slerp" && (c.version < 3 || t.channel !== "rotation"))
        fail("Slerp requires character version 3 and a rotation channel");
      let previous = -1;
      for (const k of t.keys) {
        if (!Number.isFinite(k.time) || k.time < 0 || k.time > clip.duration || k.time <= previous) fail("Key times must increase within clip duration");
        previous = k.time; k.value = channelValue(t.channel, k.value);
      }
    }
  }
  const needed = new Set([...c.controls.flatMap(x => x.bindings.map(b => b.node)),
    ...c.clips.flatMap(x => x.tracks.filter(t => !t.control).map(t => t.node))]);
  for (const id of needed) {
    const rest = c.rest[id], n = nodes.find(n => n.id === id);
    if (!rest || !n) fail(`Missing rest state for ${id}`);
    for (const key of ["position", "rotation", "scale"]) rest[key] = vector(rest[key]);
    if (rest.scale.some(v => v <= 0)) fail("Rest scale must be positive");
    for (const [name, w] of Object.entries(rest.weights ?? {})) {
      if (!n.morph?.targets.some(t => t.name === name)) fail(`Rest state references missing morph ${name}`);
      channelValue("morph", w);
    }
  }
  for (const id of Object.keys(c.rest)) if (!needed.has(id)) delete c.rest[id];
  if (c.pose) {
    if (!clipNames.has(c.pose.clip) || !Number.isFinite(c.pose.time) || c.pose.time < 0)
      fail("Pose needs an existing clip and a nonnegative time");
  }
  return c;
}
const restOf = n => ({ position: [...n.position], rotation: [...n.rotation], scale: [...n.scale],
  ...(n.morph ? { weights: { ...n.morph.weights } } : {}) });
export function resetCharacter(project) {
  for (const [id, r] of Object.entries(project.character?.rest ?? {})) {
    const n = project.nodes.find(n => n.id === id);
    if (!n) fail(`Missing character node ${id}`);
    for (const k of ["position", "rotation", "scale"]) n[k] = [...r[k]];
    if (n.morph) n.morph.weights = { ...(r.weights ?? {}) };
  }
}
export function refreshCharacterRest(project) {
  if (!project.character) return;
  for (const id of Object.keys(project.character.rest)) {
    const n = project.nodes.find(n => n.id === id);
    if (!n) fail(`Remove character dependencies before deleting ${id}`);
    project.character.rest[id] = restOf(n);
  }
}
export function sampleKeys(track, time) {
  const keys = track.keys;
  if (time <= keys[0].time) return clone(keys[0].value);
  for (let i = 1; i < keys.length; i++) if (time < keys[i].time) {
    const a = keys[i - 1], b = keys[i], t = (time - a.time) / (b.time - a.time);
    if (track.interpolation === "step") return clone(a.value);
    if (track.interpolation === "slerp") return slerpRotation(a.value, b.value, t);
    return Array.isArray(a.value) ? a.value.map((v, k) => v + (b.value[k] - v) * t) : a.value + (b.value - a.value) * t;
  }
  return clone(keys.at(-1).value);
}
export function applyCharacter(project) {
  const c = project.character;
  if (!c) return;
  resetCharacter(project);
  const values = { ...c.values }, direct = [];
  if (c.pose) {
    const clip = c.clips.find(x => x.name === c.pose.clip);
    const time = clip.loop && c.pose.time > clip.duration ? c.pose.time % clip.duration : Math.min(c.pose.time, clip.duration);
    for (const t of clip.tracks) {
      const value = sampleKeys(t, time);
      if (t.control) values[t.control] = value;
      else direct.push([t, value]);
    }
  }
  for (const control of c.controls) {
    for (const b of control.bindings) {
      // Both inputs are resolved scalar control values, not evaluated binding
      // outputs. Mutual references are therefore order-independent, not cycles.
      const w = (values[control.id] ?? 0) * (b.attenuateBy === undefined ? 1 : 1 - (values[b.attenuateBy] ?? 0));
      const n = target(project.nodes, b);
      if (b.channel === "morph") n.morph.weights[b.target] = Math.max(0, Math.min(1, (n.morph.weights[b.target] ?? 0) + b.gain * w));
      else n[b.channel] = n[b.channel].map((v, k) => v + b.delta[k] * w);
    }
  }
  for (const [t, value] of direct) {
    const n = target(project.nodes, t);
    if (t.channel === "morph") n.morph.weights[t.target] = value;
    else n[t.channel] = value;
  }
  for (const n of project.nodes) if (n.scale.some(v => v <= 0)) fail("Character pose produced a nonpositive scale");
}
export function characterCommand(project, command) {
  const c = project.character ??= { version: 1, controls: [], values: {}, rest: {}, clips: [] };
  const capture = id => {
    const n = project.nodes.find(n => n.id === id);
    if (!n) fail(`Missing character node ${id}`);
    c.rest[id] ??= restOf(n);
  };
  switch (command.op) {
    case "characterControl":
      if (command.bindings.some(b => b.attenuateBy !== undefined)) c.version = Math.max(c.version, 2);
      for (const b of command.bindings) capture(b.node);
      c.controls = [...c.controls.filter(x => x.id !== command.id), { id: command.id, bindings: clone(command.bindings) }];
      break;
    case "characterValues": c.values = { ...c.values, ...command.values }; delete c.pose; break;
    case "characterClip": {
      if (command.tracks.some(t => t.interpolation === "slerp")) c.version = 3;
      const clip = { name: command.name, duration: command.duration, fps: command.fps ?? 30,
        loop: command.loop ?? true, tracks: clone(command.tracks).map(t => ({ ...t, interpolation: t.interpolation ?? "linear" })) };
      for (const t of clip.tracks) if (!t.control) capture(t.node);
      c.clips = [...c.clips.filter(x => x.name !== clip.name), clip]; break;
    }
    case "characterPose":
      if (command.name) c.pose = { clip: command.name, time: command.time ?? 0 };
      else delete c.pose;
      break;
    case "characterRemove":
      if (command.kind === "control") { c.controls = c.controls.filter(x => x.id !== command.id); delete c.values[command.id]; }
      else { c.clips = c.clips.filter(x => x.name !== command.id); if (c.pose?.clip === command.id) delete c.pose; }
      break;
    default: fail("Unknown character command");
  }
  project.character = normalizeCharacter(c, project.nodes);
}
