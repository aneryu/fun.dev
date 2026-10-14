import { serviceWorker } from "./pwa-config.js";

// Offline play for previously opened games; see sw.js for the caching strategy.
export function registerServiceWorker() {
  if (!serviceWorker || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => { /* Online play does not depend on it. */ });
}
