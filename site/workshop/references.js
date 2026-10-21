// Reference images: one per orthographic view, kept with the draft, never in a project or
// an export. People trace over them; agents compare observations against them.
import { ModelError } from "./mesh.js";
import { t } from "../i18n.js";

export const REFERENCE_VIEWS = ["front", "back", "left", "right", "top"];
const IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;

export function normalizeReference(spec) {
  const bad = (message, path) => {
    throw new ModelError(message, "invalid", path);
  };
  if (!REFERENCE_VIEWS.includes(spec?.view))
    bad("Choose front, back, left, right or top", "view");
  if (typeof spec.image !== "string" || spec.image.length > 8 * 1024 * 1024)
    bad("Expected an image data URL of at most 8 MB", "image");
  if (!IMAGE.test(spec.image))
    bad("Expected a PNG, JPEG, WebP or GIF data URL", "image");
  if (!Number.isFinite(spec.width) || spec.width < 0.001 || spec.width > 10000)
    bad("Width is 0.001–10000 m", "width");
  const center = spec.center ?? [0, 0];
  if (
    !Array.isArray(center) ||
    center.length !== 2 ||
    center.some((v) => !Number.isFinite(v) || Math.abs(v) > 10000)
  )
    bad("Center is [horizontal, vertical] in metres", "center");
  const opacity = spec.opacity ?? 0.5;
  if (!Number.isFinite(opacity) || opacity < 0.05 || opacity > 1)
    bad("Opacity is 0.05–1", "opacity");
  return { view: spec.view, image: spec.image, width: spec.width, center: [...center], opacity };
}

export const referenceSummary = (r) => ({
  view: r.view,
  width: r.width,
  center: r.center,
  opacity: r.opacity,
  bytes: r.image.length,
});

// The desktop dialog: choose a view and an image, then size and place it in metres.
export function referenceDialog({ info, list, apply, clear, unit, history = () => null, record, select }) {
  const el = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const field = (label, input) => {
    const wrapper = el("label", label);
    wrapper.append(input);
    return wrapper;
  };
  const view = el("select");
  for (const name of REFERENCE_VIEWS) {
    const option = el("option", t({ front: "edFront", back: "edBack", left: "edLeft", right: "edRight", top: "edTop" }[name]));
    option.value = name;
    view.append(option);
  }
  const file = el("input");
  file.type = "file";
  file.accept = "image/png,image/jpeg,image/webp,image/gif";
  const versions = el("select");
  versions.setAttribute("aria-label", t("edReferenceVersions"));
  const refreshVersions = () => {
    const selected = versions.value; versions.replaceChildren();
    const blank = el("option", t("edReferenceChoose")); blank.value = ""; versions.append(blank);
    for (const r of history()?.records ?? []) if (r.kind === "image") {
      const option = el("option", `${r.text} · ${r.id}`); option.value = r.id; versions.append(option);
    }
    versions.value = selected;
  };
  refreshVersions();
  versions.onchange = () => { file.value = ""; };
  const number = (value, step = "any") => {
    const input = el("input");
    input.type = "number";
    input.step = step;
    input.value = value;
    return input;
  };
  const width = number(2),
    x = number(0),
    y = number(0),
    opacity = el("input");
  opacity.type = "range";
  opacity.min = "0.05";
  opacity.max = "1";
  opacity.step = "0.05";
  opacity.value = "0.5";
  const sync = () => {
    const current = list().find((r) => r.view === view.value);
    if (!current) return;
    width.value = current.width / unit();
    x.value = current.center[0] / unit();
    y.value = current.center[1] / unit();
    opacity.value = current.opacity;
  };
  view.onchange = sync;
  sync();
  const message = el("p");
  const set = el("button", t("edReferenceApply")),
    remove = el("button", t("edReferenceRemove"));
  set.type = remove.type = "button";
  set.onclick = async () => {
    const existing = list().find((r) => r.view === view.value);
    const chosen = file.files[0];
    const archived = history()?.records.find(r => r.id === versions.value && r.kind === "image");
    if (!chosen && !existing && !archived) {
      message.textContent = t("edReferenceChoose");
      return;
    }
    try {
      const image = chosen
        ? await new Promise((done, fail) => {
            const reader = new FileReader();
            reader.onload = () => done(reader.result);
            reader.onerror = () => fail(reader.error);
            reader.readAsDataURL(chosen);
          })
        : archived?.image ?? existing.image;
      await apply({
        view: view.value,
        image,
        width: Number(width.value) * unit(),
        center: [Number(x.value) * unit(), Number(y.value) * unit()],
        opacity: Number(opacity.value),
      });
      if (archived && !chosen) await select?.([archived.id]);
      message.textContent = t("edUpdated");
    } catch (error) {
      message.textContent = t("edError") + error.message;
    }
  };
  remove.onclick = async () => {
    await clear({ view: view.value });
    message.textContent = t("edUpdated");
  };
  const save = el("button", t("edReferenceSaveVersion"));
  save.type = "button";
  save.onclick = async () => {
    try {
      const current = list().find(r => r.view === view.value);
      if (!current) throw new ModelError(t("edReferenceApplyFirst"));
      const key = `reference-${crypto.randomUUID()}`;
      const origin = history()?.records.find(r => r.kind === "image" && r.image === current.image)?.origin ?? "user";
      await record?.({ id: key, kind: "image", origin, text: view.selectedOptions[0].textContent, image: current.image });
      refreshVersions(); versions.value = key; message.textContent = t("edUpdated");
    } catch (error) { message.textContent = t("edError") + error.message; }
  };
  const decisions = el("div");
  for (const r of history()?.records ?? []) if (r.kind !== "image")
    decisions.append(el("p", `${r.id} · ${t("edReference_" + (r.status ?? r.kind))}: ${r.text}${r.evidence ? ` — ${r.evidence}` : ""}`));
  info(t("edReference"), [
    el("p", t("edReferenceHelp")),
    field(t("edReferenceVersions"), versions),
    field(t("edReferenceView"), view),
    field(t("edReferenceImage"), file),
    field(t("edReferenceWidth"), width),
    field(t("edReferenceX"), x),
    field(t("edReferenceY"), y),
    field(t("edOpacity"), opacity),
    set,
    remove,
    ...(record ? [save, decisions] : []),
    message,
  ]);
}
