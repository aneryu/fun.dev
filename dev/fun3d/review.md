# .fun3d design — adversarial review log

Design v2 (`docs/model-format.md`) was attacked by three independent reviewers (engine realism,
format design, pipeline and operations) plus a self-review. This log records every finding
and what the design does about it. Rounds are cumulative; the document reflects the latest
round.

## Round 1

### Self-review (before the agents reported)

| # | Finding | Decision |
| --- | --- | --- |
| S1 | Three.js interleaved buffers hold one element type; "snorm16 position + snorm8 normal in one buffer" is impossible | Buffers group attributes by element type (Int16, Uint16, Int8, Uint8, Float32); at most 8 buffers |
| S2 | BatchedMesh cannot share vertices between index-only LOD levels | Index-only levels are a storage form; batches duplicate vertices per level |
| S3 | Three.js morph targets expand to a dense texture (targets × vertices × 32 bytes) | Limit: 64 targets per geometry, memory estimate in the validator; sparse storage stays |
| S4 | PropertyBinding paths cannot reach `material.params.x` | Runtime materials expose animatable parameters as direct properties |
| S5 | Jolt has no per-material friction (PhysicsMaterial is a tag); friction and restitution are per body | `physics.materials` removed; friction/restitution on bodies; per-shape material ids only as tags |
| S6 | Jolt has no breakable constraints | `break` thresholds are polled by the runtime from constraint lambdas; documented as runtime behaviour |
| S7 | Constraint frames, shape transforms and wheel positions lacked a coordinate frame | All in the space of the body's node (constraints: the first body's node) |
| S8 | Bodies on nodes with placements undefined | One static or kinematic body per copy; dynamic bodies need separate nodes |
| S9 | Group LOD underspecified | `lod.levels[]`, each naming the children visible at that level, thresholds descending |
| S10 | Light units: directional lights are lux (glTF), point and spot candela (Three.js) | Stated per type |
| S11 | Meshopt filters map to formats: octahedral → snorm8x4/snorm16x4, quaternion → snorm16x4 | Stated |
| S12 | Writer determinism not stated | Same input gives the same bytes (ordering and ids fixed) |

### Pipeline and operations reviewer (31 findings)

