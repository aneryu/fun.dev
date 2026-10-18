# fun.dev model format (proposal, 2026-10-18)

Status: proposal, nothing implemented. Decisions at the end.

The workshop replaces Blender for the agents that make models ([roadmap](platform-roadmap.md)).
Before agents produce models in bulk, the format they produce should suit the engine every game
uses: Three.js `WebGPURenderer` (WebGPU, or its WebGL 2 backend on devices without a WebGPU
adapter). Library models today are GLBs as Blender exports them: correct, but laid out for
interchange, not for drawing hundreds of them at once.

## Findings

Measured on the library (1147 models) and on a scene of 600 copies of 60 library models
(3.28 million triangles) rendered on this machine's GPU. Prototype code was throwaway; the method
is repeatable.

Library GLBs (184 MB in total, median 40 KB):

- 2.0 vertices per triangle: flat-shaded faces split every vertex for its normals. Welded, the
  same models need half the vertices.
- 516 models carry UVs but only 2 have a texture: 8 bytes per vertex for nothing.
- 9.5 draw calls per model on average, for 2.9 materials: parts are separate meshes, and every
  mesh draws once per material.
- Served uncompressed: `games.fun.dev` (R2) sends `model/gltf-binary` without content encoding,
  so the file's own size is the download.

The scene, four ways (WebGPU with shadows unless noted; frame = median of renderer submit plus
GPU completion; first frame includes shader and pipeline creation):

| | download | load + build | first frame | frame (CPU) | frame, WebGL 2 | draw calls, WebGL 2 |
| --- | --- | --- | --- | --- | --- | --- |
| Today: GLTFLoader, a clone per copy | 11.6 MB | 128 ms | 438 ms | 31.5 ms (20.3) | 12.8 ms | 4671 |
| Standard glTF compression (gltfpack) | 2.2 MB | 118 ms | 468 ms | 37.8 ms (28.2) | 13.7 ms | 4671 |
| Same GLBs merged at load into palette geometry, one BatchedMesh | 11.6 MB | 139 ms | 117 ms | 3.4 ms (0.3) | 1.5 ms | 2 |
| Compiled files (below), one BatchedMesh | 1.35 MB | 58 ms | 129 ms | 3.3 ms (0.3) | 1.3 ms | 2 |

GPU buffers for the 60 models: 11.3 MB today, 4.2 MB compiled.

What the numbers say:

1. **Speed comes from the runtime, not the file.** One geometry per part with a palette of
   materials, and every model of a scene in one `BatchedMesh` with one material, makes frames
   about 10× faster on both backends, cuts CPU time per frame about 60×, and the first frame
   3–4× (one pipeline instead of one per material and object). That works even on the unchanged
   GLBs. Phones spend far more CPU per draw call than this desktop, so the gap there is larger.
2. **Size and load time come from compiling.** Welding flat faces, dropping unused attributes,
   16-bit positions and meshopt compression make downloads 8.6× smaller than today (1.6× smaller
   than gltfpack) and halve load time, because nothing is merged in the player.
3. **A custom container adds almost nothing.** The same data in an own binary container with
   deflate is 0.89 MB; standard compressed glTF with deflate is 0.91 MB. glTF's JSON is a quarter
   of a small compressed file, but only because the CDN does not compress GLB. A custom container
   would cost compatibility with every glTF tool and with today's games, and would have to
   reinvent skins, animation and textures for the later workshop stages.

## Design

The format is new where it matters for Three.js and WebGPU: the data layout, the rules, the part
and material semantics, and the runtime that draws it. The container stays GLB, so a compiled
model is still a valid glTF file.

### Runtime: `kit/models.js`

```js
const models = createModels(context);
const taxi = await models.load("models/city_taxi_01.glb");
const city = models.batch();                 // add city.object to the scene
const car = city.add(taxi, matrix, { tint: 0xf2c94c });
car.part("wheel_front_left").rotation.x = turn;   // moving parts are instances too
city.roles.light = night * 2.5;              // every headlight and window in the batch
```

- `load` decodes a compiled file straight into GPU-ready arrays (meshopt → typed arrays →
  attributes, no copies). Any other GLB goes through GLTFLoader and is merged at load: same
  result, slower to load.
- `batch()` holds any number of models in one `BatchedMesh` for opaque surfaces and one for glass
  and blended ones, sharing one palette material. Copies, moving parts, tints and removal are
  per-instance operations; shadows, raycasting and frustum culling come with `BatchedMesh`.
- `mesh(model)` returns an ordinary object (one mesh per part) for something a game animates on
  its own, such as the player's car.
- The palette material is one TSL `MeshStandardNodeMaterial`: a per-vertex palette index
  (`unorm8x4`, filled at load) reads colour, roughness, metalness, emission and opacity from a
  palette texture; flat faces take their normal from screen-space derivatives; palette entries
  with a role (`light`, `signal`, `window`, `lamp`) scale their emission by the batch's role
  intensity; `tint` entries multiply by the instance's colour. All models share one pipeline.

### Compiled model (runtime profile 1)

