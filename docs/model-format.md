# .fun3d — fun.dev's model format (design v5, 2026-10-18)

Status: **design for review.** Three adversarial review rounds (engine realism, format
design, pipeline and operations; a resolution check; fresh eyes) and self-reviews produced
the findings and decisions in `dev/fun3d/review.md`; this document is the result. The v1
prototype on this branch validated the data path (container, GPU vertex formats, quantization
and compression, palette batching, Jolt vehicles and ragdolls); its schema is replaced by
this one. Sections 3–5 are normative for `fun3d` 1.0; appendix A lists what is planned but
not in 1.0.

## 1. Decisions this design serves

Agreed with the owner on 2026-10-18:

1. Fit Three.js and WebGPU completely; carry animation, skeletons and physics bindings.
2. Kinds: models and animation packs. Scenes stay placement lists; behaviour stays in game code.
3. Own format, `.fun3d`; GLB only imported and exported.
4. One file with a runtime section and an optional editing section.
5. Physics engine: Jolt, provided by the platform.
6. Materials are platform types implemented in TSL; files carry parameters.
7. Every library model converts; original GLBs stay.
8. Three.js both ways: load into objects, write from objects, in browsers and Node.
9. Design and prototype first, implementation after review.
10. Extension `.fun3d`.

## 2. Principles

1. **Intent, not rendering.** A file says what a thing is: a mesh and its copies, its levels of
   detail, a light with a physical intensity, a body with a shape. The runtime decides how it
   is drawn and simulated: batched or instanced, which level, how many lights are real, where
   physics steps.
2. **Data shaped for Three.js and WebGPU.** Vertex data in WebGPU vertex formats, grouped into
   buffers Three.js binds as they are; animation as keyframe tracks; skins as Three.js binds
   them. Loading is decoding and wiring.
3. **Stable identity.** Every entity (node, geometry, material, image, texture, skeleton, clip,
   physics object, variant, reference) has a string `id` that survives edits and regeneration
   and is referenced by it. Physical layout (chunks, streams) is addressed by position because
   it has no identity to keep.
4. **Explicit semantics.** Whatever the runtime acts on is structured data with a defined
   meaning. Names carry no meaning; producers' conventions live in import profiles.
5. **Materials compose.** A shading model plus independent features, each with a defined
   fallback, instead of one type per combination.
6. **Extensible on purpose.** Namespaced extensions declared as used or required; runtime
   registries; optional ones drop to a defined fallback, required ones refuse the file by name.
7. **Sources are immutable; derived files are immutable too.** A derived file is fixed for its
   (source, converter, profile); a new converter makes a new derived file, and whoever pins
   the old one keeps it. Nothing is pinned before the converter has proven itself (section 10).
8. **Data only, validated, bounded.** No code; a schema, caps and a validator stand between
   uploads and the loader, and the loader bounds every allocation before decoding.
9. **Many files, not one big file.** Parts reference their base skeleton, tiles share images,
   worlds list tiles. The unit of scale is the file.
10. **Nothing without a producer and a consumer.** The 1.0 schema holds what the first two
    releases build; everything else waits in appendix A.

## 3. Container

```
signature   89 46 55 4E 33 44 0D 0A     "\x89FUN3D\r\n" — also the container version: a new layout gets a new signature
chunk*      type          4 ASCII bytes  "JSON" | "BIN " | "EDIT"; other types are skipped
            flags         u32            bit 0 deflate (raw DEFLATE); bit 1 editing; bits 2–31 reserved, must be 0 (else refused)
            storedLength  u32            bytes of data as stored, padding excluded
            rawLength     u32            bytes after inflating (equal to storedLength when bit 0 is clear)
            data          storedLength bytes, then zero padding to the next multiple of 4; the next header follows the padding
```

- Little endian; the header is 16 bytes. Exactly one `JSON` chunk, first, never flagged
  editing. `EDIT` chunks always carry the editing flag; `BIN` chunks may. Chunks flagged
  editing come after every runtime chunk; the runtime copy of a file is the file with editing
  chunks removed, made without decoding.
- The manifest and the editing document address `BIN` chunks by ordinal among all `BIN`
  chunks in file order (editing `BIN` chunks are last, so stripping changes no runtime
  ordinal).
- Inflation stops at `rawLength`; a chunk that inflates to any other size is refused. The JSON
  chunk is capped (section 5) and parsed only after its size is known, with a null-prototype
  reviver. `DecompressionStream` `deflate-raw` is native in Chrome 103+, Safari 16.4+,
  Firefox 113+ and Node 20.12+.
- Writers put encoded images in `BIN` chunks without bit 0 (their encodings already compress);
  geometry, animation and the manifest deflate.
- No per-chunk checksum: the library addresses files by their hash (`derived.sha256` covers
  the stored bytes of the runtime copy; `asset.source.hash` the stored bytes of the source)
  and games pin hashes.

## 4. Manifest

```jsonc
{
  "fun3d": "1.0",                                              // format version, major.minor
  "kind": "model",                                             // model | animations
  "asset": { "name": "city_taxi_01", "generator": "fun.dev workshop 3.1",
             "source": { "kind": "glb", "hash": "sha256:…", "converter": "sha256:…", "profile": "fundev-library@1", "tool": null } },
  "uses": ["fun3d.wind"], "requires": [],                      // extension names; requires ⊆ uses
  "streams":  [{ "id": "s0", "chunk": 0, "offset": 0, "length": 812, "count": 412, "stride": 8,     // chunk: BIN ordinal
                 "codec": "meshopt", "mode": "attributes" }],  // mode: attributes | triangles; filter: octahedral | quaternion; filterBits
  "nodes": [], "geometries": [], "materials": [], "images": [], "textures": [],
  "skeletons": [], "animations": [], "physics": {}, "variants": [], "refs": [],
  "extensions": {}
}
```

