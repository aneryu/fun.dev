import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GLBError, glbStats, readGLB } from "../server/glb.js";
import { FILE, ID, LIMITS, MAX_FILE, SUPPORTED_TYPES, VERSION, validKit, validName, validTags } from "../server/models.js";

// Uploads prepared models to the library (docs/models-api.md), so whoever prepares them never
// handles the token: npm run models:upload -- <root> [--dry-run] [--only id,id]
//
// <root>/<id>/<version>/ holds meta.json, model.glb, preview.png and optional files
// (source.blend, qa.json, readme.md, more previews). Every version is checked locally first;
// files the server already has (same SHA-256) are skipped, so a run can be repeated after a
// failure. The token comes from MODELS_TOKEN or ~/.config/fundev/models-token and is never
// printed. The result is written to <root>/upload-report.json.
export const DEFAULT_API = "https://api.fun.dev/api/models";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PNG = [0x89, 0x50, 0x4e, 0x47];

/** Checks one prepared version; returns { meta, files: [{ name, bytes }], stats, problems }. */
export async function inspect(directory, id, version) {
  const problems = [];
  if (id.length > 64 || !ID.test(id)) problems.push(`id ${id}: use <name>_<NN>, lowercase letters, digits and _`);
  if (!VERSION.test(version)) problems.push(`version ${version}: use v and three digits`);
  let meta = null;
  try { meta = JSON.parse(await readFile(join(directory, "meta.json"), "utf8")); }
  catch { problems.push("meta.json is missing or not valid JSON"); }
  if (meta) {
    if (!validName(meta.name)) problems.push("meta.json: name needs non-empty zh and en texts (at most 100 characters)");
    if (!SUPPORTED_TYPES.includes(meta.type)) problems.push(`meta.json: type must be one of ${SUPPORTED_TYPES.join(", ")}`);
    if (!validKit(meta.kit ?? null)) problems.push("meta.json: kit uses lowercase letters, digits and _");
    if (!validTags(meta.tags)) problems.push("meta.json: tags are up to 20 lowercase words");
  }
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "meta.json") continue;
    if (!entry.isFile()) { problems.push(`${entry.name}: only files are uploaded`); continue; }
    if (entry.name.length > 64 || !FILE.test(entry.name)) { problems.push(`${entry.name}: file names use lowercase letters, digits, ., _ and -`); continue; }
    const limit = LIMITS[entry.name] ?? MAX_FILE;
    if ((await stat(join(directory, entry.name))).size > limit) { problems.push(`${entry.name}: larger than ${limit} bytes`); continue; }
    files.push({ name: entry.name, bytes: await readFile(join(directory, entry.name)) });
  }
  let stats = null;
  const glb = files.find((file) => file.name === "model.glb");
  if (!glb) problems.push("model.glb is missing");
  else {
    try { stats = glbStats(readGLB(new Uint8Array(glb.bytes))); }
    catch (error) { if (error instanceof GLBError) problems.push(`model.glb: ${error.message}`); else throw error; }
  }
  const preview = files.find((file) => file.name === "preview.png");
  if (!preview) problems.push("preview.png is missing");
  else if (!PNG.every((byte, index) => preview.bytes[index] === byte)) problems.push("preview.png is not a PNG");
  // Uploads go through regardless; review shows these.
  const warnings = [];
  if (stats) {
    if (Math.abs(stats.min[1]) > 0.001) warnings.push(`lowest point at y = ${stats.min[1]} m, not on the floor`);
    for (const [axis, index] of [["x", 0], ["z", 2]]) {
      const center = (stats.min[index] + stats.max[index]) / 2;
      if (Math.abs(center) > 0.01) warnings.push(`${axis} centre is ${center.toFixed(3)} m off`);
    }
  }
  return { meta, files, stats, problems, warnings };
}

export async function readToken(env = process.env) {
  if (env.MODELS_TOKEN) return env.MODELS_TOKEN.trim();
  try { return (await readFile(join(homedir(), ".config/fundev/models-token"), "utf8")).trim(); }
  catch { return null; }
}

