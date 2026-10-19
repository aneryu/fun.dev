import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectVersion } from "../server/model-rules.js";

// Derives a model from a blueprint or from an existing workshop project (docs/model-editor.md
// "Blueprints and derivation"): the headless workshop builds it, and the result is a library
// upload folder — <out>/<id>/v001/ with model.glb, source.funmodel.glb, preview.png and a
// meta.json to finish — plus model.fun3d for a look in a game.
//   npm run derive -- --blueprint lamp-post --id street_lamp_02 [--set height=6 arms=2] [--out out] [--gpu]
//   npm run derive -- --from source.funmodel.glb --id desk_02 --set width=1.2 [--root <asset root>]
//   npm run derive -- --list                       the blueprints and their parameters
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const values = {};
for (let i = args.indexOf("--set") + 1; args.includes("--set") && i < args.length && !args[i].startsWith("--"); i++) {
  const [key, raw] = args[i].split("=");
  if (!key || raw === undefined) { console.error(`--set takes name=value pairs, not "${args[i]}"`); process.exit(1); }
  values[key] = raw === "true" ? true : raw === "false" ? false : Number.isFinite(Number(raw)) && raw.trim() !== "" ? Number(raw) : raw;
}

function runScript(script, gpu) {
  return new Promise((done, failed) => {
    const child = spawn(process.execPath, [resolve(root, "scripts/editor-agent.mjs"), "--run", script, ...(gpu ? ["--gpu"] : [])], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => {
      const line = out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
      let parsed = null;
      try { parsed = line ? JSON.parse(line) : null; } catch { /* reported below */ }
      if (code !== 0 || !parsed?.ok) failed(new Error(parsed?.error ? `${parsed.error.code ?? "error"}: ${parsed.error.message ?? JSON.stringify(parsed.error)}` : (err || out).trim().split("\n").slice(-5).join("\n")));
      else done(parsed);
    });
  });
}

