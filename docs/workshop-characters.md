# Character authoring: duck acceptance track

This is the implementation track requested on 2026-10-20. It extends the
agent-first direction in [the roadmap](platform-roadmap.md), with static,
local authoring and `.fun3d` playback. It does not promote automatic weights,
IK, retargeting, UVs or hosted services into the current scope.

## Code audit and sequence

| Stage | Reuse | Implemented extension / boundary | Modules |
| --- | --- | --- | --- |
| Safe edits | Candidate preview, transactions, checkpoints, receipts, revision guards | Explicit allowed node/vertex scope in addition to protected parts | `workflow.js`, `inspection.js`, Agent schema |
| Observation | Fixed-camera views, studio settings, diagnostics, isolated GLB roundtrip | Saved reference versions/decisions, named views, comparisons and declared contact/thickness checks; continuous collision and global minimum thickness are not certified | `viewport.js`, `design-references.js`, `view-presets.js`, `inspection.js`, `relation-checks.js` |
| Surface attachment | Polygon triangulation, connectivity tokens, affine transforms, document evaluator | Persistent material-point binding, ordered updates and explicit invalidation | `attachments.js`, `document.js` |
| Beak surface | Loft, sweep, bridge, solidify | Ordered boundary/section surfaces, explicit correspondence, tangent constraints and capped sections | `boundary-surface.js`, mesh dispatcher, recipes |
| Shape controls | Proportional edits and deformers | Persistent local radial handles, mirrored displacement and recipe parameters; not a volume-preserving cage solver | `deform.js` (`controlDeform`), recipes |
| Expressions | Runtime morph schema and playback | Targets, controls, clips, runtime playback and basic inspector controls implemented | `morphs.js`, `character.js`, `character-panel.js`, document, viewport, importer |
| Motion | Runtime skeleton, skin and clips | Joints, rest edits, rigid binding, numeric weights, keys and inspector playback implemented; brush weight painting remains outside the basic chain | `skin.js`, `joint-rest.js`, `joint-panel.js`, `skin-panel.js`, `character-panel.js`, document, viewport, export |

The earlier [iteration workflow](workshop-iteration.md) is reused, not
replaced. GLB import now preserves morph targets, skin authoring data and supported
TRS/morph animation tracks (`import-glb.js`); unsupported curves fail explicitly.
Bounding-box anchors, sockets and one-shot `fit` are not persistent bindings.

## Closed modification scope

```js
const proposal = await ws.candidate({
  commands: [{op:"transform", id:"head", scale:[1.1,1,1]}],
  allowed: {
    nodes:["head"],
    followers:["eye_left","eye_right","eye_highlight_left","eye_highlight_right"]
  },
  protectedIds:["body","foot_left","foot_right"]
});
if (proposal.ok) await ws.accept(proposal, {operationId:"head-wide-1"});
```

`allowed` is optional for compatibility. If present, unlisted changed nodes
(including descendants moved in world space) fail scope checking. `followers`
is an explicit additional grant, not an automatic attachment discovery rule.
Top-level changes require `projectFields`, for example `["materials"]`; a material
edit must also grant every affected user. Protected parts take precedence.

`allowed.vertices: {head:[0,1,2]}` permits only those local coordinates to
change; topology, face materials, recipe, parent and transforms must stay
unchanged. It is a mesh-level grant, not a recipe-parameter grant. The result
includes `scopeIssues` with actual violating nodes, fields or vertex indices.
`allowed.parameters: {upper_bill:["extraThickness"]}` grants only named editable
recipe values. The checker re-evaluates those values from the baseline and
compares the complete resulting node, so edits to the recipe definition,
unlisted values, metadata, topology overrides or transforms cannot hide behind
a parameter grant. Dependent followers still need explicit grants.
`scope.parameterChanges` records old/new values.

`protectedVertices: {upper_bill:[0,6,12]}` is a top-level candidate option.
Those material-point indices must retain their world-space coordinates and
source connectivity, even when the whole node or a parameter is otherwise
granted. It can protect a crown/cheek region while another region changes.
These guards are exact, not approximate silhouette constraints.

```js
const candidate = await ws.candidate({
  commands:[{op:"recipeParameters",id:"upper_bill",values:{extraThickness:0.025}}],
  allowed:{parameters:{upper_bill:["extraThickness"]}},
  protectedVertices:{upper_bill:[0,6,12,26,32,38,52,58,64]}
});
if (candidate.ok) await ws.accept(candidate);
```

`allowed.assemblyParameters: {asset_root:["width"]}` grants named editable
assembly values (including linked-instance value overrides).
`allowed.characterValues: ["mouthOpen"]` grants only the named existing control
values, using `characterValues` semantics: applying values exits an active clip
pose. The checker re-evaluates the baseline with these values and requires the
entire assembly/character definition to match. It rejects changes to bindings,
rest poses, clips, other controls and parameter definitions. These grants do not
require broad `projectFields:["character","assemblies"]` access.

Driven nodes still require explicit `followers`/`nodes` grants. When value grants
are present, follower outputs must exactly match baseline re-evaluation, even if
their approved value did not change; a follower grant cannot hide a separate
rename or geometry edit. Protected nodes/vertices retain precedence. Combined
recipe, assembly and character grants are evaluated together. Returned
`parameterChanges` entries use `node` for recipe parameters, `root` for assembly
parameters, and `control` for character values.

```js
const opening = await ws.candidate({
  commands: [{op:"characterValues",values:{mouthOpen:0.5}}],
  allowed: {characterValues:["mouthOpen"],
    followers:["jaw_joint","lower_bill","mouth_cavity","tongue"]},
  protectedIds:["head","eye_left","eye_right"]
});
if (opening.ok) await ws.accept(opening);
```

`duck-control-scope.mjs` checks this mouth opening, rejects an accompanying tongue
metadata edit, compares three saved views and verifies editable export/reload.
`duck-parameter-scope.mjs` demonstrates a 20→25mm underside parameter change,
preserving nine upper-bill vertices, rejecting an accompanying name edit and
checking three views plus editable roundtrip.

## Surface attachments v1

```js
await ws.apply([
  {op:"attachSurface", id:"eye_right", targetId:"head",
   at:[0.2,1.5,0.4], anchor:[0,0,-0.02], offset:-0.002, mode:"frame"},
  {op:"attachSurface", id:"eye_highlight_right", targetId:"eye_right",
   anchor:[0,0,-0.005], offset:0, mode:"position"}
]);
const binding = (await ws.inspect({id:"eye_right"})).node.attachment;
await ws.apply([{op:"detachSurface", id:"eye_right"}]);
```

Use actual model coordinates. `at` is the world-space bind query in metres;
omitting it uses the current world position of `anchor`, which is in the
follower's local space. The closest triangle is selected **once**, then its
face ID, ordered vertex indices, connectivity token and barycentric weights
are saved. Offset is in world metres along the oriented triangle normal;
negative values intentionally embed the anchor.

`position` drives translation and retains the part's local orientation.
`frame` follows the triangle frame while retaining the part's initial
orientation relative to it. Frame X follows the triangle's first edge, Z
is its normal, Y is Z cross X. Neither mode warps follower geometry. Multiple
bindings update in parent/target dependency order, including highlight → eye
→ head chains.

`deform` uses the same stable material triangle as a local affine patch.
Its first and second edges retain their lengths and angle, so in-plane stretch
and shear deform the follower; normal distance remains in world metres.
The selected `at` (or world position of `anchor`) chooses the patch. Unlike
position mode, binding preserves the follower's existing vertices, with
`offset` added along the normal. It does not snap the local origin to the hit.
The mode stores patch coordinates for each follower vertex plus source
connectivity in attachment version 2. It bakes a primitive generator and
requires an independent polygon mesh without its own recipe, morph or skin.
Detach before editing the follower's geometry; detaching retains its evaluated
shape. Chained position/frame followers can attach to its resulting surface.
One affine patch does not conform a large mesh to arbitrary curvature.

