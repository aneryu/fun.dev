import { getLocale, initLocale, onLocaleChange, t } from "./i18n.js";
import { blobURL, formatBytes, formatSize, loadModels } from "./models-catalog.js";
import { registerServiceWorker } from "./pwa.js";

// /models/<id> is this page (Pages serves model.html there); it shows the newest version or
// ?version=v00N.
const $ = (selector) => document.querySelector(selector);
const id = location.pathname.match(/^\/models\/([a-z0-9]+(?:_[a-z0-9]+)*)$/)?.[1];
let model = null, version = null, viewer = null;
let state = "loading";

function showStatus() {
  $("#status").textContent = state === "ready" ? "" : t(state);
}

function render() {
  showStatus();
  if (!model) return;
  const name = model.name[getLocale()];
  document.title = `${name} · fun.dev`;
  $("#model-name").textContent = name;
  $("#model-kit").textContent = [t(`type_${model.type}`), model.kit, ...model.tags].filter(Boolean).join(" · ");
  $("#stat-size").textContent = formatSize(version.stats.size);
  $("#stat-triangles").textContent = version.stats.triangles.toLocaleString(getLocale() === "zh" ? "zh-CN" : "en");
  $("#stat-bytes").textContent = formatBytes(version.files["model.glb"].size);
  $("#address").textContent = new URL(blobURL("model.glb", version.files["model.glb"]), location.href).href;
  $("#download-blend").hidden = !version.files["source.blend"];
}

async function show(name) {
  version = model.versions.find((entry) => entry.version === name) ?? model.versions[0];
  render();
  const url = new URL(location.href);
  if (version === model.versions[0]) url.searchParams.delete("version"); else url.searchParams.set("version", version.version);
  history.replaceState(null, "", `${url.pathname}${url.search}`);
  if (!viewer) viewer = (await import("./model-viewer.js")).createViewer($("#stage"));
  await viewer.load(blobURL("model.glb", version.files["model.glb"])).catch(() => { state = "viewerError"; showStatus(); });
}

async function download(name) {
  const file = version.files[name];
  const response = await fetch(blobURL(name, file), { credentials: "omit" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(await response.blob()), download: `${model.id}_${version.version}.${name.split(".").pop()}` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

$("#copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#address").textContent); $("#status").textContent = t("copied"); }
  catch { $("#status").textContent = t("copyError"); }
});
$("#download-glb").addEventListener("click", () => download("model.glb").catch(() => { $("#status").textContent = t("loadError"); }));
$("#download-blend").addEventListener("click", () => download("source.blend").catch(() => { $("#status").textContent = t("loadError"); }));
$("#version").addEventListener("change", (event) => show(event.target.value));

initLocale();
onLocaleChange(render);
showStatus();
try {
  model = id ? (await loadModels(AbortSignal.timeout(10000))).find((entry) => entry.id === id) : null;
  if (!model) {
    state = "modelMissing";
  } else {
    state = "ready";
    $("#model-id").textContent = model.id;
    $("#detail").hidden = false;
    $("#version").replaceChildren(...model.versions.map((entry) => new Option(entry.version, entry.version)));
    $("#version").value = new URLSearchParams(location.search).get("version") ?? model.versions[0].version;
    $("#versions-block").hidden = model.versions.length < 2;
    await show($("#version").value);
  }
} catch {
  state = "loadError";
}
showStatus();
registerServiceWorker();