async function main() {
  if (args.includes("--list")) {
    const { listBlueprints } = await import("../site/workshop/blueprints.js");
    for (const b of listBlueprints()) {
      console.log(`${b.id} v${b.version}  ${b.title.zh} / ${b.title.en}\n  ${b.description.en}`);
      for (const [key, p] of Object.entries(b.params)) console.log(`  --set ${key}=${p.value}${p.options ? `  (${p.options.join("|")})` : `  (${p.min}–${p.max}${p.unit ? ` ${p.unit}` : ""}${p.integer ? ", whole" : ""})`}${p.structural ? "  structural" : ""}  ${p.label.zh} / ${p.label.en}`);
    }
    return 0;
  }
  const blueprint = flag("--blueprint"), from = flag("--from"), id = flag("--id");
  if ((!blueprint && !from) || !id) { console.error("Usage: npm run derive -- (--blueprint <id> | --from <project.funmodel.glb>) --id <model_id> [--set name=value ...] [--root <asset root>] [--out <dir>] [--gpu] | --list"); return 1; }
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(id)) { console.error(`${id}: a library id uses lowercase letters, digits and _ (like street_lamp_02).`); return 1; }
  const out = resolve(flag("--out") ?? "out", id, "v001"), assetRoot = flag("--root");
  await mkdir(out, { recursive: true });
  let title = { zh: id, en: id }, description = { zh: "", en: "" }, provenance = null;
  if (blueprint) {
    const { BLUEPRINTS, blueprintValues } = await import("../site/workshop/blueprints.js");
    const spec = BLUEPRINTS.find((b) => b.id === blueprint);
    if (!spec) { console.error(`Unknown blueprint ${blueprint}; --list shows them.`); return 1; }
    const checked = blueprintValues(spec, values);
    const settings = Object.entries(checked).map(([k, v]) => `${spec.params[k].label.en.toLowerCase()} ${v}${spec.params[k].unit ?? ""}`).join(", ");
    title = spec.title;
    description = { zh: `${spec.description.zh}（${Object.entries(checked).map(([k, v]) => `${spec.params[k].label.zh} ${v}${spec.params[k].unit ?? ""}`).join("，")}）`, en: `${spec.description.en} (${settings})` };
    provenance = { blueprint: { id: spec.id, version: spec.version, params: checked } };
  }
  const script = resolve(out, "_derive.mjs");
  const rootName = `${id}_ROOT`;
  await writeFile(script, `import { writeFile } from "node:fs/promises";
export default async function (ws) {
  ${blueprint
    ? `await ws.load({ name: ${JSON.stringify(id)}, materials: [{ id: "mat_base", color: "#cccccc", roughness: 0.9 }] });
  await ws.apply([{ op: "blueprint", id: ${JSON.stringify(blueprint)}, params: ${JSON.stringify(values)}, root: ${JSON.stringify(assetRoot ?? id)} }]);
  await ws.apply([{ op: "purgeMaterials" }]);`
    : `await ws.importGLB({ file: ${JSON.stringify(resolve(from))}, mode: "replace" });
  const assemblies = (await ws.inspect()).assemblies ?? [];
  const root = ${JSON.stringify(assetRoot ?? null)} ?? (assemblies.length === 1 ? assemblies[0].root : null);
  if (!root) throw new Error("The project has " + assemblies.length + " assets; name one with --root");
  if (Object.keys(${JSON.stringify(values)}).length) await ws.apply([{ op: "assemblyParameters", root, values: ${JSON.stringify(values)} }]);`}
  await ws.observe(["perspective"], { file: "preview.png", size: 768 });
  await ws.exportGLB({ file: "model.glb", origin: "ground-center", rootName: ${JSON.stringify(rootName)}, mergeStatic: "auto" });
  await ws.exportProject({ file: "source.funmodel.glb" });
  // The asset's provenance and live parameter values, for meta.json (the run reports no return value).
  const assets = (await ws.inspect()).assemblies ?? [];
  const asset = assets.find((a) => a.root === ${JSON.stringify(assetRoot ?? (blueprint ? id : null))}) ?? assets[0] ?? null;
  await writeFile(new URL("./_derive.json", import.meta.url), JSON.stringify(asset ? { blueprint: asset.blueprint ?? null, parameters: Object.fromEntries(Object.entries(asset.parameters ?? {}).map(([k, p]) => [k, p.value])) } : null));
}
`);
  let result, asset = null;
  try {
    result = await runScript(script, args.includes("--gpu"));
    asset = JSON.parse(await readFile(resolve(out, "_derive.json"), "utf8").catch(() => "null"));
  } finally { await rm(script, { force: true }); await rm(resolve(out, "_derive.json"), { force: true }); }
  // A project built from a blueprint keeps its family: the description follows the live values.
  if (!provenance && asset?.blueprint) {
    const { BLUEPRINTS } = await import("../site/workshop/blueprints.js");
    const spec = BLUEPRINTS.find((b) => b.id === asset.blueprint.id);
    if (spec) {
      const checked = { ...asset.parameters, ...asset.blueprint.params };
      const settings = (lang) => Object.entries(checked).filter(([k]) => spec.params[k]).map(([k, v]) => `${lang === "zh" ? spec.params[k].label.zh : spec.params[k].label.en.toLowerCase()} ${typeof v === "number" ? Math.round(v * 100) / 100 : v}${spec.params[k].unit ?? ""}`).join(lang === "zh" ? "，" : ", ");
      title = spec.title;
      description = { zh: `${spec.description.zh}（${settings("zh")}）`, en: `${spec.description.en} (${settings("en")})` };
      provenance = { blueprint: { ...asset.blueprint, params: checked } };
    }
  }
  const glb = await readFile(resolve(out, "model.glb"));
  const family = provenance?.blueprint?.id;
  const meta = { name: title, description, type: "prop", kit: null, tags: [...(family ? [family.replace(/-/g, "_"), "blueprint"] : ["derived"])], listed: true, ...(provenance ? { extra: provenance } : {}) };
  await writeFile(resolve(out, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  const { createConverter } = await import("./fun3d-convert.mjs");
  const converted = await createConverter().convert(glb, { type: "prop", name: id });
  await writeFile(resolve(out, "model.fun3d"), converted.bytes);
  const checks = inspectVersion({ id, version: "v001", meta: JSON.stringify(meta), files: [{ name: "model.glb", bytes: new Uint8Array(glb) }] });
  console.log(JSON.stringify({ ok: true, out, files: ["model.glb", "source.funmodel.glb", "preview.png", "meta.json", "model.fun3d"], glb: glb.length, fun3d: converted.bytes.length, triangles: converted.report.triangles, validation: result.validation ?? null, library: { problems: checks.problems, warnings: checks.warnings ?? [] }, provenance }));
  return checks.problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main().catch((error) => { console.error(error.message); return 1; }));
}
