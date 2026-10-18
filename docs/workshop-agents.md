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

## Shapes: `{ op: "create", id, kind, parent?, material?, position?, rotation?, scale?, options }`

| kind | options |
| --- | --- |
| box | `size:[x,y,z]`, `bevel?`, `bevelSegments?` (rounded) |
| sphere | `radius`, `segments`, `rings` |
| cylinder, cone | `radius`, `height`, `segments` (along local Y) |
| lathe | `profile:[[r,y]…]` from the axis back to the axis, `segments` (around Y) |
| extrude | `points:[[x,y]…]` outline in local XY (may be concave), `depth` (centred on Z), `holes?`, `round?`, `roundSegments?` |
| revolve | `profile:[[x,y]…]` closed section with x ≥ 0, `angle` (degrees), `segments` |
| sweep | `profile:[[x,y]…]` closed section, `path:[[x,y,z]…]`, `smooth?`, `pathSegments?`, `caps?` |
| mesh | top-level `mesh: { vertices, faces:[{ id, vertices, material }] }` |
| group | no geometry: a pivot or container |

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
