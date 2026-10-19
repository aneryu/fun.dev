# Workshop for agents: quick reference

The fun.dev workshop builds static low-poly models (flat PBR colours, no textures) for the
model library and games. Work like a Blender script: one script builds the model from
scratch; run it, look at the preview, fix, run again.

## Run

In the repository: `node scripts/editor-agent.mjs --run model.mjs`

Without it, with nothing but Node 22 or newer:

```sh
npx -y fundev-workshop --run model.mjs          # the npm package
# or the single file: curl -O https://static.fun.dev/tools/fundev-workshop.mjs
#                     node fundev-workshop.mjs --run model.mjs
```

The workshop runs in Node itself: no browser, GPU or WebGL; views draw in software, exactly
as the web workshop draws without WebGL. MCP: `npx -y fundev-workshop --mcp --session
model.json --artifacts out`. `--browser` drives a real page instead and needs `npm i
playwright && npx playwright install chromium`; `--gpu` draws on the GPU there.

The run prints one JSON line: the validation summary, statistics and files written. On an
error it prints `{ ok: false, error }` (code, message, commandIndex, path, suggestion) and
exits with 1.

## Edit the current browser tab

For a user working in Chrome, connect the existing workshop instead of opening DevTools
or starting a second model:

```sh
node scripts/editor-agent.mjs --serve       # keep running; prints a connection code
# Workshop → Agent → paste code → Connect this project
node scripts/editor-agent.mjs --connect --run edit.mjs
# Or use these as the MCP server arguments:
node scripts/editor-agent.mjs --connect --mcp
```

The npm tool uses the same `--serve` and `--connect` flags. `--serve --url <workshop-url>`
selects the permitted webpage origin (default `https://fun.dev/workshop/`); use the local
preview URL during development. A private temporary connection file lets `--connect`
discover the running service; `--connection-file <path>` selects another independent
service. Only one tab connects to each service. The Agent button shows connection status
and can disconnect. A previously connected tab reconnects on reload while the service runs.

`edit.mjs` receives the same `ws` API, now operating on the visible tab. Start with
`ws.inspect()` and `ws.apply()`; **do not call `ws.load()` unless replacing the user's
project is intended**. `observe` captures the page's renderer and export writes local files.
Writes keep revision checks and wait for the browser's durable save. On a lost response,
inspect before retrying: a timed-out operation may already have applied. No Chrome debug
port, Playwright installation, or console code is needed for this connection.

## A model script

```js
export default async function (ws) {
  await ws.load({ name: "crate_01", materials: [
    { id: "mat_wood", color: "#c89969", roughness: 0.8 },
    { id: "mat_steel", color: "#8c9399", roughness: 0.35, metalness: 1 },
  ] });
  await ws.apply([
    { op: "create", id: "crate_01", kind: "group" },
    { op: "create", id: "body", kind: "box", parent: "crate_01", material: "mat_wood",
      position: [0, 0.25, 0], options: { size: [0.5, 0.5, 0.5], bevel: 0.01 } },
    { op: "create", id: "lid_hinge", kind: "group", parent: "crate_01", position: [0, 0.5, -0.25] },
    { op: "create", id: "lid", kind: "box", parent: "lid_hinge", material: "mat_wood",
      position: [0, 0.02, 0.25], options: { size: [0.52, 0.04, 0.52] } },
  ]);
  await ws.observe(["perspective", "front"], { file: "preview.png", size: 768 });
  await ws.exportGLB({ file: "model.glb", origin: "ground-center",
    rootName: "crate_01_ROOT", mergeStatic: "auto" });
}
```

- Paths are relative to the script. `ws.load` starts a fresh project, so every run is the
  same; materials need `id` and `color`.
- `ws.apply(commands)` runs one atomic batch and returns `{ revision, changed, idMaps }`.
  `ws.validate()` returns `{ errors, warnings }`. `ws.inspect({ id })`, `ws.query({ id, kind,
  … })` read geometry. `ws.observe(names, { file, size, references })` writes PNGs (one name:
  `file`; several: `file` with `-<view>` added). `ws.exportGLB({ file, … })` returns the
  export report. Also `ws.importGLB({ file })`, `ws.exportProject({ file })`,
  `ws.setReference({ view, file, width, center })`, `ws.call(method, args)` for anything else.
