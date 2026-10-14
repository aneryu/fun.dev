# Wooden Fish / 敲木鱼

Self-contained game source bundle. Copy this entire directory to another project
to develop it, or copy `game.js`, `hud.js`, `sound.js`, and `assets/` to publish
it. There are no remote assets, application imports, or package dependencies.
Audio and the contact shadow are generated locally.

## Progress

The optional `context.progress` v1 capability saves `{schemaVersion:1,
data:{merit}}` after each strike. The loaded merit must be a nonnegative safe
integer. Unsupported saves fail before game resources are allocated and remain
available for export through the player. Restart preserves merit; the player's
confirmed Reset progress action clears it. Without the capability, gameplay
works and the canvas accessibility label states that saving is unavailable.
The game does not access IndexedDB, Cookies, or cloud credentials itself.

## Foundation dependencies

The host provides Three.js (tested with 0.186.1), a renderer/frame loop, a sized
canvas, and the API v2 context below. Standard browser APIs
include WebGL, Web Audio, fetch and AbortSignal.

`createGame(context)` is the async ESM entry point. Required context fields:

- `THREE`, `scene`: engine and session scene.
- `canvas`: input event target and accessible game label.
- `viewport`: live `{width, height, pixelRatio}` in CSS pixels plus render DPR.
- `setCamera(camera)`: selects the camera rendered by the host.
- `asset(path)`: resolves a relative URL within this directory, wherever hosted.
- `signal`: aborted at teardown; used by asset loads and event listeners.
- `track(resource)`: registers a disposable resource and returns it.
- `onCleanup(fn)`: registers a teardown callback, including before async loading.
- `invalidate()`: requests frames for this on-demand game.
- `locale`: `zh` or `en` (other/absent values fall back to English).
- `reducedMotion`: boolean; disables decorative movement when true.
- `viewport.safeArea`: `{top, right, bottom, left}` insets kept clear of HUD.
- `audio`: `{context, destination}` shared Web Audio graph (optional; without it
  the game plays silently and labels sound as unavailable).
- `announce(text)`, `haptics.vibrate("tap")`, `reportLoading(fraction)`.
- `options` (live values of the exported `options`) and `cheatsUsed`.

The returned object exposes `renderMode: "on-demand"`, `update(delta)`, `resize`,
`pause`, `resume`, `localeChanged`, `optionChanged`, `shareText`, and `dispose`. Call `resize` after creation
and after changing viewport dimensions; update the perspective camera aspect
in the host. Delta is in seconds. Keep rendering while `update` returns true;
render once and stop otherwise. Resume with delta zero. Pause/backgrounding must
stop frames and make the game mount inert. Dispose the game, run registered
cleanup callbacks/resources, and release host-owned mounts and rendering state.

The game creates no DOM and ships no HTML/CSS. Its local `hud.js` draws the
counter and floating feedback with Three.js geometry in the same render pass as
the model, below the platform's `viewport.safeArea`. The game owns layout,
raycast hit testing and input. Tap the fish to strike; with the canvas focused,
Space or Enter strikes. The canvas label includes localized controls and score;
merit changes are also sent to `context.announce`, which the platform coalesces.

## API v2 integration (1.2.0)

- Sound plays through `context.audio`; the platform's Options menu owns mute and
  volume, unlocks audio on a gesture and suspends it while paused. The game no
  longer draws its own speaker button or binds M.
- Each strike calls `context.haptics.vibrate("tap")` and reports loading through
  `context.reportLoading`.
- `options` declares a persistent “+1” setting, a player cheat (Merit +1000) and
  a debug-only auto-strike cheat. Cheat merit is saved like normal play.
- `shareText(locale)` returns the merit for the platform's Share button, marking
  sessions that used cheats.
- `assets/cover.jpg` (1200×630) is a screenshot of the game, used for the lobby
  and share cards. No platform HUD, styles, widgets, catalog or router is
required. Rendering geometry does not provide separate screen-reader buttons;
keyboard actions and the canvas label provide the nonvisual interface.
The platform menu belongs to the host; allow a small top-left safe-area margin.

## Local development

From this directory, without the parent repository:

```sh
npm test
npm run model
```

Tests need Node.js 22+; no install is needed. Model regeneration optionally needs
Blender 4.0 on PATH. `dev/create-model.py` writes `assets/wooden-fish.json` relative
to itself. The existing model is included, so Blender is unnecessary at runtime.

`dev/`, `package.json` and this README are development files and are excluded
from the platform's published bundle. All model geometry is locally authored;
no downloaded commercial mesh or texture is included.
