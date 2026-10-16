import { GLBError, glbStats, readGLB } from "./glb.js";
import { LIMITS, MAX_FILE, PUBLIC_FILES, typeProblem, validDescription, validFile, validId, validKit, validName, validTags, VERSION } from "./model-rules.js";

// The model library (docs/models.md): uploads and review for the console Worker on
// console.fun.dev. D1 (MODELS_DB) holds the
// catalog; uploads stay in the private bucket (MODELS_SOURCES) until approval copies the
// public files to the game bucket (MODELS_PUBLIC) as content-addressed blobs.
export { FILE, ID, LIMITS, MAX_FILE, MODEL_TYPES, PUBLIC_FILES, SUPPORTED_TYPES, VERSION, validKit, validName, validTags } from "./model-rules.js";
const MAX_METADATA = 64 * 1024;
export const TYPES = { glb: "model/gltf-binary", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", blend: "application/x-blender", json: "application/json", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8" };
export const typeOf = (name) => TYPES[name.split(".").pop()] ?? "application/octet-stream";

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
const sourceKey = (id, version, file) => `models/${id}/${version}/${file}`;
const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

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
// model.glb and thumbnail.png.
const STATUS = `CASE WHEN status='approved' THEN 'approved'
  WHEN (SELECT name IS NOT NULL AND type IS NOT NULL AND description IS NOT NULL FROM models WHERE id=versions.model)
   AND json_extract(files,'$."model.glb"') IS NOT NULL AND json_extract(files,'$."thumbnail.png"') IS NOT NULL THEN 'pending'
  ELSE 'incomplete' END`;

async function ensureVersion(db, id, version, now) {
  await sql(db, "INSERT INTO models(id,created_at,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING", id, now, now).run();
  await sql(db, "INSERT INTO versions(model,version,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(model,version) DO NOTHING", id, version, now, now).run();
  const row = await sql(db, "SELECT status FROM versions WHERE model=? AND version=?", id, version).first();
  if (row.status === "approved") fail("approved", 409, "approved versions cannot change");
}

export function versionView(row) {
  return { status: row.status, note: row.note ?? null, files: JSON.parse(row.files), stats: row.stats ? JSON.parse(row.stats) : null };
}

function checkAddress(id, version, file) {
  if (!validId(id)) fail("invalid_id", 400, "use <name>_<NN>: lowercase letters, digits and _");
  if (!VERSION.test(version)) fail("invalid_version", 400, "use v and three digits, e.g. v001");
  if (file !== undefined && !validFile(file)) fail("invalid_file_name", 400, "lowercase letters, digits, ., _ and -");
}

/** Status, files and stats of a version, for the pipeline. */
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
    sql(db, "UPDATE models SET name=?,type=?,description=?,kit=?,tags=?,extra=?,updated_at=? WHERE id=?", JSON.stringify({ zh: name.zh.trim(), en: name.en.trim() }), type, JSON.stringify({ zh: description.zh.trim(), en: description.en.trim() }), kit, JSON.stringify(tags), JSON.stringify(extra), now, id),
    sql(db, `UPDATE versions SET status=${STATUS},updated_at=? WHERE model=? AND version=?`, now, id, version),
  ]);
  return getVersion(env, id, version);
}

