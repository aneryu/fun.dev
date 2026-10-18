import { GLBError, glbSkeleton, glbStats, readGLB } from "./glb.js";
import { characterProblems, cleanTags, DISPLAY_POSE, LIMITS, MAX_FILE, PUBLIC_FILES, typeProblem, validDescription, validFile, validId, validKit, validName, validTags, VERSION } from "./model-rules.js";

// The model library (docs/models.md). D1 (MODELS_DB) is the one source of truth. Uploads put the
// public files (model.glb, thumbnail.png, source.blend, source.funmodel.glb) straight into the game bucket
// (MODELS_PUBLIC) as content-addressed blobs, whose addresses cannot be guessed, and the rest into
// the private bucket (MODELS_SOURCES). Approving a version lists it. Every change to what is
// listed rewrites the public snapshots in the same request: library/index.<locale>.json and
// library/<id>.json. Used by the console Worker and by scripts/models-admin.mjs.
export { FILE, ID, LIMITS, MAX_FILE, MODEL_TYPES, PUBLIC_FILES, SUPPORTED_TYPES, VERSION, validKit, validName, validTags } from "./model-rules.js";
const MAX_METADATA = 64 * 1024;
export const TYPES = { glb: "model/gltf-binary", fun3d: "application/octet-stream", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", blend: "application/x-blender", json: "application/json", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8" };
export const typeOf = (name) => TYPES[name.split(".").pop()] ?? "application/octet-stream";
const IMMUTABLE = "public, max-age=31536000, immutable";
const SNAPSHOT = "public, max-age=60";
const LOCALES = ["zh", "en"];
const SHA = /^[a-f0-9]{64}$/;

export class ModelError extends Error {
  constructor(code, status = 400, detail) { super(code); this.code = code; this.status = status; this.detail = detail; }
}
const fail = (code, status, detail) => { throw new ModelError(code, status, detail); };
export const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
export function errorResponse(error, label) {
  if (error instanceof ModelError) return json({ error: error.code, ...(error.detail ? { detail: error.detail } : {}) }, error.status);
  console.error(label, { kind: error.name, message: error.message });
  return json({ error: "unavailable" }, 503);
}
const sql = (db, query, ...args) => db.prepare(query).bind(...args);
const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
/** Where a file of a version lives: public files by content, the others under the version. */
export const blobKey = (name, sha256) => `blobs/${sha256}.${name.split(".").pop()}`;
export const sourceKey = (id, version, file) => `models/${id}/${version}/${file}`;

