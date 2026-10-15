# Carve a Seal / 刻一方印

Self-contained game source bundle for fun.dev (runtime API v2). The runtime files are
listed in `game.json`; everything else here is development tooling. There are no remote
assets, model files or package dependencies: the stones, their reliefs, the knife, the
sounds and the prints are all generated in code.

The game follows a seal-carving video step by step: chamfer the face's edges, cut the
border, cut a cross into four cells, carve four characters in the folded 九叠篆 style,
blow the powder away. The face is carved mirrored; the album shows each seal's print.

## How it plays

- The characters are 朱文, raised. Steps: chamfer, border, cross (grooves), characters (each
  stroke's outline), clearing (the ground around the strokes), blowing the powder.
- A fresh seal opens with a card: its print-to-be, its stone and the six steps. Each finished
  step names the next. The face is seen square from above (about 78°) on a carver's pad.
  Everything is on or beside the knife; only the album and Redo wait in the top corner, in
  one row; Blow sits just below the stone. The album shows seals still to carve as faint
  prints.
- The knife has two zones: dragging its wrapped handle moves it (the touched spot stays under
  the finger); holding its cinnabar-dyed grip drives it in. As in the video's 冲刀 it only
  pushes up the screen, away from the carver, the finger pushing it one to one; drawn back it
  slides down its groove. Letting go lifts it.
- The stone turns under the knife: a finger anywhere off the knife turns it about its centre,
  settling near each quarter turn (with a click) and squaring up when let go. The knife only
  goes in while the stone is square.
- Line assist (a setting, on by default): within 16 CSS px of an open draft line (for the
  characters, of an uncut stroke's centre line) along the knife, the cutting point settles onto
  it, and onto its nearer end; the line turns yellow. For the characters the knife has two
  edges, one each side of the stroke, so one push cuts both sides of its outline. Grooves and
  clearing never touch the strokes: the strokes are painted back as uncut stone.
- Clearing: holding the grip, the knife scrapes a broad swath wherever the finger takes it; at
  85% the rest is cleared. Undo (↶ beside the point) takes back swipes in the cutting steps;
  Redo clears the current step (or the whole seal).
- A quiet marker shows the cutting point: a thin bar as wide as the groove (two for the
  characters), a dot ahead; in the clearing, a faint ring as wide as the scrape.
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
an int16 start, its axis, blade and step, and int8 wobble every 0.006 face units); six finished
seals stay under 40 KB, plus 2 KB each for the cleared ground (one bit per cell of a
128 × 128 grid). It saves whenever the knife lifts and when a seal is finished.
Unsupported saves are refused before play and stay exportable through the player; without
the capability the game plays and its label says saving is unavailable.

## Development

```sh
npm test                      # unit tests in dev/ (also run by the root npm test)
npm run preview               # node dev/preview.mjs: prints and faces of every seal as PNG
node dev/playtest.mjs <url> <out> [mobile|desktop|cover] [script.json]
node dev/bot.mjs '<url>?debug=1' [out] [hand-error-px]   # plays the bench's seal by touch
```

`dev/playtest.mjs` drives the running game in Chromium with touch, mouse, cheats and
screenshots. `dev/cover.jpg` (1200 × 630) is a cover taken with it. It is not listed in
`game.json` yet: the lobby works offline only for covers of games already opened, and the
platform's offline check fails for an uncached second cover. Once the service worker keeps
lobby covers, move it to `assets/cover.jpg` and add `"cover"` and the file to `game.json`.
Change `version` in `game.json` whenever runtime files change.
