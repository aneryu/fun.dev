import { createScope } from "./scope.js";
import { createAudioHub } from "./audio.js";
import { coerce, createOptionState, settingsOf, validateOptions } from "./options.js";
import { createRecorder, recordingSupported } from "./recorder.js";

export const API_VERSION = 3;
const hooks = ["update", "resize", "pause", "resume", "dispose", "localeChanged", "optionChanged", "shareText", "recordingFocus", "recordingBadge"];
const hapticPatterns = { tap: [12], success: [20, 40, 30], fail: [70] };
const resolutionScales = [1, 0.8, 0.65, 0.5];
const backends = ["auto", "webgpu", "webgl"];

// WebGPU when the browser offers a hardware adapter; otherwise the WebGL 2 backend. A software
// (fallback) adapter would be slower than WebGL, so it does not count.
async function chooseBackend(preference, powerPreference) {
  if (preference !== "auto") return preference;
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference });
    return adapter && !adapter.info?.isFallbackAdapter ? "webgpu" : "webgl";
  } catch { return "webgl"; }
}

// Opens the system image picker (photo library, camera, files) from a user gesture and
// decodes the choice upright (EXIF orientation), scaled so its longer side fits maxSize.
// Resolves null when cancelled or when the session ends first.
function pickImage(surface, signal, maxSize) {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.hidden = true;
    const done = new AbortController();
    const finish = (value, error) => {
      done.abort();
      input.remove();
      if (error) reject(error); else resolve(value);
    };
    signal.addEventListener("abort", () => finish(null), { signal: done.signal });
    input.addEventListener("cancel", () => finish(null), { signal: done.signal });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      try {
        // Browsers decode upright (EXIF orientation) by default. Scale through a canvas: Safari
        // does not support createImageBitmap's resize options.
        const original = await createImageBitmap(file);
        const scale = Math.min(1, maxSize / Math.max(original.width, original.height));
        let image = original;
        if (scale < 1) {
          const canvas = new OffscreenCanvas(Math.max(1, Math.round(original.width * scale)), Math.max(1, Math.round(original.height * scale)));
          const context = canvas.getContext("2d");
          context.imageSmoothingQuality = "high";
          context.drawImage(original, 0, 0, canvas.width, canvas.height);
          original.close();
          image = await createImageBitmap(canvas);
        }
        if (signal.aborted) { image.close(); finish(null); } else finish(image);
      } catch { finish(null, new Error("The image could not be read.")); }
    }, { signal: done.signal });
    surface.append(input);
    input.click();
  });
}

