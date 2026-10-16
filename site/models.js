import { getLocale, initLocale, languagePath, onLocaleChange, t } from "./i18n.js";
import { MODEL_TYPES, blobURL, loadModels, modelPath } from "./models-catalog.js";
import { registerServiceWorker } from "./pwa.js";

const list = document.querySelector("#model-list");
const tools = document.querySelector("#catalog-tools");
const search = document.querySelector("#search");
const type = document.querySelector("#type");
const kit = document.querySelector("#kit");
const tag = document.querySelector("#tag");
const status = document.querySelector("#result-status");
const count = document.querySelector("#catalog-count");
const empty = document.querySelector("#empty-state");
const noResults = document.querySelector("#no-results");
const error = document.querySelector("#load-error");
let models = [];
let loadState = "loading";

function item(model) {
  const latest = model.versions[0];
  const node = document.createElement("li");
  const link = Object.assign(document.createElement("a"), { className: "model-link", href: languagePath(modelPath(model)) });
  const image = Object.assign(document.createElement("img"), { className: "model-preview", src: blobURL("preview.png", latest.files["preview.png"]), alt: "", loading: "lazy", decoding: "async", width: 300, height: 300 });
  const name = Object.assign(document.createElement("span"), { className: "model-name", textContent: model.name[getLocale()] });
  const id = Object.assign(document.createElement("span"), { className: "model-id muted", textContent: model.id });
  link.append(image, name, id);
  node.append(link);
  return node;
}

// Filters live in the address (?kit=…&tag=…&q=…), so a kit page is a link.
function syncAddress() {
  const url = new URL(location.href);
  for (const [key, value] of [["type", type.value], ["kit", kit.value], ["tag", tag.value], ["q", search.value.trim()]]) {
    if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
  }
  history.replaceState(null, "", `${url.pathname}${url.search}`);
}

function render() {
  count.textContent = models.length > 1 ? t("modelsCount", models.length) : "";
  if (loadState !== "ready") {
    status.textContent = t(loadState === "loading" ? "loading" : "loadError");
    return;
  }
  const query = search.value.trim().toLocaleLowerCase();
  const visible = models.filter((model) => (!type.value || model.type === type.value) && (!kit.value || model.kit === kit.value) && (!tag.value || model.tags.includes(tag.value)) &&
    [model.id, model.name.zh, model.name.en, model.kit ?? "", ...model.tags].join(" ").toLocaleLowerCase().includes(query));
  list.replaceChildren(...visible.map(item));
  list.hidden = visible.length === 0;
  empty.hidden = models.length !== 0;
  noResults.hidden = models.length === 0 || visible.length !== 0;
  status.textContent = query || type.value || kit.value || tag.value ? t("matches", visible.length) : "";
}

function options(select, values, all, label = (value) => value) {
  const selected = select.value;
  select.replaceChildren(new Option(t(all), ""), ...values.map((value) => new Option(label(value), value)));
  select.value = values.includes(selected) ? selected : "";
}

function translate() {
  options(type, MODEL_TYPES.filter((value) => models.some((model) => model.type === value)), "allTypes", (value) => t(`type_${value}`));
  options(kit, [...new Set(models.map((model) => model.kit).filter(Boolean))].sort(), "allKits");
  options(tag, [...new Set(models.flatMap((model) => model.tags))].sort(), "allTags");
  render();
}

async function load() {
  for (const node of [error, empty, tools, noResults, list]) node.hidden = true;
  loadState = "loading";
  render();
  try {
    models = await loadModels(AbortSignal.timeout(10000));
    loadState = "ready";
    tools.hidden = models.length < 2;
    const params = new URLSearchParams(location.search);
    type.replaceChildren(new Option("", params.get("type") ?? ""));
    type.value = params.get("type") ?? "";
    kit.replaceChildren(new Option("", params.get("kit") ?? ""));
    tag.replaceChildren(new Option("", params.get("tag") ?? ""));
    kit.value = params.get("kit") ?? "";
    tag.value = params.get("tag") ?? "";
    search.value = params.get("q") ?? "";
    translate();
  } catch {
    loadState = "error";
    render();
    error.hidden = false;
  }
}

for (const control of [search, type, kit, tag]) control.addEventListener(control === search ? "input" : "change", () => { syncAddress(); render(); });
document.querySelector("#clear-filters").addEventListener("click", () => {
  search.value = type.value = kit.value = tag.value = "";
  syncAddress();
  render();
  search.focus();
});
document.querySelector("#retry").addEventListener("click", async () => {
  await load();
  if (!error.hidden) document.querySelector("#retry").focus();
  else document.querySelector("#models-title").focus();
});
initLocale();
onLocaleChange(translate);
load();
registerServiceWorker();