async function readBody(request, maximum) {
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > maximum) fail("too_large", 413, `at most ${maximum} bytes`);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maximum) { await reader.cancel(); fail("too_large", 413, `at most ${maximum} bytes`); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function checkType(value) {
  const problem = typeProblem(value);
  if (problem) fail("invalid_metadata", 400, problem);
}
async function typeLocked(db, id, type) {
  const row = await sql(db, "SELECT m.type FROM models m WHERE m.id=? AND EXISTS (SELECT 1 FROM versions v WHERE v.model=m.id AND v.status='approved')", id).first();
  if (row && row.type !== type) fail("type_locked", 409, "the type cannot change once a version is approved");
}

// A version is pending once the model has a name, a type and a description and the version has
// model.glb. A missing thumbnail does not hold it back (the uploader's browser may not render
// one); review renders it before approving.
const STATUS = `CASE WHEN status='approved' THEN 'approved'
  WHEN (SELECT name IS NOT NULL AND type IS NOT NULL AND description IS NOT NULL FROM models WHERE id=versions.model)
   AND json_extract(files,'$."model.glb"') IS NOT NULL THEN 'pending'
  ELSE 'incomplete' END`;

// Approved versions keep their model.glb and sources for good (games pin them); only the
// thumbnail, a rendering, may be replaced.
async function ensureVersion(db, id, version, now, file) {
  await sql(db, "INSERT INTO models(id,created_at,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING", id, now, now).run();
  await sql(db, "INSERT INTO versions(model,version,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(model,version) DO NOTHING", id, version, now, now).run();
  const row = await sql(db, "SELECT * FROM versions WHERE model=? AND version=?", id, version).first();
  if (row.status === "approved" && file !== "thumbnail.png") fail("approved", 409, "an approved version cannot change; upload a new version");
  return row;
}

export function versionView(row) {
  return { status: row.status, note: row.note ?? null, files: JSON.parse(row.files), stats: row.stats ? JSON.parse(row.stats) : null, derived: row.derived ? JSON.parse(row.derived) : null };
}

function checkAddress(id, version, file) {
  if (!validId(id)) fail("invalid_id", 400, "use <name>_<NN>: lowercase letters, digits and _");
  if (!VERSION.test(version)) fail("invalid_version", 400, "use v and three digits, e.g. v001");
  if (file !== undefined && !validFile(file)) fail("invalid_file_name", 400, "lowercase letters, digits, ., _ and -");
}

/** Status, files and stats of a version. */
export async function getVersion(env, id, version) {
  checkAddress(id, version);
  const row = await sql(env.MODELS_DB, "SELECT * FROM versions WHERE model=? AND version=?", id, version).first();
  if (!row) fail("not_found", 404);
  return versionView(row);
}

/** Stores a version's metadata: name, type, description, kit and tags on the model, other fields as extra. */
export async function putMetadata(env, id, version, data) {
  checkAddress(id, version);
  const db = env.MODELS_DB, now = Date.now();
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("invalid_metadata", 400, "expected an object");
  const { name, type, description, kit = null, tags = [], ...extra } = data;
  if (!validName(name)) fail("invalid_metadata", 400, "name needs non-empty zh and en texts");
  if (!validDescription(description)) fail("invalid_metadata", 400, "description needs zh and en texts (at most 300 characters)");
  checkType(type);
  if (!validKit(kit)) fail("invalid_metadata", 400, "kit uses lowercase letters, digits and _");
  if (!validTags(tags)) fail("invalid_metadata", 400, "tags: up to 20 lowercase words");
  await ensureVersion(db, id, version, now);
  await typeLocked(db, id, type);
  await db.batch([
    sql(db, "UPDATE models SET name=?,type=?,description=?,kit=?,tags=?,extra=?,updated_at=? WHERE id=?", JSON.stringify({ zh: name.zh.trim(), en: name.en.trim() }), type, JSON.stringify({ zh: description.zh.trim(), en: description.en.trim() }), kit, JSON.stringify(cleanTags(tags, { type, kit })), JSON.stringify(extra), now, id),
    sql(db, `UPDATE versions SET status=${STATUS},updated_at=? WHERE model=? AND version=?`, now, id, version),
  ]);
  return getVersion(env, id, version);
}

/**
 * Stores one file of a version: public files in the public bucket by content, the rest privately.
 * The uploader may send the SHA-256 it computed (X-Content-SHA256), which spares the Worker hashing
 * large files; R2 verifies it on write either way. model.glb is checked and measured.
 */
export async function putFile(env, id, version, file, bytes, claimed = null) {
  checkAddress(id, version, file);
  const db = env.MODELS_DB, now = Date.now();
  if (!bytes.length) fail("invalid_request", 400, "the file is empty");
  if (bytes.length > (LIMITS[file] ?? MAX_FILE)) fail("too_large", 413, `at most ${LIMITS[file] ?? MAX_FILE} bytes`);
  if (claimed !== null && !SHA.test(claimed)) fail("invalid_request", 400, "X-Content-SHA256 must be 64 lowercase hex digits");
  let stats = null;
  if (file === "model.glb") {
    try {
      const json = readGLB(bytes);
      stats = { ...glbStats(json), bytes: bytes.length };
      // Skinned files are measured against the character rules; approving a character needs them met.
      const skeleton = glbSkeleton(json);
      if (skeleton) stats.character = { joints: skeleton.count, problems: characterProblems(json), display: skeleton.animations.includes(DISPLAY_POSE) };
    } catch (error) { if (error instanceof GLBError) fail("invalid_glb", 422, error.message); throw error; }
  }
  const row = await ensureVersion(db, id, version, now, file);
  const sha256 = claimed ?? hex(await crypto.subtle.digest("SHA-256", bytes));
  const isPublic = PUBLIC_FILES.includes(file);
  try {
    if (isPublic) await env.MODELS_PUBLIC.put(blobKey(file, sha256), bytes, { httpMetadata: { contentType: typeOf(file), cacheControl: IMMUTABLE }, sha256 });
    else await env.MODELS_SOURCES.put(sourceKey(id, version, file), bytes, { httpMetadata: { contentType: typeOf(file) }, sha256 });
  } catch (error) {
    if (claimed !== null) fail("checksum_mismatch", 400, `the content does not match X-Content-SHA256 (${error.message})`);
    throw error;
  }
  const files = JSON.parse(row.files), previous = files[file];
  // A different model.glb makes the version's thumbnail wrong: it goes, to be rendered again (the
  // upload page sends its thumbnail after the model; review renders missing ones).
  const stale = file === "model.glb" && previous && previous.sha256 !== sha256 ? files["thumbnail.png"] ?? null : null;
  await sql(db, `UPDATE versions SET files=json_set(${stale ? `json_remove(files,'$."thumbnail.png"')` : "files"},'$."'||?||'"',json(?)),${stats ? "stats=?," : ""}updated_at=? WHERE model=? AND version=?`,
    ...[file, JSON.stringify({ sha256, size: bytes.length }), ...(stats ? [JSON.stringify(stats)] : []), now, id, version]).run();
  await sql(db, `UPDATE versions SET status=${STATUS} WHERE model=? AND version=?`, id, version).run();
  // Public files replaced before they were ever listed go, unless another version uses them too.
  const replaced = [isPublic && previous && previous.sha256 !== sha256 && [file, previous.sha256], stale && ["thumbnail.png", stale.sha256]].filter(Boolean);
  for (const [name, old] of replaced) {
    if (row.status !== "approved" && !await sql(db, "SELECT 1 FROM versions WHERE instr(files, ?) > 0 LIMIT 1", old).first()) await env.MODELS_PUBLIC.delete(blobKey(name, old));
  }
  if (row.status === "approved") await publish(env, [id]);
  return getVersion(env, id, version);
}

/**
 * Upload routes under `prefix`: PUT <prefix>/<id>/<version> (JSON metadata),
 * PUT <prefix>/<id>/<version>/<file> (the file), GET <prefix>/<id>/<version> (status).
 * The caller authorises the request.
 */
export async function routeUpload(request, env, path) {
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2 || parts.length > 3) fail("not_found", 404);
  const [id, version, file] = parts;
  checkAddress(id, version, file);
  if (request.method === "GET" && file === undefined) return json(await getVersion(env, id, version));
  if (request.method !== "PUT") fail("method_not_allowed", 405);
  if (file !== undefined) return json(await putFile(env, id, version, file, await readBody(request, LIMITS[file] ?? MAX_FILE), request.headers.get("X-Content-SHA256")));
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") fail("invalid_metadata", 415, "send application/json");
  let data;
  try { data = JSON.parse(new TextDecoder().decode(await readBody(request, MAX_METADATA))); }
  catch (error) { if (error instanceof ModelError) throw error; fail("invalid_metadata", 400, "the body is not valid JSON"); }
  return json(await putMetadata(env, id, version, data));
}

