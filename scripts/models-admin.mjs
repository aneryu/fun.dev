import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { placementWarnings, textWarnings } from "../server/model-rules.js";
import { approveVersion, blobKey, editModel, getModel, listVersions, publish, publishedIds, putKit, rejectVersion, sourceKey } from "../server/models.js";

// Maintenance for the model library (docs/models.md), run by the maintainer: the console's own
// functions against the live database and storage, through Wrangler's remote bindings
// (wrangler.models-admin.jsonc, your Wrangler login). Nothing here is reachable from the web.
//
//   npm run models -- list [pending|rejected|approved|incomplete|all]
//   npm run models -- sheet [status]          contact sheets of those versions in test-results/models-review/
//   npm run models -- apply <plan.json> [--dry-run]
//   npm run models -- rebuild                 rewrite every model's page data and the indexes
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
  for (const value of plan.approve ?? []) {
    const [id, version] = value.split("/");
    if (await attempt(`approve ${value}`, async () => { await approveVersion(env, id, version, { defer: true }); touched.add(id); })) report.approved.push(value);
  }
  // Only models with an approved version have public pages.
  const published = [];
  for (const id of touched) if ((await getModel(env.MODELS_DB, id).catch(() => null))?.versions.some((version) => version.status === "approved")) published.push(id);
  if (!dryRun && published.length) report.listed = await publish(env, published);
  return report;
}

/** Contact sheets of versions' models, rendered with the library's own viewer. */
async function sheet(env, items, out) {
  const { launch, serve, dist } = await import("./browser/harness.mjs");
  try { await readFile(resolve(dist, "model-viewer.js")); }
  catch { throw new Error("Build the site first: npm run build."); }
  const work = resolve(dist, "review-sheet");
  await mkdir(work, { recursive: true });
  await writeFile(join(work, "index.html"), `<!doctype html><body><div id="s"></div><script type="module" src="/review-sheet/render.js"></script>`);
  await writeFile(join(work, "render.js"), `import { createViewer } from "/model-viewer.js";
const stage = document.querySelector("#s"); Object.assign(stage.style, { width: "320px", height: "320px", background: "#fff7d6" }); document.body.style.margin = "0";
const viewer = createViewer(stage); window.show = (url) => viewer.load(url);`);
  const site = await serve(), browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 320 } });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${site.base}/review-sheet/`);
    await page.waitForFunction(() => window.show);
    const tiles = [];
    for (const item of items) {
      const entry = item.files["model.glb"];
      const object = entry && (await env.MODELS_PUBLIC.get(blobKey("model.glb", entry.sha256)) ?? await env.MODELS_SOURCES.get(sourceKey(item.id, item.version, "model.glb")));
      let png = null;
      if (object) {
        await writeFile(join(work, "model.glb"), new Uint8Array(await object.arrayBuffer()));
        try { await page.evaluate((url) => window.show(url), `/review-sheet/model.glb?${item.id}${item.version}`); await page.waitForTimeout(150); png = (await page.locator("#s").screenshot()).toString("base64"); }
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
  } finally {
    await browser.close();
    site.close();
    await rm(work, { recursive: true, force: true });
  }
}

const STATUSES = ["pending", "rejected", "approved", "incomplete", "all"];

async function main([command, ...args]) {
  if (!["list", "sheet", "apply", "rebuild"].includes(command)) {
    console.error("Usage: npm run models -- list|sheet [status] | apply <plan.json> [--dry-run] | rebuild");
    return 1;
  }
  const status = args.find((arg) => STATUSES.includes(arg)) ?? "pending";
  const { getPlatformProxy } = await import("wrangler");
  const { env, dispose } = await getPlatformProxy({ configPath: join(root, "wrangler.models-admin.jsonc"), persist: false, envFiles: [] });
  try {
    if (command === "list") {
      const items = await listVersions(env.MODELS_DB, status);
      for (const item of items) {
        const warnings = warningsOf(item);
        console.log(`${item.id} ${item.version} ${item.status} ${item.type ?? "-"} ${item.kit ?? "-"} ${item.stats ? `${item.stats.size.join("×")} m ${item.stats.triangles} tris` : "-"} ${item.name?.zh ?? "(no name)"}${warnings.length ? `  ⚠ ${warnings.join("; ")}` : ""}`);
      }
      console.log(`${items.length} ${status} versions`);
    } else if (command === "sheet") {
      const items = await listVersions(env.MODELS_DB, status);
      const files = await sheet(env, items.sort((a, b) => a.id.localeCompare(b.id)), join(root, "test-results", "models-review"));
      console.log(`${items.length} versions on ${files.length} sheets:\n${files.join("\n")}`);
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
