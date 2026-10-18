# .fun3d — fun.dev's model format (design v3, 2026-10-18)

Status: **design for review.** v2 was reviewed by three adversarial reviewers (engine
realism, format design, pipeline and operations) and a self-review; the findings and
decisions are in `dev/fun3d/review.md`. The v1 prototype on this branch validated the data
path (container, GPU vertex formats, quantization and compression, palette batching, Jolt
vehicles and ragdolls); its schema is replaced by this one.

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
   detail, a light with a physical intensity, a body with a shape. The runtime decides how
   it is drawn and simulated: batched or instanced, which level, how many lights are real,
   where physics steps.
2. **Data shaped for Three.js and WebGPU.** Vertex data in WebGPU vertex formats, grouped into
   buffers Three.js can bind as they are; animation as keyframe tracks; skins as Three.js binds
   them. Loading is decoding and wiring.
3. **Stable identity.** Everything referenced has a string `id` that survives edits and
   regeneration; references name ids. Positions in arrays mean nothing.
4. **Explicit semantics.** Whatever the runtime acts on is structured data with a defined
   meaning. Names carry no meaning; producers' conventions live in import profiles.
5. **Materials compose.** A shading model plus independent features, each with a defined
   fallback, instead of one type per combination.
6. **Extensible on purpose.** Namespaced, versioned extensions declared as used or required;
   runtime registries; optional ones drop to a defined fallback, required ones refuse the file
   by name.
7. **Sources are immutable; runtime data is derived and immutable too.** A derived file is
   fixed for its (source, converter, profile); a new converter makes a new derived file, and
   whoever pins the old one keeps it.
8. **Data only, validated, bounded.** No code; a schema, caps and a validator stand between
   uploads and the loader, and the loader bounds every allocation regardless.
9. **Many files, not one big file.** Parts reference their base skeleton; worlds list tiles. The
   unit of scale is the file.

## 3. Container

```
signature   89 46 55 4E 33 44 0D 0A     "\x89FUN3D\r\n" — also the container version: a new layout gets a new signature
chunk*      type          4 ASCII bytes  "JSON" | "BIN " | "EDIT"
            flags         u32            bit 0 deflate (raw DEFLATE); bit 1 editing; bits 2–31 reserved, must be 0 (else refused)
            storedLength  u32            bytes of data as stored, padding excluded
            rawLength     u32            bytes after inflating (equal to storedLength when not compressed)
            data          storedLength bytes, then zero padding to the next multiple of 4
```

- Little endian. Exactly one `JSON` chunk, first. Chunks with the editing flag come after
  every runtime chunk; the runtime copy of a file is the file with editing chunks removed,
  made without decoding.
- The manifest names `BIN` chunks by ordinal among all `BIN` chunks in file order (editing
  `BIN` chunks are last, so stripping changes no ordinal).
- Inflation stops at `rawLength`; a chunk that inflates to any other size is refused. The
  JSON chunk is capped (section 5) and parsed only after its size is known.
- Images are stored without deflate (their encodings already compress); geometry, animation
  and the manifest deflate.
- No per-chunk checksum: the library addresses files by their hash and games pin hashes.

## 4. Manifest

```jsonc
{
  "fun3d": "1.0",                                              // format version, major.minor
  "kind": "model",                                             // model | animations
  "asset": { "name": "city_taxi_01", "generator": "fun.dev workshop 3.1",
             "source": { "kind": "glb", "hash": "sha256:…", "converter": "sha256:…", "profile": "fundev-library@1", "tool": null },
             "content": "sha256:…",                           // hash over inflated chunk payloads: the same data gives the same value on every zlib
             "licence": "CC0-1.0", "attribution": "" },
  "uses": ["fun3d.wind"], "requires": [],                      // extension names; requires ⊆ uses
  "buffers":  [{ "chunk": 0 }, { "chunk": 1 }],                // BIN ordinals
  "streams":  [{ "id": "s0", "buffer": 0, "offset": 0, "length": 812, "count": 412, "stride": 12,
                 "codec": "meshopt", "mode": "attributes" }],  // mode: attributes | triangles | indices; filter: octahedral | quaternion | exponential; filterBits
  "nodes": [], "geometries": [], "materials": [], "images": [], "textures": [],
  "skeletons": [], "animations": [], "physics": {}, "variants": [], "refs": [],
  "extensions": {}
}
```