// ── Review ───────────────────────────────────────────────────────────────────

export function modelView(row) {
  return { id: row.id, name: row.name ? JSON.parse(row.name) : null, type: row.type ?? null, description: row.description ? JSON.parse(row.description) : null, kit: row.kit, tags: JSON.parse(row.tags), extra: JSON.parse(row.extra), listed: !!row.listed };
}

/** Versions with their models, newest first; the console shows 1000, maintenance passes { limit: null } for all. */
export async function listVersions(db, status, { limit = 1000 } = {}) {
  const where = status === "all" ? "" : "WHERE v.status=?";
  const { results } = await sql(db, `SELECT v.*, m.name, m.type, m.description, m.kit, m.tags, m.extra, m.listed, m.id FROM versions v JOIN models m ON m.id=v.model ${where} ORDER BY v.updated_at DESC${limit ? ` LIMIT ${Number(limit)}` : ""}`, ...(status === "all" ? [] : [status])).all();
  return results.map((row) => ({ ...modelView(row), version: row.version, ...versionView(row), updated: row.updated_at }));
}

export async function getModel(db, id) {
  const model = await sql(db, "SELECT * FROM models WHERE id=?", id).first();
  if (!model) fail("not_found", 404);
  const { results } = await sql(db, "SELECT * FROM versions WHERE model=? ORDER BY version DESC", id).all();
  return { ...modelView(model), versions: results.map((row) => ({ version: row.version, ...versionView(row), updated: row.updated_at })) };
}

