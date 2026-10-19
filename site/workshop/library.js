// The public model library (docs/library-api.md) for the workshop: search, a model's versions
// and files, and opening one as editable parts — its workshop project file when it has one,
// otherwise its model.glb. The page reads the library from the game origin; Node, which has no
// site of its own, from the public origin (setLibraryOrigin).
import { gameOrigin } from "../game-source.js";
import { loadIndex, loadModel, blobURL, modelPath } from "../models-catalog.js";
import { importModel } from "./import-glb.js";
import { ModelError } from "./mesh.js";

export const PUBLIC_LIBRARY = "https://cdn.fun.dev";
const SITE = "https://fun.dev";
let origin = gameOrigin;
export function setLibraryOrigin(value) {
  origin = value;
}

const indexes = new Map();
async function index(locale) {
  if (!indexes.has(locale))
    indexes.set(
      locale,
      loadIndex(locale, AbortSignal.timeout(30000), origin).catch((e) => {
        indexes.delete(locale);
        throw libraryError(e);
      }),
    );
  return indexes.get(locale);
}
const libraryError = (e) =>
  e instanceof ModelError
    ? e
    : new ModelError(`Model library unavailable: ${e.message}`, "library");
const url = (name, sha256) => blobURL(name, sha256, origin);

/**
 * Listed models matching every word of query (in id, name, tags or description), best first:
 * name and id matches rank above tags, tags above descriptions. Chinese queries search the
 * Chinese index unless locale says otherwise.
 */
export async function searchLibrary({ query = "", type, kit, tags = [], limit = 20, offset = 0, locale } = {}) {
  locale ??= /[㐀-鿿]/.test(query) ? "zh" : "en";
  const { kits, models } = await index(locale);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const m of models) {
    if ((type && m.type !== type) || (kit && m.kit !== kit) || tags.some((t) => !m.tags.includes(t))) continue;
    const name = `${m.id} ${m.name}`.toLowerCase(),
      tagText = m.tags.join(" ").toLowerCase(),
      description = m.description.toLowerCase();
    let score = 0;
    for (const word of words) {
      const s = name.includes(word) ? 4 : tagText.includes(word) ? 2 : description.includes(word) ? 1 : 0;
      if (!s) {
        score = -1;
        break;
      }
      score += s;
    }
    if (score >= 0) scored.push([score, m]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].id.localeCompare(b[1].id));
  const page = scored.slice(offset, offset + limit).map(([, m]) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    type: m.type,
    kit: m.kit,
    tags: m.tags,
    size: m.size,
    version: m.version,
    thumbnail: m.thumbnail ? url("thumbnail.png", m.thumbnail) : null,
    page: SITE + modelPath(m.id),
  }));
  const usedKits = [...new Set(page.map((m) => m.kit).filter(Boolean))];
  return {
    total: scored.length,
    offset,
    models: page,
    kits: Object.fromEntries(usedKits.map((k) => [k, kits[k] ?? ""])),
    licence: "CC0-1.0",
  };
}

async function model(id) {
  let data;
  try {
    data = await loadModel(id, AbortSignal.timeout(15000), origin);
  } catch (e) {
    throw libraryError(e);
  }
  if (!data) throw new ModelError(`${id} is not in the model library`, "not_found", "id");
  return data;
}

/** A model's text in both languages, kit agreement and every approved version with file addresses. */
export async function libraryModel({ id }) {
  const m = await model(id);
  return {
    id: m.id,
    type: m.type,
    name: m.name,
    description: m.description,
    kit: m.kit,
    kitDescription: m.kitDescription ?? null,
    tags: m.tags ?? [],
    listed: m.listed !== false,
    licence: m.licence ?? "CC0-1.0",
    page: SITE + modelPath(m.id),
    versions: m.versions.map((v) => ({
      version: v.version,
      stats: v.stats,
      editable: !!v.files["source.funmodel.glb"],
      files: Object.fromEntries(
        Object.entries(v.files).map(([name, f]) => [name, { url: url(name, f.sha256), sha256: f.sha256, size: f.size }]),
      ),
      // The .fun3d converted from model.glb (docs/model-format.md), once the library made it.
      ...(v.derived?.sha256
        ? { derived: { url: url("model.fun3d", v.derived.sha256), sha256: v.derived.sha256, size: v.derived.size, converter: v.derived.converter, profile: v.derived.profile } }
        : {}),
    })),
  };
}

/**
 * Downloads a version (default: the newest) and reads it like importGLB: the workshop project
 * file when the version has one, else model.glb as parts. The project records where it came
 * from in sources.
 */
export async function importLibraryModel({ id, version, mode = "replace", parent = null, current = null, name } = {}) {
  const m = await model(id);
  const entry = version ? m.versions.find((v) => v.version === version) : m.versions[0];
  if (!entry) throw new ModelError(`${id} has no version ${version}`, "not_found", "version");
  const file = entry.files["source.funmodel.glb"] ? "source.funmodel.glb" : "model.glb";
  const { sha256 } = entry.files[file];
  let bytes;
  try {
    const response = await fetch(url(file, sha256), { credentials: "omit", signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (e) {
    throw libraryError(e);
  }
  const imported = importModel(bytes, { mode, parent, current, name: name ?? `${m.id} ${entry.version}` });
  const source = { kind: "library", id: m.id, version: entry.version, file, sha256 };
  const sources = (imported.project.sources ?? []).filter(
    (s) => !(s.kind === source.kind && s.id === source.id && s.version === source.version),
  );
  imported.project = { ...imported.project, sources: [...sources, source] };
  return { ...imported, source };
}

// "Open in workshop" from a model page.
export async function libraryProject(id, version) {
  return (await importLibraryModel({ id, version })).project;
}