**Conventions.** Metres, kilograms, seconds, radians, candela; right-handed, +Y up, the front
faces +Z. Quaternions are `[x, y, z, w]`, unit length within 1e-3. A transform is
`position`, `rotation` (quaternion) and `scale`, composed translation × rotation × scale;
`mat4` is column-major. Scale components are positive (writers bake mirroring). Colours are
sRGB hex strings `#rrggbb`; vertex colours and `_tint` are linear; emission is colour ×
intensity, intensity at most 64. Three.js renders unitless radiance, so physical intensities
only mean something against an exposure: the platform renders every scene with ACES tone
mapping at exposure 1, where a 100 cd point light at 1 m and an emitter of intensity 1 both
read as white; files are authored against that. UVs follow glTF: origin at the top-left, images never flipped. Every
optional field has the default given beside it; an absent `transform` is identity.

**Ids.** Every entry in every table has an `id`: 1–64 characters of `[A-Za-z0-9_.-]`, unique
within its table (tables are separate id spaces; morph targets, wheels, ragdoll parts and
socket keys use the same charset). The loader sets `object.name = id` and keeps the display
name in `object.userData.name`, so Three.js name lookups and animation bindings are unique by
construction. Ids are derived deterministically by the writer (section 8); a regeneration
that would change an id or a bone order is a new version.

**Streams** are typed arrays after decoding: `count` × `stride` bytes; without a codec,
`length = count × stride`. `codec` is `meshopt` with `mode` `attributes` (vertex codec; stride
a multiple of 4, at most 256), `triangles` or `indices` (index codecs), and an optional
`filter` with `filterBits` applied after decoding (`octahedral` into `snorm8x4`/`snorm16x4`,
`quaternion` into `snorm16x4`, `exponential` into `float32xN`). Codecs are a registry; a file
that needs one the runtime lacks names it in `requires` as `fun3d.codec.<name>`.

**Kinds.**

| Kind | Must have | May have | Must not have |
| --- | --- | --- | --- |
| `model` | nodes | everything | — |
| `animations` | nodes (bones only), one skeleton, animations | refs (skeletons) | geometries, materials, images, textures, physics, variants, placements, lights |

### 4.1 Nodes

Depth-first; the first entry is the root; `parent` names a node id. A node is a transform with
any of the following:

```jsonc
{ "id": "wheel_fl", "name": "wheel_front_left", "parent": "root",
  "transform": { "position": [0.82, 0.33, 1.31], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },   // in the parent's space
  "mesh": { "geometry": "wheel", "materials": ["rubber", "steel"],              // one material per group
            "shadow": "both", "morphWeights": [0, 0] },                        // shadow: both (default) | cast | receive | none
  "skin": "rig",                                                               // mesh is skinned to this skeleton (needs skinIndex/skinWeight)
  "placements": { "count": 120, "transforms": { "stream": "s8", "format": "mat4" },   // copies, each in the node's parent space, replacing the node's own transform
                  "tint": { "stream": "s9", "format": "unorm8x4" } },         // linear; feeds the materials' tint feature
  "bone": true,
  "light": { "type": "point", "color": "#ffd9a0", "intensity": 120, "range": 12,    // point | spot (candela); spot: "cone": [inner, outer]
             "shadow": false, "importance": 0.5 },                               // importance 0–1 (default 0.5): rank within the scene when the runtime budgets lights
  "lod": { "levels": [{ "screenSize": 1, "children": ["near_a", "near_b"] }, { "screenSize": 0.05, "children": ["far"] }] },
  "sockets": { "seat_driver": { "position": [0.4, 0.5, 0.2], "rotation": [0, 0, 0, 1] } },   // in node space
  "visible": true, "tags": ["door"] }
```

- `placements` describes repetition; the runtime may instance, batch or merge. A placed node
  has no children, light, bone or `lod`; it may carry one body of motion `static`, one per
  copy. Variant overrides apply to every copy.
- `lod` on a group: levels in descending `screenSize` (fraction of the viewport height the
  group's bounds cover); each level names the children shown at it, every other child is
  hidden; children named at level 0 are the group's normal content. The group's bounds are
  the union of its level-0 children. Nodes with `placements` or `skin` have no `lod`.
- `light` is intent with a physical unit; spots shine down the node's −Z (`cone` maps to
  Three.js `angle` = outer and `penumbra` = 1 − inner/outer). The runtime owns a fixed set of
  real light slots per device tier and assigns lamps to them by `importance` and distance,
  moving and dimming slots rather than adding or removing lights, because Three.js r186 keys
  shader programs on the set of lights. No directional lights in models.
- Bones are nodes a skeleton lists. Sockets are attachment frames games use (`model.socket(id)`).
- `tags` are free strings for games; the runtime never reads them.
- A node with a physics body is detached to the world at load, children following it; a
  kinematic body follows the node's animation tracks, a dynamic body ignores them.