```js
await ws.apply([{ op: "attachSurface", id: "decoration", targetId: "head",
  mode: "deform", at: [0, 1, 0], offset: 0 }]);
```

Animation export bakes changed local follower geometry to named runtime morph
targets, deduplicated across clips at a 1e-9-metre key resolution. It shares the
clip fps/key sampling and linearly blends between sampled shapes. Each follower
is limited to 128 baked shapes and one million render vertices across shapes;
over-budget exports fail with an explicit suggestion to reduce sampling.
Normals and bounds are updated with the targets. The report's
`animations[].deformationShapes` records generated target counts. Runtime
files contain baked geometry/animation; editable files retain the live binding.
`duck-deform-followers.mjs` applies this to three crown feathers, changes head
parameters, and adds a head-surface animation. The runtime probe's `DUCK_DEFORM=1`
includes that clip and checks actual follower world vertices.

Binding data lives on `node.attachment` in editable projects, versioned
independently as `version:1` (position/frame), `version:2` (deform), or
`version:3` (a mirrored relationship with any of those modes).
`inspect`/`getProject` expose it; candidate scope
reports the resulting follower changes. Apply/preview/undo/project-save use
the same evaluator. Standard GLB bakes the resulting transforms; the editable
`.funmodel.glb` retains bindings. Old workshop versions do not know this field:
do not resave attached projects through an older workshop.

Topology changes, missing targets, dependency cycles and collapsed binding
triangles reject atomically. Rebind explicitly with `attachSurface`, or detach
before topology edits and then bind again. Independent polygon mesh/group
followers and independent polygon targets are supported. Recipe geometry can
be placed under an attached group. Dense/instance/symmetry targets, recipe
followers and a deform follower's own morph/skin drivers are not supported.
Frame mode requires a shear-free decomposable transform; deform mode works
through its saved affine patch coordinates. Derived ancestor frames are also rejected.
Renaming and adding an editable project remap attachment targets. Duplicate
the complete target/follower hierarchy to retain its relationships; duplicating
a follower without its target is rejected with an explicit detach instruction.

### Mirrored material-point bindings

```js
await ws.apply([{ op: "mirrorSurface", id: "eye_left", sourceId: "eye_right",
  axis: "x", plane: 0, tolerance: .00001 }]);
const mirror = (await ws.inspect({ id: "eye_left" })).node.attachment.mirror;
```

The source must already be attached. The command reflects its material point
across `axis = plane` in the **target mesh's local space**, measured in metres,
and binds the destination to that same target. `tolerance` is the maximum
initial distance from the reflected point to the target surface; it must be
positive. A miss fails atomically with the requested/nearest points, actual
distance and threshold. This constructs the opposite binding, not the opposite
mesh or expression. The destination retains its geometry/orientation, existing
local anchor (or `[0,0,0]`), and may explicitly choose `anchor` and `mode`.

Both sides subsequently follow their own saved triangles, including when the
target becomes asymmetric; updates never silently project to another triangle.
The normal offset follows the source. The saved `mirror.source`, source binding
signature, plane, tolerance and initial residual are queryable and editable-source
persistent. Renames, complete hierarchy duplication and editable imports remap
the source dependency. Parent/attachment/mirror cycles reject before geometry
lookup. Changing or deleting the source binding rejects unless the mirrored
follower is first detached; to rebind, put `detachSurface` on the follower,
the source change, and `mirrorSurface` in one atomic apply. Target topology
changes still require explicit rebinding of both sides.

`scripts/examples/duck-mirror-followers.mjs` mirrors the left eye from the right,
adjusts head/forehead width, compares four saved views and checks editable export
roundtrip. Highlights keep their own bindings to their respective eyes. Mirroring
between different target meshes is not supported by this command.

Binding to one material point does not prove that an entire eye shell fits
a reshaped curved head. Check actual renders and declared contact samples.

## Reproducible duck check

```sh
DUCK_PROJECT=/absolute/path/to/duck.project.json \
  node scripts/editor-agent.mjs --run scripts/examples/duck-attachments.mjs
```

The input is the actual v8 study document (or a candidate report with a
`project` field). The script creates an isolated session, binds both eyes,
both highlights and a rigid mouth assembly, widens the head and flattens the
forehead, renders front/side/back/top/oblique comparisons, measures every
binding anchor and verifies editable export/reload without touching the input.
Outputs are under `test-results/duck-attachments/`.

This is attachment acceptance, not expression or walking acceptance.

The 2026-10-20 local run produced five bindings with zero measured anchor
error (double-precision world coordinates), no editable roundtrip changes,
and no geometry validation errors or warnings. Actual front, side and oblique
renders were inspected. The browser WebGL software path reopened all five
bindings and passed editable roundtrip with no console errors. Desktop
1440×900 and phone 390×844 screenshots were inspected; the workshop retains
its documented desktop-only minimum width, so the phone view is cropped.
No hardware GPU or animated `.fun3d` acceptance is claimed by this run.

## Boundary surfaces

`create` and recipe generators accept `kind:"boundarySurface"`:

```js
await ws.apply([{op:"create", id:"lip", kind:"boundarySurface", options:{
  curves:[
    [[-0.4,0,0],[0,0.08,0],[0.4,0,0]],
    [[-0.4,0,0.2],[0,0.1,0.4],[0.4,0,0.2]]
  ], samples:3, spans:3, bulge:0.02, bulgeDirection:[0,1,0]
}}]);
```

Curves are ordered local-space metre points. The first and last curves are
boundaries; additional rows are interpolated sections. Corresponding curve
directions are explicit: the generator never reverses a curve automatically.
`sampling:"index"` uses normalized point index, while `"arc"` uses normalized
polyline distance. `samples` (2–256) controls columns; `spans` (1–32) controls
subdivisions between each pair of section rows. The default index sampling with
equal row lengths preserves authored sample correspondence.

Optional `tangents` has one vector per row and sampled column, in local metres
per section interval. Cubic Hermite interpolation shares these derivatives
across adjacent strips. `bulge` displaces intermediate rows along the normalized
`bulgeDirection`, with zero position and derivative at supplied sections. Exact
coincident points are shared; fixed-diagonal triangles give predictable topology.
`flip` reverses orientation. This is a polygon approximation of the constrained
surface, not a claim that a coarse rendered triangle mesh is smoothly tangent.

`closedSections:true` connects the last section to the first; `caps:true` then
closes both ends with centroid fans. This supports explicit outer/inner lip
sections. For an open surface use a recipe `solidify` step to add a thickness
parameter and closed rim. Invalid/degenerate correspondence fails, and the
ordinary document diagnostics still check the resulting geometry.

The v8 duck example re-expresses both existing bills as section curves, retains
the warm inner-mouth materials, and exposes `extraThickness`. Its influence
tapers to zero at the corners, leaving their positions fixed:

```sh
node scripts/editor-agent.mjs --run scripts/examples/duck-boundaries.mjs
```

It reads the attachment example's candidate by default; `DUCK_PROJECT` may
point to that same v8-based document. Outputs include original/reconstruction
and baseline/thicker comparisons, editable project, GLB and roundtrip reports
under `test-results/duck-boundaries/`. The 20 mm underside adjustment passed
geometry checks and editable roundtrip; front, side and oblique renders were
inspected. This parameter is a section displacement, not a measured minimum
wall thickness. Mouth opening remains a separate expression/pose control.

## Shape Keys / Morph Targets

```js
await ws.apply([
  {op:"morphTarget", id:"eye", name:"blink",
   changes:[{index:0,position:[0.1,0.02,0.03]}]},
  {op:"morphWeights", id:"eye", values:{blink:0.5}}
]);
```

