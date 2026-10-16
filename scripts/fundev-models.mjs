import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { chmod, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectVersion, VERSION } from "../server/model-rules.js";

// fundev-models: the command-line tool for the fun.dev model library (docs/models-api.md).
// The build also publishes it as one self-contained file, https://cdn.fun.dev/tools/fundev-models.mjs,
// for machines without this repository (Node 20 or later; `unzip` for .zip inputs).
//
//   fundev-models login                      store the upload token (read from stdin, never echoed)
//   fundev-models check <folder|zip>...      check prepared models locally (no token, no network)
//   fundev-models upload <folder|zip>... [--only id,id] [--token-file path]
//   fundev-models status <id> <version> [--token-file path]   review status and note
//
// Every <id>/<version>/ folder inside (at any depth, so a zip's top folder is fine) holds
// meta.json, model.glb, preview.png and optional files; several zips (a large Drive download
// comes in parts) are merged. Upload checks each version first and skips files the server
// already has (same SHA-256), so a run can be repeated after a failure. Whoever prepares models
// never needs to read the token: the tool reads it (--token-file, MODELS_TOKEN_FILE, MODELS_TOKEN,
// the login file or /workspace/token) and never prints it.
export const DEFAULT_API = "https://api.fun.dev/api/models";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const IGNORED = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** Every <id>/<version>/ directory below root, as { id, version, directory }. */
export async function findVersions(root) {
  const found = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
      const path = join(directory, entry.name);
      // A version folder is reported even under an invalid id, so the check can say why.
      if (VERSION.test(entry.name)) found.push({ id: basename(directory), version: entry.name, directory: path });
      else await walk(path);
    }
  }
  await walk(root);
  return found.sort((a, b) => `${a.id}/${a.version}`.localeCompare(`${b.id}/${b.version}`));
}

/** Checks one prepared folder with the server's rules. */
export async function inspect(directory, id, version) {
  let meta = null;
  const files = [], problems = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED.has(entry.name)) continue;
    if (!entry.isFile()) { problems.push(`${entry.name}: only files are uploaded`); continue; }
    const bytes = new Uint8Array(await readFile(join(directory, entry.name)));
    if (entry.name === "meta.json") meta = new TextDecoder().decode(bytes);
    else files.push({ name: entry.name, bytes });
  }
  const result = inspectVersion({ id, version, meta, files });
  return { ...result, problems: [...problems, ...result.problems] };
}

