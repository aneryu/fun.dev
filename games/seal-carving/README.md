# Carve a Seal / 刻一方印

Self-contained game source bundle for fun.dev (runtime API v2). The runtime files are
listed in `game.json`; everything else here is development tooling. There are no remote
assets, model files or package dependencies: the stones, their reliefs, the knife, the
sounds and the prints are all generated in code.

The game follows a seal-carving video step by step: chamfer the face's edges, cut the
border, cut a cross into four cells, carve four characters in the folded 九叠篆 style,
blow the powder away. The face is carved mirrored; the album shows each seal's print.

## How it plays

- Dragging anywhere moves the knife by the finger's own movement (it never jumps under the
  finger). Pressing the red grip on its handle drives it into the stone; pushing up the
  screen carves, pulling back slides it down its own groove; lifting the finger lifts it.
- The knife only travels forward (screen up), as in a 冲刀 push: lines across are cut after
  turning the stone with ‹ ›. Nothing snaps to the draft: wherever the knife is pushed it
  cuts, and wobbles and overruns stay in the stone. A draft line counts as cut where a groove
  runs over it; at 90% coverage its last gaps are cut when the knife lifts.
- The knife in the stone is a stick-slip system tuned to the video's sound (pushes of
  0.25–0.45 s, cracks 15–40 ms apart): the hand pulls the tip through a spring, the tip
  stays stuck until the pull passes the stone's strength, then a flake breaks off. Each
  crack sounds, vibrates, throws a flake and powder at once. Stones differ in hardness,
  flake size and hard grains (`stones[*].carve` in `stone.js`).
- Mouse: move to aim, hold the button and drag up to carve. Keyboard: arrows move the knife;
  hold Space to press it in, then Up pushes and Down pulls back; Q/E turn, B blows, A opens
  the album.

## Files

| File | Role |
| --- | --- |
| `game.js` | Scene, camera, input, the knife's simulation, stages, album, saving |
| `seals.js` | The six seals, their glyphs (polylines on a 20 × 20 grid) and the face layout |
| `carve.js` | Strokes, draft coverage, the saved form, and painting the groove mask |
| `stone.js` | Stone materials, generated reliefs, and the face shader (ink, grooves, powder, draft) |
| `knife.js` | The knife model and its materials |
| `effects.js` | Flakes, crumbs and the puff of powder when blown |
| `sound.js` | Synthesized cracks, grinding, breath and taps |
| `hud.js` | Title, five-step progress, buttons, toast, card and album, drawn in Three.js |
| `save.js` | The progress snapshot and the unlock order |

## Progress

With `context.progress` v1 the game saves `{schemaVersion: 1, data: {current, seals,
unlockAll}}`. Each seal keeps its strokes as base64 (`carve.js` `serialize`: per stroke
an int16 start, its axis and blade, and int8 wobble every 0.006 face units); six finished
seals stay under 40 KB. It saves whenever the knife lifts and when a seal is finished.
Unsupported saves are refused before play and stay exportable through the player; without
the capability the game plays and its label says saving is unavailable.

## Development

```sh
npm test                      # unit tests in dev/ (also run by the root npm test)
npm run preview               # node dev/preview.mjs: prints and faces of every seal as PNG
node dev/playtest.mjs <url> <out> [mobile|desktop|cover] [script.json]
```

`dev/playtest.mjs` drives the running game in Chromium with touch, mouse, cheats and
screenshots. `dev/cover.jpg` (1200 × 630) is a cover taken with it. It is not listed in
`game.json` yet: the lobby works offline only for covers of games already opened, and the
platform's offline check fails for an uncached second cover. Once the service worker keeps
lobby covers, move it to `assets/cover.jpg` and add `"cover"` and the file to `game.json`.
Change `version` in `game.json` whenever runtime files change.