/** Stores one file of a version in the private bucket; model.glb is checked and measured. */
export async function putFile(env, id, version, file, bytes) {
  checkAddress(id, version, file);
  const db = env.MODELS_DB, now = Date.now();
  if (!bytes.length) fail("invalid_request", 400, "the file is empty");
  if (bytes.length > (LIMITS[file] ?? MAX_FILE)) fail("too_large", 413, `at most ${LIMITS[file] ?? MAX_FILE} bytes`);
  let stats = null;
  if (file === "model.glb") {
    try { stats = { ...glbStats(readGLB(bytes)), bytes: bytes.length }; }
    catch (error) { if (error instanceof GLBError) fail("invalid_glb", 422, error.message); throw error; }
  }
  await ensureVersion(db, id, version, now);
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  await env.MODELS_SOURCES.put(sourceKey(id, version, file), bytes, { httpMetadata: { contentType: typeOf(file) }, sha256 });
  const entry = JSON.stringify({ sha256, size: bytes.length });
  await sql(db, `UPDATE versions SET files=json_set(files,'$."'||?||'"',json(?)),${stats ? "stats=?," : ""}updated_at=? WHERE model=? AND version=? AND status!='approved'`,
    ...[file, entry, ...(stats ? [JSON.stringify(stats)] : []), now, id, version]).run();
  await sql(db, `UPDATE versions SET status=${STATUS} WHERE model=? AND version=?`, id, version).run();
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
  if (file !== undefined) return json(await putFile(env, id, version, file, await readBody(request, LIMITS[file] ?? MAX_FILE)));
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") fail("invalid_metadata", 415, "send application/json");
  let data;
  try { data = JSON.parse(new TextDecoder().decode(await readBody(request, MAX_METADATA))); }
  catch (error) { if (error instanceof ModelError) throw error; fail("invalid_metadata", 400, "the body is not valid JSON"); }
  return json(await putMetadata(env, id, version, data));
}

// ── Review (console) ─────────────────────────────────────────────────────────

export function modelView(row) {
  return { id: row.id, name: row.name ? JSON.parse(row.name) : null, type: row.type ?? null, description: row.description ? JSON.parse(row.description) : null, kit: row.kit, tags: JSON.parse(row.tags), extra: JSON.parse(row.extra), listed: !!row.listed };
}

export async function listVersions(db, status) {
  const where = status === "all" ? "" : "WHERE v.status=?";
  const { results } = await sql(db, `SELECT v.*, m.name, m.type, m.description, m.kit, m.tags, m.extra, m.listed, m.id FROM versions v JOIN models m ON m.id=v.model ${where} ORDER BY v.updated_at DESC LIMIT 500`, ...(status === "all" ? [] : [status])).all();
  return results.map((row) => ({ ...modelView(row), version: row.version, ...versionView(row), updated: row.updated_at }));
}

export async function getModel(db, id) {
  const model = await sql(db, "SELECT * FROM models WHERE id=?", id).first();
  if (!model) fail("not_found", 404);
  const { results } = await sql(db, "SELECT * FROM versions WHERE model=? ORDER BY version DESC", id).all();
  return { ...modelView(model), versions: results.map((row) => ({ version: row.version, ...versionView(row), updated: row.updated_at })) };
}

export async function editModel(env, id, changes) {
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
  await sql(db, "UPDATE models SET name=?,type=?,description=?,kit=?,tags=?,listed=?,updated_at=? WHERE id=?", next.name ? JSON.stringify(next.name) : null, next.type, next.description ? JSON.stringify(next.description) : null, next.kit, JSON.stringify(next.tags), next.listed ? 1 : 0, Date.now(), id).run();
  await sql(db, `UPDATE versions SET status=${STATUS} WHERE model=? AND status IN ('incomplete','pending')`, id).run();
  if (await sql(db, "SELECT 1 FROM versions WHERE model=? AND status='approved'", id).first()) await writeCatalog(env);
  return getModel(db, id);
}

export async function rejectVersion(db, id, version, note) {
  if (typeof note !== "string" || note.length > 2000) fail("invalid_request", 400, "note is text up to 2000 characters");
  const result = await sql(db, "UPDATE versions SET status='rejected',note=?,reviewed_at=?,updated_at=? WHERE model=? AND version=? AND status='pending'", note.trim() || null, Date.now(), Date.now(), id, version).run();
  if (!result.meta.changes) fail("not_pending", 409, "only pending versions can be rejected");
}

