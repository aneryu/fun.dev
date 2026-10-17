import { recipeInput, recipeSelection, ModelError } from "./document.js";
import { topologyToken, connectivityToken } from "./components.js";
import { t } from "../i18n.js";

const el = (tag, text) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
};
const componentFields = [
  "select",
  "face",
  "faces",
  "edge",
  "edges",
  "vertices",
  "topology",
];

// Both append and rebind use the input to that step, not the final mesh.
export function recipeScopeControls({
  project,
  node,
  index,
  step,
  getSelection,
  viewport,
  onReady,
  status,
  existing = false,
}) {
  const root = el("div"),
    label = el("label", t("edStepScope")),
    scope = el("select"),
    output = el("div");
  root.className = "recipe-scope";
  scope.setAttribute("aria-label", t("edStepScope"));
  const kind = step.op === "bevel" || step.op === "loopCut" ? "edges" : "faces";
  const selectable = ["bevel", "inset", "extrude", "paint"].includes(step.op);
  const add = (value, text) => {
    const option = el("option", text);
    option.value = value;
    scope.append(option);
  };
  if (existing) add("saved", t("edStepSavedScope"));
  if (selectable) {
    add("current", t("edStepCurrentScope"));
    add("whole", t("edStepWholeScope"));
    for (const axis of ["x", "y", "z"])
      for (const side of ["min", "max"])
        add(
          axis + ":" + side,
          t("edScope_" + axis + "_" + side) +
            " · " +
            t(kind === "edges" ? "edScopeBoundary" : "edScopeNormal"),
        );
  } else add("whole", t("edStepWholeScope"));
  const selected = getSelection();
  scope.value = existing
    ? "saved"
    : selectable &&
        selected.id === node.id &&
        selected.mode === (kind === "edges" ? "edge" : "face") &&
        selected[kind]?.length
      ? "current"
      : ["inset", "extrude"].includes(step.op)
        ? "y:max"
        : "whole";
  label.append(scope);
  root.append(label);
  const read = () => {
    if (scope.value === "saved" || !selectable) return structuredClone(step);
    const value = structuredClone(step);
    componentFields.forEach((key) => delete value[key]);
    if (scope.value === "current") {
      const current = getSelection();
      if (
        current.id !== node.id ||
        current.mode !== (kind === "edges" ? "edge" : "face") ||
        !current[kind]?.length
      )
        throw new ModelError(t("edStepSelectComponents"), "selection");
      const input = recipeInput(project, node.id, index).nodes[0];
      if (
        index < node.recipe.steps.length &&
        connectivityToken(input.mesh) !== connectivityToken(node.mesh)
      )
        throw new ModelError(t("edStepInputSelection"), "selection");
      value[kind] = [...current[kind]];
      value.topology = topologyToken(input.mesh);
    } else if (scope.value === "whole") {
      if (kind === "faces")
        value.select = { kind, space: "local", limit: 12000 };
    } else {
      const [axis, side] = scope.value.split(":"),
        direction = [0, 0, 0];
      direction[["x", "y", "z"].indexOf(axis)] = side === "min" ? -1 : 1;
      value.select =
        kind === "edges"
          ? { kind, space: "local", boundary: { axis, side }, limit: 12000 }
          : { kind, space: "local", normal: direction, limit: 12000 };
    }
    return value;
  };
  let ready = null,
    generation = 0;
  const preview = el("button", t("edStepPreviewScope"));
  preview.type = "button";
  preview.className = "recipe-scope-preview";
  preview.onclick = async () => {
    const currentGeneration = ++generation;
    ready = null;
    onReady?.(false);
    preview.disabled = true;
    try {
      const candidate = read(),
        report = recipeSelection(project, node.id, index, candidate);
      const text = `${t("edStepMatched")} ${report.count} ${t(report.selection.mode === "edge" ? "edScopeEdges" : report.selection.mode === "vertex" ? "edScopeVertices" : "edScopeFaces")}`;
      const image = el("canvas");
      image.setAttribute("role", "img");
      image.setAttribute("aria-label", t("edStepInputPreview") + " · " + text);
      const shot = viewport.renderProject(report.project, ["current"], 320, {
        ids: [node.id],
        helpers: false,
        overlays: { wire: true, selection: true },
        selection: report.selection,
      })[0];
      image.width = shot.width;
      image.height = shot.height;
      const bitmap = await createImageBitmap(
        new Blob(
          [
            Uint8Array.from(atob(shot.dataUrl.split(",")[1]), (c) =>
              c.charCodeAt(0),
            ),
          ],
          { type: "image/png" },
        ),
      );
      image.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
      if (currentGeneration !== generation || !root.isConnected) return;
      image.dataset.ready = "true";
      output.replaceChildren(
        el("p", text),
        el("p", t("edStepInputPreview")),
        image,
      );
      ready = candidate;
      onReady?.(true);
    } catch (error) {
      if (currentGeneration !== generation || !root.isConnected) return;
      ready = null;
      onReady?.(false);
      output.replaceChildren(el("p", error.message));
      status(error.message, true);
    } finally {
      preview.disabled = false;
    }
  };
  scope.onchange = () => {
    generation++;
    ready = null;
    onReady?.(false);
    output.replaceChildren(el("p", t("edStepPreviewFirst")));
  };
  root.append(el("p", t("edStepScopeHelp")), preview, output);
  return {
    element: root,
    read,
    ready: () => {
      if (!ready) throw new ModelError(t("edStepPreviewFirst"), "selection");
      return structuredClone(ready);
    },
  };
}
