// Owns resources registered during creation, including failed/aborted creation.
export function createScope() {
  const controller = new AbortController();
  const cleanups = [];
  const resources = new WeakSet();
  let disposed = false;

  function onCleanup(callback) {
    if (typeof callback !== "function") throw new TypeError("Cleanup must be a function.");
    if (disposed) callback();
    else cleanups.push(callback);
  }

  function track(resource) {
    if (!resource || typeof resource.dispose !== "function") {
      throw new TypeError("Tracked resources must have dispose().");
    }
    if (!resources.has(resource)) {
      resources.add(resource);
      onCleanup(() => resource.dispose());
    }
    return resource;
  }

  function dispose() {
    if (disposed) return [];
    disposed = true;
    controller.abort();
    const errors = [];
    for (const cleanup of cleanups.reverse()) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    cleanups.length = 0;
    return errors;
  }

  return { signal: controller.signal, track, onCleanup, dispose };
}
