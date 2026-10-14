import { bundlePath, gameText, loadCatalog } from "../catalog.js";
import { getLocale, initLocale, onLocaleChange, t } from "../i18n.js";
import { transferProgress } from "../progress-config.js";
import { ProgressClient } from "../progress/client.js";
import { createProgressUI, progressText } from "../progress/ui.js";

// Connection credentials never enter query strings, requests, analytics, or browser history.
let transferToken = globalThis.__funTransferToken ?? null;
delete globalThis.__funTransferToken;
const title = document.querySelector("#game-title");
const status = document.querySelector("#player-status");
const message = document.querySelector("#player-message");
const pause = document.querySelector("#pause");
const restart = document.querySelector("#restart");
const resume = document.querySelector("#resume");
const fullscreen = document.querySelector("#fullscreen");
const errorBack = document.querySelector("#error-back");
const actionStatus = document.querySelector("#action-status");
const menuToggle = document.querySelector("#menu-toggle");
const menu = document.querySelector("#controls-dialog");
const header = document.querySelector(".player-header");
const compact = window.matchMedia("(max-width: 64rem), (pointer: coarse)");
let manualPaused = false;
let host;
let game;
let progress;
let progressUI;
let loadingGame = false;
let state = "loading";
let errorKey = null;
let actionErrorKey = null;
let left = false;
const pageScope = new AbortController();
window.addEventListener("fun-transfer-link", () => {
  const token = globalThis.__funTransferToken;
  delete globalThis.__funTransferToken;
  if (token === undefined) return;
  if (progressUI) progressUI.offer(token);
  else transferToken = token;
});

function renderText() {
  title.textContent = game ? gameText(game.title, getLocale()) : t("playerTitle");
  document.title = `${title.textContent} — fun.dev`;
  document.querySelector("#game-description").textContent = game ? gameText(game.description, getLocale()) : "";
  pause.disabled = state !== "running" && state !== "paused";
  restart.disabled = !host || !game || state === "loading";
  pause.textContent = t(manualPaused ? "resume" : "pause");
  message.hidden = state === "running";
  resume.hidden = state !== "paused";
  errorBack.hidden = !errorKey;
  status.textContent = state === "progress" ? progressText(progress?.status || "loading") : t(errorKey || (state === "paused" ? "paused" : "loading"));
  document.querySelector("#open-progress-message").hidden = state !== "progress";
  fullscreen.textContent = t(document.fullscreenElement ? "exitFullscreen" : "fullscreen");
  actionStatus.textContent = actionErrorKey ? t(actionErrorKey) : "";
}

function showError(key) {
  state = "error";
  errorKey = key;
  renderText();
}

function onState(next) {
  state = next;
  errorKey = null;
  renderText();
  if (next === "running" && (menu.open || progressUI?.open || manualPaused || progress?.frozen)) host?.setPaused(true);
}

function closeMenu() {
  if (menu.open) menu.close();
}

menuToggle.addEventListener("click", () => {
  menu.showModal();
  host?.setPaused(true);
});
document.querySelector("#close-controls").addEventListener("click", closeMenu);
menu.addEventListener("close", () => {
  host?.setPaused(manualPaused || !!progressUI?.open || !!progress?.frozen);
  if (compact.matches) menuToggle.focus({ preventScroll: true });
});
menu.addEventListener("click", (event) => { if (event.target === menu) closeMenu(); });
function adaptControls() {
  closeMenu();
  if (compact.matches) menu.append(header);
  else document.body.insertBefore(header, document.querySelector("#player"));
  menuToggle.hidden = !compact.matches;
}
compact.addEventListener("change", adaptControls);
adaptControls();

async function openGame() {
  try {
    const id = new URLSearchParams(window.location.search).get("game");
    if (!id) { showError("chooseGame"); return; }
    const signal = AbortSignal.any([pageScope.signal, AbortSignal.timeout(10000)]);
    const catalog = await loadCatalog(signal);
    if (left) return;
    game = catalog.find((entry) => entry.id === id);
    if (!game) { showError("missingGame"); return; }
    renderText();
    const { createGameHost } = await import("../runtime/host.js");
    if (left) return;
    host = createGameHost({
      stage: document.querySelector("#game-stage"), onState,
      onError(error) {
        console.error("Unable to run game:", error);
        showError("gameError");
      },
    });
    progress = new ProgressClient({ gameId: game.id, bundleVersion: game.version, transfers: transferProgress,
      onChange() {
        progressUI?.render();
        if (progress.frozen) { host?.setPaused(true); state = "progress"; }
        renderText();
      },
    });
    progressUI = createProgressUI(progress, { pause() { host?.setPaused(true); }, resume() { host?.setPaused(manualPaused || menu.open); }, reload: loadWithProgress });
    document.querySelector("#open-progress").disabled = false;
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

async function loadWithProgress(options = {}) {
  if (loadingGame || left) return;
  loadingGame = true;
  try {
    host.setPaused(true);
    await progress.freeze();
    await progress.prepare(options);
    if (left) return;
    if (!progress.prepared) { state = "progress"; errorKey = null; renderText(); return; }
    progress.used = false;
    const loaded = await host.load(bundlePath(game), { progress: progress.capability(), launchReason: options.launchReason || "open" });
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
  host?.setPaused(manualPaused || !!progress?.frozen || !!progressUI?.open);
  renderText();
});
resume.addEventListener("click", () => {
  manualPaused = false;
  host?.setPaused(!!progress?.frozen || !!progressUI?.open);
  document.querySelector("canvas")?.focus();
});
restart.addEventListener("click", () => {
  if (!host || !game) return;
  manualPaused = false;
  closeMenu();
  void loadWithProgress({ launchReason: "restart" }).catch(() => showError("gameError"));
});
if (document.fullscreenEnabled) fullscreen.hidden = false;
fullscreen.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.body.requestFullscreen();
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
});

initLocale();
onLocaleChange(renderText);
renderText();
openGame();
