import { API_VERSION, bundlePath, compatible, gameText, loadCatalog } from "../catalog.js";
import { getLocale, initLocale, onLocaleChange, t } from "../i18n.js";
import { transferProgress } from "../progress-config.js";
import { ProgressClient } from "../progress/client.js";
import { createProgressUI, progressText } from "../progress/ui.js";
import { registerServiceWorker } from "../pwa.js";

// Connection credentials never enter query strings, requests, analytics, or browser history.
let transferToken = globalThis.__funTransferToken ?? null;
delete globalThis.__funTransferToken;
const $ = (selector) => document.querySelector(selector);
const title = $("#game-title");
const status = $("#player-status");
const message = $("#player-message");
const pause = $("#pause");
const restart = $("#restart");
const resume = $("#resume");
const fullscreen = $("#fullscreen");
const share = $("#share");
const openOptions = $("#open-options");
const errorBack = $("#error-back");
const actionStatus = $("#action-status");
const menuToggle = $("#menu-toggle");
const menu = $("#controls-dialog");
const optionsDialog = $("#options-dialog");
const loadingBar = $("#player-loading");
const announcer = $("#game-announcer");
const header = $(".player-header");
const compact = window.matchMedia("(max-width: 64rem), (pointer: coarse)");
const portrait = window.matchMedia("(orientation: portrait)");
const debug = new URLSearchParams(window.location.search).get("debug") === "1";
let manualPaused = false;
let host;
let game;
let progress;
let progressUI;
let options = null;
let loadingGame = false;
let state = "loading";
let errorKey = null;
let actionErrorKey = null;
let actionKey = null;
let left = false;
let wakeLock = null;
const pageScope = new AbortController();
window.addEventListener("fun-transfer-link", () => {
  const token = globalThis.__funTransferToken;
  delete globalThis.__funTransferToken;
  if (token === undefined) return;
  if (progressUI) progressUI.offer(token);
  else transferToken = token;
});

function readPreference(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writePreference(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Preferences are optional. */ }
}
const audioPreferences = { muted: false, volume: 1, ...readPreference("fun.dev.audio", {}) };
let hapticsEnabled = readPreference("fun.dev.haptics", true) !== false;

// On phones, a game that declares an orientation waits until the device matches it.
function rotateKey() {
  if (!game || !compact.matches || !["portrait", "landscape"].includes(game.orientation)) return null;
  if ((game.orientation === "portrait") === portrait.matches) return null;
  return game.orientation === "portrait" ? "rotatePortrait" : "rotateLandscape";
}

function blocked() {
  return manualPaused || menu.open || optionsDialog.open || !!progressUI?.open || !!progress?.frozen || !!rotateKey();
}
function syncPause() { host?.setPaused(blocked()); }

function renderText() {
  title.textContent = game ? gameText(game.title, getLocale()) : t("playerTitle");
  document.title = `${title.textContent} — fun.dev`;
  $("#game-description").textContent = game ? gameText(game.description, getLocale()) : "";
  pause.disabled = state !== "running" && state !== "paused";
  restart.disabled = !host || !game || state === "loading";
  share.disabled = !game || !!errorKey;
  openOptions.disabled = !host || !!errorKey;
  pause.textContent = t(manualPaused ? "resume" : "pause");
  const rotate = !errorKey && rotateKey();
  message.hidden = state === "running" && !rotate;
  resume.hidden = state !== "paused" || !!rotate;
  errorBack.hidden = !errorKey;
  status.textContent = rotate ? t(rotate) : state === "progress" ? progressText(progress?.status || "loading") : t(errorKey || (state === "paused" ? "paused" : "loading"));
  $("#open-progress-message").hidden = state !== "progress";
  loadingBar.hidden = state !== "loading" || loadingBar.value === 0 && !loadingBar.dataset.reported;
  fullscreen.textContent = t(document.fullscreenElement ? "exitFullscreen" : "fullscreen");
  actionStatus.textContent = actionErrorKey ? t(actionErrorKey) : actionKey ? t(actionKey) : "";
  const howToPlay = game?.howToPlay ? gameText(game.howToPlay, getLocale()) : "";
  $("#how-to-play").hidden = !howToPlay;
  $("#how-to-play-text").textContent = howToPlay;
  renderOptions();
}

function showError(key) {
  state = "error";
  errorKey = key;
  renderText();
}

