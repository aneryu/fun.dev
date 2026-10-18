# Low-poly model workshop

The static `/editor/` page lets people and browser-connected agents build game
models using the same document and command engine. The lobby links to it.
No model service, credentials, upload endpoint or new dependency is required.

```sh
npm run editor          # http://127.0.0.1:8001/editor/; rebuilds on save, refresh the tab
npm run verify:editor   # source links + build + geometry tests + browser round trip
```

This independent preview lives in ignored `.editor-preview/`, never `dist/`,
and needs no game binaries. `npm run build` / `build:production` include exactly
the same editor and pinned Three.js artifacts in the complete site. The editor
and its addons are excluded from the player service worker's precache; they load
when the workshop is opened. Release remains `npm run release` only.

The editor uses the pinned Three.js `WebGPURenderer`, preferring WebGPU and
falling back to its WebGL2 backend when the API or an adapter is unavailable.
The viewport footer and `funEditor.inspect().renderer` report the actual backend,
including whether fallback occurred. Add `?renderer=webgl` to force WebGL2 for
compatibility checks. Initialization finishes before `window.funEditor` becomes
available; `renderViews` remains synchronous. Shape previews also wait for their
renderer and can be cancelled safely during initialization. The player retains
its existing engine entry point; project JSON and GLB formats are unchanged.

## Desktop workflow

The workshop is PC-only, with a minimum viewport width of 1024px. The game/player
mobile layout is independent and unchanged. Toolbar examples exercise real editing:
Duck has linked mirrored wings; Stool has a beveled parametric seat and four linked
tapered legs; Planter has an editable profile with a returning inner wall.

- Shift-click selects multiple objects/components. B enables box selection; X
  toggles through-selection. G/R/S selects move/rotate/scale; F frames the selection.
  Numeric input commits on Enter or blur, Escape cancels. Ctrl/Cmd+Z and
  Shift+Ctrl/Cmd+Z undo/redo; Ctrl/Cmd+S downloads the project file (`.funmodel.glb`).
- Object, face, edge and vertex selections share a transform gizmo and numeric selection
  transforms. Choose world/local axes. Translation snap is selectable from 1mm to 1m, angle snap from 1° to 45°,
  and scale snap is 0.1. Length inputs switch between m/cm/mm; the document and
  agent API remain in meters. The adaptive grid displays its actual spacing.
  Profile coordinates (text, X/Y and dragging), known length parameters and recipe
  distances use the same selected unit. Profile arrow keys use the toolbar's move
  step; Shift multiplies it by ten. Shape previews include the resulting dimensions.
  Wire display shows original polygon edges rather than triangulation diagonals.
- Named front/side/top views are orthographic, with an explicit perspective toggle.
  The work viewport has neutral lighting/background, Material/Clay/Silhouette modes
  and a camera-relative orientation indicator. Direction and projection switches
  preserve the working target and screen scale; Fit explicitly reframes the model.
- Primitives retain generator kind, options and optional baked affine basis.
  Edit size, bevel, radius, height, segments, rings or the 2D profile later. The
  profile canvas supports accurate dragging, axis constraints, numeric coordinates,
  insertion, deletion and dialog-local undo/redo. A live 3D preview preserves the
  edited project context; Cancel leaves the project and its revision unchanged. Profiles may return
  down an inner wall; hollow containers use axis endpoints to close their base.
- Convert to mesh enables component edits. Coplanar face regions extrude without
  internal walls. Convex faces support individual insets; closed convex solids
  support a one-segment whole-solid bevel. Edge selection also supports local
  one-segment bevels on closed solids with planar faces, including the rims and
  floor of a recessed box and concave corners whose two edges are both bevelled
  (an extruded car profile with wheel-arch notches). A box with
  `bevelSegments` above 1 rounds every edge and corner. Plane cuts split crossed
  polygons; loop cuts follow a manifold quad strip. Unsupported/too-wide operations
  fail atomically. Inspect edges again after topology changes; vertex indices/edge
  keys may change.
- Mesh tools: Delete in face, edge or vertex mode removes the selected faces (or the
  faces on the selected edges/vertices) and leaves an open boundary; Fill holes
  closes open boundaries (in edge mode only the selected loops); Weld vertices merges
  points within the weld distance (in vertex mode only the selection); Separate moves
  the selected faces, or in object mode every loose piece, into new parts; Join parts
  merges the other selected parts into the active one.
- Reparenting keeps world appearance by default, including nonuniform parent
  transforms. Affine shear that cannot be represented by TRS is baked into geometry
  and the generator basis, with child transforms preserved. Set `keepWorld:false`
  for explicit local-preserving reparenting. Additional supplied TRS fields override
  the preserved values.
- World dimensions, apply scale, ground and bounds alignment are shared commands.
  Extrusion/inset/bevel defaults to world meters; local distance is explicit.
- Symmetry reflects a subtree across a world/parent plane, with optional ongoing
  source linkage. Linked duplicates share geometry/materials while keeping their
  own placement. Edit a source or unlink before changing derived geometry. Deleting
  a source removes its linked mirrors and makes surviving geometry copies independent.
- Multi-select duplication copies all selected roots in one undo step. Component
  mode disables whole-part duplication/deletion and Delete never removes a part.
  Paint applies to the selected objects (or faces), resolves linked sources, and
  displays the total affected parts including copies. Active selection is amber;
  other selected parts are blue.
- Tree hide/lock and viewport isolation are session-only authoring controls. Hidden
  geometry is excluded from picking and observations but still exported. Locks
  protect UI selection/transforms, not source-driven updates or agent commands.
  X-ray controls occlusion for object and component box selections.
- Select source and mirrored target together to transform along their symmetry
  plane. Group selection creates an asset container and carries internal mirror
  planes with it for arbitrary whole-asset movement. A translucent plane and tree
  relationship marks show the active mirror relationship.
