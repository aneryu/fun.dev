import { serviceWorker } from "./pwa-config.js";

// Offline play for previously opened games; see sw.js for the caching strategy.
export function registerServiceWorker() {
  if (!serviceWorker || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => { /* Online play does not depend on it. */ });
  // Installed apps ask the browser not to clear cached games under storage pressure. Only then:
  // Firefox shows a permission prompt for it, which a passing visitor should not see.
  if (matchMedia("(display-mode: standalone)").matches) navigator.storage?.persist?.().catch(() => {});
}
