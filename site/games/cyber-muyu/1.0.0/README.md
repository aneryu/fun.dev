# Wooden Fish / 敲木鱼

Self-contained game source bundle. Copy this entire directory to another project
to develop it, or copy `game.js`, `hud.js`, `sound.js`, and `assets/` to publish
it. There are no remote assets, application imports, or package dependencies.
Audio and the contact shadow are generated locally.

## Foundation dependencies

The host provides Three.js (tested with 0.186.1), a renderer/frame loop, a sized
canvas, and the API v1 context below. Standard browser APIs
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

The returned object exposes `renderMode: "on-demand"`, `update(delta)`, `resize`,
`pause`, `resume`, `localeChanged`, and `dispose`. Call `resize` after creation
and after changing viewport dimensions; update the perspective camera aspect
in the host. Delta is in seconds. Keep rendering while `update` returns true;
render once and stop otherwise. Resume with delta zero. Pause/backgrounding must
stop frames and make the game mount inert. Dispose the game, run registered
cleanup callbacks/resources, and release host-owned mounts and rendering state.

The game creates no DOM and ships no HTML/CSS. Its local `hud.js` draws the
counter, floating feedback and speaker icon with Three.js geometry in the same
render pass as the model. The game owns layout, raycast hit testing and input.
Tap the fish to strike or the speaker to mute; with the canvas focused, Space or
Enter strikes and M toggles sound. The canvas label includes localized controls,
score and sound state. No platform HUD, styles, widgets, catalog or router is
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
