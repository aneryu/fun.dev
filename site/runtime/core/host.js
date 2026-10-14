import { createScope } from "./scope.js";

export function createGameHost({ THREE, stage, onState = () => {}, onError = console.error, locale = "en", canvasLabel = "Game canvas. Press Tab to leave", bundleOrigin = window.location.origin }) {
  let currentLocale = locale;
  let currentLabel = canvasLabel;
  let current = null;
  const mobile = window.matchMedia("(max-width: 64rem), (pointer: coarse)");

  function startLoop(session) {
    if (session.loopActive || !session.game || session.paused || session.scope.signal.aborted) return;
    session.previousTime = null;
    session.loopActive = true;
    session.renderer.setAnimationLoop((time) => frame(session, time));
  }

  function stopLoop(session) {
    session.loopActive = false;
    session.renderer?.setAnimationLoop(null);
  }

  function release(session) {
    if (!session || session.scope.signal.aborted) return;
    stopLoop(session);
    const errors = session.scope.dispose();
    if (errors.length) console.error("Game cleanup failed:", errors);
  }

  function fail(session, error) {
    if (session !== current || session.scope.signal.aborted) return;
    release(session);
    onState("error");
    onError(error);
  }

  function syncPlayback(session) {
    if (!session.game || session.scope.signal.aborted) return;
    const paused = session.userPaused || document.hidden;
    if (paused === session.paused) return;
    session.paused = paused;
    session.surface.inert = paused;
    session.previousTime = null;
    try {
      if (paused) {
        stopLoop(session);
        session.game.pause?.();
      } else {
        session.game.resume?.();
        startLoop(session);
      }
      onState(paused ? "paused" : "running");
    } catch (error) { fail(session, error); }
  }

  function frame(session, time) {
    if (session.scope.signal.aborted || session.paused) return;
    const delta = session.previousTime === null ? 0 : Math.min(Math.max((time - session.previousTime) / 1000, 0), 0.05);
    session.previousTime = time;
    session.elapsed += delta;
    try {
      session.invalidated = false;
      const animate = session.game.update?.(delta, session.elapsed);
      session.renderer.render(session.scene, session.camera);
      if (session.game.renderMode === "on-demand" && !animate && !session.invalidated) stopLoop(session);
    } catch (error) { fail(session, error); }
  }

  function resize(session) {
    if (session.scope.signal.aborted) return;
    try {
      const { width, height } = stage.getBoundingClientRect();
      Object.assign(session.viewport, {
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
        pixelRatio: Math.min(window.devicePixelRatio || 1, mobile.matches ? 1.5 : 2),
      });
      const view = session.viewport;
      session.renderer.setPixelRatio(view.pixelRatio);
      session.renderer.setSize(view.width, view.height, false);
      if (session.camera.isPerspectiveCamera) {
        session.camera.aspect = view.width / view.height;
        session.camera.updateProjectionMatrix();
      }
      session.game?.resize?.({ ...view });
      if (session.game) session.renderer.render(session.scene, session.camera);
    } catch (error) { fail(session, error); }
  }

  async function load(entry, { progress, launchReason = "open" } = {}) {
    release(current);
    const scope = createScope();
    if (progress) scope.signal.addEventListener("abort", () => progress.close(), { once: true });
    const session = {
      scope, game: null, renderer: null, paused: null, userPaused: false,
      previousTime: null, elapsed: 0, viewport: {},
    };
    current = session;
    onState("loading");
    const timeout = window.setTimeout(() => fail(session, new Error("Game loading timed out.")), 30000);
    scope.onCleanup(() => window.clearTimeout(timeout));

    try {
      const entryURL = new URL(entry, window.location.href);
      const baseURL = new URL("./", entryURL);
      if (entryURL.origin !== bundleOrigin) throw new Error("Game bundle origin is not allowed.");
      const module = await import(entryURL.href);
      if (scope.signal.aborted) return;
      if (typeof module.createGame !== "function") throw new Error("Bundle must export createGame(context).");

      const surface = document.createElement("div");
      surface.className = "game-surface";
      surface.inert = true;
      session.surface = surface;
      const canvas = document.createElement("canvas");
      canvas.tabIndex = 0;
      canvas.setAttribute("aria-label", currentLabel);
      surface.append(canvas);
      stage.append(surface);
      scope.onCleanup(() => surface.remove());
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: mobile.matches ? "low-power" : "default" });
      session.renderer = renderer;
      scope.onCleanup(() => { renderer.dispose(); renderer.forceContextLoss(); });
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x211f17);
      session.scene = scene;
      scope.onCleanup(() => scene.clear());
      session.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
      session.camera.position.z = 5;

      canvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        fail(session, new Error("The WebGL context was lost. Restart the game."));
      }, { signal: scope.signal });
      const observer = new ResizeObserver(() => resize(session));
      observer.observe(stage);
      scope.onCleanup(() => observer.disconnect());
      window.addEventListener("resize", () => resize(session), { signal: scope.signal });
      document.addEventListener("visibilitychange", () => syncPlayback(session), { signal: scope.signal });
      resize(session);
      if (scope.signal.aborted) return;

      const game = await module.createGame(Object.freeze({
        apiVersion: 1,
        launchReason,
        ...(progress ? { progress: progress.api } : {}),
        get locale() { return currentLocale; },
        THREE, scene, camera: session.camera, renderer, canvas,
        viewport: session.viewport,
        signal: scope.signal,
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        track: scope.track,
        onCleanup: scope.onCleanup,
        invalidate() { session.invalidated = true; startLoop(session); },
        asset(path) {
          const url = new URL(path, baseURL);
          if (!url.href.startsWith(baseURL.href)) throw new Error("Assets must stay inside the game bundle.");
          return url.href;
        },
        setCamera(camera) {
          if (!camera?.isCamera) throw new TypeError("Expected a Three.js camera.");
          session.camera = camera;
        },
      }));

      // A slow createGame may finish after restart, timeout, or leaving the page.
      if (scope.signal.aborted) {
        game?.dispose?.();
        return;
      }
      if (!game || typeof game !== "object") throw new TypeError("createGame must return a lifecycle object.");
      if (typeof game.dispose === "function") scope.onCleanup(() => game.dispose());
      if (game.renderMode !== undefined && !["continuous", "on-demand"].includes(game.renderMode)) throw new TypeError("Invalid renderMode.");
      for (const hook of ["update", "resize", "pause", "resume", "dispose", "localeChanged"]) {
        if (game[hook] !== undefined && typeof game[hook] !== "function") throw new TypeError(`${hook} must be a function.`);
      }
      session.game = game;
      game.localeChanged?.(currentLocale);
      window.clearTimeout(timeout);
      resize(session);
      syncPlayback(session);
      return !scope.signal.aborted;
    } catch (error) { fail(session, error); return false; }
  }

  return {
    load,
    setPaused(paused) {
      if (!current) return;
      current.userPaused = paused;
      syncPlayback(current);
    },
    setLocale(locale, label = currentLabel) {
      currentLocale = locale;
      currentLabel = label;
      if (!current || current.scope.signal.aborted) return;
      current.renderer?.domElement.setAttribute("aria-label", label);
      try { current.game?.localeChanged?.(locale); }
      catch (error) { fail(current, error); }
    },
    dispose() { release(current); current = null; },
  };
}
