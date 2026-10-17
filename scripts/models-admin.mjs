import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { characterStatsWarnings, inspectVersion, placementWarnings, textWarnings, VERSION } from "../server/model-rules.js";
import { approveVersion, blobKey, eachLimited, editModel, listVersions, publish, publishedIds, putFile, putKit, putMetadata, rejectVersion, sourceKey } from "../server/models.js";

// Maintenance for the model library (docs/models.md), run by the maintainer: the console's own
// functions against the live database and storage, through Wrangler's remote bindings
// (wrangler.models-admin.jsonc, your Wrangler login). Nothing here is reachable from the web.
//
//   npm run models -- list [pending|rejected|approved|incomplete|all]
//   npm run models -- sheet [status]          contact sheets of those versions in test-results/models-review/
//   npm run models -- thumbnails [status] [--all]   render missing (or all) thumbnails, as the upload page does
//   npm run models -- apply <plan.json> [--dry-run]
//   npm run models -- rebuild                 rewrite every model's page data and the indexes
//   npm run models -- upload <folder>         upload <id>/<version>/ folders found in it, as the console does
//
// list, sheet and thumbnails also take --only id,id to look at some models only.
//
// A plan is one reviewed file: { "kits": { id: { zh, en } }, "models": { id: { name, description,
// type, kit, tags, listed } }, "reject": { "id/version": "note" }, "approve": ["id/version"] }.
// It is applied in that order and published once at the end.
const root = fileURLToPath(new URL("../", import.meta.url));

export function warningsOf(item) {
  if (!item.stats) return ["no model.glb"];
  return [
    ...(item.files["thumbnail.png"] ? [] : ["no thumbnail"]),
    ...(item.description ? [] : ["no description"]),
    ...placementWarnings(item.stats),
    ...characterStatsWarnings(item.type, item.stats),
    ...textWarnings(item),
  ];
}

/** Applies a reviewed plan; returns what happened. Publishing waits for the end. */
export async function applyPlan(env, plan, { dryRun = false, log = console.log } = {}) {
  const touched = new Set(), report = { kits: [], models: [], rejected: [], approved: [], failed: [] };
  const attempt = async (label, action) => {
    try { if (!dryRun) await action(); return true; }
    catch (error) { report.failed.push({ item: label, error: error.code ?? error.message, detail: error.detail ?? null }); log(`✗ ${label}: ${error.detail ?? error.code ?? error.message}`); return false; }
  };
  for (const [id, description] of Object.entries(plan.kits ?? {})) {
    if (await attempt(`kit ${id}`, async () => { for (const model of await putKit(env, id, description, { defer: true })) touched.add(model); })) report.kits.push(id);
  }
  for (const [id, changes] of Object.entries(plan.models ?? {})) {
    if (await attempt(`model ${id}`, async () => { await editModel(env, id, changes, { defer: true }); touched.add(id); })) report.models.push(id);
  }
  for (const [value, note] of Object.entries(plan.reject ?? {})) {
    const [id, version] = value.split("/");
    if (await attempt(`reject ${value}`, () => rejectVersion(env.MODELS_DB, id, version, note))) report.rejected.push(value);
  }
  await eachLimited(plan.approve ?? [], 6, async (value) => {
    const [id, version] = value.split("/");
    if (await attempt(`approve ${value}`, async () => { await approveVersion(env, id, version, { defer: true }); touched.add(id); })) report.approved.push(value);
  });
  // Only models with an approved version have public pages.
  const approved = new Set(await publishedIds(env.MODELS_DB));
  const published = [...touched].filter((id) => approved.has(id));
  if (!dryRun && published.length) report.listed = await publish(env, published);
  return report;
}

