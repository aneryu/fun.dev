import { t } from "../i18n.js";
import { materialUsage } from "./materials.js";
import { LIMITS } from "./document.js";

const el = (tag, value) => {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  return node;
};
const message = (key, values) =>
  Object.entries(values).reduce(
    (value, [name, replacement]) => value.replaceAll(`{${name}}`, replacement),
    t(key),
  );

export function createMaterialLibrary({ store, editable, info, onChange }) {
  return function open(selected) {
    const revision = store.revision,
      materials = materialUsage(store.snapshot());
    const unused = materials.filter((m) => m.unused).length;
    const removable = unused === materials.length ? unused - 1 : unused;
    const summary = el(
      "p",
      message("edMaterialBudget", {
        count: materials.length,
        limit: LIMITS.materials,
        unused: removable,
      }),
    );
    const sourceLabel = el("label", t("edMaterial")),
      source = el("select");
    source.id = "library-material";
    sourceLabel.htmlFor = source.id;
    const targetLabel = el("label", t("edMaterialReplacement")),
      target = el("select");
    target.id = "library-replacement";
    targetLabel.htmlFor = target.id;
    const usage = el("p"),
      help = el("p", t("edMaterialLibraryHelp")),
      error = el("p");
    error.id = "library-error";
    error.setAttribute("role", "alert");
    error.className = "notice";
    error.hidden = true;
    for (const m of materials) {
      const option = el("option", `${m.name} · ${m.id} · ${m.color}`);
      option.value = m.id;
      source.append(option);
    }
    source.value = materials.some((m) => m.id === selected)
      ? selected
      : materials[0].id;
    const remove = el("button", t("edMaterialRemove")),
      replace = el("button", t("edMaterialReplace")),
      purge = el("button", t("edMaterialPurge"));
    remove.id = "library-remove";
    replace.id = "library-replace";
    purge.id = "library-purge";
    const update = () => {
      const m = materials.find((m) => m.id === source.value);
      usage.textContent = message("edMaterialReferences", {
        users: m.users.length,
        retained: m.retainedBy.length,
      });
      const ids = new Set([...m.users, ...m.retainedBy]);
      if (ids.size)
        usage.textContent += ` · ${[...ids].slice(0, 12).join(", ")}${ids.size > 12 ? "…" : ""}`;
      target.replaceChildren();
      for (const m of materials.filter((m) => m.id !== source.value)) {
        const option = el("option", `${m.name} · ${m.id} · ${m.color}`);
        option.value = m.id;
        target.append(option);
      }
      target.disabled = !editable() || materials.length < 2;
      remove.disabled = !editable() || !m.unused || materials.length < 2;
      replace.disabled = !editable() || materials.length < 2;
      purge.disabled = !editable() || removable === 0;
    };
    source.onchange = update;
    const apply = (command, selected) => {
      try {
        store.apply([command], { ifRevision: revision });
        onChange(selected);
        open(selected);
      } catch (reason) {
        error.hidden = false;
        error.textContent =
          reason.code === "conflict" ? t("edMaterialChanged") : reason.message;
      }
    };
    remove.onclick = () => apply({ op: "removeMaterial", id: source.value });
    replace.onclick = () =>
      apply(
        { op: "removeMaterial", id: source.value, replacement: target.value },
        target.value,
      );
    purge.onclick = () => apply({ op: "purgeMaterials" }, source.value);
    update();
    info(t("edMaterialLibrary"), [
      summary,
      sourceLabel,
      source,
      usage,
      remove,
      targetLabel,
      target,
      replace,
      purge,
      help,
      error,
    ]);
  };
}
