import { ModelError } from "./mesh.js";
import { STUDIO, previewQuality } from "./preview-quality.js";
const fail = (message, id = "") => { throw new ModelError(message, "view_preset", `viewPresets.${id}`); };
const vec = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const size = n => Number.isInteger(n) && n >= 64 && n <= 2048;
export function normalizeViewPresets(input = [], nodes = []) {
  if (!Array.isArray(input) || input.length > 64) fail("Expected at most 64 view presets");
  const names = new Set(), ids = new Set(nodes.map(n => n.id));
  return input.map(p => {
    if (!p || p.version !== 1 || typeof p.id !== "string" || !p.id.trim() || p.id.length > 128 || names.has(p.id))
      fail("Presets need version 1 and unique nonempty ids");
    names.add(p.id);
    if (!["front", "back", "left", "right", "top", "perspective", "current"].includes(p.view) || !size(p.size) || !size(p.height))
      fail("Choose a standard view and fixed width/height of 64–2048 pixels", p.id);
    if (p.ids !== undefined && (!Array.isArray(p.ids) || !p.ids.length || new Set(p.ids).size !== p.ids.length || p.ids.some(id => !ids.has(id))))
      fail("Preset has missing or duplicate node dependencies; update it before deleting nodes", p.id);
    const c = p.camera;
    if (!c || !vec(c.position) || !vec(c.target) || !vec(c.up) || !["orthographic", "perspective"].includes(c.projection) ||
        !(c.near > 0 && c.far > c.near && Number.isFinite(c.far)) || !(c.zoom > 0 && Number.isFinite(c.zoom)) ||
        Math.hypot(...c.up) < 1e-8 || Math.hypot(...c.position.map((v, i) => v - c.target[i])) < 1e-8)
      fail("Preset needs a recorded, nondegenerate camera with valid clipping and zoom", p.id);
    if (c.projection === "perspective" ? !(c.fov > 0 && c.fov < 180) : !(Number.isFinite(c.top) && Number.isFinite(c.bottom) && c.top > c.bottom))
      fail("Invalid camera field of view or orthographic extent", p.id);
    const camera = Object.fromEntries(["position", "target", "up", "projection", "near", "far", "zoom",
      ...(c.projection === "perspective" ? ["fov"] : ["top", "bottom"])].map(k => [k, structuredClone(c[k])]));
    const s = p.studio, keys = ["left", "right", "top", "bottom", "near", "far"];
    if (!s || s.id !== STUDIO.id || !vec(s.keyPosition) || !vec(s.keyTarget) || keys.some(k => !Number.isFinite(s.shadowCamera?.[k])))
      fail("Preset needs the current recorded studio setup; recapture unsupported studio versions", p.id);
    const shadow = s.shadowCamera;
    if (!(shadow.near > 0 && shadow.far > shadow.near && shadow.right > shadow.left && shadow.top > shadow.bottom) ||
        Math.hypot(...s.keyPosition.map((v, i) => v - s.keyTarget[i])) < 1e-8)
      fail("Preset needs nondegenerate shadow framing and light direction", p.id);
    let quality;
    try { quality = previewQuality(p, p.size, p.height); }
    catch (error) { fail(error.message, p.id); }
    if (!["material", "clay", "silhouette", "ids"].includes(p.shading ?? "material")) fail("Unknown preset shading", p.id);
    return { version: 1, id: p.id, view: p.view, size: p.size, height: p.height,
      ...(p.ids ? { ids: [...p.ids] } : {}), camera,
      studio: { id: s.id, keyPosition: [...s.keyPosition], keyTarget: [...s.keyTarget], shadowCamera: { ...s.shadowCamera } },
      antialias: quality.antialias, shadows: quality.shadows, lighting: "studio", exposure: quality.exposure,
      shading: p.shading ?? "material" };
  });
}
export function viewPresetCommand(project, command) {
  const old = project.viewPresets ?? [];
  if (command.op === "removeViewPreset" && !old.some(p => p.id === command.id)) fail("Unknown preset", command.id);
  project.viewPresets = normalizeViewPresets([...old.filter(p => p.id !== command.id),
    ...(command.op === "viewPreset" ? [{ ...command.definition, id: command.id, version: 1 }] : [])], project.nodes);
  if (!project.viewPresets.length) delete project.viewPresets;
}
export function resolveViewPreset(project, id) {
  const preset = project.viewPresets?.find(p => p.id === id);
  if (!preset) fail("Unknown view preset; inspect viewPresets", id);
  const { version, id: name, view, size, ...render } = preset;
  return { view, size, render: { ...structuredClone(render), helpers: false, visibility: "all",
    overlays: { wire: false, selection: false, data: false } }, metadata: structuredClone(preset) };
}
export function presetFromObservation(shot, id) {
  return { id, version: 1, view: shot.view, size: shot.width, height: shot.height,
    ...(shot.observation?.visibleIds?.length ? { ids: [...new Set(shot.observation.visibleIds)] } : {}),
    camera: shot.camera, studio: shot.quality.lightingSetup, ...Object.fromEntries(
      ["antialias", "shadows", "lighting", "exposure"].map(k => [k, shot.quality[k]])), shading: shot.shading };
}
