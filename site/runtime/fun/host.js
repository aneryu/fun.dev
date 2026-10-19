// The fun host: runs a game bundle (docs/game-bundles.md, `createGame(context)`) on fun, the
// native runtime, with the same context the web player gives (docs/hosts.md). The entry that
// fun starts imports fun's modules (Window from fun:window, the fun:app, fun:assets, fun:gpu and
// fun:debug namespaces, createCanvas from fun:canvas) and the game's entry module, then calls
// createFunHost({ fun: { Window, app, assets, createCanvas, gpu, debug }, THREE, module, runtimeModules }).start()
// without awaiting it at top level: fun begins driving frames only after the entry module has
// finished evaluating. scripts/fun-probe/host-entry.mjs is a complete example.
//
// The host also gives players what the web player's ☰ menu gives (menu.js): pause and resume,
// restart, sound, language, the game's options, reset progress, quit; the menu button reserves
// the top safe area like the web player's does.
//
// This module imports nothing from fun itself, so it loads in Node for tests and never touches
// the DOM; everything host-specific arrives through `fun`.
import { createScope } from "../core/scope.js";
import { coerce, createOptionState, settingsOf, validateOptions } from "../core/options.js";
import { createFunStorage } from "./storage.js";
import { ProgressError } from "../../progress/format.js";
import { createMenu, SAFE_TOP } from "./menu.js";

export const API_VERSION = 3;
const hooks = ["update", "resize", "pause", "resume", "dispose", "localeChanged", "optionChanged", "shareText", "recordingFocus", "recordingBadge"];
const MAX_DELTA = 0.05;
const resolutionScales = [1, 0.8, 0.65, 0.5];

