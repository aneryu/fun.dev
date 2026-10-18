import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scanChunks } from "../site/runtime/kit/fun3d-container.js";
import { createConverter, converterStamp } from "./fun3d-convert.mjs";

// .fun3d files from the command line (docs/model-format.md, docs/fun3d-agents.md):
//   npm run fun3d -- inspect <file.fun3d> [--json]           what a file holds
//   npm run fun3d -- validate <file.fun3d>...                 every problem, exit 1 when any
//   npm run fun3d -- convert <model.glb> [--type prop|piece|vehicle|character] [--name <id>] [-o <out.fun3d>]
//   npm run fun3d -- library [--out <dir>] [--only id,id] [--limit <n>] [--jobs <n>]
//       converts every listed library model (public index and blobs, cached) into <dir> with a report.json:
//       sizes, times, validation, what the profile derived and which conventions each model follows
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const count = (n) => n.toLocaleString("en-US");

export async function inspect(bytes, { json = false } = {}) {
  const { fun3d } = createConverter();
  const { manifest, bins, edit, problems } = await fun3d.read(bytes, { editing: true });
  if (json) return JSON.stringify(manifest, null, 2);
  const { chunks } = scanChunks(bytes);
  const sizes = chunks.map((c) => `${c.type.trim()}${c.editing ? "(edit)" : ""} ${kb(c.end - c.start)}`).join(", ");
  const lines = [];
  const source = manifest.asset?.source;
  lines.push(`${manifest.asset?.name ?? "(unnamed)"}  ${manifest.kind}  fun3d ${manifest.fun3d}  ${kb(bytes.length)} stored (${sizes})`);
  if (source) lines.push(`source ${source.kind}${source.type ? ` type ${source.type}` : ""}${source.profile ? `  profile ${source.profile}` : ""}${source.hash ? `  ${source.hash.slice(0, 19)}…` : ""}${source.converter ? `  converter ${source.converter.slice(7, 15)}` : ""}`);
  const nodes = manifest.nodes ?? [], geometries = manifest.geometries ?? [], streams = new Map((manifest.streams ?? []).map((s) => [s.id, s]));
  const triangles = geometries.reduce((n, g) => n + streams.get(g.index.stream).count / 3, 0), vertices = geometries.reduce((n, g) => n + g.vertices, 0);
  lines.push(`nodes ${nodes.length} (meshes ${nodes.filter((n) => n.mesh).length}, placements ${nodes.filter((n) => n.placements).length} / ${count(nodes.reduce((n, x) => n + (x.placements?.count ?? 0), 0))} copies, lights ${nodes.filter((n) => n.light).length}, lod ${nodes.filter((n) => n.lod).length})`);
  lines.push(`geometries ${geometries.length}  vertices ${count(vertices)}  triangles ${count(triangles)}  lod levels ${geometries.reduce((n, g) => n + (g.lods?.length ?? 0), 0)}  morph targets ${geometries.reduce((n, g) => n + (g.morph?.targets.length ?? 0), 0)}`);
  lines.push(`materials ${manifest.materials?.length ?? 0}  images ${manifest.images?.length ?? 0}  textures ${manifest.textures?.length ?? 0}  skeletons ${manifest.skeletons?.length ?? 0}  clips ${manifest.animations?.length ?? 0}  variants ${manifest.variants?.length ?? 0}  refs ${manifest.refs?.length ?? 0}  bins ${bins.length}${edit ? `  editing section: ${edit.tool} v${edit.version}` : ""}`);
  for (const m of manifest.materials ?? []) {
    const features = Object.entries(m.features ?? {}).map(([k, v]) => (k === "emitter" ? `emitter:${v.role}` : k)).join(" ");
    lines.push(`  material ${m.id}  ${m.model ?? "pbr"} ${m.color ?? "#ffffff"}${m.alpha?.mode && m.alpha.mode !== "opaque" ? ` ${m.alpha.mode}` : ""}${m.maps ? ` maps:${Object.keys(m.maps).join(",")}` : ""}${features ? `  ${features}` : ""}`);
  }
  for (const s of manifest.skeletons ?? []) lines.push(`  skeleton ${s.id}  ${s.bones.length} bones${s.rig ? `  rig ${s.rig.name}@${s.rig.version ?? 1} (${Object.keys(s.rig.roles ?? {}).length} roles)` : ""}${s.ref ? `  ref ${s.ref}` : ""}`);
  for (const a of manifest.animations ?? []) lines.push(`  clip ${a.id}  ${a.duration}s  ${a.tracks.length} tracks${a.events?.length ? `  ${a.events.length} events` : ""}${a.loop && a.loop !== "repeat" ? `  ${a.loop}` : ""}`);
  const p = manifest.physics ?? {};
  if (Object.keys(p).length) {
    const shapes = (p.shapes ?? []).map((s) => s.type).reduce((all, t) => ({ ...all, [t]: (all[t] ?? 0) + 1 }), {});
    lines.push(`physics: shapes ${Object.entries(shapes).map(([t, n]) => `${t}×${n}`).join(" ") || 0}  bodies ${p.bodies?.length ?? 0} (${["static", "kinematic", "dynamic"].map((m) => `${m} ${(p.bodies ?? []).filter((b) => (b.motion ?? "static") === m).length}`).join(", ")})  vehicles ${p.vehicles?.length ?? 0}${p.vehicles?.length ? ` (${p.vehicles.map((v) => `${v.wheels.length} wheels`).join(", ")})` : ""}  constraints ${p.constraints?.length ?? 0}  ragdolls ${p.ragdolls?.length ?? 0}  characters ${p.characters?.length ?? 0}`);
    for (const b of p.bodies ?? []) lines.push(`  body ${b.id}  ${b.motion ?? "static"}  node ${b.node}  shape ${b.shape}${b.mass !== undefined ? `  ${b.mass} kg` : ""}${b.switchable ? "  switchable" : ""}`);
  }
  if (manifest.uses?.length) lines.push(`extensions: uses ${manifest.uses.join(", ")}${manifest.requires?.length ? `; requires ${manifest.requires.join(", ")}` : ""}`);
  if (problems.length) lines.push(`PROBLEMS (${problems.length}):`, ...problems.slice(0, 20).map((x) => `  ${x}`));
  return lines.join("\n");
}

