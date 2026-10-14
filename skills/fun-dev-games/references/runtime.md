# Runtime API v2

The platform creates a session and awaits `createGame(context)`. A game module's
top level must not allocate session resources or start gameplay; modules are
cached and restarting calls the factory again. The platform runs one API version
and every game upgrades with it; `game.json` must say `"apiVersion": 2`.

| Context | Meaning |
| --- | --- |
| `apiVersion` | `2` |
| `THREE` | Shared engine; current platform pin `0.186.1` |
| `scene`, `camera` | Session scene and default perspective camera |
| `setCamera(camera)` | Select the camera used by the container |
| `renderer`, `canvas` | Host-owned renderer and focusable input canvas |
| `viewport` | Live CSS-pixel `width`, `height`, capped `pixelRatio`, and `safeArea` `{top,right,bottom,left}` (cutouts plus the menu button) |
| `locale` | Current `zh` or `en` |
| `asset(relativePath)` | Resolve a file inside this bundle/version |
| `signal` | Aborted at session teardown; use for fetch and listeners |
| `track(resource)` | Own a disposable geometry/material/texture exactly once |
| `onCleanup(fn)` | Register synchronous cleanup, including before awaits |
| `invalidate()` | Request a frame after input/asynchronous changes |
| `audio` | `{ context, destination }` shared Web Audio graph; connect sound to `destination` |
| `announce(text)` | Screen-reader announcement, coalesced by the player |
| `haptics.vibrate(p)` | `"tap"`, `"success"`, `"fail"` or ms durations; respects the player's switch |
| `reportLoading(f)` | 0–1 loading progress while `createGame` runs |
| `options`, `cheatsUsed`, `updateOption(id, changes)` | Values and runtime state of the exported `options` |
| `runtime(name)` | Import `kit/*.js` or `addons/*Loader.js` from the platform |
| `progress` | `{ version: 1, load(), save(snapshot) }` when saving is ready; see below |
| `launchReason` | `"open"` or `"restart"` |
| `reducedMotion` | User preference at session creation |

The returned object may implement synchronous `update(delta, elapsed)`,
`resize(viewport)`, `pause()`, `resume()`, `localeChanged(locale)`,
`optionChanged(id, value)`, `shareText(locale)` and `dispose()`, and may set
`renderMode: "on-demand"` or `adaptiveResolution: true`. Times are seconds; delta
is capped at 0.05. Host updates the perspective camera aspect before resize;
orthographic bounds belong to the game. Host renders after update; do not create
another loop or dispose the renderer.

Return `renderMode: "on-demand"` to stop while idle. Call `invalidate()` after an
input and return true from update while animation continues. A resume starts
with delta zero. Hidden pages/manual pause stop simulation and suspend the shared
audio context; stop scheduled game sounds in `pause`. Never create an
`AudioContext` or a mute button: mute, volume and haptics are player options.
Keep keyboard listeners on the canvas and preserve Tab navigation.

The host aborts input/fetch, invokes cleanup in reverse order and releases the
renderer. Register resources immediately, check signal after async work, and do
not dispose a tracked resource twice. Late resources are released immediately.

HUD is game-owned Three.js geometry inside `viewport.safeArea`. Camera-attached
meshes can overlay the scene with depth testing/writing disabled and explicit
render order. The game owns hit targets and accessibility labels. Avoid relying
on global CSS, DOM IDs, platform app modules, storage or routing.

## Manifest extras

`orientation` (`any`/`portrait`/`landscape`, with a rotate prompt on phones),
`howToPlay` (text or `{zh,en}` shown in Options), `cover` (1200×630 image listed in
`files`, used in the lobby and share cards) and `keepAwake` (screen wake lock).

## Options

Export `options` beside `createGame`: items `{ id, section: "settings"|"cheats",
audience?: "player"|"debug", type: "toggle"|"range"|"choice"|"action", label,
default?, min/max/step (range), choices (choice) }`. Settings persist per game on
this device and are restored before `createGame`; cheats reset each session;
debug items show only with `?debug=1`. Read `context.options[id]`, react in
`optionChanged`. Saving after cheats is the game's decision.

## Kit

Through `await context.runtime(name)`: `kit/text.js` (`createText`, system-font
CanvasTexture text; `createHudLayer`, CSS-pixel HUD with safe-area corners),
`kit/input.js` (`createPointer`, `createActions`, `createVirtualControls`),
`kit/loop.js` (`createFixedStep`), `kit/assets.js` (`createAssets(context)` for
JSON, textures, glTF with Draco/KTX2), `kit/random.js` (`createRandom`,
`dailySeed`), and `addons/GLTFLoader.js`, `DRACOLoader.js`, `KTX2Loader.js`. Do not
bundle these or import `/runtime/...` URLs directly: bundles load from the game
origin. The starter in `assets/game.js` uses `kit/text.js`.

## Progress

Feature-detect `context.progress?.version === 1`. Await `load()` before building
resources or starting play. It returns `{kind:"saved", snapshot}`, `{kind:"empty"}`,
or `{kind:"unavailable", reason}`. Unavailable is not an empty save. Validate and
migrate `{schemaVersion: positiveInteger, data: JSON}` in game code; reject
unsupported future versions without saving defaults over them.

At checkpoints, call and handle `save({schemaVersion:1, data})`. The input is
captured immediately. Its `{sequence}` result acknowledges an IndexedDB commit,
without a network request. Limit each snapshot to 64 KiB, finite JSON and depth
32. Save during play, not in teardown; new saves after abort are rejected while
already accepted saves finish. The platform owns local identity and the account-transfer UI. Never store credentials or add separate game-owned storage.

Restart preserves progress. Clear-progress is a separate confirmed player
command. Keep gameplay usable without the capability and state that saving is
unavailable. Wooden Fish 1.2.0 is the reference integration.