// A page in the built site with the library's viewer, for rendering models in a headless browser.
// It lives under /models so it gets the model pages' policy, which lets the glTF loader read
// embedded textures through Blob URLs.
async function withViewer(task) {
  const { launch, serve, dist } = await import("./browser/harness.mjs");
  try { await readFile(resolve(dist, "model-viewer.js")); }
  catch { throw new Error("Build the site first: npm run build."); }
  const work = resolve(dist, "models", "review-sheet");
  await mkdir(work, { recursive: true });
  await writeFile(join(work, "index.html"), `<!doctype html><body><div id="s"></div><script type="module" src="/models/review-sheet/render.js"></script>`);
  await writeFile(join(work, "render.js"), `import { createViewer, renderThumbnail } from "/model-viewer.js";
const stage = document.querySelector("#s"); Object.assign(stage.style, { width: "320px", height: "320px", background: "#fff7d6" }); document.body.style.margin = "0";
const viewer = createViewer(stage); window.show = (url) => viewer.load(url);
window.thumbnail = async (base64) => { const png = await renderThumbnail(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))); let text = ""; for (const byte of png) text += String.fromCharCode(byte); return btoa(text); };`);
  const site = await serve(), browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 320 } });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${site.base}/models/review-sheet/index.html`);
    await page.waitForFunction(() => window.show && window.thumbnail);
    return await task({ page, browser, work });
  } finally {
    await browser.close();
    site.close();
    await rm(work, { recursive: true, force: true });
  }
}

async function modelBytes(env, item) {
  const entry = item.files["model.glb"];
  const object = entry && (await env.MODELS_PUBLIC.get(blobKey("model.glb", entry.sha256)) ?? await env.MODELS_SOURCES.get(sourceKey(item.id, item.version, "model.glb")));
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

/** Contact sheets of versions' models, rendered with the library's own viewer. */
async function sheet(env, items, out) {
  return withViewer(async ({ page, browser, work }) => {
    const tiles = [];
    for (const item of items) {
      const bytes = await modelBytes(env, item);
      let png = null;
      if (bytes) {
        await writeFile(join(work, "model.glb"), bytes);
        try { await page.evaluate((url) => window.show(url), `/models/review-sheet/model.glb?${item.id}${item.version}`); await page.waitForTimeout(150); png = (await page.locator("#s").screenshot()).toString("base64"); }
        catch { /* Shown as failed. */ }
      }
      tiles.push({ label: `${item.id} ${item.version}`, note: item.stats ? `${item.stats.size.map((value) => value.toFixed(2)).join("×")} m · ${item.stats.triangles}` : "", warn: warningsOf(item).length, png });
    }
    await mkdir(out, { recursive: true });
    const sheetPage = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const files = [];
    for (let start = 0; start < tiles.length; start += 24) {
      await sheetPage.setContent(`<body style="margin:0;font:11px monospace;background:#ffd43b;display:grid;grid-template-columns:repeat(6,200px)">${tiles.slice(start, start + 24).map((tile) =>
        `<div style="width:200px;height:236px;border:1px solid #211f17;box-sizing:border-box;overflow:hidden">${tile.png ? `<img src="data:image/png;base64,${tile.png}" style="width:198px;height:198px;display:block">` : `<div style="height:198px;color:#9c3a12">FAILED</div>`}<div style="padding:1px 3px;white-space:nowrap">${tile.label}</div><div style="padding:0 3px;white-space:nowrap;color:${tile.warn ? "#9c3a12" : "#5c5133"}">${tile.note}${tile.warn ? ` · ${tile.warn} warning${tile.warn > 1 ? "s" : ""}` : ""}</div></div>`).join("")}</body>`);
      const path = join(out, `sheet-${String(files.length + 1).padStart(2, "0")}.png`);
      await sheetPage.screenshot({ path, fullPage: true });
      files.push(path);
    }
    return files;
  });
}

/** Renders thumbnails like the upload page and stores them through putFile (listed ones are republished). */
export async function thumbnails(env, items, log = console.log) {
  return withViewer(async ({ page }) => {
    let done = 0;
    for (const item of items) {
      const bytes = await modelBytes(env, item);
      if (!bytes) { log(`✗ ${item.id} ${item.version}: no model.glb`); continue; }
      const png = Buffer.from(await page.evaluate((base64) => window.thumbnail(base64), Buffer.from(bytes).toString("base64")), "base64");
      await putFile(env, item.id, item.version, "thumbnail.png", new Uint8Array(png));
      log(`✓ ${item.id} ${item.version}`);
      done++;
    }
    return done;
  });
}

/** The <id>/<version>/ folders under `folder` (docs/models-upload.md), at any depth. */
export async function findVersions(folder) {
  const found = [];
  const walk = async (dir, depth) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (VERSION.test(entry.name) && depth > 0) found.push({ id: dir.split(/[\\/]/).pop(), version: entry.name, path });
      else if (depth < 6) await walk(path, depth + 1);
    }
  };
  await walk(resolve(folder), 0);
  return found;
}

/** Uploads prepared versions through the console's server functions, after the same checks. */
export async function upload(env, versions, log = console.log) {
  let done = 0;
  for (const { id, version, path } of versions) {
    const names = (await readdir(path)).filter((name) => !name.startsWith("."));
    const files = [];
    for (const name of names.filter((name) => name !== "meta.json")) {
      if ((await stat(join(path, name))).isFile()) files.push({ name, bytes: new Uint8Array(await readFile(join(path, name))) });
    }
    const meta = names.includes("meta.json") ? await readFile(join(path, "meta.json"), "utf8") : null;
    const check = inspectVersion({ id, version, meta, files });
    if (check.problems.length) { log(`✗ ${id} ${version}: ${check.problems.join("; ")}`); continue; }
    await putMetadata(env, id, version, check.meta);
    // model.glb first: a new one drops the old thumbnail, which a thumbnail in the folder replaces.
    for (const file of check.files.sort((a, b) => (b.name === "model.glb") - (a.name === "model.glb"))) await putFile(env, id, version, file.name, file.bytes);
    log(`✓ ${id} ${version}${check.warnings.length ? `  ⚠ ${check.warnings.join("; ")}` : ""}`);
    done++;
  }
  return done;
}

const STATUSES = ["pending", "rejected", "approved", "incomplete", "all"];

async function main([command, ...args]) {
  if (!["list", "sheet", "thumbnails", "apply", "rebuild", "upload"].includes(command)) {
    console.error("Usage: npm run models -- list|sheet [status] | thumbnails [status] [--all] | apply <plan.json> [--dry-run] | rebuild | upload <folder>");
    return 1;
  }
  const status = args.find((arg) => STATUSES.includes(arg)) ?? "pending";
  const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1]?.split(",")) : null;
  const versions = async () => (await listVersions(env.MODELS_DB, status)).filter((item) => !only || only.has(item.id));
  const { getPlatformProxy } = await import("wrangler");
  const { env, dispose } = await getPlatformProxy({ configPath: join(root, "wrangler.models-admin.jsonc"), persist: false, envFiles: [] });
  try {
    if (command === "list") {
      const items = await versions();
      for (const item of items) {
        const warnings = warningsOf(item);
        console.log(`${item.id} ${item.version} ${item.status} ${item.type ?? "-"} ${item.kit ?? "-"} ${item.stats ? `${item.stats.size.join("×")} m ${item.stats.triangles} tris` : "-"} ${item.name?.zh ?? "(no name)"}${warnings.length ? `  ⚠ ${warnings.join("; ")}` : ""}`);
      }
      console.log(`${items.length} ${status} versions`);
    } else if (command === "sheet") {
      const items = await versions();
      const files = await sheet(env, items.sort((a, b) => a.id.localeCompare(b.id)), join(root, "test-results", "models-review"));
      console.log(`${items.length} versions on ${files.length} sheets:\n${files.join("\n")}`);
    } else if (command === "thumbnails") {
      const items = (await versions()).filter((item) => args.includes("--all") || !item.files["thumbnail.png"]);
      console.log(`Rendered ${await thumbnails(env, items)} of ${items.length} thumbnails.`);
    } else if (command === "upload") {
      if (!args[0]) throw new Error("upload needs a folder.");
      const found = await findVersions(args[0]);
      console.log(`Uploaded ${await upload(env, found)} of ${found.length} versions.`);
    } else if (command === "apply") {
      const file = args.find((arg) => !arg.startsWith("--") && !STATUSES.includes(arg));
      if (!file) throw new Error("apply needs a plan file.");
      const report = await applyPlan(env, JSON.parse(await readFile(file, "utf8")), { dryRun: args.includes("--dry-run") });
      console.log(JSON.stringify(report, null, 2));
      if (report.failed.length) return 1;
    } else {
      const ids = await publishedIds(env.MODELS_DB);
      const listed = await publish(env, ids);
      console.log(`Rewrote ${ids.length} model pages; ${listed} models listed.`);
    }
    return 0;
  } finally {
    await dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)).catch((error) => { console.error(error.message); return 1; }));
}
