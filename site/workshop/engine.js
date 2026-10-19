// The workshop's agent API (docs/model-editor.md "Agent API v3") without the page around it.
// The workshop page wraps it as window.funEditor next to its panels and dialogs; the agent
// tool runs the same object in Node (scripts/workshop-node.mjs) with the same document store,
// draft record and viewport, so both answer every call the same way. What only a page has
// (dialogs with unsaved input, panels to refresh) comes in through `ui`.
import {
  capabilities,
  commandsSchema,
  validateSchema,
  querySchema,
  recipeStageQuerySchema,
  errorInfo,
} from "./agent-contract.js";
import { queryComponents, resolveComponents } from "./components.js";
import {
  validateProject,
  statistics,
  ModelError,
  getRecipe,
  inspectNode,
  inspectRecipeStage,
  measure,
  nodeSummary,
} from "./document.js";
import { toolboxAssemblyCommands, assetFor } from "./assembly.js";
import { listBlueprints } from "./blueprints.js";
import { describeChanges } from "./changes.js";
import { hollowBoxRecipe } from "./recipe.js";
import { exportReport, exportAsset } from "./viewport.js";
import { importModel } from "./import-glb.js";
import { searchLibrary, libraryModel, importLibraryModel } from "./library.js";
import { fromBase64, toBase64 } from "./glb.js";
import { projectFile, projectFilename } from "./project-file.js";
import { materialUsage } from "./materials.js";
import {
  normalizeReference,
  referenceSummary,
  REFERENCE_VIEWS,
} from "./references.js";
import { meshEdges } from "./topology.js";
import { t } from "../i18n.js";

export const filename = (name) =>
  name.replace(/[^\p{L}\p{N}_.-]+/gu, "-").slice(0, 80) || "model";

/** The selection after a project change: parts that still exist, components that still fit. */
export function normalizeSelection(project, selection, reset = false) {
  selection.ids = selection.ids.filter((id) => project.nodes.some((n) => n.id === id));
  if (!project.nodes.some((n) => n.id === selection.id))
    selection.id =
      selection.ids.at(-1) ??
      project.nodes.find((n) => n.mesh)?.id ??
      project.nodes[0]?.id ??
      null;
  if (selection.id && !selection.ids.length) selection.ids = [selection.id];
  const n = project.nodes.find((v) => v.id === selection.id);
  selection.faces = selection.faces.filter((id) => n?.mesh?.faces.some((f) => f.id === id));
  selection.vertices = selection.vertices.filter((i) => n?.mesh?.vertices[i]);
  selection.edges = (selection.edges ?? []).filter(
    (id) => n?.mesh && meshEdges(n.mesh).some((e) => e.id === id),
  );
  if (reset) {
    selection.faces = n?.mesh ? [n.mesh.faces[0].id] : [];
    selection.vertices = n?.mesh ? [0] : [];
    selection.edges = [];
  }
  selection.face = selection.faces.at(-1) ?? null;
  selection.vertex = selection.vertices.at(-1) ?? 0;
  return selection;
}

/** A rename keeps the selection and the view state on the same part. */
export function followRenames(results, selection, viewState) {
  for (const r of results)
    if (r.op === "rename")
      for (const [from, to] of Object.entries(r.idMap ?? {})) {
        if (selection.id === from) selection.id = to;
        selection.ids = selection.ids.map((id) => (id === from ? to : id));
        for (const set of [viewState.hidden, viewState.locked, viewState.isolated])
          if (set?.delete(from)) set.add(to);
      }
}

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let result = "";
  for (let i = 0; i < bytes.length; i += 8192)
    result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}

/**
 * The agent API over a document store, its draft and a viewport. `getSelection` and
 * `setSelection` reach the caller's selection; `viewState` is shared and mutated in place.
 * ui: status(message, error), flushPending() → false while page input cannot be committed,
 * pendingInput(), hasPendingParameters(), shapePending(), afterReplace() after the project is
 * replaced (load, undo, import, restore), afterSelect().
 */
