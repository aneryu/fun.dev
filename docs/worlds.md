# Scenes and worlds: design

Status: designed and approved 2026-10-19 (the owner's "同意，并继续"); step 1 of the rollout is
built the same day (section 11). It follows the discussion of that day: what else the workshop
should do, with scene and map building as the example. The [roadmap](platform-roadmap.md)'s
workshop stage 2 ("scatter and instancing, scene assembly from library models") expands into
this layer.

## 1. Decisions this design serves

Agreed in the discussion of 2026-10-19:

1. **Authored, invented places.** A scene or world is designed, from a diorama to an open
   world; it is never real geography. 帝都's pipeline (real data regularised privately) stays a
   game pipeline; its street generator, streaming and closed-loop audits are donors of code, not
   the model for this design.
2. **Every genre.** The same building blocks must compose the places every kind of game needs
   (section 8 walks through sixteen), with nothing genre-specific in the format.
3. **three.js only.** Scenes and worlds come out as `.fun3d` tiles and a world manifest read by
   the fun.dev runtime, which is three.js. There is no flattened GLB for other engines, so
   instancing, batching, Jolt physics, height-field collision and streaming are designed the
   three.js way. The roadmap's "outputs, equal weight" (standard GLB beside `.fun3d`) keeps
   applying to models; it does not apply to this layer.
4. **The runtime is a package.** The runtime kit ships as an npm package, like the workshop, so
   an agent uses worlds in any three.js project, not only in the fun.dev player (recommended in
   the discussion; taken as accepted with the owner's "继续").
5. **Rules are data, run in two places.** Programs and parameters at the source, data at
   runtime ([parametric pillar](platform-roadmap.md#parametric-and-procedural-extend-and-derive-decided-2026-10-19)):
   scatter, kit assembly and terrain rules are data; Node bakes them into tiles at build time,
   and the runtime kit executes the same rule data at run time for games that generate as they
   play (dungeons, endless runners, strategy decorations). No file carries code.
6. **Scenes stay placement lists; behaviour stays in game code** ([format decision 2](model-format.md#1-decisions-this-design-serves)).
   The data games need is three things: markers, zones and paths, each with tags and the game's
   own parameters; games read them through the kit.
7. **Agents first.** Every capability is a command with a schema, in the page, the npm package
   and MCP; agents verify with map renders, sampled views and audits, never by eye alone.
8. **Design first.** As with the format: this document, a prototype of each step, then
   implementation after review.

## 2. Principles

1. **One format from a diorama to a world.** A world is a manifest listing tiles; a scene is a
   world with one tile; a tile is a `.fun3d` file. A tile loads alone like any model
   (`fun3d.load` and `models.place`), so a toy's single scene needs nothing the format does not
   already have.
2. **References, not copies.** Tiles place library models by pinned `id@version`; the game
   build resolves the closure into `models.lock` as it does for references today. A thousand
   lamps are one file plus a thousand transforms.
3. **Intent, not rendering** (format principle 1). A tile says what stands where, which ground
   is which surface, where paths and zones are. The kit decides instancing, batching, LOD,
   which lights are real, when a tile loads and when its bodies enter the physics world.
4. **Data only, validated, bounded** (format principle 8), including the rules: a rule is a JSON
   record with a schema, evaluated by the kit's assembler, never a function.
5. **Deterministic derivation.** Baking a tile depends on (source, generator stamp, parameters,
   seed) and is cached by that key, so an edit re-derives only the tiles it touches and a
   rebuild changes nothing it did not touch.
6. **Mobile first.** Every tile carries a budget; the audits enforce it before a world ships.
7. **Extensible on purpose** (format principle 6). Ground representations, data layers and
   generators enter as `fun3d.*` extensions named in `requires`; a runtime that lacks one
   refuses the file by name rather than guessing. Voxel ground, floating origin and baked
   lighting are planned this way (appendix A).
8. **Nothing without a producer and a consumer** (format principle 10). The first release holds
   what step 1 of the rollout builds; later steps add their extensions when both exist.

## 3. Files

### 3.1 A tile

A tile is a `.fun3d` 1.0 file ([format](model-format.md)) that uses the extensions below. Its
nodes are the placement list; its geometries are what the generators baked (ground, roads,
tracks); its editing section keeps the workshop source, so a tile reopens for editing.

**Placed models.** `refs` may name whole models, and a node may be a copy of one:

```jsonc
"refs": [{ "id": "lamp", "model": "street_lamp_01@v005" }, { "id": "huai", "model": "tree_huai_01@v002" }],
"nodes": [
  { "id": "lamp_3", "parent": "root", "transform": { "position": [12, 0, -4] }, "tags": ["lamp"],
    "model": { "ref": "lamp", "variants": { "arms": "double" }, "tint": [1, 1, 1, 1] } },               // one editable copy
  { "id": "huai_row_w", "parent": "root", "model": { "ref": "huai" },
    "placements": { "count": 140, "transforms": { "stream": "s8", "format": "mat4" }, "tint": { "stream": "s9", "format": "unorm8x4" } },
    "derived": { "rule": "trees_west", "hash": "sha256:…" } }                                           // a scatter result: one node, many copies
]
```

A `model` node brings the referenced model's own nodes, lights, sockets and bodies with every
copy, as `models.place` does today; `placements` on it is the instanced form the format already
has for meshes. `derived` marks what a rule produced, so re-deriving replaces exactly those nodes
and hand edits beside them survive. Reference depth becomes two for tiles (tile → model → the
model's skeleton base), still acyclic; the validator checks the closure.

**Ground.** Three representations, each an extension on the tile's top level naming the node
that carries its baked mesh and body:

```jsonc
"extensions": {
  "fun3d.terrain": {                                           // a height field
    "node": "ground", "origin": [-128, 0, -128], "cell": 2, "samples": [129, 129],
    "heights": { "stream": "s40", "format": "float32" },
    "surfaces": { "stream": "s41", "format": "uint8" },        // one per cell: index into surfaceTable
    "surfaceTable": [{ "id": "grass", "color": "#6b8f3a", "friction": 0.8, "tags": ["soft"] },
                     { "id": "sand", "color": "#d9c58a", "friction": 0.6, "tags": ["slow"] }],
    "water": [{ "level": 2.0 }]                                // optional, per region later
  },
  "fun3d.grid": {                                              // a cell map: strategy, farms, dungeons
    "node": "floor", "origin": [0, 0, 0], "cell": 2, "size": [64, 64],
    "cells": { "stream": "s42", "format": "uint8" }, "levels": { "stream": "s43", "format": "int8" },
    "types": [{ "id": "plain", "walkable": true, "buildable": true, "color": "#9fb66b" },
              { "id": "rock", "walkable": false, "buildable": false, "color": "#6f6a62" }]
  }
}
```

A flat floor needs no extension: it is a placed piece or a box. The baked ground mesh is an
ordinary geometry (flat-shaded, one colour per face from its surface or type); the extension is
what the kit queries (`height`, `surface`, `normal`, `cell`) and what physics cooks: a height
field shape, planned in the format's appendix A and made core by the step that ships terrain.

**Paths.** One table holds every curve and network: a path is an edge; a network is edges that
share points.

```jsonc
"fun3d.paths": {
  "points": { "stream": "s50", "format": "float32x3" },
  "attributes": { "width": { "stream": "s51", "format": "float32" }, "bank": { "stream": "s52", "format": "float32" } },   // per point, optional
  "edges": [
    { "id": "lap", "points": [0, 1, 2, 3, 4, 5], "closed": true, "kind": "track", "profile": "track_12m", "tags": ["lap"] },
    { "id": "r12", "points": [40, 41, 42], "kind": "road", "profile": "street_2x2", "lanes": 2, "oneway": false, "speed": 50 },
    { "id": "patrol_a", "points": [60, 61, 62], "kind": "data", "tags": ["patrol"], "params": { "pause": 2 } }
  ],
  "profiles": [{ "id": "track_12m", "width": 12, "lanes": 2, "shoulder": 1.5, "barrier": "armco_01@v001" }]
}
```

`kind: "data"` edges generate nothing; the others are what the sweep generators turned into
geometry, kept so the kit can route vehicles along them and games can follow them.

**Zones and markers.**

```jsonc
"fun3d.zones": [
  { "id": "forest_n", "tags": ["biome", "forest"], "shape": { "polygon": [[-100, -100], [100, -100], [100, 0]], "y": [0, 60] } },
  { "id": "safe_1", "tags": ["safe"], "shape": { "box": { "center": [0, 2, 0], "halfExtents": [20, 4, 20] } }, "params": { "team": 1 } }
]
```

A marker is a node with `tags` and, when the game needs values, `extensions["fun3d.params"]`
(any JSON under 4 KB; a game namespaces its keys as it likes). Sockets on markers give
attachment frames, as on models. Spawn points, checkpoints, pickups, build spots, tees and
holes, piece slots are all markers.

**Navigation.** `fun3d.navmesh` holds a baked walkable mesh per tile: a vertex stream, polygon
index lists, an area type per polygon, and portals naming the neighbouring tile and edge so
paths cross tiles. Vehicle routing needs no extra data: it runs on `fun3d.paths` edges with a
`kind` and `lanes`. Grid pathing runs on `fun3d.grid`.

**Tile record.** `fun3d.tile` names the world, the tile's coordinates and bounds, its far file
(a merged low-detail version for the distance) and its budget, so a tile is self-describing
when opened alone.

**Caps** (first release, checked by the validator with the format's own): placed-model nodes
4096 per tile, copies 262 144 per tile (the format's placements cap), path points 65 536, edges
4096, zones 1024, markers 4096, navmesh polygons 65 536, terrain samples 1025 × 1025, grid
cells 1024 × 1024.

### 3.2 A world

```jsonc
{
  "format": "fun.dev/world", "version": 1, "id": "island", "name": { "zh": "海岛", "en": "Island" },
  "tile": { "size": 256 }, "bounds": { "min": [-1024, -50, -1024], "max": [1024, 300, 1024] },
  "tiles": [{ "x": -4, "z": -4, "file": "tiles/-4_-4.fun3d", "sha256": "…", "bytes": 418212,
              "far": { "file": "tiles/-4_-4.far.fun3d", "sha256": "…" } }],
  "data": { "file": "world.fun3d", "sha256": "…" },                        // paths, zones, markers, grid and navmesh portals that span tiles; loaded first, small
  "models": { "street_lamp_01@v005": { "file": "models/street_lamp_01@v005.fun3d", "sha256": "…" } },   // the closure, as models.lock records it
  "environment": { "sun": [{ "time": 0.25, "direction": [0.3, -0.8, 0.5], "intensity": 3.0, "color": "#fff1dc" }],
                   "sky": { "zenith": "#7fb3e6", "horizon": "#dbe7f0", "ground": "#6b6b66" }, "fog": { "color": "#dbe7f0", "near": 400, "far": 2400 } },
  "rules": { "runtime": ["floor_layout"] }                                  // rules the kit executes when the game asks
}
```

A scene is a world with one tile, or just the tile. The manifest is JSON, not `.fun3d`: it is
small, read before any binary data, and is what a release's `files.json` closure and the game
build's lock work from. Data that spans tiles (a lap, a road network, zones, markers) lives in
`world.fun3d`, a tile-shaped file without geometry; per-tile data (navmesh, local markers) stays
in the tile.

### 3.3 Sources and the library

The workshop source of a scene or world is its project with the rules, kept in the tile's
editing section and, for worlds, as `world.funworld.glb` beside the manifest (the project
container the workshop already uses). The library API reserves the types `scene` and `world`:
a scene is uploaded as its tile plus source; a world as manifest, tiles, `world.fun3d` and
source. Both are CC0 like everything else, pinned by games like models, and their closure of
referenced models is resolved at build.

## 4. Building blocks

| Block | Data | Workshop | Runtime |
| --- | --- | --- | --- |
| Placements | `model` nodes, `placements` streams, `refs` | `place`, `move`, variants and tint, groups, snap to ground | `models.place` per copy; instancing and batching as today |
| Kits | library `kit` with a structured fitting agreement: grid, storey height, socket vocabulary; pieces with tagged `sockets` | `snap` socket to socket, grid snapping, piece swapping | nothing new: pieces are placed models |
| Ground | `fun3d.terrain`, `fun3d.grid`, or a placed floor | terrain ops, grid painting, surface painting, water level | height, surface, normal, cell queries; height-field body |
| Paths | `fun3d.paths` | draw, edit points, set profile and attributes; sweep to geometry | `path.at(t)`, `nearest`, `frame`; `network.route(a, b)` |
| Zones | `fun3d.zones` | draw polygons and boxes, tag, parameters | `zones(tag)`, `contains`, enter and leave events |
| Markers | nodes with `tags`, `fun3d.params`, `sockets` | `marker`, tag, parameters | `markers(tag)` with positions, frames and parameters |
| Generators | rules in the editing section, `derived` stamps on results | `scatter`, `assemble`, `terrain`, `sweep`, `blueprint`; `derive` re-runs | `assemble(rule, { seed })` for runtime rules |
| Navigation and collision | `fun3d.navmesh`, path edges with lanes, grid types; bodies from models, ground and pieces | baked at `derive`; shown as overlays | navmesh paths, vehicle routes, grid paths; static bodies per tile |
| Lighting and atmosphere | manifest `environment`; light nodes of placed models | time of day preview, sun and sky settings | sun and sky by time; light slots for lamps (as today) |
| Tiles | manifest `tiles`, `fun3d.tile`, far files | tile grid shown; per-tile budget readout | streaming by focus and radius, far files beyond, bodies with tiles |
| Verification | — | `map`, `sample`, `audit`, budgets | `audit` data on load in development builds |

## 5. Generators: rules as data

A rule is a JSON record with an `id`, a `kind`, parameters and a `seed`. The workshop evaluates
rules through the kit's assembler (`kit/assemble.js`, shared with the runtime); results carry
`derived: { rule, hash }` so a re-run replaces exactly its own output. Rules declare `bake:
true` (the default: baked into tiles) or `bake: false` (left in the manifest for the game to run
through `world.assemble`).

| Kind | Parameters (sketch) | Produces |
| --- | --- | --- |
| `scatter` | `along` edges or `in` zones or `on` terrain/grid; `spacing` or `density`; `jitter`; `align` ground, normal or path; `candidates` [{ ref, weight, variants, tint range, scale range }]; `avoid` edges by width and zones; `slope` limits; `seed` | `placements` nodes |
| `assemble` | a `kit`; adjacency rules (which socket tags mate, weights); `bounds` as a zone or grid; `start` sockets; `count` or `length`; `seed` | placed pieces (rooms and corridors, runner segments, fence runs) |
| `lots` | an edge or network; lot depth and width ranges; a `blueprint` per lot type with parameter ranges; setbacks; `seed` | placed blueprint results along a path (a street of houses) |
| `terrain` | an ordered list of ops: `noise` (octaves, amplitude, scale), `stamp` (shape, position, height), `erode` (passes), `flatten` along edges by width and blend, `level` inside a zone, `water` level; `surfaces` by slope and height bands | `fun3d.terrain` streams |
| `sweep` | edges with a `profile`: lanes, sidewalks, shoulders, markings, barriers; junction style; bridges and cuts where the terrain demands | road, track, rail and river geometry; path edges keep their profile |
| `blueprint` | as today ([blueprints](model-editor.md#blueprints-and-derivation)) | a parametric model in place |

Determinism: the same source, generator stamp, parameters and seed give the same bytes; the
stamp is the hash of the assembler's modules, like the converter's. Caching is per tile by that
key, so a scatter edit in one zone re-derives only the tiles the zone touches.

Runtime execution covers what cannot be baked because it depends on play: a dungeon floor per
run, runner segments ahead of the player, strategy decorations after the map is revealed.
`world.assemble("floor_layout", { seed })` returns placed copies with their bodies, from the same
rule data and the same code path as the bake, so what an agent verified in the workshop at one
seed is what the game gets at another.

## 6. Workshop

**Document.** The project format gains node kinds and tables: `place` (a reference copy: id,
version, variants, tint; opaque, with bounds and sockets from the library's model record and
derived file), `placements` (the instanced form, usually derived), `marker`, `zone`, `path`
(points and attributes with an edge table), `terrain` and `grid` (with their streams), plus
`rules` and, for worlds, `tiles` (tile size and bounds; a node's tile follows from its position).
Projects keep `format: "fun.dev/model"` and version 1 with these additions as optional tables;
a project with only models is unchanged byte for byte. The 512-node limit counts nodes, never
copies; a world project of up to 64 tiles stays in one document, larger worlds derive by region
(their source is rules anyway) once stage 2's binary storage lands.

**Commands** (page, npm package and MCP, with schemas in the agent contract): `place`
(`librarySearch` and `libraryModel` find the id), `snap`, `marker`, `zone`, `path` with point
edits, `terrain` ops, `grid` painting, `scatter`, `assemble`, `lots`, `sweep`, `derive` (evaluate
rules, all or one), `map`, `sample`, `audit`, `exportTile`, `exportWorld`. Every command returns
revision, changed ids and warnings as today.

**Viewport.** Placed models draw through instancing with the library's derived file (a box
until it arrives); terrain and sweeps are meshes; zones, paths, markers and the navmesh are
overlays; a top-down orthographic mode with the map's layers; per-tile budget readout. The
software renderer gains instanced meshes so the Node runtime draws the same thing.

**Limits.** As section 3.1; the workshop refuses what the validator would.

## 7. Runtime

The runtime kit ships as an npm package (name and licence to decide, section 13) holding the
modules of [format section 7](model-format.md#7-runtime) plus `kit/world.js` and
`kit/assemble.js`, with three.js as a peer dependency, for WebGPU and WebGL 2. The fun.dev
player uses the same package.

```js
const world = await createWorld({ THREE, scene, fun3d, models, physics, lights, fetch }, "worlds/island/world.json");
world.focus(car.position); world.update(camera, dt);          // streams tiles by distance, far files beyond, bodies with tiles
world.height(x, z); world.surface(x, z); world.normal(x, z);   // terrain; grid: world.cell(x, z)
world.markers("spawn");                                        // [{ id, position, rotation, params, node }]
world.zones("safe"); world.zone("safe_1").contains(p);
world.on("zone", ({ id, entered, object }) => …);
world.path("lap").at(t); world.path("lap").nearest(p);        // position, tangent, distance
world.network("road").route(a, b);                             // along edges with lanes
world.navmesh.path(a, b);                                      // across tiles through portals
world.grid.path(a, b, { walkable: true });
const floor = await world.assemble("floor_layout", { seed: 42 });   // runtime rules: placed copies with bodies
world.time = 0.5;                                               // environment keyframes: sun, sky, fog; lights.factor follows
world.dispose();
```

A single tile needs none of this: `fun3d.load` and `models.place` as today, with
`world.data(tile)` to read its markers, zones and paths.

## 8. Genre coverage

| Genre | Composition | Special, and where it lives |
| --- | --- | --- |
| Open-world driving (帝都) | terrain or flat ground, road network swept, districts as zones, lots and scatter, tiles | vehicle routing on path edges; streaming |
| Racing | a closed track edge with width and bank attributes, swept with barriers; start grid and checkpoints as markers; trackside scatter | `bank` per point; lap data from the path |
| Third-person action (准点下班) | interior kits with sockets, exterior terrain, trigger and camera zones, spawn markers, navmesh | baked navmesh across interior and exterior |
| Shooter, arena | kit assembly, spawn and pickup markers, navmesh for bots, zones | baked lighting later (stage 3) |
| 3D platformer | placed pieces, moving-platform paths (`kind: "data"`), kill zones, checkpoint and collectible markers | precise bodies from pieces; the game drives platforms along paths |
| Puzzle, escape room | hand placement with grid snap, interactable markers with parameters, fixed camera markers | nothing new |
| Toy, tap, idle (木鱼, 扇耳光) | one tile: placed models, lights, a few markers | bodies and constraints come with the models |
| Strategy, builder, tower defence | `fun3d.grid` with types, buildable zones, lanes as paths, build-spot markers, decoration scatter | grid pathing; buildings placed at run time via `assemble` |
| RPG, dungeon | kits assembled by rules (rooms and corridors), spawn and loot markers, trigger zones, navmesh | `bake: false` rules for a floor per run |
| Life and farm sim | grid plots, placed buildings, markers, day cycle | `world.time` |
| Sports (golf, pitch) | terrain with surface types, tee and hole markers, out-of-bounds zones, placed stands | `surface(x, z)` drives ball behaviour |
| Flight, sailing | large terrain and water, tiles with far files, waypoint markers, sky | floating origin later (appendix A) |
| Horror, narrative walk | interior kits, trigger and sound zones, lighting keyframes, markers | nothing new |
| Runner, endless | segment kit with sockets, `assemble` at run time ahead of the player, lane markers | runtime rules |
| Survival, sandbox | terrain, scatter, chunked tiles | voxel ground later (appendix A) |
| Battle royale | the open-world set plus shrinking zones and loot markers | networking is the game's, outside this toolchain |

Every row composes from section 4; nothing in the format knows the genre. The three things no
row gets in the first release are voxel ground, floating origin and baked lighting.

## 9. Verification

- **`map({ layers, size })`**: a top-down orthographic render with any of ground (surfaces or
  grid types), heights (shaded or contours), paths (by kind), zones, markers (by tag),
  placements, navmesh, tile grid and budgets; the picture agents reason about.
- **`sample({ along, every, height, look })`**: perspective renders at intervals along a path
  (a drive down the lap, a walk through the corridor), the agent's walkthrough.
- **`audit()`**: structured findings `{ code, severity, node, position, message, suggestion }`:
  overlapping bodies, floating or buried copies against the ground, out of bounds, unresolved
  references, path networks with more than one component, slopes above a kind's limit, markers
  unreachable from spawn markers over the navmesh or the road network, missing far files, and
  per-tile budgets (triangles, estimated draw calls after batching, copies, bodies, lights).
  Games keep their own audits for their own rules, as 帝都 does for its closed loop.
- **Budgets** (initial, to be measured): within the streaming radius on a phone, 300 k
  triangles, 150 draw calls after batching, 8 light slots, 2000 static bodies; a tile over its
  budget fails the audit.

## 10. Pipeline

- `npm run world -- derive <project> --out <dir>` evaluates the rules and writes the manifest,
  tiles, far files, `world.fun3d`, the model closure and a report; cached per tile.
- Game builds list worlds in `game.json` (`"worlds": ["worlds/island"]` beside `models` and
  `convert`); the build derives, writes the closure into `models.lock`, and the release's
  `files.json` lists every tile so the service worker caches a world completely.
- Library uploads of type `scene` or `world` go through the console with the same review; the
  validator runs on every tile; thumbnails are the map render and a sampled view.

## 11. Rollout

Each step adds producer and consumer together and is accepted by sample places an agent builds
from a script, reviewed like library models.

1. **Places and data** (built 2026-10-19). `place` by reference, `marker`, `zone`, `path` as
   data, `map`, `audit` for overlap, floating, buried, out-of-bounds, unconverted models and the
   budget; `exportTile` and `exportWorld` (one tile); the kit loads tiles with `resolve` and
   answers `markers`, `zones`, `path` queries (`kit/world.js`); `.fun3d` 1.1 carries `model`
   nodes, `fun3d.params`, `fun3d.zones`, `fun3d.paths`, `fun3d.tile`
   ([format 4.9a](model-format.md#49a-placed-models-and-scene-data-11)). Samples:
   `examples/worlds/park-corner.mjs` (18 placed models, a lawn zone, a stroll, a spawn) and
   `examples/worlds/escape-room.mjs` (walls built, furniture placed, puzzle markers, an exit
   trigger), both built by script against the live library and clean in the audit. Not yet:
   per-copy tint and variants applied at run time, placed models' lamps as light-slot
   candidates, and batching of nested copies (they draw as singles); these come with step 2's
   instancing work. How the workshop records a placement: [model editor](model-editor.md#scenes-placed-models-markers-zones-and-paths).
2. **Rules and kits.** `scatter`, `assemble` with socket rules, structured kits, `derive` with
   caching and `derived` stamps, runtime `assemble`. Samples: a dungeon floor, runner segments,
   an arena.
3. **Ground, sweeps, navigation, tiles.** `fun3d.terrain` and `fun3d.grid`, terrain ops, `sweep`
   for roads and tracks (帝都's generator generalised), `lots`, `fun3d.navmesh`, the manifest with
   streaming and far files, `sample`, full budgets. Samples: a racing track, an island, 帝都 M1's
   block loaded from world data instead of game code.
4. **Later** (appendix A).

Step 1 fits the early phase and serves 帝都 M1. Whether step 3 precedes workshop stage 4
(characters and animation, which the roadmap puts next after the early phase) is decided after
the early phase's acceptance test.

## 12. What this changes elsewhere

- `.fun3d`: `refs` to whole models, `model` nodes, reference depth two for tiles, the
  extensions of section 3.1, the height-field shape (appendix A → core at step 3).
- Library API: `scene` and `world` types filled in; kits gain structured fitting agreements.
- Roadmap: this layer replaces "scatter and instancing, scene assembly from library models" in
  stage 2; outputs for this layer are three.js only; the runtime becomes a package.
- Player: worlds in `files.json`; `models.lock` closures include tiles' references.

## 13. Open questions for the owner

1. The runtime package's name and licence (the workshop is `UNLICENSED` until a licence is
   chosen; a runtime meant for other people's projects needs one).
2. Navmesh generation: a maintained Recast build for Node is the recommendation (a new,
   workshop-and-build-only dependency), against writing a simpler walkable-surface extractor.
3. Whether scenes and worlds enter the public library in the first release or stay game-local
   until the review flow has handled a few.
4. Reference depth two for tiles, or inlining skeleton bases at build.
5. The budget numbers in section 9, to set after measuring on a phone.

## Appendix A. Later, not in the first release

Voxel ground (`fun3d.voxel`, chunked, editable at run time) for survival and sandbox games;
floating origin for worlds beyond about 8 km across (the manifest's bounds warn before then);
baked lighting and lightmaps (workshop stage 3); weather; portals and occlusion for dense
interiors; networking of any kind (the game's or a host service's, never this format's).
