# .fun3d — fun.dev's model format (draft 1, 2026-10-18)

Status: **draft for review.** A working prototype is on branch `platform/model-format` (runtime
modules in `site/runtime/kit/`, harness in `dev/fun3d/`). Nothing is released and no library
data has changed.

## Decisions

Agreed with the owner on 2026-10-18 before any design:

1. **Goal**: fit Three.js and WebGPU completely, and carry animation, skeletons and
   physics-engine bindings.
2. **Kinds**: models and animation packs. Scenes stay placement lists that reference models
   ([models](models.md)); behaviour stays in game code.
3. **Own format**, `.fun3d`. The workshop saves it, the library stores it, games load it. GLB is
   only imported and exported.
4. **One file, two sections**: the runtime section (meshes, materials, skins, animations,
   physics) and an optional editing section (the workshop's document). Games get the file
   without the editing section; the library keeps it whole.
5. **Physics engine: Jolt** (single-threaded WebAssembly, MIT), provided by the platform and
   loaded on first use. Physics data follows Jolt's concepts.
6. **Materials are platform types** implemented in TSL; a file names the type and its
   parameters.
7. **Migration**: every library model is converted; the console converts GLB uploads in the
   browser; the original GLB stays as the download.
8. **Three.js both ways**: one module reads files into Three.js objects and writes Three.js
   objects into files, in browsers and Node.
9. **Order**: this draft and a prototype first; implementation after review.

## Overview

A `.fun3d` file is a signature and chunks. The JSON chunk describes the model; BIN chunks hold
its data, laid out in WebGPU vertex formats so arrays go to the GPU as they are; EDIT chunks
hold the workshop's editable document.

| In the file | In Three.js |
| --- | --- |
| node | `Object3D`, `Bone`, `Mesh`, `SkinnedMesh` or `InstancedMesh`, with its name, transform and children |
| node with a quantized mesh | the node as an `Object3D` (it stays the pivot), its `Mesh` a child that dequantizes |
| geometry | `BufferGeometry`; attributes are typed arrays straight from the file |
| material (type + parameters) | `MeshStandardMaterial`, `MeshPhysicalMaterial`, `MeshBasicMaterial` or `MeshToonMaterial`; types Three.js lacks keep their parameters in `userData.fun3d`; batches use one palette `NodeMaterial` |
| texture | `Texture` from the encoded image (WebP, PNG, JPEG or KTX2) |
| skin | `Skeleton`, bound like GLTFLoader binds it |
| animation | `AnimationClip` with keyframe tracks named as Three.js expects |
| physics | descriptors pointing at the loaded objects, turned into Jolt bodies by `kit/physics.js` |

Names are sanitized like GLTFLoader does (`mixamorig:Hips` becomes `mixamorigHips`), so games
find parts and clips address bones the same way as with glTF.

## Container

```
signature   89 46 55 4E 33 44 0D 0A          "\x89FUN3D\r\n" (catches text-mode transfers)
chunk*      type     4 ASCII bytes            JSON, BIN␠, EDIT, EBIN
            flags    u32 little endian        bit 0 deflate (raw DEFLATE), bit 1 editing
            length   u32                      stored length
            data     length bytes, zero-padded to a multiple of 4
```

- The JSON chunk comes first. BIN chunks follow in the order `buffers` lists them; EDIT and
  EBIN chunks last.
- Deflate is decoded with the platform's `DecompressionStream("deflate-raw")`: native in every
  current browser and in Node, no library. The CDN does not compress model files
  (`games.fun.dev` serves them as they are), so the file compresses itself.
- Removing the chunks with the editing flag gives the runtime copy without decoding anything
  (`stripEditing`).
- Unknown chunk types are skipped.

## Manifest (JSON chunk)

```jsonc
{
  "format": "fun3d", "version": 1, "kind": "model",        // or "animations"
  "name": "city_taxi_01", "generator": "fun.dev fun3d 1",
  "buffers": [{ "byteLength": 5304 }, { "byteLength": 812004 }],  // BIN chunks in order
  "streams": [{ "buffer": 0, "offset": 0, "length": 812, "count": 412, "stride": 8, "codec": "meshopt-attributes" }],
  "nodes": [], "geometries": [], "materials": [], "textures": [], "skins": [], "animations": [],
  "physics": {}
}
```

Units are metres, kilograms, seconds and radians; +Y is up and the front faces +Z (the
library's conventions).

**Streams.** A stream is a typed array after decoding: `count` elements of `stride` bytes.
`codec` is `meshopt-attributes` (meshopt's vertex codec), `meshopt-triangles` (its index
codec) or absent (raw bytes). The meshopt decoder is already part of the runtime; the
encoder is needed only to write.

**Nodes** in depth-first order; node 0 is the root.

```jsonc
{ "name": "wheel_front_left", "parent": 0, "position": [0.82, 0.33, 1.31], "quaternion": [0, 0, 0, 1], "scale": [1, 1, 1],
  "role": "part",                 // static | part | collider | socket
  "bone": true,                   // a skeleton joint
  "hidden": true,
  "mesh": { "geometry": 2, "material": [0, 1], "castShadow": true, "receiveShadow": true,
            "instances": { "stream": 9, "format": "mat4", "count": 20 }, "morph": ["smile"] },
  "skin": 0 }
```

**Geometries.** Attributes reference streams with a WebGPU vertex format.

| Attribute | Format | Notes |
| --- | --- | --- |
| `position` | `snorm16x4` | quantized to the bounds with one scale for all axes (14 significant bits): `position = offset + value × scale`; rigid meshes keep it on the GPU, skinned and morphed ones are expanded when loaded |
| `normal` | `snorm8x4` (`snorm16x4` when morphed) | absent for flat geometry: welded vertices, normals from screen-space derivatives |
| `uv`, `uv1` | `unorm16x2` (12 bits) when inside 0–1, else `float32x2` | only when a material samples a texture |
| `skinIndex` | `uint8x4` or `uint16x4` | |
| `skinWeight` | `unorm8x4` | sums to exactly 255 |
| `color` | `unorm8x4` | |
| `material` | `uint8x4` (x) | slot of the triangle's material, for drawing all slots at once |
| others | `float32xN` | |

```jsonc
{ "vertices": 412, "attributes": { "position": { "stream": 0, "format": "snorm16x4" } },
  "index": { "stream": 3, "format": "uint16" },
  "quantization": { "offset": [0, 0.73, -0.02], "scale": 2.2504 },
  "groups": [{ "start": 0, "count": 1800, "material": 0 }],   // opaque slots first, then glass
  "morphTargets": [{ "name": "smile", "position": { "stream": 5, "format": "float32x3" } }],
  "bounds": { "min": [-0.9, 0, -2.2], "max": [0.9, 1.46, 2.2] } }
```

**Materials** are platform types. Colours are sRGB hex like the workshop's.

| Type | Parameters | Three.js today |
| --- | --- | --- |
| `standard` | `color`, `roughness`, `metalness`, `emissive`, `emissiveIntensity`, `opacity`, `alphaTest`, `side`, `maps` (`color`, `normal`, `metallicRoughness`, `occlusion`, `emissive`, `alpha`), `tint` | `MeshStandardMaterial` |
| `glass` | `color`, `roughness`, `transmission`, `ior`, `thickness` | `MeshPhysicalMaterial` |
| `light` | standard + `role` (`light`, `light_red`, `signal_red`, `window`, `lamp`, …) | standard; a batch scales its emission by the role's intensity (headlights on at night with one call) |
| `unlit` | `color`, `maps.color` | `MeshBasicMaterial` |
| `toon` | `color`, `maps` | `MeshToonMaterial` |

Later types (each a TSL material in the kit, files only name them): foliage with wind, water,
toon hair, skin with decals, screens.

**Textures**: `{ "stream", "mime", "colorSpace": "srgb" | "linear", "wrap": ["repeat", "clamp"], "name" }`.
Images are stored in a BIN chunk without deflate, as their source encoded them; several
textures may share one image.

**Skins**: `{ "joints": [node indices], "inverseBindMatrices": { "stream", "format": "mat4" }, "rig": "mixamo" }`.
`rig` names the skeleton family (`mixamo`, `ue` for the Unreal-style rig the workshop's people
use, or `custom`); animation packs declare the same field.

**Animations**: tracks address nodes by index; the loader names them for Three.js.

```jsonc
{ "name": "walk", "duration": 1.03,
  "tracks": [{ "node": 4, "path": "quaternion",                // position | quaternion | scale | morph:<index>
               "times": { "start": 0, "fps": 30, "count": 32 }, // or { "stream" } when not uniform
               "values": { "stream": 41, "format": "snorm16x4" }, "interpolation": "step" }] }
```

Rotations are 16-bit unit quaternions; other values 32-bit floats.

**Animation packs** (`"kind": "animations"`) hold a skeleton's nodes (bones only, for the rest
pose) and clips. Any model with the same `rig` and bone names plays them.

## Physics

Descriptors map onto Jolt's settings classes; node references are node indices (names before
writing, objects after loading).

