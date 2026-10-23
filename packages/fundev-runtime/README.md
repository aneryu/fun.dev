# fundev-runtime

The [fun.dev](https://fun.dev/docs) runtime kit for three.js projects: the same modules the
fun.dev player runs, as plain ES modules with Three.js injected (`{ THREE }`), so your page
keeps one copy of three.

```sh
npm install fundev-runtime three
```

```js
import * as THREE from "three";
import { createFun3d, createModels, worldData, createWorld } from "fundev-runtime";

const fun3d = createFun3d({ THREE });
const models = createModels({ THREE, scene });

// One tile or model (.fun3d): load it, place copies, read its data.
const tile = await fun3d.load(bytes, { resolve: (id) => loadModel(id) });   // resolve: the library models the tile places
const copy = models.place(tile, { position: [0, 0, 0] });
const data = worldData(tile);
data.markers("spawn"); data.zone("safe_1").contains(p); data.path("lap").at(0.5);
data.height(x, z); data.surface(x, z); data.cell(x, z); data.gridPath(a, b);
data.network("road").route(a, b); data.walk(a, b); data.run("floor_layout", { seed });

// A world of tiles (world.json from the workshop's exportWorld): streamed by distance.
const world = await createWorld({ fun3d, models, physics, read, json }, "worlds/island/world.json");
world.focus(player.position);            // each frame; near tiles within a tile size, far files within four
await world.settle();                    // loading screens, tests
world.height(x, z); world.markers("spawn"); world.walk(a, b); world.network("road").route(a, b);
```

What is here (each also importable as `fundev-runtime/kit/<file>.js`):

- `createFun3d` — read, validate, load and write `.fun3d` files ([format](https://fun.dev/docs)); `createWriter` for Three.js scenes.
- `createModels` — place loaded models: batched rigid parts, instanced placements, LOD, lights offered to `createLightSlots`.
- `createMaterials` — the platform's TSL materials (pass `TSL` from three/tsl) for batching and tints.
- `createPhysics` — Jolt bodies and vehicles from a model's physics section; pass `Jolt` (or `loadJolt`) yourself.
- `createAnimator`, `createFixedStep` — clips and a fixed-step loop.
- `worldData`, `createWorld`, `buildNetwork` — markers, zones, paths, terrains, grids, the walkable raster, runtime rules, road routing, streaming.
- `evaluateScatter`, `evaluateAssembly`, `evaluateLots` — the rules the workshop bakes, for play time.
- `generateHeights`, `heightAt`, `terrainMesh`, `gridMesh`, `gridPath`, `sweepPath`, `sweepNetwork`, `navPath` — the generators and queries themselves.

Files come from the [fun.dev workshop](https://www.npmjs.com/package/fundev-workshop) (`exportTile`, `exportWorld`) and the public CC0 model library. Node 22 or newer for tooling; browsers with WebGPU or WebGL 2 for play.

MIT.

## Local scene and effect integration

The current local kit is verified against Three.js 0.186.1. The peer range now
matches r186; older releases are not certified for the exported RenderPipeline
and TSL helpers. No package publication or dependency upgrade is implied.

`createPresentation(context, data)` applies version-1 camera, HDR/IBL, exposure,
light slots and AO/bloom/grade settings. `createTimeline(data, bindings)` advances
bounded transform tracks and state with play/pause/reset/seek; physics keeps
reset/replay semantics. Both keep DOM input outside the shared core.

`createRippleExtension({ THREE, TSL, backend })` is a trusted built-in consumer
registered as `extensions['fun3d.ripple']` when constructing `createFun3d`.
Assets contain parameters only. Loader `signal` cancels at asynchronous
boundaries and releases resources already created; `dispose()` is idempotent.
See [source, fixtures and acceptance](../../docs/workshop-toolchain.md).