async function updateWakeLock() {
  const wanted = !!game?.keepAwake && state === "running" && !document.hidden;
  if (wanted && !wakeLock && navigator.wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; }, { once: true });
    } catch { wakeLock = null; }
  } else if (!wanted && wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    await lock.release().catch(() => {});
  }
}

function onState(next) {
  state = next;
  errorKey = null;
  if (next !== "loading") { loadingBar.value = 0; delete loadingBar.dataset.reported; }
  renderText();
  if (next === "running" && blocked()) host?.setPaused(true);
  void updateWakeLock();
}

// Coalesces game announcements so a fast game cannot flood the screen reader.
let pendingAnnouncements = [];
let announceTimer = null;
function announce(text) {
  if (!pendingAnnouncements.includes(text)) pendingAnnouncements.push(text);
  if (announceTimer) return;
  announceTimer = setTimeout(() => {
    announcer.textContent = "";
    const separator = getLocale() === "zh" ? "。" : ". ";
    requestAnimationFrame(() => { announcer.textContent = pendingAnnouncements.slice(-3).join(separator); pendingAnnouncements = []; });
    setTimeout(() => { announceTimer = null; if (pendingAnnouncements.length) announce(pendingAnnouncements.pop()); }, 1000);
  }, 400);
}

function safeArea(rect) {
  const probe = getComputedStyle($(".safe-area-probe"));
  const insets = {
    top: parseFloat(probe.paddingTop) - rect.top,
    right: parseFloat(probe.paddingRight) - (window.innerWidth - rect.right),
    bottom: parseFloat(probe.paddingBottom) - (window.innerHeight - rect.bottom),
    left: parseFloat(probe.paddingLeft) - rect.left,
  };
  if (!menuToggle.hidden) insets.top = Math.max(insets.top, menuToggle.getBoundingClientRect().bottom - rect.top + 8);
  return insets;
}

function closeMenu() {
  if (menu.open) menu.close();
}

menuToggle.addEventListener("click", () => {
  menu.showModal();
  host?.setPaused(true);
});
$("#close-controls").addEventListener("click", closeMenu);
menu.addEventListener("close", () => {
  syncPause();
  if (compact.matches && !optionsDialog.open && !progressUI?.open) menuToggle.focus({ preventScroll: true });
});
menu.addEventListener("click", (event) => { if (event.target === menu) closeMenu(); });
function adaptControls() {
  closeMenu();
  if (compact.matches) menu.append(header);
  else document.body.insertBefore(header, $("#player"));
  menuToggle.hidden = !compact.matches;
  renderText();
  syncPause();
}
compact.addEventListener("change", adaptControls);
portrait.addEventListener("change", () => { renderText(); syncPause(); });
adaptControls();

function optionLabel(option) { return gameText(option.label, getLocale()); }
function renderOptions() {
  for (const section of ["settings", "cheats", "debug"]) {
    const group = $(`#options-${section}`);
    const items = options?.list.filter((option) => section === "debug" ? debug && option.audience === "debug" : option.section === section && option.audience === "player") ?? [];
    group.hidden = items.length === 0;
    const list = group.querySelector(".option-list");
    // Rebuild only when the declarations change; otherwise update values in place to keep focus.
    const signature = items.map((option) => option.id).join();
    if (list.dataset.signature !== signature) {
      list.dataset.signature = signature;
      list.replaceChildren(...items.map(optionControl));
    }
    for (const option of items) updateControl(list.querySelector(`[data-option="${option.id}"]`), option);
  }
}
function optionControl(option) {
  const id = `option-${option.id}`;
  if (option.type === "action") {
    const button = document.createElement("button");
    Object.assign(button, { type: "button", className: "button", id });
    button.dataset.option = option.id;
    button.addEventListener("click", () => host?.setOption(option.id));
    return button;
  }
  const row = document.createElement("label");
  row.className = `option-row${option.type === "range" ? " option-range" : ""}`;
  row.dataset.option = option.id;
  const text = document.createElement("span");
  let input;
  if (option.type === "toggle") {
    input = Object.assign(document.createElement("input"), { type: "checkbox", id });
    input.addEventListener("change", () => host?.setOption(option.id, input.checked));
    row.append(input, text);
  } else if (option.type === "range") {
    input = Object.assign(document.createElement("input"), { type: "range", id, step: option.step });
    const output = document.createElement("output");
    output.htmlFor = id;
    input.addEventListener("change", () => host?.setOption(option.id, Number(input.value)));
    input.addEventListener("input", () => { output.textContent = input.value; });
    row.append(text, input, output);
  } else {
    input = Object.assign(document.createElement("select"), { id });
    input.addEventListener("change", () => host?.setOption(option.id, input.value));
    row.append(text, input);
  }
  return row;
}
function updateControl(node, option) {
  const limits = options.limits[option.id];
  const value = options.values[option.id];
  if (option.type === "action") {
    node.textContent = optionLabel(option);
    node.disabled = limits.disabled;
    return;
  }
  node.querySelector("span").textContent = optionLabel(option);
  const input = node.querySelector("input, select");
  input.disabled = limits.disabled;
  if (option.type === "toggle") input.checked = value;
  if (option.type === "range") {
    Object.assign(input, { min: limits.min, max: limits.max });
    input.value = value;
    node.querySelector("output").textContent = value;
  }
  if (option.type === "choice") {
    if (input.options.length !== option.choices.length) input.replaceChildren(...option.choices.map((choice) => new Option("", choice.value)));
    option.choices.forEach((choice, index) => { input.options[index].textContent = gameText(choice.label, getLocale()); });
    input.value = value;
  }
}