Target positions are absolute local metres relative to the base mesh. Unlisted
vertices have zero delta. Reusing a name replaces that complete target;
`morphRemove` deletes it. `morphMirror` takes `name`, `newName` and `axis`
and requires unique symmetric base correspondence about local zero. Author
independent one-sided targets to mix asymmetric expressions.

`morphEdit` patches an **existing** target using the same absolute local-metre
`changes` array; unlisted vertices retain their previous deltas. It preserves
the base, other targets and weights. Repeating the same absolute patch is
idempotent. Normal transaction validation, topology correspondence, candidates,
scope protection and undo apply:

```js
await ws.apply([{op:"morphEdit",id:"eye",name:"blink",
  changes:[{index:0,position:[0.1,0.025,0.03]}]}]);
```

The **Character & motion → Morph target editing** section exposes blank/copy
creation and selected-vertex refinement. Select vertices in the existing vertex
selection mode, or explicitly enable **Edit whole target**. Translation is in
mesh-local metres; scale is dimensionless about the selected target positions'
centroid. **Preview edit** isolates the selected target at weight 1, zeroes
character controls and pauses clips in a temporary viewport state. It does not
change stored weights, rest poses, history or controller definitions. **Save
target edit** patches coordinates through `morphEdit`, then returns to the
stored model. Escape, selection changes and collapsing the panel restore it.
Editing is numerical translation/scale, not target brush painting or a separate
gizmo mode. Previewing a single target does not certify combination contacts.

`scripts/examples/duck-morph-panel.mjs` copies the duck's smile target, moves one
vertex by 5 mm, checks unaffected data, undo/redo and exact editable reload,
and captures desktop/1024px views.

`node.morph` stores version 1, connectivity token, base vertices, named deltas
and 0–1 weights. `inspect` summarizes names, weights and changed counts;
`getProject` exposes all data. Preview, candidates, undo and project files use
the same evaluator. Every evaluation starts from the base; repeated reloads
do not accumulate displacement. Geometry commands edit the **base**, preserving
deltas when topology stays identical; recipe parameters therefore remain usable.
Topology changes fail atomically until targets are explicitly removed. Dense
meshes, linked-copy sources and assembly-driven nodes are not yet supported.

The viewport displays the evaluated blend. GLB export preserves target names,
weights and per-corner correspondence; morph meshes cannot be statically merged.
Editable roundtrip retains the full source. Generic GLB import preserves morph
vertices without position-only welding or polygonization, so its vertex count
can be higher. Target normals are regenerated by the workshop's shading policy.
Morph imports that need reduction or nonpositive/sheared transform baking fail
explicitly. No silent loss of targets is allowed by those paths.

The `.fun3d` library converter previously routed unskinned morph meshes through
its static merger, which dropped targets. It now preserves those primitives,
as it already did for skinned characters. Material splits can produce more
runtime target entries than authoring targets: the duck's 30 authored targets
become 39 entries on material-split geometries. They retain their names.

`validate` checks the currently mixed geometry, not every possible target
combination; `checks.allMorphTargets` and `checks.allMorphCombinations` are false.
Preview every target at its extremes and the combinations intended for delivery.
The duck script creates blink/smile/surprise plus a mixed preview:

```sh
node scripts/editor-agent.mjs --run scripts/examples/duck-morphs.mjs
node scripts/fun3d.mjs convert test-results/duck-morphs/duck.glb \
  --type character --name duck-morphs -o test-results/duck-morphs/duck.fun3d
```

Outputs are in `test-results/duck-morphs/`. This verifies target authoring and
data preservation. Coordinated controls must also bake attachment-driven
transforms into runtime clips before claiming expression playback parity.

`node scripts/examples/duck-runtime-morphs.mjs` loads the actual `.fun3d` in
the browser runtime and renders neutral, blink, smile, surprise and a mixed
pose. The local WebGL software run retained 39 targets, passed format validation
and produced five actual runtime images with no console errors. The closed-eye
authoring target suppresses highlights to avoid a bright strip on the squashed
eye. Runtime pose rendering proves that weights are applied, not yet that all
attachment/controller motion matches authoring.

## Persisted expression controls and clips

```js
await ws.apply([
  {op:"characterControl", id:"blink", bindings:[
    {node:"eye", channel:"morph", target:"blink", gain:1}
  ]},
  {op:"characterValues", values:{blink:0.5}},
  {op:"characterClip", name:"blink_once", duration:1, fps:30, loop:false,
   tracks:[{control:"blink", channel:"control", keys:[
     {time:0,value:0}, {time:0.5,value:1}, {time:1,value:0}
   ]}]},
  {op:"characterPose", name:"blink_once", time:0.5}
]);
```

`project.character` version 1 stores controls, current values, rest transforms
and weights, clips and the preview playhead. `getProject` exposes these records.
`characterPose` without a name clears the clip preview. `characterValues`
updates continuous 0–1 controls and clears the playhead. Commands use the existing
atomic apply, candidate, version check, undo and editable-project serialization.
`characterRemove {kind:"control"|"clip",id}` removes a record; unresolved references
fail atomically. Node renaming remaps control, clip and rest references. Deleting
driven nodes fails until dependencies are removed. Merging editable projects
remaps nodes, joints, controls and clips on name collisions; clear active clip
previews first. Duplicating only a driven hierarchy is rejected because it would
otherwise lose its global controls.

Bindings add `delta:[x,y,z]` to local position (metres), rotation (XYZ Euler
degrees), or scale (dimensionless). Morph bindings add `gain * controlValue` to
the rest weight, clamped to 0–1. Multiple controls add in stored order.
An optional binding `attenuateBy:"otherControl"` multiplies its influence by
`1 - otherControlValue`. Both values come from current controls plus sampled
clip inputs, so attenuation references are order-independent and do not recurse.
This applies to transform and morph bindings. Removing a referenced control
fails; merging projects remaps attenuation references. Authoring this field
upgrades `project.character` to version 2; version 1 remains readable.
Older clients reject version 2 rather than silently dropping the relationship.
Runtime clips bake the resulting influence, with no new runtime extension.

For example, a mouth-lining smile binding can be
`{node:"mouth_cavity",channel:"morph",target:"smile",gain:1,
attenuateBy:"mouthClose"}`. The eye's smile binding remains unattenuated.
`scripts/examples/duck-mouth-close.mjs` retains a closed-mouth morph, projected
from the current upper-bill boundary, plus affine retraction targets for the
inner parts. Its `mouthClose` control is distinct from the additional 15-degree
`mouthOpen` rotation. It checks 45 open/close/expression combinations and saves
three matching views. This is a stylized corrective shape, not a tissue or
volume-preserving simulation, and internal whole-surface clearance is not
certified by those samples.

Direct node tracks use `node`, `channel`, optional morph `target`, and keys with
absolute local values; they override control bindings. Interpolation is `linear`,
`step`, or `slerp` for rotation only. Slerp uses shortest-arc quaternion rotation
between keys expressed as XYZ Euler degrees, and upgrades character data to version
3. Versions 1/2 retain their existing linear Euler semantics; older readers reject
version 3 instead of misinterpreting its rotation curves. Times are seconds. Loop preview wraps times beyond duration; the exact
duration samples the last key. Scale must remain positive. Attachment-driven
channels cannot also be driven directly: position for position/frame bindings,
rotation and scale for frame bindings, and every channel for deform bindings.
Position bindings retain independent rotation/scale authoring. Animate their target
or a child pivot. Rest state prevents repeated evaluation from accumulating poses.

