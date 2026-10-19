# .fun3d for agents — one page

`.fun3d` is fun.dev's model format ([specification](model-format.md)): one file with a JSON
manifest and binary streams in WebGPU vertex formats, carrying meshes with their copies and
levels of detail, materials as platform shading models plus features, images, skeletons and
rigs, clips, and physics (Jolt). Games load it through the runtime kit; nothing in it is code.
Release 1 of the runtime (§10 of the specification) loads meshes, placements, skins, morph
targets and node-channel clips, batches rigid parts, and builds static and dynamic bodies and
wheeled vehicles; the rest of the manifest is accepted, kept and reported.

## Three ways to produce a file

1. **A GLB through the library profile** (`fundev-library@1`, §6): what the maintenance script
   does to every approved model. Names carry the conventions (`static__<material>` parts,
   `<pivot>__<material>` splits, `wheel_*`, `collider*`, `mat_light`, `mat_body`…), the
   profile turns them into data (merged parts, emitter roles, tint, hulls, vehicles, rigs).

   ```sh
   npm run fun3d -- convert model.glb --type vehicle --name city_taxi_01     # → model.fun3d
   npm run fun3d -- inspect model.fun3d          # what it holds; --json for the manifest
   npm run fun3d -- validate model.fun3d         # every problem, exit 1 when any
   ```

2. **Three.js objects in Node or a browser**: `createFun3d({ THREE, encoder }).write(root, options)`.
   Object names are ids (`[A-Za-z0-9_-]`, 1–64 characters; other names map through the id rule
   and may not collide), geometry, material and texture names likewise. Materials take features
   through `material.userData.fun3d = { features: { emitter: { role: "lamp", color, intensity }, tint: {} } }`;
   groups mark flat faces with `group.flat = true`; physics is a descriptor by id
   (`{ shapes, bodies, vehicles }`, §4.7) with convex `points` as a flat array; `animations`
   are AnimationClips whose tracks name nodes; `asset` names the source.

   ```js
   import { createFun3d } from "./site/runtime/kit/fun3d.js";      // scripts/fun3d-convert.mjs shows the Node setup
   const bytes = await fun3d.write(root, { asset: { name: "crate" }, physics, animations: [clip] });
   ```