export function createEngine({ store, draft, viewport, viewState, getSelection, setSelection, ui = {} }) {
  const {
    status = () => {},
    flushPending = () => true,
    pendingInput = () => false,
    hasPendingParameters = () => false,
    shapePending = () => false,
    afterReplace = () => {},
    afterSelect = () => {},
  } = ui;
  let previous = store.snapshot(),
    comparison = null,
    action = null;
  const receipts = new Map(draft.record.receipts ?? []);
  const saveLog = (entry) => {
    try {
      draft.setMetadata({
        activity: [...(draft.record.activity ?? []), entry].slice(-30),
      });
    } catch (e) {
      status(e.message, true);
    }
  };
  store.subscribe(() => {
    const after = store.snapshot(),
      before = previous;
    previous = after;
    comparison = { before, after, revision: store.revision };
    const changed = after.nodes
        .filter(
          (n) =>
            JSON.stringify(n) !==
            JSON.stringify(before.nodes.find((v) => v.id === n.id)),
        )
        .map((n) => n.id),
      removed = before.nodes
        .filter((n) => !after.nodes.some((v) => v.id === n.id))
        .map((n) => n.id);
    const report = validateProject(after);
    const entry = {
      id: crypto.randomUUID(),
      revision: store.revision,
      time: new Date().toISOString(),
      label: action ?? t("edEdit"),
      changed,
      removed,
      stats: statistics(after),
      ...describeChanges(before, after),
      issues: [...report.errors, ...report.warnings].map((i) => ({
        code: i.code,
        node: i.node,
        face: i.face,
      })),
      detachedRecipes: before.nodes
        .filter(
          (n) => n.recipe && !after.nodes.find((v) => v.id === n.id)?.recipe,
        )
        .map((n) => n.id),
    };
    saveLog(entry);
    status(
      `${entry.label} · r${entry.revision} · ${entry.affected.length} ${t("edParts")} · ${entry.issues.length} ${t("edWarnings")}`,
    );
  });
  const check = (options) => {
    if (
      options?.ifRevision !== undefined &&
      options.ifRevision !== store.revision
    )
      throw new ModelError("Project changed; inspect and retry", "conflict");
  };
  const pendingError = () =>
    new ModelError(
      t(
        shapePending()
          ? "edShapePending"
          : hasPendingParameters()
            ? "edParameterPending"
            : "edInvalidField",
      ),
      "pending_input",
    );
  // Unsaved page input (a shape dialog, parameter fields) is committed or blocks the call.
  const commitPending = () => {
    if (hasPendingParameters())
      throw new ModelError(t("edParameterPending"), "pending_input");
    if (!flushPending())
      throw new ModelError(
        t(shapePending() ? "edShapePending" : "edInvalidField"),
        "pending_input",
      );
  };
  const api = {
    version: 3,
    inspect({ id, detail = "summary" } = {}) {
      const p = store.snapshot(),
        selection = getSelection(),
        common = {
          revision: store.revision,
          draftId: draft.id,
          writable: draft.writable,
          recovery: draft.recovery,
          units: "meters",
          renderer: viewport.rendererInfo(),
          persistence: draft.persistence,
          pendingInput: !!pendingInput(),
        };
      if (id) {
        return { ...common, ...inspectNode(p, id, { detail }) };
      }
      return {
        ...common,
        name: p.name,
        assemblies: p.assemblies,
        assembly: assetFor(p, selection.id),
        selection: structuredClone(selection),
        stats: statistics(p),
        bounds: viewport.bounds(),
        camera: viewport.cameraInfo(),
        viewState: {
          hidden: [...viewState.hidden],
          locked: [...viewState.locked],
          isolated: viewState.isolated ? [...viewState.isolated] : null,
        },
        nodes: p.nodes.map((n) => ({
          ...nodeSummary(n),
          bounds: measure(p, n.id, { components: false }).bounds,
        })),
        materials: materialUsage(p),
      };
    },
    getProject: () => store.snapshot(),
    loadProject(p, options) {
      if (!flushPending()) throw pendingError();
      const result = store.replace(p, options);
      afterReplace();
      return { ...result, persistence: draft.persistence };
    },
    select(id, opts = {}) {
      if (!flushPending()) throw pendingError();
      const p = store.snapshot(),
        current = getSelection(),
        ids = Array.isArray(id) ? id : [id],
        n = p.nodes.find((n) => n.id === ids.at(-1));
      if (!ids.length || ids.some((id) => !p.nodes.some((n) => n.id === id)))
        throw new Error("Unknown selection");
      opts = resolveComponents(
        p,
        { ...opts, id: n.id },
        { selectionOnly: true },
      );
      const mode = opts.mode ?? current.mode;
      if (!["object", "face", "vertex", "edge"].includes(mode))
        throw new Error("Unknown selection mode");
      const faces =
          opts.faces ??
          (opts.face !== undefined
            ? [opts.face]
            : n.mesh
              ? [n.mesh.faces[0].id]
              : []),
        vertices = opts.vertices ?? [opts.vertex ?? 0],
        edges = opts.edges ?? (opts.edge ? [opts.edge] : []);
      if (
        edges.some(
          (id) => !n.mesh || !meshEdges(n.mesh).some((e) => e.id === id),
        )
      )
        throw new Error("Unknown edge");
      if (
        faces.some((id) => !n.mesh?.faces.some((f) => f.id === id)) ||
        vertices.some(
          (i) => !Number.isInteger(i) || (n.mesh && !n.mesh.vertices[i]),
        )
      )
        throw new Error("Unknown component");
      setSelection({
        id: n.id,
        ids,
        mode,
        faces,
        vertices: n.mesh ? vertices : [],
        edges,
      });
      afterSelect();
      return structuredClone(getSelection());
    },
    view: (name, options) => viewport.view(name, options),
    focus: () => viewport.focus(),
    renderViews(views, { size = 512, ...options } = {}) {
      const revision = store.revision;
      return viewport
        .renderViews(views, size, options)
        .map((shot) => ({ ...shot, revision, draftId: draft.id }));
    },
    validate: (budget) => ({
      revision: store.revision,
      ...validateProject(store.snapshot(), budget),
    }),
    async setReference(spec) {
      const next = normalizeReference(spec),
        list = [
          ...(draft.record.references ?? []).filter((r) => r.view !== next.view),
          next,
        ];
      await viewport.setReferences(list);
      const persistence = draft.setMetadata({ references: list });
      return { references: list.map(referenceSummary), persistence };
    },
    async clearReference({ view } = {}) {
      if (view !== undefined && !REFERENCE_VIEWS.includes(view))
        throw new ModelError("Choose front, back, left, right or top", "invalid", "view");
      const list = (draft.record.references ?? []).filter(
        (r) => view !== undefined && r.view !== view,
      );
      await viewport.setReferences(list);
      const persistence = draft.setMetadata({ references: list });
      return { references: list.map(referenceSummary), persistence };
    },
    references: () => (draft.record.references ?? []).map(referenceSummary),
    async exportGLB({ encoding = "buffer", ...options } = {}) {
      if (!["buffer", "base64"].includes(encoding))
        throw new Error("Use buffer or base64 encoding");
      if (!flushPending()) throw pendingError();
      const p = store.snapshot(),
        revision = store.revision,
        { buffer, report } = await exportAsset(p, options);
      return encoding === "base64"
        ? {
            revision,
            report,
            filename: `${filename(p.name)}.glb`,
            mimeType: "model/gltf-binary",
            data: base64(buffer),
          }
        : buffer;
    },
    capabilities,
    getRecipe(options) {
      check(options);
      return {
        revision: store.revision,
        ...getRecipe(store.snapshot(), options),
      };
    },
    recipeStage({ id, index, query = {}, views, size = 512, ...options }) {
      validateSchema(query, recipeStageQuerySchema);
      if (query.offset > 0 && options.ifRevision === undefined)
        throw new ModelError(
          "Continue pagination with ifRevision from the first page",
          "conflict",
          "ifRevision",
        );
      check(options);
      const { project, selection, ...stage } = inspectRecipeStage(
        store.snapshot(),
        { id, index, query },
      );
      return {
        revision: store.revision,
        ...stage,
        ...(views
          ? {
              observations: viewport
                .renderProject(project, views, size, {
                  ids: [id],
                  helpers: false,
                  overlays: { wire: true, selection: true },
                  selection,
                })
                .map((shot) => ({
                  ...shot,
                  revision: store.revision,
                  draftId: draft.id,
                  recipeStep: index,
                })),
            }
          : {}),
      };
    },
    presets: () => ({
      hollowBox: hollowBoxRecipe(),
      toolbox: toolboxAssemblyCommands(hollowBoxRecipe()),
    }),
    blueprints: () => listBlueprints(),
    flush: () => draft.flush(),
    undo(options = {}) {
      commitPending();
      check(options);
      action = t("edUndo");
      try {
        const changed = store.undo();
        afterReplace();
        return {
          changed,
          revision: store.revision,
          persistence: draft.persistence,
        };
      } finally {
        action = null;
      }
    },
    redo(options = {}) {
      commitPending();
      check(options);
      action = t("edRedo");
      try {
        const changed = store.redo();
        afterReplace();
        return {
          changed,
          revision: store.revision,
          persistence: draft.persistence,
        };
      } finally {
        action = null;
      }
    },
    query(options) {
      validateSchema(options, querySchema);
      if (options.offset > 0 && options.ifRevision === undefined)
        throw new ModelError(
          "Continue pagination with ifRevision from the first page",
          "conflict",
          "ifRevision",
        );
      check(options);
      return {
        revision: store.revision,
        ...queryComponents(store.snapshot(), options),
      };
    },
    preview(
      commands,
      { views, size = 512, detail = "summary", ...options } = {},
    ) {
      if (!["summary", "full"].includes(detail))
        throw new ModelError(
          "Expected summary or full preview detail",
          "schema",
          "detail",
        );
      validateSchema(commands, commandsSchema, "commands");
      check(options);
      const result = store.preview(commands, {
        ...options,
        strictComponents: true,
      });
      const { project, ...summary } = result;
      return {
        ...summary,
        name: project.name,
        nodes: project.nodes.map((n) => inspectNode(project, n.id)),
        materials: project.materials,
        ...(detail === "full" ? { project } : {}),
        validation: validateProject(project),
        ...(views
          ? {
              observations: viewport
                .renderProject(result.project, views, size, {
                  visibility: "all",
                  helpers: false,
                })
                .map((v) => ({
                  ...v,
                  revision: store.revision,
                  draftId: draft.id,
                  preview: true,
                })),
            }
          : {}),
      };
    },
    apply(commands, options = {}) {
      // An acknowledged request can be retried without applying a relative edit twice.
      if (options.operationId) {
        if (
          typeof options.operationId !== "string" ||
          options.operationId.length > 128
        )
          throw new ModelError("Invalid operationId");
        const prior = receipts.get(options.operationId),
          signature = JSON.stringify(commands);
        if (prior) {
          if (prior.signature !== signature)
            throw new ModelError(
              "operationId was used for different commands",
              "conflict",
            );
          return {
            ...structuredClone(prior.result),
            replayed: true,
            persistence: draft.persistence,
          };
        }
      }
      commitPending();
      check(options);
      validateSchema(commands, commandsSchema, "commands");
      action =
        options.label ??
        `Agent · ${commands
          .map((c) => c.op)
          .filter((v, i, a) => a.indexOf(v) === i)
          .join(", ")}`;
      try {
        const result = {
          ...store.apply(commands, { ...options, strictComponents: true }),
          operationId: options.operationId ?? null,
          persistence: draft.persistence,
        };
        if (options.operationId) {
          receipts.set(options.operationId, {
            signature: JSON.stringify(commands),
            result: {
              revision: result.revision,
              stats: result.stats,
              changed: result.changed,
              removed: result.removed,
              materials: result.materials,
              operationId: result.operationId,
              results: result.results
                .filter((r) => r.idMap)
                .map(({ index, op, idMap }) => ({ index, op, idMap })),
            },
          });
          if (receipts.size > 32) receipts.delete(receipts.keys().next().value);
          try {
            draft.setMetadata({ receipts: [...receipts] });
          } catch (e) {
            result.receiptPersisted = false;
            status(e.message, true);
          }
        }
        result.persistence = draft.persistence;
        return result;
      } catch (e) {
        saveLog({
          id: crypto.randomUUID(),
          revision: store.revision,
          time: new Date().toISOString(),
          label: action,
          error: errorInfo(e),
        });
        status(e.message, true);
        throw e;
      } finally {
        action = null;
      }
    },
    checkpoints() {
      return (draft.record.checkpoints ?? []).map(
        ({ project, ...meta }) => meta,
      );
    },
    checkpoint({ name = store.snapshot().name } = {}, options = {}) {
      commitPending();
      check(options);
      draft.assert(store.revision);
      if (typeof name !== "string" || !name.trim() || name.length > 100)
        throw new ModelError("Checkpoint name must be 1–100 characters");
      const list = draft.record.checkpoints ?? [];
      if (list.length >= 5)
        throw new ModelError(
          "Five checkpoints already exist; remove one or download a backup",
          "budget",
        );
      const item = {
        id: crypto.randomUUID(),
        name,
        revision: store.revision,
        time: new Date().toISOString(),
        project: store.snapshot(),
      };
      draft.setMetadata({ checkpoints: [...list, item] });
      return { ...api.checkpoints().at(-1), persistence: draft.persistence };
    },
    restoreCheckpoint(id, options = {}) {
      commitPending();
      check(options);
      const item = draft.record.checkpoints?.find((c) => c.id === id);
      if (!item) throw new ModelError("Unknown checkpoint");
      action = `${t("edRestoreCheckpoint")} · ${item.name}`;
      try {
        const result = store.replace(item.project, options);
        afterReplace();
        return { ...result, persistence: draft.persistence };
      } finally {
        action = null;
      }
    },
    removeCheckpoint(id, options = {}) {
      check(options);
      if (!draft.record.checkpoints?.some((c) => c.id === id))
        throw new ModelError("Unknown checkpoint");
      draft.setMetadata({
        checkpoints: draft.record.checkpoints.filter((c) => c.id !== id),
      });
      return api.checkpoints();
    },
    activity() {
      return structuredClone(draft.record.activity ?? []);
    },
    getSession() {
      return structuredClone({
        ...draft.record,
        project: draft.recovery ? draft.record.project : store.snapshot(),
        revision: store.revision,
        ...(draft.recovery ? { recovery: draft.recovery } : {}),
        ...(draft.recoverySources
          ? { recoverySources: draft.recoverySources }
          : {}),
      });
    },
    exportReport(options = {}) {
      return {
        revision: store.revision,
        ...exportReport(store.snapshot(), options),
      };
    },
    // A GLB or project file: replace the project (one undoable change) or add its parts.
    importGLB({ data, mode = "replace", parent, name } = {}, options = {}) {
      commitPending();
      check(options);
      const bytes = fromBase64(data);
      if (bytes.length > 64 * 1024 * 1024)
        throw new ModelError("The file is larger than 64 MB", "budget", "data");
      const imported = importModel(bytes, {
        mode,
        parent: parent ?? null,
        current: store.snapshot(),
        name,
      });
      action = imported.container ? t("edOpenedProject") : t("edImported");
      try {
        const result = store.replace(imported.project, options);
        afterReplace();
        return {
          ...result,
          nodes: imported.nodes,
          warnings: imported.warnings,
          container: imported.container,
          persistence: draft.persistence,
        };
      } finally {
        action = null;
      }
    },
    // The public model library (docs/library-api.md).
    librarySearch: (options) => searchLibrary(options),
    libraryModel: (options) => libraryModel(options),
    async openLibraryModel({ id, version, mode = "replace", parent, name } = {}, options = {}) {
      commitPending();
      check(options);
      const revision = store.revision;
      const imported = await importLibraryModel({
        id,
        version,
        mode,
        parent: parent ?? null,
        current: store.snapshot(),
        name,
      });
      // The download took time: refuse if the project changed meanwhile.
      check({ ifRevision: options.ifRevision ?? revision });
      commitPending();
      action = t(imported.container ? "edOpenedProject" : "edImported");
      try {
        const result = store.replace(imported.project, options);
        afterReplace();
        return {
          ...result,
          source: imported.source,
          nodes: imported.nodes,
          warnings: imported.warnings,
          container: imported.container,
          persistence: draft.persistence,
        };
      } finally {
        action = null;
      }
    },
    async exportProject() {
      commitPending();
      const project = store.snapshot(),
        revision = store.revision,
        bytes = await projectFile(project);
      return {
        revision,
        filename: projectFilename(project.name),
        mimeType: "model/gltf-binary",
        bytes: bytes.length,
        data: toBase64(bytes),
      };
    },
  };
  return {
    api,
    commitPending,
    /** The change the latest revision made: { before, after, revision }. */
    get comparison() {
      return comparison;
    },
  };
}