- Materials show affected-part counts, with new/rename/make-unique controls. Unique
  creation and assignment are one undoable command batch.

Editable projects remain versioned `fun.dev/model` v1 JSON, with optional generator,
symmetry and instance metadata (including affine link bases for appearance-preserving bakes). Node/face IDs are stable; generated render triangles
are derived from polygons. Topology changes can replace face IDs when segmentation
changes. Face extrusion retains cap IDs. Flat face normals are explicit. World units
are meters, Y is up, front is +Z and XYZ Euler rotations are degrees.

## Shapes from sections and paths, and arrays

Beyond boxes, spheres, cylinders, cones, outlines and lathes (`site/editor/generators.js`):

- **Extrusions with holes and rounded corners**: `holes:[[[x,y],…],…]` lie inside the
  outline and apart from each other; `round` fillets every corner of the outline and the
  holes (`roundSegments`, default 3), filling concave corners and cutting convex ones.
  Without holes and within 64 corners an extrusion keeps the plain face layout (caps f0
  and f1, then one side per edge); otherwise the solid kernel builds it and its caps
  become a few simple polygons.
- **revolve**: a closed section (x = distance from the Y axis, at least 0; holes and
  rounding as above) turned around +Y. `segments` count a full circle; an `angle` below
  360° starts on +X, turns like a positive rotation about +Y and caps both ends: pipe
  elbows, rings, arches.
- **sweep**: a closed section moved along `path:[[x,y,z],…]` with rotation-minimising
  frames, so it never flips or twists on a 3D path. Section x runs sideways and y up; a
  level path keeps y on +Y. Polyline corners are mitred to keep the full thickness (at
  most 150° per corner); `smooth` runs a centripetal Catmull–Rom curve through the points
  (`pathSegments` per span); `closed` joins the ends without caps; `scale` sets the end
  size. Pipes, handrails, rails, cables, frames. Curved sweeps keep slightly non-planar
  quads, which validation reports as warnings.
- **array** command: `count` copies stepped by `rotation` about `pivot`, then `offset`, in
  the parent's coordinates (the pivot defaults to the part's origin; give one for radial
  arrays). Copies are linked parts named `<id>_2`, `<id>_3`… with their descendants
  suffixed the same way, or the roots listed in `newIds`; `linked:false` copies
  independently. `merge:true` appends the copies to the part's own mesh instead, which is
  also the recipe step form (count as a parameter, e.g. fence pickets). Merged copies that
  overlap stay separate shells (a `shell-overlap` warning).

The add-shape dialog offers revolve and sweep (section in the profile editor, path as
`x, y, z` lines) and a corner radius; holes are agent-only. The parts panel's **Array**
control makes linked or independent copies of the selected part.

## Project files and GLB import

**Save project** (and Ctrl/Cmd+S) downloads a project file, `<name>.funmodel.glb`: the model
exported like **Export GLB** (every part, world origin, nothing merged, never blocked by
diagnostics) whose glTF JSON also carries the editable document in a root extension,
`FUNDEV_workshop: { format, version, project }`, listed in `extensionsUsed` only. Any glTF
viewer shows it as an ordinary model; **Open** in the workshop restores the exact project,
recipes, links and assemblies included. JSON projects (`.funmodel.json`, `getProject()`) still
open.

**Open** also accepts any other GLB (or `.gltf` with embedded buffers) and turns it into
editable parts:

- The scene's node hierarchy, with glTF names as IDs (other characters become `_`; repeats
  get `-2`, `-3`) and the original names as display names. TRS and matrices become position,
  XYZ rotation and scale; a mirrored or sheared transform is baked into the part's mesh and
  its children, so world geometry is unchanged.
- Materials: base colour (linear factors to sRGB hex), roughness, metalness (glTF's default
  is 1), emission with `KHR_materials_emissive_strength`, `BLEND` opacity (`MASK` becomes
  opaque or invisible), `KHR_materials_transmission`/`ior` glass, double-sided. Materials
  with the same name and look are one material.
- Polygons: glTF has only triangles, so edge-connected triangles of one material on one
  plane merge back into a polygon, or a few simple polygons where the region has holes or
  more than 64 corners. Vertices split for normals or UVs are welded; vertices inside a flat
  region disappear, which can lower the triangle count without changing the shape.
- A mesh used by several nodes becomes linked copies of its first node.
- Reported, not imported: skins and bones, morph targets, animations, textures, cameras,
  lights, line and point primitives. Refused: compressed files (Draco, meshopt, KTX2, WebP,
  AVIF), other unknown required extensions, and models beyond the limits.

