import { getLocale, onLocaleChange } from "../i18n.js";
import { assert, snapshot } from "./format.js";
import { decodeLink } from "./transfer.js";
const words = {
  en: {
    title: "My progress", close: "Close", explanation: "Progress stays on this device. Transfer it when you change devices. Keep an exported backup in case browser data is cleared.",
    transfer: "Transfer to another device", transferHelp: "This profile is paused during transfer. Open the private link on your new device within 10 minutes and accept it there.",
    receiveHelp: "Receive this profile and continue here? Your existing local progress will be kept separately in your exports. The old device will stop using the transferred profile.",
    receive: "Receive and continue", decline: "Keep this device's progress", linkLabel: "Private transfer link", copyLink: "Copy link", copied: "Link copied.",
    retry: "Check / retry", cancel: "Cancel transfer", declineIncoming: "Cancel receiving", more: "More options", takeover: "Continue here",
    export: "Export backup", importSave: "Import backup", chooseImport: "Choose a save", importSelected: "Use selected save",
    importConfirm: "Replace this game's local progress with the selected backup? A transferred or uncertain profile will be copied into a new local profile.",
    reset: "Reset this game's progress", resetConfirm: "Delete this game's current local progress? Export a backup first if you need it.",
    clear: "Clear this profile's local data", clearConfirm: "Delete this profile's local saves and backups? This cannot be undone.",
    newIdentity: "Start a new local profile", newConfirm: "Start a new, empty local profile? Existing saves remain available in exports.",
    legacy: "Previous local saves and alternate versions have been preserved. Export a backup to inspect or import them; there is no cloud synchronization.",
    done: "Done.", failed: "Could not complete this action. Your local data remains; retry or export a backup.",
    active: "Ready to continue", legacy_unknown: "An old cloud save could not be confirmed. Export local data; explicitly reset or import this game before continuing.",
    loading: "Loading progress…", local: "Saved on this device", unsupported: "This game does not use automatic saves yet.",
    outgoing: "Transfer pending · this profile is paused", incoming: "Receiving · checking the handoff", moved: "Transferred · the old profile is read-only",
    receive_prompt: "Receive a profile", profile_frozen: "This profile is paused for transfer. Check its status before continuing.",
    identity_mismatch: "This profile changed in another tab. Reload to check its status.", writer_busy: "This game is open in another tab.", writer_changed: "This game continued in another tab. Choose Continue here to take over.",
    unavailable: "Progress is not saved · browser storage is unavailable", storage_unavailable: "Browser storage is unavailable. Export a backup before leaving.",
    transfer_unavailable: "Transfer service is unavailable. Local data is retained; retry when online.",
    transfer_unknown: "The handoff result is unknown. This profile stays read-only; retry or export into a new profile.",
    invalid_transfer: "This link is invalid or no longer supported. Request a new transfer from the old device.",
    transfer_taken: "Another device has claimed this transfer. You can cancel receiving to keep your previous profile.",
    transfer_expired: "This transfer has expired. Check its status on the old device.",
    transfer_mismatch: "The transfer could not be verified. Local data is retained.",
    invalid_snapshot: "This save could not be read. Export a backup before resetting it.", newer_schema: "This save needs a newer game version.",
    save_too_large: "The save or transfer exceeds the size limit. Export a backup; no games have been omitted.",
    relay_full: "The transfer service is full. Local data is retained; cancel or try later.", rate_limited: "Too many requests. Try again in a minute.",
  },
  zh: {
    title: "我的进度", close: "关闭", explanation: "进度保存在当前设备，换设备时再转移。建议导出备份，防止清理浏览器数据后丢失。",
    transfer: "转移到新设备", transferHelp: "转移期间这个账号暂停游玩。请在 10 分钟内，用新设备打开私密链接并接收。",
    receiveHelp: "接收这个账号并在此继续？本机原有进度会独立保留，可通过导出找回。旧设备将停止使用转移的账号。",
    receive: "接收并继续", decline: "继续本机进度", linkLabel: "私密转移链接", copyLink: "复制链接", copied: "链接已复制。",
    retry: "检查 / 重试", cancel: "取消转移", declineIncoming: "取消接收", more: "更多选项", takeover: "在此继续",
    export: "导出备份", importSave: "导入备份", chooseImport: "选择存档", importSelected: "使用所选存档",
    importConfirm: "使用所选备份替换这个游戏的本机进度？已转移或结果不明的账号会复制为新的本机账号。",
    reset: "清空这个游戏的进度", resetConfirm: "删除这个游戏当前的本机进度？如有需要，请先导出备份。",
    clear: "清理这个账号的本机数据", clearConfirm: "删除这个账号的本机存档和备份？此操作无法撤销。",
    newIdentity: "新建本机账号", newConfirm: "新建一个空的本机账号？原有存档仍可通过导出找回。",
    legacy: "旧版本机存档与不同版本的副本已保留，可导出查看或导入；现在不再进行云端同步。",
    done: "已完成。", failed: "操作未完成，本机数据仍保留。请重试或导出备份。",
    active: "可以继续游玩", legacy_unknown: "旧版云存档尚未确认。请先导出本机数据，再明确清空或导入这个游戏的存档后继续。",
    loading: "正在读取进度…", local: "已保存在本机", unsupported: "这个游戏尚未使用自动存档。",
    outgoing: "等待转移 · 这个账号已暂停", incoming: "正在接收 · 确认交接结果", moved: "已转移 · 旧账号只读",
    receive_prompt: "接收账号", profile_frozen: "这个账号因转移而暂停，请先检查转移状态。",
    identity_mismatch: "其他标签页更改了账号，请重新加载检查状态。", writer_busy: "这个游戏正在另一个标签页打开。", writer_changed: "游戏已在另一个标签页继续，选择「在此继续」可切换回来。",
    unavailable: "进度尚未保存 · 无法使用浏览器存储", storage_unavailable: "无法使用浏览器存储，请在离开前导出备份。",
    transfer_unavailable: "转移服务暂不可用。本机数据仍保留，请联网后重试。",
    transfer_unknown: "暂时无法确认交接结果。这个账号保持只读，可重试或导出为新的本机账号。",
    invalid_transfer: "链接无效或不再支持，请在旧设备重新发起转移。",
    transfer_taken: "另一台设备已领取这次转移。可以取消接收，继续本机原有进度。",
    transfer_expired: "转移已过期，请在旧设备检查状态。", transfer_mismatch: "无法验证转移内容，本机数据仍保留。",
    invalid_snapshot: "无法读取这份存档，清空前请先导出。", newer_schema: "这份存档需要更新的游戏版本。",
    save_too_large: "存档或转移包超过大小限制，请导出备份；没有跳过任何游戏。",
    relay_full: "转移服务容量已满。本机数据仍保留，可取消或稍后重试。", rate_limited: "请求过于频繁，请在一分钟后重试。",
  },
};
export function progressText(key) { return words[getLocale()][key] || words[getLocale()].failed; }
export function createProgressUI(client, { pause, resume, reload }) {
  const dialog = document.createElement("dialog"); dialog.className = "progress-dialog"; dialog.setAttribute("aria-labelledby", "progress-title");
  dialog.innerHTML = `
    <div class="controls-heading"><h2 id="progress-title" data-text="title"></h2><button type="button" class="close-controls" data-action="close" data-label="close">×</button></div>
    <p id="progress-status" role="status" aria-live="polite"></p><p class="muted" data-text="explanation"></p>
    <p id="progress-legacy" class="muted" data-text="legacy" hidden></p>
    <section id="progress-receive" hidden><p data-text="receiveHelp"></p><div class="progress-buttons"><button class="button" data-action="receive" data-text="receive"></button><button class="button" data-action="decline" data-text="decline"></button></div></section>
    <button class="button" data-action="transfer" data-text="transfer"></button>
    <section id="progress-link" hidden><label for="progress-link-value" data-text="linkLabel"></label><textarea id="progress-link-value" readonly rows="4" spellcheck="false"></textarea><p class="muted" data-text="transferHelp"></p><button class="button" data-action="copyLink" data-text="copyLink"></button></section>
    <div class="progress-buttons"><button class="button" data-action="retry" data-text="retry"></button><button class="button" data-action="cancel" data-text="cancel" hidden></button><button class="button" data-action="declineIncoming" data-text="declineIncoming" hidden></button><button class="button" data-action="takeover" data-text="takeover" hidden></button></div>
    <p id="progress-action-status" role="status" aria-live="polite"></p>
    <details id="progress-more"><summary data-text="more"></summary>
      <div class="progress-buttons"><button class="button" data-action="export" data-text="export"></button><label class="button progress-file"><span data-text="importSave"></span><input id="progress-file" type="file" accept="application/json,.json"></label></div>
      <div id="progress-import-choice" hidden><label for="progress-import-select" data-text="chooseImport"></label><select id="progress-import-select"></select><button class="button" data-action="importSelected" data-text="importSelected"></button></div>
      <div class="progress-buttons"><button class="button" data-action="newIdentity" data-text="newIdentity"></button><button class="button" data-action="reset" data-text="reset"></button><button class="button" data-action="clear" data-text="clear"></button></div>
    </details>`;
  document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector), text = progressText;
  let busy = false, offered = null, imports = [], actionKey = null;
  function render() {
    for (const node of dialog.querySelectorAll("[data-text]")) node.textContent = text(node.dataset.text);
    for (const node of dialog.querySelectorAll("[data-label]")) node.setAttribute("aria-label", text(node.dataset.label));
    $("#progress-status").textContent = text(offered ? "receive_prompt" : client.status);
    $("#progress-action-status").textContent = actionKey ? text(actionKey) : "";
    $("#progress-legacy").hidden = !client.identity?.legacy;
    $("#progress-receive").hidden = !offered;
    const pending = !!client.identity?.pending, active = client.identity?.state === "active";
    for (const button of dialog.querySelectorAll("button")) button.disabled = busy;
    $("[data-action=receive]").disabled = busy || !client.local || !client.transfers || !!client.identity?.pending;
    $("[data-action=transfer]").hidden = !client.transfers || !!offered || pending || client.identity?.state === "moved";
    $("[data-action=transfer]").disabled = busy || !client.local || !active || client.frozen;
    $("[data-action=cancel]").hidden = client.identity?.state !== "outgoing";
    $("[data-action=declineIncoming]").hidden = client.identity?.state !== "incoming" || !!client.identity?.pending?.staged;
    $("[data-action=takeover]").hidden = !["writer_busy", "writer_changed"].includes(client.status);
    $("[data-action=retry]").hidden = !!offered || ["local", "unsupported"].includes(client.status);
    for (const name of ["reset", "clear", "newIdentity"]) $("[data-action=" + name + "]").disabled = busy || !client.local || (pending && client.status !== "transfer_unknown") || (name === "reset" && !active);
    $("#progress-file").disabled = busy || !client.local || (pending && client.status !== "transfer_unknown");
    const link = client.link(); $("#progress-link").hidden = !link;
    if (link) { const url = new URL(`/games/${encodeURIComponent(client.gameId)}`, location.origin); url.searchParams.set("lang", getLocale()); url.hash = `transfer=${link}`; $("#progress-link-value").value = url.href; }
    if (["writer_busy", "writer_changed", "moved", "transfer_unknown", "legacy_unknown"].includes(client.status)) $("#progress-more").open = true;
    for (const node of document.querySelectorAll("[data-open-progress]")) {
      node.textContent = text("title") + (!["local", "loading", "unsupported"].includes(client.status) ? " !" : "");
      node.setAttribute("aria-label", `${text("title")} · ${text(client.status)}`);
    }
  }
  async function action(task, quiet = false) {
    if (busy) return; busy = true; if (!quiet) actionKey = null; render();
    try { await task(); if (!quiet) actionKey ||= "done"; }
    catch (error) { actionKey = error.code || "failed"; if (client.identity?.pending) client.setStatus(error.code || "transfer_unavailable"); }
    finally { busy = false; render(); }
  }
  function download(data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "fun-dev-progress.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function retry() { await reload(); }
  const actions = {
    close: () => dialog.close(),
    transfer: async () => { await client.createTransfer(); try { await navigator.clipboard.writeText($("#progress-link-value").value); actionKey = "copied"; } catch { /* The selectable link remains visible. */ } },
    copyLink: async () => { await navigator.clipboard.writeText($("#progress-link-value").value); actionKey = "copied"; },
    receive: async () => { const link = offered; offered = null; await client.acceptTransfer(link); await reload(); dialog.close(); },
    decline: async () => { offered = null; await reload(); dialog.close(); },
    retry, cancel: async () => { await client.cancelTransfer(); await reload(); }, declineIncoming: async () => { await client.declineIncoming(); await reload(); },
    takeover: () => reload({ takeover: true }),
    export: async () => download(await client.exportData()),
    reset: async () => { if (confirm(text("resetConfirm"))) { await client.reset(); await reload(); } },
    clear: async () => { if (confirm(text("clearConfirm"))) { await client.clearDevice(); await reload(); } },
    newIdentity: async () => { if (confirm(text("newConfirm"))) { await client.newIdentity(); await reload(); } },
    importSelected: async () => { if (confirm(text("importConfirm"))) { await client.importSnapshot(imports[Number($("#progress-import-select").value)].snapshot); await reload(); $("#progress-import-choice").hidden = true; } },
  };
  dialog.addEventListener("click", event => { const button = event.target.closest("[data-action]"); if (button) void action(actions[button.dataset.action]); });
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { if (offered) { offered = null; void action(retry); } else if (!client.frozen) resume(); });
  $("#progress-file").addEventListener("change", event => {
    const file = event.target.files[0];
    if (file) void action(async () => {
      assert(file.size <= 32 * 1024 * 1024, "save_too_large"); const data = JSON.parse(await file.text());
      assert(data.format === "fun.dev.progress" && data.version === 1 && Array.isArray(data.saves), "invalid_snapshot");
      imports = [...data.saves, ...(data.alternatives || []), ...(data.cloud?.saves || []), ...(data.cloud?.alternatives || [])].filter(item => item.gameId === client.gameId && item.snapshot);
      assert(imports.length && imports.length < 1000, "invalid_snapshot");
      imports = imports.map(item => ({ snapshot: snapshot(item.snapshot), updatedAt: item.updatedAt }));
      const select = $("#progress-import-select"); select.replaceChildren();
      imports.forEach((item, index) => { const option = document.createElement("option"); option.value = index; option.textContent = `${text("chooseImport")} ${index + 1} · v${item.snapshot.schemaVersion}${Number.isFinite(item.updatedAt) ? ` · ${new Date(item.updatedAt).toLocaleString(getLocale())}` : ""}`; select.append(option); });
      $("#progress-import-choice").hidden = false; event.target.value = "";
    });
  });
  const timer = setInterval(() => {
    if (!dialog.open || document.hidden || !client.identity?.pending || busy || ["rate_limited", "transfer_unknown"].includes(client.status)) return;
    void action(async () => { await client.resumeTransfer(); if (client.identity.state === "active") await reload(); }, true);
  }, 5000);
  const unsubscribe = onLocaleChange(render); render();
  const show = () => { pause(); render(); if (!dialog.open) dialog.showModal(); };
  return { render, get open() { return dialog.open; }, show,
    offer(link) { actionKey = null; try { decodeLink(link); offered = link; } catch { offered = null; client.setStatus("invalid_transfer"); } show(); },
    dispose() { clearInterval(timer); unsubscribe(); dialog.remove(); },
  };
}