/** Edits a model's name, description, type, kit, tags or listing; listed changes are published unless deferred. */
export async function editModel(env, id, changes, { defer = false } = {}) {
  const db = env.MODELS_DB;
  const model = await sql(db, "SELECT * FROM models WHERE id=?", id).first();
  if (!model) fail("not_found", 404);
  const next = modelView(model);
  if ("description" in changes) { if (!validDescription(changes.description)) fail("invalid_metadata", 400, "description needs zh and en"); next.description = { zh: changes.description.zh.trim(), en: changes.description.en.trim() }; }
  if ("name" in changes) { if (!validName(changes.name)) fail("invalid_metadata", 400, "name needs zh and en"); next.name = { zh: changes.name.zh.trim(), en: changes.name.en.trim() }; }
  if ("type" in changes) { checkType(changes.type); await typeLocked(db, id, changes.type); next.type = changes.type; }
  if ("kit" in changes) { const kit = changes.kit === "" ? null : changes.kit; if (!validKit(kit)) fail("invalid_metadata", 400, "invalid kit"); next.kit = kit ?? null; }
  if ("tags" in changes) { if (!validTags(changes.tags)) fail("invalid_metadata", 400, "invalid tags"); next.tags = changes.tags; }
  if ("listed" in changes) { if (typeof changes.listed !== "boolean") fail("invalid_metadata", 400, "listed is a boolean"); next.listed = changes.listed; }
  next.tags = cleanTags(next.tags, next);
  await sql(db, "UPDATE models SET name=?,type=?,description=?,kit=?,tags=?,listed=?,updated_at=? WHERE id=?", next.name ? JSON.stringify(next.name) : null, next.type, next.description ? JSON.stringify(next.description) : null, next.kit, JSON.stringify(next.tags), next.listed ? 1 : 0, Date.now(), id).run();
  await sql(db, `UPDATE versions SET status=${STATUS} WHERE model=? AND status IN ('incomplete','pending')`, id).run();
  if (!defer && await sql(db, "SELECT 1 FROM versions WHERE model=? AND status='approved'", id).first()) await publish(env, [id]);
  return getModel(db, id);
}

/** Sets a kit's fitting agreement ({zh, en}); its models' pages are republished unless deferred. */
export async function putKit(env, id, description, { defer = false } = {}) {
  if (!validKit(id) || !id) fail("invalid_metadata", 400, "invalid kit");
  if (!validDescription(description)) fail("invalid_metadata", 400, "a kit needs zh and en descriptions");
  await sql(env.MODELS_DB, "INSERT INTO kits(id,description,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET description=excluded.description, updated_at=excluded.updated_at",
    id, JSON.stringify({ zh: description.zh.trim(), en: description.en.trim() }), Date.now()).run();
  const { results } = await sql(env.MODELS_DB, "SELECT DISTINCT m.id FROM models m JOIN versions v ON v.model=m.id WHERE m.kit=? AND v.status='approved'", id).all();
  if (!defer) await publish(env, results.map((row) => row.id));
  return results.map((row) => row.id);
}

export async function rejectVersion(db, id, version, note) {
  if (typeof note !== "string" || note.length > 2000) fail("invalid_request", 400, "note is text up to 2000 characters");
  const result = await sql(db, "UPDATE versions SET status='rejected',note=?,reviewed_at=?,updated_at=? WHERE model=? AND version=? AND status='pending'", note.trim() || null, Date.now(), Date.now(), id, version).run();
  if (!result.meta.changes) fail("not_pending", 409, "only pending versions can be rejected");
}