```jsonc
"physics": {
  "shapes": [
    { "type": "box", "halfExtents": [0.4, 0.4, 0.4] },
    { "type": "sphere", "radius": 0.3 }, { "type": "capsule", "halfHeight": 0.6, "radius": 0.25 },
    { "type": "cylinder", "halfHeight": 0.5, "radius": 0.2 },
    { "type": "convex", "points": [/* x, y, z… in the root's space */] },
    { "type": "mesh" }                                   // the visible meshes (static bodies only)
  ],
  "bodies": [{ "node": 0, "shape": 0, "motion": "static" | "kinematic" | "dynamic", "mass": 1200,
               "friction": 0.5, "restitution": 0.1, "linearDamping": 0.05, "angularDamping": 0.05 }],
  "constraints": [{ "type": "hinge" | "fixed" | "point" | "slider" | "cone" | "swingTwist" | "sixDOF" | "distance",
                    "bodies": [1, 0], "point": [], "axis": [], "limits": {}, "motor": {} }],
  "vehicles": [{ "type": "wheeled", "body": 0,
                 "wheels": [{ "node": 2, "position": [0.82, 0.33, 1.31], "radius": 0.33, "width": 0.22,
                              "suspension": { "min": 0.05, "max": 0.25, "frequency": 1.6, "damping": 0.5 },
                              "steer": 0.6, "brake": 1500, "handbrake": 4000 }],
                 "engine": { "maxTorque": 300, "minRPM": 1000, "maxRPM": 6000 },
                 "transmission": { "mode": "auto", "gears": [2.66, 1.78, 1.3, 1.0, 0.74], "reverse": [-2.9] },
                 "differentials": [{ "left": 0, "right": 1, "ratio": 3.42, "share": 1 }], "antiRoll": [] }],
  "ragdolls": [{ "parts": [{ "name": "thigh_l", "joint": 45, "parent": "pelvis", "to": 46, "radius": 0.075, "mass": 7,
                             "limits": { "cone": 1.0, "twist": [-0.4, 0.4] } }] }],
  "character": { "shape": 2, "offset": [0, 0.9, 0], "maxSlope": 0.8 }
}
```