Runtime GLB clips bake the evaluated transforms and morph weights, including
surface followers, at the clip fps plus authored key times. Changing a clip also
resets constant channels. Exact source steps are approximated within 10 microseconds
in the linear export bake. Export reports this tolerance and rejects more than
200,000 node samples. Animated hierarchies cannot be statically merged. Loop intent
is stored in clip extras and retained by `.fun3d`; playback clients select the
appropriate AnimationMixer loop mode. Editable project reload preserves controls
and authored tracks. Ordinary GLB import restores LINEAR/STEP TRS and morph tracks;
glTF LINEAR rotations become `slerp`, retaining their spherical interpolation.
Morph weight vectors expand into named target tracks. Clip names are made unique,
`extras.loop`/`extras.bakeFps` are retained where present, and unspecified looping
defaults to play once. Node transforms and morph weights become the editable rest
state. The key editor displays spherical rotation and preserves it when editing.
CUBICSPLINE, unsupported target paths, negative scale, weights outside 0–1,
missing scene targets or budget overflow fail explicitly without partial import.
This import retains baked runtime motion; it cannot reconstruct recipes or
semantic control bindings from the exported samples.

```js
await ws.apply([{op:"characterClip", name:"turn", duration:1, loop:false, tracks:[
  {node:"head_joint", channel:"rotation", interpolation:"slerp", keys:[
    {time:0, value:[0,170,0]}, {time:1, value:[0,-170,0]}
  ]}
]}]); // turns through 180 degrees, rather than through zero
```

The runtime converter now preserves unskinned animated hierarchies, splits
multi-target weight tracks, and binds unskinned morph tracks to the actual mesh
inside its runtime wrapper. These fix observed playback failures, not just schema
gaps.

```sh
node scripts/editor-agent.mjs --run scripts/examples/duck-character.mjs
node scripts/fun3d.mjs convert test-results/duck-character/duck.glb \
  --type character --name duck-character -o test-results/duck-character/duck.fun3d
npm run build:production
node scripts/examples/duck-runtime-character.mjs
```

The duck has three persistent controls and four clips (blink, smile, surprise,
combination). Editable roundtrip passed. Five actual browser runtime renders
were inspected/recorded; all 25 node transforms matched authoring at neutral and
the four clip peaks within 1e-4. These samples do not certify continuous contact,
minimum thickness, every intermediate pose, or arbitrary expression combinations.
The following sections add joints, skin weights, walking clips and basic human
playback/key controls.

## Rigid joints and action authoring

```js
await ws.apply([
  {op:"create", kind:"group", id:"hip", position:[0,1,0]},
  {op:"joint", id:"hip"},
  {op:"set", id:"foot", parent:"hip", keepWorld:true},
  {op:"characterClip", name:"step", duration:1, loop:true, tracks:[
    {node:"hip", channel:"rotation", keys:[
      {time:0,value:[-15,0,0]}, {time:0.5,value:[15,0,0]}, {time:1,value:[-15,0,0]}
    ]}
  ]}
]);
```

`joint` marks an independent empty group and captures its current local
position/rotation/scale as `node.joint.rest` (version 1). Calling it again
recaptures rest; `enabled:false` removes the marker. Joint parenting uses the
existing cycle-checked hierarchy. Reparent rigid parts with `set` and
`keepWorld:true`. Preview/export creates a Three.js Bone; runtime rigid motion
uses the preserved hierarchy. Rigid-only parts need hierarchy and clips;
weighted skins additionally use the bind data described below. Joint metadata
persists in editable source and GLB extras.

Use `jointRest` to reposition the authored joint frame while preserving immediate
children's world frames and rebuilding skins which reference that joint:

```js
const result = await ws.apply([{op:"jointRest",id:"hip",
  position:[0,1.02,0],rotation:[0,0,0],scale:[1,1,1]}]);
```

Position is in parent-local metres, rotation is XYZ degrees, and scale is a
positive dimensionless vector. Omitted fields keep their authored values.
The operation runs against unposed character/morph/skin bases; it does not bake
the currently displayed expression or animation. Child local transforms are
compensated, joint rest metadata is refreshed, and affected meshes retain weights
while acquiring new bind matrices. Existing morph deltas and animation keys are
not retargeted. The result lists `preservedChildWorldFrames`, `reboundSkins` and
`unchangedTracks`; inspect those absolute tracks after changing the rest frame.
Controllers continue to apply relative to the updated character rest.

Surface/linked/assembly-driven joints or immediate children are rejected.
A child compensation that requires shear also fails atomically; no geometry
is silently baked. This is a rest-frame edit, not IK or animation retargeting.
Preview, candidate scope, undo and source persistence use the normal transaction.

**Character & motion → Joints & rest pose** creates a marked group at a chosen
parent's origin, or marks the selected group as a joint. Select an existing joint
to preview/save local rest position, rotation and scale through `jointRest`.
The panel lists skins that will be rebound and warns that absolute keyframes
remain unchanged. Use manual controls without active expressions when judging
the neutral base. `duck-joint-panel.mjs` moves a shoulder pivot by 20 mm, verifies
unchanged neutral world geometry and weights, creates a child joint, and checks
undo/redo and exact editable reload.

`duck-actions.mjs` adds six joint markers, rigid head/wing/leg attachment and
stand/walk/run/jump clips alongside the four expression clips. Action tracks also
drive smile and blink controls. The initial leg swing lowered feet below the
authored support plane; the example now samples root-height corrections and
checks between those keys within a 2mm tolerance. This is explicit sampled
contact correction, not IK or a continuous contact guarantee.

```sh
node scripts/editor-agent.mjs --run scripts/examples/duck-actions.mjs
node scripts/fun3d.mjs convert test-results/duck-actions/duck.glb \
  --type character --name duck-actions -o test-results/duck-actions/duck.fun3d
DUCK_ACTIONS=1 node scripts/examples/duck-runtime-character.mjs
```

Artifacts include editable/runtime GLBs, four three-view comparisons, source
snapshots, roundtrip results, sampled contact measurements and actual runtime
pose renders. The local duck run passed editable roundtrip and four actual
runtime poses with all 29 node transforms and 39 morph entries matching authoring
within 1e-4, without browser console errors. At 96 between-key samples per action,
the largest support-plane penetration was 0.077mm (2mm acceptance tolerance).
These are sampled results, not a continuous collision proof.
Weighted deformation and basic human playback/key controls are covered below.
Automatic foot locking and continuous collision checks remain incomplete.

## Skin weights

```js
const wing = (await ws.call("getProject")).nodes.find(n => n.id === "wing");
await ws.apply([
  {op:"skinBind", id:"wing", joints:["shoulder","tip"],
   weights:wing.mesh.vertices.map((_,index) => ({
     index, influences:[{joint:"shoulder",weight:0.75},{joint:"tip",weight:0.25}]
   }))},
  {op:"skinWeights", id:"wing", weights:[
    {index:0, influences:[{joint:"shoulder",weight:0.5},{joint:"tip",weight:0.5}]}
  ]}
]);
```

`skinBind` captures the current unposed base mesh, mesh world bind matrix and
each joint's inverse world bind matrix. Joints must be marked empty groups.
`node.skin` version 1 stores those matrices, joint ids, connectivity, base
positions and weights. Matrices are column-major; positions are local metres.
Each editable vertex has 1–4 unique positive influences whose weights sum to 1.
Partial `skinWeights` updates retain other vertices. Invalid weights, missing
joints or changed topology reject the candidate/transaction. `skinUnbind`
explicitly removes the binding and returns to the unposed base.

The **Character & motion → Joint binding & weights** section uses these same
commands. Choose binding joints in the multiple-selection list. For an unbound
mesh, enter up to four initial influences and **Bind whole mesh**; this initializes
every vertex. For an existing skin, select vertices in Vertex mode, edit the four
influence rows and **Save selected weights**. Rows initially show the first
selected vertex (vertex 0 when none is selected); saving replaces the influence
list on all selected vertices. **Edit weights on all vertices** is an explicit
whole-mesh option. Zero rows are omitted, positive weights must sum to 1, and
**Normalize weights** divides the entered values by their sum.