| # | Finding | Decision |
| --- | --- | --- |
| P1 | Regenerating derived files changes the bytes a pinned version resolves to; every pinning game republishes with changed physics | **Accepted.** Derived files are immutable per (version, converter, profile). Games keep `games/<id>/models.lock` (hash, size, path) like `assets.lock`; `npm run models -- update <game>` advances it |
| P2 | No converter regression gate | **Accepted.** `npm run models -- convert` renders GLB and `.fun3d` in the same viewer, pixel-diffs, writes a worst-50 sheet, checks derived data (hull points, mass class, wheel count, emitter roles) |
| P3 | "Every listed model" misses unlisted and older approved versions games may pin | **Accepted.** Every approved version converts |
| P4 | `ensureVersion`/`approveVersion` refuse derived files; `putFile` publishes per file; orphans | **Accepted.** A `derived` column separate from `files`; one publish per run; derived blobs deleted when no lock references them |
| P5 | Two converters (console bundle, site bundle), hand-typed stamp | **Accepted.** One converter: the maintenance script in headless Chromium; stamp = hash of converter modules + profile |
| P6 | Console CSP has no `wasm-unsafe-eval` | **Accepted with P5:** browser conversion is cut from the first release |
| P7 | Importer allocates per triangle; dies at the limits | **Accepted.** Weld on typed arrays (meshopt `generateVertexRemap`); triangle cap for any in-browser path |
| P8 | Partial uploads leave an unexplained pending state | **Accepted.** Status knows derived data: `未转换` is a visible state in the console and `list` |
| P9 | Review wall would depend on conversion | **Accepted.** Thumbnails stay on the original GLB; `.fun3d` renders only in the parity check |
| P10 | File hashes differ by zlib implementation | **Accepted.** `asset.source.content` = hash over inflated payloads; both stored |
| P11 | No reference resolver in games; versions collide | **Accepted.** Closure files are `models/<id>@<version>.fun3d`; the build inflates manifests to collect refs; resolver `(id, version) → asset(path)` |
| P12 | Skin indices into a referenced base skeleton break on bone reorder | **Accepted.** A skinned part lists the bone ids it uses; the loader remaps by id |
| P13 | Jolt lands in the shell precache; root-relative import crosses the edge redirect | **Accepted.** Jolt served like the vision runtime (`/runtime/physics/<hash>/`, cache-first, excluded from the shell, URL from `import.meta.url`); encoder not shipped to games |
| P14 | Model pages and console cannot decode `.fun3d` (CSP, viewer) | **Accepted.** Pages keep GLB in the first release |
| P15 | Approved vehicles are typed `prop`; types are locked | **Accepted.** `retype` plan action allowed for widening (`prop → vehicle`), recorded in `asset.source.profile` |
| P16 | "Regenerate from the source" undefined for workshop documents | **Accepted.** `source.kind: edit` regenerates through the headless workshop; `glb` through the importer; other kinds refused |
| P17 | Stale rule discards recipes with nobody watching | **Accepted.** Stale sections open read-only with a diff; reimport only by command; the library never marks stale |
| P18 | Editing sections may leak script paths | **Accepted.** Validator strips absolute paths; allowed contents listed |
| P19 | GLB export extras have no consumer | **Accepted.** Plain GLB export; semantics stay in `.fun3d` |
| P20 | Loaded object graph differs from GLTFLoader's | **Accepted.** `kit/models.js` is the API (`part(id)`, `tint`, `roles`); duplicate ids refused at write |
| P21 | Two render paths disagree (batch vs single mesh) | **Accepted.** `kit/materials.js` builds both from one function; a `verify kit` case renders both ways and diffs |
| P22 | Shipping both `.glb` and `.fun3d` doubles downloads | **Accepted.** One format per game (`game.json` `"models.format"`), never both |
| P23 | Physics never tears down | **Accepted.** `physics.dispose()` on `onCleanup`; `handle.remove()`; pooled Jolt temporaries |
| P24 | No agent can write `.fun3d` by hand; no one-pager | **Accepted.** `docs/fun3d-agents.md`: three recipes, descriptors by id, `npm run fun3d -- inspect|validate` |
| P25 | grok's tiles (GLB + meshopt) have no producer path; two loaders in 帝都 | **Accepted.** Build-time conversion of `games/<id>/assets/*.glb` on request (`game.json` `"convert": [...]`), cached by hash; tiles stay GLB until then |
| P26 | No JSON Schema | **Accepted.** Schema written first; the limits table derives from it; `npm test` validates every converted file |
| P27 | Review never sees derived physics or roles | **Accepted.** Derived-data warnings in `models-admin` and the console wall |
| P28 | Maintenance is the cost: ~4 k lines of unversioned shared runtime | **Accepted.** First-release surface cut (below); Jolt pinned by hash; `verify kit` covers it |
| P29 | No automated converter runner exists | **Accepted.** `未转换` is an explicit state; conversion runs from the maintenance script (a scheduled Actions job is an option the owner decides) |
| P30 | Release gate has no `.fun3d` coverage | **Accepted.** `verify kit` loads real library files plus synthetic scenarios before any game adopts |
| P31 | Retargeting in the first release is scope creep | **Accepted.** Release 1 plays clips on the same bone ids only; roles stay in the schema |

