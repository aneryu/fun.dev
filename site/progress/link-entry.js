// Scrub private fragments before game code executes, including same-page links.
(() => {
  function capture() {
    const params = new URLSearchParams(location.hash.slice(1));
    if (!params.has("transfer") && !params.has("connect")) return;
    const token = params.get("transfer") || "retired";
    history.replaceState(null, "", location.pathname + location.search);
    Object.defineProperty(globalThis, "__funTransferToken", { value: token, configurable: true });
    window.dispatchEvent(new Event("fun-transfer-link"));
  }
  window.addEventListener("hashchange", capture);
  capture();
})();
