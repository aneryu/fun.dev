# Wooden Fish / 敲木鱼

Self-contained game source bundle. Copy this entire directory to another project
to develop it, or copy the runtime files listed in `game.json` to publish it.
There are no remote assets, application imports, or package dependencies.
Sound effects, the contact shadow, glow and the relic models are generated locally.

## Progress

The optional `context.progress` v1 capability saves `economy.serialize(state)`:
`{schemaVersion:3, data}` with merit, collected relics, each relic's switch and dragged
position, the chosen skins, the drop pity counter and stats. Saves are throttled on both edges: the
first change after a quiet spell saves at once, later changes within five seconds;
every relic and pause also saves. A 1.x save
(`{schemaVersion:1, data:{merit}}`) and the unreleased 2.0 draft (schema 2) migrate.
`economy.deserialize` rejects anything else; unsupported saves fail before game
resources are allocated and remain available for export through the player.
Restart preserves progress; the player's confirmed Reset progress action clears it. Without the capability, gameplay
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
- `runtime(name)`: `kit/assets.js` loads the GLB, `kit/text.js` draws the HUD text.

The returned object exposes `renderMode: "on-demand"`, `update(delta)`, `resize`,
`pause`, `resume`, `localeChanged`, `optionChanged`, `shareText`, and `dispose`. Call `resize` after creation
and after changing viewport dimensions; update the perspective camera aspect
in the host. Delta is in seconds. Keep rendering while `update` returns true;
render once and stop otherwise. Resume with delta zero. Pause/backgrounding must
stop frames and make the game mount inert. Dispose the game, run registered
cleanup callbacks/resources, and release host-owned mounts and rendering state.

The game creates no DOM and ships no HTML/CSS. Its local `hud.js` draws the merit,
the 法物 button and panel and a relic's info card with kit text and flat
rectangles in the same render pass as the model, inside the platform's
`viewport.safeArea`; there is deliberately little text on screen. The game owns
layout, hit testing and input: a press anywhere on the stage strikes at once
(`pointerdown`, several fingers may alternate) unless it lands on the HUD or on a
relic, which can then be dragged along the floor, never into the fish, behind it or into
another relic (a press without moving shows what it does). The prayer-bead button opens a panel with two icon tabs: relics (switch each on
and off) and skins (the fish's and the cushion's, unlocked by merit). With the canvas
focused, Space or Enter strikes, E opens the panel (arrows select, Enter switches or
wears, S changes tabs) and C reads the collected relics. The canvas label includes merit, zen, the
collection and the controls; merit, 入定, relics, luck and switches are sent to
`context.announce`.

## API v2 integration (1.2.0)

- Sound plays through `context.audio`; the platform's Options menu owns mute and
  volume, unlocks audio on a gesture and suspends it while paused. The game no
  longer draws its own speaker button or binds M.
- Each strike calls `context.haptics.vibrate("tap")` and reports loading through
  `context.reportLoading`.
- `options` declares a sound-ring setting, player cheats (Merit +1000, collect every
  relic, unlock every skin) and debug cheats: steady auto strike and an immediate drop. Cheat merit is saved like
  normal play.
- `shareText(locale)` returns the merit and the relic count for the platform's Share
  button, marking sessions that used cheats.
- `assets/cover.jpg` (1200×630) is a screenshot of the game, used for the lobby
  and share cards. No platform HUD, styles, widgets, catalog or router is
required. Rendering geometry does not provide separate screen-reader buttons;
keyboard actions and the canvas label provide the nonvisual interface.
The platform menu belongs to the host; allow a small top-left safe-area margin.

## Zen and relics (2.0.0)

The design and its reasons are in `DESIGN-economy.md`. Modules:

- `economy.js`: merit, the twelve relics, drops, temporary luck, saves and number
  formatting. Relics only change how striking sounds and looks, never the numbers. Pure
  logic; `dev/simulate.mjs` collects whole sets with it, and `dev/economy.test.mjs` checks
  the pacing.
- `zen.js`: one rhythm detector for the chant and the zen meter. Three knocks warm up the
  chant (南无阿弥陀佛, one syllable per strike); steady beats deepen zen, which multiplies
  merit and warms the scene; two seconds without a strike break the chant and zen ebbs.
- `altar.js`: relics on a shallow arc in front of the fish, draggable and switchable,
  behind a `buildItem` provider (generated low-poly now) that a GLB loader can replace.
- `relics.js`: what relics do in the scene: incense smoke, the lotus lamp's light, prayer
  beads, the nodding little monk, wind chimes, fortune sticks, and petals for good luck.
- `effects.js`: zen glow, rays for the gold-lacquered fish and camera-facing sound rings.
- `sound.js`: knocks with a zen-dependent hall (softer with the mallet wrap, deeper with the
  rosewood mallet), bowl, temple bell and wind chimes, and the chant voice,
  which speeds up (up to 2×) on fast beats and sounds through a soft echo and a hall.

The mallet is a damped spring: a press kicks it, and sound, haptics and a sound ring
fire at contact; the wooden fish stays rigid. The game keeps its own clock from `performance.now()` while running
and renders only while something moves.

## Local development

From this directory, without the parent repository:

```sh
npm test
npm run simulate   # progress curve of four lives and a mashing player
npm run model
npm run voice -- <recording.mp3>
```

Tests need Node.js 22+; no install is needed. `assets/wooden-fish.glb` is included,
so model regeneration is only needed after replacing `dev/tripo-source.glb`. It
needs Blender 4.2+ on PATH and the parent repository's `three` package:
`dev/decode-meshopt.mjs` decodes the meshopt-compressed Tripo export (the
platform has no meshopt decoder), then `dev/clean-model.py` names the meshes
`Fish`, `Cushion`, `MalletHead` and `MalletHandle`, replaces the lumpy generated
cushion with a clean torus of the same size, smooths the fish, bakes ambient
occlusion (Cycles) and each vertex's depth below the fish's convex hull into its
vertex colors, which shade the carving's grooves and the hollow slit, applies transforms and exports
an uncompressed GLB. Materials and the procedural wood grain are in `game.js`.

`dev/`, `package.json` and this README are development files and are excluded
from the platform's published bundle. The model was generated with Tripo; no
texture is included.

The chant voice is a 清念 recitation of 南无阿弥陀佛; it sounds once the chanting box (录音机)
relic is collected.
`npm run voice -- <recording.mp3>` (needs `uv`) cuts the six syllables at hand-picked
points (see `dev/chant-voice.py`), adds a light chorus and writes `assets/chant.wav` and the slices in
`assets/chant.json`; the recording stays outside the repository. Before
2.0.0 the voice was synthesized with Qwen3-TTS (see Git history).