**Preview weights** evaluates the current pose in the viewport without changing
history or stored weights. Stop/restore, Escape, selection changes and collapsing
the panel discard preview. **Rebuild bind matrices** captures the unposed binding
again and preserves existing per-vertex weights; include their referenced joints
in the binding list or the operation fails atomically. Changing a joint list does
not silently redistribute weights. Binding, removal and weight edits support undo
and editable export/reload. This is numeric weight editing, not weight painting,
automatic weights; joint rest-pose authoring has its separate panel above.

`scripts/examples/duck-skin-panel.mjs` edits two wing vertices while preserving
the others, adds a rigid skin to the left foot, checks unbinding/undo and exact
editable reload, and records actual desktop/minimum-width screenshots.

Evaluation order is controls → morph blend → linear blend skinning → surface
followers. Repeated evaluation/reload starts from the saved base. Topology-
preserving edits change that base and retain weights; topology changes fail.
Recipes can generate the base. A mesh and all its joints may share the same
nearest surface-attached ancestor: its common transform cancels in local
skinning, and the whole rig follows that frame. Different attached branches,
directly attached mesh transforms, dense meshes and linked/symmetry sources
are currently rejected with an explicit dependency error. Renaming joints
remaps bindings; deleting/removing a required joint fails. Full unanimated rig
copies remap their joints, while partial or linked skin copies fail explicitly.
Editable project merging preserves skin and character dependencies.

`scripts/examples/duck-jaw.mjs` uses this shared-frame composition for a
two-joint mouth rig under `mouth_mount`. Lower bill and tongue follow the jaw;
the oral lining blends fixed-roof and jaw weights. The `mouthOpen` character
control rotates the jaw from 0 to 15 degrees about the authored corner axis.
The reference is already open, so zero is **not a closed mouth**. Existing
morph controls combine before skinning; clips `mouth_open`, `mouth_expression`
and an edited `walk` persist the coordinated control.

```js
await ws.apply([{ op: "characterValues", values: { mouthOpen: .5, smile: .4 } }]);
```

Run the example through `editor-agent.mjs --run`, convert its exported
`test-results/duck-jaw/duck.funmodel.glb` with `scripts/fun3d.mjs`, then run
`DUCK_SKIN=1 DUCK_MOUTH=1 DUCK_RUNTIME_DIR=test-results/duck-jaw node
scripts/examples/duck-runtime-character.mjs` for actual runtime skin, transform
and morph comparisons. Mouth-corner samples and rendered views are not proof
of whole-mouth containment or continuous collision clearance.

Rendering uses the evaluated editable geometry. Runtime export writes actual
joint hierarchies, inverse binds, per-corner weight attributes and GLB skins;
the `.fun3d` converter preserves them as skeletons. Material/normal splits
duplicate weight attributes with their source vertices. Morphs are applied
before skinning in both authoring and runtime. Animated and skinned parts cannot
be statically merged. Generic GLB import preserves supported skin authoring data;
use `.funmodel.glb` to retain recipes, attachments, controls and editable clips.

Ordinary GLB import preserves the selected scene's joint hierarchy, per-vertex
joint palette weights and supplied inverse bind matrices. It uses an identity
mesh bind matrix because glTF inverse binds already include the bind transform.
Missing inverse binds use identity matrices as specified by glTF. Duplicate
positions at material/normal seams are retained, with the matching weights;
increased editable vertex counts do not mean additional surface geometry.
The imported `node.skin` and `node.joint` use the same version 1 structures and
`skinWeights`, `jointRest`, undo and source export paths as newly authored rigs.

```js
// Existing Agent API; import into an isolated candidate before accepting it.
const imported = importModel(glbBytes); // site/workshop/import-glb.js
const candidate = await ws.candidate({project: imported.project});
if (!candidate.ok) throw new Error(JSON.stringify(candidate.error));
await ws.accept(candidate);
await ws.exportProject({file: "continued.funmodel.glb"});
```

Inspect `warnings` and `processing` before accepting an ordinary import.
`processing` reports preserved joint ids, inverse-bind provenance and disabled
vertex welding. Animation processing reports original clip indices, editable
names, expanded track counts and loop provenance; empty clips produce a warning.
Imports reject more than four influences, invalid or non-unit weight sums,
missing joint nodes, joint nodes carrying geometry, lossy mesh reduction,
nonpositive/sheared rig transforms and editable geometry budget overflow.
No weights are silently truncated or auto-generated. The current per-mesh
deforming geometry budget is 16,384 vertices and faces; global editable limits
also apply. This does not restore source recipes or attachment relationships
from an ordinary runtime GLB.

Run `node scripts/examples/duck-skin-import.mjs` after a production build and
the joint-panel example. It imports the actual duck's ordinary GLB into an
isolated browser session, compares all six skins before and after a joint edit,
samples all imported clips against source geometry, renders
front/side/three-quarter views with identical saved cameras, and exports
and reloads the resulting editable source. Artifacts are written to
`test-results/duck-skin-import/`; this separate import exercise does not replace
the canonical source that retains attachments, recipes and action clips.
`duck-animation-import-edit.mjs` then edits a spherical rotation key in the
human inspector, checks undo/redo and exact source reload, and writes a separate
`test-results/duck-animation-import/` project for runtime conversion and playback.
`duck-animation-import-parity.mjs` compares the imported geometry against the
same GLB played by Three.js, independently of the original author's runtime
bake. All 13 sampled clips had less than 0.00055 mm import error; the larger
original-author-versus-baked-import difference (up to 0.392 mm) is reported
separately. Static meshes use surface distance because polygonization can remove
coplanar internal vertices; deforming meshes retain vertex correspondence.

```sh
node scripts/examples/duck-skin-import.mjs
node scripts/examples/duck-animation-import-parity.mjs
node scripts/examples/duck-animation-import-edit.mjs
node scripts/fun3d.mjs convert test-results/duck-animation-import/duck.funmodel.glb \
  --type character --name duck-animation-import -o test-results/duck-animation-import/duck.fun3d
DUCK_SKIN=1 DUCK_MOUTH=1 DUCK_CLOSE=1 DUCK_DEFORM=1 \
  DUCK_RUNTIME_DIR=test-results/duck-animation-import \
  node scripts/examples/duck-runtime-character.mjs
```

The edited imported character passed nine actual runtime poses with 62 morph
entries and six skins; maximum measured skin error was below 0.247 mm and no
browser errors were recorded. This is sampled runtime acceptance, not continuous
collision clearance. Re-export de-duplicates times at glTF float32 precision
while retaining original geometry sampling times. Plain rigs sample transforms
and weights directly; geometry-dependent authoring still uses the full evaluator.

`duck-skin.mjs` adds two wing-tip joints and blends shoulder/tip weights on the
existing wing meshes, preserving rigid head/leg motion and all expression/action
clips. Reproduce with:

```sh
node scripts/editor-agent.mjs --run scripts/examples/duck-skin.mjs
node scripts/fun3d.mjs convert test-results/duck-skin/duck.glb \
  --type character --name duck-skin -o test-results/duck-skin/duck.fun3d
npm run build:production
DUCK_SKIN=1 node scripts/examples/duck-runtime-character.mjs
```

The runtime probe compares actual skinned vertices in world space to the
authoring result, in addition to node transforms and morph weights. This does
not validate all possible poses, weights or inter-part collisions. Automatic
weights, transfer, IK and weight-paint UI are not implemented by this slice.

The local duck acceptance retained two skins and eight joint markers through
editable save/reload, exported actual runtime skeletons, and rendered four
action poses without console errors. The maximum measured runtime-to-authoring
wing vertex error was 0.247mm, below the 1mm runtime compression tolerance.
Controls, clip poses and per-node transforms were checked separately.

## Persistent sampled design relations

