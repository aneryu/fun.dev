import { WebGPUSDFRuntime } from "./kernel/runtime.js";
import { bathDuckScene } from "./scenes/bath-duck.js";

const UI_TEXT = {
  zh: {
    intro: "做点好玩的东西。",
    openStudio: "Studio ↗",
    unsupported: "当前浏览器或环境未开启 WebGPU，已自动切换为静态小黄鸭海报。",
    ariaHero: "项目介绍",
    ariaStage: "3D 互动舞台",
    ariaCanvas: "互动式 3D 浴缸小黄鸭画布",
    ariaPoster: "小黄鸭静态插画海报",
  },
  en: {
    intro: "Things I make for fun.",
    openStudio: "Studio ↗",
    unsupported: "WebGPU is unavailable in this browser; showing the static rubber duck poster.",
    ariaHero: "Identity",
    ariaStage: "3D Interactive Stage",
    ariaCanvas: "Interactive 3D Bath Duck Canvas",
    ariaPoster: "Rubber duck illustration",
  },
};

const urlParams = new URLSearchParams(window.location.search);

function detectLocale() {
  const urlLang = urlParams.get("lang");
  if (urlLang === "zh" || urlLang === "en") return urlLang;
  const langs =
    Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language || "en"];
  for (const l of langs) {
    const lower = String(l).toLowerCase();
    if (lower.startsWith("zh")) return "zh";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

const canvas = document.querySelector("#sdf-canvas");
const posterFallback = document.querySelector("#poster-fallback");
const posterMessage = document.querySelector("#poster-message");

let locale = detectLocale();

const runtime = new WebGPUSDFRuntime(canvas, {
  onStatus({ state, message }) {
    const t = UI_TEXT[locale];
    if (state === "running" || state === "paused") {
      posterFallback.hidden = true;
    } else if (state === "unsupported") {
      posterFallback.hidden = false;
      posterMessage.textContent = t.unsupported;
      document.body.dataset.sdfReady = "fallback";
    } else if (state === "error") {
      document.body.dataset.sdfReady = "error";
    } else if (state === "lost") {
      posterFallback.hidden = false;
      posterMessage.textContent = message;
    }
  },
});

function applyLocale() {
  locale = detectLocale();
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  const t = UI_TEXT[locale];
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const key = el.dataset.i18n;
    if (t[key]) {
      el.textContent = t[key];
    }
  }
  for (const el of document.querySelectorAll("[data-i18n-aria]")) {
    const key = el.dataset.i18nAria;
    if (t[key]) {
      el.setAttribute("aria-label", t[key]);
    }
  }
}

window.addEventListener("languagechange", () => {
  applyLocale();
});

const motionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
const syncReducedMotion = () => {
  runtime.reducedMotion = motionMedia.matches;
};
motionMedia.addEventListener("change", syncReducedMotion);
syncReducedMotion();

// Boot sequence (pure Mode A Bath Duck, zero CPU voxel baking!)
(async () => {
  applyLocale();
  const ok = await runtime.init();
  if (!ok) return;

  await runtime.loadScene(bathDuckScene, {
    resetCamera: true,
    resetState: true,
    isTrustedDefault: true,
  });

  const deterministicT = urlParams.get("t");
  const startPaused = urlParams.get("paused") === "1" || urlParams.get("paused") === "true";

  if (deterministicT !== null) {
    runtime.setPaused(true);
    await runtime.stepDeterministically(Number(deterministicT) || 0);
    document.body.dataset.sdfReady = "true";
    if (urlParams.get("paused") === "0" || urlParams.get("paused") === "false") {
      runtime.setPaused(false);
      runtime.start();
    }
  } else if (startPaused) {
    runtime.setPaused(true);
    await runtime.renderSingleFrame();
    await runtime.device.queue.onSubmittedWorkDone();
    document.body.dataset.sdfReady = "true";
  } else {
    await runtime.renderSingleFrame();
    await runtime.device.queue.onSubmittedWorkDone();
    document.body.dataset.sdfReady = "true";
    runtime.start();
  }
})();