- The public CC0 model library: `ws.librarySearch({ query, type, tags })` finds models (ids,
  sizes in metres, versions); `ws.openLibraryModel(id)` opens one to edit or derive from (its
  workshop project when it has one), `ws.openLibraryModel(id, { mode: "add" })` adds its parts
  to assemble a scene; `ws.libraryModel(id)` lists versions and file addresses. The project
  records them in `sources`. Details: [library API](library-api.md).

## Conventions

- Metres; +Y up; the model faces +Z (its left side is +X); rotations are XYZ Euler degrees;
  positions are relative to the parent.
- A node ID is its glTF name: games look parts up by it. IDs: letters, digits, `_ . -`.
- Moving parts sit under an empty `group` placed at the pivot (`wheel_front_l`,
  `door_hinge`); a group's children move with it.
- `mergeStatic: "auto"` merges every mesh directly under the root into one mesh per
  material, named `static__<material>`; meshes inside groups stay separate (they move).
  With `rootName`, a single top-level group becomes the root itself.
- Materials: `id, name?, color "#rrggbb", roughness, metalness?, emissive?,
  emissiveIntensity?, opacity?, transmission?, ior?, doubleSided?`. Full metal
  (metalness 1) reflects its surroundings: the workshop and library show a sky, but a
  game without an environment shows it almost black. Library metals mostly use 0.55.

## Shapes: `{ op: "create", id, kind, parent?, material?, position?, rotation?, scale?, options, smooth? }`

