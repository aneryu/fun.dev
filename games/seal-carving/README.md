# Carve a Seal / 刻一方印

Self-contained game source bundle for fun.dev (runtime API v2). The runtime files are
listed in `game.json`; everything else here is development tooling. There are no remote
assets, model files or package dependencies: the stones, their reliefs, the knife, the
sounds and the prints are all generated in code.

The game follows a seal-carving video step by step: chamfer the face's edges, cut the
border, cut a cross into four cells, carve four characters in small seal script (小篆),
blow the powder away. The face is carved mirrored; the album shows each seal's print.

## How it plays

- The characters are 朱文, raised, in the small seal script of the 说文解字 (see Glyphs below),
  stretched to fill their square cells and redrawn at one even stroke width. Steps: chamfer,
  border, cross (grooves), then each character in reading order (its own step), then blowing
  the powder.
- A character step closes the camera in on its cell and turns the stone about it. Its ground
  (everything but the strokes) is shown red and covered by guides, one per push, across, upright
or at 45° (picked greedily to cover the ground with few pushes); character
  grooves clear the ground they pass, never the strokes (painted back as uncut stone), and
  leave a fine tool mark, so wider patches cleared with several pushes read as hatched. Once
  85% of the ground is cleared, or every guide is cut, the rest of the cell is cleared and the
  next character comes up.
- A fresh seal opens with a card: its print-to-be, its stone and the steps. Each finished
  step names the next. The face is seen nearly straight down (about 86°) on a carver's pad.
  Everything is on or beside the knife; only the album and Redo wait in the top corner, in
  one row; Blow sits just below the stone. The album shows seals still to carve as faint
  prints.
- The knife has two zones: dragging its wrapped handle moves it (the touched spot stays under
  the finger); holding its cinnabar-dyed grip drives it in. As in the video's 冲刀 it only
  pushes up the screen, away from the carver, the finger pushing it one to one; drawn back it
  slides down its groove. Letting go lifts it.
- The stone turns under the knife to any angle: a finger anywhere off the knife turns it,
  settling lightly every 15° and firmly at each quarter turn (a click each), so slanted
  strokes can be cut. Strokes are stored at any of 256 angles. Proof (试印, top right) stamps
  the face as it stands.
- Line assist (a setting, on by default): within 16 CSS px of an open draft line (for the
  characters, of an uncut stroke's centre line) along the knife, the cutting point settles onto
  it, and onto its nearer end; the line turns yellow. Undo (↶, left of the point, tap only)
  takes back swipes; Redo clears the current step (or the whole seal).
- A quiet marker shows the cutting point: a thin bar as wide as the groove and a dot ahead.
- Keyboard: arrows move the knife; hold Space and Up to push; Q/E turn the stone, Z undoes,
  B blows, A opens the album.
- The knife in the stone is a stick-slip system tuned to the video's sound (pushes of
  0.25–0.45 s, cracks 15–40 ms apart): the hand pulls the tip through a spring, the tip stays
  stuck until the pull passes the stone's strength, then a flake breaks off. Each crack sounds,
  vibrates, throws a flake and powder at once. Stones differ in hardness, flake size and hard
  grains (`stones[*].carve` in `stone.js`).

## Files

| File | Role |
| --- | --- |
| `game.js` | Scene, camera, input, the knife's simulation, stages, album, saving |
| `seals.js` | The four seals, the face layout and the guides over each character's ground |
| `glyphs.js` | Generated: each character's stroke mask (84 × 84 bits), from `dev/build-glyphs.mjs` |
| `carve.js` | Strokes, draft coverage, the saved form, and painting the groove mask |
| `stone.js` | Stone materials, generated reliefs, and the face shader (ink, grooves, powder, draft) |
| `knife.js` | The knife model and its materials |
| `effects.js` | Flakes, crumbs and the puff of powder when blown |
| `sound.js` | Synthesized cracks, grinding, breath and taps |
| `hud.js` | Title, step progress, buttons, toast, card and album, drawn in Three.js |
| `save.js` | The progress snapshot and the unlock order |

## Progress

With `context.progress` v1 the game saves `{schemaVersion: 1, data: {current, seals,
unlockAll}}`. Each seal keeps its strokes as base64 (`carve.js` `serialize`: per stroke
an int16 start, its angle, blade and step, and int8 wobble every 0.006 face units); all
finished seals stay under 40 KB; offsets are stored as runs, and the cleared ground is replayed from
the strokes. Schema 4 (the 说文 glyphs); an older save keeps its place but drops its carvings. It saves whenever the knife lifts and when a seal is finished.
Unsupported saves are refused before play and stay exportable through the player; without
the capability the game plays and its label says saving is unavailable.

## Development

```sh
npm test                      # unit tests in dev/ (also run by the root npm test)
npm run preview               # node dev/preview.mjs: every seal carved in full, print and face as PNG
node dev/build-glyphs.mjs     # regenerates glyphs.js from dev/shuowen/*.svg
node dev/playtest.mjs <url> <out> [mobile|desktop|cover] [script.json]
node dev/bot.mjs '<url>?debug=1' [out] [hand-error-px]   # plays the bench's seal by touch
```

`dev/playtest.mjs` drives the running game in Chromium with touch, mouse, cheats and
screenshots. `dev/cover.jpg` (1200 × 630) is a cover taken with it. It is not listed in
`game.json` yet: the lobby works offline only for covers of games already opened, and the
platform's offline check fails for an uncached second cover. Once the service worker keeps
lobby covers, move it to `assets/cover.jpg` and add `"cover"` and the file to `game.json`.
Change `version` in `game.json` whenever runtime files change.

## Glyphs

The characters are the small seal script (小篆) of the 说文解字 as drawn in Wikimedia Commons'
"Shuowen seal script characters" category (files `<character>-seal.svg`, each marked public
domain). The originals are kept in `dev/shuowen/`; `dev/build-glyphs.mjs` stretches each to its
cell, thins it to centre lines and redraws them at one width into `glyphs.js`. The 说文 has no
玩 or 吃, so 只是好玩 and 好好吃饭 wait for a source; 开 and 万 are carved as 開 and 萬.