Cut from the first release (reviewer's list, accepted): browser conversion; pages, thumbnails
and console on `.fun3d`; references, retargeting, ragdolls, character controllers; editing
sections in library sources (the workshop keeps `.funmodel.glb` until its binary storage);
GLB export extras; variants, group LOD, placement attributes, toon, physical transmission,
material and light channels, events, light budgeting. Schema slots stay; nothing is built.

First release: container + schema + validator, importer with the library profile, write and
load, `pbr`/`unlit` with `emitter` and `tint`, batching, static bodies + wheeled vehicles,
`models.lock`, the parity test, the agent one-pager.

### Format-design reviewer (67 findings)

All accepted unless noted; the decision is what v3 does.

| # | Finding | Decision |
| --- | --- | --- |
| D1–D7 | Chunk `id` vs ordinal; three ways to classify a chunk; reserved flag bits; `rawLength` not enforced during inflation; header size and padding unstated; no container version; "JSON first" not a rule | Container simplified: types `JSON`, `BIN`, `EDIT`; flags deflate and editing (reserved bits must be 0); exactly one JSON chunk first; editing-flagged chunks last; buffers reference BIN chunks by ordinal; header 16 bytes, `storedLength` excludes padding; inflation stops at `rawLength` and a mismatch refuses; JSON chunk capped; the signature is the container version |
| D8 | No defaults | A default for every optional field |
| D9 | Vector spaces unstated | A space for every vector field; right-handed, quaternion `[x, y, z, w]`, TRS composed T·R·S, `mat4` column-major |
| D10 | Two versions, `asset.format` and `asset.id` redundant | Top-level `"fun3d": "1.0"`; `asset.id` dropped (the catalogue owns identity) |
| D11 | `limits` derivable, forgeable | Deleted; the validator's caps are the rule |
| D12 | `codec` conflates mode and filter | `codec: "meshopt"`, `mode` (attributes, triangles, indices), `filter`, `filterBits` |
| D13 | Duplicate strides | Geometry buffers name streams only; `length = count × stride` without a codec |
| D14 | Suffixed names break tracks and round trips | `object.name = id`; display name in `userData.name`; tracks bind by id |
| D15 | Kinds undefined | A table of what each kind may contain |
| D16 | Id scopes | Tables are separate id spaces; morph targets have ids; socket keys use the id charset |
| D17–D24 | Group LOD, placements combinations, `_tint`, `importance`, "handle", negative scale, quaternion validity, default morph weights | All specified: group `lod.levels[]` with visible children per level; placed nodes carry no light, bone, lod; one static body per copy; `_tint` linear unorm8x4, one slot per model; `importance` 0–1 relative rank; no directional lights in models; scale > 0, bodies uniform world scale; quaternions unit within 1e-3; `mesh.morphWeights` |
| D25 | Blend ordering of groups impossible (materials live on nodes) | Rule deleted; the runtime sorts draws |
| D26 | LOD levels lose groups | `lods[].groups` |
| D27 | `material` attribute duplicates groups | Deleted from the file; derived at load for batches |
| D28 | Morph deltas quantized with the position scale | `morph.decode` with its own scale |
| D29 | Per-vertex zero-normal sentinel | Flatness per group (`groups[].flat`); the writer never relies on sentinels; batches build what they need |
| D30–D32 | Units of `groups`, LOD error, tangent `w`, position `w`, lines and points materials; attribute cap; morph target ids | Stated; 12 attributes per geometry (the runtime adds the rest); targets have ids |
| D33 | Feature keys vs extension names | Core features by bare key (`emitter`, `tint`, `transmission`); others by full extension name; versions only in `uses`; no `extensions` on materials |
| D34 | Two emission paths | `emitter` replaces `pbr.emissive`; its state is a role factor the runtime sets |
| D35–D37 | Alpha fields, per-model parameter tables, `occlusion` slot, transmission amount and attenuation, `quality`, tint semantics | Added; `quality` deleted; transmission never batches; tint multiplies base colour |
| D38–D40 | Texel cap, array and cube textures, UV and sampler conventions | Cap per file; array and cube deferred; glTF UV convention, no flips |
| D41 | Retargeting contract | Canonical rig `fundev-humanoid@1` for packs; rest-relative retargeting defined; release 1 plays same-id clips only |
| D42–D46 | Additive reference pose, material channels without `node`, pack channels by role, root motion axes, totals caps | Specified |
| D47 | Non-finite floats and unchecked indices reach Jolt and the GPU | Decode-time scan of every float stream, index range checks, hull and compound rules, failure marks the asset bad |
| D48 | `jolt: {}` passthrough | Deleted |
| D49 | Pieces with mesh shapes are not dynamic | Pieces get convex hulls; mesh shapes stay static-only |
| D50–D54 | Wheel ids and positions, per-type tables, shape ids, body nodes vs hierarchy, ragdoll references and layers | Wheels have ids and take positions from nodes; per-type field tables (motorcycle, tracked and heightfield deferred); shapes referenced by id everywhere; body nodes detach to world, kinematic follow tracks; ragdoll bones by `role:` or id; `layers` deleted |
| D55 | Variants exclusive and underdefined | `variants[].axis`; one active per axis; precedence variant then animation; allowed overrides listed |
| D56–D58 | Ref entry syntax, regeneration drift, resolver scope | `{ id, ref, entry }`; refs carry the referenced file's content hash; regeneration that changes ids or bone order is a new version; deterministic id derivation documented; validation fetches the base |
| D59 | Extension naming | `fun3d.<name>`; version only in `uses`/`requires`; `requires ⊆ uses`; codecs are `fun3d.codec.<name>`; every extension states its drop fallback |
| D60 | Two sources of truth | `asset.source.kind` is `glb` or `edit`, exactly one; `asset.source.tool` names the authoritative section |
| D61 | Integer version cannot express safe additions | `major.minor`; minor additions are safe to ignore; major refuses |
| D62 | Client-produced derived files served to every game | Browser conversion is a preview; the trusted script derives what the library serves |
| D63–D65 | Profile form, duplicated conventions, "no code" vs node graphs | Profiles are kit modules; conventions documented once in models.md; node graphs are data for a whitelisted registry |
| D66–D67 | Evaluation rows overstated; conflict cells missing | Rows relabelled (motorcycle, tracked, heightfield = extension; destructibles = data + game code); conflict table completed |
| Deletions | `limits`, `asset.format`, `asset.id`; duplicate attribute, stride, wheel position; `quality`, `layers`, directional lights, `jolt`; array/cube textures, motorcycle/tracked, refs beyond skeletons, node LOD in v1; container classification | Accepted |

### Engine-realism reviewer (31 findings)

| # | Finding | Decision |
| --- | --- | --- |
| E1 | Mixed element types in one interleaved buffer do not exist in Three.js; the prototype never interleaved | Buffers grouped by element type (also S1); example corrected |
| E2 | `uint8x4`/`uint16x4` attributes: WebGPU widens to 32 bits; WebGL 2 needs `gpuType` Int, interleaved has none; `skinIndex` must stay integer | `skinIndex` planar, loaded with `gpuType` Int, cost stated; the material slot attribute left the file (D27) and batches derive an `unorm8x4` slot at load |
| E3 | BatchedMesh copies vertices per geometry id; index-only LOD levels duplicate in batches | Stated in 4.2 (also S2) |
| E4 | BatchedMesh needs one attribute signature | Profile defines a batch signature; the importer pads batchable geometries |
| E5 | Light sets are part of the shader cache key; budgeting by adding/removing lights recompiles | Fixed light slots per tier, moved and dimmed; stated in 4.1 and 7 |
| E6 | Candela without an exposure contract means nothing | Platform exposure contract stated in 4 (ACES, exposure 1, 100 cd at 1 m reads white); emission intensity capped at 64 |
| E7 | Morph targets expand to dense GPU textures; delta space must match the position space | Morphed meshes load with float positions; deltas in metres with `morph.decode`; cap 1 M target-vertices per file; row relabelled core, conflict |
| E8 | `PropertyBinding` cannot reach materials by id or two-level parameters; batches need per-copy slots | Material and light channels sampled by `kit/animation.js`, written to material handles and palette slots; conflict row added |
| E9 | Copying local rotations by role is wrong when rest frames differ | Retargeting defined as rest-pose compensated (SkeletonUtils.retargetClip with role maps) |
| E10 | Jolt has no per-material friction | Physics materials deleted (also S5) |
| E11 | No breakable constraints | `break` polled per step from constraint impulses, at most 64 watched (also S6) |
| E12 | Tracked and motorcycle vehicles need their own fields | Deferred to extensions with per-type objects |
| E13 | Layer tables are per world, not per file | Platform layers; files name one (also D54) |
| E14 | Mesh shapes enter Jolt one element at a time; 1 M triangles takes seconds; heightfield had no fields | Cap 100 k triangles; cooked off the main thread; heightfield deferred to an extension |
| E15 | Worker physics unspecified (SAB needs cross-origin isolation; everything a frame late) | Fixed step with interpolation; inputs for N, state N−1; transferred state unless isolated |
| E16 | Codec and filter conflated; filters need planar streams; lines and points need the index-sequence codec | `codec` + `mode` + `filter` + `filterBits`; `indices` mode (also D12) |
| E17 | 8 buffers / 16 attributes leave no room for instancing | Caps 6 / 11 |
| E18 | No texel budget; array and cube textures undefined | 64 M texels per file; array and cube deferred (also D38–39) |
| E19 | Loaded textures are bitmaps; write-back re-encodes | The loader keeps encoded bytes and mime on textures |
| E20 | Skinning is a uniform block; 256 bones is WebGL 2's minimum block exactly | Cap 128 bones |
| E21 | Flat/smooth boundary vertices must be duplicated; `normalNode` bypasses normal mapping | Duplication rule; `kit/materials.js` owns normal mapping and flat shading |
| E22 | Per-copy data: InstancedMesh needs per-node geometry wrappers; BatchedMesh offers colours only | Core per-copy attribute is tint only (also D19) |
| E23 | Per-geometry UV decode breaks batches | Batches take no maps in release 1; batch signature fixes formats |
| E24 | Loader object model (pivot + child mesh) undocumented | Stated in 4.1 |
| E25 | Animation values dequantize and times synthesize at load; cubic needs a custom interpolant | Stated; glTF cubic-spline interpolant reused |
| E26 | Light axis undefined; spot cone mapping | Spots shine down −Z; cone maps to angle and penumbra |
| E27 | `transmission.quality` is not a Three.js concept | Deleted (also D35) |
| E28 | LOD groups need bounds; error units | Bounds = union of level-0 children; error relative to the bounds radius |
| E29 | WebGL 2 without multi-draw issues one draw per copy | Stated in 7 |
| E30 | Instanced skinning is runtime work, not a format change | Row relabelled extension |
| E31 | `deflate-raw` needs Node ≥ 20.12, Safari ≥ 16.4; stream offsets must align | Stated; alignment in the validator |

Round 1 closed: v3 written from all four lists (S1–S12, P1–P31, D1–D67, E1–E31).

## Round 2

### Resolution and regression check (28 regressions, plus partial/missing/contradicted decisions)

Implemented in v4 unless noted.

| # | Finding | Decision |
| --- | --- | --- |
| R1 | `asset.content` self-referential and undefined for editing chunks | Defined: SHA-256 over inflated runtime BIN payloads in ordinal order, then the manifest with `asset.content` = ""; editing excluded |
| R2 | Console validation of uploads that are GLB | Validator runs in the console only for direct `.fun3d` uploads (release 2) |
| R3 | `pbr` still listed an emissive map | Moved to `features.emitter.map` |
| R4 | Id suffixing "recorded in the editing section" | Pure function of document order (`_2`, `_3`…) plus charset mapping |
| R5 | "core" meant both schema-defined and first release | Core = schema-defined; a release column in section 9; section 10 is a table of what each release implements and what the loader does with the rest |
| R6 | Exposure anchors numerically wrong | One anchor: emitter 1 and a white surface under π cd at 1 m give radiance 1 (≈ 0.8 after ACES); about 8 clips |
| R7 | `position` vs `translation` channel | `position` |
| R8 | `_tint` vs `placements.tint` | `tint` in the file; `_tint` only as the runtime attribute |
| R9 | `uint16x4` skinIndex with 128 bones | Dropped |
| R10 | Example stride 12 for an 8-byte buffer | 8 |
| R11 | One node example violating the combination rules | Split into valid examples and a combination table |
| R12 | Ragdoll example referenced undefined parts | Parts added |
| R13 | Id derivation pointed to section 8 | Section 6 |
| R14 | Extension versions in `uses` | Extensions carry no version; a breaking change is a new name |
| R15 | Bind matrix claim | Identity in attached mode, as GLTFLoader |
| R16 | Images "stored without deflate" was unplaced | Image streams live in BIN chunks without bit 0; raw data may deflate |
| R17 | `EDIT` type vs flag; EDIT's BIN addressing | EDIT always flagged, JSON never; ordinals among all BIN chunks |
| R18 | Ref hash zlib-dependent | `content` = the referenced file's `asset.content` |
| R19 | "atlases" | "texture arrays" |
| R20 | Attenuation without distance | `attenuationDistance` (0 = infinite) |
| R21 | Differential and swing-twist fields unmapped | `split`, `engineShare`, `limitedSlip`; `normalCone`, `planeCone` |
| R22 | Hull points | Jolt keeps at most 256 hull vertices, stated |
| R23 | Missing caps | chunks, streams, textures, skeletons, sockets, variants, refs, events |
| R24 | Uniform scale per placed copy | Stated |
| R25 | City tiles "conflict" without a restriction | Restriction stated (caps per tile, no streaming inside a file) |
| R26 | Pack tracks' `node` | Bone ids of the pack's skeleton; roles for `mask` and `root` |
| R27 | Three.js names → ids at write | Charset mapping, duplicates refused |
| R28 | Supersessions unmarked in this log | S1, D30–D32 (caps) superseded by E17; S8 superseded by D17–D24 (static only); S4 superseded by E8 |
| partial D8 | Defaults missing | Section 4.13 defaults table |
| partial D27/E2 | Batch slot derivation unstated; `skinIndex` plain | Stated in 4.2 |
| partial D47 | Failure handling | A shape the runtime cannot build marks the model's physics failed; the library records it |
| partial D56–D58 | Charset mapping of glTF names | Stated in section 6 |
| partial D66–D67 | Empty Lights row | Filled |
| partial P1, P4, P5, P7, P8, P11, P18, P20, P21, P23, P26, E31 | Size in the lock; one publish per run and orphan deletion; converter stamp; 200 k triangle cap in browsers; `list` shows 未转换; closure collection and resolver; stripping paths and allowed contents; duplicates refused at write; both-ways render diff; `handle.remove()`; schema first and `npm test`; DecompressionStream versions and offset alignment | All stated |
| missing S12 | Byte determinism | Scoped to one converter build; `asset.content` for data identity |
| missing P15 | `retype` | Recorded in `asset.source.profile` (section 6); the type itself stays an owner decision |
| contradicted D33 | `extensions` on materials | Excluded; features only |
| contradicted D63–D65 | Conventions "documented once in models.md" were not there | Section 6 is normative; models.md links to it |
| scope | Section 10 narrower than the review's first release; "core (release 2)" rows | Section 10 rewritten as a release table including the loader's behaviour with unimplemented data |

### Fresh-eyes reviewer (30 findings, 5 simplifications, biggest risk)

Implemented in v5 unless noted.

| # | Finding | Decision |
| --- | --- | --- |
| F1 | Decoded stream size unbounded | Σ `count × stride` ≤ 256 MB, checked before decoding; vertex stride ≤ 64 |
| F2 | Alignment rules missing | Stream offsets, vertex strides and attribute offsets multiples of 4; index streams their element size; validator refuses |
| F3 | `SkeletonUtils.retarget` is not rest-pose compensated | Reference dropped; the delta formula stated; `kit/animation.js` owns it |
| F4 | Packs bind by node id but claim rig compatibility | Pack tracks bind by role (bone → role → bone); same rig skips rest compensation only |
| F5 | Two animation systems with undefined blending | One mixer: material and light channels bind to per-model proxy objects; the runtime copies proxy values after each update |
| F6 | Refs pin a file; parts lack inverse binds | Refs pin the base skeleton's `hash` (bone ids, rest, inverse binds); parts carry their own inverse binds; `models.lock` verifies at build, the loader never fetches |
| F7 | Characters need region hiding and shared morphs | `regions` on base nodes, `hides` on parts; morph targets with the same id drive together |
| F8 | No image sharing across tiles | Images and textures may be referenced across files |
| F9 | Destructibles cannot start stable | `active` and `switchable` on bodies; `break` detection from contact impulses |
| F10 | Wheel attachment ambiguous | `suspension.rest`: the node's position is the wheel centre at rest length |
| F11 | Exposure sentence numerically wrong | Formulas and a worked lamp value; intensities capped at 1000 |
| F12 | Minor versions cannot absorb enum growth; strictness; prototype pollution | New enum values are extensions or major; strict schema for the writer's minor, loader tolerates unknown fields; null-prototype reviver |
| F13 | Profile ids underivable for non-ASCII names | Slug + six hex of the name's SHA-256 when lossy; `_2` suffixes in document order; every later profile reproduces `@1` ids |
| F14 | Conventions not in models.md; approved models never asked to follow them | Section 6 normative; the parity run reports convention coverage before anything but hulls is promised |
| F15 | `asset.content` circular, no consumer | Deleted; `derived.sha256` and `asset.source.hash` defined over stored bytes; refs pin skeleton hashes instead |
| F16 | Offline closure misses the physics runtime | Jolt and decoders listed in each release's `files.json` closure |
| F17 | Constraint frames half-specified; springs ambiguous; no world anchors; character origin | Assembled-pose rule; `limitSpring` vs `motor.spring`; `bodies: [null, …]` anchors to the world; `characters[].offset` |
| F18 | Hull cap above Jolt's 256 | Cap 256 |
| F19 | Bone cap justification | Stated as policy |
| F20 | Shadow toggles recompile | Shadow is a slot property |
| F21 | Map semantics ambiguous | `metalRough` + `occlusion`; colour-map alpha rule; feature × model table |
| F22 | Unlisted LOD children hidden forever | Unlisted children always show |
| F23 | Missing validator rules | Added (intensity bounds, determinants, cone order, morph weights, slots, UV sets, event times, bodies on bones, refs of refs, counts) |
| F24 | Library uploads can require `x.*` or unknown codecs | Library accepts only registered `fun3d.*`; meshopt is the only 1.0 codec |
| F25 | Morph row did not fit its cap | Restated: 100 targets on a 10 k-vertex face, the face its own geometry |
| F26 | Parity gate without a threshold | Per-model thresholds on a masked metric; derived-data checks are the gate |
| F27 | One format per game vs tiles staying GLB | One format per library model; game-local assets may stay GLB |
| F28 | Editing-section rules | EDIT always flagged; BIN ordinals; unknown chunk types skipped; hashes defined over stored bytes |
| F29 | Encoded bytes kept on textures double memory | Loader option; off in games |
| F30 | Conflict table cells | Fixed (refs × batching, morphs × placements, transmission × placements, blend × placements) |
| Simplify 1 | `buffers` table | Deleted; streams name the chunk |
| Simplify 2 | `asset.content`, `licence`, `attribution` | Deleted; the catalogue owns them |
| Simplify 3 | `bone: true` | Deleted; bones are what skeletons list |
| Simplify 4 | Unbuilt schema slots | Moved to appendix A (toon, lines/points, raw image data, uv2/uv3, cubic, pingpong, cone/sixDOF/distance, manual transmission, exponential filter, texture arrays, other codecs) |
| Simplify 5 | Multi-tool editing sections | One section; a tool that does not understand it drops it |
| Risk | Irreversibility before the consumer exists | Section 10 order: 帝都 runs on trial derived files, the converter is frozen only after the parity gate passes over the library, pins come last |

Round 2 closed: v5 written. Round 3 is a final consistency check of v5.
