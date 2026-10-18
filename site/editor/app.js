import "./i18n.js";
import { initLocale, onLocaleChange, t } from "../i18n.js";
import {
  createStore,
  ModelError,
  emptyProject,
  duckProject,
  normalizeProject,
  evaluateProject,
  statistics,
  validateProject,
  measure,
  inspectNode,
  nodeSummary,
  shapeGenerator,
  LIMITS,
  evaluateCommands,
} from "./document.js";
import { assetFor, bindingFor } from "./assembly.js";
import { materialUsage } from "./materials.js";
import { createMaterialLibrary } from "./material-library.js";
import { createWorkbench, materialRuleFields } from "./workbench.js";
import {
  topologyToken,
  componentRef,
  resolveComponents,
} from "./components.js";
import {
  createViewport,
  exportGLB,
  exportAsset,
  exportReport,
} from "./viewport.js";
import { openDraft } from "./draft.js";
import { loadKernel } from "./kernel.js";
import { meshEdges, edgeKey } from "./topology.js";
import { profileEditor } from "./profile.js";
import { stoolProject, planterProject } from "./examples.js";

const $ = (selector) => document.querySelector(selector),
  all = (selector) => [...document.querySelectorAll(selector)];

const text = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
};
function status(message, error = false) {
  $("#status").textContent = message;
  $("#status").dataset.error = String(error);
}
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function filename(name) {
  return name.replace(/[^\p{L}\p{N}_.-]+/gu, "-").slice(0, 80) || "model";
}
function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let result = "";
  for (let i = 0; i < bytes.length; i += 8192)
    result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
function options(select, entries, selected) {
  select.replaceChildren(
    ...entries.map(([value, label]) => {
      const option = text("option", label);
      option.value = value;
      return option;
    }),
  );
  select.value = selected ?? entries[0]?.[0] ?? "";
}
let lengthUnit = "m";
const unitFactor = () => ({ m: 1, cm: 0.01, mm: 0.001 })[lengthUnit];
const lengthVectors = new Set([
  "position",
  "dimensions",
  "vertex",
  "selectionMove",
  "primitiveSize",
  "pivot",
]);
const lengthFields = [
  "extrude-distance",
  "inset-distance",
  "bevel-distance",
  "edge-bevel-distance",
  "cut-offset",
  "symmetry-offset",
  "radius",
  "height",
  "depth",
  "box-bevel",
];
const distanceValue = (id) => Number($("#" + id).value) * unitFactor();
function vectorValue(name) {
  return all(`[data-vector="${name}"] input`).map((input) => {
    if (!input.reportValidity()) throw new Error(t("edInvalidField"));
    return Number(input.value) * (lengthVectors.has(name) ? unitFactor() : 1);
  });
}
function setVector(name, value) {
  all(`[data-vector="${name}"] input`).forEach((input, i) => {
    input.value = Number(
      (value[i] / (lengthVectors.has(name) ? unitFactor() : 1)).toFixed(6),
    );
  });
}
for (const container of all("[data-vector]")) {
  for (const [index, axis] of ["X", "Y", "Z"].entries()) {
    const label = text("label", axis),
      input = document.createElement("input");
    input.type = "number";
    input.required = true;
    input.step = "any";
    input.min = [
      "scale",
      "selectionScale",
      "primitiveSize",
      "dimensions",
    ].includes(container.dataset.vector)
      ? "0.001"
      : "-10000";
    input.max = [
      "scale",
      "selectionScale",
      "primitiveSize",
      "dimensions",
    ].includes(container.dataset.vector)
      ? "1000"
      : "10000";
    input.value = [
      "scale",
      "selectionScale",
      "primitiveSize",
      "dimensions",
    ].includes(container.dataset.vector)
      ? "1"
      : "0";
    input.name = `${container.dataset.vector}-${index}`;
    label.append(input);
    container.append(label);
  }
}
initLocale();

start().catch((error) => {
  $("#boot-message").textContent = t("edFailure");
  status(t("edError") + error.message, true);
  console.error(error);
});

