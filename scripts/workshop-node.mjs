// The workshop without a browser (docs/model-editor.md "Agents without the repository"): the
// page's own modules (document store, geometry kernel, viewport, agent API in engine.js) run in
// Node, drawn by the software renderer, so `fundev-workshop.mjs --run` needs Node and nothing
// else. The draft lives in memory; the agent tool writes sessions and files itself.
import { installShims, Canvas } from "./workshop-shims.mjs";

/**
 * The draft API of site/workshop/draft.js, in memory. Like the page, a record whose metadata is
 * damaged opens protected: readable, never written, its original kept as the recovery source.
 */
export function memoryDraft(initial, { createError, readMetadata, jsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length }) {
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
      if (jsonBytes(next) > 96 * 1024 * 1024)
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
  const [{ loadKernel }, document, { createViewport }, engineModule, { readMetadata }, { jsonBytes }] = await Promise.all([
    import("../site/workshop/kernel.js"),
    import("../site/workshop/document.js"),
    import("../site/workshop/viewport.js"),
    import("../site/workshop/engine.js"),
    import("../site/workshop/draft.js"),
    import("../site/workshop/dense.js"),
  ]);
  const { createEngine, normalizeSelection, followRenames } = engineModule;
  // Node has no site: the model library comes from its public origin.
  const library = await import("../site/workshop/library.js");
  library.setLibraryOrigin(process.env.FUNDEV_LIBRARY_ORIGIN || library.PUBLIC_LIBRARY);
  await loadKernel(kernel);
  const createError = (message, code) => new document.ModelError(message, code);
  // Dense meshes are counted by their bytes, not encoded, on every activity entry.
  const draft = memoryDraft(record ?? { project: document.duckProject(), revision: 0 }, { createError, readMetadata, jsonBytes });
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
  const drawing = await createViewport(canvas, {
    onError: (error) => process.stderr.write(`workshop: ${error.message}\n`),
  });
  // Unlike the page, nothing here is on screen: a change only marks the drawing stale, and the
  // next call that reads the viewport (a view, bounds, the camera, a pick) brings it up to date
  // first. Agents make many edits between looks; a rebuild costs tens of milliseconds at a
  // hundred thousand triangles.
  let stale = false;
  const viewport = new Proxy(drawing, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== "function") return value;
      return (...args) => {
        if (stale && key !== "setProject" && key !== "dispose") {
          stale = false;
          target.setProject(store.snapshot());
          target.select(selection);
        }
        return value.apply(target, args);
      };
    },
  });
  viewport.setProject(store.snapshot());
  viewport.select(selection);
  // The page frames the model when it opens; so does this.
  viewport.view();
  await viewport.setReferences(draft.record.references ?? []);
  // As the page does: renames carry the selection, the draft keeps every revision; the
  // viewport follows the store when it is next read.
  store.subscribe((results = []) => {
    const project = store.snapshot();
    followRenames(results, selection, viewState);
    try {
      normalizeSelection(project, selection);
      stale = true;
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