// Copies the public files to blobs/<sha256>.<ext> (never overwritten, never deleted), marks the
// version approved, and rewrites the public catalog.
export async function approveVersion(env, id, version, { catalog = true } = {}) {
  const db = env.MODELS_DB;
  const row = await sql(db, "SELECT * FROM versions WHERE model=? AND version=?", id, version).first();
  if (!row) fail("not_found", 404);
  if (row.status !== "pending") fail("not_pending", 409, "only pending versions can be approved");
  const files = JSON.parse(row.files);
  for (const name of PUBLIC_FILES) {
    if (!files[name]) continue;
    const { sha256 } = files[name], key = `blobs/${sha256}.${name.split(".").pop()}`;
    if (await env.MODELS_PUBLIC.head(key)) continue;
    const object = await env.MODELS_SOURCES.get(sourceKey(id, version, name));
    if (!object) fail("missing_file", 409, `${name} is missing from storage`);
    const bytes = await object.arrayBuffer();
    if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== sha256) fail("changed_file", 409, `${name} changed since upload; upload it again`);
    await env.MODELS_PUBLIC.put(key, bytes, { httpMetadata: { contentType: typeOf(name), cacheControl: "public, max-age=31536000, immutable" }, sha256 });
  }
  const now = Date.now();
  const result = await sql(db, "UPDATE versions SET status='approved',note=NULL,reviewed_at=?,updated_at=? WHERE model=? AND version=? AND status='pending' AND files=?", now, now, id, version, row.files).run();
  if (!result.meta.changes) fail("changed_file", 409, "the version changed during review; reload it");
  if (catalog) await writeCatalog(env);
}

// At most this many versions per request, to stay within a Worker invocation's limits.
export const APPROVE_BATCH = 10;

/** Approves several "<id>/<version>" at once; the catalog is rewritten once, when asked. */
export async function approveVersions(env, versions, { catalog = true } = {}) {
  if (!Array.isArray(versions) || versions.length > APPROVE_BATCH || versions.some((value) => typeof value !== "string")) fail("invalid_request", 400, `up to ${APPROVE_BATCH} "<id>/<version>" strings`);
  const approved = [], failed = [];
  for (const value of versions) {
    const [id, version] = value.split("/");
    if (!validId(id) || !VERSION.test(version ?? "")) { failed.push({ version: value, error: "invalid_id" }); continue; }
    try { await approveVersion(env, id, version, { catalog: false }); approved.push(value); }
    catch (error) { if (!(error instanceof ModelError)) throw error; failed.push({ version: value, error: error.code, detail: error.detail ?? null }); }
  }
  if (catalog) await writeCatalog(env);
  return { approved, failed };
}

/** The public catalog: listed models with their approved versions, newest first. */
export async function buildCatalog(db) {
  const { results } = await sql(db, `SELECT m.id, m.name, m.type, m.description, m.kit, m.tags, v.version, v.files, v.stats, v.reviewed_at FROM models m
    JOIN versions v ON v.model=m.id WHERE m.listed=1 AND m.name IS NOT NULL AND v.status='approved' ORDER BY m.id, v.version DESC`).all();
  const models = [];
  for (const row of results) {
    const files = Object.fromEntries(Object.entries(JSON.parse(row.files)).filter(([name]) => PUBLIC_FILES.includes(name)));
    const version = { version: row.version, files, stats: JSON.parse(row.stats), approved: row.reviewed_at };
    const last = models.at(-1);
    if (last?.id === row.id) last.versions.push(version);
    else models.push({ id: row.id, name: JSON.parse(row.name), type: row.type, description: row.description ? JSON.parse(row.description) : null, kit: row.kit, tags: JSON.parse(row.tags), versions: [version] });
  }
  // Kits in use, with their fitting agreement.
  const used = new Set(models.map((model) => model.kit).filter(Boolean));
  const kits = Object.fromEntries((await sql(db, "SELECT id, description FROM kits ORDER BY id").all()).results
    .filter((kit) => used.has(kit.id)).map((kit) => [kit.id, JSON.parse(kit.description)]));
  return { licence: "CC0-1.0", kits, models };
}

export async function writeCatalog(env) {
  await env.MODELS_PUBLIC.put("models.json", JSON.stringify(await buildCatalog(env.MODELS_DB)), { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } });
}
