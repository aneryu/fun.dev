# Workshop for agents: quick reference

The fun.dev workshop builds static low-poly models (flat PBR colours, no textures) for the
model library and games. Work like a Blender script: one script builds the model from
scratch; run it, look at the preview, fix, run again.

## Run

In the repository: `node scripts/editor-agent.mjs --run model.mjs`

Without it:

```sh
npm i playwright && npx playwright install chromium
curl -O https://cdn.fun.dev/tools/fundev-workshop.mjs
node fundev-workshop.mjs --run model.mjs        # --gpu: render on the GPU
```

No GPU or WebGL needed: without them the workshop draws in software (same results, slower
previews); `--software` skips trying the GPU. The connect line on stderr names the renderer.

The run prints one JSON line: the validation summary, statistics and files written. On an
error it prints `{ ok: false, error }` (code, message, commandIndex, path, suggestion) and
exits with 1.

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
library upload folder. A new blueprint is a module in `site/editor/blueprints.js`.

## Before delivering

- `ws.validate()` has no errors (`shell-overlap` and `nonplanar` warnings are fine).
- Look at the preview; check the export report's triangles, bounds and merge groups.

Full reference: [model editor](model-editor.md) and the workshop's `/editor/guide`.
