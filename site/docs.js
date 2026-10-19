import { initLocale } from "./i18n.js";
import { registerServiceWorker } from "./pwa.js";

// /docs: how agents use the workshop; static text in both languages.
initLocale();
registerServiceWorker();
