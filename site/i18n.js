export const messages = {
  zh: {
    language: "语言", languageAuto: "自动",
    home: "fun.dev 首页", skip: "跳到游戏", games: "游戏", gameList: "游戏列表",
    description: "fun.dev — 做着玩的小游戏，点开就玩。",
    search: "搜索", searchPlaceholder: "搜索游戏", category: "分类", allCategories: "全部分类",
    random: "随便玩", play: "开始玩", empty: "游戏即将上线。", noResults: "没有找到游戏。",
    clear: "清除筛选", loadError: "加载失败，请重试。", retry: "重试", loading: "加载中…",
    count: (count) => `${count} 款游戏`, matches: (count) => `找到 ${count} 款`,
    mobile: "手机", desktop: "电脑", playerTitle: "开玩", back: "← 游戏",
    controls: "游戏控制", menu: "游戏菜单", closeMenu: "关闭菜单", pause: "暂停", resume: "继续", restart: "重开", fullscreen: "全屏",
    exitFullscreen: "退出全屏", paused: "已暂停", gameArea: "游戏区域",
    canvas: "游戏画面，按 Tab 离开游戏区域", errorBack: "返回游戏",
    chooseGame: "请先选择游戏。", missingGame: "游戏不存在。",
    gameError: "游戏出错，请重开。", playerError: "加载失败，请刷新。",
    fullscreenError: "无法进入全屏。",
    options: "选项", closeOptions: "关闭选项", howToPlay: "怎么玩", soundHaptics: "声音与震动", mute: "静音", volume: "音量",
    haptics: "震动反馈", settings: "设置", cheats: "秘籍", debugOptions: "调试", share: "分享", shareCopied: "分享链接已复制。",
    shareError: "无法分享，请手动复制地址。", rotatePortrait: "请把设备竖过来。", rotateLandscape: "请把设备横过来。",
    myProgress: "我的进度", platformUpdated: "fun.dev 已更新，请刷新页面。", gameOutdated: "这个游戏正在升级，请稍后再来。", loadingProgress: "加载进度",
    shareDefault: (title) => `来 fun.dev 玩「${title}」`,
    recordVideo: "录制视频", stopRecording: "停止录制", stop: "停止", recordingTime: (time) => `正在录制 ${time}，点击停止`,
    recordDone: "录好了", recordShare: "分享视频", recordSave: "保存视频", recordDiscard: "不要了",
    recordNote: (time) => `${time} · 视频只在这台设备上，关掉就没了。`, recordError: "录制失败。", recordShareError: "无法分享，请先保存视频。",
  },
  en: {
    language: "Language", languageAuto: "Auto",
    home: "fun.dev home", skip: "Skip to games", games: "Games", gameList: "Game list",
    description: "fun.dev — Little games, made for fun.",
    search: "Search", searchPlaceholder: "Search games", category: "Category", allCategories: "All categories",
    random: "Surprise me", play: "Play", empty: "Games coming soon.", noResults: "No games found.",
    clear: "Clear filters", loadError: "Couldn't load games. Try again.", retry: "Retry", loading: "Loading…",
    count: (count) => `${count} game${count === 1 ? "" : "s"}`, matches: (count) => `${count} found`,
    mobile: "Mobile", desktop: "Desktop", playerTitle: "Play", back: "← Games",
    controls: "Game controls", menu: "Game menu", closeMenu: "Close menu", pause: "Pause", resume: "Resume", restart: "Restart", fullscreen: "Fullscreen",
    exitFullscreen: "Exit fullscreen", paused: "Paused", gameArea: "Game area",
    canvas: "Game canvas. Press Tab to leave the game area", errorBack: "Back to games",
    chooseGame: "Choose a game first.", missingGame: "Game not found.",
    gameError: "Something went wrong. Restart the game.", playerError: "Couldn't load the game. Reload to retry.",
    fullscreenError: "Fullscreen unavailable.",
    options: "Options", closeOptions: "Close options", howToPlay: "How to play", soundHaptics: "Sound & haptics", mute: "Mute", volume: "Volume",
    haptics: "Haptic feedback", settings: "Settings", cheats: "Cheats", debugOptions: "Debug", share: "Share", shareCopied: "Share link copied.",
    shareError: "Couldn't share. Copy the address instead.", rotatePortrait: "Turn your device to portrait.", rotateLandscape: "Turn your device to landscape.",
    myProgress: "My progress", platformUpdated: "fun.dev has been updated. Reload the page.", gameOutdated: "This game is being updated. Try again later.", loadingProgress: "Loading progress",
    shareDefault: (title) => `Play ${title} on fun.dev`,
    recordVideo: "Record video", stopRecording: "Stop recording", stop: "Stop", recordingTime: (time) => `Recording ${time}, select to stop`,
    recordDone: "Your clip", recordShare: "Share video", recordSave: "Save video", recordDiscard: "Discard",
    recordNote: (time) => `${time} · The video stays on this device and is gone once you close this.`, recordError: "Recording failed.", recordShareError: "Couldn't share. Save the video instead.",
  },
};

export function chooseLocale(query, saved, languages = []) {
  if (query === "zh" || query === "en") return query;
  if (saved === "zh" || saved === "en") return saved;
  for (const language of languages) {
    const code = language.toLowerCase().split(/[-_]/)[0];
    if (code === "zh" || code === "en") return code;
  }
  return "en";
}

function savedLocale() {
  try { return globalThis.localStorage?.getItem("fun.dev.language"); }
  catch { return null; }
}

const queryLocale = new URLSearchParams(globalThis.location?.search).get("lang");
const saved = savedLocale();
let preference = ["zh", "en"].includes(queryLocale) ? queryLocale : ["zh", "en"].includes(saved) ? saved : "auto";
let locale = chooseLocale(preference, null, globalThis.navigator?.languages);
const listeners = new Set();

export const getLocale = () => locale;
export function t(key, value) {
  const message = messages[locale][key];
  return typeof message === "function" ? message(value) : message;
}

export function languagePath(path, language = preference) {
  const url = new URL(path, "https://local.invalid");
  if (language === "zh" || language === "en") url.searchParams.set("lang", language);
  else url.searchParams.delete("lang");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function translatePage() {
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  delete document.documentElement.dataset.i18nPending;
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const [attribute, dataset] of [["aria-label", "i18nAria"], ["placeholder", "i18nPlaceholder"], ["content", "i18nContent"]]) {
    const selector = `data-${dataset.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    for (const node of document.querySelectorAll(`[${selector}]`)) node.setAttribute(attribute, t(node.dataset[dataset]));
  }
  for (const link of document.querySelectorAll("a[data-language-link]")) {
    link.setAttribute("href", languagePath(link.getAttribute("href")));
  }
  const toggle = document.querySelector("#language-toggle");
  toggle.value = preference;
}

export function initLocale() {
  translatePage();
  const toggle = document.querySelector("#language-toggle");
  toggle.hidden = false;
  function applyPreference() {
    locale = chooseLocale(preference, null, navigator.languages);
    translatePage();
    for (const listener of listeners) listener(locale);
  }
  toggle.addEventListener("change", () => {
    preference = toggle.value;
    try {
      if (preference === "auto") localStorage.removeItem("fun.dev.language");
      else localStorage.setItem("fun.dev.language", preference);
    } catch { /* Preferences are optional. */ }
    history.replaceState(null, "", languagePath(window.location.href));
    applyPreference();
  });
  window.addEventListener("languagechange", () => {
    if (preference === "auto") applyPreference();
  });
}
