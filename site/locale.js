// Page language: ?lang=zh|en wins, else the first Chinese or English entry in the browser's
// language list, else English. Shared by the homepage and the Studio.
export function detectLocale() {
  if (typeof window === "undefined") return "en";
  const urlLang = new URLSearchParams(window.location.search).get("lang");
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