- Loaded object model: every node is an `Object3D` named by its id; a rigid quantized mesh is
  a child `Mesh` carrying the dequantizing transform, so the node stays the pivot that
  sockets, tracks and physics target; skinned and morphed meshes load with float positions
  and are the node's mesh themselves. Games use `kit/models.js` handles, not the tree.

### 4.2 Geometries

```jsonc
{ "id": "wheel", "mode": "triangles",                                         // triangles | lines | points
  "vertices": 412,
  "buffers": [                                                                 // at most 6; one element type per buffer; at most 11 attributes in all
    { "stream": "s0", "attributes": { "position": { "format": "snorm16x4", "offset": 0 } } },          // Int16 buffer
    { "stream": "s1", "attributes": { "normal": { "format": "snorm8x4", "offset": 0 }, "tangent": { "format": "snorm8x4", "offset": 4 } } },  // Int8 buffer, stride 8
    { "stream": "s2", "attributes": { "uv": { "format": "unorm16x2", "offset": 0 } } } ],
  "decode": { "position": { "offset": [0, 0.33, 0], "scale": 0.3401 }, "uv": { "offset": [0, 0], "scale": [1, 1] } },   // value = offset + stored × scale
  "index": { "stream": "s3", "format": "uint16" },                            // required for triangles; indices
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
| `uv`, `uv1`, `uv2`, `uv3` | `unorm16x2` (12 bits, `decode` range) or `float32x2` | |
| `color` | `unorm8x4` | linear |
| `skinIndex`, `skinWeight` | `uint8x4` / `uint16x4`, `unorm8x4` | weights sum to 255; four influences (Three.js's limit); `skinIndex` is its own buffer and loads as an integer attribute (`gpuType` Int; WebGPU widens it to 32 bits) |
| `_<name>` | any | custom; its meaning belongs to the extension that reads it |

Buffers are grouped by element type because Three.js binds one typed array per interleaved
buffer; the runtime adds its own buffers and attributes (instance matrices take one buffer and
four locations, tint one more), hence the caps of 6 and 11 against WebGPU's 8 and 16.
Vertices at material-slot boundaries and at flat/smooth boundaries are duplicated. Morph
targets are sparse (vertex indices plus values) with their own scale, and expand to dense
textures on the GPU (32 bytes per vertex per target), which the caps bound. Batchable
geometries follow the profile's batch signature (the same attribute set and formats, padded
by the importer), because a batch holds one layout; `lines` and `points` take `unlit`
materials and never batch.

### 4.3 Materials

A material is a shading model, parameters, maps and features.

```jsonc
{ "id": "mat_body", "name": "mat_body", "model": "pbr",                   // pbr | unlit | toon
  "color": "#f2c94c", "alpha": { "mode": "opaque", "cutoff": 0.5, "opacity": 1 },   // opaque (default) | mask | blend
  "side": "front",                                                         // front (default) | double
  "pbr": { "roughness": 0.6, "metalness": 0 },                             // model parameters, see the table
  "maps": { "color": { "texture": "paint", "uv": 0, "transform": { "offset": [0, 0], "scale": [1, 1], "rotation": 0 } } },
  "features": {
    "emitter": { "role": "headlight", "color": "#fff0c8", "intensity": 3 },  // core: emission with a role the runtime scales (factor 1 by default)
    "tint": {},                                                             // core: base colour and colour map multiply by the copy's tint
    "transmission": { "amount": 1, "ior": 1.5, "thickness": 0.01, "attenuation": "#ffffff" },   // core
    "fun3d.wind": { "strength": 0.2, "frequency": 1.1 } } }                  // extension features by full name
```

| Model | Parameters |
| --- | --- |
| `pbr` | `roughness` 1, `metalness` 0; maps `color`, `normal` (`scale` 1), `orm` (R occlusion, G roughness, B metalness), `occlusion` (own UV set), `emissive`, `alpha` |
| `unlit` | maps `color`, `alpha` |
| `toon` | `shade` colour, `bands` 2, `rim` 0; maps `color`, `alpha` |

- `emitter` replaces any other emission: a material has `emitter` or nothing emissive. Roles:
  `headlight`, `taillight`, `brake`, `indicator`, `signal`, `window`, `lamp`, `screen`, or any
  string; `kit/models.js` sets a factor per role (`roles.set("window", 0)` at day).
- `tint`: the copy's `_tint` (placements) or `handle.tint` multiplies the base colour and the
  colour map; one tint per model.
- `transmission` never batches.
- Every other feature is an extension (`fun3d.wind`, `fun3d.clearcoat`, `fun3d.decals`,
  `fun3d.hair`, `fun3d.skin`, later `fun3d.nodes` for TSL graphs). Each extension states the
  models it combines with and what the material looks like without it (its fallback). Dropped
  optional features leave the model and base parameters.
- Batchable: `pbr` or `unlit`, no maps, no `transmission`. In a batch, animated material
  parameters write to the copy's palette slot.
- The runtime materials own normal mapping and flat shading (they set the normal node), so
  every model and feature renders the same way alone and in a batch.

### 4.4 Images and textures

```jsonc
"images":   [{ "id": "paint_png", "stream": "s12", "mime": "image/webp" },            // image/webp | image/png | image/jpeg | image/ktx2
             { "id": "lut", "data": { "width": 16, "height": 16, "format": "rgba8unorm", "stream": "s13" } }],
