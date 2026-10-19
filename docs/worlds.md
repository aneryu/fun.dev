# Scenes and worlds: design

Status: designed and approved 2026-10-19 (the owner's "同意，并继续"); steps 1, 2 and the terrain
and tiles of step 3 are built the same day (section 11). It follows the discussion of that day: what else the workshop
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
that carries its baked mesh and body (`fun3d.terrain` is an array: a tile may hold several
fields):

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
Built 2026-10-19: `fun3d.grid` is an array of cell maps (`node`, `origin`, `cell`, `size`
[columns, rows], `step` metres per level, `cells` and optional `levels` as uint8 streams,
`types` with `walkable`, `buildable`, `color`, `tags`); the workshop's `grid` part draws it as a
mesh with walls where levels change and paints it by rectangle, cell list, zone or all; the
runtime answers `cell(x, z)` and `gridPath(a, b, { walkable, diagonal, climb, types })` (A*
over four or eight neighbours), `height` falls back to a cell's floor, scatter takes
`where: { types }`.

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
geometry, kept so the kit can route vehicles along them and games can follow them. Built
2026-10-19: a path part carries `kind` (road, track, rail, river, walk), `lanes`, `oneway` and
`speed`; the `sweep` rule (section 5) turns it into geometry and the tile's `profiles` table
summarises each sweep (`id`, `width`, `lanes`, `kind`) with the edge naming the profile that
swept it; `worldData(tile).network(kind).route(a, b)` routes over edges welded at shared
points, one-way edges directed; `path.frame(t)` gives position, tangent and right. Per-point
attributes (`width`, `bank`) stay planned: banking comes from curvature for now.

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

**Navigation.** Built 2026-10-19 as a raster rather than polygons: `fun3d.navgrid` is a
walkable raster per tile (`cell`, `origin`, `size`, `radius`, `climb`, `areas` with costs,
`cells` as a uint8 stream with the area index per cell, 0 blocked, `heights` as a float32
stream), baked by the workshop from the ground (terrains, grids, floors and roads tagged
`ground`) less what stands on it, the water, grid cells no one walks, slopes beyond the
agent's limit, grown by the agent's radius; `worldData(tile).walk(a, b)` is an A* over the
cells pulled straight where the way is clear, `walkable(x, z)` the test. `fun3d.navmesh`
(polygons with portals across tiles, Recast) stays planned for when the raster is not enough;
walks stay within one tile for now. Vehicle routing needs no extra data: it runs on
`fun3d.paths` edges with a `kind` and `lanes`. Grid pathing runs on `fun3d.grid`.

**Tile record.** `fun3d.tile` names the world (`world`, the manifest's id), the tile's
coordinates (`x`, `z`), its `bounds` and the world's tile `size`, its far file (`far`, a coarse
version for the distance) and, in that far file, `level: "far"`, so a tile is self-describing
when opened alone. A tile exported on its own has `bounds` and `size` only; the budget is the
audit's.

**Caps** (first release, checked by the validator with the format's own): placed-model nodes
4096 per tile, copies 262 144 per tile (the format's placements cap), path points 65 536, edges
4096, zones 1024, markers 4096, navmesh polygons 65 536, terrain samples 1025 × 1025, grid
cells 1024 × 1024.

### 3.2 A world

```jsonc
{
  "format": "fun.dev/world", "version": 1, "id": "island", "name": "Island",
  "tile": { "size": [256, 256], "span": [9, 9] }, "bounds": { "min": [-1152, -50, -1152], "max": [1152, 300, 1152] },
  "tiles": [{ "x": -4, "z": -4, "file": "tiles/-4_-4.fun3d", "sha256": "…", "bytes": 418212, "bounds": { "min": […], "max": […] },
              "far": { "file": "tiles/-4_-4.far.fun3d", "sha256": "…", "bytes": 31020 } }],
  "data": { "file": "world.fun3d", "sha256": "…", "bytes": 9120 },         // markers, zones, paths and runtime rules of the whole world; loaded first, small
  "models": { "street_lamp_01@v005": { "file": "models/street_lamp_01@v005.fun3d", "sha256": "…", "bytes": 48210 } },   // the closure, as models.lock records it
  "environment": { "sun": [{ "time": 0.5, "direction": [-0.4, -0.8, 0.45], "intensity": 3, "color": "#fff1dc" }],
                   "sky": { "zenith": "#7fb3e6", "horizon": "#dbe7f0", "ground": "#6b6b66" }, "fog": null },
  "rules": { "runtime": ["floor_layout"] },                                 // rules the kit executes when the game asks
  "source": { "file": "world.funmodel.glb", "sha256": "…", "bytes": 120400 }   // the project, to reopen in the workshop
}
```

A scene is a world with one tile, or just the tile. The manifest is JSON, not `.fun3d`: it is
small, read before any binary data, and is what a release's `files.json` closure and the game
build's lock work from.

**How a project becomes tiles** (`site/workshop/tiles.js`, built 2026-10-19). Tile `(i, k)` is
centred on `(i·w, k·d)` for `tile.size = [w, d]`, so a scene built around the origin is the one
tile `0_0` and a world grows outward; `tile.span = [across, deep]` (odd numbers, 1 by default)
is how many tiles the world may use, which the audit's `out-of-bounds` checks. A part goes to
the tile under the centre of its bounds, its ancestors along as bare pivots; a part with
`copies` goes row by row, one placements node per tile; a terrain is split into sub-fields along
its cells (a cell belongs to the tile under its centre; the shared edge samples repeat, so
heights agree at the seam; the sub-field node is `<id>__<x>_<z>` with `m` for minus); tiles
without anything are not written. Markers, zones, paths and the runtime rules are the world's
data, not any tile's: they go to `world.fun3d`, a tile-shaped file without geometry, so a game
reads spawn points and lap data before any tile has streamed; a pure marker's node stays in its
tile only as a pivot of children, while tagged geometry (a placed lamp tagged `lamp`, a copy of
a rule with tags) stays a marker of its tile. A far file holds the tile's terrains coarsened
(every fourth sample where that divides the cells, else fifth, third or second) and the parts at
least 8 metres across (`far: { minSize, step }`, or `far: false`), with no bodies and no
editing section; a tile with nothing worth the distance has none. Tiles carry no editing
section either; the project rides once as `source`.

### 3.3 Sources and the library

The workshop source of a scene or world is its project with the rules, kept in the tile's
editing section and, for worlds, as `world.funmodel.glb` beside the manifest (the project
container the workshop already uses; the manifest's `source`). The library API reserves the types `scene` and `world`:
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
| `lots` | `on` a path, paths or a tag; `sides`; `width` and `depth` ranges; `offset` from the centreline to the front line (the sweep's half width + 2 by default); `gap`; `start`, `end`; `ground`; `bounds` zone; `avoid`; `candidates` with `front` (the model's side that faces the road) and `margin`; `zones: true` for a zone part per lot; `seed` | placed copies of library models fitting each lot's frontage and depth, standing on the front line facing the road; lot zones with `side`, `width`, `depth`, `model`; runs at play time too (`bake: false`). Built 2026-10-19; blueprint buildings sized to their lots are later |
| `terrain` | an ordered list of ops: `noise` (octaves, amplitude, scale), `stamp` (shape, position, height), `erode` (passes), `flatten` along edges by width and blend, `level` inside a zone, `water` level; `surfaces` by slope and height bands | `fun3d.terrain` streams |
| `sweep` | `on` a path, paths or a tag; a `profile` (preset `road`, `track`, `rail`, `river`, `walk` with options, or explicit `strips` side by side with offsets for kerbs, `marks` laid over them dashed by length, a `thickness` slab); `ground` follows the terrain plus `rise`; `step`; `bank` by curvature; `chunk` metres per mesh (the tile size by default) | mesh parts tagged `ground` with static bodies; path edges keep their kind and profile. Built 2026-10-19 with junctions: paths made to meet (`meet`: ends snap, an end on another path joins it, crossings enter both) sweep as one network, each ribbon stopping short of a junction by the others' half width over the sine of their angle and a patch of the junction material filling it; shoulders cut into terrain and bridges are later |
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
const world = await createWorld({ fun3d, models, physics, read: assets.arrayBuffer, json: assets.json }, "worlds/island/world.json");
world.focus(car.position);                                     // each frame: tiles by distance, far files beyond, bodies with near tiles
await world.settle();                                          // loading screens and tests; world.tiles() lists states
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

Built 2026-10-19 (`kit/world.js`): `createWorld` with `read` and `json` taking paths joined to
the manifest's directory (fetch by default), `focus`, `update`, `settle`, `tiles`, `tile`,
`height`, `surface`, `markers`, `marker`, `zones`, `zone`, `zonesAt`, `paths`, `path`, `rules`,
`run`, `network`, `dispose`; options `radius` (the tile size by default), `far` (four tile
sizes), `hysteresis`, `concurrency`, `onTile`. A tile is near within `radius` of its rectangle,
far within `far` (its far file, if it has one), gone beyond; a near file replaces the far copy
only once it has loaded, and the reverse; a tile whose file fails is reported once and left.
Queries merge the data file with the near tiles; terrain queries ask the near tiles first, then
the far ones; `network(kind)` builds a routable graph over the paths in reach. Still sketches:
`normal`, zone events, lane offsets on routes, navmesh, grid, environment time.
A single tile needs none of this: `fun3d.load` and `models.place` as today, with
`worldData(tile)` to read its markers, zones and paths.

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
- **`sample({ path, every, height, look, limit })`**: perspective renders at intervals along a
  path (a drive down the lap, a walk through the corridor), the agent's walkthrough. Built
  2026-10-19 as `observe` with `along` (`ws.sample` writes the frames).
- **`audit()`**: structured findings `{ code, severity, node, position, message, suggestion }`:
  overlapping bodies, floating or buried copies against the ground, out of bounds, unresolved
  references, path networks with more than one component, slopes above a kind's limit, markers
  unreachable from spawn markers over the navmesh or the road network, missing far files, and
  per-tile budgets (triangles, estimated draw calls after batching, copies, bodies, lights).
  Games keep their own audits for their own rules, as 帝都 does for its closed loop.
- **Budgets** (initial, to be measured): within the streaming radius on a phone, 300 k
  triangles, 150 draw calls after batching, 8 light slots, 2000 static bodies; a tile over its
  budget fails the audit. Built 2026-10-19: the audit estimates triangles, draw calls after
  batching, static bodies and copies for the scene or per tile (`budget`, `tile-budget`), the
  world report carries each tile's numbers; light slots are the runtime's fixed set and are
  not counted; the numbers wait for a device.

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
2. **Rules and kits.** Scatter is built (2026-10-19): `rule` adds a scatter rule as data on
   the project (along a path with offset and sides, inside a zone with jitter and margin, on a
   grid; yaw, scale range, weighted candidates with tint palettes, keep-out by paths, zones
   and solids; a seed), `derive` resolves the candidate models in the library, evaluates the
   rule in `kit/scatter.js` (the same code a game may run) and replaces the parts it produced
   last time: one placed model with many copies per candidate, stamped with the rule and a
   hash of its inputs, so the audit reports `stale-rule` and `underived-rule`. Copies draw
   instanced in the viewport (the software renderer too), export as `placements` on `model`
   nodes, load as one instanced mesh per part of the referenced model, offer the model's lamps
   to the light slots once per copy, and read as one marker per copy. Sample:
   `examples/worlds/avenue.mjs` (grass tiles on grids, lamps and benches along the road,
   trees and shrubs over the verges). Kits and assembly are built too (2026-10-19): parts carry
   `sockets` (frames with tags; `socket`, `removeSocket`, `snap` commands; exported to GLB as
   `socket_<name>` empties with tags in the extras, read back by the importer, the converter
   and the placed-model templates, so a library piece made in the workshop keeps them);
   `assemble` rules grow a kit from a start piece through mating sockets (`kit/assemble.js`,
   the same code a game may run): pieces are library models with sockets from the model or a
   box-side shorthand, mating by tag or a `[open, new]` table, growth from any open socket or
   a chain with a `sequence`, kept inside a zone and clear of what stands, adjacency-consistent
   (no road into a wall), dead ends capped by closers. Samples: `examples/worlds/street-grid.mjs`
   (the city_streets kit grown from a crossing) and `examples/worlds/walled-garden.mjs`
   (retaining walls chained around a lawn by sequence). Rules at play time are built too: a
   rule with `bake: false` is not derived in the workshop but rides in the tile
   (`fun3d.rules`, models pinned and among the refs, pieces with their bounds and socket
   frames, keep-outs by solids as boxes) and `worldData(tile).run(id, { seed })` evaluates it
   in the game with the same code, over the tile's paths and zones, returning rows per model
   for `models.place`. Still to come: the library's kit records as structured agreements.
3. **Ground, sweeps, navigation, tiles.** Terrain is built (2026-10-19): a `terrain` part is a
   height field (cell, samples up to 257 × 257, a surface table with colours, friction and
   tags, water) that the `terrain` command shapes by ops in world space (noise, stamps,
   flatten along a path, level inside a zone, smooth, clamp) and classifies by height and slope
   rules; it draws as one flat-shaded mesh coloured by surface, scatter rules place on it
   (`ground: true`, `where: { surfaces }`), the audit takes it as the ground, and a tile carries
   the mesh, a static mesh body and the field itself (`fun3d.terrain`, an array of fields) so
   `worldData(tile).height(x, z)` and `surface(x, z)` answer at play time and runtime rules sit
   on it. Tiles and streaming are built (2026-10-19): `exportWorld` cuts the project by
   `tile.size` as section 3.2 describes (parts by bounds, copies by row, terrains at their
   cells, data in `world.fun3d`, far files, the source), the audit checks `tile.span` and a
   triangle budget per tile (`tile-budget`), and `createWorld` streams the result (section 7).
   Sample: `examples/worlds/island.mjs`, a 3 × 3 world of 96 m tiles. Sweeps are built
   (2026-10-19): the `sweep` rule carries a profile along paths (section 5) into mesh parts
   tagged `ground` with static bodies, `resample` spaces a path's points along a smooth curve,
   path parts carry `kind`, `lanes`, `oneway` and `speed` into the tile's edges with the
   profiles that swept them, and the runtime routes over them (`network(kind).route`).
   Samples: `examples/worlds/circuit.mjs` (a banked track from a resampled lap, lamps and
   trees), the island's road. Grids and the walkthrough are built (2026-10-19): a `grid` part
   (section 4) painted by the `grid` command, the audit's ground and scatter's `where.types`,
   cut into tiles like a terrain, `cell` and `gridPath` in the game; `observe({ along })` /
   `ws.sample` renders frames along a path. Sample: `examples/worlds/keep.mjs` (a tower-defence
   board with a lane, a river ford, a plateau and build spots). Still to come in this step:
   `lots` (built 2026-10-19: parcels along a street taking the library's buildings by footprint,
   facing the road, as zones for the game; sample `examples/worlds/block.mjs`), the tile grid
   on maps and junctions (built 2026-10-19: the `meet` op joins paths where they meet or
   cross, a sweep over several paths trims its ribbons at the junctions and fills them with
   patches, the welded network routes in the game; sample `examples/worlds/crossroads.mjs`)
   are done, and navigation (built 2026-10-19 as the walkable raster `fun3d.navgrid`: a `nav`
   setting on the project bakes it into every tile, the audit reports markers no spawn can
   reach, the game walks over it; sample `examples/worlds/keep.mjs`); budgets measured on a
   phone and 帝都 M1's block loaded from world data remain, polygon navmeshes with portals
   across tiles are later.
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