async function call(url, options, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(120000) }); }
    catch (error) { if (attempt >= attempts) throw error; await new Promise((done) => setTimeout(done, 2000 * attempt)); continue; }
    if (response.status < 500 || attempt >= attempts) return response;
    await new Promise((done) => setTimeout(done, 2000 * attempt));
  }
}

/** Uploads every version under root; returns the report rows. */
export async function uploadAll({ root, api = DEFAULT_API, token, dryRun = false, only = null, log = console.log }) {
  const rows = [];
  for (const id of (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    if (only && !only.includes(id)) continue;
    for (const version of (await readdir(join(root, id), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
      const { meta, files, stats, problems, warnings } = await inspect(join(root, id, version), id, version);
      const row = { id, version, type: meta?.type ?? null, kit: meta?.kit ?? null, size: stats?.size ?? null, triangles: stats?.triangles ?? null, warnings, problems, status: problems.length ? "not_uploaded" : dryRun ? "checked" : null, uploaded: [], skipped: [] };
      rows.push(row);
      if (problems.length || dryRun) { log(`${problems.length ? "✗" : "✓"} ${id} ${version}${problems.length ? `: ${problems.join("; ")}` : ""}${warnings.length ? ` (warning: ${warnings.join("; ")})` : ""}`); continue; }
      const base = `${api}/${id}/${version}`, auth = { Authorization: `Bearer ${token}` };
      try {
        let response = await call(base, { headers: auth });
        if (response.status === 401) throw Object.assign(new Error("unauthorized: the token is wrong; stopping"), { fatal: true });
        const current = response.ok ? await response.json() : null;
        if (current?.status === "approved") { row.status = "approved"; log(`= ${id} ${version}: already approved, skipped`); continue; }
        response = await call(base, { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(meta) });
        if (!response.ok) throw new Error(`metadata: ${await response.text()}`);
        for (const file of files) {
          if (current?.files?.[file.name]?.sha256 === sha(file.bytes)) { row.skipped.push(file.name); continue; }
          response = await call(`${base}/${file.name}`, { method: "PUT", headers: auth, body: file.bytes });
          if (response.status === 401) throw Object.assign(new Error("unauthorized: the token is wrong; stopping"), { fatal: true });
          if (!response.ok) throw new Error(`${file.name}: ${await response.text()}`);
          row.uploaded.push(file.name);
        }
        const final = await (await call(base, { headers: auth })).json();
        row.status = final.status;
        log(`✓ ${id} ${version}: ${final.status}, ${final.stats.size.join(" × ")} m, ${final.stats.triangles} triangles${warnings.length ? ` (warning: ${warnings.join("; ")})` : ""}`);
      } catch (error) {
        row.status = "error";
        row.problems.push(error.message);
        log(`✗ ${id} ${version}: ${error.message}`);
        if (error.fatal) return rows;
      }
    }
  }
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const root = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--only");
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1]?.split(",") : null;
  const dryRun = args.includes("--dry-run");
  if (!root) {
    console.error("Usage: npm run models:upload -- <root> [--dry-run] [--only id,id]\n<root>/<id>/<version>/ holds meta.json, model.glb, preview.png and optional files.");
    process.exit(1);
  }
  const token = dryRun ? null : await readToken();
  if (!dryRun && !token) { console.error("No token: set MODELS_TOKEN or create ~/.config/fundev/models-token."); process.exit(1); }
  const rows = await uploadAll({ root: resolve(root), api: process.env.MODELS_API || DEFAULT_API, token, dryRun, only });
  const report = resolve(root, "upload-report.json");
  await writeFile(report, JSON.stringify({ at: new Date().toISOString(), dryRun, rows }, null, 2) + "\n");
  const count = (status) => rows.filter((row) => row.status === status).length;
  console.log(`\n${rows.length} versions: ${dryRun ? `${count("checked")} ready` : `${count("pending")} pending, ${count("approved")} already approved, ${count("incomplete")} incomplete`}, ${count("not_uploaded")} failed local checks, ${count("error")} errors. Report: ${report}`);
  process.exit(rows.some((row) => ["not_uploaded", "error"].includes(row.status)) ? 1 : 0);
}
