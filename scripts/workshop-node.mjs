// The workshop without a browser (docs/model-editor.md "Agents without the repository"): the
// page's own modules (document store, geometry kernel, viewport, agent API in engine.js) run in
// Node, drawn by the software renderer, so `fundev-workshop.mjs --run` needs Node and nothing
// else. The draft lives in memory; the agent tool writes sessions and files itself.
import { installShims, Canvas } from "./workshop-shims.mjs";

/**
 * The draft API of site/editor/draft.js, in memory. Like the page, a record whose metadata is
 * damaged opens protected: readable, never written, its original kept as the recovery source.
 */
export function memoryDraft(initial, { createError, readMetadata }) {
  const metadata = readMetadata(structuredClone(initial));
  let record = metadata.record,
    activated = false,
    recovery = null,
    recoverySources = null;
  if (metadata.damaged || initial.recovery) {
    const reason = initial.recovery;
    recovery =
      reason && typeof reason.code === "string" && typeof reason.message === "string"
        ? reason
        : {
            code: "draft_recovery",
            message: "Saved records are damaged or disagree. Originals are protected; continue in a recovered copy.",
          };
    // The session file is this draft's journal.
    recoverySources = structuredClone(initial.recoverySources ?? { indexedDB: null, journal: JSON.stringify(initial), legacy: null });
  }
  const persistence = () => ({
    state: recovery ? "recovery" : "saved",
    revision: record.revision,
    persistedRevision: record.revision,
    journalRevision: record.revision,
    backend: "memory",
  });
  return {
    id: "default",
    get record() {
      return record;
    },
    get writable() {
      return !recovery;
    },
    get recovery() {
      return structuredClone(recovery);
    },
    get recoverySources() {
      return structuredClone(recoverySources);
    },
    restoreError: !!recovery,
    storageError: false,
    get persistence() {
      return persistence();
    },
    activate() {
      activated = true;
    },
    quarantine(error) {
      recovery = { code: error.code ?? "invalid", message: error.message };
      recoverySources ??= { indexedDB: null, journal: JSON.stringify(initial), legacy: null };
    },
    assert(revision) {
      if (recovery) throw createError("Original draft is protected. Download it or recover a copy.", "recovery");
      if (revision !== record.revision) throw createError("The document revision changed", "conflict");
    },
    save(project, revision) {
      if (recovery) throw createError("Original draft is protected", "recovery");
      record = { ...record, project, revision };
      return persistence();
    },
    setMetadata(metadata) {
      this.assert(record.revision);
      const next = { ...record, ...metadata };
      if (new TextEncoder().encode(JSON.stringify(next)).length > 96 * 1024 * 1024)
        throw createError("Draft with checkpoints exceeds 96 MB", "budget");
      record = next;
      return persistence();
    },
    async flush() {
      return persistence();
    },
    async retry() {},
    async copy() {
      throw createError("Copies of a draft are a page feature", "unsupported");
    },
    dispose() {
      activated = false;
    },
    get activated() {
      return activated;
    },
  };
}

/**
 * Opens a workshop session: { api } with the methods of window.funEditor. record is a session
 * ({ project, revision, checkpoints?, activity?, receipts?, references? }) or nothing for the
 * example duck; kernel is { module, wasmBinary } in the bundled tool.
 */
export async function openWorkshop({ record, kernel = {}, width = 1440, height = 900 } = {}) {
  installShims();
  // Unbundled, the page's site paths (/runtime/three.js…) need mapping to node_modules.
  if (typeof __WORKSHOP_BUNDLED__ === "undefined")
    (await import("node:module")).register("./workshop-resolve.mjs", import.meta.url);
  const [{ loadKernel }, document, { createViewport }, engineModule, { readMetadata }] = await Promise.all([
    import("../site/editor/kernel.js"),
    import("../site/editor/document.js"),
    import("../site/editor/viewport.js"),
    import("../site/editor/engine.js"),
    import("../site/editor/draft.js"),
  ]);
  const { createEngine, normalizeSelection, followRenames } = engineModule;
  await loadKernel(kernel);
  const createError = (message, code) => new document.ModelError(message, code);
  const draft = memoryDraft(record ?? { project: document.duckProject(), revision: 0 }, { createError, readMetadata });
  // A protected draft shows its last geometry as saved, without evaluating it again.
  const store = document.createStore(draft.recovery ? draft.record.project : document.evaluateProject(draft.record.project), {
    revision: draft.record.revision,
    cached: !!draft.recovery,
    beforeChange: (revision) => draft.assert(revision),
  });
  draft.activate();
  const viewState = { hidden: new Set(), locked: new Set(), isolated: null };
  let selection = normalizeSelection(store.snapshot(), { id: null, ids: [], mode: "object", faces: [], vertices: [], edges: [] }, true);
  const canvas = new Canvas(width, height);
  canvas.layout(width, height);
  globalThis.document.body.append(canvas);
  const viewport = await createViewport(canvas, {
    onError: (error) => process.stderr.write(`workshop: ${error.message}\n`),
  });
  viewport.setProject(store.snapshot());
  viewport.select(selection);
  // The page frames the model when it opens; so does this.
  viewport.view();
  await viewport.setReferences(draft.record.references ?? []);
  // As the page does: renames carry the selection, the viewport follows the store, the draft
  // keeps every revision.
  store.subscribe((results = []) => {
    const project = store.snapshot();
    followRenames(results, selection, viewState);
    try {
      viewport.setProject(project);
      normalizeSelection(project, selection);
      viewport.select(selection);
    } finally {
      if (!draft.recovery) draft.save(project, store.revision);
    }
  });
  const engine = createEngine({
    store,
    draft,
    viewport,
    viewState,
    getSelection: () => selection,
    setSelection: (next) => {
      selection = next;
    },
    ui: {
      afterReplace: () => {
        viewState.hidden.clear();
        viewState.locked.clear();
        viewState.isolated = null;
        viewport.setViewState(viewState);
        normalizeSelection(store.snapshot(), selection, true);
        viewport.select(selection);
        viewport.view();
      },
      afterSelect: () => {
        normalizeSelection(store.snapshot(), selection);
        viewport.select(selection);
      },
    },
  });
  return {
    api: engine.api,
    dispose() {
      viewport.dispose();
      draft.dispose();
    },
  };
}
