import { createViewer } from "../site/model-viewer.js";
import { inspectVersion } from "../server/model-rules.js";
import { groupVersions, readZip } from "./zip.js";

// The review console (docs/models.md). It talks only to its own Worker; Access signs requests in.
const $ = (selector) => document.querySelector(selector);
const api = async (path, { method = "GET", body } = {}) => {
  const response = await fetch(path, {
    method, credentials: "same-origin",
    headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Fun-Console": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
  return data;
};
const file = (id, version, name) => `/files/${id}/${version}/${encodeURIComponent(name)}`;
const element = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
let viewer = null, current = null;

// Checks against the production spec: standing on y = 0, centred on x and z.
function warnings(stats) {
  if (!stats) return ["还没有 model.glb"];
  const list = [];
  if (Math.abs(stats.min[1]) > 0.001) list.push(`底部在 y = ${stats.min[1]} m，不在地面上`);
  for (const [axis, index] of [["x", 0], ["z", 2]]) {
    const center = (stats.min[index] + stats.max[index]) / 2;
    if (Math.abs(center) > 0.01) list.push(`${axis} 方向中心偏移 ${center.toFixed(3)} m`);
  }
  if (stats.triangles > 50000) list.push(`${stats.triangles} 个三角形，偏多`);
  return list;
}
const STATUS = { incomplete: "未传完", pending: "待审", approved: "已通过", rejected: "已退回" };
const size = (stats) => stats ? stats.size.map((value) => value.toFixed(2)).join(" × ") + " m" : "—";

function showTab(name) {
  $("#tab-review").setAttribute("aria-pressed", String(name === "review"));
  $("#tab-upload").setAttribute("aria-pressed", String(name === "upload"));
  $("#upload-view").hidden = name !== "upload";
  if (name === "review") showList(); else { $("#list-view").hidden = true; $("#detail-view").hidden = true; }
}

// ── Upload: the same checks as the server, then the console's upload routes ──
let prepared = [];
const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function renderChecks() {
  $("#upload-rows").replaceChildren(...prepared.map((item) => {
    const ok = !item.problems.length;
    const size = item.stats ? ` · ${item.stats.size.map((value) => value.toFixed(2)).join(" × ")} m · ${item.stats.triangles} 三角形` : "";
    const lines = [element("strong", { textContent: `${ok ? "✓" : "✗"} ${item.id} ${item.version}` }), element("span", { className: "muted", textContent: `${item.meta?.type ?? ""}${item.meta?.kit ? ` · ${item.meta.kit}` : ""}${size}${item.result ? ` · ${item.result}` : ""}` })];
    for (const text of item.problems) lines.push(element("div", { className: "bad", textContent: text }));
    for (const text of item.warnings) lines.push(element("div", { className: "bad", textContent: `提醒：${text}` }));
    return element("li", {}, ...lines);
  }));
  const ready = prepared.filter((item) => !item.problems.length && (!item.result || item.retry));
  $("#upload-start").hidden = !ready.length;
  $("#upload-start").textContent = `上传 ${ready.length} 个通过检查的版本`;
}

async function prepare(files) {
  $("#upload-status").textContent = "读取中…";
  try {
    const entries = [];
    for (const file of files) {
      if (file.name.toLowerCase().endsWith(".zip")) entries.push(...await readZip(file));
      else entries.push({ path: file.webkitRelativePath || file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    prepared = groupVersions(entries).map((version) => ({ ...version, ...inspectVersion(version), result: null }));
    const bad = prepared.filter((item) => item.problems.length).length;
    $("#upload-status").textContent = prepared.length ? `找到 ${prepared.length} 个版本，${prepared.length - bad} 个通过检查${bad ? `，${bad} 个没通过（不会上传）` : ""}。` : "没有找到 <id>/<version>/ 文件夹。";
  } catch (error) {
    prepared = [];
    $("#upload-status").textContent = `读取失败：${error.message}`;
  }
  renderChecks();
}

async function uploadOne(item) {
  const base = `/api/upload/${item.id}/${item.version}`;
  const current = await api(base);
  if (current?.status === "approved") return "已通过，跳过";
  await api(base, { method: "PUT", body: item.meta });
  let sent = 0;
  for (const file of item.files) {
    if (current?.files?.[file.name]?.sha256 === hex(await crypto.subtle.digest("SHA-256", file.bytes))) continue;
    const response = await fetch(`${base}/${file.name}`, { method: "PUT", credentials: "same-origin", headers: { "X-Fun-Console": "1" }, body: file.bytes });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${file.name}: ${data.detail || data.error || response.status}`);
    sent++;
  }
  const status = await api(base);
  return `${{ pending: "待审", incomplete: "未传完", rejected: "已退回" }[status.status] ?? status.status}（传了 ${sent} 个文件）`;
}

async function uploadAll() {
  $("#upload-start").disabled = true;
  const ready = prepared.filter((item) => !item.problems.length && (!item.result || item.retry));
  let done = 0, failed = 0;
  for (const item of ready) {
    $("#upload-status").textContent = `上传中 ${done + failed + 1}/${ready.length}：${item.id} ${item.version}`;
    try { item.result = await uploadOne(item); item.retry = false; done++; }
    catch (error) { item.result = `失败：${error.message}`; item.retry = true; failed++; }
    renderChecks();
  }
  $("#upload-status").textContent = `完成：${done} 个成功${failed ? `，${failed} 个失败（可再点一次上传重试）` : ""}。到“审核”里查看。`;
  renderChecks();
  $("#upload-start").disabled = false;
}

async function showList() {
  $("#detail-view").hidden = true;
  $("#list-view").hidden = false;
  $("#list-status").textContent = "加载中…";
  try {
    const { versions } = await api(`/api/versions?status=${$("#filter").value}`);
    $("#rows").replaceChildren(...versions.map((item) => {
      const problems = warnings(item.stats);
      const row = element("button", { className: "row", type: "button" },
        element("img", { src: item.files["preview.png"] ? file(item.id, item.version, "preview.png") : "", alt: "", loading: "lazy" }),
        element("span", {},
          element("strong", { textContent: item.name ? `${item.name.zh} · ${item.name.en}` : "（没有名字）" }),
          element("span", { className: "muted", textContent: `${item.id} ${item.version} · ${item.type ?? "未填类别"} · ${size(item.stats)} · ${item.stats?.triangles ?? "—"} 三角形${item.kit ? ` · ${item.kit}` : ""}` }),
          ...(problems.length ? [element("span", { className: "muted warn", textContent: ` · ${problems.length} 个问题` })] : [])));
      row.addEventListener("click", () => showModel(item.id, item.version));
      return element("li", {}, row);
    }));
    $("#list-status").textContent = versions.length ? `${versions.length} 个` : "没有";
  } catch (error) {
    $("#list-status").textContent = `加载失败：${error.message}`;
  }
}

async function showModel(id, version) {
  $("#list-view").hidden = true;
  $("#detail-view").hidden = false;
  $("#detail-status").textContent = "加载中…";
  const model = await api(`/api/models/${id}`);
  const entry = model.versions.find((item) => item.version === version) ?? model.versions[0];
  current = { model, entry };
  $("#detail-title").textContent = `${model.name?.zh ?? id} · ${id} ${entry.version}`;
  const stats = entry.stats;
  $("#stats").replaceChildren(...[
    ["状态", STATUS[entry.status]],
    ["尺寸 x × y × z", size(stats)],
    ["最低点 y", stats ? `${stats.min[1]} m` : "—"],
    ["三角形", stats?.triangles ?? "—"],
    ["GLB", stats ? `${Math.round(stats.bytes / 1024)} KB` : "—"],
    ["更新", new Date(entry.updated).toLocaleString("zh-CN")],
  ].map(([term, value]) => element("div", {}, element("dt", { textContent: term }), element("dd", { textContent: String(value) }))));
  $("#warnings").replaceChildren(...warnings(stats).map((text) => element("li", { textContent: text })));
  $("#note").hidden = !entry.note;
  $("#note").textContent = entry.note ? `退回原因：${entry.note}` : "";
  $("#files").replaceChildren(...Object.entries(entry.files).map(([name, info]) =>
    element("li", {}, element("a", { href: file(id, entry.version, name), target: "_blank", rel: "noopener", textContent: name }), ` ${Math.ceil(info.size / 1024)} KB`)));
  $("#versions").replaceChildren(...model.versions.map((item) => {
    const link = element("a", { href: "#", textContent: `${item.version} · ${STATUS[item.status]}` });
    link.addEventListener("click", (event) => { event.preventDefault(); showModel(id, item.version); });
    return element("li", {}, link);
  }));
  const form = $("#edit");
  form.zh.value = model.name?.zh ?? "";
  form.en.value = model.name?.en ?? "";
  form.type.value = model.type ?? "";
  form.kit.value = model.kit ?? "";
  form.tags.value = model.tags.join(", ");
  form.listed.checked = model.listed;
  $("#review").hidden = entry.status !== "pending";
  $("#review-version").textContent = entry.version;
  $("#reject-note").value = "";
  $("#detail-status").textContent = "";
  scrollTo(0, 0);
  if (entry.files["model.glb"]) {
    viewer ??= createViewer($("#stage"));
    viewer.load(file(id, entry.version, "model.glb")).catch((error) => { $("#detail-status").textContent = `模型加载失败：${error.message}`; });
  }
}

async function act(task, done) {
  const buttons = document.querySelectorAll("#detail-view button");
  for (const button of buttons) button.disabled = true;
  try {
    await task();
    $("#detail-status").textContent = done;
  } catch (error) {
    $("#detail-status").textContent = `失败：${error.message}`;
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

$("#edit").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target, { id } = current.model;
  act(async () => {
    await api(`/api/models/${id}`, { method: "PATCH", body: {
      name: { zh: form.zh.value, en: form.en.value }, type: form.type.value, kit: form.kit.value.trim(),
      tags: form.tags.value.split(/[,，\s]+/).map((tag) => tag.trim().toLowerCase()).filter(Boolean), listed: form.listed.checked,
    } });
    await showModel(id, current.entry.version);
  }, "已保存");
});
$("#approve").addEventListener("click", () => act(async () => {
  await api(`/api/models/${current.model.id}/${current.entry.version}/approve`, { method: "POST", body: {} });
  await showModel(current.model.id, current.entry.version);
}, "已通过并发布"));
$("#reject").addEventListener("click", () => act(async () => {
  await api(`/api/models/${current.model.id}/${current.entry.version}/reject`, { method: "POST", body: { note: $("#reject-note").value } });
  await showModel(current.model.id, current.entry.version);
}, "已退回"));
$("#back").addEventListener("click", showList);
$("#tab-review").addEventListener("click", () => showTab("review"));
$("#tab-upload").addEventListener("click", () => showTab("upload"));
for (const input of [$("#zip-input"), $("#folder-input")]) input.addEventListener("change", () => { if (input.files.length) prepare([...input.files]); input.value = ""; });
$("#upload-start").addEventListener("click", uploadAll);
$("#filter").addEventListener("change", showList);
api("/api/session").then(({ email }) => { $("#who").textContent = email; }).catch(() => {});
showList();