```js
await ws.apply([{op:"relation", definition:{
  id:"eye_contact", kind:"signedGap", source:"eye", target:"head",
  vertices:[0,1,2], min:-0.02, max:0.005
}}]);
const result = await ws.relations({maxTests:2000000});
```

Define the tolerated interval deliberately in world metres. `distance` measures
the nearest target surface. `signedGap` uses that nearest triangle's outward
normal, allowing a negative interval for intentional overlap. It is a local
orientation measurement, **not** a containment or global penetration test.
`thickness` casts a ray from each vertex along the required world-space
`direction`, skips the originating surface within a reported numerical tolerance,
and measures the first subsequent hit. Use it for selected wall sections;
it does not prove global minimum thickness or even that the whole ray lies inside
a solid. Missed rays fail, rather than reporting zero thickness or success.

`inside` measures sampled clearance inside a closed, consistently oriented
polygon shell: positive inside, negative outside. Three independent ray
directions must agree; disagreement is `not_checked`. Open/nonmanifold targets
are also `not_checked`. The declared min/max interval constrains clearance.
This checks only selected vertices, not every edge, face or swept volume.
The target must actually represent the intended containing volume; a visual
mouth lining is not automatically an oral envelope.

`project.relations` stores version 1 records and the source connectivity token.
Samples follow stable source vertex indices through morphs and skinning.
Changing that topology requires explicit redefinition; deleting referenced
parts fails. Rename and editable import merge remap source/target ids.
`removeRelation {id}` explicitly removes a relation.

`workflow {action:"relations",query:{maxTests}}` returns per-relation and
per-sample measurements, source vertex, world point, target face/triangle,
normal, thresholds and `passed`, `failed`, `not_checked` or `incomplete`.
Triangle-test exhaustion is incomplete and retryable. Coverage separately
reports that whole-surface contact, containment, inter-object intersection,
global minimum thickness and continuous animation were not checked.

Candidate preparation gates acceptance on every declared relation passing.
`diagnose` includes failing vertices in its location renders. Direct authoring
commands may persist a failing relation so it can be inspected and repaired;
the relation report, not mesh validation alone, determines its status.

For a complete **declared pair of polygon surfaces**, use a version 2
intersection relation. Both connectivity tokens are saved; changing either
topology requires explicit rebinding, including review of any face exceptions.

```js
await ws.apply([{op:"relation", definition:{
  id:"bill_separation", kind:"surfaceIntersection",
  source:"upper_bill", target:"lower_bill",
  tolerance:0.00001, touching:"forbid", allowed:[]
}}]);
const contacts = await ws.relations({maxTests:2000000});
// An intentional joint overlap can instead be declared by stable face ids:
// allowed:[{sourceFaces:["f12"],targetFaces:["f8"],reason:"Designed mouth corner joint"}]
```

The tolerance is a numerical tolerance in world metres, not an allowed
penetration depth. Every source/target triangle pair is considered, including
coplanar overlap and boundary contact. Results identify source and target face
ids, their triangle vertex indices and a world-space contact point. The
measurement is an intersection count (`units:"count"`); positions and tolerance
are labelled in metres. `crossing`, `coplanar-overlap` and `touch` are distinguished.
`touching:"allow"` permits boundary-only contacts; positive-area coplanar overlap
still requires a named face-pair exception with a design reason. Exceptions
remain visible as `allowed` samples, rather than disappearing from the report.

Each determinate contact also includes `contactGeometry`: the full crossing
segment, clipped coplanar polygon or point, with `space:"world"` and
`units:"metres"`. `point` remains a representative location for compatibility.
Use the full geometry to locate a seam's extent; its midpoint alone cannot
prove that the intersection is confined to an intended joining region.
The geometry uses the relation's numerical tolerance and does not measure
penetration depth or enclosed overlap volume. Diagnostic records retain it too.

For a seam region, an allowed face-pair rule may also carry
`bounds:{min:[x,y,z],max:[x,y,z]}` in **source mesh local metres**. This creates
relation version 4; older readers reject it instead of silently discarding the
spatial restriction. All endpoints of a crossing segment or vertices of a
coplanar overlap polygon must fit the box, with the world numerical tolerance
transformed into that local frame. The representative midpoint is insufficient.
Face matches outside the box remain failed and report `rejectedBounds` plus
`sourceLocalContact`; accepted contacts record the exception index and bounds.
Bounds move with the source transform, including nonuniform scale. Topology
changes still require rebinding both meshes' face sets.

```js
await ws.apply([{op:"relation",definition:{
  id:"hinge",kind:"surfaceIntersection",source:"upper",target:"lower",
  tolerance:0.00001,allowed:[{
    sourceFaces:upperHingeFaces,targetFaces:lowerHingeFaces,
    bounds:{min:[-.58,-.30,.63],max:[.58,-.13,1.13]},
    reason:"Solid hinge insertion inside the designated root compartment"
  }]
}}]);
```

These are bounds on the contact set, not on penetration volume. Combine them
with deliberately chosen signed-gap samples if the design also limits insertion
depth, and retain the reported sample/continuous-motion limitations.

Triangle-test exhaustion or the 1,000-contact report cap is `incomplete`;
degenerate/ambiguous geometry is `not_checked`. The per-relation coverage and
`declaredMeshPairIntersections` identify checked pairs; global
`interObjectIntersection` remains false because undeclared objects were not
examined. A wholly nested object can have no surface intersections, so this is
not a volumetric collision or containment test. Combine it with suitable
containment relations and evaluate the needed poses; swept motion remains
unchecked. Diagnostic renders select the failing source faces, and full
diagnostics contain world points plus both face ids.

`node scripts/examples/duck-surface-audit.mjs` checks the current canonical duck
in an isolated browser session at neutral, open, closed, smiling-open and
surprised-closed poses. It declares six mouth-part pairs with no exceptions,
keeps failed candidates isolated, saves three diagnostic views and verifies
exact editable reload. The initial audit completed all 30 pair/pose checks:
10 passed and 20 reported unapproved intersections. These are not 20 unique
defects: triangle pairs can describe the same physical seam, and some joint
overlap may be intended. No exception has yet been adopted. The report and
`audit.funmodel.glb` in `test-results/duck-surface-audit/` are diagnostic artifacts,
not a replacement accepted duck. The oral-volume follow-up below repairs the
tongue and defines oral air explicitly; bill/lining seam classification remains open.
Older readers that only accept relation version 1 reject these version 2 records.

`insideVolume` (relation version 3) defines an inspection volume from selected
target faces plus explicit closure triangles. The cap indices reference the
target's vertices; both source and target topology tokens are saved. It follows
evaluated morphs, skinning and transforms without storing a second, stale mesh.
Use a physically meaningful boundary: for the duck, the inner bowl faces plus
the surface between the upper/lower aperture arcs define oral air. The lining's
material shell does not.

```js
await ws.apply([{op:"relation",definition:{
  id:"oral_air",kind:"insideVolume",source:"tongue",target:"mouth_cavity",
  vertices:tongueSampleIndices,min:0.00001,max:1,
  volume:{faces:innerBowlFaceIds,caps:apertureTriangles}
}}]);
const report = await ws.relations();
// Browser API, or the equivalent workflow tool:
await funEditor.workflow({action:"inspect",views:["front","left","perspective"],
  query:{showVolumes:true},render:{ids:["tongue"]}});
```

The enclosure must be one closed, consistently oriented, nonzero-volume shell
with no detected self-intersection. Inward winding is reversed only in the
derived inspection mesh. Invalid or ambiguous enclosures are `not_checked`;
an exhausted validation/ray/triangle budget is `incomplete`. The report includes
the derived mesh in target-local coordinates, its world matrix, source vertex
mapping, closure face ids and validity evidence.

