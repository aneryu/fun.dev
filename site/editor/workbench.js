import {
  capabilities,
  commandsSchema,
  validateSchema,
  querySchema,
  recipeStageQuerySchema,
  errorInfo,
} from "./agent-contract.js";
import { queryComponents } from "./components.js";
import {
  validateProject,
  statistics,
  ModelError,
  emptyProject,
  evaluateCommands,
  getRecipe,
  inspectNode,
  inspectRecipeStage,
  shapeGenerator,
} from "./document.js";
import { toolboxAssemblyCommands, assetFor, bindingFor } from "./assembly.js";
import { listBlueprints } from "./blueprints.js";
import { describeChanges } from "./changes.js";
import { hollowBoxRecipe, recipeValue } from "./recipe.js";
import { recipeScopeControls } from "./recipe-controls.js";
import { exportReport } from "./viewport.js";
import { importModel } from "./import-glb.js";
import { fromBase64, toBase64 } from "./glb.js";
import { projectFile, projectFilename } from "./project-file.js";
import { t } from "../i18n.js";

const el = (tag, value) => {
  const n = document.createElement(tag);
  if (value !== undefined) n.textContent = value;
  return n;
};
export function materialRuleFields(panel, id, project) {
  const directionLabel = el("label", t("edPaintDirection")),
    direction = el("select"),
    materialLabel = el("label", t("edMaterial")),
    material = el("select");
  for (const [label, normal] of [
    ["+Y", [0, 1, 0]],
    ["−Y", [0, -1, 0]],
    ["+X", [1, 0, 0]],
    ["−X", [-1, 0, 0]],
    ["+Z", [0, 0, 1]],
    ["−Z", [0, 0, -1]],
  ]) {
    const option = el("option", label);
    option.value = JSON.stringify(normal);
    direction.append(option);
  }
  const node = project.nodes.find((n) => n.id === id);
  for (const m of project.materials) {
    const option = el("option", m.name);
    option.value = m.id;
    material.append(option);
  }
  material.value =
    node?.recipe?.paint?.faces[0]?.material ?? project.materials[0].id;
  directionLabel.append(direction);
  materialLabel.append(material);
  panel.append(directionLabel, materialLabel);
  return () => ({
    name: direction.selectedOptions[0].textContent,
    material: material.value,
    select: {
      kind: "faces",
      space: "local",
      normal: JSON.parse(direction.value),
    },
  });
}
export function createWorkbench({
  store,
  draft,
  viewport,
  flushPending,
  status,
  info,
  getNode,
  getSelection,
  getLengthUnit = () => "m",
  onSelect,
  onRestore,
}) {
  let previous = store.snapshot(),
    comparison = null,
    action = null;
  const parameterEdits = new Map();
  const hasPending = () => parameterEdits.size > 0;
  const lengthFactor = () => ({ m: 1, cm: 0.01, mm: 0.001 })[getLengthUnit()];
  const unitLabel = (value) => value.replaceAll("(m)", `(${getLengthUnit()})`);
  const parameterFactor = (name) =>
    /\(m\)/.test(t("edParam_" + name) ?? "") ? lengthFactor() : 1;
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
  const flush = () => {
    if (hasPending())
      throw new ModelError(t("edParameterPending"), "pending_input");
    if (!flushPending())
      throw new ModelError(
        t(
          document.querySelector("#add-dialog").open
            ? "edShapePending"
            : "edInvalidField",
        ),
        "pending_input",
      );
  };
  const api = {
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
      flush();
      check(options);
      action = t("edUndo");
      try {
        const changed = store.undo();
        onRestore();
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
      flush();
      check(options);
      action = t("edRedo");
      try {
        const changed = store.redo();
        onRestore();
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
      flush();
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
      flush();
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
      flush();
      check(options);
      const item = draft.record.checkpoints?.find((c) => c.id === id);
      if (!item) throw new ModelError("Unknown checkpoint");
      action = `${t("edRestoreCheckpoint")} · ${item.name}`;
      try {
        const result = store.replace(item.project, options);
        onRestore();
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
      flush();
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
        onRestore();
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
    async exportProject() {
      flush();
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
  function safe(fn) {
    try {
      const result = fn();
      if (result?.catch) result.catch((e) => status(e.message, true));
      return result;
    } catch (e) {
      status(e.message, true);
    }
  }
  const tools = document.querySelector(".file-tools");
  const assemblyPreset = el("button", t("edAssemblyPreset"));
  assemblyPreset.id = "assembly-preset";
  assemblyPreset.disabled = !draft.writable;
  assemblyPreset.onclick = () =>
    safe(() => {
      flush();
      if (!confirm(t("edConfirm"))) return;
      // One replace is one undo step, including the parameter relationships.
      const scratch = emptyProject("Toolbox");
      const project = evaluateCommands(
        scratch,
        toolboxAssemblyCommands(hollowBoxRecipe()),
      );
      store.replace(project);
      onRestore();
      assemblyPanel.open = true;
    });
  document.querySelector("#planter").after(assemblyPreset);

  for (const [id, key, fn] of [
    [
      "activity",
      "edActivity",
      () => {
        const list = el("ol");
        list.className = "activity-list";
        for (const item of api.activity().reverse()) {
          const row = el("li");
          row.append(el("strong", `r${item.revision} · ${item.label}`));
          row.append(
            el(
              "p",
              item.error
                ? `${item.error.message} (${item.error.path})`
                : [
                    ...(item.changed ?? []),
                    ...(item.removed ?? []).map((id) => `− ${id}`),
                  ].join(", "),
            ),
          );
          const details = el("ul");
          for (const field of item.fields ?? [])
            details.append(
              el(
                "li",
                `${field.path}: ${JSON.stringify(field.before)} → ${JSON.stringify(field.after)}`,
              ),
            );
          if (details.children.length) row.append(details);
          if (item.truncatedFields) row.append(el("p", t("edMoreChanges")));
          row.append(
            el(
              "p",
              `${t("edAffected")}: ${(item.affected ?? item.changed ?? []).join(", ") || "—"} · ${t(draft.persistence.persistedRevision >= item.revision ? "edSaved" : "edSaving")}`,
            ),
          );
          if (item.issues?.length)
            row.append(
              el(
                "p",
                item.issues
                  .map((i) => `${i.code}: ${i.node ?? ""} ${i.face ?? ""}`)
                  .join(" · "),
              ),
            );
          if (item.detachedRecipes?.length)
            row.append(
              el(
                "p",
                t("edRecipeDetached") + ": " + item.detachedRecipes.join(", "),
              ),
            );
          list.append(row);
        }
        const elements = [list];
        if (comparison) {
          const button = el("button", t("edCompare"));
          button.onclick = () =>
            safe(async () => {
              const grid = el("div");
              grid.className = "comparison";
              const current = viewport.renderViews(["perspective"], 512, {
                  visibility: "all",
                  helpers: false,
                })[0],
                pose = current.camera;
              for (const [label, p] of [
                [t("edBefore"), comparison.before],
                [t("edAfter"), comparison.after],
              ]) {
                const figure = el("figure"),
                  image = el("canvas");
                image.width = image.height = 512;
                image.setAttribute("role", "img");
                image.setAttribute("aria-label", label);
                const data = viewport
                  .renderProject(p, ["perspective"], 512, {
                    camera: pose,
                    visibility: "all",
                    helpers: false,
                  })[0]
                  .dataUrl.split(",")[1];
                const bitmap = await createImageBitmap(
                  new Blob(
                    [Uint8Array.from(atob(data), (c) => c.charCodeAt(0))],
                    { type: "image/png" },
                  ),
                );
                image.getContext("2d").drawImage(bitmap, 0, 0);
                bitmap.close();
                image.dataset.ready = "true";
                figure.append(el("figcaption", label), image);
                grid.append(figure);
              }
              button.replaceWith(grid);
            });
          elements.unshift(button);
        }
        info(t("edActivity"), elements);
      },
    ],
    [
      "checkpoints",
      "edCheckpoints",
      () => {
        const name = el("input");
        name.value = store.snapshot().name;
        name.maxLength = 100;
        name.setAttribute("aria-label", t("edName"));
        const create = el("button", t("edCreateCheckpoint"));
        create.disabled = !draft.writable;
        create.onclick = () =>
          safe(async () => {
            api.checkpoint({ name: name.value });
            await draft.flush();
            document.querySelector("#info-dialog").close();
            document.querySelector("#checkpoints").click();
          });
        const elements = [name, create];
        for (const item of api.checkpoints()) {
          const row = el("div");
          row.className = "checkpoint-row";
          const restore = el(
              "button",
              `${t("edRestoreCheckpoint")} · ${item.name} (r${item.revision})`,
            ),
            remove = el("button", t("edDelete"));
          restore.disabled = remove.disabled = !draft.writable;
          restore.onclick = () =>
            safe(async () => {
              api.restoreCheckpoint(item.id, { ifRevision: store.revision });
              await draft.flush();
              document.querySelector("#info-dialog").close();
            });
          remove.onclick = () =>
            safe(async () => {
              api.removeCheckpoint(item.id);
              await draft.flush();
              document.querySelector("#info-dialog").close();
              document.querySelector("#checkpoints").click();
            });
          row.append(restore, remove);
          elements.push(row);
        }
        info(t("edCheckpoints"), elements);
      },
    ],
    [
      "export-report",
      "edExportReport",
      async () => {
        const { exportAsset } = await import("./viewport.js"),
          report = (await exportAsset(store.snapshot(), { force: true }))
            .report,
          list = el("dl");
        list.className = "delivery-summary";
        const size = report.bounds
          ? report.bounds.max
              .map((v, i) => Number((v - report.bounds.min[i]).toFixed(4)))
              .join(" × ") + " m"
          : "—";
        for (const [label, value] of [
          [
            t("edExportState"),
            t(report.validation.ok ? "edValid" : "edNeedsReview"),
          ],
          [t("edDimensions"), size],
          [t("edOrigin"), "[0, 0, 0] · m · Y ↑ · +Z"],
          [t("edTriangles"), report.triangles],
          [t("edCalls"), report.drawCalls],
          [t("edFileSize"), `${(report.bytes / 1024).toFixed(1)} KiB`],
          [
            t("edGeometryReuse"),
            `${report.meshes} / ${report.uniqueGeometries}`,
          ],
          [
            t("edWarnings"),
            `${report.validation.errors.length} ${t("edErrors")} · ${report.validation.warnings.length} ${t("edWarnings")}`,
          ],
        ])
          list.append(el("dt", label), el("dd", String(value)));
        const details = el("details");
        details.append(
          el("summary", t("edTechnicalDetails")),
          el("pre", JSON.stringify(report, null, 2)),
        );
        const issues = el("ul");
        for (const issue of [
          ...report.validation.errors,
          ...report.validation.warnings,
        ])
          issues.append(
            el(
              "li",
              `${t("edIssue_" + issue.code) ?? issue.code} · ${issue.node ?? issue.metric ?? ""} ${issue.face ?? ""}`,
            ),
          );
        info(t("edExportReport"), [
          list,
          issues,
          el("p", t("edUnchecked")),
          details,
        ]);
      },
    ],
  ]) {
    const button = el("button", t(key));
    button.id = id;
    button.dataset.i18n = key;
    button.onclick = () => safe(fn);
    tools.append(button);
  }
  const recipePanel = el("details"),
    assemblyPanel = el("details");
  recipePanel.id = "recipe-tools";
  assemblyPanel.id = "assembly-tools";
  const properties = document.querySelector("#properties"),
    navigation = el("div"),
    contextLabel = el("p"),
    shortcuts = el("nav");
  navigation.className = "inspector-navigation";
  contextLabel.className = "small";
  shortcuts.setAttribute("aria-label", t("edProperties"));
  const targets = [
    ["object-properties", "edObjectProperties"],
    ["recipe-tools", "edRecipeSteps"],
    ["assembly-tools", "edAssembly"],
  ];
  for (const [id, key] of targets) {
    const button = el("button", t(key));
    button.dataset.inspectorTarget = id;
    button.onclick = () => {
      for (const [other] of targets)
        document.getElementById(other).open = other === id;
      document.getElementById(id).scrollIntoView({ block: "start" });
    };
    shortcuts.append(button);
  }
  navigation.append(contextLabel, shortcuts);
  properties.prepend(navigation, recipePanel, assemblyPanel);
  function parameterFields(
    panel,
    parameters,
    key,
    command,
    readonly = false,
    assembly = null,
  ) {
    const pending = parameterEdits.get(key),
      signature = JSON.stringify(parameters);
    const fields = el("div");
    fields.className = "recipe-fields";
    for (const [name, p] of Object.entries(parameters)) {
      const label = el("label", unitLabel(t("edParam_" + name) ?? name)),
        input = el("input");
      input.type = "number";
      input.step = "any";
      input.dataset.parameter = name;
      input.value =
        pending?.values[name] ??
        Number((p.value / parameterFactor(name)).toPrecision(10));
      if (p.min !== undefined) input.min = p.min / parameterFactor(name);
      if (p.max !== undefined) input.max = p.max / parameterFactor(name);
      const portDriven =
        assembly &&
        store
          .snapshot()
          .assemblies.some((a) =>
            a.bindings.some(
              (b) =>
                b.id === assembly.root &&
                Object.hasOwn(b.assetValues ?? {}, name),
            ),
          );
      const shared =
        assembly?.source && !Object.hasOwn(assembly.overrides ?? {}, name);
      input.disabled =
        !draft.writable ||
        readonly ||
        !!p.expression ||
        !!shared ||
        !!portDriven;
      input.oninput = () => {
        const values = {};
        for (const field of fields.querySelectorAll("input"))
          if (!field.disabled) values[field.dataset.parameter] = field.value;
        parameterEdits.set(key, {
          values,
          signature: pending?.signature ?? signature,
        });
        status(t("edParameterPending"));
      };
      input.onkeydown = (e) => {
        if (e.key === "Escape") {
          parameterEdits.delete(key);
          renderRecipe();
        }
        if (e.key === "Enter") {
          e.preventDefault();
          rebuild.click();
        }
      };
      label.append(input);
      if (assembly?.source && !p.expression && !portDriven) {
        const toggle = el(
          "button",
          t(shared ? "edOverrideParameter" : "edShareParameter"),
        );
        toggle.dataset.overrideParameter = name;
        toggle.disabled = !draft.writable;
        toggle.onclick = () =>
          safe(() => {
            flush();
            api.apply(
              [
                {
                  op: "assemblyParameters",
                  root: assembly.root,
                  values: shared ? { [name]: p.value } : {},
                  ...(shared ? { override: true } : { resetOverrides: [name] }),
                },
              ],
              { ifRevision: store.revision },
            );
          });
        label.append(toggle);
      }
      if (portDriven) label.append(el("small", t("edParentPortDriven")));
      fields.append(label);
    }
    const rebuild = el("button", t("edRebuild")),
      cancel = el("button", t("edCancel"));
    rebuild.disabled = !draft.writable || readonly;
    const recovery = el("div");
    recovery.className = "parameter-recovery";
    rebuild.onclick = () =>
      safe(() => {
        const values = {};
        for (const input of fields.querySelectorAll("input")) {
          if (!input.reportValidity()) return;
          if (!input.disabled)
            values[input.dataset.parameter] =
              Number(input.value) * parameterFactor(input.dataset.parameter);
        }
        const staged = parameterEdits.get(key);
        if (staged && staged.signature !== signature)
          throw new ModelError(t("edParameterConflict"), "conflict");
        parameterEdits.delete(key);
        try {
          api.apply([{ ...command, values }], {
            ifRevision: store.revision,
            label: t("edRebuild"),
          });
        } catch (e) {
          if (staged) parameterEdits.set(key, staged);
          recovery.replaceChildren();
          if (e.recovery && e.node) {
            recovery.append(el("p", t("edPaintRecovery")));
            const readRule = materialRuleFields(
              recovery,
              e.node,
              store.snapshot(),
            );
            for (const [mode, label] of [
              ["clear", "edPaintClearRetry"],
              ["rules", "edPaintRulesRetry"],
            ]) {
              const fix = el("button", t(label));
              fix.onclick = () =>
                safe(() => {
                  parameterEdits.delete(key);
                  try {
                    api.apply(
                      [
                        {
                          op: "recipePaint",
                          id: e.node,
                          mode,
                          ...(mode === "rules" ? { rules: [readRule()] } : {}),
                        },
                        { ...command, values },
                      ],
                      { ifRevision: store.revision },
                    );
                  } catch (error) {
                    if (staged) parameterEdits.set(key, staged);
                    throw error;
                  }
                });
              recovery.append(fix);
            }
          }
          throw e;
        }
      });
    cancel.onclick = () => {
      parameterEdits.delete(key);
      renderRecipe();
      status(t("edCancelled"));
    };
    panel.append(fields, rebuild, cancel, recovery);
    if (pending) panel.append(el("p", t("edParameterPending")));
  }
  function renderRecipe(n = getNode()) {
    const project = store.snapshot(),
      assembly = assetFor(project, n?.id);
    const oldStepState =
      recipePanel.dataset.partId === n?.id
        ? [...recipePanel.querySelectorAll(".recipe-step")].map((el) => el.open)
        : [];
    contextLabel.textContent = n
      ? `${n.name} · ${n.id}${assembly ? " · " + t("edParameterTarget") + " " + assembly.root : ""}`
      : "";
    for (const [id, key] of targets) {
      const button = shortcuts.querySelector(`[data-inspector-target="${id}"]`);
      button.textContent = t(key);
      button.disabled =
        id === "assembly-tools"
          ? !assembly
          : id === "recipe-tools"
            ? !n?.mesh || !!n.instanceOf || !!n.symmetry
            : !n;
    }
    assemblyPanel.hidden = !assembly;
    const assemblyOpen = assemblyPanel.open,
      hadAssembly = assemblyPanel.dataset.active === "true";
    assemblyPanel.dataset.active = String(!!assembly);
    assemblyPanel.replaceChildren(el("summary", t("edAssembly")));
    if (assembly) {
      assemblyPanel.open =
        (recipePanel.dataset.partId !== n?.id
          ? n?.id === assembly.root
          : hadAssembly && assemblyOpen) ||
        parameterEdits.has("assembly:" + assembly.root);
      const root = project.nodes.find((v) => v.id === assembly.root);
      assemblyPanel.append(
        el("p", t("edParameterTarget") + " " + root.name + " · " + root.id),
      );
      const parentAsset = assetFor(project, root.parent);
      const related = [
        parentAsset,
        ...project.assemblies.filter(
          (a) =>
            a !== assembly &&
            assetFor(
              project,
              project.nodes.find((v) => v.id === a.root).parent,
            ) === assembly,
        ),
      ].filter(Boolean);
      for (const relatedAsset of related) {
        const jump = el(
          "button",
          t(relatedAsset === parentAsset ? "edParentAsset" : "edChildAsset") +
            " · " +
            relatedAsset.root,
        );
        jump.onclick = () => safe(() => onSelect(relatedAsset.root));
        assemblyPanel.append(jump);
      }
      parameterFields(
        assemblyPanel,
        assembly.parameters,
        "assembly:" + assembly.root,
        {
          op: "assemblyParameters",
          root: assembly.root,
          ...(assembly.source ? { override: true } : {}),
        },
        false,
        assembly,
      );
      if (assembly.source) {
        assemblyPanel.append(
          el("p", t("edParameterSource") + " " + assembly.source),
        );
        const independent = el("button", t("edMakeIndependent"));
        independent.onclick = () =>
          safe(() => {
            const definition = structuredClone(assembly);
            delete definition.source;
            delete definition.overrides;
            api.apply([{ op: "assembly", definition }], {
              ifRevision: store.revision,
            });
          });
        const source = el("button", t("edEditParameterSource"));
        source.onclick = () => safe(() => onSelect(assembly.source));
        independent.disabled = !draft.writable;
        assemblyPanel.append(source, independent);
      }
      assemblyPanel.append(el("p", t("edAssemblyHelp")));
      const binding = bindingFor(project, n?.id);
      if (binding) {
        const bindingOwner = project.assemblies.find((a) =>
          a.bindings.some((b) => b.id === n.id),
        );
        const hint = el("p", t("edAssemblyDriven"));
        hint.className = "driven-field-hint";
        const keys = new Set();
        const scan = (v) => {
          if (v && typeof v === "object") {
            if (v.$param) keys.add(v.$param);
            Object.values(v).forEach(scan);
          }
        };
        scan(binding);
        for (const key of keys) {
          const jump = el(
            "button",
            (t("edParam_" + key) ?? key).replace(/ \(.*\)$/, ""),
          );
          jump.onclick = () =>
            safe(() => {
              if (bindingOwner !== assembly) onSelect(bindingOwner.root);
              else if (
                assembly.source &&
                !Object.hasOwn(assembly.overrides ?? {}, key)
              )
                onSelect(assembly.source);
              assemblyPanel.open = true;
              assemblyPanel.querySelector(`[data-parameter="${key}"]`)?.focus();
            });
          hint.append(jump);
        }
        const detach = el("button", t("edDetachBinding"));
        detach.id = "detach-binding";
        detach.disabled = !draft.writable;
        detach.onclick = () =>
          safe(() => {
            flush();
            api.apply([{ op: "detachBinding", id: n.id }], {
              ifRevision: store.revision,
            });
          });
        assemblyPanel.append(hint);
        for (const field of [
          "position",
          "rotation",
          "options",
          "recipeValues",
          "assetValues",
        ].filter((k) => binding[k])) {
          const detachField = el(
            "button",
            t("edDetachField") + " · " + t("edBinding_" + field),
          );
          detachField.dataset.detachField = field;
          detachField.disabled = !draft.writable;
          detachField.onclick = () =>
            safe(() => {
              flush();
              api.apply([{ op: "detachBinding", id: n.id, fields: [field] }], {
                ifRevision: store.revision,
              });
            });
          assemblyPanel.append(detachField);
          if (field === "assetValues" && assembly.source) {
            const inherit = el("button", t("edDetachInherit"));
            inherit.disabled = !draft.writable;
            inherit.onclick = () =>
              safe(() => {
                flush();
                api.apply(
                  [
                    {
                      op: "detachBinding",
                      id: n.id,
                      fields: ["assetValues"],
                      mode: "inherit",
                    },
                  ],
                  { ifRevision: store.revision },
                );
              });
            assemblyPanel.append(inherit);
          }
        }
        assemblyPanel.append(detach);
      }
    }
    recipePanel.hidden = !n?.mesh || !!n.instanceOf || !!n.symmetry;
    const open = recipePanel.open,
      oldId = recipePanel.dataset.partId,
      hadRecipe = recipePanel.dataset.recipe === "true";
    recipePanel.dataset.recipe = String(!!n?.recipe);
    recipePanel.dataset.partId = n?.id ?? "";
    recipePanel.replaceChildren(el("summary", t("edRecipe")));
    if (n?.recipe) {
      recipePanel.open = oldId === n.id && hadRecipe ? open : true;
      if (assembly?.bindings.some((b) => b.id === n.id && b.recipeValues)) {
        recipePanel.append(el("p", t("edAssemblyDriven")));
      } else if (Object.keys(n.recipe.parameters).length)
        parameterFields(recipePanel, n.recipe.parameters, "node:" + n.id, {
          op: "recipeParameters",
          id: n.id,
        });
      if (shapeGenerator(n)) {
        const base = el("button", t("edRecipeShape"));
        base.id = "recipe-shape";
        base.disabled = !draft.writable || !!bindingFor(project, n.id)?.options;
        base.onclick = () => document.querySelector("#parameters").click();
        recipePanel.append(base);
      }
      recipePanel.append(el("p", t("edRecipeHelp")));
      const steps = el("section");
      steps.className = "recipe-steps";
      steps.append(
        el("h4", t("edRecipeSteps")),
        el("p", t("edRecipeStepsHelp")),
      );
      const editStep = (change) => {
        flush();
        return api.apply([{ op: "recipeStep", id: n.id, ...change }], {
          ifRevision: store.revision,
        });
      };
      for (const [index, step] of n.recipe.steps.entries()) {
        const row = el("details"),
          title = el("summary"),
          enabled = el("input");
        row.open = oldStepState[index] ?? index === n.recipe.steps.length - 1;
        row.className = "recipe-step";
        row.dataset.step = index;
        enabled.type = "checkbox";
        enabled.onclick = (e) => e.stopPropagation();
        enabled.checked = step.enabled !== false;
        enabled.disabled = !draft.writable;
        enabled.setAttribute(
          "aria-label",
          t("edStepEnabled") + " " + (index + 1),
        );
        enabled.onchange = () =>
          safe(() => {
            try {
              editStep({
                action: "update",
                index,
                step: { ...step, enabled: enabled.checked },
              });
            } catch (error) {
              enabled.checked = step.enabled !== false;
              throw error;
            }
          });
        title.append(
          enabled,
          document.createTextNode(
            `${index + 1}. ${step.label ?? t("edStep_" + step.op)}`,
          ),
        );
        const brief = el(
          "small",
          ["distance", "ratio", "offset"]
            .filter((k) => step[k] !== undefined)
            .map(
              (k) =>
                `${Number((recipeValue(step[k], n.recipe.parameters) / (k === "ratio" ? 1 : lengthFactor())).toPrecision(5))}${k === "ratio" ? "" : " " + getLengthUnit()}`,
            )
            .join(" · "),
        );
        title.append(brief);
        row.append(title);
        for (const field of ["distance", "ratio", "offset"].filter(
          (key) => step[key] !== undefined,
        )) {
          const factor = field === "ratio" ? 1 : lengthFactor();
          const label = el("label", unitLabel(t("edStepField_" + field))),
            input = el("input"),
            value = step[field];
          input.setAttribute(
            "aria-label",
            `${index + 1}. ${unitLabel(t("edStepField_" + field))}`,
          );
          if (typeof value === "number") {
            input.type = "number";
            input.step = "any";
            input.value = Number((value / factor).toPrecision(10));
            input.disabled = !draft.writable;
            input.onchange = () =>
              safe(() => {
                try {
                  if (
                    input.value === "" ||
                    !Number.isFinite(input.valueAsNumber)
                  )
                    throw new ModelError(t("edInvalidField"));
                  editStep({
                    action: "update",
                    index,
                    step: { ...step, [field]: input.valueAsNumber * factor },
                  });
                } catch (error) {
                  input.value = Number((value / factor).toPrecision(10));
                  throw error;
                }
              });
          } else {
            input.value = Number(
              (recipeValue(value, n.recipe.parameters) / factor).toPrecision(8),
            );
            input.readOnly = true;
            input.title =
              (value.$param
                ? t("edParam_" + value.$param)
                : t("edStepExpression")) +
              " · " +
              JSON.stringify(value);
          }
          label.append(input);
          row.append(label);
        }
        if (step.axis) {
          const label = el("label", t("edStepAxis")),
            axis = el("select");
          for (const v of ["x", "y", "z"]) {
            const option = el("option", v.toUpperCase());
            option.value = v;
            axis.append(option);
          }
          axis.value = step.axis;
          axis.disabled = !draft.writable;
          axis.onchange = () =>
            safe(() => {
              try {
                editStep({
                  action: "update",
                  index,
                  step: { ...step, axis: axis.value },
                });
              } catch (error) {
                axis.value = step.axis;
                throw error;
              }
            });
          label.append(axis);
          row.append(label);
        }
        const actions = el("div");
        actions.className = "recipe-step-actions";
        for (const [key, change, unavailable] of [
          ["edStepUp", { action: "move", index, to: index - 1 }, index === 0],
          [
            "edStepDown",
            { action: "move", index, to: index + 1 },
            index === n.recipe.steps.length - 1,
          ],
          ["edDelete", { action: "remove", index }, false],
        ]) {
          const button = el("button", t(key));
          button.disabled = !draft.writable || unavailable;
          button.onclick = () => safe(() => editStep(change));
          actions.append(button);
        }
        row.append(actions);
        const scopeDetails = el("details"),
          applyScope = el("button", t("edStepApplyScope"));
        scopeDetails.className = "recipe-step-scope";
        scopeDetails.append(
          el(
            "summary",
            t("edStepScope") +
              " · " +
              t(
                step.select
                  ? "edStepSemanticScope"
                  : step.faces || step.edges
                    ? "edStepCurrentScope"
                    : "edStepWholeScope",
              ),
          ),
        );
        applyScope.disabled = true;
        const scopeControls = recipeScopeControls({
          project,
          node: n,
          index,
          step,
          existing: true,
          getSelection,
          viewport,
          status,
          onReady: (ready) => {
            applyScope.disabled = !draft.writable || !ready;
          },
        });
        applyScope.onclick = () =>
          safe(() =>
            editStep({ action: "update", index, step: scopeControls.ready() }),
          );
        scopeDetails.append(scopeControls.element, applyScope);
        row.append(scopeDetails);
        steps.append(row);
      }
      const addLabel = el("label", t("edStepAdd")),
        choice = el("select");
      choice.id = "recipe-step-kind";
      for (const op of ["bevel", "cut", "inset", "extrude", "mirror"]) {
        const option = el("option", t("edStep_" + op));
        option.value = op;
        choice.append(option);
      }
      const addStep = el("button", t("edStepAdd"));
      addStep.id = "recipe-step-add";
      let scopeControls;
      const scopeHost = el("div");
      scopeHost.id = "recipe-step-scope";
      const resetScope = () => {
        addStep.disabled = true;
        const op = choice.value,
          top = {
            kind: "faces",
            space: "local",
            normal: [0, 1, 0],
            largest: true,
          };
        const step =
          op === "bevel"
            ? { op, distance: 0.005 }
            : op === "cut"
              ? { op, axis: "y", offset: 0 }
              : op === "mirror"
                ? { op, axis: "x" }
                : { op, select: top, distance: 0.005 };
        scopeControls = recipeScopeControls({
          project,
          node: n,
          index: n.recipe.steps.length,
          step,
          getSelection,
          viewport,
          status,
          onReady: (ready) => {
            addStep.disabled =
              !draft.writable || n.recipe.steps.length >= 32 || !ready;
          },
        });
        scopeHost.replaceChildren(scopeControls.element);
      };
      choice.onchange = resetScope;
      resetScope();
      addStep.onclick = () =>
        safe(() => editStep({ action: "append", step: scopeControls.ready() }));
      addLabel.append(choice);
      steps.append(addLabel, scopeHost, addStep);
      recipePanel.append(steps);
      const paint = el("details");
      paint.className = "recipe-paint";
      paint.append(
        el("summary", t("edPaintBindings")),
        el("p", t("edPaintRulesHelp")),
      );
      const readRule = materialRuleFields(paint, n.id, project);
      const bind = el("button", t("edPaintBind")),
        clear = el("button", t("edPaintClear"));
      bind.disabled = clear.disabled = !draft.writable;
      bind.onclick = () =>
        safe(() =>
          api.apply(
            [
              {
                op: "recipePaint",
                id: n.id,
                mode: "rules",
                rules: [...(n.recipe.paint?.rules ?? []), readRule()],
              },
            ],
            { ifRevision: store.revision },
          ),
        );
      clear.onclick = () =>
        safe(() =>
          api.apply([{ op: "recipePaint", id: n.id, mode: "clear" }], {
            ifRevision: store.revision,
          }),
        );
      paint.append(bind, clear);
      for (const [index, rule] of (n.recipe.paint?.rules ?? []).entries()) {
        const row = el(
            "p",
            (rule.name ?? String(index + 1)) +
              " · " +
              (project.materials.find((m) => m.id === rule.material)?.name ??
                rule.material),
          ),
          remove = el("button", t("edDelete"));
        remove.disabled = !draft.writable;
        remove.onclick = () =>
          safe(() =>
            api.apply(
              [
                {
                  op: "recipePaint",
                  id: n.id,
                  mode: "rules",
                  rules: n.recipe.paint.rules.filter((_, i) => i !== index),
                },
              ],
              { ifRevision: store.revision },
            ),
          );
        row.append(remove);
        paint.append(row);
      }
      recipePanel.append(paint);
    } else {
      if (n?.mesh && !n.instanceOf && !n.symmetry) {
        const start = el("button", t("edStartRecipe"));
        start.id = "start-recipe";
        start.disabled = !draft.writable;
        start.onclick = () =>
          safe(() =>
            api.apply(
              [
                {
                  op: "recipe",
                  id: n.id,
                  definition: getRecipe(project, { id: n.id }).recipe,
                },
              ],
              { ifRevision: store.revision, label: t("edStartRecipe") },
            ),
          );
        recipePanel.append(start, el("p", t("edStartRecipeHelp")));
      }
      const preset = el("button", t("edHollowRecipe"));
      preset.disabled = !draft.writable;
      preset.onclick = () =>
        safe(() =>
          api.apply(
            [{ op: "recipe", id: n.id, definition: hollowBoxRecipe() }],
            { ifRevision: store.revision, label: t("edHollowRecipe") },
          ),
        );
      recipePanel.append(preset, el("p", t("edRecipeReplace")));
    }
  }
  return { api, renderRecipe, hasPending };
}