Imports replace the project as one undoable change, or `mode:"add"` adds the parts (under
`parent`, if given); clashing node and material IDs get suffixes. Merged meshes whose parts
pass through each other (the library's `static__mat_*` nodes, for example) are separate
shells: validation warns (`shell-overlap`) and editing and export work as usual.

## Draft ownership

A modern desktop browser with Web Locks (Chrome on localhost or HTTPS) grants one
writer per draft. Additional tabs are read-only; they can download their snapshot,
reconnect after the writer closes, or open an independent draft copy. A persisted
revision catches stale saved state. Undo/redo revisions remain monotonic across a
reload, but undo history itself stays in memory and is bounded to 30 snapshots /
about 8 MB in each direction. Storage failure is visible and downloads remain usable.
The old v1 local draft is migrated on the first successful save; its original key
is retained. Separate draft copies use their own URL key and writer lock.

Keep the editable JSON (`getProject()`, saved as `.funmodel.json`) beside a game's development
scripts, for example `games/<id>/dev/models/duck.funmodel.json`, so source edits are
reviewable in Git; project files are binary and, like other source binaries, belong in
`sources/` with their lock ([assets](assets.md)).
The runtime export goes to `games/<id>/assets/duck.glb`; list it in `game.json`,
bump the game version when shipping a change, then run `npm run assets` and keep
the lock in sync. No new game or binary asset is added by the workshop itself.

GLB contains only the model, standard nonmetallic materials and its named hierarchy.
Grid, floor, lights, camera, selection and editor history are not exported. A node's
ID becomes its glTF name; its display name is retained in extras as `label`.

```js
const { createAssets } = await context.runtime("kit/assets.js");
const { scene } = await createAssets(context).gltf("assets/duck.glb");
context.scene.add(scene);
const beak = scene.getObjectByName("beak");
```

## Model library

Each model page (`/models/<id>`) has **Open in workshop**: `/editor/?open=<id>&version=vNNN`
opens that version in a new draft of its own (the current draft is untouched; the address
then names the new draft). A version with a workshop source, `source.funmodel.glb`, opens as
that project; otherwise its `model.glb` is imported as parts. Uploads may include
`source.funmodel.glb` beside `model.glb`: like `source.blend` it is public and fixed once the
version is approved, and the page offers it for download ([models](models.md)).

## Agent contract

The page exposes `window.funEditor.version === 3`. The complete API, command fields,
examples and project schema are at `/editor/guide` (source:
[`site/editor/guide.html`](../site/editor/guide.html)). Wait for the API, then inspect
→ apply → renderViews → validate → exportGLB. API v2 makes world-space extrusion and
world-preserving reparenting the defaults; explicit local-space options remain.

`inspect({id})` defaults to compact node metadata, recipe parameters/step summaries,
counts, topology token, world matrix, subtree bounds and origin. Request
`inspect({id,detail:'full'})` for editable mesh data, face centers/normals and edge
references; use `getProject()` for the complete project. General inspection returns node bounds,
material users, selection, session visibility/lock/isolation state, camera, revision,
draft ID and writable state. `select`
accepts object IDs or arrays of face/vertex IDs. UI and agents use the same transform,
symmetry, instance, parameter, alignment, grounding and topology commands.

The project panel's **Material library** is available even on an empty project.
It shows the 32-material budget, removes unused materials, and can replace a material
throughout the project before removing it. These actions are undoable. Cleanup keeps
references in base generators, scripted source meshes, disabled recipe steps, whole
mesh/face overrides and paint rules, including rules that currently match no faces.
Inspection includes `users` (evaluated meshes), `retainedBy` (parts with modeling
references), `referenceCount` and `unused` for each material. Agent commands are
`{op:'purgeMaterials'}` and `{op:'removeMaterial',id,replacement?}`. Removing a used
material requires a different existing replacement; cleanup always retains at least
one material. Replies include `removedMaterials`; `materials` includes changed and
removed IDs. Full document loading also validates dormant material references.

The inspector keeps the selected part and owning asset in a sticky navigation
strip. Its buttons jump to object properties, modeling steps or asset parameters.
Steps have compact expandable summaries; only the last step starts expanded.
Recipe-step edits, selectors, enable/disable and order changes appear as field
differences in Activity, including values before and after the change.

`apply()` validates an entire batch before committing one history entry, and returns
changed node IDs, removed IDs and changed material IDs. Linked geometry is
synchronized between dependent commands, so batch and sequential geometry agree. Pass `ifRevision`; pending valid UI edits are committed first so
an agent cannot silently discard them. Invalid input leaves the document, revision
and history unchanged. Reads return independent copies. Observations include the
revision, draft ID, camera/projection matrices and shading mode. GLB export snapshots
the document before asynchronous work and reports revision with base64 output.

The page remains a local API without arbitrary script-string evaluation or a remote
HTTP endpoint. A local CLI / stdio MCP adapter now uses the same browser API;
no online service or extra dependency is required. The UI works without an agent.

`preview(commands,{ifRevision,views?,size?,detail?})` defaults to compact proposed
`nodes` (the same metadata/bounds shape as `inspect({id})`), materials, per-command
results, statistics and validation. It includes the proposed project name and optional
images. Use `detail:'full'` only when you need the complete proposed `project` mesh.
Preview leaves the live project, revision and undo history unchanged.

## Mesh editing commands

These change one part's polygons and fail before the document changes when the result
would be invalid. Weld distances and solidify thickness are world meters unless
`space:"local"`.

- `deleteComponents {id, faces|edges|vertices|select}` removes faces (or every face
  using the edges/vertices) and leaves an open boundary.
- `dissolve {id, edges|vertices|select, angle?}` joins coplanar faces across edges
  (within `angle` degrees, default 0.1) or removes vertices. Without components it
  cleans the whole mesh: coplanar faces of one material merge into the fewest simple
  polygons and corners on a straight edge drop out — use it after imports and
  booleans.
- `weld {id, distance?, vertices?}` merges points within the distance at their centre;
  coincident faces collapse, and a weld that would pinch a face is refused.
- `fill {id, edges?, material?}` closes open boundaries; holes with more than 64
  corners become several faces.
- `bridge {id, faces:[a,b]}` (or `edges` on two open loops) joins two loops with the
  same corner count by quads, e.g. a tunnel between two inset faces.
- `connect {id, vertices:[a,b]}` splits a face along a new edge between two corners.
- `solidify {id, thickness, offset?}` thickens an open surface into a closed shell
  (offset -1 grows against the normals, 1 along them, 0 both ways) with even walls at
  corners; a closed mesh gains an inward cavity shell.
- `separate {id, newId, faces|select|loose:true}` moves faces, or every loose part
  after the first (`newId`, `newId-2`, …), into new parts with the same parent and
  transform. `join {id, with:[ids]}` moves other parts into this part's coordinates and
  consumes them; their children and mirrors stay. Parts that touch or overlap are
  refused: boolean union makes one clean solid instead.

All but separate and join are also recipe steps.

## Limits and verification

Untextured static models. UV/textures, rigs and animation are later stages of the
[roadmap](platform-roadmap.md#workshop-replacing-blender-decided-2026-10-18). Limits: 512
nodes, 32 materials, 30,000 editable vertices, 50,000 triangles, 64 vertices per polygon,
8 MB project JSON. Every command still re-checks the whole project: at 45,000 triangles a
small edit takes about 0.15 s and a geometry edit of the large mesh about 1.4 s (binary
storage and incremental history are stage 2). Generated topology may change face identity
when its segment counts change; inspect again after parameter updates.

The validator checks IDs, indices, hierarchy/link cycles, degenerate polygons and
material references. It reports non-planar polygons, open/nonmanifold/inconsistent
edges and optional budgets. GUI diagnostics locate the offending part/face. Draw
calls count mesh/material groups, excluding helpers, shadows and renderer passes.
Surface checks additionally detect triangle self-intersections (including coplanar
overlap), inward closed shells and zero-volume shells. A shell is an edge-connected set
of faces: a shell crossing itself is an error, separate shells passing through each other
(merged parts, joined pieces) only warn (`shell-overlap`). Geometry-changing commands
reject results that add self-intersections or collapsed shells; faults a mesh already
had (from a loaded project or an import) and checks too large to finish do not block.
Inward shells are warnings: nested cavity shells can intentionally face inward.
`validate()` reports errors separately from warnings and explicitly lists checked
and unchecked categories. Inter-object collisions, minimum wall thickness, visual
quality and runtime frame rate are not certified. Surface scans are bounded to
2 million candidate pairs and 24 issues per mesh; incomplete scans are reported.

`npm run verify:editor` covers transaction rollback, revision conflicts, world
geometry preservation under shear, parameter regeneration, mirrored/linked parts,
region edits, inset/bevel, dimensions and alignment. Browser checks exercise numeric
commit/cancel, project downloads/reopen/reload, material uniqueness, hollow profiles,
view metadata, writer locks, desktop layouts, bilingual UI and GLB loading through
the existing runtime kit. The same suite participates in `npm run verify` as
`editor`; artifacts go to `test-results/`.

## Materials and names

Materials are glTF metallic-roughness PBR: `color`, `roughness`, and optionally
`metalness`, `emissive` + `emissiveIntensity` (KHR_materials_emissive_strength above 1),
`opacity` (blended below 1), `transmission` + `ior` (glass, KHR_materials_transmission /
KHR_materials_ior) and `doubleSided`. Defaults are left out of the document; `null`
removes a property. The material panel shows them under "Metal, emission and glass".

A node ID is its glTF name, which games use to find parts. `{op:'rename',id,newId}`
updates parents, mirrors, linked copies, asset bindings and anchors; the object panel's
"Export name (ID)" field does the same. `symmetry` and `duplicate` name copied descendants
by `idMap` (explicit), `replace:["_l","_r"]` (last occurrence) or `newId-1…`, and report the
map. Exports take `rootName` (e.g. `crate_01_ROOT`): with one top-level part, that part
becomes the root under this name (no extra wrapper). `mergeStatic` groups are named
`static__<material>` under the root and `<parent>__<material>` under a moving part, as in
the model library.

## Geometry kernel and booleans

manifold-3d (Apache-2.0, a WebAssembly build of Manifold) loads before `window.funEditor`
opens (about 200 KB compressed, workshop only; the `/editor/*` policy allows WebAssembly).
`{op:'boolean', id, operation:'union'|'difference'|'intersection', with:[ids] | shape, keep?}`
works on closed solids: `with` parts are placed in the world and used up unless `keep`;
`shape` is an inline primitive `{kind, options, position, rotation, scale, material}` in the
part's local coordinates and is also a recipe step, so a window keeps its parameters. Cut
faces keep the tool's material. Results come back as editable polygons: triangles from
one source face merge into one polygon, or a few simple (possibly concave) pieces where the
face has holes. The page's buttons Union / Subtract / Intersect use the last selected part
as the target.

## Reference images

One image per orthographic view (front, back, left, right, top) stands behind the model:
`setReference({view, image, width, center, opacity})`, `clearReference({view?})`,
`references()`; `renderViews(names, {references:true})` includes them. `center` is
[horizontal, vertical] metres along the view's screen axes from the world origin. Images
stay with the draft (up to 8 MB each) and never enter a project or export. The page's
"Reference image" button opens the same settings.

## Agent API v3: references, previews and recovery

`capabilities()` returns JSON Schema for every command, query fields, limits and
unsupported features. `query({id,kind,...})` finds faces by normal/area, components
on a plane, edges by crease angle/length, adjacent components, or a quad ring from
an edge reference. It returns only requested results, plus `total` / `truncated`.
Read larger meshes with `limit`, then pass `offset: result.nextOffset` and the
same `topology` token and `ifRevision: result.revision` until `nextOffset === null`.
A changed revision invalidates pagination, including world-transform changes.
Selectors must match the operation: bevel uses edges, inset/extrude/paint
use faces. Empty or incompatible selections fail; they never become whole-mesh edits.
Operation results include resolved selection scope, kind and count.

Component references are `{node,kind,id,topology}`. Geometry changes invalidate
these content-bound references. Pass query/inspect refs in `faces`, `edges` or
`vertices`; legacy raw IDs require `command.topology` from current inspection.
Absolute `vertices` changes also require `topology`. The UI binds its current
selection internally. Semantic `select` queries resolve inside each command, so
later operations in one batch can select newly generated geometry safely.

```js
const state = funEditor.inspect();
const top = funEditor.query({
  id: "body",
  kind: "faces",
  normal: [0, 1, 0],
  largest: true,
});
const commands = [
  {
    op: "inset",
    id: "body",
    faces: top.items.map((f) => f.ref),
    distance: 0.02,
  },
];
const preview = funEditor.preview(commands, {
  ifRevision: state.revision,
  views: ["perspective"],
  size: 512,
}); // project, results, validation, observations; no draft/history mutation
funEditor.apply(commands, {
  ifRevision: state.revision,
  operationId: "unique-edit-id",
  label: "Inset the top",
});
```

Success results include compact per-command changes, previous/current topology and
face/edge counts. Set `includeComponents:true` to return created/removed faces and
current refs (capped at 1,000); normally use a targeted `query` instead.
Errors include `commandIndex` (zero-based), `operation`, `node`, `components`,
`path`, and where available `issues` and `suggestion`. Schema errors identify the
argument path. Check revision before evaluating a batch. `operationId` deduplicates
the last 32 acknowledged requests, persisted with the local draft when storage
allows; the same ID with different commands fails. Older/evicted IDs are not a
permanent exactly-once guarantee. Keep the original revision on retries.

`checkpoint({name},{ifRevision})`, `checkpoints()`, `restoreCheckpoint(id,options)`
and `removeCheckpoint(id,options)` manage up to five named persistent snapshots.
Restoration is an undoable commit. Checkpoints and the last 30 activity records
survive refresh in the draft; they are separate from editable project JSON.
`getSession()` includes them for local adapter persistence. Writes return a `persistence` status; await `flush()` before treating a checkpoint
or edit as durable. The GUI and MCP await this acknowledgement. Storage failures
remain visible and `flush()` rejects with applied/unsaved status. Undo history
itself remains in memory. The Activity dialog shows changed parts, diagnostics,
detached recipes, and a fixed-camera comparison of the latest change in this tab.

## Parameter recipes

A mesh may retain `recipe:{name?,parameters,generator,steps,basis?}`. Parameter
values have optional min/max. A value expression is `{$param:"width",factor:1,
offset:0}`; no script strings are evaluated. Up to 32 steps operate on this mesh
in local meters, using semantic selections. Supported steps: transform, vertices,
inset, extrude, bevel, cut, loopCut, paint, mirror, boolean, array (copies merged into this
mesh, so a count can be a parameter), deleteComponents, dissolve, weld, fill, bridge,
connect and solidify. A recipe is rebuilt
atomically; other objects and the node's transform are retained, and linked copies
update. Pivot/reparent/apply-scale bakes are retained in its affine basis.
Whole-mesh `transform` steps transform every vertex immediately, so later cuts and
selectors see that geometry. They retain the object's own TRS and use the current
geometry bounds center as the default pivot; supply `pivot` to override it.

```js
const { hollowBoxRecipe } = await import("/editor/recipe.js");
funEditor.apply([{ op: "recipe", id: "body", definition: hollowBoxRecipe() }], {
  ifRevision: funEditor.inspect().revision,
});
funEditor.apply(
  [{ op: "recipeParameters", id: "body", values: { width: 0.82 } }],
  { ifRevision: funEditor.inspect().revision },
);
```

`recipeStep` refines an existing recipe without detaching its dimensions:

For an ordinary parametric primitive, `getRecipe({id})` returns its implicit
zero-step recipe (`implicit:true`), and `recipeStage({id,index:0})` inspects its
unbaked input geometry. Appending its first `recipeStep` promotes the current shape
without replacing it: material, pivot/scale bakes, asset dimension bindings and
linked copies remain intact. The inspector's **Keep shape and start modeling steps**
button performs the same promotion without adding a step. Manual face colors are
retained; incompatible new topology reports executable paint-recovery commands.

Scripted `kind:'mesh'` nodes support the same promotion. Their recipe stores
`generator:{kind:'mesh',mesh:{vertices,faces}}`, preserving original face materials.
The immutable base mesh is rebuilt before subsequent steps, and stage queries,
copying, affine bakes and serialization use the same rules as primitive recipes.
To replace the base, read `getRecipe`, update `generator.mesh`, then submit `recipe`;
topology-bound selections still fail safely if they no longer match. `convert`
bakes the result before direct component editing. Mesh sources have no primitive
shape-options dialog.

`parameters` also edits literal base generator options under a recipe, then rebuilds
its steps. **Base shape parameters** opens these options in the inspector. Assembly
`options` bindings keep driving promoted shapes. Options containing parameter
expressions cannot be overwritten this way: use `recipeParameters` / `recipeValues`.

```js
{op:'recipeStep', id:'body', action:'append', step:{op:'cut', axis:'y', offset:0}}
{op:'recipeStep', id:'body', action:'update', index:3, step:{op:'cut', axis:'y', offset:.05, enabled:false}}
{op:'recipeStep', id:'body', action:'patch', index:3, patch:{offset:.02, enabled:true}}
{op:'recipeStep', id:'body', action:'move', index:3, to:0}
{op:'recipeStep', id:'body', action:'remove', index:0}
```

Read only the recipe with `getRecipe({id:'body',ifRevision})`, or one step with
`getRecipe({id:'body',index:3,ifRevision})`. A step read returns the saved `step`, its
`evaluated` arguments, `parameters`, `basis` and revision without mesh arrays.
Full recipe reads include the base mesh for scripted sources; use compact
`inspect({id})` or an indexed step read when that geometry is not needed.
The MCP equivalent is `fun_editor_getRecipe`. `patch` replaces only supplied fields;
`null` removes an optional field. Nested selectors/vectors are replaced as a whole.
Use `update` to change the operation itself. The merged step is validated atomically.

`recipeStage({id,index,query?,views?,size?,ifRevision?})` reads the geometry **before**
the indexed step; `index === steps.length` reads the input for an appended step.
It returns compact `input` metadata/bounds, `components` with paginated guarded refs,
the saved/evaluated step (null at the end), and optional images highlighting the
returned query page. The MCP tool is `fun_editor_recipeStage`.
Queries use recipe coordinates before the affine basis (`space:'local'` only).
Images apply the saved basis, parent and object placement; `placement` reports both
matrices. No project, history, selection or camera changes are made.

```js
const stage = funEditor.recipeStage({
  id: "body",
  index: 0,
  ifRevision: funEditor.inspect().revision,
  query: { kind: "faces", normal: [0, 0, -1] },
  views: ["front"],
  size: 256,
});
funEditor.apply(
  [
    {
      op: "recipeStep",
      id: "body",
      action: "append",
      index: 0,
      step: {
        op: "paint",
        material: "ink",
        faces: stage.components.items.map((f) => f.ref),
      },
    },
  ],
  { ifRevision: stage.revision },
);
```

Use references from the step's input, not from the final mesh. Continue stage
pagination with `query.offset`, `query.topology` and the top-level `ifRevision`.
Fixed references expire when the input geometry changes; semantic selectors remain
the choice for steps that must follow parameter changes.
Duplicating a mesh or asset remaps recipe component references (including ring
seeds) to the copied node IDs while retaining their topology guards.

Append optionally inserts at `index`; update replaces the complete step. Steps accept
`enabled` and an optional `label`. Indices are zero-based; guard mutations with
`ifRevision`. Errors include the outer `commandIndex` and `recipeStepIndex` /
`recipeOperation` when a step fails, along with `recipeArguments` (evaluated command),
`recipeParameters` (numeric values) and `path: "nodes.<id>.recipe.steps.<index>"`.
The browser and MCP return the same context. The inspector supports step insertion, numeric
edits, enable/disable, reordering and removal; expression-driven values remain linked
to their parameters. All steps rebuild atomically in local meters before the saved
affine basis is applied. Use semantic selectors for details that must survive resizing.

Before adding or rebinding a step, choose its scope and preview the matched count
and highlighted **input geometry before that step**. The preview preserves document,
selection and camera. Fixed selections carry a topology token and must be rebound
when input geometry changes. Directional face selectors and edge boundaries follow
dimensions; e.g. `select:{kind:'edges',space:'local',boundary:{axis:'y',side:'min'}}`
selects edges with both endpoints on the mesh's bottom boundary (default tolerance
`1e-6` meters). Existing steps expose the same scope controls. Expression-backed
numeric fields display their evaluated value while retaining the expression.

The inspector exposes the same parameters and a hollow-box preset. Applying a
preset replaces that mesh, undoably. Width changes retain wall/cavity/bevel values.
Direct component edits detach the recipe and are recorded in Activity. Recipes
remain bounded mesh programs, not an animation system or automatic reconstruction
of older edits. The first local face color on a primitive promotes its generator
to a zero-step recipe; older painted primitives migrate when opened. This keeps
base-shape editing available while giving their colors the same guarded material
layer as recipes. The bindings survive dimension changes; incompatible cached
topology is rejected instead of moving colors to reused face IDs.
Whole-object painting replaces the overrides. `convert` is an
explicit, undoable way to bake a recipe before direct geometry edits.

When a shape-dialog edit invalidates face colors, preview a directional rebind or
clear the overrides before applying. These repairs remain staged with the shape
edit: Apply commits both as one undo step and Cancel discards both. While a shape
dialog is open, `inspect().pendingInput` is true and external model mutations are
rejected with `pending_input`; an agent cannot overwrite a human's staged edit.

## Reproducible observations and export

`renderViews(names, options)` additionally accepts `ids`, `visibility:"all"`,
`shading:"material"|"clay"|"silhouette"|"ids"`, `helpers`,
`overlays:{wire,selection}` and an explicit `camera:{position,target,up?,projection?,
near?,far?,fov?,height?,zoom?}`. Explicit IDs show those subtrees regardless of
session hiding. Each image records visible IDs, visibility/lock/isolation state,
selection, overlays, helpers and the object-color lookup. ID images suppress
helpers/overlays. Camera, shading and visibility are restored after observations,
including failure. A recipe preview can be rendered without replacing the draft.
For named views, explicit `ids` also define the framing bounds, taking precedence
over `focus` on the live selection. `current` retains the current framing; an explicit
`camera` retains the requested pose. Observing an asset never changes the live selection.

`exportReport(options)` and base64 `exportGLB` report editable/render/unique-buffer
vertices, triangles, mesh/material-group counts, reused geometry, precise bounds
and (after export) byte size. Exports index position+normal tuples, preserving
flat normals, and share identical geometry between copies. Sharing buffers alone
does not reduce draw calls. `ids:[rootIds]` exports only those subtrees, retaining
ancestors/transforms. `mergeStatic:[leafMeshIds]` explicitly merges selected static
leaves by **parent and material**, baking geometry in that parent's frame. It
preserves asset and hinge motion; it removes the leaves' independent runtime names
and stores only that merged group's source IDs in extras. `mergeGroups` reports
each result's parent, material and sources. Do not include leaves that must move
independently of their parent or remain addressable by their original name.
The default export preserves all names/hierarchy and includes hidden geometry.
Export validation compares the current geometry/transforms with reevaluation and
blocks `evaluation-mismatch`, so export cannot silently change the visible asset.
Selected exports compare only included parts and their retained ancestors. Import
still rebuilds recipes; `force:true` remains an explicit export override.

`origin:'world'` preserves placement by default. `origin:'asset-root'` requires
exactly one `ids` root and moves its world-space pivot to zero; `ground-center`
moves the exported bounds' X/Z center and minimum Y to zero. These modes translate
only the exported scene, retaining orientation, scale, ancestors and hinge motion.
Reports include `origin:{mode,point,up,front}` (point is in project coordinates),
and bounds reflect the exported coordinates. The Export GLB dialog previews scope,
origin, dimensions and bounds before downloading; the editable draft is unchanged.

## Agents without the repository

`tools/fundev-workshop.mjs` (published at `https://cdn.fun.dev/tools/fundev-workshop.mjs`)
is the CLI / MCP adapter below as one file. It drives the published workshop, or `--url`,
in its own headless Chromium; `--gpu` uses the machine's GPU instead of software WebGL 2.

```sh
npm i playwright && npx playwright install chromium
curl -O https://cdn.fun.dev/tools/fundev-workshop.mjs
node fundev-workshop.mjs --mcp --session model.json --artifacts out/
```

`npm run verify:editor` drives the built file against the local preview.

## Local CLI and MCP

```sh
npm run editor -- --build
# Newline-delimited JSON CLI; stdout is JSON, progress is stderr.
printf '%s\n' '{"method":"inspect","arguments":{}}' | \
  node scripts/editor-agent.mjs --session /tmp/toolbox-session.json
# Long-running stdio MCP process (configure command/args in your MCP client).
node scripts/editor-agent.mjs --mcp --session /tmp/toolbox-session.json \
  --artifacts /tmp/toolbox-artifacts
```

The adapter advertises typed `fun_editor_*` tools for capabilities, inspect/query,
select/observe, preview/apply, undo/redo, presets, validation, project loading,
export, checkpoints, flush and activity. Mutations require `ifRevision`. It starts an isolated local Chromium
and serves the built static editor on loopback; `--project model.funmodel.glb` (or a
JSON project) seeds a new session. `fun_editor_importGLB` takes `data` (base64) or, through
the adapter, a local `path`; `fun_editor_exportProject` returns the project file.
`--artifacts` writes observation PNGs, GLBs and project files and returns paths;
without it CLI returns image/base64 data, while MCP observations use image content
blocks. Session JSON is saved after each request using temporary-file replacement.
A process lock prevents two adapters from overwriting one session file; stale locks
from exited processes are recovered. Use one adapter process per session file.

MCP discovery uses compact command envelopes. `fun_editor_capabilities` defaults
to a summary with command names, units, limits and unsupported features. Pass
`{command:'recipeStep'}` for one complete schema with its required definitions, or
`{detail:'full'}` for the full contract. Execution always validates the full schema,
including unknown fields. Browser `funEditor.capabilities()` retains the full
default for compatibility and accepts the same summary/command options.

For a Chrome instance already started with remote debugging, attach to one exact
existing editor tab with `--cdp http://127.0.0.1:9222 --url <exact-editor-tab-url>`.
This neither enables remote debugging nor loads/replaces the tab's project.
The existing draft writer/readonly state still applies. The adapter exposes no
arbitrary evaluation tool. The MCP transport follows the
[stdio lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
and [typed tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
contracts; nothing is hosted on fun.dev.

## Durable drafts, pending inputs and asset relationships

IndexedDB stores the project, up to five checkpoints, 30 activity records and 32
compact retry receipts. A synchronous localStorage journal stores only the current
project/revision to recover an interrupted asynchronous write. Existing v2 drafts
migrate automatically; the newest project revision wins during recovery. The
complete draft has a 32 MiB metadata budget; the 4 MiB project limit is unchanged.
No server or upload is involved. Storage availability is not guaranteed: inspect
`persistence.state` (`pending`, `saved`, `failed`, `recovery`), `revision`, `persistedRevision`
and `journalRevision`. Browser `apply` stays synchronous; use
`await funEditor.flush()` to acknowledge durability. MCP waits for IndexedDB and
then writes its optional `--session` file before replying. A failure includes the
applied revision, so retry with the original operation ID/revision or save a backup.

Parameter forms retain uncommitted values. `inspect().pendingInput` includes both
mesh and asset parameters. Apply/Rebuild or Cancel resolves the pending state;
agent mutations and unrelated GUI edits cannot silently overwrite it. Derived
parameters are read-only. Activity shows field before/after values, material users,
affected linked parts, recipe detachment and persistence status.

`funEditor.presets()` (MCP `fun_editor_presets`) returns a hollow-box definition and
ready-to-run toolbox assembly commands. The toolbar's **Parametric toolbox** uses
the same commands. Start with an empty project using the default palette:

```js
const { emptyProject } = await import("/editor/document.js");
funEditor.loadProject(emptyProject("Toolbox"));
funEditor.apply(funEditor.presets().toolbox);
funEditor.apply(
  [
    {
      op: "assemblyParameters",
      root: "toolbox",
      values: { width: 0.92, height: 0.5 },
    },
  ],
  { ifRevision: funEditor.inspect().revision, operationId: "toolbox-wide" },
);
await funEditor.flush();
```

Projects store `assemblies:[{root,name?,source?,overrides?,exposed?,parameters,bindings}]`.
Assets may nest. Each owns its subtree up to the next child asset root; parents
can drive child-root position/rotation and explicitly exposed parameter ports,
but cannot write a child's internal parts. Legacy single `assembly` projects migrate on
load, inferring their common root. `inspect().assemblies` lists all assets;
`inspect().assembly` is a convenience view of the selected asset. Imported JSON,
draft restoration and export evaluate recipes and assemblies before use, so cached
meshes cannot silently disagree with edited parameters.

Each binding names a descendant and may drive `position`, `rotation`, primitive
`options`, or mesh `recipeValues`. Expressions support
`{$param:'width',factor?,offset?}` and
`{$expr:'add'|'sub'|'mul'|'div',args:[a,b]}`. Derived parameters may have an
`expression`; dependency cycles and nonfinite/out-of-range values reject atomically.
`{$anchor:{node:'body',point:'min'|'max'|'center'|'origin',axis:'y'}}` reads the
source's geometry **in the driven node's parent frame**. Bounds include descendants;
vertices are transformed into that frame before computing extrema. A world AABB
corner is never used as an attachment point. Whole-asset translation, rotation and
nonuniform scale therefore retain the internal assembly relationships.

`assemblyParameters` takes `root`; omission is accepted only when exactly one asset
exists. The inspector shows the selected asset and its parameter owner. Driven
fields and incompatible gizmos are disabled; parameter-name buttons jump to their
inputs. `{op:'detachBinding',id:'body'}` releases only that part's bindings, keeping
its evaluated appearance. `{op:'assembly',root:'toolbox',definition:null}` releases
an entire asset. Replacing an assembly definition without `source` makes shared
parameters independent (also remove `overrides`).

Use `{op:'detachBinding',id:'hinge',fields:['rotation']}` to release only rotation
while preserving position attachment. Omit `fields` to release all fields. Detached
rotation can be edited numerically; multi-field transform gizmos remain locked
while another field is driven.
Detaching `assetValues` defaults to `mode:'keep'`: linked children retain the current
effective values as instance overrides. `mode:'inherit'` explicitly restores the
shared values instead. The UI exposes both choices; preview/apply results list
effective assembly `parameterChanges`. Removing an entire assembly also preserves
the evaluated child-port values.

Linked instances can override individual parameters without losing shared dimensions:

```js
{op:'assemblyParameters',root:'second',override:true,values:{openAngle:-90}}
{op:'assemblyParameters',root:'second',values:{},resetOverrides:['openAngle']}
```

Derived parameters are recomputed from the effective values. The inspector exposes
an override/reset button for each editable shared parameter. Source deletion freezes
the effective values and removes the link and its overrides.

For nested composition, declare `exposed:['width']` on a child asset, then use a
parent binding such as `{id:'toolbox',position:[0,0,0],assetValues:{width:{$param:'width'}}}`.
The parent owns those driven ports until `assetValues` is detached. A dependency
graph orders parameter inheritance, port writes, geometry and anchor reads; cycles
reject the entire batch. Selecting an internal part resolves its nearest asset.
Independent copies of a parent retain remapped links between their copied children.
Anchors also wait for the geometry sources of linked and mirrored parts. Validation
reports `evaluation-mismatch` when cached appearance differs from a fresh evaluation.
Duplicate results include `idMap` from every source node to its copied node; this map
survives `operationId` retries and session reloads.

Whole-asset duplication accepts `assetMode:'independent'|'linked'|'static'`:
independent copies own remapped bindings and internal instances; linked copies
share the source asset's **parameter values** while retaining their own graph and
placement; static copies retain evaluated meshes only. The desktop copy selector
names these three behaviors explicitly. Shared parameters do not imply shared
arbitrary topology edits. Deleting an asset removes its bindings and makes surviving
parameter copies independent. Deleting an anchor used by another binding is
rejected with a dependency error until that dependent binding is detached.

Face material rules can survive segmentation changes:

```js
funEditor.apply(
  [
    {
      op: "recipePaint",
      id: "knob",
      mode: "rules",
      rules: [
        {
          name: "cap",
          material: "cream",
          select: { normal: [0, 1, 0], space: "local" },
        },
      ],
    },
    { op: "recipeParameters", id: "knob", values: { segments: 12 } },
  ],
  { ifRevision: funEditor.inspect().revision },
);
```

Rules use local face queries, run after whole-mesh color and before manual face
overrides. Rule execution evaluates the complete selection (query `limit` is only
for inspection, not rule execution); apply/preview replies include `materialRules`
with matched counts, including zero matches. Generator base materials are persisted
separately from face paint. Older recipes infer and freeze the most common unpainted
cached material; if no unpainted face remains, the most common cached material is used.
Affine reflections preserve manual face identity and winding bindings.
Setting rules replaces manual overrides; `mode:'clear'` clears only
manual face bindings. Invalidated bindings report affected faces plus `recovery`
commands. The parameter panel offers directional rebinding or clearing overrides
and rebuilding in one undoable batch; canceled edits retain the original mesh.

Damaged draft records, malformed checkpoints/receipts and conflicting projects at
the same revision enter protected recovery mode. An intact IndexedDB project is
still displayed when its journal is damaged. If the project itself cannot rebuild,
the editor shows its cached mesh, or an empty recovery document when no usable mesh
remains. Originals stay read-only; startup evaluation happens before any save.
An initial database read failure also protects the draft until storage access is
restored; it cannot silently save a default project over an unread original.
`inspect().recovery` identifies the failure. `getSession()` (MCP
`fun_editor_getSession`) retains the original document and, for storage damage,
`recoverySources` with the database record and exact journal text.

The banner downloads the original project or a `fun.dev/model-recovery` JSON bundle
containing those sources. **Recover a copy** creates an independent draft from the
visible document: valid recipes remain editable, while failed dependencies recover
as static geometry. The original draft is preserved. Recovery bundles are archival
data, not ordinary `.funmodel.json` projects. MCP leaves a protected `--session`
file byte-for-byte unchanged, including on shutdown; `sessionPersistence.state`
reports `protected`. Use `getProject` to save the recoverable document to a separate
project file and start a new session when working without the GUI.

MCP mutation acknowledgments distinguish the browser draft from the optional
session file (`sessionPersistence`). A session-file failure returns structured
`code:'session_storage'`, `applied`, `revision`, both persistence states and the
original operation ID. Restore file access and retry with the same operation ID,
or inspect before issuing a new mutation. Schemas share one `$defs` per tool and
include the raw mesh vertices/faces contract.

Relationships remain declarative expressions/anchors, not a general CAD constraint
solver. Full schemas are available through `capabilities()` and MCP tool definitions.

Exports validate the actual selected scope, retain only required ancestors, and
include diagnostics in their reports. Serious geometry errors block normal export;
`force:true` explicitly exports with `report.forced:true` and retained diagnostics.
The GUI displays errors before offering the same override. The delivery report
shows dimensions, origin/axes, triangle and material-group counts, generated GLB
size, errors/warnings, and unchecked categories; JSON is expandable detail.
The camera returned by `inspect`/observations can be passed directly to MCP observe.
