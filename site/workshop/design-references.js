// Portable reference versions and design decisions. Images are embedded local
// data, never fetched. Record ids identify immutable versions, not mutable slots.
import { ModelError } from "./mesh.js";
const fail = (message, path = "designReferences") => { throw new ModelError(message, "reference", path); };
const text = (v, path, max = 4000) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) fail(`Expected nonempty text, at most ${max} characters`, path);
  return v;
};
const id = v => text(v, "id", 128);
export function normalizeDesignReferences(input) {
  if (input === undefined) return undefined;
  if (input?.version !== 1 || !Array.isArray(input.records) || input.records.length > 128 ||
      !Array.isArray(input.selected)) fail("Expected version 1, up to 128 records, and selected image ids");
  const records = [], byId = new Map();
  let imageBytes = 0;
  for (const r of input.records) {
    if (!r || typeof r !== "object") fail("Expected a reference record object");
    const key = id(r.id);
    if (byId.has(key)) fail(`Duplicate reference record ${key}`);
    if (!["image", "feature", "decision"].includes(r.kind)) fail(`Unknown reference kind ${r.kind}`);
    const entry = { id: key, kind: r.kind, text: text(r.text, `${key}.text`) };
    if (r.kind === "image") {
      if (!["user", "generated", "render", "external"].includes(r.origin)) fail(`Invalid image origin ${key}`);
      if (typeof r.image !== "string" || r.image.length > 8 * 1024 * 1024 ||
          !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(r.image)) fail(`Expected embedded image up to 8 MB for ${key}`);
      imageBytes += r.image.length;
      if (imageBytes > 32 * 1024 * 1024) fail("Reference images exceed 32 MB; keep fewer versions");
      Object.assign(entry, { image: r.image, origin: r.origin });
    } else {
      if (!Array.isArray(r.references) || r.references.some(ref => byId.get(ref)?.kind !== "image") ||
          new Set(r.references).size !== r.references.length) fail(`${key} needs unique existing image-version references`);
      entry.references = [...r.references];
      if (r.kind === "feature") {
        if (!["proposed", "accepted", "rejected"].includes(r.status)) fail(`Invalid feature status ${key}`);
        entry.status = r.status;
        if (r.status !== "proposed") entry.evidence = text(r.evidence, `${key}.evidence`);
      }
    }
    if (r.supersedes !== undefined) {
      if (byId.get(r.supersedes)?.kind !== r.kind || records.some(e => e.supersedes === r.supersedes))
        fail(`${key} must supersede an existing, not already superseded record of the same kind`);
      entry.supersedes = r.supersedes;
      entry.reason = text(r.reason, `${key}.reason`);
      if (byId.get(r.supersedes).status === "accepted" && entry.status === "proposed")
        fail("A proposal cannot replace an accepted feature; retain it until a new explicit decision");
    }
    records.push(entry); byId.set(key, entry);
  }
  if (new Set(input.selected).size !== input.selected.length || input.selected.some(ref => byId.get(ref)?.kind !== "image"))
    fail("Selected references must be unique existing image-version ids");
  return { version: 1, records, selected: [...input.selected] };
}
export function designReferenceCommand(project, command) {
  const history = structuredClone(project.designReferences ?? { version: 1, records: [], selected: [] });
  if (command.op === "referenceRecord") {
    const old = history.records.find(r => r.id === command.definition?.id);
    if (old) fail(`Reference record ${old.id} already exists; append a new version with supersedes and reason`);
    history.records.push(command.definition);
  } else history.selected = command.ids;
  project.designReferences = normalizeDesignReferences(history);
}
export function designReferenceSummary(project) {
  const history = project.designReferences;
  if (!history) return null;
  return { version: history.version, selected: [...history.selected],
    records: history.records.map(({ image, ...r }) => ({ ...r, ...(image ? { imageBytes: image.length } : {}) })) };
}
export function mergeDesignReferences(base, incoming) {
  if (!incoming) return base;
  const result = structuredClone(base ?? { version: 1, records: [], selected: [] });
  const names = new Map(), used = new Set(result.records.map(r => r.id));
  for (const r of incoming.records) {
    let key = r.id, suffix = 1;
    while (used.has(key)) key = `${r.id.slice(0, 110)}_${suffix++}`;
    names.set(r.id, key); used.add(key);
  }
  result.records.push(...incoming.records.map(r => ({ ...r, id: names.get(r.id),
    ...(r.references ? { references: r.references.map(ref => names.get(ref)) } : {}),
    ...(r.supersedes ? { supersedes: names.get(r.supersedes) } : {}) })));
  result.selected.push(...incoming.selected.map(ref => names.get(ref)));
  return normalizeDesignReferences(result);
}