After validating the enclosure, the checker tests every source triangle against
its entire boundary, including virtual caps. Boundary contact is rejected.
At least one sampled vertex must represent each connected source mesh component;
unrepresented components produce `not_checked`. Complete boundary checks plus
inside witnesses produce `coverage.wholeMeshContainmentChecked` and
`wholeMeshContained` for that declared mesh and evaluated pose. The min/max
clearance interval applies to the selected vertices only, not global minimum
clearance. Continuous motion and undeclared objects remain unchecked.

`showVolumes` adds transparent inspection meshes only to the returned rendering;
they are absent from the document, undo history and runtime export. Source
projects save the relation definition, while runtime files contain the character.
Older readers reject relation version 3. The command participates in the same
candidate, revision, history, dependency and source-export paths as other relations.

The reproducible duck follow-up uses the lining's 100 inner faces and 18
aperture closure triangles. It reshapes the tongue against the actual bowl floor
with an 8 mm base offset, uses the lining's affine closure for its closed target,
and attenuates jaw opening during closure. Saved proximity relations also limit
the sampled underside's distance from the lining and lower jaw, so removing
intersections cannot silently turn into a floating tongue.

```sh
node scripts/examples/duck-oral-volume.mjs
npm run build:production
node scripts/examples/duck-oral-volume-browser.mjs
node scripts/fun3d.mjs convert test-results/duck-oral-volume/duck.funmodel.glb \
  --type character --name duck-oral-volume -o test-results/duck-oral-volume/duck.fun3d
DUCK_SKIN=1 DUCK_MOUTH=1 DUCK_CLOSE=1 DUCK_DEFORM=1 \
  DUCK_RUNTIME_DIR=test-results/duck-oral-volume \
  node scripts/examples/duck-runtime-character.mjs
```

The scripts consume `test-results/duck-joint-panel/authored.json` from the
preceding character examples. All 45 sampled opening/closure/expression
combinations pass tongue/bill/lining intersection checks, floor proximity and
whole-mesh containment in the validated derived volume. Browser acceptance
checks isolated candidates, matching before/after views, volume overlays,
undo/redo and exact editable export/reload. The overlay is absent from saved
geometry. Actual runtime playback checks 63 morph entries, six skins and nine
rendered poses without console errors. The PNGs and JSON evidence are saved in
`test-results/duck-oral-volume/`. Runtime playback does not itself re-run the
oral containment checker on compressed geometry; continuous motion, remaining
bill/lining intersections and the full head/thickness range remain unchecked.

Re-run the six-pair audit against this repaired source without replacing the
original diagnostic artifacts:

```sh
DUCK_AUDIT_SOURCE=test-results/duck-oral-volume/authored.json \
  DUCK_AUDIT_OUT=test-results/duck-oral-volume-seams \
  node scripts/examples/duck-surface-audit.mjs
```

All 30 pair/pose checks complete: 18 pass and 12 retain unapproved intersections.
All 15 tongue-pair checks pass. Remaining reports concern upper/lower bill and
lining/bill contacts; they have not been waived as intentional seams. The audit
also verifies exact editable reload and leaves the canonical source unchanged.

For seam repair, use `DUCK_AUDIT_OUT=test-results/duck-seam-extents` in the
same audit command, then run `node scripts/examples/duck-seam-extents.mjs`.
The read-only follow-up writes `extents.json`: complete contact geometry and
bounds in the mouth mount's local metre coordinates, separated into this
duck's inner lining, outer shell and rim. The neutral sample has 40 inner
lining/upper-bill and 47 inner lining/lower-bill triangle contacts. These
counts include repeated physical seams; they are neither penetration depths
nor a justification for blanket overlap exceptions. The source remains unchanged.

The lining follow-up projects its inner material points into the measured gap
between the actual upper/lower bill surfaces. Matching outer-shell points move
with them to preserve wall orientation; independently clipping both shells was
rejected by the existing self-intersection guard. The tongue follows the revised
floor. Two saved morphs (`liningFit`, `closeClearance`) and an `oralFit` control
retain editable vertex correspondence. The closing correction uses the existing
binding attenuation to produce `c * (1 - c)`, so it vanishes at both endpoints
and corrects the intermediate closing shapes. The roof and floor have different
correction strengths to preserve floor proximity.

```sh
DUCK_LINING_MARGIN=0.016 DUCK_LINING_CORRECTIVE=1 DUCK_LINING_BACKING=1 \
  node scripts/examples/duck-lining-fit.mjs
npm run build:production
node scripts/examples/duck-lining-fit-browser.mjs
node scripts/fun3d.mjs convert test-results/duck-lining-fit/render-0.016/duck.funmodel.glb \
  --type character --name duck-lining-fit -o test-results/duck-lining-fit/render-0.016/duck.fun3d
DUCK_SKIN=1 DUCK_MOUTH=1 DUCK_CLOSE=1 DUCK_DEFORM=1 \
  DUCK_RUNTIME_DIR=test-results/duck-lining-fit/render-0.016 \
  node scripts/examples/duck-runtime-character.mjs
```

This example checks 45 opening/closure/expression combinations. Its saved design
exceptions permit only the lining's **outer backing/rim** to seat into the
upper bill's recessed underside bands (section spans 5–7) and lower bill's
inner lip/bowl bands (spans 0–3). Inner lining faces and exterior bill bands are
not exempt. Disabling the fit reproduces inner-wall failures against both bills
even with these exceptions enabled. The example asserts that negative control,
complete declared-pair checks, zero inner contacts and all other saved relations.
The full lining and tongue surfaces also pass self-intersection checks at all
45 samples; enclosure validation alone would not prove the outer lining safe.
The section layout is asserted before applying the model-specific face bands.

The three-margin diagnostic mode (run without environment variables) retains
failures and does not replace the accepted source. The browser acceptance uses
the 16 mm fitted/corrected result and checks candidate acceptance, undo/redo and
exact editable roundtrip, with 18 comparison renders in
`test-results/duck-lining-fit/render-0.016/`. This repairs lining/bill contact;
the exported fun3d retains six skins and 69 runtime morph entries and passes
nine rendered runtime poses without console errors. These playback checks
compare actual animation geometry but do not certify continuous collision.
Upper/lower bill seam classification and the final all-controls integration
remain separate requirements.

The integrated scenario continues from that editable source:

```sh
node scripts/examples/duck-integrated.mjs
node scripts/examples/duck-integrated-browser.mjs
node scripts/fun3d.mjs convert test-results/duck-integrated/duck.funmodel.glb \
  --type character --name duck-integrated -o test-results/duck-integrated/duck.fun3d
DUCK_SKIN=1 DUCK_MOUTH=1 DUCK_CLOSE=1 DUCK_DEFORM=1 \
  DUCK_RUNTIME_DIR=test-results/duck-integrated \
  node scripts/examples/duck-runtime-character.mjs
```

It changes head width from .065 to .085, forehead width from .11 to .13,
both bill thickness parameters from .020 to .025 metres, and the left-wing
walk key at .3 seconds by +5 degrees. Seven material-point anchors (eyes,
highlights, mouth mount and new frame-following nostrils) remain coincident
within 1e-8 m; the protected chin vertices stay unchanged. The upper bill's
recipe is first reparameterized at identical current geometry: increasing
thickness grows the outer roof while preserving the oral surface. The older
inward-growing definition produced eight intermediate-closure failures after
thickening; those failures were not solved by weakening contact thresholds.

All 45 mouth combinations and nine walking samples pass declared relations
and the four mouth meshes' self-intersection checks. Browser acceptance retains
seven fixed before/after comparison PNGs, an edited walking pose, blinking and
a simultaneous blink/smile/surprise/closure preview, with undo/redo and exact
editable reload. The runtime export retains six skins and 69 morph entries,
and passes nine rendered poses with no console errors. Artifacts are in
`test-results/duck-integrated/`. The mouth close-up still reveals a thin corner
seam: declared checks do not prove visual seam closure. Upper/lower bill contact
classification, that visual repair and compressed-runtime contact acceptance
remain open; the overall character track is not complete.

