// The API behind --run: a model script receives `ws` and builds the model from scratch, the
// way a Blender script does. Revisions, file paths and compact results are handled here, so
// one run is one call and its output stays short.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, extname, basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { presetFromObservation } from "../site/workshop/view-presets.js";

class ScriptError extends Error {
  constructor(info) {
    super(info?.message ?? "Workshop request failed");
    this.info = info;
  }
}

export const compactError = (error) => {
  const e = error?.info ?? error ?? {};
  return Object.fromEntries(
    Object.entries({
      code: e.code,
      message: e.message ?? String(error),
      operation: e.operation,
      commandIndex: e.commandIndex,
      node: e.node,
      path: e.path,
      suggestion: e.suggestion,
      issues: e.issues?.length ? e.issues.slice(0, 3) : undefined,
      issueCount: e.issues?.length,
      applied: e.applied,
      partialCommit: e.partialCommit,
      revision: e.revision,
      diagnosticsFile: e.diagnosticsFile,
      candidateId: e.candidateId,
      operationId: e.operationId,
    }).filter(([, v]) => v !== undefined && v !== ""),
  );
};

// Issues grouped per code and part: enough to act on, short enough to read every run.
const summary = (validation) => {
  const group = (list) => {
    const counts = new Map();
    for (const issue of list) {
      const key = `${issue.code}${issue.node ? ` (${issue.node})` : ""}`;
      counts.set(key, (counts.get(key) ?? 0) + (issue.count ?? 1));
    }
    return [...counts].map(([key, n]) => (n > 1 ? `${key} ×${n}` : key));
  };
  return {
    ...(validation.revision !== undefined ? { revision: validation.revision } : {}),
    errors: group(validation.errors ?? []),
    warnings: group(validation.warnings ?? []),
    checks: validation.checks ?? { status: "not-reported" },
  };
};

const BOOKKEEPING = new Set(["index", "op", "node", "selection", "parameterChanges", "changed", "removed", "geometry", "materialRules", "detachedRecipes", "idMap", "copies", "consumed"]);