"textures": [{ "id": "paint", "image": "paint_png", "colorSpace": "srgb",            // srgb | linear
               "sampler": { "wrap": ["repeat", "repeat"], "minFilter": "linear-mipmap-linear", "magFilter": "linear", "anisotropy": 4 } }]
```

Images keep their source encoding; KTX2 (Basis Universal) is the GPU-compressed option. Several
textures may share an image. The loader keeps the encoded bytes and mime on each texture so
writing back is byte-identical. Texture arrays and cube maps are later extensions.

### 4.5 Skeletons and rigs

```jsonc
{ "id": "rig", "bones": ["hips", "spine", …], "inverseBinds": { "stream": "s20", "format": "mat4" },   // bone order = joint index; inverse binds relative to the mesh node, as glTF
  "rig": { "name": "fundev-humanoid", "version": 1, "rest": "T", "height": 1.78,
           "roles": { "hips": "hips", "spine": "spine", "chest": "spine1", "upperChest": "spine2", "neck": "neck", "head": "head",
                      "leftShoulder": "…", "leftUpperArm": "…", "leftLowerArm": "…", "leftHand": "…",
                      "leftUpperLeg": "…", "leftLowerLeg": "…", "leftFoot": "…", "leftToes": "…", "right…": "…" } } }
```

- `roles` maps standard roles (the VRM humanoid set; creatures use their own role names) to
  bone ids. Skinned meshes bind at load with the mesh node's world matrix, as GLTFLoader does.
- `fundev-humanoid@1` is the platform's canonical rig: the bone set, rest pose and axes every
  public animation pack is authored on. Retargeting is rest-pose compensated: for each role, the
  clip's rotation is taken relative to the source rig's rest world rotation and applied relative
  to the target's (what `SkeletonUtils.retargetClip` does with name maps), and root translation
  scales by `height`. Local rest frames may differ between rigs; copying local rotations does not work.

### 4.6 Animations

```jsonc
{ "id": "walk", "name": "walk", "duration": 1.03, "loop": "repeat",                  // repeat (default) | once | pingpong
  "blend": "normal",                                                                // normal | additive (relative to the clip's first frame)
  "mask": ["spine"],                                                                // bones and their descendants the clip may drive
  "root": { "node": "hips", "motion": "inplace" },                                  // inplace (default) | extract: horizontal translation and yaw go to the model's handle
  "tracks": [
    { "node": "spine", "channel": "rotation", "interpolation": "linear",             // translation | rotation | scale | visible | morph:<target id>
      "times": { "start": 0, "fps": 30, "count": 32 }, "values": { "stream": "s30", "format": "snorm16x4" } },   // times: uniform, or { "stream" }
    { "material": "mat_lamp", "channel": "emitter.intensity", "times": { "stream": "s31" }, "values": { "stream": "s32", "format": "float32" } },
    { "node": "bulb", "channel": "light.intensity", "times": { "stream": "s33" }, "values": { "stream": "s34", "format": "float32" } } ],
  "events": [{ "time": 0.42, "name": "footstep", "data": { "foot": "left" } }] }   // data at most 1 KB