`duck-relations.mjs` saves eye-back contact, mouth-corner distance and upper-bill
directional wall samples, full measurements, diagnostic views and editable
roundtrip results in `test-results/duck-relations/`.

The initial duck relation audit is intentionally **not all green**. Eye-back
signed gaps are approximately -4.2 to -13.5mm and pass the declared interval.
The upper-bill lateral extrema are 154.4mm from the lower-bill surface, exceeding
the 40mm seam interval. The crown-to-underside directional span is 333.8mm,
exceeding the chosen 200mm section limit. Diagnostic renders show the precise
sampled vertices. These measured failures are retained; deciding whether those
vertices represent the intended mouth seam/wall requires geometric review.
The current values do not prove a minimum wall defect or a global open seam.

The follow-up in `test-results/duck-relations-verified/` corrects the sample
semantics without changing those thresholds. The lower first lip-section
endpoints are 5.6–6.2mm from the upper underside. Front-lip samples use oblique
down/back rays that enter the rounded lip, measuring 97–105mm; vertical rays at
the frontmost contour leave the silhouette and correctly miss.
Descriptions saved with each relation record why those indices/directions
were selected. Original failed audits remain in `duck-relations/` and
`duck-relations-refined/`.

Clip sampling then found two buried Blink vertices at about -94.6mm signed
gap, outside the allowed -80mm overlap. The example uses diagnostic normals
to adjust only those two target vertices to -70mm. The neutral base and head
are unchanged. The final run passes the four declared relations at 40 sampled
poses across all eight clips, with a before/after Blink comparison and editable
roundtrip. This is not a continuous-time guarantee.

Comparison `inspect` renders now keep the same framing/overlay policy even
when one candidate fails diagnostics; diagnostic selection and wire overlays
are confined to `diagnose`/failed preparation. `ws.compare` defaults to clean,
matching overlays. This avoids comparing a wireframe failure to a shaded repair.

The mouth lining should not be assumed to be an oral containing volume:
the exploratory `tongue-audit.json` fails that particular interpretation.
The oral-volume follow-up above replaces that interpretation with an explicitly
validated envelope. Its acceptance is limited to the recorded sampled poses.

The current reproducible script writes the repaired result to
`test-results/duck-relations-verified/`:

```sh
node scripts/editor-agent.mjs --run scripts/examples/duck-relations.mjs
node scripts/fun3d.mjs convert test-results/duck-relations-verified/duck.funmodel.glb \
  --type character --name duck-relations -o test-results/duck-relations-verified/duck.fun3d
DUCK_SKIN=1 DUCK_RUNTIME_DIR=test-results/duck-relations-verified \
  node scripts/examples/duck-runtime-character.mjs
```

## Runtime inspection and export reports

`workflow({action:"verifyRuntime"})` is read-only and accepts base64 `.fun3d`
bytes, 1–64 explicit clip/time samples (seconds), and optional relation IDs.
It loads the actual runtime, verifies unique base-position and oriented-triangle
correspondence, poses the runtime, and runs the selected source design relations
on those runtime vertices/triangles. It never substitutes source positions or
averages disagreeing split-vertex copies. The returned draft identity/revision
and source/runtime SHA256 digests identify the checked input.

```js
const report = await funEditor.workflow({
  action: "verifyRuntime", ifRevision: funEditor.inspect().revision,
  query: { data: base64Fun3d, poses: [
    {clip: "mouth_close", time: 0.5}, {clip: "walk", time: 0.3},
  ] },
});
// report.status: passed / failed / not_checked / incomplete
// report.samples[].results preserves the status and coverage of each relation.
```

In a Node Agent script, `ws.verifyRuntime({runtimeFile, poses, file})` reads the
binary and can save the report. `detail:"full"` retains all samples and derived
volume meshes. Default summary detail keeps sample counts, up to 50 nonpassing
samples per relation and explicit diagnostic truncation; omitted volume meshes
are marked. Summary does not change check coverage. Full reports can be large.

Base correspondence defaults to a 1 mm maximum error and five million distance
comparisons. `query.mapping` can set `maxError` in (0, 10 mm] and
`maxComparisons` in 1–5,000,000. Ambiguous/missing vertices, changed triangles or
disagreeing split copies are **not checked**, never silently welded. The check
budget (`query.maxTests`, up to two million) applies separately to each pose.
Budget exhaustion is **incomplete**. The source must be the exported editable
project; this is not generic correspondence recovery after arbitrary remeshing.
Undeclared pairs and unsampled times remain outside coverage.
Animation-channel parity is a separate check (`coverage.animationParity:false`);
passing geometric relationships does not prove a clip matches the author's intended
transform or weight curve.

Very small closed-mouth geometry can be damaged by separately quantizing base
positions and morph deltas. The converter offers
`--position-precision float32` to preserve GLB Float32 positions and position
deltas while retaining lossless stream compression. Normals, weights, transforms
and animation channels retain their existing encodings; this is not a claim of
lossless preservation of the entire scene. Always inspect the resulting runtime.

`exportReport()` includes the final baked morph target inventory and animation
summaries, matching `exportGLB().report`. Deformation followers may generate
additional targets during clip sampling. Preflight therefore performs the same
animation bake and obeys its sample/shape budgets; a budget error is not a
successful partial report. Both operations leave the editable project unchanged.

The versioned `report.transfer` declaration separates runtime payload from
authoring semantics. It lists exported-node recipes, attachments, morphs and
skins, plus document controls, clips, assemblies, design relations, references
and view presets. `runtime` preserves a runtime representation; `baked` keeps
evaluated results; `sampled` denotes clip baking; `omitted` stays source-only.
Document-level IDs may refer to definitions outside a selected-node export.

```js
const report = funEditor.exportReport();
console.table(report.transfer.features.map(({ name, ids, treatment }) =>
  ({ name, count: ids.length, treatment })));
// Keep the .funmodel.glb for parameters, relationships and continued editing.
const editable = await funEditor.exportProject();
```

This is a writer policy/inventory, explicitly `readbackChecked: false`, not a
claim that reimport or `.fun3d` compression/playback passed. Use the isolated
source verification workflow and actual runtime checks for those results.
Triangulation and render-vertex splitting are explained separately from data
loss; counts alone do not establish either geometric damage or preservation.

## Human character controls

The inspector's **Character & motion** section provides manual expression
sliders, clip selection, a time slider, explicit playback preview and keep-pose
actions. Playback is opt-in, capped at 12 preview frames per second, and writes
neither history nor the saved document. Stop, Escape, hiding the page or changing
selection restores the saved pose. Releasing the time slider or keeping a pose
uses `characterPose`; expression sliders use `characterValues`.

The expandable key editor targets an existing expression control or the selected
part's local position, rotation, scale or morph weight. It supports linear/step
keys and spherical rotation, key replacement/removal and creating named looping/nonlooping clips.
Units are explicit. Each edit uses `characterClip` through the same transaction
and undo path as agents. Surface-driven channels and linked-copy targets are
excluded from the selector. Read-only drafts cannot author keys.

`node scripts/examples/duck-character-panel.mjs` exercises actual browser
controls on the duck, including playback isolation, setting a head key, undo/
redo, editable export/reload and desktop screenshots. The workbench retains its
documented 1024px minimum; the recorded phone screenshot is a limitation, not
mobile authoring acceptance. Weight painting, binding creation and a graphical
curve editor are not provided by this panel.

The browser acceptance passed playback isolation, key set/undo/redo and exact
editable reload with no console errors. Actual 1440px and 1024px screenshots
were inspected. It also exposed and fixed a position-attachment drift: position
mode now updates only translation, retaining local rotation/scale exactly
instead of re-decomposing them on every evaluated frame.
