import { getLocale, initLocale, languagePath, onLocaleChange, t } from "./i18n.js";
import { blobURL, loadIndex, loadModel, modelPath } from "./models-catalog.js";
import { registerServiceWorker } from "./pwa.js";

// The homepage: a model from the library turning on the page (the claw machine first; "another
// one" picks at random), then the workshop, the library and what was made with them.
initLocale();
registerServiceWorker();

const stage = document.querySelector("#model-stage");
const caption = document.querySelector("#model-caption");
const another = document.querySelector("#another-model");
const modelsLine = document.querySelector("#models-line");
// Whole objects show best; modular pieces (walls, road kits) and characters are left out.
const SHOWN = new Set(["prop", "vehicle"]);
const FEATURED = "claw_machine_01";
let index = null, current = null, viewer = null, modelCount = null;

function renderCaption() {
  caption.replaceChildren();
  if (!current) return;
  const view = Object.assign(document.createElement("a"), { href: languagePath(modelPath(current.id)), textContent: t("viewModel") });
  const open = Object.assign(document.createElement("a"), { href: languagePath(`/workshop/?open=${encodeURIComponent(current.id)}`), textContent: t("openInWorkshop") });
  const name = Object.assign(document.createElement("strong"), { textContent: current.name[getLocale()] ?? current.name.en });
  caption.append(name, " · ", view, " · ", open);
}

function renderModels() {
  modelsLine.textContent = modelCount ? t("modelsLine", modelCount.toLocaleString(getLocale() === "zh" ? "zh-CN" : "en")) : t("modelsIntro");
}

async function show(id) {
  const model = await loadModel(id, AbortSignal.timeout(15000));
  const glb = model?.versions[0]?.files["model.glb"];
  if (!glb) return;
  viewer ??= (await import("./model-viewer.js")).createViewer(stage, { ground: true });
  await viewer.load(blobURL("model.glb", glb.sha256));
  current = model;
  renderCaption();
}

function showRandom() {
  const pool = index.models.filter((model) => SHOWN.has(model.type) && model.id !== current?.id);
  return pool.length ? show(pool[Math.floor(Math.random() * pool.length)].id) : Promise.resolve();
}

async function start() {
  // The featured model and the index (for its size and "another one") load side by side.
  const indexed = loadIndex(getLocale(), AbortSignal.timeout(15000)).then((loaded) => {
    index = loaded;
    modelCount = loaded.models.length;
    renderModels();
  }, () => {});
  await show(FEATURED).catch(() => {});
  await indexed;
  another.hidden = !current || !index;
}

another.addEventListener("click", () => { another.disabled = true; showRandom().catch(() => {}).finally(() => { another.disabled = false; }); });

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent);
      button.textContent = t("copied");
      setTimeout(() => { button.textContent = t("copy"); }, 1500);
    } catch { /* Selecting the command by hand still works. */ }
  });
}

onLocaleChange(() => { renderCaption(); renderModels(); });
void start();