async function main([command, ...args]) {
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const files = args.filter((a, i) => !a.startsWith("-") && !["--type", "--name", "-o", "--out", "--only", "--limit", "--jobs"].includes(args[i - 1]));
  if (command === "inspect" && files[0]) {
    console.log(await inspect(await readFile(resolve(files[0])), { json: args.includes("--json") }));
    return 0;
  }
  if (command === "validate" && files.length) {
    const { fun3d } = createConverter();
    let failed = 0;
    for (const file of files) {
      const problems = await fun3d.validate(await readFile(resolve(file)));
      console.log(`${problems.length ? "✗" : "✓"} ${file}${problems.length ? `\n  ${problems.join("\n  ")}` : ""}`);
      if (problems.length) failed++;
    }
    return failed ? 1 : 0;
  }
  if (command === "convert" && files[0]) {
    const input = resolve(files[0]), glb = await readFile(input);
    const name = flag("--name") ?? basename(input).replace(/\.glb$/i, ""), out = flag("-o") ?? flag("--out") ?? input.replace(/\.glb$/i, "") + ".fun3d";
    const { bytes, report } = await createConverter().convert(glb, { type: flag("--type") ?? "prop", name });
    await writeFile(out, bytes);
    console.log(`${out}  ${kb(bytes.length)} from ${kb(glb.length)} GLB  (${report.type}, ${count(report.vertices)} vertices, ${count(report.triangles)} triangles, ${report.materials} materials${report.hull ? `, hull ${report.hull} points` : ""}${report.wheels.length ? `, ${report.wheels.length} wheels` : ""}${report.rig ? `, rig ${report.rig}` : ""})  converter ${(await converterStamp()).slice(7, 15)}`);
    for (const warning of report.warnings) console.log(`  ⚠ ${warning}`);
    return 0;
  }
  if (command === "library") {
    const { fetchIndex, fetchSource } = await import("./library-models.mjs");
    const out = resolve(flag("--out") ?? "test-results/fun3d-library"), limit = Number(flag("--limit") ?? Infinity), only = flag("--only")?.split(","), jobs = Number(flag("--jobs") ?? 4);
    const index = await fetchIndex();
    let models = index.models.map((row) => Object.fromEntries(index.fields.map((field, i) => [field, row[i]])));
    if (only) models = models.filter((m) => only.includes(m.id));
    models = models.slice(0, limit);
    await mkdir(out, { recursive: true });
    const converter = createConverter(), stamp = await converterStamp(), entries = [];
    let next = 0;
    async function worker() {
      while (next < models.length) {
        const m = models[next++], entry = { id: m.id, version: m.version, type: m.type };
        try {
          const source = await fetchSource(m.id, m.version);
          const started = performance.now();
          const { bytes, manifest, report } = await converter.convert(source.body, { type: source.type, name: m.id, hash: `sha256:${source.hash}` });
          entry.ms = Math.round(performance.now() - started);
          entry.hash = source.hash; entry.glb = source.body.length; entry.fun3d = bytes.length;
          entry.problems = await converter.fun3d.validate(bytes);
          await writeFile(join(out, `${m.id}@${m.version}.fun3d`), bytes);
          const roles = new Set(manifest.materials.flatMap((x) => (x.features?.emitter ? [x.features.emitter.role] : [])));
          Object.assign(entry, {
            kind: report.kind, convertedAs: report.type, warnings: report.warnings, vertices: report.vertices, triangles: report.triangles, materials: report.materials, nodes: report.nodes,
            hull: report.hull, mass: report.mass, wheels: report.wheels.length, rig: report.rig,
            conventions: { static: manifest.nodes.some((n) => n.id === "static"), collider: manifest.nodes.some((n) => n.tags?.includes("collider")), textured: manifest.images.length > 0, roles: [...roles], tint: manifest.materials.some((x) => x.features?.tint), blend: manifest.materials.some((x) => x.alpha?.mode === "blend"), skinned: manifest.skeletons.length > 0, meshShape: manifest.physics?.shapes?.some((x) => x.type === "mesh") ?? false },
          });
        } catch (error) { entry.error = error.message; }
        entries.push(entry);
        if (entries.length % 50 === 0) console.log(`  ${entries.length}/${models.length}`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(jobs, models.length) }, worker));
    entries.sort((a, b) => a.id.localeCompare(b.id));
    const ok = entries.filter((e) => !e.error), failed = entries.filter((e) => e.error), invalid = ok.filter((e) => e.problems.length);
    const sum = (list, key) => list.reduce((n, e) => n + (e[key] ?? 0), 0);
    const counts = {};
    for (const e of ok) for (const [key, value] of Object.entries(e.conventions)) { if (Array.isArray(value)) for (const v of value) counts[`role:${v}`] = (counts[`role:${v}`] ?? 0) + 1; else if (value) counts[key] = (counts[key] ?? 0) + 1; }
    const summary = { converter: stamp, models: entries.length, converted: ok.length, failed: failed.length, invalid: invalid.length, glb: sum(ok, "glb"), fun3d: sum(ok, "fun3d"), ms: sum(ok, "ms"), conventions: counts, byType: Object.fromEntries(["prop", "piece", "vehicle", "character"].map((t) => [t, ok.filter((e) => e.convertedAs === t).length])), warnings: ok.filter((e) => e.warnings.length).length };
    await writeFile(join(out, "report.json"), JSON.stringify({ summary, models: entries }, null, 1));
    console.log(`${ok.length}/${entries.length} converted into ${out} (${failed.length} failed, ${invalid.length} invalid), ${kb(summary.glb)} GLB → ${kb(summary.fun3d)} .fun3d (${(summary.glb / Math.max(1, summary.fun3d)).toFixed(1)}×), ${(summary.ms / 1000).toFixed(1)} s of conversion, converter ${stamp.slice(7, 15)}`);
    console.log(`  types ${JSON.stringify(summary.byType)}  conventions ${JSON.stringify(counts)}`);
    for (const e of failed) console.log(`  ✗ ${e.id}@${e.version}: ${e.error}`);
    for (const e of invalid) console.log(`  ! ${e.id}@${e.version}: ${e.problems[0]}`);
    for (const e of ok.filter((x) => x.warnings.length).slice(0, 20)) console.log(`  ⚠ ${e.id}: ${e.warnings.join("; ")}`);
    const slow = [...ok].sort((a, b) => b.ms - a.ms).slice(0, 3).map((e) => `${e.id} ${e.ms} ms`).join(", ");
    console.log(`  slowest: ${slow}`);
    return failed.length || invalid.length ? 1 : 0;
  }
  console.error("Usage: npm run fun3d -- inspect <file.fun3d> [--json] | validate <file.fun3d>... | convert <model.glb> [--type prop|piece|vehicle|character] [--name <id>] [-o <out.fun3d>]");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)).catch((error) => { console.error(error.message); return 1; }));
}