/** Lists a pending version: its files are already public, so this is a status change. */
export async function approveVersion(env, id, version, { defer = false } = {}) {
  const db = env.MODELS_DB;
  const row = await sql(db, "SELECT * FROM versions WHERE model=? AND version=?", id, version).first();
  if (!row) fail("not_found", 404);
  if (row.status !== "pending") fail("not_pending", 409, "only pending versions can be approved");
  const { type } = await sql(db, "SELECT type FROM models WHERE id=?", id).first();
  if (type === "character") {
    const character = JSON.parse(row.stats ?? "{}").character;
    if (!character) fail("not_a_character", 409, "a character needs a skinned mesh on the Mixamo skeleton");
    if (character.problems.length) fail("not_a_character", 409, character.problems.join("; "));
  }
  const now = Date.now();
  const result = await sql(db, "UPDATE versions SET status='approved',note=NULL,reviewed_at=?,updated_at=? WHERE model=? AND version=? AND status='pending' AND files=?", now, now, id, version, row.files).run();
  if (!result.meta.changes) fail("changed_file", 409, "the version changed during review; reload it");
  if (!defer) await publish(env, [id]);
}

/**
 * The derived .fun3d of an approved version (docs/model-format.md §8), written by the maintenance
 * script: stored by content in the public bucket and recorded with the converter that made it,
 * so games get the same file whether they convert or download. Old derived blobs stay (games
 * may pin them).
 */
export async function putDerived(env, id, version, bytes, { converter, profile, report = null } = {}) {
  checkAddress(id, version, "model.fun3d");
  const db = env.MODELS_DB;
  if (!/^sha256:[0-9a-f]{64}$/.test(converter ?? "") || typeof profile !== "string" || !profile) fail("invalid_request", 400, "a derived file names its converter and profile");
  if (!bytes.length || bytes.length > MAX_FILE) fail("too_large", 413, `at most ${MAX_FILE} bytes`);
  const row = await sql(db, "SELECT status FROM versions WHERE model=? AND version=?", id, version).first();
  if (!row) fail("not_found", 404);
  if (row.status !== "approved") fail("not_approved", 409, "only approved versions have derived files");
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  await env.MODELS_PUBLIC.put(blobKey("model.fun3d", sha256), bytes, { httpMetadata: { contentType: typeOf("model.fun3d"), cacheControl: IMMUTABLE }, sha256 });
  const derived = { sha256, size: bytes.length, converter, profile, at: Date.now(), ...(report ? { report } : {}) };
  // Not a change to the version itself: updated_at (the console's order) stays.
  const result = await sql(db, "UPDATE versions SET derived=json(?) WHERE model=? AND version=? AND status='approved'", JSON.stringify(derived), id, version).run();
  if (!result.meta.changes) fail("changed_file", 409, "the version changed meanwhile");
  return derived;
}

/** A maintainer's one-time type change of an approved model (the console refuses it), republished. */
export async function retypeModel(env, id, type, { defer = false } = {}) {
  checkType(type);
  const result = await sql(env.MODELS_DB, "UPDATE models SET type=?,updated_at=? WHERE id=?", type, Date.now(), id).run();
  if (!result.meta.changes) fail("not_found", 404);
  if (!defer) await publish(env, [id]);
}

// At most this many versions per request, to stay within a Worker invocation's limits.
export const APPROVE_BATCH = 10;

/** Approves several "<id>/<version>" at once and publishes them together. */
export async function approveVersions(env, versions, { limit = APPROVE_BATCH } = {}) {
  if (!Array.isArray(versions) || versions.length > limit || versions.some((value) => typeof value !== "string")) fail("invalid_request", 400, `up to ${limit} "<id>/<version>" strings`);
  const approved = [], failed = [];
  for (const value of versions) {
    const [id, version] = value.split("/");
    if (!validId(id) || !VERSION.test(version ?? "")) { failed.push({ version: value, error: "invalid_id" }); continue; }
    try { await approveVersion(env, id, version, { defer: true }); approved.push(value); }
    catch (error) { if (!(error instanceof ModelError)) throw error; failed.push({ version: value, error: error.code, detail: error.detail ?? null }); }
  }
  if (approved.length) await publish(env, approved.map((value) => value.split("/")[0]));
  return { approved, failed };
}

