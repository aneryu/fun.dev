# Runtime API v1

The platform creates a session and awaits `createGame(context)`. A game module's
top level must not allocate session resources or start gameplay; modules are
cached and restarting calls the factory again.

| Context | Meaning |
| --- | --- |
| `apiVersion` | `1` |
| `THREE` | Shared engine; current platform pin `0.186.1` |
| `scene`, `camera` | Session scene and default perspective camera |
| `setCamera(camera)` | Select the camera used by the container |
| `renderer`, `canvas` | Host-owned renderer and focusable input canvas |
| `viewport` | Live CSS-pixel `width`, `height`, and capped `pixelRatio` |
| `locale` | Current `zh` or `en` |
| `asset(relativePath)` | Resolve a file inside this bundle/version |
| `signal` | Aborted at session teardown; use for fetch and listeners |
| `track(resource)` | Own a disposable geometry/material/texture exactly once |
| `onCleanup(fn)` | Register synchronous cleanup, including before awaits |
| `invalidate()` | Request a frame after input/asynchronous changes |
| `progress` | Optional `{ version: 1, load(), save(snapshot) }`; see below |
| `launchReason` | `"open"` or `"restart"` |
| `reducedMotion` | User preference at session creation |

The returned object may implement synchronous `update(delta, elapsed)`,
`resize(viewport)`, `pause()`, `resume()`, `localeChanged(locale)`, and `dispose()`.
Times are seconds; delta is capped at 0.05. Host updates the perspective camera
aspect before resize; orthographic bounds belong to the game. Host renders after
update; do not create another loop or dispose the renderer.

Return `renderMode: "on-demand"` to stop while idle. Call `invalidate()` after an
input and return true from update while animation continues. A resume starts
with delta zero. Hidden pages/manual pause stop simulation; game audio must also
pause. Keep keyboard listeners on the canvas and preserve Tab navigation.

The host aborts input/fetch, invokes cleanup in reverse order and releases the
renderer. Register resources immediately, check signal after async work, and do
not dispose a tracked resource twice. Late resources are released immediately.

HUD is game-owned Three.js geometry. Camera-attached meshes can overlay the
scene with depth testing/writing disabled and explicit render order. The game
owns hit targets and accessibility labels. Avoid relying on global CSS, DOM IDs,
platform app modules, storage, routing or a platform-specific widget API.

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
command. Older hosts may omit the capability: keep gameplay usable and state
that saving is unavailable. Wooden Fish 1.1.0 is the reference integration.