export function createGameHost({
  THREE, stage, onState = () => {}, onError = console.error, locale = "en", canvasLabel = "Game canvas. Press Tab to leave",
  bundleOrigin = window.location.origin, runtimeBase = new URL("../", import.meta.url),
  safeArea = () => ({ top: 0, right: 0, bottom: 0, left: 0 }), announce = () => {}, haptics = () => {},
  onLoading = () => {}, onOptions = () => {}, onRecorded = () => {}, renderer: rendererPreference = "auto",
}) {
  if (!backends.includes(rendererPreference)) throw new TypeError(`renderer must be one of ${backends.join(", ")}.`);
  let currentLocale = locale;
  let currentLabel = canvasLabel;
  let current = null;
  const mobile = window.matchMedia("(max-width: 64rem), (pointer: coarse)");
  // Phones save battery; desktops ask for the discrete GPU where there is one. The backend is
  // decided once per host, starting right away: the first adapter request can take a while.
  const tierNow = () => mobile.matches ? "low" : "high";
  const powerPreferences = { low: "low-power", high: "high-performance" };
  const backendChoice = chooseBackend(rendererPreference, powerPreferences[tierNow()]);
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

  // Ends the session's recording and hands the pending video to the player.
  function endRecording(session) {
    const recorder = session?.recorder;
    if (!recorder) return;
    session.recorder = null;
    onRecorded(recorder.stop());
  }

  function release(session) {
    if (!session || session.scope.signal.aborted) return;
    stopLoop(session);
    endRecording(session);
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
        session.recorder?.pause();
        session.game.pause?.();
      } else {
        session.game.resume?.();
        session.recorder?.resume();
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
      draw(session);
      session.recorder?.capture(time);
      if (session.game.adaptiveResolution === true && session.game.renderMode !== "on-demand") adapt(session, time);
      // While recording, on-demand games keep rendering so the video gets a steady frame rate.
      if (session.game.renderMode === "on-demand" && !animate && !session.invalidated && !session.recorder) stopLoop(session);
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
      if (session.game) draw(session);
    } catch (error) { fail(session, error); }
  }

  function emitOptions(session) {
    if (session === current && session.options) onOptions({ list: session.options.list, values: { ...session.options.values }, limits: structuredClone(session.options.limits) });
  }

  function redraw(session) {
    session.invalidated = true;
    if (!session.paused) startLoop(session);
    else if (session.game) draw(session);
  }

  // A game's postprocessing pipeline (context.setRenderPipeline) replaces the plain scene render.
  function draw(session) {
    if (session.pipeline) session.pipeline.render();
    else session.renderer.render(session.scene, session.camera);
  }

  async function load(entry, { progress, launchReason = "open", settings, deviceStorage } = {}) {
    release(current);
    const scope = createScope();
    if (progress) scope.signal.addEventListener("abort", () => progress.close(), { once: true });
    const session = {
      scope, game: null, renderer: null, paused: null, userPaused: false, previousTime: null, elapsed: 0,
      viewport: {}, scaleIndex: 0, lastFrame: null, sampleTime: 0, slowTime: 0, frames: [], options: null, loading: true, pipeline: null,
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
      // files.json says where each assets/ file is served: content-addressed blobs shared by
      // releases and games.
      const index = fetch(new URL("files.json", baseURL), { signal: scope.signal }).then((response) => {
        if (!response.ok) throw new Error(`Bundle file index unavailable (HTTP ${response.status}).`);
        return response.json();
      });
      const bundle = Promise.all([import(entryURL.href), index]);
      bundle.catch(() => {}); // awaited below, after the renderer has started

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
      // The graphics device starts while the bundle downloads.
      const tier = tierNow();
      const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, powerPreference: powerPreferences[tier], forceWebGL: await backendChoice === "webgl" });
      session.renderer = renderer;
      // A lost device (GPU reset, driver update, WebGL context loss) cannot be recovered in place.
      renderer.onDeviceLost = () => fail(session, new Error("The graphics device was lost. Restart the game."));
      scope.onCleanup(() => { renderer.setAnimationLoop(null); void renderer.dispose(); });
      const [[module, { blobs = {} }]] = await Promise.all([bundle, renderer.init()]);
      if (scope.signal.aborted) return;
      const graphics = Object.freeze({ backend: renderer.backend.isWebGPUBackend ? "webgpu" : "webgl", tier });
      session.graphics = graphics;
      const blobBase = new URL("/blobs/", entryURL);
      if (typeof module.createGame !== "function") throw new Error("Bundle must export createGame(context).");
      const list = validateOptions(module.options ?? []);
      let stored = {};
      try { stored = settings?.load() ?? {}; } catch { /* Settings are optional preferences. */ }
      session.options = { list, ...createOptionState(list, stored), save: settings?.save, cheatsUsed: false };
      const optionValues = Object.freeze(Object.defineProperties({}, Object.fromEntries(list.filter((option) => option.type !== "action")
        .map((option) => [option.id, { enumerable: true, get: () => session.options.values[option.id] }]))));

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x211f17);
      session.scene = scene;
      scope.onCleanup(() => scene.clear());
      session.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
      session.camera.position.z = 5;
      const sound = audio.session();
      session.sound = sound;
      if (sound) scope.onCleanup(() => sound.dispose());

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
        ...(deviceStorage ? { deviceStorage } : {}),
        get locale() { return currentLocale; },
        THREE, scene, camera: session.camera, renderer, canvas, graphics,
        viewport: session.viewport,
        signal: scope.signal,
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        track: scope.track,
        onCleanup: scope.onCleanup,
        options: optionValues,
        get cheatsUsed() { return session.options.cheatsUsed; },
        invalidate() { session.invalidated = true; startLoop(session); },
        asset(name) {
          const url = new URL(name, baseURL);
          if (!url.href.startsWith(baseURL.href)) throw new Error("Assets must stay inside the game bundle.");
          const path = url.pathname.slice(baseURL.pathname.length);
          const blob = Object.hasOwn(blobs, path) ? blobs[path] : null;
          if (blob === null) return url.href;
          if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(blob)) throw new Error(`Invalid blob for ${path}.`);
          return new URL(blob, blobBase).href + url.search + url.hash;
        },
        runtime(name) {
          if (typeof name !== "string" || !/^(?:kit|addons)\/[a-zA-Z0-9-]+\.js$/.test(name)) return Promise.reject(new TypeError("Unknown runtime module."));
          return import(new URL(name, runtimeBase).href);
        },
        setCamera(camera) {
          if (!camera?.isCamera) throw new TypeError("Expected a Three.js camera.");
          session.camera = camera;
        },
        // A THREE.RenderPipeline (or any object with render()) draws each frame instead of
        // renderer.render(scene, camera); null goes back to the plain render. The game owns it.
        setRenderPipeline(pipeline) {
          if (pipeline !== null && typeof pipeline?.render !== "function") throw new TypeError("Expected a render pipeline or null.");
          session.pipeline = pipeline;
          if (session.game) redraw(session);
        },
        reportLoading(fraction) {
          if (session.loading && session === current && Number.isFinite(fraction)) onLoading(Math.min(1, Math.max(0, fraction)));
        },
        announce(text) {
          if (session === current && !scope.signal.aborted && typeof text === "string" && text.trim()) announce(text.trim().slice(0, 200));
        },
        pickImage({ maxSize = 1024 } = {}) {
          if (!Number.isFinite(maxSize) || maxSize < 16 || maxSize > 4096) return Promise.reject(new TypeError("maxSize must be 16–4096."));
          if (!running() || session.picking) return Promise.resolve(null);
          session.picking = true;
          return pickImage(surface, scope.signal, maxSize).finally(() => { session.picking = false; });
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
      // Shaders compile in parallel before the first frame instead of stalling it one by one.
      await renderer.compileAsync(scene, session.camera).catch(() => {});
      if (scope.signal.aborted) return; // the scope already disposed the game
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
    recordingSupported,
    // Starts recording the running game; onRecorded receives the video when it ends.
    startRecording({ watermark }) {
      const session = current;
      if (!session?.game || session.scope.signal.aborted || session.recorder || !recordingSupported()) return false;
      const { context, destination } = session.sound?.api ?? {};
      session.recorder = createRecorder({
        source: session.renderer.domElement,
        audio: context ? { context, node: destination } : null,
        topInset: () => session.viewport.safeArea.top / session.viewport.height,
        focus: () => {
          try {
            const point = session.game.recordingFocus?.();
            const x = point?.x / session.viewport.width, y = point?.y / session.viewport.height;
            return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) } : null;
          } catch { return null; }
        },
        badge: () => {
          try {
            const image = session.game.recordingBadge?.();
            return image && image.width > 0 && image.height > 0 ? image : null;
          } catch { return null; }
        },
        watermark,
        onLimit: () => endRecording(session),
      });
      session.recorder.start();
      if (session.paused) session.recorder.pause();
      else startLoop(session);
      return true;
    },
    stopRecording() { endRecording(current); },
    recordingSeconds() { return current?.recorder ? current.recorder.seconds : null; },
    shareText(locale) {
      try {
        const text = current?.game?.shareText?.(locale);
        return typeof text === "string" && text.trim() ? text.trim().slice(0, 280) : null;
      } catch { return null; }
    },
    stats() {
      const session = current;
      if (!session?.renderer || session.viewport.pixelRatio === undefined) return null;
      const { render, memory } = session.renderer.info;
      return {
        fps: session.loopActive ? session.frames.length : 0, calls: render.drawCalls, triangles: render.triangles,
        geometries: memory.geometries, textures: memory.textures, pixelRatio: session.viewport.pixelRatio,
        backend: session.graphics?.backend ?? "", tier: session.graphics?.tier ?? "",
      };
    },
    dispose() { release(current); current = null; },
  };
}