// ── Public snapshots: library/index.<locale>.json and library/<id>.json ──────

export const INDEX_FIELDS = ["id", "name", "description", "type", "kit", "tags", "size", "version", "thumbnail"];
const round = (value) => Math.round(value * 100) / 100;
const publicFiles = (files) => Object.fromEntries(Object.entries(files).filter(([name]) => PUBLIC_FILES.includes(name)));
// What games need of a derived record: the blob's address and which converter made it.
const publicDerived = (text) => { if (!text) return null; const { sha256, size, converter, profile } = JSON.parse(text); return { sha256, size, converter, profile }; };

/** One model's page data: both languages, every approved version with its public files. */
export async function writeDetail(env, id) {
  const db = env.MODELS_DB;
  const model = await sql(db, "SELECT m.*, k.description AS kit_description FROM models m LEFT JOIN kits k ON k.id=m.kit WHERE m.id=?", id).first();
  const { results } = await sql(db, "SELECT version, files, stats, reviewed_at, derived FROM versions WHERE model=? AND status='approved' ORDER BY version DESC", id).all();
  if (!model || !results.length) { await env.MODELS_PUBLIC.delete(`library/${id}.json`); return; }
  const view = modelView(model);
  const detail = {
    licence: "CC0-1.0", id, name: view.name, description: view.description, type: view.type, kit: view.kit,
    kitDescription: model.kit_description ? JSON.parse(model.kit_description) : null, tags: view.tags, listed: view.listed,
    versions: results.map((row) => ({ version: row.version, files: publicFiles(JSON.parse(row.files)), stats: JSON.parse(row.stats), approved: row.reviewed_at, derived: publicDerived(row.derived) })),
  };
  await env.MODELS_PUBLIC.put(`library/${id}.json`, JSON.stringify(detail), { httpMetadata: { contentType: "application/json", cacheControl: SNAPSHOT } });
}

/** The compact indexes: listed models with their newest approved version, one model per line. */
export async function writeIndexes(env) {
  const db = env.MODELS_DB;
  const { results } = await sql(db, `SELECT m.id, m.name, m.description, m.type, m.kit, m.tags, v.version, v.files, v.stats FROM models m
    JOIN versions v ON v.model=m.id AND v.status='approved'
    WHERE m.listed=1 AND m.name IS NOT NULL AND v.version=(SELECT MAX(version) FROM versions WHERE model=m.id AND status='approved')
    ORDER BY m.id`).all();
  const used = new Set(results.map((row) => row.kit).filter(Boolean));
  const kits = (await sql(db, "SELECT id, description FROM kits ORDER BY id").all()).results.filter((kit) => used.has(kit.id));
  for (const locale of LOCALES) {
    const text = (value) => (value ? JSON.parse(value)[locale] : "");
    const rows = results.map((row) => {
      const files = JSON.parse(row.files);
      return [row.id, text(row.name), text(row.description), row.type, row.kit ?? "", JSON.parse(row.tags).join(" "), JSON.parse(row.stats).size.map(round), row.version, files["thumbnail.png"]?.sha256 ?? ""];
    });
    const body = `{"licence":"CC0-1.0","fields":${JSON.stringify(INDEX_FIELDS)},\n"kits":${JSON.stringify(Object.fromEntries(kits.map((kit) => [kit.id, text(kit.description)])))},\n"models":[\n${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]}\n`;
    await env.MODELS_PUBLIC.put(`library/index.${locale}.json`, body, { httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: SNAPSHOT } });
  }
  return results.length;
}

/** Runs task on every item, a few at a time (each page is two queries and a write; reviews list hundreds). */
export async function eachLimited(items, limit, task) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => { while (queue.length) await task(queue.shift()); }));
}

/** Rewrites the given models' pages and the indexes, as part of the change that needs it. */
export async function publish(env, ids = []) {
  await eachLimited(new Set(ids), 6, (id) => writeDetail(env, id));
  return writeIndexes(env);
}

/** Every model with an approved version, for a full rebuild. */
export async function publishedIds(db) {
  return (await sql(db, "SELECT DISTINCT model FROM versions WHERE status='approved' ORDER BY model").all()).results.map((row) => row.model);
}