export function scriptApi(invoke, base) {
  const files = [];
  let revision;
  let committedCalls = 0;
  const path = (file) => resolve(base, file);
  async function call(method, args = {}) {
    args = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
    const result = await invoke("fun_editor_" + method, args);
    if (result.isError) {
      const info = { ...result.structuredContent?.error, operationId: args.operationId,
        partialCommit: committedCalls > 0 || result.structuredContent?.error?.applied === true };
      try { info.diagnosticsFile = await write(`error-${crypto.randomUUID()}.json`, JSON.stringify(info, null, 2)); }
      catch (error) { info.artifactError = error.message; }
      throw new ScriptError(info);
    }
    // Any answer that reports the project's revision keeps the one ws.apply sends current, so
    // ws.call("apply", …) and ws.inspect() mix with ws.apply (library records are not projects).
    const value = result.structuredContent;
    if (!method.startsWith("library") && Number.isSafeInteger(value?.revision)) {
      if (["apply", "acceptCandidate", "loadProject", "importGLB", "undo", "redo", "restoreCheckpoint", "place", "derive", "openLibraryModel"].includes(method)
          && value.revision !== revision && !value.replayed) committedCalls++;
      revision = value.revision;
    }
    return value;
  }
  const current = async () =>
    (revision ??= (await call("inspect")).revision);
  const write = async (file, data) => {
    const target = path(file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    files.push(target);
    return target;
  };
  const ws = {
    call,
    async candidate({ file, ...args } = {}) {
      const result = await call("workflow", { action: "prepare", ...args, ifRevision: await current() });
      // A failure always produces a reusable, complete inspection artifact.
      if (file || !result.ok) {
        const full = await call("workflow", { action: "inspect", candidateId: result.candidateId,
          detail: "full", ifRevision: await current() });
        const report = file ?? `candidate-${result.candidateId}.json`;
        result.diagnosticsFile = await write(report, JSON.stringify({ ...full, observations: result.observations }, null, 2));
        for (const [i, shot] of result.observations.entries())
          await write(`${report}.${i}.png`, Buffer.from(shot.dataUrl.split(",")[1], "base64"));
      }
      return result;
    },
    async accept(candidate, { operationId = crypto.randomUUID() } = {}) {
      return call("acceptCandidate", { candidateId: candidate.candidateId, ifRevision: candidate.baseRevision, operationId });
    },
    async replace({ commands = [], ...project }, options = {}) {
      const candidate = await ws.candidate({ project: {
        format: "fun.dev/model", version: 1, name: "Model", nodes: [],
        ...project, materials: (project.materials?.length ? project.materials : [{ id: "mat_default", color: "#c8c8c8" }])
          .map(m => ({ name: m.id, roughness: 0.85, ...m })),
      }, ...(commands.length ? { commands } : {}), ...options });
      if (!candidate.ok) throw new ScriptError({ code: "candidate_rejected", message: "Candidate rejected; current draft unchanged",
        ...candidate.error, applied: false, partialCommit: committedCalls > 0, candidateId: candidate.candidateId,
        revision: candidate.revision, diagnosticsFile: candidate.diagnosticsFile });
      return ws.accept(candidate);
    },
    async surface(query, { candidateId } = {}) {
      return call("workflow", { action: "surface", query, candidateId, ifRevision: await current() });
    },
    async relations({ candidateId, file, ...query } = {}) {
      const report = await call("workflow", { action: "relations", query, candidateId, ifRevision: await current() });
      if (file) await write(file, JSON.stringify(report, null, 2));
      return report;
    },
    async diagnose({ file, ...args } = {}) {
      const report = await call("workflow", { action: "diagnose", ...args, ifRevision: await current() });
      if (file) await write(file, JSON.stringify(report, null, 2));
      return report;
    },
    async fit({ id, at, targets, offset = 0 }) {
      const hit = await ws.surface({ at, ids: targets, offset });
      if (!hit.offsetPoint) throw new Error(hit.reason);
      return ws.apply([{ op: "transform", id, space: "world", translation: hit.offsetPoint.map((v, i) => v - at[i]) }]);
    },
    async verifyExport({ file, ...args } = {}) {
      const result = await call("workflow", { action: "verifyExport", ...args, ifRevision: await current() });
      if (file) await write(file, JSON.stringify(result, null, 2));
      return result;
    },
    async verifyRuntime({ runtimeFile, poses, relationIds, mapping, maxTests, candidateId, detail="summary", file }) {
      const data=(await readFile(path(runtimeFile))).toString("base64");
      const result=await call("workflow",{action:"verifyRuntime",detail,ifRevision:await current(),
        ...(candidateId?{candidateId}:{}),query:{data,poses,...(relationIds?{relationIds}:{}),
          ...(mapping?{mapping}:{}),...(maxTests===undefined?{}:{maxTests})}});
      if(file)await write(file,JSON.stringify(result,null,2));
      return result;
    },
    async compare({ baseline, candidate, views, reference, overlay = true, file = "comparison.html" }) {
      const escape = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
      const records = [], rows = [];
      const referenceImage = reference ? `data:image/${extname(reference).slice(1).replace("jpg", "jpeg")};base64,${(await readFile(path(reference))).toString("base64")}` : null;
      for (const [name, options] of Object.entries(views)) {
        const { view = "perspective", size: requestedSize, ...render } = options;
        const size = requestedSize ?? (render.preset ? undefined : 512);
        render.overlays = { wire: false, selection: false, data: false, ...render.overlays };
        const first = await call("workflow", { action: "inspect", candidateId: baseline.candidateId,
          ifRevision: await current(), views: [view], size, render });
        if (!first.observations?.length) throw new ScriptError(first.renderError);
        const before = first.observations[0];
        const second = await call("workflow", { action: "inspect", candidateId: candidate.candidateId,
          ifRevision: await current(), views: [view], size, render: { ...render, camera: before.camera, height: before.height,
            studio: before.quality.lightingSetup, exposure: before.quality.exposure,
            antialias: before.quality.antialias, shadows: before.quality.shadows } });
        if (!second.observations?.length) throw new ScriptError(second.renderError);
        const after = second.observations[0];
        const images = [];
        for (const [label, shot] of [["baseline", before], ["candidate", after]]) {
          const imageFile = `${file}.${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.${label}.${shot.candidateId}.png`;
          const target = await write(imageFile, Buffer.from(shot.dataUrl.split(",")[1], "base64"));
          const { dataUrl, ...metadata } = shot;
          records.push({ name, role: "real-model-render", label, file: target, ...metadata });
          images.push(`<figure><img alt="${escape(name)} ${label}" src="${dataUrl}"><figcaption>真实模型渲染 · ${label}<br>${escape(shot.candidateId)}</figcaption></figure>`);
        }
        if (overlay) images.push(`<figure><div style="position:relative"><img alt="${escape(name)} baseline overlay" src="${before.dataUrl}"><img alt="${escape(name)} candidate overlay" src="${after.dataUrl}" style="position:absolute;inset:0;opacity:.5"></div><figcaption><label>透明叠加 · candidate <input type="range" min="0" max="100" value="50" oninput="this.closest('figure').querySelectorAll('img')[1].style.opacity=this.value/100"></label></figcaption></figure>`);
        const history = after.designReferences;
        const basis = history ? `<p>采用参考版本：${history.selected.map(escape).join(" · ") || "未选择"}</p><ul>${history.records.filter(r => r.kind !== "image").map(r => `<li>${escape(r.id)} · ${escape(r.status ?? r.kind)}: ${escape(r.text)}${r.evidence ? ` · ${escape(r.evidence)}` : ""}</li>`).join("")}</ul>` : "";
        rows.push(`<section><h2>${escape(name)}</h2>${basis}<div class="views">${referenceImage ? `<figure><img alt="Reference" src="${referenceImage}"><figcaption>参考图 · 非模型渲染</figcaption></figure>` : ""}${images.join("")}</div></section>`);
      }
      await write(`${file}.json`, JSON.stringify({ overlay, reference: reference ? { file: path(reference), role: "reference" } : null, records }, null, 2));
      return { file: await write(file, `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>模型对照</title><style>
body{margin:0;padding:24px;background:#FFD43B;color:#211F17;font:14px/1.5 ui-monospace,monospace}h1{font-size:24px}h2{font-size:18px}section{border-top:1px solid;margin-top:24px}.views{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0;flex:1 1 280px;min-width:0}img{width:100%;display:block}figcaption{overflow-wrap:anywhere;margin-top:8px}a{color:#064F67}a:focus-visible{outline:3px solid #004E89}</style><h1>参考与模型对照</h1><p>相机、投影、曝光、灯光与采样保持一致。参考图用于建模判断，不代表几何校验结果。</p>${rows.join("")}</html>`), records };
    },
    // A fresh project; materials need only id and color.
    async load({ name = "Model", materials = [], nodes = [], ...rest } = {}) {
      // A project needs one material; scenes of placed models rarely name any.
      if (!materials.length) materials = [{ id: "mat_default", color: "#c8c8c8" }];
      const project = {
        format: "fun.dev/model",
        version: 1,
        name,
        materials: materials.map((m) => ({ name: m.id, roughness: 0.85, ...m })),
        nodes,
        ...rest,
      };
      const result = await call("loadProject", {
        project,
        ifRevision: await current(),
      });
      revision = result.revision;
      return { revision };
    },
    async apply(commands, { label, operationId = crypto.randomUUID() } = {}) {
      const result = await call("apply", {
        commands,
        ifRevision: await current(),
        operationId,
        ...(label ? { label } : {}),
      });
      revision = result.revision;
      const idMaps = result.results
        ?.filter((r) => r.idMap || r.copies || r.consumed)
        .map(({ index, op, idMap, copies, consumed }) => ({
          index,
          op,
          ...(idMap ? { idMap } : {}),
          ...(copies ? { copies } : {}),
          ...(consumed ? { consumed } : {}),
        }));
      // What commands measured (a stroke's dabs and vertices moved, displace's affected
      // vertices…), without the bookkeeping every result carries.
      const reports = result.results
        ?.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k === "index" || k === "op" || !BOOKKEEPING.has(k))))
        .filter((r) => Object.keys(r).length > 2);
      return {
        revision,
        changed: result.changed,
        ...(result.removed?.length ? { removed: result.removed } : {}),
        ...(idMaps?.length ? { idMaps } : {}),
        ...(reports?.length ? { reports } : {}),
      };
    },
    async undo() {
      const result = await call("undo", { ifRevision: await current() });
      revision = result.revision;
      return { revision };
    },
    inspect: (args = {}) => call("inspect", args),
    query: (args) => call("query", args),
    async validate({ file, detail = "summary", ...budget } = {}) {
      const result = await call("validate", budget);
      if (file) await write(file, JSON.stringify(result, null, 2));
      return detail === "full" ? result : summary(result);
    },
    // One view writes `file`; several write `file` with -<view> before the extension.
    // A walkthrough: frames every few metres along a path, written as file-01.png, file-02.png …
    async sample({ path: along, file = "walk.png", ...options } = {}) {
      const result = await call("observe", { names: ["perspective"], along: { path: along, ...options } });
      const written = [];
      for (const [i, shot] of result.observations.entries())
        written.push(await write(resolve(dirname(path(file)), `${basename(file, extname(file))}-${String(i + 1).padStart(2, "0")}${extname(file) || ".png"}`), Buffer.from(shot.dataUrl.split(",")[1], "base64")));
      return { files: written, frames: result.observations.map((s) => ({ view: s.view, distance: s.distance, position: s.position })) };
    },
    async observe(names = ["perspective"], { file = "view.png", report, ...options } = {}) {
      const result = await call("observe", { names, ...options });
      const written = [];
      for (const shot of result.observations) {
        const name =
          names.length === 1 && result.observations.length === 1
            ? file
            : `${basename(file, extname(file))}-${shot.view}${extname(file) || ".png"}`;
        written.push(
          await write(
            resolve(dirname(path(file)), basename(name)),
            Buffer.from(shot.dataUrl.split(",")[1], "base64"),
          ),
        );
      }
      if (report) await write(report, JSON.stringify(result.observations.map(({ dataUrl, ...metadata }, i) => ({ ...metadata, file: written[i] })), null, 2) + '\n');
      return written;
    },
    async saveView(id, { view = "perspective", size = 512, ...options } = {}) {
      const result = await call("observe", { names: [view], size, helpers: false,
        overlays: { wire: false, selection: false, data: false }, ...options });
      const definition = presetFromObservation(result.observations[0], id);
      await ws.apply([{ op: "viewPreset", id, definition }]);
      return definition;
    },
    async exportGLB({ file = "model.glb", ...options } = {}) {
      const result = await call("exportGLB", options);
      const target = await write(file, Buffer.from(result.data, "base64"));
      const r = result.report ?? {};
      return {
        file: target,
        revision: result.revision,
        triangles: r.triangles,
        bytes: r.bytes,
        drawCalls: r.drawCalls,
        bounds: r.bounds,
        ...(r.mergeGroups?.length
          ? { mergeGroups: r.mergeGroups.map((g) => g.id) }
          : {}),
        validation: summary(r.validation ?? {}),
      };
    },
    async exportProject({ file = "model.funmodel.glb" } = {}) {
      const result = await call("exportProject");
      return { file: await write(file, Buffer.from(result.data, "base64")) };
    },
    async importGLB({ file, ...options }) {
      const result = await call("importGLB", {
        ...options,
        path: path(file),
        ifRevision: await current(),
      });
      revision = result.revision;
      return { revision, nodes: result.nodes, warnings: result.warnings };
    },
    librarySearch: (args = {}) => call("librarySearch", args),
    libraryModel: (id) => call("libraryModel", { id }),
    async openLibraryModel(id, options = {}) {
      const result = await call("openLibraryModel", {
        id,
        ...options,
        ifRevision: await current(),
      });
      revision = result.revision;
      return { revision, source: result.source, nodes: result.nodes, warnings: result.warnings };
    },
    async setReference({ file, ...options }) {
      return call("setReference", { ...options, path: path(file) });
    },
    // Scenes (docs/worlds.md): a library model by reference, the map, the audit, the tile,
    // the one-tile world.
    async place({ id, model, ...options }) {
      const result = await call("place", { id, model, ...options, ifRevision: await current() });
      revision = result.revision;
      return { revision, id, model: result.placed.model, bounds: result.placed.bounds, triangles: result.placed.triangles, warnings: result.warnings };
    },
    async rule(definition) {
      const result = await ws.apply([{ op: "rule", definition }]);
      return { revision: result.revision, id: definition.id };
    },
    async removeRule(id) {
      const result = await ws.apply([{ op: "removeRule", id }]);
      return { revision: result.revision };
    },
    async derive(options = {}) {
      const result = await call("derive", { ...options, ifRevision: await current() });
      revision = result.revision;
      return { revision, derived: result.derived };
    },
    async audit(options = {}) {
      const result = await call("audit", options);
      return { findings: result.findings, counts: result.counts, triangles: result.triangles };
    },
    async map({ file = "map.png", ...options } = {}) {
      const result = await call("map", options);
      const target = await write(file, Buffer.from(result.dataUrl.split(",")[1], "base64"));
      return { file: target, width: result.width, height: result.height, metresPerPixel: result.metresPerPixel, bounds: result.bounds };
    },
    async exportTile({ file = "tile.fun3d", ...options } = {}) {
      const result = await call("exportTile", options);
      return { file: await write(file, Buffer.from(result.data, "base64")), ...result.report };
    },
    async exportWorld({ dir = "world", ...options } = {}) {
      const result = await call("exportWorld", options);
      const written = [];
      for (const f of result.files) written.push(await write(join(dir, f.path), Buffer.from(f.data, "base64")));
      return { dir: path(dir), files: written, tiles: result.manifest.tiles.length, models: Object.keys(result.manifest.models), report: result.report };
    },
  };
  return { ws, files, status: () => ({ revision, committedCalls }) };
}

