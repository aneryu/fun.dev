import { createViewer } from "../site/model-viewer.js";

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
$("#filter").addEventListener("change", showList);
api("/api/session").then(({ email }) => { $("#who").textContent = email; }).catch(() => {});
showList();
