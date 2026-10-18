// The API behind --run: a model script receives `ws` and builds the model from scratch, the
// way a Blender script does. Revisions, file paths and compact results are handled here, so
// one run is one call and its output stays short.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, extname, basename } from "node:path";
import { pathToFileURL } from "node:url";

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
    errors: group(validation.errors ?? []),
    warnings: group(validation.warnings ?? []),
  };
};

export function scriptApi(invoke, base) {
  const files = [];
  let revision;
  const path = (file) => resolve(base, file);
  async function call(method, args = {}) {
    const result = await invoke("fun_editor_" + method, args);
    if (result.isError) throw new ScriptError(result.structuredContent?.error);
    return result.structuredContent;
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
    // A fresh project; materials need only id and color.
    async load({ name = "Model", materials = [], nodes = [], ...rest } = {}) {
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
    async apply(commands, { label } = {}) {
      const result = await call("apply", {
        commands,
        ifRevision: await current(),
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
      return {
        revision,
        changed: result.changed,
        ...(result.removed?.length ? { removed: result.removed } : {}),
        ...(idMaps?.length ? { idMaps } : {}),
      };
    },
    async undo() {
      const result = await call("undo", { ifRevision: await current() });
      revision = result.revision;
      return { revision };
    },
    inspect: (args = {}) => call("inspect", args),
    query: (args) => call("query", args),
    validate: async (budget = {}) => summary(await call("validate", budget)),
    // One view writes `file`; several write `file` with -<view> before the extension.
    async observe(names = ["perspective"], { file = "view.png", ...options } = {}) {
      const result = await call("observe", { names, ...options });
      const written = [];
      for (const shot of result.observations) {
        const name =
          names.length === 1
            ? file
            : `${basename(file, extname(file))}-${shot.view}${extname(file) || ".png"}`;
        written.push(
          await write(
            resolve(dirname(path(file)), basename(name)),
            Buffer.from(shot.dataUrl.split(",")[1], "base64"),
          ),
        );
      }
      return written;
    },
    async exportGLB({ file = "model.glb", ...options } = {}) {
      const result = await call("exportGLB", options);
      const target = await write(file, Buffer.from(result.data, "base64"));
      const r = result.report ?? {};
      return {
        file: target,
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
    async setReference({ file, ...options }) {
      return call("setReference", { ...options, path: path(file) });
    },
  };
  return { ws, files };
}

// Runs a model script and returns the one-line result the CLI prints.
export async function runScript(file, invoke) {
  const script = resolve(file),
    { ws, files } = scriptApi(invoke, dirname(script));
  const module = await import(pathToFileURL(script).href);
  if (typeof module.default !== "function")
    throw new Error("A model script exports a default async function (ws)");
  await module.default(ws);
  const state = await ws.inspect();
  return {
    ok: true,
    revision: state.revision,
    stats: state.stats,
    validation: await ws.validate(),
    files,
  };
}

export async function guideText(root) {
  return (
    process.env.FUNDEV_WORKSHOP_GUIDE ||
    (await readFile(resolve(root, "docs/workshop-agents.md"), "utf8"))
  );
}