| kind | options |
| --- | --- |
| box | `size:[x,y,z]`, `bevel?`, `bevelSegments?` (rounded) |
| sphere | `radius`, `segments`, `rings`; `latitude:[from,to]?` degrees (−90…90: `[0,90]` a dome, `[-90,0]` a bowl), `angle?` (a wedge) |
| cylinder, cone | `radius`, `height`, `segments`; `radiusTop?` (a frustum; a cone's is 0), `innerRadius?` (a tube; the bore runs parallel to the outside), `round?` (rim radius), `roundSegments?`, `angle?` |
| torus | `radius` (ring centre line), `tube` (tube radius), `segments`, `tubeSegments`, `angle?` (an elbow) |
| capsule | `radius`, `height` (total, ≥ 2 × radius), `segments`, `rings` (per end) |
| lathe | `profile` from the axis back to the axis as `[r,y]` items (outline items below), `segments` (around Y) |
| extrude | `points` outline in local XY (may be concave), `depth` (centred on Z), `holes?`, `round?`, `roundSegments?` |
| revolve | `profile` closed section with x ≥ 0, `angle` (degrees), `segments` |
| sweep | `profile` closed section, `path` (3D items), `smooth?`, `pathSegments?`, `caps?` |
| mesh | top-level `mesh: { vertices, faces:[{ id, vertices, material }] }` |
| group | no geometry: a pivot or container |

- Round shapes stand on their local Y axis, centred on their position (cylinders, cones,
  capsules and spheres reach half their height below it); `axis: "x" | "z"` lays cylinders,
  cones, tori, capsules, lathes and revolves along that axis instead. Partial `angle`s
  start on +X and turn like a positive rotation about the axis (+X towards −Z), with flat ends.
- `segments` (and `rings`, `tubeSegments`) take a whole number or `"auto"`: about 2 mm from
  the true curve, 8–64, in steps of four, so big and small round parts of one model look
  alike. Tori, capsules and curves in outlines default to `"auto"`; the others keep their
  old defaults (8 around, 6 rings).
- `smooth: true` (or a crease angle in degrees, `true` = 60) shades a part smoothly: edges
  sharper than the crease stay hard, so a 24-segment can looks round with crisp rims and a
  box stays a box. `{ op: "set", id, smooth: false }` returns to flat faces. Without it every
  face is flat, the library's low-poly look. Imported smooth models keep their smoothing.

## Outlines and paths

Wherever a shape takes `points`, `profile`, `holes` or `path`, the list holds points and
segments that continue from the last point:

```js
[x, y]                                   // a point
[x, y, r]                                // a point whose corner is rounded with radius r
{ arc: { center: [cx, cy], angle: 90 } } // turn about a centre (degrees, + counter-clockwise)
{ arc: { through: [x, y], to: [x, y] } } // an arc through a point to an end point
{ bezier: { controls: [[x, y]], to: [x, y] } }  // one control: quadratic, two: cubic
```

A whole 2D outline (or hole) may be one shape: `{ circle: r }` or `{ circle: { radius,
center } }`, `{ ellipse: [rx, ry] }`, `{ rect: { size: [w, h], round } }`, `{ polygon: {
sides, radius } }` (a corner points up). Path items are 3D: `[x, y, z]`, `{ arc: { center,
axis, angle, rise? } }` (`rise` along the axis makes a helix), `{ arc: { through, to } }`,
`{ bezier: { controls, to } }`. Arcs and curves take `segments` (default `"auto"`).

```js
// A wheel arch in a side outline, an arched window, a washer, a spiral handrail:
points: [[-2, 0.2], [-1.25, 0.2], { arc: { center: [-0.9, 0.2], angle: -180 } }, [2, 0.2], [2, 1], [-2, 1]]
points: [[-0.3, 0], [0.3, 0], [0.3, 0.4], { arc: { through: [0, 0.7], to: [-0.3, 0.4] } }]
{ kind: "extrude", options: { points: { circle: 0.05 }, holes: [{ circle: 0.02 }], depth: 0.004 } }
{ kind: "sweep", options: { profile: { circle: 0.025 }, path: [[0.6, 0.9, 0], { arc: { center: [0, 0.9, 0], axis: [0, 1, 0], angle: 360, rise: 3 } }] } }
```

A side profile extruded with `rotation:[0,-90,0]` runs along +Z (its depth along X): a car
body with wheel-arch notches is one concave outline.

## Commands for `ws.apply`

- Parts: `set {id, position?, rotation?, scale?, parent?, name?}`, `rename {id, newId}`,
  `delete {id}`, `group {ids, newId}`, `pivot {id, offset}`.
- Copies: `duplicate {id, newId, offset?, linked?, replace?:["front","rear"], idMap?}`,
  `symmetry {id, newId, axis:"x", space:"world", replace:["_l","_r"]}` (a linked mirror,
  children renamed by `replace`), `array {id, count, offset?, rotation?, pivot?, merge?}`.
- Colour: `material {id, …}`, `paint {id, material, select?}`.
- Solids: `boolean {id, operation:"union"|"difference"|"intersection", with:[ids] | shape:{kind,
  options, position?, rotation?, material?}}` (tools are used up; cut faces take the tool's
  material).
- Faces and edges: `extrude`/`inset {id, distance, select}`, `bevel {id, distance, select}`,
  `cut {id, axis, offset, space}`, `solidify {id, thickness}`, `weld`, `fill`, `dissolve`,
  `join {id, with}`, `separate {id, newId, loose:true}`, `deleteComponents {id, select}`.
- Selectors: `{ kind:"faces"|"edges"|"vertices", space:"world", normal?:[x,y,z], at?:{axis,
  value}, boundary?:{axis, side:"min"|"max"}, largest?, crease?:degrees }`.

## Blueprints: parametric families

`await ws.call("blueprints")` lists them (`lamp-post`, `railing`, `building-block`) with their
parameter schemas. `ws.apply([{ op: "blueprint", id: "lamp-post", params: { height: 6, arms: 2 },
root: "lamp" }])` builds one; `{ op: "assemblyParameters", root: "lamp", values: { height: 4 } }`
re-derives it (structural parameters such as `arms` need the blueprint again). From the command
line, `npm run derive -- --blueprint lamp-post --id street_lamp_02 --set height=5` writes a
library upload folder. A new blueprint is a module in `site/workshop/blueprints.js`.

## Before delivering

- `ws.validate()` has no errors (`shell-overlap` and `nonplanar` warnings are fine).
- Look at the preview; check the export report's triangles, bounds and merge groups.

Full reference: [model editor](model-editor.md) and the workshop's `/workshop/guide`.

### Preview quality

```js
await ws.observe(["perspective", "front"], {
  file: "preview.png", report: "preview.json", size: 1536,
  antialias: "ssaa2", shadows: true, lighting: "studio", exposure: 1,
});
```

`ssaa2` (default) samples 2×2 per pixel at every output size; `ssaa4` uses 4×4.
`native` uses one software sample or the GPU renderer's native MSAA. GPU captures
keep native MSAA in addition to the selected supersampling. More than 16,777,216
supersamples is an error, never a silent downgrade (2048 px with `ssaa2` fits;
2048 px with `ssaa4` does not). The same controls work in MCP `observe`, `preview`
and `recipeStage`, and in the page's **Save view** dialog.

The optional JSON report records the image paths, camera, backend, sampling,
exposure, fixed `studio-v1` light setup and shadow bounds. Use the recorded camera
and lighting when comparing an exported model in a game; different game lighting
will produce different pictures. Image quality and geometric resemblance still
need visual review. A PNG alone is not evidence that a model matches its reference.

### Automatic local vertex symmetry

For an already symmetric independent mesh, enable persistent vertex pairs with
`{op:"vertexSymmetry",id:"head",axis:"z",offset:0,side:1}`. Positive local Z is
the source (`side:-1` chooses negative). Source vertex edits automatically update
the opposite side and pin seam vertices to the plane. The setting survives project
export/import and undo/redo. Destination vertex edits are rejected. Disable with
`{op:"vertexSymmetry",id:"head",enabled:false}` before topology changes; re-enable
after restoring symmetric topology. This links positions, not face colors.

Separate eyes, wings or feet use the existing `symmetry` command with
`space:"parent",axis:"z",linked:true` to link geometry and transforms.

## Scenes

Place library models by reference and add the data a game reads (docs/worlds.md):

```js
await ws.load({ name: "Park corner", tile: { size: [12, 12] }, materials: [] });
await ws.place({ id: "lamp_1", model: "street_lamp_01", position: [-5, 0, 0.5], rotation: [0, 90, 0], tags: ["lamp"] });
await ws.apply([
  { op: "create", id: "spawn", kind: "marker", position: [0, 0, 5], tags: ["spawn"], params: { facing: "north" } },
  { op: "create", id: "lawn", kind: "zone", tags: ["picnic"], area: { polygon: [[-6, -6], [6, -6], [6, 0], [-6, 0]], y: [0, 3] } },
  { op: "create", id: "stroll", kind: "path", tags: ["stroll"], path: { points: [[-5, 0, 5], [0, 0, 2], [5, 0, 5]] } },
]);
const audit = await ws.audit();          // overlap, floating, buried, out-of-bounds, unconverted-model, budget
await ws.map({ file: "map.png" });       // the top view with zones, paths and markers
await ws.exportTile({ file: "park.fun3d" });
await ws.exportWorld({ dir: "park-world" }); // world.json, the tiles (+ far files), world.fun3d (markers, zones, paths), the source, the placed models' .fun3d files
```

`model` is a library id or `id@vNNN`; `ws.librarySearch({ query })` finds ids. A placed part
keeps the library's bounds and files, never the geometry. Tag the floor `ground`. Fix what the
audit lists before exporting; `--run` prints the audit for scene projects.

Many copies come from rules, data on the project that `derive` runs:

```js
await ws.rule({ id: "lamps", kind: "scatter", target: "lamps", tags: ["lamp"], on: { path: "road", spacing: 12, offset: 5, sides: "both" }, candidates: [{ model: "street_lamp_01" }] });
await ws.rule({ id: "green", kind: "scatter", seed: "spring", on: { zone: "verge", spacing: 4, jitter: 0.6, margin: 3.5 }, yaw: "random", scale: [0.85, 1.15],
  avoid: [{ path: "road", width: 14 }], candidates: [{ model: "flowering_cherry_tree_01" }, { model: "garden_shrub_01", weight: 3 }] });
await ws.derive();                        // placed parts with copies, stamped with their rule
```

Roads, tracks, rails and rivers are sweeps: a profile carried along a path into a mesh part
tagged `ground` (with a static body in the tile); the path keeps its kind for the game:

```js
await ws.apply([
  { op: "create", id: "lap", kind: "path", tags: ["lap"], path: { points: [[-60, 0, -40], [60, 0, -40], [60, 0, 40], [-60, 0, 40]], closed: true, kind: "track", lanes: 2 } },
  { op: "resample", id: "lap", spacing: 3 },                                  // a smooth curve through the points, 3 m apart
]);
await ws.rule({ id: "track", kind: "sweep", on: { path: "lap" }, profile: { preset: "track", width: 12 }, ground: true, bank: { max: 8, radius: 60 } });
await ws.rule({ id: "streets", kind: "sweep", on: { tag: "road" }, profile: { preset: "road", lanes: 2, sidewalks: true } });   // presets: road, track, rail, river, walk; or { strips, marks }
await ws.derive();                        // mesh parts per path (in chunks of the tile size), preset materials added
```

A cell map for strategy, builder and dungeon games is a `grid` part, painted by rectangle,
cell list or zone; a walkthrough renders frames along a path:

```js
await ws.apply([
  { op: "create", id: "board", kind: "grid", position: [-40, 0, -30], tags: ["ground"], grid: { cell: 2, size: [40, 30], step: 0.5, types: [{ id: "plain", color: "#9fb66b" }, { id: "rock", color: "#6f6a62", walkable: false, buildable: false }] } },
  { op: "grid", id: "board", paint: [{ type: "rock", rect: [8, 0, 11, 7] }, { level: 2, rect: [30, 0, 39, 9] }] },
]);
await ws.sample({ path: "lane", every: 25, height: 2, file: "walk.png" });   // walk-01.png, walk-02.png … looking ahead along the lane
```

A street of buildings is a `lots` rule: parcels along a road, each taking a library model that
fits its frontage and faces the road, optionally as zones for the game:

```js
await ws.rule({ id: "lots", kind: "lots", seed: "block", on: { path: "avenue" }, width: [14, 20], depth: 24, gap: [2, 2], zones: true,
  candidates: [{ model: "city_office_midrise_01", weight: 2 }, { model: "city_retail_residential_01", weight: 3 }, { model: "cafe_01", margin: 2 }] });
await ws.derive();                        // copies on the lots' front line facing the road; lot zones with side, width, depth, model
```

Roads that meet or cross are welded first, then swept together: the ribbons stop short of each
junction and a patch fills it, and the game routes across:

```js
await ws.apply([{ op: "meet", tag: "road", tolerance: 1 }]);          // shared points where roads meet, touch or cross
await ws.rule({ id: "roads", kind: "sweep", on: { tag: "road" }, profile: { preset: "road", lanes: 2, sidewalks: true } });
await ws.derive();                        // roads_1 … and roads_j1 … (the junction patches)
```

`nav` on the project bakes a walkable raster into every tile (the ground less what stands on
it, slopes and water, grown by the agent's radius); the audit then reports markers no `spawn`
marker can reach, and the game walks with `data.walk(a, b)`:

```js
await ws.load({ name: "Keep", tile: { size: [96, 96] }, nav: { cell: 1, radius: 0.5 } });
```

`on` is `{ path, spacing, offset, sides }`, `{ zone, spacing, jitter, margin }` or `{ grid: { cells,
spacing, origin } }`; the audit says when a rule is stale or not yet derived.

Kits grow by assembly rules: pieces with sockets (a box-side shorthand or the model's own) mate
by tag from a start piece, inside a zone, never overlapping, dead ends capped by closers:

```js
await ws.rule({ id: "streets", kind: "assemble", seed: 7, target: "streets", bounds: "block", count: 60,
  pieces: [{ model: "city_street_cross_01", sockets: { n: "road", s: "road", e: "road", w: "road" }, start: true },
           { model: "city_street_straight_01", sockets: { e: "road", w: "road" }, weight: 6 },
           { model: "city_street_endcap_01", sockets: { n: "road" }, closer: true }] });
await ws.derive({ id: "streets" });
```

Parts take sockets too (`sockets` on create/set, `socket`, `removeSocket`), `snap` mates two
sockets, and GLBs carry them as `socket_<name>` empties.

Ground is a terrain part shaped by ops, with surfaces by height and slope:

```js
await ws.apply([
  { op: "create", id: "ground", kind: "terrain", position: [-128, 0, -128], tags: ["ground"], terrain: { cell: 4, samples: [65, 65],
    surfaceTable: [{ id: "sand", color: "#d9c58a" }, { id: "grass", color: "#6b8f3a" }, { id: "rock", color: "#7a746c" }] } },
  { op: "terrain", id: "ground", seed: "isle", ops: [{ noise: { amplitude: 16, scale: 90 } }, { stamp: { shape: "circle", center: [0, 0], radius: 40, height: 14, falloff: 50 } },
    { flatten: { path: "road", width: 10, blend: 8 } }, { level: { zone: "village", height: 9, blend: 10 } }],
    surfaces: [{ surface: "sand", height: [-100, 1.5] }, { surface: "grass", height: [1.5, 100] }, { surface: "rock", slope: [30, 90] }], water: { level: 0.5 } },
]);
await ws.rule({ id: "trees", kind: "scatter", on: { zone: "whole", spacing: 9 }, ground: true, where: { surfaces: ["grass"] }, candidates: [{ model: "flowering_cherry_tree_01" }] });
```