/** A bundle-relative asset path, as the web player accepts: inside the bundle, no `..`, no absolute. */
export function assetKey(name) {
  if (typeof name !== "string" || !name) throw new TypeError("Asset paths must be non-empty strings.");
  const path = name.replace(/[?#].*$/, "").replace(/^\.\//, "");
  if (path.startsWith("/") || /(^|\/)\.\.?(\/|$)/.test(path) || path.includes("\\") || path.includes("\0")) throw new Error("Assets must stay inside the game bundle.");
  return path;
}

/** Flips the rows of tightly packed RGBA pixels in place, for `imageOrientation: "flipY"`. */
export function flipRows(data, width, height) {
  const row = width * 4, tmp = new Uint8Array(row);
  for (let y = 0; y < height >> 1; y++) {
    const a = y * row, b = (height - 1 - y) * row;
    tmp.set(data.subarray(a, a + row)); data.copyWithin(a, b, b + row); data.set(tmp, b);
  }
  return data;
}

export function createFunHost({
  fun, THREE, module, manifest = {}, locale = "zh", title = manifest.title?.[locale] ?? manifest.title?.en ?? manifest.id ?? "fun",
  width = 1280, height = 720, tier = "high", runtimeModules = {}, menu: withMenu = true,
  // fun's data directory holds progress, device storage, settings and preferences; null runs without persistence.
  storage = globalThis.navigator?.storage ?? null,
  createRenderer = ({ canvas }) => new THREE.WebGPURenderer({ canvas, antialias: true }),
  requestFrame = (callback) => requestAnimationFrame(callback),
  onError = (error) => fun.app?.print?.(`game error: ${error?.stack || error}`),
}) {
  if (!fun?.Window || !fun.assets || !fun.createCanvas) throw new TypeError("createFunHost needs fun's Window, assets and createCanvas.");
  if (typeof module?.createGame !== "function") throw new TypeError("Bundle must export createGame(context).");
  const hostScope = createScope();
  const host = { window: null, canvas: null, renderer: null, store: null, prefs: { muted: false, volume: 1, locale }, audio: null, menu: null, started: false, failed: null, closed: false, closing: null };
  let session = null;
  let frameCounter = 0;
  const graphics = Object.freeze({ backend: "webgpu", tier });
  const list = validateOptions(module.options ?? []);

  function report(error) { host.failed = error; onError(error); }
  function draw(s) {
    if (s.pipeline) s.pipeline.render();
    else host.renderer.render(s.scene, s.camera);
  }
  function overlay(s) { if (host.menu) host.menu.render(host.renderer); }
  function present(s) { draw(s); overlay(s); }
  function startLoop(s) {
    if (s.loopActive || !s.game || s.paused || s.scope.signal.aborted) return;
    s.previousTime = null;
    s.loopActive = true;
    requestFrame((time) => frame(s, time));
  }
  function adapt(s, time) {
    if (s.lastFrame !== null) {
      const interval = time - s.lastFrame;
      if (interval > 0 && interval < 250) {
        s.sampleTime += interval;
        if (interval > 22) s.slowTime += interval;
        if (s.sampleTime >= 2000) {
          if (s.slowTime / s.sampleTime > 0.5 && s.scaleIndex < resolutionScales.length - 1) { s.scaleIndex++; resize(s); }
          s.sampleTime = s.slowTime = 0;
        }
      }
    }
    s.lastFrame = time;
  }
  function frame(s, time) {
    if (!s.loopActive || s.scope.signal.aborted || s.paused) { s.loopActive = false; return; }
    if (s.previousTime === null) s.lastFrame = null;
    const delta = s.previousTime === null ? 0 : Math.min(Math.max((time - s.previousTime) / 1000, 0), MAX_DELTA);
    s.previousTime = time;
    s.elapsed += delta;
    s.frames.push(time);
    while (s.frames[0] < time - 1000) s.frames.shift();
    try {
      s.invalidated = false;
      const animate = s.game.update?.(delta, s.elapsed);
      present(s);
      frameCounter++;
      if (s.game.adaptiveResolution === true && s.game.renderMode !== "on-demand") adapt(s, time);
      if (s.game.renderMode === "on-demand" && !animate && !s.invalidated) { s.loopActive = false; return; }
      requestFrame((t) => frame(s, t));
    } catch (error) { fail(s, error); }
  }
  function redraw(s) {
    s.invalidated = true;
    if (!s.paused) startLoop(s);
    else if (s.game) present(s);
  }
  function viewportOf(s) {
    const canvas = host.canvas;
    return {
      width: Math.max(1, canvas.clientWidth || canvas.width), height: Math.max(1, canvas.clientHeight || canvas.height),
      pixelRatio: Math.min(Math.max(1, Number(globalThis.devicePixelRatio) || 1), 2) * resolutionScales[s.scaleIndex],
      safeArea: Object.freeze({ top: host.menu ? SAFE_TOP : 0, right: 0, bottom: 0, left: 0 }),
    };
  }
  function resize(s = session) {
    if (!s || s.scope.signal.aborted) return;
    try {
      Object.assign(s.viewport, viewportOf(s));
      const view = s.viewport;
      host.renderer.setPixelRatio(view.pixelRatio);
      host.renderer.setSize(view.width, view.height, false);
      host.menu?.resize({ width: view.width, height: view.height });
      if (s.camera.isPerspectiveCamera) { s.camera.aspect = view.width / view.height; s.camera.updateProjectionMatrix(); }
      s.game?.resize?.({ ...view });
      if (s.game) present(s);
    } catch (error) { fail(s, error); }
  }
  function syncPlayback(s) {
    if (!s.game || s.scope.signal.aborted) return;
    const paused = s.userPaused || host.unfocused === true;
    if (paused === s.paused) return;
    s.paused = paused;
    s.previousTime = null;
    try {
      if (paused) { s.loopActive = false; host.audio?.context.suspend?.(); s.game.pause?.(); present(s); }
      else { host.audio?.context.resume?.(); s.game.resume?.(); startLoop(s); }
    } catch (error) { fail(s, error); }
  }
  function release(s) {
    if (!s || s.scope.signal.aborted) return;
    s.loopActive = false;
    for (const error of s.scope.dispose()) onError(error);
  }
  function fail(s, error) {
    if (s !== session || s.scope.signal.aborted) return;
    release(s);
    report(error);
  }
  function applyAudio() {
    if (host.audio) host.audio.master.gain.value = host.prefs.muted ? 0 : host.prefs.volume;
  }
  function savePrefs() { host.store?.preferences.save(host.prefs).catch(report); }

  async function createSession(launchReason) {
    const scope = createScope();
    const s = {
      scope, launchReason, game: null, paused: null, userPaused: false, previousTime: null, elapsed: 0, frames: [], viewport: {}, pipeline: null,
      invalidated: false, loopActive: false, loading: true, camera: null, scene: null, options: null, cheats: false, scaleIndex: 0, lastFrame: null, sampleTime: 0, slowTime: 0,
    };
    session = s;
    const settings = host.store?.settings ?? null;
    let stored = {};
    try { stored = settings?.load() ?? {}; } catch { /* optional */ }
    // Storage writes are promises on fun (the web's are localStorage): a failure is reported, not unhandled.
    s.options = { list, ...createOptionState(list, stored), save: settings ? (values) => settings.save(values).catch(report) : null };
    // The contract's progress capability, scoped to this session: after restart or stop a late
    // save from the old game is refused as stale_context, as the web player does.
    const progress = host.store ? Object.freeze({
      version: 1,
      load: () => (scope.signal.aborted ? Promise.resolve({ kind: "unavailable", reason: "stale_context" }) : host.store.progress.load()),
      save: (value) => (scope.signal.aborted ? Promise.reject(new ProgressError("stale_context")) : host.store.progress.save(value)),
    }) : null;
    const optionValues = Object.freeze(Object.defineProperties({}, Object.fromEntries(list.filter((option) => option.type !== "action")
      .map((option) => [option.id, { enumerable: true, get: () => s.options.values[option.id] }]))));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x211f17);
    s.scene = scene;
    scope.onCleanup(() => scene.clear());
    s.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    s.camera.position.z = 5;
    let sound = null;
    if (host.audio) {
      const destination = host.audio.context.createGain();
      destination.connect(host.audio.master);
      sound = Object.freeze({ context: host.audio.context, destination });
      scope.onCleanup(() => { try { destination.disconnect(); } catch { /* closing */ } });
    }
    resize(s);
    if (scope.signal.aborted) return false;

    const context = Object.freeze({
      apiVersion: API_VERSION,
      launchReason,
      ...(sound ? { audio: sound } : {}),
      ...(progress ? { progress, deviceStorage: host.store.deviceStorage } : {}),
      get locale() { return host.prefs.locale; },
      THREE, scene, camera: s.camera, renderer: host.renderer, canvas: host.canvas, graphics,
      viewport: s.viewport,
      signal: scope.signal,
      reducedMotion: false,
      track: scope.track,
      onCleanup: scope.onCleanup,
      options: optionValues,
      get cheatsUsed() { return s.cheats; },
      invalidate() { s.invalidated = true; startLoop(s); },
      asset: (name) => assetKey(name),
      async readAsset(name) { return new Uint8Array(fun.assets.readBytes(assetKey(name))); },
      async decodeImage(bytes, { imageOrientation = "none" } = {}) {
        const { width: w, height: h, data } = fun.assets.decodeImage(bytes);
        const pixels = new Uint8Array(data);
        return { width: w, height: h, data: imageOrientation === "flipY" ? flipRows(pixels, w, h) : pixels };
      },
      createCanvas2D: (w, h) => fun.createCanvas(w, h),
      runtime(name) {
        const load = typeof name === "string" ? runtimeModules[name] : null;
        return load ? load() : Promise.reject(new TypeError(`Unknown runtime module: ${name}`));
      },
      setCamera(camera) {
        if (!camera?.isCamera) throw new TypeError("Expected a Three.js camera.");
        s.camera = camera;
      },
      setRenderPipeline(pipeline) {
        if (pipeline !== null && typeof pipeline?.render !== "function") throw new TypeError("Expected a render pipeline or null.");
        s.pipeline = pipeline;
        if (s.game) redraw(s);
      },
      reportLoading(fraction) { if (s.loading && Number.isFinite(fraction)) fun.app?.print?.(`loading ${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`); },
      announce(text) { if (typeof text === "string" && text.trim()) fun.app?.print?.(`announce: ${text.trim().slice(0, 200)}`); },
      haptics: Object.freeze({ vibrate() {} }),
      updateOption(id, changes = {}) {
        const option = s.options.list.find((item) => item.id === id);
        if (!option) throw new TypeError(`Unknown option: ${id}`);
        const limits = s.options.limits[id];
        if (changes.disabled !== undefined) limits.disabled = !!changes.disabled;
        if (option.type === "range") {
          if (changes.min !== undefined) limits.min = Math.max(option.min, Math.min(Number(changes.min), option.max));
          if (changes.max !== undefined) limits.max = Math.min(option.max, Math.max(Number(changes.max), limits.min));
          if (!Number.isFinite(limits.min) || !Number.isFinite(limits.max)) throw new TypeError("Range limits must be numbers.");
          s.options.values[id] = coerce(option, s.options.values[id], limits);
        }
        if (changes.value !== undefined) s.options.values[id] = coerce(option, changes.value, limits);
        if (option.section === "settings" && changes.value !== undefined) s.options.save?.(settingsOf(list, s.options.values));
        host.menu?.refresh();
      },
    });
    const game = await module.createGame(context);
    if (scope.signal.aborted) { game?.dispose?.(); return false; }
    if (!game || typeof game !== "object") throw new TypeError("createGame must return a lifecycle object.");
    if (typeof game.dispose === "function") scope.onCleanup(() => game.dispose());
    if (game.renderMode !== undefined && !["continuous", "on-demand"].includes(game.renderMode)) throw new TypeError("Invalid renderMode.");
    if (game.adaptiveResolution !== undefined && typeof game.adaptiveResolution !== "boolean") throw new TypeError("adaptiveResolution must be a boolean.");
    for (const hook of hooks) if (game[hook] !== undefined && typeof game[hook] !== "function") throw new TypeError(`${hook} must be a function.`);
    await host.renderer.compileAsync?.(scene, s.camera)?.catch?.(() => {});
    if (scope.signal.aborted) return false;
    s.game = game;
    s.loading = false;
    game.localeChanged?.(host.prefs.locale);
    resize(s);
    syncPlayback(s);
    return true;
  }

  function setPaused(paused) {
    if (!session) return;
    session.userPaused = !!paused;
    if (host.menu) { if (paused) host.menu.show(); else host.menu.hide(); }
    syncPlayback(session);
  }
  function setLocale(next) {
    if (next !== "zh" && next !== "en") throw new TypeError("locale must be zh or en.");
    host.prefs.locale = next;
    savePrefs();
    host.menu?.setLocale(next);
    try { session?.game?.localeChanged?.(next); } catch (error) { fail(session, error); }
    if (session?.paused) present(session);
  }
  function setOption(id, value) {
    const s = session;
    if (!s?.game || s.scope.signal.aborted) return;
    const option = s.options.list.find((item) => item.id === id);
    if (!option || s.options.limits[id].disabled) return;
    try {
      if (option.type !== "action") {
        s.options.values[id] = coerce(option, value, s.options.limits[id]);
        if (option.section === "settings") s.options.save?.(settingsOf(s.options.list, s.options.values));
      }
      if (option.section === "cheats") s.cheats = true;
      s.game.optionChanged?.(id, option.type === "action" ? undefined : s.options.values[id]);
      host.menu?.refresh();
      redraw(s);
    } catch (error) { fail(s, error); }
  }
  async function restart() {
    if (!host.started || host.closed) return false;
    const previous = session;
    release(previous);
    host.menu?.hide();
    try { return await createSession("restart"); } catch (error) { release(session); report(error); return false; }
  }
  async function resetProgress() {
    await host.store?.resetProgress();
    return restart();
  }
  function stop() {
    if (host.closed) return host.closing;
    host.closed = true;
    release(session);
    for (const error of hostScope.dispose()) onError(error);
    // Queued storage writes commit on close; quit waits for them.
    host.closing = (host.store?.close() ?? Promise.resolve()).catch(report);
    return host.closing;
  }
  async function quit() { await stop(); fun.app?.quit?.(); }

  async function start() {
    if (host.started) throw new Error("start() runs once.");
    host.started = true;
    try {
      host.window = new fun.Window({ title, width, height });
      const canvas = host.window.canvas;
      host.canvas = canvas;
      // Keyboard focus follows the window manager; fun refuses focus() before the window is shown.
      try { canvas.focus?.(); } catch { /* HOT_RELOAD_NO_WINDOW_FOCUS before the first frame */ }
      host.renderer = createRenderer({ canvas });
      await host.renderer.init?.();
      if (host.closed) return false;
      // fun's device is host-owned: the renderer is never disposed, only the loops stopped.
      if (storage && manifest.id) {
        try { host.store = await createFunStorage(storage, manifest.id); }
        catch (error) { onError(new Error(`storage unavailable, playing without persistence: ${error.message}`)); }
      }
      if (host.store) { try { host.prefs = { ...host.prefs, ...host.store.preferences.load() }; } catch { /* optional */ } }
      // fun's Web Audio subset, when the build has it: one context, a master gain for the player's switches.
      const AudioContextClass = globalThis.AudioContext;
      if (AudioContextClass) {
        const context = new AudioContextClass();
        const master = context.createGain();
        master.connect(context.destination);
        host.audio = { context, master };
        hostScope.onCleanup(() => { try { master.disconnect(); context.close?.(); } catch { /* closing */ } });
        applyAudio();
      }
      if (withMenu) {
        host.menu = createMenu({
          createCanvas2D: (w, h) => fun.createCanvas(w, h), locale: host.prefs.locale,
          state: () => ({ muted: host.prefs.muted, volume: host.prefs.volume, locale: host.prefs.locale, options: session?.options, hasProgress: !!host.store }),
          actions: {
            pause: () => setPaused(true), resume: () => setPaused(false), restart: () => { void restart(); }, quit,
            setMuted: (muted) => { host.prefs.muted = !!muted; applyAudio(); savePrefs(); host.menu.refresh(); if (session?.paused) present(session); },
            setVolume: (volume) => { host.prefs.volume = Math.min(1, Math.max(0, Number(volume) || 0)); applyAudio(); savePrefs(); host.menu.refresh(); if (session?.paused) present(session); },
            setLocale, option: setOption, resetProgress: () => { void resetProgress(); },
          },
        });
        hostScope.onCleanup(() => host.menu.dispose());
        // The menu takes taps and keys before the game sees them: capture listeners, stopped when consumed.
        const pointerAt = (event) => { const rect = canvas.getBoundingClientRect?.() ?? { left: 0, top: 0, width: canvas.width, height: canvas.height }; const view = session?.viewport ?? { width: canvas.width, height: canvas.height }; return { x: (event.clientX - rect.left) / rect.width * view.width, y: (event.clientY - rect.top) / rect.height * view.height }; };
        const taken = new Set();
        canvas.addEventListener("pointerdown", (event) => {
          if (!session?.game) return;
          const { x, y } = pointerAt(event);
          if (host.menu.tap(x, y)) { taken.add(event.pointerId ?? 0); event.stopImmediatePropagation?.(); if (session.paused) present(session); }
        }, { capture: true, signal: hostScope.signal });
        for (const type of ["pointermove", "pointerup", "pointercancel"]) canvas.addEventListener(type, (event) => {
          if (host.menu.open || taken.has(event.pointerId ?? 0)) { event.stopImmediatePropagation?.(); if (type !== "pointermove") taken.delete(event.pointerId ?? 0); }
        }, { capture: true, signal: hostScope.signal });
        canvas.addEventListener("keydown", (event) => {
          if (!session?.game) return;
          if (host.menu.key(event.code)) { event.stopImmediatePropagation?.(); if (session.paused) present(session); }
        }, { capture: true, signal: hostScope.signal });
        canvas.addEventListener("keyup", (event) => { if (host.menu.open) event.stopImmediatePropagation?.(); }, { capture: true, signal: hostScope.signal });
      }
      canvas.addEventListener?.("resize", () => resize(), { signal: hostScope.signal });
      // Focus loss pauses like a hidden tab does on the web; focus resumes unless the player paused.
      canvas.addEventListener?.("blur", () => { host.unfocused = true; if (session) syncPlayback(session); }, { signal: hostScope.signal });
      canvas.addEventListener?.("focus", () => { host.unfocused = false; if (session) syncPlayback(session); }, { signal: hostScope.signal });
      return await createSession("open");
    } catch (error) { report(error); stop(); return false; }
  }

  return {
    start, stop, quit, restart, resetProgress, setPaused, setLocale, setOption,
    get signal() { return session?.scope.signal ?? hostScope.signal; },
    get failed() { return host.failed; },
    get frames() { return frameCounter; },
    get paused() { return !!session?.paused; },
    get menuOpen() { return !!host.menu?.open; },
    get preferences() { return { ...host.prefs }; },
    setMuted(muted) { host.prefs.muted = !!muted; applyAudio(); savePrefs(); },
    setVolume(volume) { host.prefs.volume = Math.min(1, Math.max(0, Number(volume) || 0)); applyAudio(); savePrefs(); },
    /** Opens or closes the platform menu, which pauses and resumes the game. */
    menu(action = "toggle") { if (!host.menu) return false; if (action === "open") setPaused(true); else if (action === "close") setPaused(false); else host.menu.toggle(); return host.menu.open; },
    shareText(forLocale = host.prefs.locale) {
      try { const text = session?.game?.shareText?.(forLocale); return typeof text === "string" && text.trim() ? text.trim().slice(0, 280) : null; } catch { return null; }
    },
    stats() {
      const info = host.renderer?.info;
      return { fps: session?.loopActive ? session.frames.length : 0, frames: frameCounter, calls: info?.render?.drawCalls ?? 0, triangles: info?.render?.triangles ?? 0, pixelRatio: session?.viewport.pixelRatio ?? 1, backend: "webgpu", tier, paused: !!session?.paused, menu: !!host.menu?.open, launchReason: session?.launchReason ?? null };
    },
    /** The window's pixels as a PNG in fun's artifact directory, through fun:gpu and fun:debug. */
    async capture(name = `frame-${String(frameCounter).padStart(4, "0")}.png`) {
      if (!fun.gpu?.dispatch || !fun.debug?.writeImage) throw new Error("capture needs fun:gpu and fun:debug.");
      const context = host.canvas.getContext("webgpu");
      const pixels = await fun.gpu.dispatch("capture", context._id, { overlay: false });
      const { width: w, height: h } = host.canvas;
      return fun.debug.writeImage(name, { width: w, height: h, format: "bgra8unorm", alphaMode: "opaque", origin: "top-left", frame: frameCounter, metadata: {} }, pixels);
    },
    /** Registers RPC methods on fun's debug socket so agents can drive and inspect the game. */
    registerDebug(prefix = "game") {
      if (!fun.debug?.register) return false;
      fun.debug.register(`${prefix}.stats`, () => this.stats());
      fun.debug.register(`${prefix}.capture`, (params) => this.capture(params?.name));
      fun.debug.register(`${prefix}.option`, (params) => { if (!params?.id) throw new TypeError("option needs { id, value }."); setOption(params.id, params.value); return session?.options.values[params.id] ?? null; });
      fun.debug.register(`${prefix}.pause`, () => { setPaused(true); return true; });
      fun.debug.register(`${prefix}.resume`, () => { setPaused(false); return true; });
      fun.debug.register(`${prefix}.menu`, (params) => this.menu(params?.action ?? "toggle"));
      fun.debug.register(`${prefix}.key`, (params) => { const taken = host.menu?.key(params?.code) ?? false; if (session?.paused) present(session); return taken; });
      fun.debug.register(`${prefix}.locale`, (params) => { setLocale(params?.locale); return host.prefs.locale; });
      fun.debug.register(`${prefix}.restart`, () => restart());
      fun.debug.register(`${prefix}.reset`, () => resetProgress());
      fun.debug.register(`${prefix}.quit`, () => quit().then(() => true));
      return true;
    },
  };
}