3. **The workshop** (`/workshop/`, release 3): saves `.fun3d` with its editing section and exports GLB.
4. **A blueprint**: `npm run derive -- --blueprint lamp-post --id street_lamp_02 --set height=5`
   builds a parametric family's member headless and writes a library upload folder with
   `model.glb`, `source.funmodel.glb`, `model.fun3d` and `meta.json` ([model
   editor](model-editor.md#blueprints-and-derivation)).

## Using a file in a game

```jsonc
// game.json
{ "models": { "city_taxi_01": "v003", "street_lamp_01": "v001" }, "modelFormat": "fun3d" }
```

The build converts each pinned version through the profile (cached by source and converter) and
writes `<id>/models.lock` in the games repository; commit it with `game.json`. Files are served as
`models/<id>@<version>.fun3d` blobs.

```js
const { THREE } = context, TSL = THREE.TSL;
const { createFun3d } = await context.runtime("kit/fun3d.js");
const { createMaterials } = await context.runtime("kit/materials.js");
const { createModels } = await context.runtime("kit/models.js");
const { MeshoptDecoder } = await context.runtime("addons/MeshoptDecoder.js");
const materials = createMaterials({ THREE, TSL });
const fun3d = createFun3d({ THREE, decoder: MeshoptDecoder, materials });
const taxi = await fun3d.load(new Uint8Array(await (await fetch(context.asset("models/city_taxi_01@v003.fun3d"))).arrayBuffer()));
const car = models.place(taxi, { position: [0, 0, 0], tint: [1, 0.2, 0.2] });   // batched with every other rigid part
car.node("wheel_fl"); car.socket("hub"); car.live = true;                         // Object3Ds; live copies follow their nodes
materials.roles.set("headlight", 0);                                               // every emitter of a role at once
const { createLightSlots } = await context.runtime("kit/lights.js");
const lights = createLightSlots({ THREE, scene, kind: "spot", tier: graphics.tier });  // real lights lent to the nearest lamps
const models = createModels({ THREE, TSL, materials, scene, lights });            // (pass lights here when creating models)
lights.factor = night;                                                             // lamps off by day
models.update(camera, { height: viewport.height, dt, at: car.position });         // each frame before rendering

const { createPhysics } = await context.runtime("kit/physics.js");
const physics = await createPhysics({ THREE, scene });                             // Jolt, served with the platform
physics.addStatic({ type: "box", halfExtents: [50, 0.5, 50] }, { position: [0, -0.5, 0] });
const handle = physics.add(car);
handle.vehicles.get("car").drive({ throttle: 1, steer: 0.2 });
physics.step(dt);                                                                  // fixed steps inside
context.onCleanup(() => { physics.dispose(); models.dispose(); taxi.dispose(); });

const { createAnimator } = await context.runtime("kit/animation.js");
const animator = createAnimator({ THREE }, models.place(walker));
animator.play("walk", { fade: 0.2 }); animator.update(dt);
```

Without the TSL builder (`createFun3d({ THREE, decoder })`), files load into Three.js's own
materials: roles and tints do not apply, everything else does.

### A scene tile

A tile written by the workshop ([worlds](worlds.md)) places library models by reference; load
it with `resolve`, which returns each referenced model loaded, and read its data with
`kit/world.js`:

```js
const { worldData } = await context.runtime("kit/world.js");
const files = new Map();
const tile = await fun3d.load(bytes, {
  resolve: async (model) => files.get(model) ?? files.set(model, await fun3d.load(await load(`models/${model}.fun3d`))).get(model),
});
const copy = models.place(tile);                     // the placed models' objects come with the copy
const data = worldData(tile);
for (const m of data.markers("spawn")) spawnAt(m.position, m.rotation, m.params);
data.zone("safe_1").contains([x, y, z]); data.zonesAt(position);
const lap = data.path("lap"); lap.at(0.5).position; lap.nearest(position).distance; lap.length;
lap.kind; lap.lanes; lap.width; lap.frame(0.5).right;   // what the workshop swept: kind, lanes, the profile's width; a frame along it
const roads = data.network("road");                     // paths of one kind (or tag) welded at shared points, one-way edges directed
roads.route(car.position, goal);                        // { found, points, length, edges }
data.cell(x, z);                                        // a grid's cell: { col, row, type: { id, walkable, buildable, tags }, level, height }
data.gridPath(spawn, keep, { diagonal: true });         // A* over walkable cells: { found, cells, points, length }
```

`data.height(x, z)` and `data.surface(x, z)` read the tile's terrains (`fun3d.terrain`: the
field, its surface table with friction and tags, its water level); the terrain's mesh has a
static body already. `world.json` lists the world's tiles (`x`, `z`, file, SHA-256, bounds,
a `far` file), its `data` file (`world.fun3d`: the markers, zones, paths and runtime rules of
the whole world) and the models' files; a game build pins them like any model. `createWorld`
streams it:

```js
import { createWorld } from "/runtime/kit/world.js";
const world = await createWorld({ fun3d, models, physics, read: assets.arrayBuffer, json: assets.json }, "worlds/island/world.json");
const [spawn] = world.markers("spawn");               // the data file answers before any tile
world.focus(spawn.position);                           // each frame: near tiles within a tile size, far files within four, bodies with the near ones
await world.settle();                                  // wait for the first tiles (loading screen)
world.height(x, z); world.zone("safe_1").contains(p); world.path("lap").nearest(p); world.run("floor_layout", { seed });
world.tiles();                                         // [{ x, z, state: "near" | "far" | "none", distance }]
world.dispose();
```

A model node with `placements` (a scatter rule's copies)
loads as instanced parts, lights its lamps once per copy and yields one marker per copy
(`id#index`). Rules the workshop left for play time (`fun3d.rules`) run in the game:

```js
for (const rule of data.rules()) console.log(rule.id, rule.kind, rule.models);
const floor = data.run("floor_layout", { seed: run });          // rows per model, tile space
for (const { model, rows, tints } of floor.placed)
  for (const [i, [x, y, z, rx, ry, rz, s]] of rows.entries())
    models.place(files.get(model), { position: [x, y, z], rotation: quaternionFromDegrees(rx, ry, rz), scale: s, tint: tints?.[i] });
```

## What to check

- `npm run fun3d -- validate` on anything you produce; `npm test` and `npm run verify -- fun3d`
  (synthetic scenes alone and in batches, Jolt, clips, and the GLBs in `$FUNDEV_FUN3D_SAMPLES`).
- Conventions: metres, +Y up, front +Z, quaternions `[x, y, z, w]`, colours sRGB `#rrggbb`,
  intensities in candela against the platform exposure (§4). Caps are in §5.
- A regeneration that changes an id or a bone order is a new version, never an update.