function renderPreferences() {
  $("#pref-mute").checked = audioPreferences.muted;
  $("#pref-volume").value = audioPreferences.volume;
  $("#pref-volume").disabled = audioPreferences.muted;
  $("#pref-haptics").checked = hapticsEnabled;
  $("#pref-haptics").closest("label").hidden = !("vibrate" in navigator);
}
$("#pref-mute").addEventListener("change", (event) => {
  audioPreferences.muted = event.target.checked;
  writePreference("fun.dev.audio", audioPreferences);
  host?.setAudio(audioPreferences);
  renderPreferences();
});
$("#pref-volume").addEventListener("input", (event) => {
  audioPreferences.volume = Number(event.target.value);
  writePreference("fun.dev.audio", audioPreferences);
  host?.setAudio(audioPreferences);
});
$("#pref-haptics").addEventListener("change", (event) => {
  hapticsEnabled = event.target.checked;
  writePreference("fun.dev.haptics", hapticsEnabled);
});
openOptions.addEventListener("click", () => {
  closeMenu();
  host?.setPaused(true);
  renderPreferences();
  renderOptions();
  optionsDialog.showModal();
});
$("#close-options").addEventListener("click", () => optionsDialog.close());
optionsDialog.addEventListener("click", (event) => { if (event.target === optionsDialog) optionsDialog.close(); });
optionsDialog.addEventListener("close", () => {
  syncPause();
  if (!compact.matches) openOptions.focus({ preventScroll: true });
});

async function openGame() {
  try {
    const id = new URLSearchParams(window.location.search).get("game");
    if (!id) { showError("chooseGame"); return; }
    const signal = AbortSignal.any([pageScope.signal, AbortSignal.timeout(10000)]);
    const catalog = await loadCatalog(signal);
    if (left) return;
    game = catalog.find((entry) => entry.id === id);
    if (!game) { showError("missingGame"); return; }
    if (!compatible(game)) { showError(game.apiVersion > API_VERSION ? "platformUpdated" : "gameOutdated"); return; }
    renderText();
    const { createGameHost } = await import("../runtime/host.js");
    if (left) return;
    host = createGameHost({
      stage: $("#game-stage"), onState, safeArea, announce,
      haptics(steps) { if (hapticsEnabled) navigator.vibrate?.(steps); },
      onLoading(fraction) {
        if (fraction === null) { loadingBar.value = 0; delete loadingBar.dataset.reported; }
        else { loadingBar.value = fraction; loadingBar.dataset.reported = "1"; }
        renderText();
      },
      onOptions(next) { options = next; renderOptions(); },
      onError(error) {
        console.error("Unable to run game:", error);
        showError("gameError");
      },
    });
    host.setAudio(audioPreferences);
    progress = new ProgressClient({ gameId: game.id, bundleVersion: game.version, transfers: transferProgress,
      onChange() {
        progressUI?.render();
        if (progress.frozen) { host?.setPaused(true); state = "progress"; }
        renderText();
      },
    });
    progressUI = createProgressUI(progress, { pause() { host?.setPaused(true); }, resume: syncPause, reload: loadWithProgress });
    $("#open-progress").disabled = false;
    if (transferToken !== null) {
      await loadWithProgress();
      progressUI.offer(transferToken);
      transferToken = null;
      renderText();
      return;
    }
    await loadWithProgress();
  } catch (error) {
    if (left) return;
    console.error("Unable to load player:", error);
    showError("playerError");
  }
}