A GLB that follows these rules (the compiler produces them; a validator checks them):

- `extensionsRequired`: `KHR_mesh_quantization`, `EXT_meshopt_compression` (both read by
  GLTFLoader with the runtime's MeshoptDecoder). `extensionsUsed` adds `FUNDEV_model` and the
  material extensions the source used.
- Library conventions unchanged: metres, +Y up, front +Z, root `<id>_ROOT` at the floor centre,
  material names `mat_*`.
- **Parts.** Every static mesh (`static__<material>` under the root, or the workshop's
  `mergeStatic`) merges into one part, `static`. Every other mesh node keeps its name, parent and
  transform, so pivots such as `wheel_front_left` turn as before. `collider` nodes stay, hidden.
- **Geometry**, one glTF mesh per part:
  - `POSITION`: 16-bit normalized, byte stride 8 (the GPU's `snorm16x4`), quantized uniformly
    to the part's bounds. A child node carries the dequantizing translation and scale, so the
    part's own transform stays the pivot.
  - Flat faces have no `NORMAL`: their vertices are welded and the renderer derives the face
    normal (glTF requires flat normals where `NORMAL` is absent). Smooth faces have an 8-bit
    `NORMAL`, byte stride 4 (`snorm8x4`).
  - One primitive per material (and per flat or smooth surface), all sharing the part's vertex
    buffer; their indices are consecutive ranges of one 16-bit index buffer (32-bit above 65 535
    vertices), opaque materials first, then blended and glass ones. Viewers that know nothing of
    fun.dev still draw every material correctly.
  - No texture coordinates, colours or tangents unless a texture uses them (profile 1 is
    untextured).
  - Vertex and index data compressed with `EXT_meshopt_compression`, optimized for vertex cache
    and fetch.
- **Materials**: glTF metallic-roughness as today (with emissive strength, transmission, ior),
  at most 32 per model; their order is the palette.
- **`FUNDEV_model`** (root): `{ "version": 1, "source": "<sha256 of the source GLB>", "parts":
  { "<name>": "static" | "part" | "collider" }, "palette": [{ "role"?: "light" | "signal" |
  "window" | "lamp", "tint"?: true }] }`, derived from the naming conventions (`mat_light*`,
  `mat_signal_*`, `mat_window`, `mat_lamp`; `mat_body` is tintable). Names stay the contract;
  the extension saves the runtime from parsing them.

### Where models are compiled

- **Library models, when a game is built.** `scripts/library-models.mjs` already fetches each
  model a game pins; it compiles it (cached by source hash and compiler version beside the blob
  cache) and serves the result at the same path, `models/<id>.glb`. No library migration, no
  production writes, no change for the uploaders. Existing game code keeps working:
  `assets.gltf()` reads compiled files, part names and pivots are unchanged.
- **The workshop**: **Export for games** writes the compiled profile (for `games/<id>/assets/`);
  **Export GLB** stays the interchange file and the library upload. One compiler module serves
  Node and the browser; the meshopt encoder (MIT) is vendored like manifold.
- Model pages, thumbnails and the workshop keep reading the uncompressed `model.glb` and
  `source.funmodel.glb`.

### Unchanged

Uploads (`model.glb`, `source.funmodel.glb`, `source.blend`), the console, review, the catalogue,
the naming conventions and game pins. Characters, creatures and animations stay standard GLB
until a later profile covers skins.

## Verification

- Every listed library model compiles, and its compiled render in the library stage matches the
  source within 1/255 on average (thumbnail renders before and after).
- A browser check builds the benchmark scene: two draw objects, frame time and first frame
  recorded on WebGPU and WebGL 2.
- Compiled files load in GLTFLoader with the same part names and transforms; the taxi in 帝都
  drives, steers and lights up as before.

## Decisions

1. **Container**: GLB with the profile above (recommended), or an own binary container (about 2%
   smaller after deflate, simpler to parse, no glTF tooling, a second format for characters).
2. **Compile when games are built** (recommended: no migration), or compile at approval and
   store a compiled file per library version (model pages could use it; 1147 to migrate).
3. **Scope**: runtime, compiler, game-build hook and workshop export in one go, verified on the
   library and on 帝都's taxi (recommended), or the runtime alone first (the speed without the
   smaller downloads).

## Later

- Level-of-detail chains generated by the compiler (meshopt simplifier), swapped per instance by
  distance: the library has no triangle budget, so distance is where the cost goes.
- GPU culling on WebGPU (compute shader writing indirect draws) for scenes with tens of thousands
  of copies; per-instance CPU culling stays on WebGL 2.
- Precompressed blobs (stored compressed, served with `Content-Encoding`) for every kind of
  blob, including large JSON.
- Textured models (UVs, KTX2 in a palette atlas), skins and shape keys in a later profile.
- Palette effects in TSL: wind sway for foliage, blinking signals, scrolling water.
- Workshop projects with binary geometry (stage 2) and a viewport drawn by the same runtime.
- Scene files (placement lists, [models](models.md)) loaded straight into a batch.