**Conventions.** Metres, kilograms, seconds, radians, candela; right-handed, +Y up, the front
faces +Z. Quaternions are `[x, y, z, w]`, unit length within 1e-3. A transform is
`position`, `rotation` (quaternion) and `scale`, composed translation × rotation × scale;
`mat4` is column-major with a positive determinant. Scale components are positive (writers
bake mirroring). Colours are sRGB hex strings `#rrggbb`; vertex colours and tints are linear.
Light and emission intensities are at most 1000 and finite. Three.js renders unitless
radiance, so intensities only mean something against an exposure: the platform renders every
scene with ACES tone mapping at exposure 1, where a white Lambert surface lit by `I` candela
at `d` metres has radiance `I / (π d²)` and an emitter of intensity `e` has radiance `e`;
radiance 1 maps to about 0.8, above about 8 clips. A 50 cd street lamp lights a white
pavement 3 m below to radiance 1.8; a 3 cd headlight glass reads as an emitter of 3. The
workshop previews with the same settings. UVs follow glTF: origin at the top-left, images
never flipped. Every optional field has a default (section 4.13); an absent `transform` is
identity. Licence and attribution are the catalogue's, not the file's.

**Ids.** Every entity has an `id`: 1–64 characters of `[A-Za-z0-9_.-]`, unique within its
table (tables are separate id spaces; morph targets, wheels, ragdoll parts, socket keys,
regions and variant axes use the same charset). The loader sets `object.name = id` and keeps
the display name in `object.userData.name`, so Three.js name lookups and animation bindings
are unique by construction. Writers derive ids deterministically (section 6 for imports);
writing from Three.js objects maps `object.name` the same way and refuses duplicates. A
regeneration that would change an id or a bone order is a new version.

**Streams** are typed arrays after decoding: `count` × `stride` bytes; without a codec,
`length = count × stride`. `offset` is a multiple of 4; vertex strides and attribute offsets
are multiples of 4 (every format is x2 or x4); index streams use their element size. `codec`
is `meshopt` with `mode` `attributes` (vertex codec; stride a multiple of 4, at most 64) or
`triangles` (index codec), and an optional `filter` with `filterBits` applied after decoding
(`octahedral` into `snorm8x4`/`snorm16x4`, `quaternion` into `snorm16x4`); filters apply to a
whole stream, so filtered attributes have their own stream. The sum of `count × stride` over
all streams is capped (section 5) and checked before anything decodes. meshopt is the only
codec of 1.0; another codec is a minor version that names itself in `requires`.

**Kinds.**