```

- Node channels: `translation`, `rotation`, `scale`, `visible` (0 or 1, step), `morph:<id>`,
  `light.intensity`, `light.color`. Material channels name a material, not a node: `color`,
  `alpha.opacity`, the model's parameters, `emitter.intensity`, `emitter.color`,
  `<feature>.<parameter>`; the runtime clones a material per loaded model when a clip
  animates it. Interpolation: `linear` (default), `step`, `cubic` (tangents in values, glTF
  layout).
- The loader makes Three.js keyframe tracks for node channels, bound by node id, dequantizing
  values and expanding uniform times (`cubic` uses the glTF cubic-spline interpolant).
  Material and light channels are sampled by `kit/animation.js` itself and written to the
  model's material handles and light slots, since `PropertyBinding` cannot reach a material
  by id.
- Animation packs (`kind: animations`) carry a skeleton with its rig and clips with node
  channels only; `mask` and `root.node` name roles. A model plays a pack whose rig has the same
  name and version directly; other rigs through retargeting by role.

### 4.7 Physics

Engine-neutral shapes, bodies and constraints; vehicles, ragdolls and characters map to Jolt's
controllers. Every reference is an id; every vector is in the space of the body's node.

```jsonc
"physics": {
  "shapes": [
    { "id": "box", "type": "box", "halfExtents": [0.4, 0.4, 0.4] },
    { "id": "ball", "type": "sphere", "radius": 0.3 },
    { "id": "pill", "type": "capsule", "halfHeight": 0.6, "radius": 0.25 },             // axis Y
    { "id": "drum", "type": "cylinder", "halfHeight": 0.5, "radius": 0.2 },
    { "id": "hull", "type": "convex", "points": { "stream": "s40", "format": "float32x3" } },   // 4–1024 points, not coplanar
    { "id": "walls", "type": "mesh", "geometry": "static" },                             // static bodies only
    { "id": "all", "type": "compound", "children": [{ "shape": "box", "position": [0, 0.4, 0], "rotation": [0, 0, 0, 1] }] } ],   // children are not compounds
  "bodies": [{ "id": "chassis", "node": "root", "shape": "hull",
               "motion": "dynamic",                                                      // static (default) | kinematic | dynamic
               "mass": 1200, "centerOfMass": [0, -0.2, 0], "friction": 0.5, "restitution": 0.1,
               "damping": { "linear": 0.05, "angular": 0.05 }, "gravity": 1, "ccd": false, "sensor": false, "sleep": true }],
  "constraints": [{ "id": "door", "type": "hinge", "bodies": ["frame", "door"],
                    "frame": { "position": [0, 1, 0], "axis": [0, 1, 0], "normal": [1, 0, 0] },  // in the first body's node space
                    "limits": [0, 1.6], "motor": { "mode": "position", "target": 0, "maxForce": 50 },
                    "spring": { "frequency": 2, "damping": 0.5 }, "break": { "force": 5000, "torque": 1000 } }],
  "vehicles": [{ "id": "car", "type": "wheeled", "body": "chassis",
                 "wheels": [{ "id": "fl", "node": "wheel_fl", "radius": 0.33, "width": 0.22,          // the wheel centre is the node's position
                              "suspension": { "min": 0.05, "max": 0.25, "frequency": 1.6, "damping": 0.5 },
                              "steer": 0.6, "brake": 1500, "handbrake": 0 }],
                 "engine": { "maxTorque": 300, "minRPM": 1000, "maxRPM": 6000 },
                 "transmission": { "mode": "auto", "gears": [2.66, 1.78, 1.3, 1.0, 0.74], "reverse": [-2.9] },
                 "differentials": [{ "wheels": ["fl", "fr"], "ratio": 3.42, "share": 1 }],
                 "antiRoll": [{ "wheels": ["fl", "fr"], "stiffness": 1000 }] }],
  "ragdolls": [{ "id": "doll", "skeleton": "rig",
                 "parts": [{ "id": "thigh_l", "bone": "role:leftUpperLeg", "parent": "pelvis", "to": "role:leftLowerLeg",   // bone: id or role:<role>; parent: part id
                             "radius": 0.075, "mass": 7, "limits": { "cone": 1.0, "twist": [-0.4, 0.4] } },
                           { "id": "head", "bone": "role:head", "parent": "chest", "length": 0.22, "radius": 0.1, "mass": 5, "limits": { "cone": 0.6, "twist": [-0.6, 0.6] } }] }],
  "characters": [{ "id": "walker", "node": "root", "shape": "pill", "mass": 70, "maxSlope": 0.8, "stepHeight": 0.3 }]
}
```

| Constraint | `limits` | `motor` |
| --- | --- | --- |
| `fixed`, `point` | — | — |
| `hinge` | `[min, max]` radians | position or velocity, `maxForce` as torque |
| `slider` | `[min, max]` metres | position or velocity, `maxForce` |
| `cone` | `halfAngle` | — |
| `swingTwist` | `cone`, `twist: [min, max]` | position (target quaternion) |
| `sixDOF` | per axis `translation: [[min,max]×3]`, `rotation: [[min,max]×3]` | per axis |
| `distance` | `[min, max]` | — |

Rules: nodes with bodies have uniform world scale; mesh shapes belong to static bodies and
stay under 100 k triangles (Jolt's JS bindings take them one element at a time); a ragdoll's
bones belong to its skeleton; `break` is watched by the runtime (Jolt reports constraint
impulses per step; the runtime removes the constraint; at most 64 watched per scene).
Collision layers are the platform's four (static, moving, debris, sensor; static–moving,
moving–moving, debris–static, sensor–moving collide); a body picks one with `layer` (default
by motion).
Motorcycles, tracked vehicles, height fields and soft bodies are extensions (`fun3d.motorcycle`,
`fun3d.tracked`, `fun3d.heightfield`, `fun3d.softbody`).

### 4.8 Variants

```jsonc
"variants": [{ "id": "police", "axis": "livery", "overrides": [{ "node": "body", "materials": ["white", "blue"] }, { "node": "lightbar", "visible": true }] },
             { "id": "wrecked", "axis": "damage", "overrides": [{ "node": "roof", "geometry": "roof_dented" }] }]