const tokenFile = (env = process.env) => join(env.FUNDEV_CONFIG_DIR || join(homedir(), ".config/fundev"), "models-token");
// The token comes from --token-file, MODELS_TOKEN_FILE, MODELS_TOKEN, the login file or
// /workspace/token (where the model pipeline keeps it), in that order.
const WORKSPACE_TOKEN = "/workspace/token";
export async function readToken(env = process.env, file = null) {
  const path = file || env.MODELS_TOKEN_FILE;
  if (path) {
    try { return (await readFile(path, "utf8")).trim() || null; }
    catch { throw new Error(`Cannot read the token file ${path}.`); }
  }
  if (env.MODELS_TOKEN) return env.MODELS_TOKEN.trim();
  for (const candidate of [tokenFile(env), WORKSPACE_TOKEN]) {
    try { const token = (await readFile(candidate, "utf8")).trim(); if (token) return token; }
    catch { /* Try the next place. */ }
  }
  return null;
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
const fatal = (message) => Object.assign(new Error(message), { fatal: true });

/** Checks and (unless dryRun) uploads every version found under root; returns report rows. */
export async function uploadAll({ root, api = DEFAULT_API, token, dryRun = false, only = null, log = console.log }) {
  const rows = [];
  for (const { id, version, directory } of await findVersions(root)) {
    if (only && !only.includes(id)) continue;
    const { meta, files, stats, problems, warnings } = await inspect(directory, id, version);
    const row = { id, version, type: meta?.type ?? null, kit: meta?.kit ?? null, size: stats?.size ?? null, triangles: stats?.triangles ?? null, warnings, problems, status: problems.length ? "not_uploaded" : dryRun ? "checked" : null, uploaded: [], skipped: [] };
    rows.push(row);
    const notes = warnings.length ? ` (warning: ${warnings.join("; ")})` : "";
    if (problems.length || dryRun) { log(`${problems.length ? "✗" : "✓"} ${id} ${version}${problems.length ? `: ${problems.join("; ")}` : ""}${notes}`); continue; }
    const base = `${api}/${id}/${version}`, auth = { Authorization: `Bearer ${token}` };
    try {
      let response = await call(base, { headers: auth });
      if (response.status === 401) throw fatal("unauthorized: the token is wrong; stopping");
      const current = response.ok ? await response.json() : null;
      if (current?.status === "approved") { row.status = "approved"; log(`= ${id} ${version}: already approved, skipped`); continue; }
      response = await call(base, { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(meta) });
      if (!response.ok) throw new Error(`metadata: ${await response.text()}`);
      for (const file of files) {
        if (current?.files?.[file.name]?.sha256 === sha(file.bytes)) { row.skipped.push(file.name); continue; }
        response = await call(`${base}/${file.name}`, { method: "PUT", headers: auth, body: file.bytes });
        if (response.status === 401) throw fatal("unauthorized: the token is wrong; stopping");
        if (!response.ok) throw new Error(`${file.name}: ${await response.text()}`);
        row.uploaded.push(file.name);
      }
      const final = await (await call(base, { headers: auth })).json();
      row.status = final.status;
      log(`✓ ${id} ${version}: ${final.status}, ${final.stats.size.join(" × ")} m, ${final.stats.triangles} triangles${notes}`);
    } catch (error) {
      row.status = "error";
      row.problems.push(error.message);
      log(`✗ ${id} ${version}: ${error.message}`);
      if (error.fatal) return rows;
    }
  }
  return rows;
}

const USAGE = `fundev-models: the fun.dev model library tool

  fundev-models login                       store the upload token (paste it, then Enter)
  fundev-models check <folder|zip>...       check prepared models locally
  fundev-models upload <folder|zip>... [--only id,id] [--token-file path]
  fundev-models status <id> <version> [--token-file path]

The token is read from --token-file, MODELS_TOKEN_FILE, MODELS_TOKEN, the login file or
/workspace/token; it is never printed. Inside each folder or zip: <id>/<version>/ with meta.json, model.glb, preview.png and optional
files (source.blend, qa.json, readme.md, more previews). Rules: https://github.com/aneryu/fun.dev/blob/main/docs/models-api.md`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function run(inputs, { dryRun, only, tokenPath }) {
  if (!inputs.length) { console.error(USAGE); return 1; }
  const token = dryRun ? null : await readToken(process.env, tokenPath);
  if (!dryRun && !token) { console.error("No token: put it in /workspace/token, or run `fundev-models login`."); return 1; }
  // Zips are unpacked into one new, empty folder; folders are read in place.
  const zips = inputs.filter((input) => input.toLowerCase().endsWith(".zip"));
  const folders = inputs.filter((input) => !zips.includes(input));
  const unpacked = zips.length ? await mkdtemp(join(tmpdir(), "fundev-models-")) : null;
  const rows = [];
  try {
    for (const zip of zips) execFileSync("unzip", ["-q", "-o", zip, "-d", unpacked], { stdio: ["ignore", "ignore", "inherit"] });
    for (const root of [...folders, ...(unpacked ? [unpacked] : [])]) {
      if (!(await stat(root)).isDirectory()) throw new Error(`Not a folder or .zip: ${root}`);
      rows.push(...await uploadAll({ root, api: process.env.MODELS_API || DEFAULT_API, token, dryRun, only }));
    }
  } finally {
    if (unpacked) await rm(unpacked, { recursive: true, force: true });
  }
  if (!rows.length) console.log("No <id>/<version>/ folders found.");
  const report = join(folders[0] ?? dirname(zips[0]), "upload-report.json");
  await writeFile(report, JSON.stringify({ at: new Date().toISOString(), dryRun, inputs, rows }, null, 2) + "\n");
  const count = (status) => rows.filter((row) => row.status === status).length;
  console.log(`\n${rows.length} versions: ${dryRun ? `${count("checked")} ready` : `${count("pending")} pending, ${count("approved")} already approved, ${count("incomplete")} incomplete`}, ${count("not_uploaded")} failed local checks, ${count("error")} errors. Report: ${report}`);
  return rows.some((row) => ["not_uploaded", "error"].includes(row.status)) ? 1 : 0;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  const option = (name) => rest.includes(name) ? rest[rest.indexOf(name) + 1] : null;
  const only = option("--only")?.split(",") ?? null, tokenPath = option("--token-file");
  const inputs = rest.filter((arg, index) => !arg.startsWith("--") && !["--only", "--token-file"].includes(rest[index - 1])).map((arg) => resolve(arg));
  if (command === "check") return run(inputs, { dryRun: true, only });
  if (command === "upload") return run(inputs, { dryRun: false, only, tokenPath });
  if (command === "login") {
    if (process.stdin.isTTY) process.stdout.write("Paste the upload token, then press Enter (it is not shown): ");
    const token = process.stdin.isTTY ? await new Promise((done) => {
      process.stdin.setRawMode(true);
      let value = "";
      process.stdin.on("data", (key) => {
        const text = key.toString("utf8");
        if (text === "\u0003") process.exit(1);
        if (text === "\r" || text === "\n") { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); done(value.trim()); }
        else value += text;
      });
    }) : await readStdin();
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) { console.error("That does not look like an upload token."); return 1; }
    const file = tokenFile();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, `${token}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    const response = await fetch(`${process.env.MODELS_API || DEFAULT_API}/token_check_00/v000`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    console.log(response?.status === 401 ? `Saved to ${file}, but the server rejects this token.` : `Saved to ${file}.`);
    return response?.status === 401 ? 1 : 0;
  }
  if (command === "logout") { await rm(tokenFile(), { force: true }); console.log("Token removed."); return 0; }
  if (command === "status" && inputs.length === 2) {
    const token = await readToken(process.env, tokenPath);
    if (!token) { console.error("No token: put it in /workspace/token, or run `fundev-models login`."); return 1; }
    const [id, version] = rest.filter((arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--token-file");
    const response = await call(`${process.env.MODELS_API || DEFAULT_API}/${id}/${version}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) { console.error(`${response.status} ${data.error}${data.detail ? `: ${data.detail}` : ""}`); return 1; }
    console.log(`${id} ${version}: ${data.status}${data.note ? `\nnote: ${data.note}` : ""}\nfiles: ${Object.keys(data.files).join(", ")}${data.stats ? `\nsize: ${data.stats.size.join(" × ")} m, ${data.stats.triangles} triangles` : ""}`);
    return 0;
  }
  console.log(USAGE);
  return ["help", "--help"].includes(command) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)).catch((error) => { console.error(error.message); return 1; }));
}