const settingsKey = () => `fun.dev.settings.${game.id}`;
async function loadWithProgress(loadOptions = {}) {
  if (loadingGame || left) return;
  loadingGame = true;
  try {
    host.setPaused(true);
    await progress.freeze();
    await progress.prepare(loadOptions);
    if (left) return;
    if (!progress.prepared) { state = "progress"; errorKey = null; renderText(); return; }
    progress.used = false;
    const loaded = await host.load(bundlePath(game), {
      progress: progress.capability(), launchReason: loadOptions.launchReason || "open",
      settings: { load: () => readPreference(settingsKey(), {}), save: (values) => writePreference(settingsKey(), values) },
    });
    if (loaded && !progress.used) progress.setStatus("unsupported");
  } finally { loadingGame = false; }
}
for (const button of document.querySelectorAll("[data-open-progress]")) button.addEventListener("click", () => {
  closeMenu();
  progressUI?.show();
});

pause.addEventListener("click", () => {
  manualPaused = !manualPaused;
  closeMenu();
  syncPause();
  renderText();
});
resume.addEventListener("click", () => {
  manualPaused = false;
  syncPause();
  renderText();
  document.querySelector(".game-surface canvas")?.focus();
});
restart.addEventListener("click", () => {
  if (!host || !game) return;
  manualPaused = false;
  closeMenu();
  void loadWithProgress({ launchReason: "restart" }).catch(() => showError("gameError"));
});
share.addEventListener("click", async () => {
  if (!game) return;
  const locale = getLocale();
  const text = host?.shareText(locale) || t("shareDefault", gameText(game.title, locale));
  const url = new URL(`/s/${game.id}/${locale === "en" ? "en/" : ""}`, window.location.origin).href;
  actionErrorKey = actionKey = null;
  try {
    if (navigator.share) await navigator.share({ title: gameText(game.title, locale), text, url });
    else { await navigator.clipboard.writeText(`${text} ${url}`); actionKey = "shareCopied"; }
    closeMenu();
  } catch (error) {
    if (error?.name !== "AbortError") actionErrorKey = "shareError";
  }
  renderText();
});
if (document.fullscreenEnabled) fullscreen.hidden = false;
fullscreen.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      await document.body.requestFullscreen();
      // Only some browsers (Android Chrome) can lock orientation, and only in fullscreen.
      if (["portrait", "landscape"].includes(game?.orientation)) await screen.orientation?.lock?.(game.orientation).catch(() => {});
    }
    actionErrorKey = null;
    closeMenu();
  } catch { actionErrorKey = "fullscreenError"; }
  renderText();
});
document.addEventListener("fullscreenchange", () => {
  renderText();
});
window.addEventListener("pagehide", () => {
  left = true;
  pageScope.abort();
  host?.dispose();
  void progress?.close();
  progressUI?.dispose();
  void wakeLock?.release().catch(() => {});
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
let checkingProgress = false;
async function refreshProgress() {
  if (checkingProgress || loadingGame || left || !progress) return;
  checkingProgress = true;
  try {
    if (await progress.resumeCheck()) await loadWithProgress();
  } catch { /* Local progress remains usable; the service displays its status. */ }
  finally { checkingProgress = false; }
}
window.addEventListener("online", () => { void refreshProgress(); });
window.addEventListener("focus", () => { void refreshProgress(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshProgress();
  void updateWakeLock();
});

if (debug) {
  const panel = $("#debug-panel");
  panel.hidden = false;
  setInterval(() => {
    const stats = host?.stats();
    panel.textContent = stats
      ? `fps ${stats.fps}  calls ${stats.calls}  tris ${stats.triangles}\ngeo ${stats.geometries}  tex ${stats.textures}  programs ${stats.programs}  dpr ${stats.pixelRatio.toFixed(2)}`
      : "debug";
  }, 500);
}

initLocale();
onLocaleChange(renderText);
renderText();
renderPreferences();
openGame();
registerServiceWorker();