- Vehicles are Jolt `WheeledVehicleController`s; wheels follow suspension, steering and spin,
  composed with the wheel node's authored rotation.
- Ragdoll parts are capsules from a joint to the next part's joint, built from whatever pose
  the skeleton has when the ragdoll starts (an animation frame, for example); bones between
  parts keep their local pose. Jolt can also drive a ragdoll towards an animated pose with
  motors (`DriveToPoseUsingMotors`), which is how hits blend into animation.
- `character` describes a capsule for Jolt's `CharacterVirtual` controller.

## Roles and conventions

The library's names stay the contract; `role` records what they mean:

- `static`: every static mesh merged into one part (from `static__<material>` nodes);
- `part`: any other named node a game may move (`wheel_*`, `steer_*`, `*_hinge`, doors);
- `collider`: hidden geometry the physics uses (`collider*` nodes);
- `socket`: an attachment point (`socket_*`).

Materials named `mat_light*`, `mat_signal*`, `mat_window*`, `mat_lamp*`, `mat_screen*` and
`mat_beacon*` are `light` with that role; `mat_body` may be `tint` (a per-copy colour).

## Editing section

The EDIT chunk holds the workshop's project (`fun.dev/model` document: polygons with face IDs,
recipes, links, assemblies). The runtime section is always written from it, so opening a
library model in the workshop restores its recipes. Large geometry moves to EBIN chunks with the
workshop's binary storage (roadmap stage 2).

## Versioning

`version` is 1. Additions that old readers can ignore keep the version; anything else raises
it. Runtimes read every version up to their own and refuse newer ones with a clear message.
Approved library versions are never rewritten, so the runtime keeps reading old versions.

## Runtime

| Module | Does |
| --- | --- |
| `kit/fun3d.js` | `createFun3d({ THREE, encoder, decoder })` → `write(object, { kind, animations, physics, rig, edit })`, `read(bytes)`, `load(bytes)`; `stripEditing(bytes)` |
| `kit/fun3d-import.js` | GLB → normalized Three.js objects, roles and physics (below) |
| `kit/models.js` | `createBatch({ THREE, TSL })`: every rigid part of every model in one `BatchedMesh` (plus one for glass), one palette material, role intensities |
| `kit/physics.js` | `createPhysics({ THREE })`: a Jolt world; `add(model)` makes its bodies, vehicle and ragdoll; `step(dt)` moves the Three.js objects |