| Kind | Must have | May have | Must not have |
| --- | --- | --- | --- |
| `model` | nodes | everything | — |
| `animations` | nodes (the skeleton's bones), one skeleton (local or referenced), animations | refs (skeletons) | geometries, materials, images, textures, physics, variants, placements, lights |

### 4.1 Nodes

Depth-first; the first entry is the root; `parent` names a node id. A node is a transform with
any of the following; the combinations allowed are in the table after the examples. Bones
are the nodes a skeleton lists; they need no marker.

```jsonc
{ "id": "wheel_fl", "name": "wheel_front_left", "parent": "root",
  "transform": { "position": [0.82, 0.33, 1.31], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },   // in the parent's space
  "mesh": { "geometry": "wheel", "materials": ["rubber", "steel"], "shadow": "both" },   // one material per group; shadow: both | cast | receive | none
  "sockets": { "hub": { "position": [0, 0, 0], "rotation": [0, 0, 0, 1] } },             // attachment frames, in node space
  "tags": ["wheel"] }

{ "id": "face", "parent": "root", "mesh": { "geometry": "head", "materials": ["skin"], "morphWeights": [0.2] }, "skin": "rig",
  "regions": ["head"] }                                                                   // what a part may hide (4.9)

{ "id": "lamps", "parent": "root", "mesh": { "geometry": "lamp", "materials": ["iron"] },
  "placements": { "count": 120, "transforms": { "stream": "s8", "format": "mat4" },     // copies, each in the node's parent space, replacing the node's own transform
                  "tint": { "stream": "s9", "format": "unorm8x4" } } }                  // linear colour per copy, feeds the materials' tint feature

{ "id": "bulb", "parent": "lamp_head", "light": { "type": "spot", "color": "#ffd9a0", "intensity": 50, "range": 12,   // point | spot, candela; spot: cone [inner, outer]
                                                 "cone": [0.4, 0.6], "importance": 0.5 } }

{ "id": "tree", "parent": "root", "lod": { "levels": [{ "screenSize": 1, "children": ["near"] }, { "screenSize": 0.05, "children": ["far"] }] } }
```

| Node has | May also have | Never with |
| --- | --- | --- |
| `mesh` | `skin`, `regions`, `placements` (one static body per copy), `sockets`, `tags`, children (unless placed) | `light`, `lod` |
| `skin` | `mesh`, `regions` | `placements`, `lod`, body |
| `placements` | `mesh`, one static body (one per copy; every copy's matrix uniformly scaled) | children, `light`, `lod`, `skin` |
| `light` | `sockets` | `mesh`, `placements` |
| `lod` | children | `mesh`, `placements`, `skin` |

- `placements` describes repetition; the runtime may instance, batch or merge.
- `lod` on a group: levels in descending `screenSize` (fraction of the viewport height the
  group's bounds cover); each level names the children it shows; a child named at no level is
  always shown; the first level is the group's normal content and its bounds are the union of
  that level's children. Levels of a skinned group share the skeleton.
- `light` is intent with a physical unit; spots shine down the node's −Z (`cone` maps to
  Three.js `angle` = outer and `penumbra` = 1 − inner/outer; inner ≤ outer); `range` 0 means
  unlimited. The runtime owns a fixed set of real light slots per device tier, each with a
  fixed shadow setting, and assigns lamps to them by `importance` (0–1, a relative rank) and
  distance, moving and dimming slots rather than adding or removing lights, because Three.js
  r186 keys shader programs on the set of lights and their shadow flags. No directional lights
  in models.
- Sockets are attachment frames games use (`model.socket(id)`); `tags` are free strings for
  games; the runtime never reads them.
- A node with a physics body is detached to the world at load, children following it; a
  kinematic body follows the node's animation tracks, a dynamic body ignores them.
- Loaded object model: every node is an `Object3D` named by its id; a rigid quantized mesh is
  a child `Mesh` carrying the dequantizing transform, so the node stays the pivot that
  sockets, tracks and physics target; skinned and morphed meshes load with float positions
  and are the node's mesh themselves. Games use `kit/models.js` handles, not the tree.

### 4.2 Geometries

```jsonc
{ "id": "wheel",
  "vertices": 412,
  "buffers": [                                                                 // at most 6; one element type per buffer; at most 11 attributes in all
    { "stream": "s0", "attributes": { "position": { "format": "snorm16x4", "offset": 0 } } },          // Int16 buffer, stride 8
    { "stream": "s1", "attributes": { "normal": { "format": "snorm8x4", "offset": 0 }, "tangent": { "format": "snorm8x4", "offset": 4 } } },  // Int8 buffer, stride 8
    { "stream": "s2", "attributes": { "uv": { "format": "unorm16x2", "offset": 0 } } } ],             // Uint16 buffer, stride 4
  "decode": { "position": { "offset": [0, 0.33, 0], "scale": 0.3401 }, "uv": { "offset": [0, 0], "scale": [1, 1] } },   // value = offset + stored × scale
  "index": { "stream": "s3", "format": "uint16" },                            // required
  "groups": [{ "start": 0, "count": 1200, "material": 0, "flat": false }],    // start and count in indices; material = slot in the node's materials; flat: normals from derivatives
  "lods": [{ "error": 0.01, "index": { "stream": "s4", "format": "uint16" }, "groups": [{ "start": 0, "count": 600, "material": 0 }] }],   // ascending error, relative to the bounds radius; levels reuse the vertices in the file (a batch copies them per level)
  "morph": { "relative": true, "decode": { "scale": 0.02 },                    // deltas: value = stored × scale
    "targets": [{ "id": "jawOpen", "sparse": { "indices": { "stream": "s5", "format": "uint16" } },
                  "position": { "stream": "s6", "format": "snorm16x4" }, "normal": { "stream": "s7", "format": "snorm8x4" } }] },
  "bounds": { "min": [-0.34, 0, -0.34], "max": [0.34, 0.68, 0.34] } }           // in geometry space, after decode; skinned meshes: bind pose
```

| Attribute | Format | Rule |
| --- | --- | --- |
| `position` | `snorm16x4` (14 significant bits, `w` = 0) or `float32x3` | `decode` gives offset and one scale; writers use floats above 20 m extents |
| `normal` | `snorm8x4` | absent or ignored for groups with `flat: true` (screen-space derivatives) |
| `tangent` | `snorm8x4` | `w` is handedness; without it normal maps use derivative tangents |
| `uv`, `uv1` | `unorm16x2` (12 bits, `decode` range) or `float32x2` | present on every geometry a material with maps on that set is used with |
| `color` | `unorm8x4` | linear |
| `skinIndex`, `skinWeight` | `uint8x4`, `unorm8x4` | weights sum to 255; four influences (Three.js's limit); `skinIndex` is a plain, never interleaved attribute that loads as an integer attribute (`gpuType` Int; the WebGPU backend copies it to 32 bits) |
| `_<name>` | any | custom; its meaning belongs to the extension that reads it |

Buffers are grouped by element type because Three.js binds one typed array per interleaved
buffer; the runtime adds its own buffers and attributes (instance matrices take one buffer and
four locations, tint one more), hence the caps of 6 and 11 against WebGPU's 8 and 16.
Vertices at material-slot boundaries and at flat/smooth boundaries are duplicated. Morph
targets are sparse (vertex indices plus values) with their own scale and expand to dense
textures on the GPU (32 bytes per vertex per target), which the caps bound; a face that
carries the expressions is its own geometry. Batchable geometries follow the profile's batch
signature (the same attribute set and formats, padded by the importer), because a batch
holds one layout; batches derive a per-vertex material slot (`unorm8x4`) from `groups` at
load.

### 4.3 Materials

A material is a shading model, parameters, maps and features.

```jsonc
{ "id": "mat_body", "name": "mat_body", "model": "pbr",                   // pbr | unlit
  "color": "#f2c94c", "alpha": { "mode": "opaque", "cutoff": 0.5, "opacity": 1 },   // opaque | mask | blend
  "side": "front",                                                         // front | double
  "pbr": { "roughness": 0.6, "metalness": 0 },
  "maps": { "color": { "texture": "paint", "uv": 0, "transform": { "offset": [0, 0], "scale": [1, 1], "rotation": 0 } } },
  "features": {
    "emitter": { "role": "headlight", "color": "#fff0c8", "intensity": 3, "map": { "texture": "glow", "uv": 0 } },   // core
    "tint": {},                                                             // core: base colour and colour map multiply by the copy's tint
    "transmission": { "amount": 1, "ior": 1.5, "thickness": 0.01, "attenuation": "#ffffff", "attenuationDistance": 0 },   // core; 0 = infinite
    "fun3d.wind": { "strength": 0.2, "frequency": 1.1 } } }                  // extension features by full name
```

| Model | Parameters and maps |
| --- | --- |
| `pbr` | `roughness`, `metalness`; maps `color` (its alpha feeds `alpha` when the mode is `mask` or `blend`), `normal` (`scale`), `metalRough` (G roughness, B metalness), `occlusion` (R, own UV set), `alpha` (overrides the colour map's alpha) |
| `unlit` | maps `color`, `alpha` |

| Feature | `pbr` | `unlit` | Batches |
| --- | --- | --- | --- |
| `emitter` | yes | yes | yes |
| `tint` | yes | yes | yes |
| `transmission` | yes | no | no |
| extensions | as each one states | | |

- `emitter` is the only emission: colour × intensity (× `map`), scaled by a factor per role
  that `kit/models.js` sets (`roles.set("window", 0)` at day). Roles: `headlight`,
  `taillight`, `brake`, `indicator`, `signal`, `window`, `lamp`, `screen`, or any string.
- `tint`: the copy's tint (placements) or `handle.tint` multiplies the base colour and the
  colour map; one tint per model.
- Every other feature is an extension (`fun3d.wind`, `fun3d.clearcoat`, `fun3d.decals`,
  `fun3d.hair`, `fun3d.skin`, later `fun3d.nodes` for TSL graphs). Each extension states the
  models it combines with and what the material looks like without it (its fallback). Dropped
  optional features leave the model and base parameters. Materials carry extension data only
  as features; they have no `extensions` object.
- Batchable: `pbr` or `unlit`, no maps, no `transmission`. In a batch, animated material
  parameters write to the copy's palette slot.
- The runtime materials own normal mapping and flat shading (they set the normal node), so
  every model and feature renders the same way alone and in a batch.

### 4.4 Images and textures

```jsonc
"images":   [{ "id": "paint_png", "stream": "s12", "mime": "image/webp" }],           // image/webp | image/png | image/jpeg | image/ktx2
"textures": [{ "id": "paint", "image": "paint_png", "colorSpace": "srgb",            // srgb | linear
               "sampler": { "wrap": ["repeat", "repeat"], "minFilter": "linear-mipmap-linear", "magFilter": "linear", "anisotropy": 4 } }]
```

Images keep their source encoding; KTX2 (Basis Universal) is the GPU-compressed option; the
validator reads image headers for dimensions before anything decodes. Several textures may
share an image, and images and textures may come from another file (4.9). The loader keeps
the encoded bytes on each texture only when asked (the workshop does, games do not).

### 4.5 Skeletons and rigs

```jsonc
{ "id": "rig", "bones": ["hips", "spine", …], "inverseBinds": { "stream": "s20", "format": "mat4" },   // bone order = joint index
  "rig": { "name": "fundev-humanoid", "version": 1, "rest": "T", "height": 1.78,
           "roles": { "hips": "hips", "spine": "spine", "chest": "spine1", "upperChest": "spine2", "neck": "neck", "head": "head",
                      "leftShoulder": "…", "leftUpperArm": "…", "leftLowerArm": "…", "leftHand": "…",
                      "leftUpperLeg": "…", "leftLowerLeg": "…", "leftFoot": "…", "leftToes": "…", "right…": "…" } } }
```

- `roles` maps standard roles (the VRM humanoid set; `hips`, `spine`, `head` and the four
  limb chains are required for a humanoid; creatures use their own role names) to bone ids.
  Skinned meshes bind with the identity matrix in attached mode, as GLTFLoader does. A
  skeleton's identity is the hash of its bone ids, rest transforms and inverse binds
  (`skeletons[].hash`, written by the writer, what references pin).
- `fundev-humanoid@1` is the platform's canonical rig: the bone set, rest pose and axes every
  public animation pack is authored on. Retargeting is rest-pose compensated: for each role,
  `R_target_world = R_target_rest_world × R_source_rest_world⁻¹ × R_source_world`, then to the
  target bone's local space; root translation scales by `height`. `kit/animation.js` owns
  this (Three.js's `SkeletonUtils.retarget` copies world rotations and is not it).

### 4.6 Animations

```jsonc
{ "id": "walk", "name": "walk", "duration": 1.03, "loop": "repeat",                  // repeat | once
  "blend": "normal",                                                                // normal | additive (relative to the clip's first frame)
  "mask": ["spine"],                                                                // bones and their descendants the clip may drive
  "root": { "node": "hips", "motion": "inplace" },                                  // inplace | extract: horizontal translation and yaw go to the model's handle
  "tracks": [
    { "node": "spine", "channel": "rotation", "interpolation": "linear",             // position | rotation | scale | visible | morph:<target id> | light.intensity | light.color
      "times": { "start": 0, "fps": 30, "count": 32 }, "values": { "stream": "s30", "format": "snorm16x4" } },   // times: uniform, or { "stream" }
    { "material": "mat_lamp", "channel": "emitter.intensity", "times": { "stream": "s31" }, "values": { "stream": "s32", "format": "float32" } } ],
  "events": [{ "time": 0.42, "name": "footstep", "data": { "foot": "left" } }] }   // time ≤ duration; data at most 1 KB
```

- Node channels: `position`, `rotation`, `scale`, `visible` (0 or 1, step), `morph:<id>`,
  `light.intensity`, `light.color`. Material channels name a material, not a node: `color`,
  `alpha.opacity`, the model's parameters, `emitter.intensity`, `emitter.color`,
  `<feature>.<parameter>`. Interpolation: `linear`, `step`.
- One mixer drives everything: the loader makes Three.js keyframe tracks for node channels,
  bound by node id, and for material and light channels bound to proxy objects the runtime
  creates per loaded model (one per animated material, one per light), so crossfades,
  weights, time scale, masks and additive blending apply the same way; after each mixer
  update the runtime copies proxy values into the model's materials (its own clones or palette
  slots) and light slots. Values dequantize and uniform times expand at load.
- Animation packs (`kind: animations`) carry a skeleton with its rig and clips with node
  channels only; pack tracks bind by role: `tracks[].node` names bones of the pack's
  skeleton, the loader maps bone → role (the pack's rig) → bone (the model's rig). A model on
  the same rig name and version skips rest-pose compensation; other rigs retarget by role.
  `mask` and `root.node` name roles.

### 4.7 Physics

Engine-neutral shapes, bodies and constraints; vehicles, ragdolls and characters map to Jolt's
controllers. Every reference is an id; every vector is in the space of the body's node. The
file's node transforms are the assembled pose: constraint frames and relative placements
derive from them at load.

```jsonc
"physics": {
  "shapes": [
    { "id": "box", "type": "box", "halfExtents": [0.4, 0.4, 0.4] },
    { "id": "ball", "type": "sphere", "radius": 0.3 },
    { "id": "pill", "type": "capsule", "halfHeight": 0.6, "radius": 0.25 },             // axis Y, centred
    { "id": "drum", "type": "cylinder", "halfHeight": 0.5, "radius": 0.2 },
    { "id": "hull", "type": "convex", "points": { "stream": "s40", "format": "float32x3" } },   // 4–256 points, not coplanar (Jolt's hull limit)
    { "id": "walls", "type": "mesh", "geometry": "static" },                             // static bodies only
    { "id": "all", "type": "compound", "children": [{ "shape": "box", "position": [0, 0.4, 0], "rotation": [0, 0, 0, 1] }] } ],   // children are not compounds
  "bodies": [{ "id": "chassis", "node": "root", "shape": "hull", "motion": "dynamic",   // static | kinematic | dynamic
               "layer": "moving", "mass": 1200, "centerOfMass": [0, -0.2, 0], "friction": 0.5, "restitution": 0.1,
               "damping": { "linear": 0.05, "angular": 0.05 }, "gravity": 1, "ccd": false, "sensor": false, "sleep": true,
               "active": true, "switchable": false }],                                   // active: starts simulating; switchable: may change between kinematic and dynamic
  "constraints": [{ "id": "door", "type": "hinge", "bodies": ["frame", "door"],         // a null first body anchors to the world
                    "frame": { "position": [0, 1, 0], "axis": [0, 1, 0], "normal": [1, 0, 0] },  // in the first body's node space (the world for a null body); the second body's frame follows from the assembled pose
                    "limits": [0, 1.6], "limitSpring": { "frequency": 2, "damping": 0.5 },
                    "motor": { "mode": "position", "target": 0, "maxForce": 50, "spring": { "frequency": 2, "damping": 0.5 } },
                    "break": { "force": 5000, "torque": 1000 } }],                     // newtons, newton-metres
  "vehicles": [{ "id": "car", "type": "wheeled", "body": "chassis",
                 "wheels": [{ "id": "fl", "node": "wheel_fl", "radius": 0.33, "width": 0.22,          // the node's position is the wheel centre at suspension.rest
                              "suspension": { "min": 0.05, "max": 0.25, "rest": 0.15, "frequency": 1.6, "damping": 0.5 },
                              "steer": 0.6, "brake": 1500, "handbrake": 0 }],
                 "engine": { "maxTorque": 300, "minRPM": 1000, "maxRPM": 6000 },
                 "transmission": { "gears": [2.66, 1.78, 1.3, 1.0, 0.74], "reverse": [-2.9] },   // automatic
                 "differentials": [{ "wheels": ["fl", "fr"], "ratio": 3.42, "split": 0.5, "engineShare": 1, "limitedSlip": 1.4 }],   // Jolt mDifferentialRatio, mLeftRightSplit, mEngineTorqueRatio, mLimitedSlipRatio
                 "antiRoll": [{ "wheels": ["fl", "fr"], "stiffness": 1000 }] }],
  "ragdolls": [{ "id": "doll", "skeleton": "rig",
                 "parts": [{ "id": "pelvis", "bone": "role:hips", "to": "role:spine", "radius": 0.13, "mass": 11 },
                           { "id": "chest", "bone": "role:chest", "parent": "pelvis", "to": "role:neck", "radius": 0.15, "mass": 14, "limits": { "normalCone": 0.35, "planeCone": 0.35, "twist": [-0.25, 0.25] } },
                           { "id": "head", "bone": "role:head", "parent": "chest", "length": 0.22, "radius": 0.1, "mass": 5, "limits": { "normalCone": 0.6, "planeCone": 0.6, "twist": [-0.6, 0.6] } },
                           { "id": "thigh_l", "bone": "role:leftUpperLeg", "parent": "pelvis", "to": "role:leftLowerLeg", "radius": 0.075, "mass": 7, "limits": { "normalCone": 1.0, "planeCone": 1.0, "twist": [-0.4, 0.4] } }] }],
  "characters": [{ "id": "walker", "node": "root", "shape": "pill", "offset": [0, 0.9, 0], "mass": 70, "maxSlope": 0.8, "stepHeight": 0.3 }]   // offset: shape centre from the node (feet)
}
```

| Constraint | `limits` | `motor` |
| --- | --- | --- |
| `fixed`, `point` | — | — |
| `hinge` | `[min, max]` radians | position or velocity, `maxForce` as torque |
| `slider` | `[min, max]` metres | position or velocity, `maxForce` |
| `swingTwist` | `normalCone`, `planeCone`, `twist: [min, max]` (Jolt's two half-cone angles) | position (target quaternion) |

Rules: nodes with bodies have uniform world scale (per copy for placed nodes); bodies live on
nodes outside skeletons unless they are ragdoll parts; mesh shapes belong to static bodies
and stay under 100 k triangles (Jolt's JS bindings take them one element at a time); a
ragdoll's bones belong to its skeleton; `centerOfMass` offsets are subtracted when Jolt
frames are built; `break` is watched by the runtime from contact impulses (a contact listener,
not polling) and the constraint is removed; bodies with `active: false` start asleep and
static-like until the game activates them (`EActivation_DontActivate`), which with
`switchable` is how destructibles stand until hit. Collision layers are the platform's four
(static, moving, debris, sensor; static–moving, moving–moving, debris–static, sensor–moving
collide); a body picks one with `layer`. Motorcycles, tracked vehicles, height fields and
soft bodies are extensions (`fun3d.motorcycle`, `fun3d.tracked`, `fun3d.heightfield`,
`fun3d.softbody`). A shape the runtime cannot build marks the model's physics failed: the
loader reports it and the model loads without that body; the library records the failure.

### 4.8 Variants

```jsonc
"variants": [{ "id": "police", "axis": "livery", "overrides": [{ "node": "body", "materials": ["white", "blue"] }, { "node": "lightbar", "visible": true }] },
             { "id": "wrecked", "axis": "damage", "overrides": [{ "node": "roof", "geometry": "roof_dented" }] }]
```

One variant active per axis; overrides may set `materials`, `geometry`, `visible` and
`morphWeights`; animation tracks apply after variants; bodies keep their shapes.

### 4.9 References

```jsonc
"refs": [{ "id": "base", "model": "commuter_body_01@v003" }]
"skeletons": [{ "id": "rig", "ref": "base", "entry": "rig", "hash": "sha256:…",          // the base skeleton's hash (4.5)
                "bones": ["hips", …], "inverseBinds": { "stream": "s20", "format": "mat4" } }]
"images":    [{ "id": "atlas", "ref": "tiles_shared", "entry": "atlas" }]
"nodes":     [{ "id": "shirt", "mesh": {}, "skin": "rig", "hides": ["torso", "upper_arms"] }]   // regions of the base this part covers
```

- A skeleton, image or texture may come from another file. A referencing skeleton lists the
  bone ids the part uses, in its own joint order (what its `skinIndex` values index) with its
  own inverse binds; the loader maps them to the base's bones by id, and the base's skeleton
  `hash` must match, so a base re-version that keeps its skeleton keeps its parts.
- A part may `hides` regions the base declares on its nodes (`regions`), and morph targets
  with the same id on the base and the part are driven together, so body sliders deform
  clothes.
- Only pinned library versions may be referenced; one hop of depth; the game build resolves
  the closure and records it in `models.lock` (section 8); the loader never fetches. In the
  workshop, the library is the resolver.

### 4.10 Extensions

`extensions` may appear on the top level and on any table entry except materials, whose
extension data are features (4.3). Names are `fun3d.<name>` for the platform and
`x.<game>.<name>` for games; extensions carry no version: a breaking change is a new name.
`uses` lists every extension in the file, `requires ⊆ uses` those the file is wrong without.
An unknown optional extension drops to the fallback its specification defines; an unknown
required one refuses the file with its name. The library accepts only `fun3d.*` names its
runtime registers; `x.*` extensions live in games' own assets. New values of the schema's
closed enumerations (shape types, channels, modes) are extensions or a major version, never
silently ignorable additions. Node graphs (`fun3d.nodes`, later) are data interpreted by a
whitelisted node registry.

### 4.11 Editing section

An `EDIT` chunk is `{ "tool": "fun.dev/workshop", "version": 3, "document": {} }`; editing-flagged
`BIN` chunks hold its binary data, addressed by ordinal like every `BIN` chunk. A file has at
most one editing section; `asset.source.kind` is `glb` or `edit`, exactly one, and
`asset.source.tool` names the section's tool when it is `edit`. A tool that saves a file it
does not understand the section of drops the section (the file becomes `kind: glb`-like:
runtime data only, `source.kind: "runtime"`). The library never edits runtime data. The
validator caps the section's size, strips absolute paths and parses it with a null-prototype
reviver; the workshop treats sections from other tools as untrusted input.

### 4.12 Versioning

`fun3d` is `major.minor`. A minor change adds fields old readers can ignore without loading
anything wrong (writers must show this; new enumeration values are not minor, see 4.10); a
major change refuses old readers. The schema is strict for the writer's own minor; a loader
tolerates unknown fields of a newer minor. Extensions version by name.
`asset.source.converter` and `profile` name what produced the runtime section; a derived
file never changes in place (section 8).

### 4.13 Defaults

| Field | Default |
| --- | --- |
| node `transform` | identity; `visible` true; `tags` []; `sockets` {}; `regions` [] |
| `mesh.shadow` | `both`; `morphWeights` zeros |
| `light.range` | 0 (unlimited); `importance` 0.5; `cone` [0.5, 0.6] |
| material `model` | `pbr`; `color` `#ffffff`; `alpha.mode` `opaque`, `cutoff` 0.5, `opacity` 1; `side` `front`; `pbr.roughness` 1, `metalness` 0; map `uv` 0, `transform` identity; `emitter.intensity` 1; `transmission.amount` 1, `ior` 1.5, `thickness` 0, `attenuation` `#ffffff`, `attenuationDistance` 0 |
| texture `colorSpace` | `linear`; `wrap` repeat; `minFilter` `linear-mipmap-linear`; `magFilter` `linear`; `anisotropy` 1 |
| `rig.rest` | `T`; `rig.version` 1 |
| clip `loop` | `repeat`; `blend` `normal`; `mask` all bones; `root.motion` `inplace`; `interpolation` `linear` |
| body `motion` | `static`; `layer` by motion (static → static, else moving); `mass` from shape volume × 1000 kg/m³; `friction` 0.5; `restitution` 0; `damping` 0.05 / 0.05; `gravity` 1; `ccd` false; `sensor` false; `sleep` true; `active` true; `switchable` false; `centerOfMass` from the shape |
| wheel | `steer` 0; `brake` 1500; `handbrake` 0; `suspension` min 0.05, max 0.25, rest max, frequency 1.5, damping 0.5 |
| engine | `maxTorque` 300, `minRPM` 1000, `maxRPM` 6000; gears as the example, reverse [-2.9]; differential `split` 0.5, `engineShare` 1, `limitedSlip` 1.4 |
| constraint `limitSpring` / `motor` / `break` | none |
| ragdoll part `limits` | required when `parent` is present; `characters[].offset` [0, 0, 0] |

## 5. Validation and limits

The validator runs in the maintenance script (before anything is served), in the console when
a `.fun3d` is uploaded directly (release 2), and in the loader (counts, ranges, non-finite
values; cheap). It checks the JSON Schema (written first; this table derives from it), that
every reference resolves (including `refs` targets, which may not have refs of their own),
that streams lie inside chunks with aligned offsets and attributes inside strides, that the
decoded size of all streams fits the cap before anything decodes, that parents form a tree,
that quaternions are unit and placement matrices have positive determinants, that every
decoded float stream is finite and every index in range, that `cone[0] ≤ cone[1]`,
`morphWeights` lengths, material counts against group slots, UV sets against the geometries a
material is used with, `events[].time ≤ duration`, that hulls have four non-coplanar points,
and the caps below (the library profile's). `npm test` validates every converted library file.

| | Cap |
| --- | --- |
| file | 64 MB stored, 256 MB raw; JSON chunk 16 MB; chunks 64; streams 4096; decoded streams 256 MB in all |
| nodes / geometries / materials / images / textures / skeletons | 4096 / 1024 / 256 / 64 / 256 / 16 |
| vertices / triangles per geometry, total | 4 M / 8 M, 16 M / 32 M including LOD levels |
| vertex buffers / attributes per geometry, vertex stride | 6 / 11 (WebGPU allows 8 / 16; instancing and tint take the rest), 64 |
| texels per image / per file | 16 M (4096²) / 64 M |
| bones per skeleton, influences | 128 (policy: within a WebGL 2 uniform block; Three.js would fall back to a bone texture above it), 4 |
| morph targets per geometry, targets × vertices per file | 64, 1 M (32 MB of GPU memory; 100 expressions on a 10 k-vertex face) |
| clips, tracks per clip, keyframes per file, events per clip | 256, 1024, 4 M, 256 |
| placements per node, per file | 65 536, 262 144 |
| sockets per node, regions per node, variants, refs, `extensions` bytes | 32, 16, 64, 8, 64 KB |
| convex points, mesh-shape triangles, bodies, constraints, watched `break` per scene | 256, 100 k, 256, 256, 64 |

## 6. Profiles

A profile is a kit module `{ name, version, rules, limits }` that turns a producer's
conventions into explicit data when importing. The console and the maintenance script run the
platform's profiles only; a game may register its own in `game.json` for its own assets, run by
its own build. `fundev-library@1` is normative here; [models](models.md) links to it for
uploaders, and the parity run reports how many approved versions follow each convention
before anything but hulls is promised:

- `static__<material>` nodes merge into one node `static`; `<pivot>__<material>` children
  merge into their pivot; other mesh nodes merge their primitives; flat faces weld and lose
  their normals (`groups[].flat`); unused texture coordinates go; batchable geometries get the
  batch signature.
- `mat_light*`, `mat_signal*`, `mat_window*`, `mat_lamp*`, `mat_screen*`, `mat_beacon*` get
  `emitter` with the matching role; `mat_body` gets `tint`; transmissive materials
  `transmission`.
- Physics by library type: props and pieces a convex hull (`collider*` nodes when present;
  convex decomposition later as `fun3d.decomposition`), vehicles (type `vehicle`; the one-time
  `retype` of approved vehicles typed `prop` is recorded in `asset.source.profile`) a wheeled
  vehicle from `wheel_*` nodes with defaults by mass class, characters a capsule and a ragdoll
  from the rig's roles. Mass from a density table by type.
- Ids: a glTF name becomes its ASCII slug (`[A-Za-z0-9_.-]`, other runs of characters
  collapse to `_`) plus `-` and the first six hex digits of the SHA-256 of the UTF-8 name
  whenever the slug lost anything or exceeds 58 characters; a repeated id gets `_2`, `_3`… in
  document order; bone order is the glTF skin order. Every later profile reproduces `@1` ids.

## 7. Runtime

| Module | Role |
| --- | --- |
| `kit/fun3d.js` | read, validate, load into Three.js, write from Three.js, strip editing sections, dispose |
| `kit/fun3d-import.js` | GLB → `.fun3d` through a profile (typed-array welding, bounded memory; 200 k triangles in a browser, unbounded in the script) |
| `kit/materials.js` | models and features in TSL; one builder serves single meshes and batches; registry |
| `kit/models.js` | places loaded models and returns handles: batches rigid batchable meshes, instances placements, picks LOD levels, fills light slots, applies variants and tints; `model.part(id)`, `model.socket(id)`, `handle.tint`, `handle.remove()`, `roles.set` |
| `kit/physics.js` | Jolt: bodies, constraints, vehicles, ragdolls, characters; asynchronous API, pooled temporaries, `dispose()`; the world can move to a worker |
| `kit/animation.js` | clips through one mixer (proxies for material and light channels), masks, additive blending, events; retargeting by role (release 2) |

The kit, not the file, decides whether a mesh is drawn alone, instanced or batched, which LOD
level shows, how many lights are real and where physics steps. Physics steps at a fixed rate
with interpolation; its API takes the inputs for step N and returns the state of step N−1, so
the world can live in a worker (transferred state; shared memory only where the page is
cross-origin isolated). Shapes are cooked off the main thread. On WebGL 2 without
`WEBGL_multi_draw`, a batch still issues one draw per copy; the pipeline and material savings
remain. Jolt and the decoders are served like the vision runtime (`/runtime/physics/<hash>/`,
cache-first, outside the shell precache, found through `import.meta.url`) and listed in each
release's `files.json` closure so offline play has them; the meshopt encoder is not shipped to
games. Everything loaded registers with the game context's `track` and is released at
teardown. Data a release's loader does not implement (section 10) is ignored with a warning,
except references, which refuse the load.

## 8. Pipeline

- **Derived files.** `model.fun3d` is derived from the source by the maintenance script
  (headless Chromium, one converter whose stamp is the hash of its modules and profile) and
  stored under a `derived` record `{ sha256, size, converter, profile }` separate from
  `files`, with one catalogue publish per run; every approved version of every model
  converts. A new converter or profile makes a new derived file; the old one stays as long
  as any `models.lock` pins it and is deleted otherwise. Regeneration that would change ids
  or bone order is refused (the model needs a new version). Workshop sources (`kind: edit`)
  regenerate through the headless workshop; GLB sources through the importer. Nothing is
  pinned until the converter is frozen (section 10).
- **Parity gate.** `npm run models -- convert` renders GLB and `.fun3d` in the same viewer
  with the same classic materials, pixel-diffs them against per-model thresholds on a masked
  metric (emitter roles and tints excluded), writes a worst-50 sheet, and checks derived data
  (hull points, mass class, wheel count, emitter roles) — the derived-data checks are the gate;
  `verify kit` renders library models alone and in a batch and diffs the two.
- **Console.** Uploads stay as they are (GLB in, thumbnails from GLB); a version shows `未转换`
  in the console and in `npm run models -- list` until the script derives its file. Browser
  conversion is a preview at most, never what the library serves.
- **Games.** `game.json` pins versions and names the format for library models
  (`"models": { "format": "fun3d" }`, one format per library model; game-local assets may stay
  GLB); `games/<id>/models.lock` records hash, size and path of every pinned file and of the
  closure of references (the build inflates each pinned manifest to collect them; paths are
  `models/<id>@<version>.fun3d`; the loader's resolver is `(id, version) → asset(path)`);
  `npm run models -- update <game>` advances it. Game-local GLBs convert at build on request
  (`"convert": ["assets/tiles/*.glb"]`), cached by hash.
- **Workshop.** Keeps `.funmodel.glb` until its binary storage lands; then saves `.fun3d` with
  its editing section, exports plain GLB, gains physics commands with a Jolt preview.
- **Library pages.** Keep GLB in the first release; switch when the viewer uses the runtime
  materials and the page CSP allows the decoders.
- **Platform.** Jolt and the decoders in the runtime; validator and inspector as
  `npm run fun3d -- inspect|validate`; `docs/fun3d-agents.md` with the three ways to produce a
  file (GLB through a profile, Three.js in Node, the workshop); `verify kit` loads real library
  files and the synthetic scenarios.

## 9. Evaluation

"Core" means defined in this schema (`fun3d` 1.0); the release column says when the runtime
implements it (section 10). Levels: **core**, **extension** (mechanism in core, feature later
with the producer and consumer named), **change** (needs a core change), **conflict** (works
only with the stated restriction).

| Scenario | Level | Release | Schema | Producer / consumer |
| --- | --- | --- | --- | --- |
| Textured PBR props (normal, metal-rough, occlusion on uv1, transforms) | core | 1 | 4.3 maps | workshop stage 3 / every game |
| Characters: base body + hair and clothes on one skeleton | core | 2 | 4.9 refs, skeleton hash, regions, shared morph ids | character creator / games |
| 50–100 expressions, sliders | core, conflict | 2 | 4.2 sparse morphs; dense on the GPU; 100 targets on a 10 k-vertex face | creator / games |
| Decals, toon hair, skin | extension | later | `fun3d.decals`, `fun3d.hair`, `fun3d.skin` | creator / games |
| Creatures with custom rigs; retargeting | core | 2 | 4.5 roles, rest, height | workshop stage 4 / `kit/animation.js` |
| Animated materials and lights, visibility | core | 2 | 4.6 channels through proxies | workshop, games / runtime |
| Events, additive clips, masks, root motion | core | 2 | 4.6 | animation packs / `kit/animation.js` |
| Doors, drawers, levers | core | 2 | 4.7 constraints, world anchors | workshop physics commands / `kit/physics.js` |
| Destructibles | core data + game code | 2 | inactive switchable fragments, `break` | workshop / physics; the swap is the game's |
| Cars | core | 1 | 4.7 wheeled | profile, workshop / physics |
| Motorcycles, tracked vehicles, boats | extension | later | `fun3d.motorcycle`, `fun3d.tracked`, `fun3d.buoyancy` | nobody yet |
| Cloth, soft bodies | extension | later | `fun3d.softbody` | workshop later / Jolt |
| Character controller | core | 2 | 4.7 characters | profile / physics |
| Lamps that light, headlight cones | core, conflict | 2 | 4.1 lights with importance; fixed light slots per tier, authored against the platform exposure | profile / `kit/models.js` |
| City tiles, terrain | conflict + extension | — | tiles are models under the caps sharing images by reference, listed by a world file; no streaming inside a file; `fun3d.heightfield` | 帝都's build / runtime |
| Vegetation at scale, per-copy colour, wind | core + extension | 1 (placements, tint) | 4.1 placements with tint; `fun3d.wind` | profile, workshop / runtime |
| Crowds | extension | later | `fun3d.vat` baked animation textures | creator / games |
| Colour schemes and damage states together | core | 2 | 4.8 variant axes | workshop / runtime |
| Custom shaders | extension | later | `fun3d.nodes` | workshop later |
| GPU-driven rendering | extension | later | `fun3d.clusters` | runtime |
| Other tools' editing data | core | 3 (workshop) | 4.11 | tools |
| New codecs and image formats | minor version + `requires` | — | 4.12 | — |
| Instanced skinning | extension | later | `fun3d.vat` or a TSL skinning node over instances (runtime work, not a format change) | creator / games |

**Conflicts** (what the runtime enforces):

| | Batching | Skinning | Morphs | Geometry LOD | Variants | Placements | Blend alpha | Physics |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Batching | — | no (drawn alone) | no | per copy | palette slots | yes | second batch, sorted per copy | — |
| Skinning | no | — | yes | yes | yes | no (see crowds) | yes | ragdoll, character |
| Morphs | no | yes | — | yes | `morphWeights` | yes (`InstancedMesh` morph texture) | yes | — |
| Group LOD | per level | levels share the skeleton | yes | yes | yes | no | yes | one body for the group |
| Variants | yes | yes | yes | yes | one per axis | every copy | yes | shapes unchanged |
| Placements | yes | no | yes | yes | every copy | — | instances are not depth-sorted among themselves | static body per copy |
| Animation | yes | yes | yes | yes | after variants | per node, not per copy | yes | kinematic follows, dynamic ignores |
| Transmission | no | yes | yes | yes | yes | no (one draw per copy; keep copies few) | yes | — |
| Refs | parts never batch (skinned); shared images do | base skeleton | shared ids drive together | own | local entries only | yes | yes | own |
| Lights | emitters always glow; real lights fill fixed slots with fixed shadows | lights on bones follow them | — | — | `visible` overrides apply | not on placed nodes | — | lights on bodies follow them |
| Masks | — | after retargeting | — | — | — | — | — | a mask without the root drops root motion |
| Animated materials | per-copy palette slot | yes | yes | yes | after variants | per node | yes | — |
| Integer attributes | — | `skinIndex` loads as an integer attribute on both backends | — | — | — | — | — | — |

## 10. Rollout

| Release | Runtime implements | Loader behaviour with the rest |
| --- | --- | --- |
| 1 | container, schema, validator; nodes with meshes, sockets, tags, placements with tint; geometries with groups, flat groups, geometry LOD; `pbr` and `unlit` with `emitter` and `tint`; images and textures (webp, png, jpeg, ktx2); skeletons and skinned meshes; clips with node channels on the same bone ids; batching; physics static bodies and wheeled vehicles; `models.lock`; parity gate; agent one-pager; `verify kit` with synthetic scenarios | morphs, variants, group LOD, lights, constraints, dynamic bodies, ragdolls, characters, material and light channels, events, additive and masks: ignored with a warning; refs: refused; `transmission`, extension features: dropped to the base |
| 2 | references, retargeting, ragdolls, characters, constraints and dynamic bodies, morphs, variants, group LOD, lights with slots, material and light channels through proxies, events, additive clips and masks, `transmission`; 准点下班 adopts | extension features: dropped to the base |
| 3 | workshop: `.fun3d` save and open with editing sections, GLB export, physics commands; library pages on `.fun3d` | — |
| later | extensions as needed, each with its producer and consumer: wind, decals, hair, skin, soft bodies, crowds, texture arrays, nodes, clusters, heightfields, motorcycles; appendix A items as they find producers | — |

Order: release 1 core with `verify kit`; 帝都 on trial derived files (not pinned); the
converter frozen only when 帝都 runs on them and the parity gate passes over the library;
then the library's derived files for every approved version with the `未转换` state and
derived-data warnings in review, and pins; then release 2; then the workshop.

## 11. Open decisions

1. Light slots per device tier (release 2).
2. Library type `vehicle` added to the catalogue, so the one-time `retype` of approved
   vehicles typed `prop` can run.
3. A scheduled conversion job (GitHub Actions with a Wrangler secret) or `未转换` as a normal
   state cleared by hand.
4. KTX2 transcoding at conversion: off for the first release.

## Appendix A. Planned, not in 1.0

Each enters as a minor version named in `requires`, or as an extension, when it has a
producer and a consumer: `toon` shading model; `lines` and `points` geometry modes; raw
image data (`images[].data`); `uv2`/`uv3`; `cubic` interpolation and `pingpong` loops;
`cone`, `sixDOF` and `distance` constraints; manual transmissions; the `exponential`
meshopt filter; texture arrays and cube maps; codecs other than meshopt.
