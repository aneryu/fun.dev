import { createScope } from "./scope.js";
import { createAudioHub } from "./audio.js";
import { coerce, createOptionState, settingsOf, validateOptions } from "./options.js";

export const API_VERSION = 2;
const hooks = ["update", "resize", "pause", "resume", "dispose", "localeChanged", "optionChanged", "shareText"];
const hapticPatterns = { tap: [12], success: [20, 40, 30], fail: [70] };
const resolutionScales = [1, 0.8, 0.65, 0.5];

export function createGameHost({
  THREE, stage, onState = () => {}, onError = console.error, locale = "en", canvasLabel = "Game canvas. Press Tab to leave",
  bundleOrigin = window.location.origin, runtimeBase = new URL("/runtime/", window.location.origin),
  safeArea = () => ({ top: 0, right: 0, bottom: 0, left: 0 }), announce = () => {}, haptics = () => {},
  onLoading = () => {}, onOptions = () => {},
}) {
  let currentLocale = locale;
  let currentLabel = canvasLabel;
  let current = null;
  const mobile = window.matchMedia("(max-width: 64rem), (pointer: coarse)");
  const audio = createAudioHub();
  // Any gesture on the page may unlock audio, including the platform's own Resume button.
  for (const type of ["pointerdown", "keydown", "touchend"]) window.addEventListener(type, () => audio.unlock(), { capture: true });

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
    if (session === current) audio.setActive(false);
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
    audio.setActive(!paused);
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

  // Lowers the pixel ratio in steps while more than half of the frames miss ~45 fps.
  function adapt(session, time) {
    if (session.lastFrame !== null) {
      const interval = time - session.lastFrame;
      if (interval > 0 && interval < 250) {
        session.sampleTime += interval;
        if (interval > 22) session.slowTime += interval;
        if (session.sampleTime >= 2000) {
          if (session.slowTime / session.sampleTime > 0.5 && session.scaleIndex < resolutionScales.length - 1) {
            session.scaleIndex++;
            resize(session);
          }
          session.sampleTime = session.slowTime = 0;
        }
      }
    }
    session.lastFrame = time;
  }

  function frame(session, time) {
    if (session.scope.signal.aborted || session.paused) return;
    if (session.previousTime === null) session.lastFrame = null;
    const delta = session.previousTime === null ? 0 : Math.min(Math.max((time - session.previousTime) / 1000, 0), 0.05);
    session.previousTime = time;
    session.elapsed += delta;
    session.frames.push(time);
    while (session.frames[0] < time - 1000) session.frames.shift();
    try {
      session.invalidated = false;
      const animate = session.game.update?.(delta, session.elapsed);
      session.renderer.render(session.scene, session.camera);
      if (session.game.adaptiveResolution === true && session.game.renderMode !== "on-demand") adapt(session, time);
      if (session.game.renderMode === "on-demand" && !animate && !session.invalidated) stopLoop(session);
    } catch (error) { fail(session, error); }
  }

  function resize(session) {
    if (session.scope.signal.aborted) return;
    try {
      const rect = stage.getBoundingClientRect();
      const insets = safeArea(rect);
      Object.assign(session.viewport, {
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
        pixelRatio: Math.min(window.devicePixelRatio || 1, mobile.matches ? 1.5 : 2) * resolutionScales[session.scaleIndex],
        safeArea: Object.freeze(Object.fromEntries(["top", "right", "bottom", "left"].map((side) => [side, Math.max(0, Math.round(insets[side] || 0))]))),
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

  function emitOptions(session) {
    if (session === current && session.options) onOptions({ list: session.options.list, values: { ...session.options.values }, limits: structuredClone(session.options.limits) });
  }

  function redraw(session) {
    session.invalidated = true;
    if (!session.paused) startLoop(session);
    else if (session.game) session.renderer.render(session.scene, session.camera);
  }

  async function load(entry, { progress, launchReason = "open", settings } = {}) {
    release(current);
    const scope = createScope();
    if (progress) scope.signal.addEventListener("abort", () => progress.close(), { once: true });
    const session = {
      scope, game: null, renderer: null, paused: null, userPaused: false, previousTime: null, elapsed: 0,
      viewport: {}, scaleIndex: 0, lastFrame: null, sampleTime: 0, slowTime: 0, frames: [], options: null, loading: true,
    };
    current = session;
    onState("loading");
    onLoading(null);
    onOptions(null);
    const timeout = window.setTimeout(() => fail(session, new Error("Game loading timed out.")), 30000);
    scope.onCleanup(() => window.clearTimeout(timeout));

    try {
      const entryURL = new URL(entry, window.location.href);
      const baseURL = new URL("./", entryURL);
      if (entryURL.origin !== bundleOrigin) throw new Error("Game bundle origin is not allowed.");
      const module = await import(entryURL.href);
      if (scope.signal.aborted) return;
      if (typeof module.createGame !== "function") throw new Error("Bundle must export createGame(context).");
      const list = validateOptions(module.options ?? []);
      let stored = {};
      try { stored = settings?.load() ?? {}; } catch { /* Settings are optional preferences. */ }
      session.options = { list, ...createOptionState(list, stored), save: settings?.save, cheatsUsed: false };
      const optionValues = Object.freeze(Object.defineProperties({}, Object.fromEntries(list.filter((option) => option.type !== "action")
        .map((option) => [option.id, { enumerable: true, get: () => session.options.values[option.id] }]))));

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
      const sound = audio.session();
      if (sound) scope.onCleanup(() => sound.dispose());

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
      emitOptions(session);

      const running = () => session === current && !scope.signal.aborted && session.paused === false;
      const game = await module.createGame(Object.freeze({
        apiVersion: API_VERSION,
        launchReason,
        ...(progress ? { progress: progress.api } : {}),
        ...(sound ? { audio: sound.api } : {}),
        get locale() { return currentLocale; },
        THREE, scene, camera: session.camera, renderer, canvas,
        viewport: session.viewport,
        signal: scope.signal,
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        track: scope.track,
        onCleanup: scope.onCleanup,
        options: optionValues,
        get cheatsUsed() { return session.options.cheatsUsed; },
        invalidate() { session.invalidated = true; startLoop(session); },
        asset(path) {
          const url = new URL(path, baseURL);
          if (!url.href.startsWith(baseURL.href)) throw new Error("Assets must stay inside the game bundle.");
          return url.href;
        },
        runtime(name) {
          if (typeof name !== "string" || !/^(?:kit|addons)\/[a-zA-Z0-9-]+\.js$/.test(name)) return Promise.reject(new TypeError("Unknown runtime module."));
          return import(new URL(name, runtimeBase).href);
        },
        setCamera(camera) {
          if (!camera?.isCamera) throw new TypeError("Expected a Three.js camera.");
          session.camera = camera;
        },
        reportLoading(fraction) {
          if (session.loading && session === current && Number.isFinite(fraction)) onLoading(Math.min(1, Math.max(0, fraction)));
        },
        announce(text) {
          if (session === current && !scope.signal.aborted && typeof text === "string" && text.trim()) announce(text.trim().slice(0, 200));
        },
        haptics: Object.freeze({
          vibrate(pattern) {
            const steps = typeof pattern === "string" ? hapticPatterns[pattern] : pattern;
            if (!Array.isArray(steps) || steps.length > 8 || steps.some((step) => !Number.isFinite(step) || step < 0 || step > 1000)) throw new TypeError("Unknown haptic pattern.");
            if (running()) haptics(steps);
          },
        }),
        updateOption(id, changes = {}) {
          const option = session.options.list.find((item) => item.id === id);
          if (!option) throw new TypeError(`Unknown option: ${id}`);
          const limits = session.options.limits[id];
          if (changes.disabled !== undefined) limits.disabled = !!changes.disabled;
          if (option.type === "range") {
            if (changes.min !== undefined) limits.min = Math.max(option.min, Math.min(Number(changes.min), option.max));
            if (changes.max !== undefined) limits.max = Math.min(option.max, Math.max(Number(changes.max), limits.min));
            if (!Number.isFinite(limits.min) || !Number.isFinite(limits.max)) throw new TypeError("Range limits must be numbers.");
            session.options.values[id] = coerce(option, session.options.values[id], limits);
          }
          if (changes.value !== undefined) session.options.values[id] = coerce(option, changes.value, limits);
          if (option.section === "settings" && changes.value !== undefined) session.options.save?.(settingsOf(session.options.list, session.options.values));
          emitOptions(session);
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
      if (game.adaptiveResolution !== undefined && typeof game.adaptiveResolution !== "boolean") throw new TypeError("adaptiveResolution must be a boolean.");
      for (const hook of hooks) {
        if (game[hook] !== undefined && typeof game[hook] !== "function") throw new TypeError(`${hook} must be a function.`);
      }
      session.game = game;
      session.loading = false;
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
    setAudio(preferences) { audio.setPreferences(preferences); },
    // Applies a player change from the options panel. Actions carry no value.
    setOption(id, value) {
      const session = current;
      if (!session?.game || session.scope.signal.aborted) return;
      const option = session.options.list.find((item) => item.id === id);
      if (!option || session.options.limits[id].disabled) return;
      try {
        if (option.type !== "action") {
          session.options.values[id] = coerce(option, value, session.options.limits[id]);
          if (option.section === "settings") session.options.save?.(settingsOf(session.options.list, session.options.values));
        }
        if (option.section === "cheats") session.options.cheatsUsed = true;
        session.game.optionChanged?.(id, option.type === "action" ? undefined : session.options.values[id]);
        emitOptions(session);
        redraw(session);
      } catch (error) { fail(session, error); }
    },
    shareText(locale) {
      try {
        const text = current?.game?.shareText?.(locale);
        return typeof text === "string" && text.trim() ? text.trim().slice(0, 280) : null;
      } catch { return null; }
    },
    stats() {
      const session = current;
      if (!session?.renderer) return null;
      const { render, memory } = session.renderer.info;
      return {
        fps: session.loopActive ? session.frames.length : 0, calls: render.calls, triangles: render.triangles,
        geometries: memory.geometries, textures: memory.textures, pixelRatio: session.viewport.pixelRatio,
        programs: session.renderer.info.programs?.length ?? 0,
      };
    },
    dispose() { release(current); current = null; },
  };
}