async function start() {
  let workbench,
    draft,
    store,
    selection,
    materialId = null,
    editingShape = null,
    shapeRepair = [],
    applyingShape = false,
    rendering = false,
    transformMode = "translate",
    shapePreview = null,
    shapePreviewInit = null,
    shapePreviewController = null,
    previewRevision = 0,
    shapeSignature = null,
    previewFrame = 0,
    previousMode = null;
  const viewState = { hidden: new Set(), locked: new Set(), isolated: null };
  function draftState() {
    if (!draft || !store) return;
    $("#draft-banner").hidden = draft.writable && !draft.storageError;
    $("#draft-message").textContent = t(
      draft.recovery
        ? "edRecoveryDraft"
        : draft.storageError
          ? "edStorageError"
          : "edReadOnly",
    );
    $("#draft-original").hidden = !draft.recovery;
    $("#draft-copy").textContent = t(
      draft.recovery ? "edRecoveryCopy" : "edDraftCopy",
    );
    $("#save-status").textContent = t(
      draft.recovery
        ? "edNeedsReview"
        : draft.storageError
          ? "edStorageError"
          : draft.writable
            ? draft.persistence.state === "pending"
              ? "edSaving"
              : "edSaved"
            : "edReadOnly",
    );
  }
  // Drafts may hold kernel-built geometry, so the kernel is ready before they evaluate.
  await loadKernel();
  draft = await openDraft(duckProject(), draftState);
  let initial,
    restoreError = draft.restoreError;
  try {
    initial = evaluateProject(draft.record.project);
  } catch (error) {
    draft.quarantine(error);
    // Keep the last geometry visible without replacing the damaged source.
    const cached = structuredClone(draft.record.project);
    delete cached.assembly;
    cached.assemblies = [];
    for (const n of Array.isArray(cached.nodes) ? cached.nodes : []) {
      if (!n || typeof n !== "object") continue;
      for (const key of [
        "recipe",
        "generator",
        "instanceOf",
        "instanceBasis",
        "symmetry",
      ])
        delete n[key];
    }
    try {
      initial = normalizeProject(cached);
    } catch {
      initial = emptyProject(
        typeof draft.record.project?.name === "string"
          ? draft.record.project.name
          : "Recovery",
      );
    }
    restoreError = true;
  }
  store = createStore(initial, {
    revision: draft.record.revision,
    cached: !!draft.recovery,
    beforeChange: (r) => {
      if ($("#add-dialog").open && !applyingShape)
        throw new ModelError(t("edShapePending"), "pending_input");
      if (workbench?.hasPending())
        throw new ModelError(t("edParameterPending"), "pending_input");
      draft.assert(r);
    },
  });
  draft.activate();
  selection = {
    id: initial.nodes.find((n) => n.mesh)?.id ?? null,
    ids: [],
    mode: "object",
    faces: [],
    vertices: [],
    edges: [],
  };
  if (selection.id) selection.ids = [selection.id];
  const viewport = await createViewport($("#canvas"), {
    onError: (error) => {
      console.error(error);
      status(t("edError") + error.message, true);
    },
    onPick: pick,
    onTransform: (command) => {
      if (flushPending()) apply([command]);
    },
    onGrid: (step) => {
      $("#grid-label").textContent =
        t("edGrid") +
        " " +
        (step < 0.01
          ? Number((step * 1000).toFixed(4)) + " mm"
          : step < 1
            ? Number((step * 100).toFixed(4)) + " cm"
            : Number(step.toFixed(4)) + " m");
    },
    onBoxEnd: () => $("#box-select").setAttribute("aria-pressed", "false"),
  });
  viewport.setReadonly(!draft.writable);
  $("#renderer-label").textContent =
    viewport.rendererInfo().backend === "webgpu" ? "WebGPU" : "WebGL2";
  const profile = profileEditor($("#profile-editor"), $("#outline"), {
    onChange: scheduleShapePreview,
    step: () => Number($("#snap-step").value) / unitFactor(),
  });
  function act(fn, message = "edUpdated") {
    try {
      const value = fn();
      if (value === false) return false;
      status(t(message));
      return value;
    } catch (error) {
      status(t("edError") + error.message, true);
      return null;
    }
  }
  const apply = (commands) => act(() => store.apply(commands));
  const node = () => store.snapshot().nodes.find((n) => n.id === selection.id);
  const newId = (prefix, material = false) => {
    const list = material ? store.snapshot().materials : store.snapshot().nodes;
    let i = 1;
    while (list.some((n) => n.id === `${prefix}-${i}`)) i++;
    return `${prefix}-${i}`;
  };
  function updateSelection(reset = false) {
    const p = store.snapshot();
    selection.ids = selection.ids.filter((id) =>
      p.nodes.some((n) => n.id === id),
    );
    if (!p.nodes.some((n) => n.id === selection.id))
      selection.id =
        selection.ids.at(-1) ??
        p.nodes.find((n) => n.mesh)?.id ??
        p.nodes[0]?.id ??
        null;
    if (selection.id && !selection.ids.length) selection.ids = [selection.id];
    const n = node();
    selection.faces = selection.faces.filter((id) =>
      n?.mesh?.faces.some((f) => f.id === id),
    );
    selection.vertices = selection.vertices.filter((i) => n?.mesh?.vertices[i]);
    selection.edges = (selection.edges ?? []).filter(
      (id) => n?.mesh && meshEdges(n.mesh).some((e) => e.id === id),
    );
    if (reset) {
      selection.faces = n?.mesh ? [n.mesh.faces[0].id] : [];
      selection.vertices = n?.mesh ? [0] : [];
      selection.edges = [];
      materialId = null;
    }
    selection.face = selection.faces.at(-1) ?? null;
    selection.vertex = selection.vertices.at(-1) ?? 0;
    viewport.select(selection);
    renderUI();
  }
  function pick(part) {
    if (!flushPending()) return;
    if (part.empty) {
      if (!part.additive) {
        if (selection.mode === "object") {
          selection.id = null;
          selection.ids = [];
          viewport.select(selection);
          renderUI();
        } else {
          selection.faces = [];
          selection.vertices = [];
          selection.edges = [];
          updateSelection();
        }
      }
      return;
    }
    const items = part.items ?? [part];
    if (!items.length) return;
    if (selection.mode === "object") {
      const ids = part.additive ? [...selection.ids] : [];
      for (const item of items) {
        const i = ids.indexOf(item.id);
        if (part.additive && !part.items && i >= 0) ids.splice(i, 1);
        else if (i < 0) ids.push(item.id);
      }
      selection.ids = ids;
      selection.id = ids.at(-1) ?? null;
      selection.faces = [];
      selection.vertices = [];
      selection.edges = [];
      materialId = null;
    } else {
      if (items[0].id !== selection.id) {
        selection.id = items[0].id;
        selection.ids = [selection.id];
        selection.faces = [];
        selection.vertices = [];
        selection.edges = [];
        materialId = null;
      }
      const key =
          selection.mode === "face"
            ? "faces"
            : selection.mode === "edge"
              ? "edges"
              : "vertices",
        field =
          selection.mode === "face"
            ? "face"
            : selection.mode === "edge"
              ? "edge"
              : "vertex";
      const values = part.additive ? [...selection[key]] : [];
      for (const item of items) {
        if (item[field] === undefined) continue;
        const i = values.indexOf(item[field]);
        if (part.additive && !part.items && i >= 0) values.splice(i, 1);
        else if (i < 0) values.push(item[field]);
      }
      selection[key] = values;
    }
    if (!selection.id) {
      viewport.select(selection);
      renderUI();
    } else updateSelection();
  }
  function selectPart(id, additive = false) {
    if (selection.mode !== "object") {
      if (!flushPending()) return;
      selection.id = id;
      selection.ids = [id];
      updateSelection(true);
    } else pick({ id, additive });
  }
  function renderParts(p) {
    const order = [];
    const visit = (parent, depth) => {
      for (const n of p.nodes.filter((n) => n.parent === parent)) {
        order.push([n, depth]);
        visit(n.id, depth + 1);
      }
    };
    visit(null, 0);
    const current = new Map(
      all("#parts li").map((li) => [li.firstElementChild.dataset.node, li]),
    );
    for (const [i, [n, depth]] of order.entries()) {
      let li = current.get(n.id);
      if (!li) {
        li = document.createElement("li");
        const b = document.createElement("button");
        b.dataset.node = n.id;
        b.addEventListener("click", (e) => selectPart(n.id, e.shiftKey));
        li.append(b);
      }
      const b = li.firstElementChild;
      b.textContent = `${n.symmetry ? "↔" : n.instanceOf ? "↗" : n.mesh ? "◇" : "+"} ${n.name}`;
      b.style.setProperty("--depth", Math.min(depth, 6));
      b.title = n.id;
      b.setAttribute("aria-pressed", String(selection.ids.includes(n.id)));
      b.dataset.active = String(selection.id === n.id);
      b.dataset.related = String(
        !selection.ids.includes(n.id) &&
          (n.symmetry?.source === selection.id ||
            n.instanceOf === selection.id ||
            node()?.symmetry?.source === n.id ||
            node()?.instanceOf === n.id),
      );
      li.dataset.hidden = String(viewState.hidden.has(n.id));
      for (const [kind, set, label, on, off] of [
        ["visibility", viewState.hidden, "edVisibility", "○", "●"],
        ["lock", viewState.locked, "edLock", "◆", "◇"],
      ]) {
        let button = li.querySelector(`[data-${kind}]`);
        if (!button) {
          button = document.createElement("button");
          button.dataset[kind] = n.id;
          button.className = "tree-toggle";
          li.append(button);
          button.onclick = () => {
            set.has(n.id) ? set.delete(n.id) : set.add(n.id);
            syncViewState();
          };
        }
        button.textContent = set.has(n.id) ? on : off;
        button.title = t(label) + ": " + n.name;
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-pressed", String(set.has(n.id)));
      }
      if ($("#parts").children[i] !== li)
        $("#parts").insertBefore(li, $("#parts").children[i] ?? null);
      current.delete(n.id);
    }
    for (const li of current.values()) li.remove();
  }
  function selectedRoots() {
    const p = store.snapshot();
    return selection.ids.filter((id) => {
      let n = p.nodes.find((n) => n.id === id);
      while (n?.parent) {
        if (selection.ids.includes(n.parent)) return false;
        n = p.nodes.find((v) => v.id === n.parent);
      }
      return true;
    });
  }
  function inherited(id, set) {
    let n = store.snapshot().nodes.find((n) => n.id === id);
    while (n) {
      if (set.has(n.id)) return true;
      n = store.snapshot().nodes.find((v) => v.id === n.parent);
    }
    return false;
  }
  function resetViewState() {
    viewState.hidden.clear();
    viewState.locked.clear();
    viewState.isolated = null;
    viewport.setViewState(viewState);
  }
  function syncViewState() {
    viewport.setViewState(viewState);
    renderUI();
  }
  function paintTargets() {
    const p = store.snapshot();
    if (selection.mode !== "object") return node()?.mesh ? [node()] : [];
    const roots = selectedRoots();
    return p.nodes.filter(
      (n) =>
        n.mesh &&
        roots.some((id) => {
          let v = n;
          while (v) {
            if (v.id === id) return true;
            v = p.nodes.find((x) => x.id === v.parent);
          }
          return false;
        }),
    );
  }
  function paintSource(n) {
    const p = store.snapshot();
    return p.nodes.find(
      (v) => v.id === (n.symmetry?.source ?? n.instanceOf ?? n.id),
    );
  }
  function paintCommands(material) {
    return [
      ...new Map(
        paintTargets().map((n) => {
          const source = paintSource(n);
          return [
            source.id,
            {
              op: "paint",
              id: source.id,
              ...(selection.mode === "face" ? { faces: selection.faces } : {}),
              material,
            },
          ];
        }),
      ).values(),
    ];
  }
  function materialUI() {
    const p = store.snapshot(),
      m = p.materials.find((m) => m.id === materialId);
    if (!m) return;
    $("#color").value = m.color;
    $("#roughness").value = m.roughness;
    $("#material-name").value = m.name;
    $("#metalness").value = m.metalness ?? 0;
    $("#emissive-on").checked = !!m.emissive;
    $("#emissive").value = m.emissive ?? "#ffffff";
    $("#emissive").disabled = $("#emissive-intensity").disabled =
      !m.emissive || !draft.writable;
    $("#emissive-intensity").value = m.emissiveIntensity ?? 1;
    $("#opacity").value = m.opacity ?? 1;
    $("#transmission").value = m.transmission ?? 0;
    $("#double-sided").checked = !!m.doubleSided;
    const usage = materialUsage(p).find((v) => v.id === m.id);
    $("#material-usage").textContent = t("edMaterialReferences")
      .replace("{users}", usage.users.length)
      .replace("{retained}", usage.retainedBy.length);
  }
  function renderUI() {
    rendering = true;
    const p = store.snapshot(),
      n = node(),
      stats = statistics(p),
      component = selection.mode !== "object",
      linked = !!(n?.symmetry || n?.instanceOf),
      driven = bindingFor(p, n?.id),
      selectionLocked = selection.ids.some(
        (id) =>
          inherited(id, viewState.locked) || inherited(id, viewState.hidden),
      ),
      geometryEditable =
        !!n?.mesh && !n.generator && !linked && !selectionLocked && !driven;
    document.title = `${t("edTitle")} — fun.dev`;
    $("#project-name").value = p.name;
    $("#stats").textContent =
      `${stats.triangles} ${t("edTriangles")} · ${stats.drawCalls} ${t("edCalls")}`;
    $("#undo").disabled = !store.canUndo || !draft.writable;
    $("#redo").disabled = !store.canRedo || !draft.writable;
    $("#empty").hidden = !!p.nodes.length;
    $("#choose").hidden = !!n;
    $("#properties").hidden = !n;
    $("#selection-mode").value = selection.mode;
    $("#duplicate").disabled = $("#delete").disabled =
      !n || !draft.writable || selectionLocked || component;
    $("#duplicate").textContent = t("edDuplicateCount").replace(
      "{count}",
      selectedRoots().length,
    );
    $("#delete").textContent = t("edDeleteParts").replace(
      "{count}",
      selectedRoots().length,
    );
    $("#linked-duplicate").disabled = selection.ids.some(
      (id) => p.nodes.find((n) => n.id === id)?.symmetry,
    );
    if ($("#linked-duplicate").disabled) $("#linked-duplicate").checked = false;
    $("#linked-duplicate").title = t("edLinkedCopyHint");
    const assetCopy = selectedRoots().some((id) =>
      p.assemblies.some((a) => a.root === id),
    );
    $("#asset-copy-mode").parentElement.hidden = !assetCopy;
    $("#linked-duplicate").parentElement.hidden = assetCopy;
    $("#group-selection").disabled =
      component || !selection.ids.length || selectionLocked || !draft.writable;
    $("#isolate").setAttribute("aria-pressed", String(!!viewState.isolated));
    renderParts(p);
    $("#view-label").textContent = t(
      viewport.cameraInfo().projection === "orthographic"
        ? "edOrthographic"
        : "edPerspective",
    );
    if (!n) {
      rendering = false;
      return;
    }
    $("#selection-summary").textContent =
      `${selection.mode === "object" ? selection.ids.length : selection.mode === "face" ? selection.faces.length : selection.mode === "edge" ? selection.edges.length : selection.vertices.length} ${t(selection.mode === "object" ? "edParts" : selection.mode === "face" ? "edFaces" : selection.mode === "edge" ? "edEdges" : "edVertices")} · ${n.id}`;
    $("#selection-tools").hidden = !component && selection.ids.length < 2;
    if (previousMode !== selection.mode)
      $("#object-properties").open = !component;
    if (previousMode !== selection.mode) {
      if (component)
        $("#properties").insertBefore(
          $("#object-properties"),
          $("#group-note"),
        );
      else
        $("#properties").insertBefore(
          $("#object-properties"),
          $("#context-tools"),
        );
    }
    previousMode = selection.mode;
    for (const [field, button, mode] of [
      ["selectionMove", "move-selection", "translate"],
      ["selectionRotate", "rotate-selection", "rotate"],
      ["selectionScale", "scale-selection", "scale"],
    ]) {
      $(`[data-vector="${field}"]`).hidden = transformMode !== mode;
      $("#" + button).hidden = transformMode !== mode;
    }
    $("#selection-help").textContent = selectionLocked
      ? t("edLockedHelp")
      : component
        ? t("edComponentDeleteHelp")
        : selection.ids.some((id) => p.nodes.find((n) => n.id === id)?.symmetry)
          ? t("edMirrorMoveHelp")
          : "";
    $("#selection-help").hidden = !$("#selection-help").textContent;
    $("#linked-note").hidden = $("#link-actions").hidden = !linked;
    $("#linked-note").textContent = linked
      ? `${t("edLinkedTo")} ${n.symmetry?.source ?? n.instanceOf}`
      : "";
    $("#generator-tools").hidden = !shapeGenerator(n) && !n.recipe;
    $("#parameters").hidden = !shapeGenerator(n);
    $("#group-note").hidden = !!n.mesh;
    $("#mesh-properties").hidden = !n.mesh;
    $("#context-tools").hidden = !n.mesh;
    $("#material-tools").hidden =
      !paintTargets().length || ["edge", "vertex"].includes(selection.mode);
    $("#node-name").value = n.name;
    $("#node-id").value = n.id;
    const excluded = new Set([n.id]);
    for (let i = 0; i < p.nodes.length; i++)
      for (const other of p.nodes)
        if (excluded.has(other.parent)) excluded.add(other.id);
    options(
      $("#parent"),
      [
        ["", t("edRoot")],
        ...p.nodes
          .filter((other) => !excluded.has(other.id))
          .map((other) => [other.id, other.name]),
      ],
      n.parent ?? "",
    );
    for (const key of ["position", "rotation", "scale"]) setVector(key, n[key]);
    setVector("dimensions", measure(p, n.id).bounds.size);
    for (const input of all("#transform-form input,#transform-form select")) {
      input.disabled = !!n.symmetry || !draft.writable || selectionLocked;
      input.title = "";
    }
    $("#apply-scale").disabled = linked || !draft.writable;
    $("#ground").disabled = !!n.symmetry || !draft.writable;
    $("#set-dimensions").disabled = !!n.symmetry || !draft.writable;
    $("#align").disabled =
      selection.ids.length < 2 || !draft.writable || selectionLocked;
    for (const id of [
      "apply-scale",
      "ground",
      "set-dimensions",
      "parameters",
      "convert",
      "unlink",
      "pivot",
      "symmetry",
    ])
      $("#" + id).disabled =
        selectionLocked ||
        !draft.writable ||
        (["apply-scale", "parameters", "convert"].includes(id) && linked);
    for (const id of ["move-selection", "rotate-selection", "scale-selection"])
      $("#" + id).disabled =
        selectionLocked ||
        !draft.writable ||
        (component && !geometryEditable) ||
        (!!n.symmetry && !selection.ids.includes(n.symmetry.source));
    const hasMirror = selection.ids.some(
      (id) => p.nodes.find((n) => n.id === id)?.symmetry,
    );
    if (hasMirror)
      for (const id of ["ground", "align"]) {
        $("#" + id).disabled = true;
        $("#" + id).title = t("edMirrorMoveHelp");
      }
    else for (const id of ["ground", "align"]) $("#" + id).title = "";
    if (n.symmetry)
      for (const id of ["set-dimensions", "pivot", "symmetry"])
        $("#" + id).disabled = true;
    if (n.mesh) {
      $("#face-tools").hidden = selection.mode !== "face";
      $("#vertex-form").hidden = selection.mode !== "vertex";
      $("#bevel-tools").hidden = component;
      $("#edge-tools").hidden = selection.mode !== "edge";
      $("#face-edges").hidden = selection.mode !== "face";
      $("#face-edges").disabled = !selection.faces.length;
      options(
        $("#edge"),
        meshEdges(n.mesh).map((e) => [
          e.id,
          `${selection.edges.includes(e.id) ? "✓ " : ""}${e.id}`,
        ]),
        selection.edges.at(-1),
      );
      for (const id of ["bevel-edges", "loop-cut", "cut"])
        $("#" + id).disabled =
          !draft.writable ||
          !geometryEditable ||
          (id !== "cut" && !selection.edges.length);
      $("#loop-cut").disabled ||= selection.edges.length !== 1;
      options(
        $("#face"),
        n.mesh.faces.map((f) => [
          f.id,
          `${selection.faces.includes(f.id) ? "✓ " : ""}${f.id} · ${f.vertices.length}`,
        ]),
        selection.face ?? n.mesh.faces[0].id,
      );
      options(
        $("#vertex"),
        n.mesh.vertices.map((_, i) => [
          String(i),
          `${selection.vertices.includes(i) ? "✓ " : ""}${i}`,
        ]),
        String(selection.vertex),
      );
      setVector(
        "vertex",
        n.mesh.vertices[selection.vertex] ?? n.mesh.vertices[0],
      );
      for (const id of [
        "extrude",
        "inset",
        "bevel",
        "move-selection",
        "rotate-selection",
        "scale-selection",
      ])
        $("#" + id).disabled =
          !draft.writable ||
          selectionLocked ||
          (component
            ? !geometryEditable ||
              (selection.mode === "face" && !selection.faces.length) ||
              (selection.mode === "edge" && !selection.edges.length) ||
              (selection.mode === "vertex" && !selection.vertices.length)
            : (linked && id === "bevel") ||
              (!!n.symmetry && !selection.ids.includes(n.symmetry.source)));
      for (const input of all("#vertex-form input,#vertex-form button"))
        input.disabled = !geometryEditable || !draft.writable;
    }
    if (paintTargets().length) {
      const face =
        n.mesh?.faces.find((f) => f.id === selection.face) ??
        paintTargets()[0].mesh.faces[0];
      if (!p.materials.some((m) => m.id === materialId))
        materialId = face.material;
      options(
        $("#material"),
        p.materials.map((m) => [m.id, m.name]),
        materialId,
      );
      $("#paint").textContent = t(
        selection.mode === "face" ? "edPaintFacesCount" : "edPaintPartsCount",
      ).replace(
        "{count}",
        selection.mode === "face"
          ? selection.faces.length
          : paintTargets().length,
      );
      const sources = new Set(paintTargets().map((n) => paintSource(n).id)),
        affected = p.nodes.filter(
          (n) =>
            n.mesh && sources.has(n.symmetry?.source ?? n.instanceOf ?? n.id),
        );
      $("#paint-scope").textContent = t("edPaintScope").replace(
        "{count}",
        affected.length,
      );
      materialUI();
      for (const id of ["paint", "unique-material", "new-material", "mirror"])
        $("#" + id).disabled =
          (["unique-material", "new-material"].includes(id) &&
            p.materials.length >= LIMITS.materials) ||
          !draft.writable ||
          selectionLocked ||
          (id === "mirror"
            ? linked
            : ["vertex", "edge"].includes(selection.mode) ||
              !paintTargets().length ||
              (selection.mode === "face" && !selection.faces.length));
    }
    if (driven) {
      if (driven.options) $("#parameters").disabled = true;
      for (const key of ["position", "rotation", "scale"])
        for (const input of all(`#transform-form [data-vector="${key}"] input`))
          if (driven[key] || key === "scale") {
            input.disabled = true;
            input.title = t("edAssemblyDriven");
          }
      $("#parent").disabled = true;
      for (const id of [
        "apply-scale",
        "ground",
        "set-dimensions",
        "convert",
        "pivot",
        "symmetry",
        "mirror",
        "bevel",
        "cut",
        "move-selection",
        "rotate-selection",
        "scale-selection",
      ])
        $("#" + id).disabled = true;
    }
    workbench?.renderRecipe(n);
    refreshUnitLabels();
    for (const el of all("[data-dirty]")) delete el.dataset.dirty;
    rendering = false;
  }
  store.subscribe((results = []) => {
    const p = store.snapshot();
    // A rename keeps the selection and session view state on the same part.
    for (const r of results)
      if (r.op === "rename")
        for (const [from, to] of Object.entries(r.idMap ?? {})) {
          if (selection.id === from) selection.id = to;
          selection.ids = selection.ids.map((id) => (id === from ? to : id));
          for (const set of [
            viewState.hidden,
            viewState.locked,
            viewState.isolated,
          ])
            if (set?.delete(from)) set.add(to);
        }
    try {
      viewport.setProject(p);
      updateSelection();
    } catch (error) {
      status(t("edError") + error.message, true);
      console.error(error);
    } finally {
      draft.save(p, store.revision);
    }
  });
  function commitField(input) {
    if (rendering || input.disabled) return true;
    if (!input.reportValidity()) return false;
    const n = node();
    let commands = [];
    if (input.id === "project-name") {
      if (input.value !== store.snapshot().name)
        commands = [{ op: "renameProject", name: input.value }];
    } else if (input.id === "node-name") {
      if (input.value !== n.name)
        commands = [{ op: "set", id: n.id, name: input.value }];
    } else if (input.id === "node-id") {
      if (input.value !== n.id)
        commands = [{ op: "rename", id: n.id, newId: input.value }];
    } else if (input.id === "parent") {
      if ((input.value || null) !== n.parent)
        commands = [{ op: "set", id: n.id, parent: input.value || null }];
    } else if (input.closest("#transform-form [data-vector]")) {
      const key = input.closest("[data-vector]").dataset.vector,
        value = vectorValue(key);
      if (value.some((v, i) => Math.abs(v - n[key][i]) > 1e-6))
        commands = [{ op: "set", id: n.id, [key]: value }];
    } else if (input.closest("#vertex-form")) {
      const value = vectorValue("vertex");
      if (
        value.some(
          (v, i) => Math.abs(v - n.mesh.vertices[selection.vertex][i]) > 1e-6,
        )
      )
        commands = [
          {
            op: "vertices",
            id: n.id,
            changes: [{ index: selection.vertex, position: value }],
          },
        ];
    }
    if (commands.length && !apply(commands)) return false;
    delete input.dataset.dirty;
    return true;
  }
  function flushPending() {
    if ($("#add-dialog").open) {
      status(t("edShapePending"), true);
      return false;
    }
    if (workbench?.hasPending()) {
      status(t("edParameterPending"), true);
      return false;
    }
    for (const input of all('[data-autocommit][data-dirty="true"]')) {
      try {
        if (!commitField(input)) return false;
      } catch (error) {
        status(t("edError") + error.message, true);
        return false;
      }
    }
    return true;
  }
  const pendingInputError = () =>
    new ModelError(
      t(
        $("#add-dialog").open
          ? "edShapePending"
          : workbench?.hasPending()
            ? "edParameterPending"
            : "edInvalidField",
      ),
      "pending_input",
    );
  for (const input of all(
    "#project-name,#transform-form input,#transform-form select,#vertex-form input",
  )) {
    input.dataset.autocommit = "true";
    input.addEventListener("input", () => {
      if (!rendering) {
        input.dataset.dirty = "true";
        status(t("edPending"));
      }
    });
    input.addEventListener("change", () => act(() => commitField(input)));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        renderUI();
        status(t("edCancelled"));
      }
      if (e.key === "Enter") {
        e.preventDefault();
        act(() => commitField(input));
      }
    });
  }
  $("#transform-form").onsubmit = $("#vertex-form").onsubmit = (e) => {
    e.preventDefault();
    flushPending();
  };
  for (const id of ["new", "duck", "stool", "planter"])
    $("#" + id).onclick = () => {
      if (flushPending() && confirm(t("edConfirm"))) {
        act(() =>
          store.replace(
            {
              new: emptyProject,
              duck: duckProject,
              stool: stoolProject,
              planter: planterProject,
            }[id](),
          ),
        );
        resetViewState();
        updateSelection(true);
        viewport.view();
        renderUI();
      }
    };
  $("#undo").onclick = () => {
    if (flushPending()) act(() => store.undo());
  };
  $("#redo").onclick = () => {
    if (flushPending()) act(() => store.redo());
  };
  $("#open").onclick = () => $("#project-file").click();
  $("#project-file").onchange = async (e) => {
    const file = e.target.files[0],
      revision = store.revision;
    e.target.value = "";
    if (!file) return;
    try {
      if (file.size > LIMITS.bytes) throw new Error(t("edFileLarge"));
      const p = normalizeProject(JSON.parse(await file.text()));
      if (!flushPending() || !confirm(t("edConfirm"))) return;
      store.replace(p, { ifRevision: revision });
      resetViewState();
      updateSelection(true);
      viewport.view();
      status(t("edLoaded"));
    } catch (error) {
      status(t("edError") + error.message, true);
    }
  };
  $("#save").onclick = () => {
    if (!flushPending()) return;
    const p = store.snapshot();
    download(
      `${filename(p.name)}.funmodel.json`,
      JSON.stringify(p, null, 2),
      "application/json",
    );
    status(t("edDownloaded"));
  };
  async function downloadExport(force = false, options = {}) {
    if (!flushPending()) return;
    $("#export").disabled = true;
    status(t("edBusy"));
    const p = store.snapshot(),
      revision = store.revision;
    try {
      const { buffer, report } = await exportAsset(p, { ...options, force });
      download(`${filename(p.name)}.glb`, buffer, "model/gltf-binary");
      status(
        `${t("edDownloaded")} · ${report.bytes} B · ${report.uniqueGeometries} ${t("edGeometryReuse")}${report.forced ? " · " + t("edNeedsReview") : ""}`,
      );
    } catch (error) {
      status(t("edError") + error.message, true);
      if (error.code === "export_validation") {
        const issues = text("ul", "");
        for (const issue of error.issues)
          issues.append(
            text(
              "li",
              `${t("edIssue_" + issue.code) ?? issue.code} · ${issue.node ?? ""} ${issue.face ?? ""}`,
            ),
          );
        const forceButton = text("button", t("edForceExport"));
        forceButton.onclick = () => {
          $("#info-dialog").close();
          // Revalidate if the document changed while the report was open.
          downloadExport(store.revision === revision, options);
        };
        info(t("edNeedsReview"), [issues, forceButton]);
      }
    } finally {
      $("#export").disabled = false;
    }
  }
  $("#export").onclick = () => {
    if (!flushPending()) return;
    const scope = text("select", ""),
      origin = text("select", ""),
      summary = text("dl", ""),
      confirm = text("button", t("edExport"));
    scope.id = "export-scope";
    origin.id = "export-origin";
    confirm.id = "export-confirm";
    confirm.className = "primary";
    summary.className = "delivery-summary";
    const label = (key, control) => {
      const el = text("label", t(key));
      el.htmlFor = control.id;
      el.append(control);
      return el;
    };
    const option = (control, value, key) => {
      const el = text("option", t(key));
      el.value = value;
      control.append(el);
      return el;
    };
    option(scope, "all", "edExportAll");
    option(scope, "selection", "edExportSelection").disabled =
      !selection.ids.length;
    for (const value of ["world", "asset-root", "ground-center"])
      option(origin, value, "edExportOrigin_" + value);
    const options = () => ({
      origin: origin.value,
      ...(scope.value === "selection" ? { ids: [...selection.ids] } : {}),
    });
    const refresh = () => {
      origin.querySelector('[value="asset-root"]').disabled =
        scope.value !== "selection" || selection.ids.length !== 1;
      if (origin.selectedOptions[0].disabled) origin.value = "world";
      summary.replaceChildren();
      try {
        const report = exportReport(store.snapshot(), options());
        const format = (v) =>
          v.map((n) => Number(n.toFixed(6))).join(", ") + " m";
        for (const [key, value] of [
          [
            "edDimensions",
            report.bounds
              ? format(
                  report.bounds.max.map((v, i) => v - report.bounds.min[i]),
                )
              : "—",
          ],
          ["edExportSourceOrigin", format(report.origin.point)],
          [
            "edExportBounds",
            report.bounds
              ? `${format(report.bounds.min)} → ${format(report.bounds.max)}`
              : "—",
          ],
          ["edTriangles", report.triangles],
        ])
          summary.append(text("dt", t(key)), text("dd", String(value)));
        confirm.disabled = false;
      } catch (error) {
        summary.append(text("p", error.message));
        confirm.disabled = true;
      }
    };
    scope.onchange = origin.onchange = refresh;
    confirm.onclick = () => {
      const value = options();
      $("#info-dialog").close();
      downloadExport(false, value);
    };
    info(t("edExport"), [
      label("edExportScope", scope),
      label("edOrigin", origin),
      text("p", t("edExportOriginHelp")),
      summary,
      confirm,
    ]);
    refresh();
  };
  $("#screenshot").onclick = () =>
    act(() => {
      const shot = viewport.renderViews(["current"], 1024)[0];
      download(
        `${filename(store.snapshot().name)}-view.png`,
        Uint8Array.from(atob(shot.dataUrl.split(",")[1]), (s) =>
          s.charCodeAt(0),
        ),
        "image/png",
      );
    }, "edDownloaded");
  $("#draft-retry").onclick = () =>
    draft.retry().catch((e) => status(e.message, true));
  $("#draft-copy").onclick = () =>
    draft.copy(store.snapshot()).catch((e) => status(e.message, true));
  $("#draft-original").onclick = () => {
    const sources = draft.recoverySources;
    download(
      `${filename(store.snapshot().name)}-${sources ? "recovery.json" : "original.funmodel.json"}`,
      JSON.stringify(
        sources
          ? {
              format: "fun.dev/model-recovery",
              version: 1,
              draftId: draft.id,
              recovery: draft.recovery,
              sources,
            }
          : draft.record.project,
        null,
        2,
      ),
      "application/json",
    );
  };
  $("#duplicate").onclick = () => {
    if (!flushPending() || selection.mode !== "object") return;
    let serial = 1;
    const p = store.snapshot();
    while (
      p.nodes.some(
        (n) => n.id === `copy-${serial}` || n.id.startsWith(`copy-${serial}-`),
      )
    )
      serial++;
    const prefix = `copy-${serial}`,
      commands = selectedRoots().map((id, i) => ({
        op: "duplicate",
        id,
        newId: `${prefix}-${i}`,
        offset: [0, 0, 0],
        linked:
          !$("#linked-duplicate").parentElement.hidden &&
          $("#linked-duplicate").checked,
        ...(p.assemblies.some((a) => a.root === id)
          ? { assetMode: $("#asset-copy-mode").value }
          : {}),
      })),
      ids = commands.map((c) => c.newId);
    if (
      apply([...commands, { op: "transform", ids, translation: [0.2, 0, 0] }])
    ) {
      selection.ids = ids;
      selection.id = selection.ids.at(-1);
      updateSelection(true);
    }
  };
  $("#group-selection").onclick = () => {
    const id = newId("group");
    if (
      flushPending() &&
      apply([
        { op: "group", ids: selection.ids, newId: id, name: t("edGroup") },
      ])
    ) {
      selection.id = id;
      selection.ids = [id];
      updateSelection(true);
    }
  };
  $("#isolate").onclick = () => {
    viewState.isolated = viewState.isolated ? null : new Set(selection.ids);
    syncViewState();
  };
  $("#show-all").onclick = () => {
    viewState.hidden.clear();
    viewState.isolated = null;
    syncViewState();
  };
  $("#delete").onclick = () => {
    if (selection.mode !== "object" || !flushPending()) return;
    const p = store.snapshot(),
      ids = selection.ids.filter((id) => {
        let parent = p.nodes.find((n) => n.id === id)?.parent;
        while (parent) {
          if (selection.ids.includes(parent)) return false;
          parent = p.nodes.find((n) => n.id === parent)?.parent;
        }
        return true;
      });
    const commands = ids.map((id) => ({ op: "delete", id })),
      count = p.nodes.length - evaluateCommands(p, commands).nodes.length;
    if (confirm(t("edConfirmDeleteCount").replace("{count}", count)))
      apply(commands);
  };
  $("#selection-mode").onchange = () => {
    if (!flushPending()) return;
    selection.mode = $("#selection-mode").value;
    selection.ids = selection.id ? [selection.id] : [];
    updateSelection(true);
  };
  for (const b of all("[data-transform]"))
    b.onclick = () => {
      if (!flushPending()) return;
      transformMode = b.dataset.transform;
      viewport.setMode(transformMode);
      renderUI();
      all("[data-transform]").forEach((other) =>
        other.setAttribute("aria-pressed", String(other === b)),
      );
    };
  $("#space").onchange = () => viewport.setSpace($("#space").value);
  for (const [id, method] of [
    ["wire", "setWireframe"],
    ["xray", "setXray"],
    ["box-select", "setBox"],
    ["snap", "setSnap"],
  ])
    $("#" + id).onclick = () => {
      const b = $("#" + id),
        enabled = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(enabled));
      if (id === "snap") updateSnap();
      else viewport[method](enabled);
    };
  for (const b of all("[data-view]"))
    b.onclick = () => {
      viewport.view(b.dataset.view, {
        preserve: b.dataset.view !== "perspective",
      });
      $("#view-label").textContent = t(
        viewport.cameraInfo().projection === "orthographic"
          ? "edOrthographic"
          : "edPerspective",
      );
    };
  $("#focus").onclick = () => viewport.focus();
  $("#projection").onclick = () => {
    $("#view-label").textContent = t(
      viewport.projection() === "orthographic"
        ? "edOrthographic"
        : "edPerspective",
    );
  };
  $("#shading").onchange = () => viewport.setShading($("#shading").value);
  function updateSnap() {
    viewport.setSnap(
      $("#snap").getAttribute("aria-pressed") === "true"
        ? Number($("#snap-step").value)
        : 0,
      Number($("#snap-angle").value),
    );
    $("#snap").title =
      `${$("#snap-step").selectedOptions[0].textContent} · ${$("#snap-angle").value}°`;
  }
  $("#snap-step").onchange = $("#snap-angle").onchange = updateSnap;
  function refreshUnitLabels() {
    for (const el of all("[data-length-unit]")) el.textContent = lengthUnit;
    for (const el of all("[data-i18n]")) {
      if (!/(米|\(m\)|\(米\))/.test(t(el.dataset.i18n))) continue;
      if (el.children.length) continue;
      el.textContent = t(el.dataset.i18n)
        .replaceAll("米", lengthUnit)
        .replaceAll("(m)", `(${lengthUnit})`);
    }
  }
  $("#length-unit").onchange = () => {
    if (!flushPending()) {
      $("#length-unit").value = lengthUnit;
      return;
    }
    const old = unitFactor();
    lengthUnit = $("#length-unit").value;
    const factor = old / unitFactor();
    for (const input of [
      ...lengthFields.map((id) => $("#" + id)),
      ...all("[data-vector] input").filter((el) =>
        lengthVectors.has(el.closest("[data-vector]").dataset.vector),
      ),
    ]) {
      if (input.min) input.min = Number(input.min) * factor;
      if (input.max) input.max = Number(input.max) * factor;
    }
    for (const id of lengthFields)
      $("#" + id).value = Number(
        (Number($("#" + id).value) * factor).toFixed(6),
      );
    for (const name of lengthVectors)
      for (const input of all(`[data-vector="${name}"] input`))
        input.value = Number((Number(input.value) * factor).toFixed(6));
    $("#outline").value = scaleOutline($("#outline").value, factor);
    profile.reset();
    renderUI();
  };
  $("#edge").onchange = () => {
    selection.edges = [$("#edge").value];
    updateSelection();
  };
  $("#face-edges").onclick = () => {
    const counts = new Map();
    for (const f of node().mesh.faces.filter((f) =>
      selection.faces.includes(f.id),
    ))
      f.vertices.forEach((a, i) => {
        const key = edgeKey(a, f.vertices[(i + 1) % f.vertices.length]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      });
    selection.edges = [...counts].filter(([, n]) => n === 1).map(([id]) => id);
    selection.mode = "edge";
    updateSelection();
  };
  function topology(command) {
    if (apply([command])) {
      selection.edges = [];
      selection.faces = [];
      selection.vertices = [];
      updateSelection();
    }
  }
  $("#bevel-edges").onclick = () =>
    topology({
      op: "bevel",
      id: selection.id,
      edges: selection.edges,
      distance: distanceValue("edge-bevel-distance"),
    });
  $("#loop-cut").onclick = () =>
    topology({
      op: "loopCut",
      id: selection.id,
      edge: selection.edges[0],
      ratio: Number($("#loop-ratio").value),
    });
  $("#cut").onclick = () =>
    topology({
      op: "cut",
      id: selection.id,
      axis: $("#cut-axis").value,
      offset: distanceValue("cut-offset"),
      space: $("#space").value,
    });
  $("#face").onchange = () => {
    selection.faces = [$("#face").value];
    updateSelection();
  };
  $("#vertex").onchange = () => {
    selection.vertices = [Number($("#vertex").value)];
    updateSelection();
  };
  const target = () =>
    selection.mode === "object"
      ? { ids: selection.ids }
      : {
          id: selection.id,
          ...(selection.mode === "face"
            ? { faces: selection.faces }
            : selection.mode === "edge"
              ? { edges: selection.edges }
              : { vertices: selection.vertices }),
        };
  for (const [id, key, field] of [
    ["move-selection", "translation", "selectionMove"],
    ["rotate-selection", "rotation", "selectionRotate"],
    ["scale-selection", "scale", "selectionScale"],
  ])
    $("#" + id).onclick = () =>
      act(() => {
        const value = vectorValue(field);
        const result = store.apply([
          {
            op: "transform",
            ...target(),
            [key]: value,
            space: $("#space").value,
          },
        ]);
        setVector(field, key === "scale" ? [1, 1, 1] : [0, 0, 0]);
        return result;
      });
  for (const [field, button] of [
    ["extrude-distance", "extrude"],
    ["inset-distance", "inset"],
    ["edge-bevel-distance", "bevel-edges"],
    ["loop-ratio", "loop-cut"],
  ])
    $("#" + field).addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        $("#" + button).click();
        $("#canvas").focus();
      }
    });
  $("#extrude").onclick = () =>
    apply([
      {
        op: "extrude",
        id: selection.id,
        faces: selection.faces,
        distance: distanceValue("extrude-distance"),
        space: $("#space").value,
      },
    ]);
  $("#inset").onclick = () =>
    apply([
      {
        op: "inset",
        id: selection.id,
        faces: selection.faces,
        distance: distanceValue("inset-distance"),
        space: $("#space").value,
      },
    ]);
  $("#bevel").onclick = () =>
    apply([
      {
        op: "bevel",
        id: selection.id,
        distance: distanceValue("bevel-distance"),
      },
    ]);
  $("#set-dimensions").onclick = () =>
    act(() =>
      store.apply([
        { op: "dimensions", id: selection.id, size: vectorValue("dimensions") },
      ]),
    );
  $("#apply-scale").onclick = () =>
    apply([{ op: "applyScale", id: selection.id }]);
  $("#ground").onclick = () => apply([{ op: "ground", ids: selection.ids }]);
  $("#align").onclick = () =>
    apply([
      {
        op: "align",
        ids: selection.ids,
        reference: selection.id,
        axis: $("#align-axis").value,
        mode: $("#align-mode").value,
      },
    ]);
  $("#convert").onclick = () => apply([{ op: "convert", id: selection.id }]);
  $("#unlink").onclick = () => apply([{ op: "unlink", id: selection.id }]);
  $("#select-source").onclick = () =>
    selectPart(node().symmetry?.source ?? node().instanceOf);
  $("#symmetry").onclick = () => {
    const id = newId("mirror");
    if (
      apply([
        {
          op: "symmetry",
          id: selection.id,
          newId: id,
          axis: $("#symmetry-axis").value,
          space: $("#symmetry-space").value,
          offset: distanceValue("symmetry-offset"),
          linked: $("#symmetry-linked").checked,
        },
      ])
    ) {
      selection.id = id;
      selection.ids = [id];
      updateSelection(true);
    }
  };
  $("#material").onchange = () => {
    materialId = $("#material").value;
    materialUI();
  };
  $("#paint").onclick = () => apply(paintCommands(materialId));
  for (const [id, key, numeric] of [
    ["color", "color"],
    ["roughness", "roughness", true],
    ["material-name", "name"],
    ["metalness", "metalness", true],
    ["emissive", "emissive"],
    ["emissive-intensity", "emissiveIntensity", true],
    ["opacity", "opacity", true],
    ["transmission", "transmission", true],
  ])
    $("#" + id).onchange = () =>
      apply([
        {
          op: "material",
          id: materialId,
          [key]: numeric ? Number($("#" + id).value) : $("#" + id).value,
        },
      ]);
  $("#emissive-on").onchange = () =>
    apply([
      {
        op: "material",
        id: materialId,
        emissive: $("#emissive-on").checked ? $("#emissive").value : null,
      },
    ]);
  $("#double-sided").onchange = () =>
    apply([
      {
        op: "material",
        id: materialId,
        doubleSided: $("#double-sided").checked,
      },
    ]);
  for (const id of ["new-material", "unique-material"])
    $("#" + id).onclick = () => {
      const old = store.snapshot().materials.find((m) => m.id === materialId),
        newMaterial = newId("material", true),
        m =
          id === "unique-material"
            ? { ...old, name: `${old.name} copy` }
            : {
                name: `Material ${store.snapshot().materials.length + 1}`,
                color: "#a6b6bf",
                roughness: 0.8,
              };
      if (
        apply([
          { ...m, op: "material", id: newMaterial },
          ...paintCommands(newMaterial),
        ])
      ) {
        materialId = newMaterial;
        renderUI();
      }
    };
  $("#mirror").onclick = () =>
    apply([{ op: "mirror", id: selection.id, axis: "x" }]);
  $("#pivot").onclick = () =>
    act(() => {
      const result = store.apply([
        { op: "pivot", id: selection.id, offset: vectorValue("pivot") },
      ]);
      setVector("pivot", [0, 0, 0]);
      return result;
    });
  const cupProfile = "0, 0\n0.3, 0\n0.45, 0.7\n0.4, 0.7\n0.26, 0.06\n0, 0.06";
  function scaleOutline(value, factor) {
    return value
      .trim()
      .split(/\n+/)
      .map((line) =>
        line
          .trim()
          .split(/[,\s]+/)
          .map((n) => Number((Number(n) * factor).toPrecision(12)))
          .join(", "),
      )
      .join("\n");
  }
  function shapeFields(reset = false) {
    const kind = $("#kind").value;
    for (const [field, visible] of Object.entries({
      size: kind === "box",
      radius: ["sphere", "cylinder", "cone"].includes(kind),
      height: ["cylinder", "cone"].includes(kind),
      rings: kind === "sphere",
      segment: ["sphere", "cylinder", "cone", "lathe"].includes(kind),
      outline: ["extrude", "lathe"].includes(kind),
      depth: kind === "extrude",
    }))
      $("#" + field + "-field").hidden = !visible;
    $("#cup-profile").hidden = kind !== "lathe";
    $("#outline-hint").textContent = t(
      kind === "lathe" ? "edLatheHint" : "edOutlineHint",
    );
    if (reset)
      $("#outline").value = scaleOutline(
        kind === "lathe"
          ? cupProfile
          : "-0.5, -0.5\n0.5, -0.5\n0.3, 0.3\n0, 0.6\n-0.3, 0.3",
        1 / unitFactor(),
      );
    if (["lathe", "extrude"].includes(kind)) profile.draw();
  }
  function shapeOptions() {
    const kind = $("#kind").value,
      opts = {};
    if (kind === "box") {
      opts.size = vectorValue("primitiveSize");
      opts.bevel = distanceValue("box-bevel");
    }
    if (["sphere", "cylinder", "cone"].includes(kind))
      opts.radius = distanceValue("radius");
    if (["cylinder", "cone"].includes(kind))
      opts.height = distanceValue("height");
    if (kind === "sphere") opts.rings = Number($("#rings").value);
    if (["sphere", "cylinder", "cone", "lathe"].includes(kind))
      opts.segments = Number($("#segments").value);
    if (["lathe", "extrude"].includes(kind))
      opts[kind === "lathe" ? "profile" : "points"] = $("#outline")
        .value.trim()
        .split(/\n+/)
        .map((line) =>
          line
            .trim()
            .split(/[,\s]+/)
            .map((n) => Number(n) * unitFactor()),
        );
    if (kind === "extrude") opts.depth = distanceValue("depth");
    return { kind, opts };
  }
  function scheduleShapePreview() {
    if (!$("#add-dialog").open) return;
    // A blur emits change after input. Do not disable a ready submit button
    // between its pointerdown and click when the preview already matches.
    const signature = JSON.stringify([
      editingShape,
      shapeRepair,
      all("#add-form input, #add-form select, #add-form textarea").map((el) => [
        el.id || el.name,
        el.value,
      ]),
    ]);
    if (signature === shapeSignature) return;
    shapeSignature = signature;
    const revision = ++previewRevision;
    $("#shape-submit").disabled = true;
    cancelAnimationFrame(previewFrame);
    previewFrame = requestAnimationFrame(async () => {
      try {
        const { kind, opts } = shapeOptions();
        const p = emptyProject();
        const next = editingShape
          ? evaluateCommands(store.snapshot(), [
              ...shapeRepair,
              { op: "parameters", id: editingShape, options: opts },
            ])
          : evaluateCommands(p, [
              { op: "create", id: "preview", kind, options: opts },
            ]);
        const first = !shapePreview;
        if (!shapePreviewInit) {
          shapePreviewController = new AbortController();
          shapePreviewInit = createViewport($("#shape-canvas"), {
            helpers: false,
            signal: shapePreviewController.signal,
          });
        }
        const preview = await shapePreviewInit;
        if (revision !== previewRevision || !$("#add-dialog").open) return;
        shapePreview = preview;
        shapePreview.setReadonly(true);
        shapePreview.setProject(next);
        if (first) shapePreview.view();
        const size = measure(next, editingShape ?? "preview").bounds.size.map(
          (v) => Number((v / unitFactor()).toPrecision(6)),
        );
        $("#shape-preview-status").textContent =
          `${t("edLivePreview")} · ${size.join(" × ")} ${lengthUnit}`;
        $("#add-error").textContent = "";
        $("#shape-submit").disabled = false;
        const recovery = $("#shape-recovery");
        recovery.replaceChildren();
        if (shapeRepair.length) {
          recovery.append(
            text("p", t("edPaintRepairStaged")),
            resetShapeRepairButton(),
          );
        }
      } catch (error) {
        if (revision !== previewRevision || !$("#add-dialog").open) return;
        $("#add-error").textContent = error.recovery
          ? t("edPaintRemapNeeded")
          : error.message;
        $("#shape-preview-status").textContent = t(
          shapePreview
            ? "edShapePreviewUnchanged"
            : "edShapePreviewUnavailable",
        );
        $("#shape-submit").disabled = true;
        const recovery = $("#shape-recovery");
        recovery.replaceChildren();
        if (error.recovery && error.node && !shapeRepair.length) {
          recovery.append(text("p", t("edPaintRecovery")));
          const readRule = materialRuleFields(
            recovery,
            error.node,
            store.snapshot(),
          );
          for (const [mode, label] of [
            ["rules", "edPaintRulesPreview"],
            ["clear", "edPaintClearPreview"],
          ]) {
            const button = text("button", t(label));
            button.type = "button";
            button.dataset.paintRepair = mode;
            button.onclick = () => {
              shapeRepair = [
                {
                  op: "recipePaint",
                  id: error.node,
                  mode,
                  ...(mode === "rules" ? { rules: [readRule()] } : {}),
                },
              ];
              scheduleShapePreview();
            };
            recovery.append(button);
          }
        }
        if (shapeRepair.length) {
          recovery.append(resetShapeRepairButton());
        }
      }
    });
  }
  function resetShapeRepairButton() {
    const button = text("button", t("edPaintResetPreview"));
    button.type = "button";
    button.onclick = () => {
      shapeRepair = [];
      scheduleShapePreview();
    };
    return button;
  }
  $("#add-form").addEventListener("input", scheduleShapePreview);
  $("#add-form").addEventListener("change", scheduleShapePreview);
  $("#shape-fit").onclick = () => shapePreview?.view();
  $("#add-dialog").addEventListener("close", () => {
    shapeSignature = null;
    ++previewRevision;
    cancelAnimationFrame(previewFrame);
    shapePreviewController?.abort();
    shapePreviewController = null;
    shapePreviewInit?.then(
      (preview) => preview.dispose(),
      () => {},
    );
    shapePreviewInit = null;
    shapePreview = null;
    // A pending renderer owns its canvas context until initialization settles.
    // Reopening gets a fresh canvas, independent of that asynchronous cleanup.
    const canvas = $("#shape-canvas");
    canvas.replaceWith(canvas.cloneNode(false));
    shapeRepair = [];
  });
  function shapeDialog(edit = false) {
    if (!flushPending()) return;
    editingShape = edit ? selection.id : null;
    shapeRepair = [];
    $("#shape-recovery").replaceChildren();
    $("#kind").disabled = edit;
    $("#add-error").textContent = "";
    if (edit) {
      const g = shapeGenerator(node()),
        o = g.options;
      $("#kind").value = g.kind;
      setVector("primitiveSize", o.size ?? [1, 1, 1]);
      for (const [id, value] of Object.entries({
        radius: o.radius ?? 0.5,
        height: o.height ?? 1,
        rings: o.rings ?? 6,
        segments: o.segments ?? 8,
        "box-bevel": o.bevel ?? 0,
        depth: o.depth ?? 0.5,
      }))
        $("#" + id).value =
          value / (lengthFields.includes(id) ? unitFactor() : 1);
      $("#outline").value = (o.profile ?? o.points ?? [])
        .map((p) =>
          p.map((v) => Number((v / unitFactor()).toPrecision(12))).join(", "),
        )
        .join("\n");
    } else {
      setVector("primitiveSize", [1, 1, 1]);
      $("#box-bevel").value = 0;
    }
    shapeFields(!edit);
    $("#add-title").textContent = t(edit ? "edParameters" : "edAddTitle");
    $("#shape-submit").textContent = t(edit ? "edApply" : "edCreate");
    $("#add-dialog").showModal();
    profile.reset();
    scheduleShapePreview();
  }
  $("#add").onclick = () => shapeDialog();
  $("#parameters").onclick = () => shapeDialog(true);
  $("#kind").onchange = () => shapeFields(true);
  $("#cup-profile").onclick = () => {
    $("#outline").value = scaleOutline(cupProfile, 1 / unitFactor());
    profile.reset();
    scheduleShapePreview();
  };
  $("#add-form").onsubmit = (e) => {
    e.preventDefault();
    applyingShape = true;
    try {
      const { kind, opts } = shapeOptions();
      let id = editingShape;
      if (id)
        store.apply([...shapeRepair, { op: "parameters", id, options: opts }]);
      else {
        id = newId(kind);
        const selected = node();
        const commands = [
          {
            op: "create",
            id,
            name: $("#kind").selectedOptions[0].textContent,
            kind,
            options: opts,
            parent: selected
              ? selected.mesh
                ? selected.parent
                : selected.id
              : null,
            position: selected?.mesh ? [...selected.position] : [0, 0, 0],
          },
        ];
        if (!selected && kind !== "group") commands.push({ op: "ground", id });
        store.apply(commands);
      }
      selection.id = id;
      selection.ids = [id];
      updateSelection(true);
      if (store.snapshot().nodes.length === 1) viewport.view();
      $("#add-dialog").close();
      status(t("edUpdated"));
    } catch (error) {
      $("#add-error").textContent = error.message;
    } finally {
      applyingShape = false;
    }
  };
  for (const b of all("[data-close]"))
    b.onclick = () => $(`#${b.dataset.close}`).close();
  function info(title, elements) {
    $("#info-title").textContent = title;
    $("#info-content").replaceChildren(...elements);
    $("#info-dialog").showModal();
  }
  const openMaterials = createMaterialLibrary({
    store,
    editable: () => draft.writable,
    info,
    onChange: (id) => {
      const materials = store.snapshot().materials;
      materialId = materials.some((m) => m.id === id) ? id : materials[0].id;
      renderUI();
      status(t("edUpdated"));
    },
  });
  for (const id of ["material-library", "manage-materials"])
    $("#" + id).onclick = () => {
      if (flushPending()) openMaterials(materialId);
    };
  $("#check").onclick = () => {
    const result = validateProject(store.snapshot(), {
        triangles: 5000,
        drawCalls: 32,
      }),
      elements = [
        text(
          "p",
          `${t(result.warnings.length || result.errors.length ? "edNeedsReview" : "edValid")} · ${result.warnings.length + result.errors.length} ${t("edWarnings")}`,
        ),
        text("p", t("edWarningHelp")),
      ];
    for (const warning of [...result.errors, ...result.warnings]) {
      const b = text(
        "button",
        `${t("edIssue_" + warning.code)} ${warning.node ?? warning.metric ?? ""} ${warning.face ?? ""}`,
        "diagnostic",
      );
      b.onclick = () => {
        if (warning.node) {
          $("#info-dialog").close();
          selection.mode = warning.face ? "face" : "object";
          selectPart(warning.node);
          if (warning.face) {
            selection.faces = warning.faces ?? [warning.face];
            updateSelection();
          }
          viewport.focus();
        }
      };
      elements.push(b);
    }
    elements.push(text("pre", JSON.stringify(result, null, 2)));
    info(t("edCheck"), elements);
  };
  $("#agent").onclick = () => {
    const guide = text("a", t("edDocs"));
    guide.href = "/editor/guide";
    guide.target = "_blank";
    guide.rel = "noopener";
    info(t("edAgent"), [
      text("p", t("edAgentHint")),
      text(
        "pre",
        'const state = funEditor.inspect();\nfunEditor.apply([{ op: "ground", ids: [state.selection.id] }],\n  { ifRevision: state.revision });\nfunEditor.renderViews(["front", "left"]);',
      ),
      guide,
    ]);
  };
  window.addEventListener("keydown", (e) => {
    if ($("dialog[open]")) return;
    const input = e.target.closest("input,textarea,select");
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      $("#save").click();
      return;
    }
    if (input) return;
    if (e.key === "Escape") {
      viewport.cancel();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (flushPending()) act(() => (e.shiftKey ? store.redo() : store.undo()));
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (selection.mode === "face" && ["e", "i"].includes(e.key.toLowerCase())) {
      e.preventDefault();
      const input = $(
        e.key.toLowerCase() === "e" ? "#extrude-distance" : "#inset-distance",
      );
      input.focus();
      input.select();
      return;
    }
    const shortcuts = {
      f: "focus",
      b: "box-select",
      g: '[data-transform="translate"]',
      r: '[data-transform="rotate"]',
      s: '[data-transform="scale"]',
      x: "xray",
    };
    const control = shortcuts[e.key.toLowerCase()];
    if (control) {
      e.preventDefault();
      $(control.startsWith("[") ? control : "#" + control)?.click();
    }
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      selection.mode === "object"
    ) {
      e.preventDefault();
      $("#delete").click();
    }
  });
  onLocaleChange(() => {
    renderUI();
    draftState();
  });
  window.addEventListener("pagehide", () => {
    draft.dispose();
    viewport.dispose();
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) location.reload();
  });
  const contextual = document.createElement("section");
  contextual.id = "context-tools";
  for (const id of ["face-tools", "face-edges", "edge-tools", "vertex-form"])
    contextual.append($("#" + id));
  $("#properties").insertBefore(contextual, $("#selection-tools"));
  $("#properties").insertBefore($("#material-tools"), $("#object-properties"));
  updateSnap();
  viewport.setProject(initial);
  updateSelection(true);
  viewport.view();
  renderUI();
  $("#boot-message").hidden = true;
  status(
    draft.recovery
      ? t("edRecoveryDraft")
      : restoreError
        ? t("edRestoreError")
        : `${t("edTitle")} · ${initial.name}`,
    restoreError,
  );
  draftState();
  for (const id of [
    "new",
    "duck",
    "stool",
    "planter",
    "open",
    "add",
    "symmetry",
    "parameters",
    "convert",
    "unlink",
    "new-material",
    "color",
    "roughness",
    "material-name",
    "metalness",
    "emissive-on",
    "emissive",
    "emissive-intensity",
    "opacity",
    "transmission",
    "double-sided",
    "project-name",
    "pivot",
  ])
    if (!draft.writable) $("#" + id).disabled = true;
  workbench = createWorkbench({
    store,
    draft,
    viewport,
    flushPending,
    status,
    info,
    getNode: node,
    getSelection: () => structuredClone(selection),
    getLengthUnit: () => lengthUnit,
    onSelect: (id) => window.funEditor.select(id),
    onRestore: () => {
      resetViewState();
      updateSelection(true);
      viewport.view();
    },
  });
  workbench.renderRecipe();
  window.funEditor = Object.freeze({
    version: 3,
    inspect({ id, detail = "summary" } = {}) {
      const p = store.snapshot(),
        common = {
          revision: store.revision,
          draftId: draft.id,
          writable: draft.writable,
          recovery: draft.recovery,
          units: "meters",
          renderer: viewport.rendererInfo(),
          persistence: draft.persistence,
          pendingInput:
            $("#add-dialog").open ||
            workbench.hasPending() ||
            !!document.querySelector('[data-autocommit][data-dirty="true"]'),
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
      if (!flushPending()) throw pendingInputError();
      const result = store.replace(p, options);
      resetViewState();
      updateSelection(true);
      viewport.view();
      return { ...result, persistence: draft.persistence };
    },
    apply(commands, options) {
      if (!flushPending()) throw pendingInputError();
      return store.apply(commands, options);
    },
    undo: () => {
      if (!flushPending()) return false;
      return store.undo();
    },
    redo: () => store.redo(),
    select(id, opts = {}) {
      if (!flushPending()) throw pendingInputError();
      const p = store.snapshot(),
        ids = Array.isArray(id) ? id : [id],
        n = p.nodes.find((n) => n.id === ids.at(-1));
      if (!ids.length || ids.some((id) => !p.nodes.some((n) => n.id === id)))
        throw new Error("Unknown selection");
      opts = resolveComponents(
        p,
        { ...opts, id: n.id },
        { selectionOnly: true },
      );
      const mode = opts.mode ?? selection.mode;
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
      selection = {
        id: n.id,
        ids,
        mode,
        faces,
        vertices: n.mesh ? vertices : [],
        edges,
      };
      materialId = null;
      updateSelection();
      return structuredClone(selection);
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
    async exportGLB({ encoding = "buffer", ...options } = {}) {
      if (!["buffer", "base64"].includes(encoding))
        throw new Error("Use buffer or base64 encoding");
      if (!flushPending()) throw pendingInputError();
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
    ...workbench.api,
  });
}