```js
const fun3d = createFun3d({ THREE, encoder: MeshoptEncoder, decoder: MeshoptDecoder });
const taxi = await fun3d.load(await (await fetch("models/city_taxi_01.fun3d")).arrayBuffer());
scene.add(taxi.scene);
const physics = await createPhysics({ THREE });
const car = physics.add(taxi);
car.vehicle.drive({ throttle: 1, steer: 0.2 });
const walk = (await fun3d.load(packBytes)).animations.find((clip) => clip.name === "walk");
```

Jolt is vendored under `/vendor/jolt/` (0.6 MB compressed) and loaded by the first
`createPhysics`; the meshopt encoder (24 KB) is needed only where files are written.

## Importing GLB

What the console does to every upload and the workshop to every import:

- static parts merge into `static`; a moving part split by material (`wheel_front_left__mat_rubber`
  under `wheel_front_left`) merges into its pivot; every other mesh node merges its primitives;
- flat faces are welded without normals; texture coordinates go when nothing samples them;
- vertices are ordered for the GPU's vertex cache (meshopt), which also compresses better;
- materials get types from their names and properties;
- physics: props get a convex hull (of `collider*` nodes when present), pieces their mesh,
  models with `wheel_*` nodes a wheeled vehicle, characters a capsule and a ragdoll for their
  rig;
- skins, morph targets and clips carry over; a file with clips and no meshes becomes an
  animation pack;
- textures keep their encoded bytes.

## Measurements (prototype)

The 220-model library sample used for the workshop's import tests, converted in a browser in
14 seconds with no failures:

| | GLB today | gltfpack (best standard glTF) | .fun3d |
| --- | --- | --- | --- |
| total | 82.0 MB | 14.8 MB | 9.7 MB |
| median model | 79.7 KB | 17.9 KB | 4.9 KB |
| vertices | 2.53 M | | 1.27 M |

Single files: `city_taxi_01` 332 KB → 7.0 KB (with its vehicle physics); a restaurant sink
297 KB → 6.1 KB; a character with 10 WebP textures 1028 KB → 1028 KB (as small as its Draco
original; textures are 77% of it); the library's Mixamo character 5.3 MB → 2.1 MB; an
animation pack with 19 clips 1117 KB → 107 KB. Import, write and load take 4, 2 and 1 ms for
a median model.

Rendering 600 copies of 60 library models (3.3 M triangles) on this machine's GPU, earlier
the same day: today's GLBs draw in 31.5 ms per frame with shadows on WebGPU (12.8 ms on
WebGL 2) and 4671 draw calls; one batch with a palette material draws in 3.3 ms (1.3 ms) with
two draw calls on WebGL 2, and the first frame comes 3–4× sooner.

The prototype implements the container, both directions of the Three.js mapping (tested in
`tests/fun3d.test.mjs`), the importer, batches with light roles, and Jolt shapes, bodies,
wheeled vehicles and ragdolls. Constraints, the character controller, per-copy tints and the
editing section's binary geometry are specified here but not built yet.

The prototype scene (`node dev/fun3d/demo.mjs <site> <shots>`) puts 62 batched props with
convex colliders on a street, drives the converted taxi as a Jolt vehicle through a stack of
dynamic crates, and plays the walk clip of a converted animation pack on a converted
character before it falls as a ragdoll. It runs identically on WebGPU and WebGL 2.

## After approval

- **Library**: store `model.fun3d` beside the original `model.glb`; the console converts
  uploads in the browser (the same importer); convert the 1147 listed models once with the
  maintenance script; model pages, thumbnails and "Open in workshop" read `.fun3d`.
- **Games**: `game.json` pins resolve to `.fun3d` files; the kit modules above; each game
  adopts them on its own schedule (帝都's taxi and street furniture first).
- **Workshop**: saves and opens `.fun3d` (the editing section replaces `.funmodel.glb`),
  exports GLB for other tools, and gains physics commands with a Jolt preview.
- **Platform**: Jolt and the meshopt encoder in the runtime, the CSP allowing their
  WebAssembly where games run, tests in `npm run verify`.

## Open questions

1. Vehicles: 13 of the 220 sample models have `wheel_*` nodes. Should only models typed as
   vehicles get vehicle physics (a wheelbarrow would rather be a body with free wheels)?
2. Character controller (`CharacterVirtual`) in version 1, or later?
3. Textures: keep each source encoding (WebP, JPEG, PNG) or transcode to KTX2 when converting
   (GPU-compressed, smaller in memory, larger on disk)?
4. Morph targets: 32-bit deltas today; quantize like positions?

## Later

Custom TSL node graphs, prefabs with behaviour, scenes inside the format, level-of-detail
chains (meshopt simplifier), GPU culling with compute and indirect draws, streaming large
models in pieces, KTX2 transcoding, soft bodies and cloth, and per-copy light roles in
batches.
