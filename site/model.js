import { getLocale, initLocale, onLocaleChange, t } from "./i18n.js";
import { blobURL, formatBytes, formatSize, loadModel } from "./models-catalog.js";
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
  $("#model-description").textContent = model.description?.[getLocale()] ?? "";
  $("#model-description").hidden = !model.description;
  $("#model-kit-note").textContent = model.kitDescription ? `${t("kit")} ${model.kit}: ${model.kitDescription[getLocale()]}` : "";
  $("#model-kit-note").hidden = !model.kitDescription;
  $("#stat-size").textContent = formatSize(version.stats.size);
  $("#stat-triangles").textContent = version.stats.triangles.toLocaleString(getLocale() === "zh" ? "zh-CN" : "en");
  $("#stat-bytes").textContent = formatBytes(version.files["model.glb"].size);
  $("#address").textContent = new URL(blobURL("model.glb", version.files["model.glb"].sha256), location.href).href;
  $("#download-blend").hidden = !version.files["source.blend"];
  $("#download-workshop").hidden = !version.files["source.funmodel.glb"];
  // The workshop opens this version as its own draft: its project file, or the GLB as parts.
  $("#open-workshop").href = `/workshop/?open=${model.id}&version=${version.version}`;
}

async function show(name) {
  version = model.versions.find((entry) => entry.version === name) ?? model.versions[0];
  render();
  const url = new URL(location.href);
  if (version === model.versions[0]) url.searchParams.delete("version"); else url.searchParams.set("version", version.version);
  history.replaceState(null, "", `${url.pathname}${url.search}`);
  if (!viewer) viewer = (await import("./model-viewer.js")).createViewer($("#stage"));
  await viewer.load(blobURL("model.glb", version.files["model.glb"].sha256)).catch(() => { state = "viewerError"; showStatus(); });
}

async function download(name) {
  const file = version.files[name];
  const response = await fetch(blobURL(name, file.sha256), { credentials: "omit" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const extension = name === "source.funmodel.glb" ? "funmodel.glb" : name.split(".").pop();
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(await response.blob()), download: `${model.id}_${version.version}.${extension}` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

$("#copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#address").textContent); $("#status").textContent = t("copied"); }
  catch { $("#status").textContent = t("copyError"); }
});
$("#download-glb").addEventListener("click", () => download("model.glb").catch(() => { $("#status").textContent = t("loadError"); }));
$("#download-blend").addEventListener("click", () => download("source.blend").catch(() => { $("#status").textContent = t("loadError"); }));
$("#download-workshop").addEventListener("click", () => download("source.funmodel.glb").catch(() => { $("#status").textContent = t("loadError"); }));
$("#version").addEventListener("change", (event) => show(event.target.value));

initLocale();
onLocaleChange(render);
showStatus();
try {
  model = id ? await loadModel(id, AbortSignal.timeout(10000)) : null;
  // An unlisted model keeps its page data for games that pinned it, but no public page.
  if (!model || !model.listed) {
    model = null;
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
