# Wooden Fish / 敲木鱼

Self-contained game source bundle. Copy this entire directory to another project
to develop it, or copy the runtime files listed in `game.json` to publish it.
There are no remote assets, application imports, or package dependencies.
Sound effects, the contact shadow and glow are generated locally; the models are Draco GLBs.

## Progress

The optional `context.progress` v1 capability saves `economy.serialize(state)`:
`{schemaVersion:4, data}` with merit, collected relics, each relic's switch and dragged
position, the chosen skins, the 签谱 (lots drawn, this round's lots and the last draw's local date), the drop pity counter and stats. Every strike saves at once (a local write, so
a tab closed right after a strike keeps it);
every relic and pause also saves. A 1.x save
(`{schemaVersion:1, data:{merit}}`), the unreleased 2.0 draft (schema 2) and 2.0–2.1 saves (schema 3, no lots) migrate.
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
another relic (a press without moving shows what it does). The prayer-bead button opens a panel with three icon tabs: relics (switch each on
and off), skins (the fish's and the cushion's, unlocked by merit) and the 签谱 (sixty
lots; a drawn one opens its card again). With the canvas
focused, Space or Enter strikes, E opens the panel (arrows select, Enter switches,
wears or opens, S changes tabs) and C reads the collected relics; Space, Enter or Escape
put a lot card away. The canvas label includes merit, zen, the
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
  merit and brightens the glow behind the fish (the background stays the site's Duck Yellow);
  two seconds without a strike break the chant and zen ebbs.
- `altar.js`: relics on a shallow arc in front of the fish (tallest at the far ends),
  draggable and switchable; each is a copy of its node in `assets/relics.glb`, with effect
  points and animated pivots. The relic models load in the background, so a new player
  starts after the fish alone; a save with relics waits for them, and a relic dropped before
  they arrive flies out once they do.
- `relics.js`: what relics do in the scene: incense smoke, the lotus lamp's light, prayer
  beads, the nodding little monk, wind chimes, fortune sticks, and petals for good luck.
- `effects.js`: zen glow, rays for the gold-lacquered fish and camera-facing sound rings.
- `sound.js`: crisp hollow knocks (a mallet click over damped wood modes, four detuned
  variants) with a zen-dependent, darkening hall (softer with the mallet wrap, deeper with the
  rosewood mallet), bowl, temple bell and wind chimes, all in D major pentatonic and through
  a gentle compressor, and the chant voice,
  which speeds up (up to 2×) on fast beats and sounds through a soft echo and a hall.

The mallet is a damped spring: a press kicks it, and sound, haptics and a sound ring
fire at contact; the wooden fish stays rigid. The game keeps its own clock from `performance.now()` while running
and renders only while something moves.

## Polish and 每日一签 (2.2.0)

- `lots.js`: the sixty lots (four-line verse and 解曰 in Chinese, a couplet and its meaning in
  English) and their titles (第十七签 · 庚辰 · 上签). The first 入定 of each local day draws one
  not yet drawn this round; a bamboo stick flies out of the fish's mouth and a card opens.
  While it is open zen holds; the first second and a half of presses are absorbed so a steady
  beat cannot dismiss it unread. Putting the day's lot away brings 30 s of 好运. The share
  text adds the day's lot.
- `floats.js`: words that float up from the fish on some strikes (about 1 in 8, 1 in 3 in
  入定), pure decoration. Like the lots they joke about everyday life instead of chasing memes.
- Zen lights the fish from within: a warm emissive term masked by the baked groove and slit
  vertex colors, and the mallet head's own emissive material.
- The camera frames the fish, the resting mallet and the shown relics (points near their
  silhouettes) in the stage the HUD leaves free and eases over about a second as relics
  arrive or the panel opens; a drag holds it. Relics are 2.2× their modeled size.
- The HUD follows the player's own controls (DESIGN.md): Duck Yellow surfaces with a 2px Duck
  Ink border, 44px square buttons with a 1px border (the 法物 button mirrors the menu button),
  ink-filled "on" cells, brown disabled ones, the player's dialog backdrop behind the lot card
  and Beak Deep instead of gold for 福报. Labels shrink to fit their cells and cards.

## Local development

From this directory, without the parent repository:

```sh
npm test
npm run simulate   # progress curve of four lives and a mashing player
npm run model
npm run relics
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
a GLB, which `gltf-transform` (run through `npx`, not a dependency) compresses with Draco:
Blender's ARM build has no Draco library, and the platform's loader decodes Draco.
Materials and the procedural wood grain are in `game.js`.

`npm run relics` rebuilds `assets/relics.glb` (needs the uncompressed `/tmp/wooden-fish.glb`
from `npm run model` for the rosewood mallet). `dev/fetch-blenderkit.py` downloads three free
CC0 BlenderKit models into `~/.cache/fundev-blenderkit` (no account needed; the .blend files
stay outside the repository), and `dev/build-relics.py` applies their modifiers, scales each
relic, reduces it to 800–1,800 triangles, bakes its colors (Cycles) and repaints each face
with the nearest color of a shared palette, so no textures ship. It models the other relics (chanting box, bronze bowl, wind chime, mallet wrap, fortune sticks,
little monk, prayer beads, temple bell) and reuses the fish's mallet for the rosewood mallet.
All twelve stay within about 16,000 triangles (`dev/models.test.mjs` checks the budget, the
size and every hook). Effect points (`tip`, `mouth`, `flame`, `vent`) and animated pivots
(`nod`, `loop`, `chimes`) are empties inside each relic.

One style for everything: the palette takes the fish's wood, red lacquer, rosewood, bronze and
gold and the cushion's red cloth and straw (materials named `wood`, `lacquer`, `gold` … in the
GLB), and `game.js` gives the relics' `wood`, `dark-wood` and `rosewood` the fish's
procedural grain, so the altar reads as one set of lacquered wooden toys.

| Relic | BlenderKit model | Author | License |
| --- | --- | --- | --- |
| 香炉 Censer | Chinese Tripod Censer | Free poly | CC0 |
| 莲花灯 Lotus lamp | Chinese lotus lamp | Free poly | CC0 |
| 线香 Incense (burner) | Incense Burner | Seatla Morake | CC0 |

Only CC0 models are used, so the built GLB can live in this public repository.

`dev/`, `package.json` and this README are development files and are excluded
from the platform's published bundle. The wooden fish was generated with Tripo; no
texture is included.

The chant voice is a 清念 recitation of 南无阿弥陀佛; it sounds once the chanting box (录音机)
relic is collected.
`npm run voice -- <recording.mp3>` (needs `uv`) cuts the six syllables at hand-picked
points (see `dev/chant-voice.py`), adds a light chorus and writes `assets/chant.wav` and the slices in
`assets/chant.json`; the recording stays outside the repository. Before
2.0.0 the voice was synthesized with Qwen3-TTS (see Git history).