```

One variant active per axis; overrides may set `materials`, `geometry`, `visible` and
`morphWeights`; animation tracks apply after variants; bodies keep their shapes.

### 4.9 References

```jsonc
"refs": [{ "id": "base", "model": "commuter_body_01@v003", "hash": "sha256:…" }]
"skeletons": [{ "id": "rig", "ref": "base", "entry": "rig", "bones": ["hips", …] }]   // the bone ids this file uses, in its own joint order
```

A skeleton may come from another file: the part's `skinIndex` values index the part's own
`bones` list, which the loader maps to the base skeleton's bones by id. Only pinned library
versions may be referenced; `hash` names the referenced runtime file and a mismatch refuses
the load. One hop of depth. The resolver is the platform's: in games, the release closure (section 8);
in the workshop, the library. Validation of a part fetches its base to check bone ids.

### 4.10 Extensions

`extensions` may appear on the top level and on any table entry; feature extensions appear
in `materials[].features`. Names are `fun3d.<name>` for the platform and `x.<game>.<name>` for
games; versions are declared once per file in `uses` (`"fun3d.wind"` means the version the
runtime's registry knows; a breaking change is a new name). `requires ⊆ uses`. An unknown
optional extension drops to the fallback its specification defines; an unknown required one
refuses the file with its name. Every extension specification states its fallback and the
features it combines with. Node graphs (`fun3d.nodes`, later) are data interpreted by a
whitelisted node registry.

### 4.11 Editing sections

An `EDIT` chunk is `{ "tool": "fun.dev/workshop", "version": 3, "document": {} }`; editing-flagged
`BIN` chunks hold its binary data. `asset.source.kind` is `glb` or `edit`, exactly one;
`asset.source.tool` names the authoritative section when it is `edit`. Other tools' sections
are kept and shown read-only with a diff; reimporting from the runtime section happens only
by command. The library never edits runtime data. The validator checks editing sections for
size and absolute paths only.

### 4.12 Versioning

`fun3d` is `major.minor`. A minor change adds fields old readers can ignore without loading
anything wrong (writers must show this); a major change refuses old readers. Extensions
version by name. `asset.source.converter` and `profile` name what produced the runtime
section; a derived file never changes in place (section 8).

## 5. Validation and limits

The validator runs in the maintenance script (before anything is served), in the console (on
upload, as a check), and in the loader (counts, ranges, non-finite values; cheap). It checks
the JSON Schema, that every reference resolves, that streams lie inside buffers and
attributes inside strides, that parents form a tree, that quaternions are unit, that every
decoded float stream is finite and every index in range, that hulls have four non-coplanar
points, and the caps below (the library profile's).

| | Cap |
| --- | --- |
| file | 64 MB stored, 256 MB raw; JSON chunk 16 MB |
| nodes / geometries / materials / images | 4096 / 1024 / 256 / 64 |
| vertices / triangles per geometry, total | 4 M / 8 M, 16 M / 32 M including LOD levels |
| vertex buffers / attributes per geometry | 6 / 11 (WebGPU allows 8 / 16; instancing and tint take the rest) |
| texels per image / per file | 16 M (4096²) / 64 M |
| bones per skeleton, influences | 128 (a uniform block within WebGL 2's minimum), 4 |
| morph targets per geometry, targets × vertices per file | 64, 1 M (32 MB of GPU memory) |
| clips, tracks per clip, keyframes per file | 256, 1024, 4 M |
| placements per node, per file | 65 536, 262 144 |
| convex points, mesh-shape triangles, bodies, constraints | 1024, 100 k, 256, 256 |

## 6. Profiles

A profile is a kit module `{ name, version, rules, limits }` that turns a producer's
conventions into explicit data when importing. The console and the maintenance script run the
platform's profiles only; a game may register its own in `game.json` for its own assets, run by
its own build. `fundev-library@1` reads the conventions documented in [models](models.md):

- `static__<material>` nodes merge into one node `static`; `<pivot>__<material>` children
  merge into their pivot; other mesh nodes merge their primitives; flat faces weld and lose
  their normals (`groups[].flat`); unused texture coordinates go.
- `mat_light*`, `mat_signal*`, `mat_window*`, `mat_lamp*`, `mat_screen*`, `mat_beacon*` get
  `emitter` with the matching role; `mat_body` gets `tint`; transmissive materials
  `transmission`.
- Physics by library type: props and pieces a convex hull (`collider*` nodes when present;
  convex decomposition later as `fun3d.decomposition`), vehicles (type `vehicle`) a wheeled
  vehicle from `wheel_*` nodes with defaults by mass class, characters a capsule and a ragdoll
  from the rig's roles. Mass from a density table by type.
- Ids: node ids are the glTF node names (unique by suffix at import, recorded in the editing
  section), material ids the material names, bone order the glTF skin order. The same source
  gives the same ids on every run.

## 7. Runtime

| Module | Role |
| --- | --- |
| `kit/fun3d.js` | read, validate, load into Three.js, write from Three.js, strip editing sections, dispose |
| `kit/fun3d-import.js` | GLB → `.fun3d` through a profile (typed-array welding, bounded memory) |
| `kit/materials.js` | models and features in TSL; one builder serves single meshes and batches; registry |
| `kit/models.js` | places loaded models and returns handles: batches rigid batchable meshes, instances placements, picks LOD levels, budgets lights, applies variants and tints; `model.part(id)`, `model.socket(id)`, `roles.set` |
| `kit/physics.js` | Jolt: bodies, constraints, vehicles, ragdolls, characters; asynchronous API, pooled temporaries, `dispose()`; the world can move to a worker |
| `kit/animation.js` | clips, masks, additive blending, events, retargeting by role |

The kit, not the file, decides whether a mesh is drawn alone, instanced or batched, which LOD
level shows, how many lights are real and where physics steps. Physics steps at a fixed rate
with interpolation; its API takes the inputs for step N and returns the state of step N−1, so
the world can live in a worker (transferred state; shared memory only where the page is
cross-origin isolated). Shapes are cooked off the main thread. On WebGL 2 without
`WEBGL_multi_draw`, a batch still issues one draw per copy; the pipeline and material savings
remain. Jolt is served like the vision
runtime (`/runtime/physics/<hash>/`, cache-first, outside the shell precache, found through
`import.meta.url`); the meshopt encoder is not shipped to games. Everything loaded registers
with the game context's `track` and is released at teardown.

## 8. Pipeline

- **Derived files.** `model.fun3d` is derived from the source by the maintenance script
  (headless Chromium, one converter) and stored under a `derived` record `{ sha256, size,
  converter, profile }` separate from `files`; every approved version of every model converts.
  A new converter or profile makes a new derived file; the old one stays as long as any lock
  or reference pins it. Regeneration that would change ids or bone order is refused (the
  model needs a new version). Workshop sources (`kind: edit`) regenerate through the headless
  workshop; GLB sources through the importer.
- **Parity gate.** `npm run models -- convert` renders GLB and `.fun3d` in the same viewer,
  pixel-diffs them (worst-50 sheet), and checks derived data (hull points, mass class, wheel
  count, emitter roles) before a derived file is recorded.
- **Console.** Uploads stay as they are (GLB in, thumbnails from GLB); a version shows `未转换`
  until the script derives its file; the validator runs on upload as a check. Browser
  conversion is a preview at most, never what the library serves.
- **Games.** `game.json` pins versions and names the format (`"models": { "format": "fun3d" }`,
  one format per game); `games/<id>/models.lock` records the derived hash and path of every
  pinned file and of the closure of references (`models/<id>@<version>.fun3d`);
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

Levels: **core** (defined and in the first release), **extension** (mechanism in core, feature
later with the producer and consumer named), **change** (needs a core change), **conflict**
(works only with the stated restriction).

| Scenario | Level | Schema | Producer / consumer |
| --- | --- | --- | --- |
| Textured PBR props (normal, ORM, occlusion on uv1, transforms) | core | 4.3 maps | workshop stage 3 / every game |
| Characters: base body + hair and clothes on one skeleton | core (release 2) | 4.9 refs, bone-id remap | character creator / games |
| 50–100 expressions, sliders | core, conflict | 4.2 sparse morphs; dense on the GPU, 1 M target-vertices per file | creator / games |
| Decals, toon hair, skin | extension | `fun3d.decals`, `fun3d.hair`, `fun3d.skin` | creator / games |
| Creatures with custom rigs; retargeting | core (release 2) | 4.5 roles, rest, height | workshop stage 4 / `kit/animation.js` |
| Animated materials and lights, visibility | core | 4.6 channels | workshop, games / runtime |
| Events, additive clips, masks, root motion | core | 4.6 | animation packs / `kit/animation.js` |
| Doors, drawers, levers | core | 4.7 constraints | workshop physics commands / `kit/physics.js` |
| Destructibles | core data + game code | bodies per fragment, `break` | workshop / physics; the swap is the game's |
| Cars | core | 4.7 wheeled | profile, workshop / physics |
| Motorcycles, tracked vehicles, boats | extension | `fun3d.motorcycle`, `fun3d.tracked`, `fun3d.buoyancy` | nobody yet |
| Cloth, soft bodies | extension | `fun3d.softbody` | workshop later / Jolt |
| Character controller | core (release 2) | 4.7 characters | profile / physics |
| Lamps that light, headlight cones | core, conflict | 4.1 lights with importance; fixed light slots per tier, authored against the platform exposure | profile / `kit/models.js` |
| City tiles, terrain | conflict + extension | tiles are models in a world list; `fun3d.heightfield` | 帝都's build / runtime |
| Vegetation at scale, per-copy colour, wind | core + extension | 4.1 placements with tint; `fun3d.wind` | profile, workshop / runtime |
| Crowds | extension | `fun3d.vat` baked animation textures | creator / games |
| Colour schemes and damage states together | core | 4.8 variant axes | workshop / runtime |
| Custom shaders | extension | `fun3d.nodes` | workshop later |
| GPU-driven rendering | extension | `fun3d.clusters` | runtime |
| Other tools' editing data | core | 4.11 | tools |
| New codecs and image formats | core | registries, `requires` | — |
| Instanced skinning | extension | `fun3d.vat` or a TSL skinning node over instances (runtime work, not a format change) | creator / games |

**Conflicts** (what the runtime enforces):

| | Batching | Skinning | Morphs | Geometry LOD | Variants | Placements | Blend alpha | Physics |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Batching | — | no (drawn alone) | no | per copy | palette slots | yes | second batch, sorted | — |
| Skinning | no | — | yes | yes | yes | no (see crowds) | yes | ragdoll, character |
| Morphs | no | yes | — | yes | `morphWeights` | Three.js supports instanced morphs; the runtime may | yes | — |
| Group LOD | per level | levels share the skeleton | yes | yes | yes | no | yes | one body for the group |
| Variants | yes | yes | yes | yes | one per axis | every copy | yes | shapes unchanged |
| Placements | yes | no | yes | yes | every copy | — | yes | static body per copy |
| Animation | yes | yes | yes | yes | after variants | per node, not per copy | yes | kinematic follows, dynamic ignores |
| Transmission | no | yes | yes | yes | yes | drawn alone | yes | — |
| Refs | yes | base skeleton | own | own | local entries only | yes | yes | own |
| Lights | real lights budgeted; emitters always glow | | | | | not on placed nodes | | |
| Masks | — | after retargeting | — | — | — | — | — | a mask without the root drops root motion |
| Animated materials | per-copy palette slot | yes | yes | yes | after variants | per node | yes | — |
| Lines, points | never | — | — | — | — | instanced only | — | — |
| Integer attributes | — | `skinIndex` loads as an integer attribute on both backends | — | — | — | — | — | — |

## 10. Rollout

1. **Core**: schema and validator, container, loader and writer, importer with the library
   profile, `pbr`/`unlit` with `emitter` and `tint`, batching, static bodies and wheeled
   vehicles, `models.lock`, parity gate, the agent one-pager, `verify kit` with synthetic
   scenarios for every core row above.
2. **Library**: derived files for every approved version; `未转换` state; derived-data warnings
   in review.
3. **Games**: 帝都 (taxi, street furniture, lights budget).
4. **Release 2**: references, retargeting, ragdolls, characters, character controller,
   material and light channels, events, variants, group LOD; 准点下班 adopts.
5. **Workshop**: `.fun3d` save and open with editing sections, GLB export, physics commands.
6. **Extensions as needed**, each with its producer and consumer: wind, decals, hair, skin,
   soft bodies, crowds, atlases, nodes, clusters, heightfields, motorcycles.

## 11. Open decisions

1. Light budget: how many real lights per device tier.
2. Library type `vehicle` added to the catalogue, with a one-time `retype` action for the
   approved vehicles typed `prop`.
3. A scheduled conversion job (GitHub Actions with a Wrangler secret) or `未转换` as a normal
   state cleared by hand.
4. KTX2 transcoding at conversion: off for the first release.