// Runs a model script and returns the one-line result the CLI prints.
export async function runScript(file, invoke) {
  const script = resolve(file),
    { ws, files, status } = scriptApi(invoke, dirname(script));
  const module = await import(pathToFileURL(script).href);
  if (typeof module.default !== "function")
    throw new Error("A model script exports a default async function (ws)");
  let returned;
  try { returned = await module.default(ws); }
  catch (error) {
    const state = status();
    throw new ScriptError({ code: error?.code ?? "script_error", message: error?.message ?? String(error),
      ...error?.info, partialCommit: state.committedCalls > 0 || error?.info?.partialCommit === true,
      revision: error?.info?.revision ?? state.revision });
  }
  const state = await ws.inspect();
  const result = {
    ok: true,
    revision: state.revision,
    stats: state.stats,
    validation: await ws.validate(),
    files,
    // What the script returns (an export report, usually) comes out with the run.
    ...(returned !== undefined ? { result: returned } : {}),
  };
  // A scene (placed models, markers, zones or paths) carries its audit too.
  const { placed = 0, markers = 0, zones = 0, paths = 0 } = state.stats;
  if (placed + markers + zones + paths > 0) {
    const audit = await ws.audit();
    result.audit = {
      ...audit.counts,
      findings: audit.findings.map((f) => ({ code: f.code, node: f.node ?? f.nodes, message: f.message })),
    };
  }
  return result;
}

export async function guideText(root) {
  return (
    process.env.FUNDEV_WORKSHOP_GUIDE ||
    (await readFile(resolve(root, "docs/workshop-agents.md"), "utf8"))
  );
}
