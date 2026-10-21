# Character track: completion ledger

This ledger keeps the full 2026-10-20 request in scope. The requested basic authoring track has passed the final integrated acceptance
below. All changes remain local; broader roadmap extensions are not included.

| Requirement | Current evidence | Limits / final follow-up |
| --- | --- | --- |
| Safe isolated local changes | `workflow.js`, `inspection.js`, workflow tests: candidate state, atomic acceptance, revision/scope guards, parameter/follower re-evaluation and protected world vertices; final re-edit below checks actual duck undo/redo and protected chin | Three in-memory candidates; use saved projects/checkpoints for durable milestones |
| Full diagnostics and honest coverage | `errorInfo`, candidate snapshots, local/world geometry and thresholds; tests cover malformed/failed steps, scope violations and budgets; final read-only code audit checked failure paths | Missing checks remain not_checked; exhausted budgets remain incomplete; not all scene pairs or all morph combinations are implied |
| Contact, seams and thickness | Persistent sampled distance/gap/thickness rules, whole declared-pair triangle checks, validated oral volume, bounded intentional root contacts; 54 source poses and 24 actual runtime poses on the rear-wall refinement | Explicit relation/sample scope; no global minimum-thickness or continuous swept-collision claim |
| Persistent surface attachment | Position/frame/deform modes, offsets, mirror binding, ordered updates, connectivity invalidation/rebind and persistence; latest model has 10 attachments, final re-edit checks seven zero-offset anchors | Local triangle affine deformation, not whole-surface wrapping; same-target local-plane mirror |
| Boundary-driven mouth surfaces | Ordered/index/arc-length correspondence, intermediate sections, bulge/tangent constraints, caps, normal flip, shell thickness and parametric recipes; actual front/side/oblique mouth observations | Low-poly patches, not a CAD/NURBS system |
| Head shape control | Persistent generic `controlDeform` handles, mirrored local influence and recipe parameters; head width, forehead, crown/depth examples; final re-edit protects eight chin vertices | Radial control handles, not a volume-preserving cage or viewport drag gizmo |
| Morphs and expression coupling | Named targets, continuous mixing, symmetry/unilateral changes, controller attenuation, topology guards, save/undo/export; blink/smile/surprise/combination and mouth correction runtime poses | Human target refinement is selected-vertex translate/scale; arbitrary expression combinations require their own checks |
| Skeletons, binding and actions | Joint hierarchy/rest editing, rigid binding, 1–4 skin influences, key editing/loop/playback, persisted clips; stand/walk/run/jump and expression-bearing actions; final re-edit changes a walking key | Automatic weights, transfer, retargeting and IK remain roadmap extensions |
| Human editing/inspection | `duck-morph-panel`, `duck-joint-panel`, `duck-skin-panel`, `duck-character-panel` result reports: isolated preview, exact reload, undo/redo and no console errors; desktop/minimum-width screenshots inspected | Numeric controls, no curve editor or brush weight painting; existing workbench minimum width is 1024 px |
| Reference decisions and repeatable renders | `design-references.js`, immutable embedded versions, adopted features/evidence/conflicts; reference/preset browser reports show preserved selected version, unchanged geometry, same pixels after resize; five overall/three local presets and PNG/HTML overlays | Approval is recorded evidence, not automatic user consent; cross-renderer pixel equality is not claimed |
| Source versus runtime delivery | Exact stored and evaluated source comparisons; GLB split/weld statistics and versioned runtime transfer inventory; final duck stores all authoring relationships, runtime bakes supported results; Float32 positions and exact stream sharing | Runtime is not the editable source; import has explicit unsupported-curve/geometry limits; source comparison budget is five million values |
| Recovery and repeat-safe writes | `duck-connection-recovery/recovery.json`: real lost acknowledgement, same persisted document UUID, recovered revision, receipt replay without duplicate modification, conflicting ID reuse rejected | Latest 32 receipts only; unknown/evicted results require state inspection |
| Discoverable reusable APIs and compatibility | Agent schemas, command discovery, Node/MCP/browser entry points, named persisted versions and runnable examples in the iteration/character docs; audit found and fixed frame-attachment scale driver conflict | Old documents with a silently overridden conflicting scale channel now fail explicitly; use target/child pivot instead |
| Final integrated duck | `duck-backing-jaw` accepted locally; `duck-final-reedit` reopens its editable file, changes head/forehead/bill parameters and a walk key, checks 54 poses × 37 relations, anchors, protected chin and exact reload; actual runtime 24 poses × 37 relations, 14 rendered poses | Seven fixed-camera comparisons and mixed/walk/blink previews passed and were inspected; final source/runtime files and hashes are recorded in delivery.json below |

The oral lining's material shell is not oral air. The current duck derives a
validated inspection volume from its 100 inner faces and 18 aperture triangles.
The 45 authoring samples pass tongue containment; continuous motion and
containment on the older quantized file was not certified; the Float32 runtime follow-up below checks 24 samples. Earlier
exploratory failures against the material shell retain their original semantics.

### Latest seam and export follow-up

The saved rim/contact-policy source is now
`test-results/duck-rim-repair/authored.json` (editable binary alongside it).
`duck-rim-repair-browser.mjs` checks six former neutral crack pixels against
actual rendered surface hits, identical comparison cameras, undo/redo and exact
editable reload. `duck-bill-seam-policy.mjs` passes 54 sampled combinations and
rejects a deliberately raised lower bill. Version 4 intersection exceptions
bound the complete contact segment/polygon in source-local metres; root and lip
depth limits are separate sampled checks, not a global penetration-depth proof.
`duck-bill-policy-save.mjs` saves and reloads these rules without differences.
The runtime probe now includes half closure: 69 morph entries and 10 rendered
poses passed playback/parity checks with no console errors. These checks do not
certify compressed-runtime contacts.

Actual half-close renders exposed a further defect: retracting the entire oral
lining reveals the yellow head at both sides. `duck-closure-rim-study.mjs`
retains three rejected width-correction candidates (27, 29 and 27 of 54 samples
passed). `duck-oral-backing.mjs` instead constructs a persisted boundary-surface
rear wall and a closing target. Its final candidate passes the existing 54
sampled relations plus backing/tongue and backing/lining intersections and its
own self-intersection check. `duck-oral-backing-browser.mjs` renders 12 isolated
views. The front leak is covered, but the side view still exposes the retracted
lining's disconnected-looking silhouette. **This candidate is not accepted**;
it has not replaced the saved rim source, and its editable/runtime roundtrip
has not been accepted. Wall/bill contacts and full side-wall continuity remain
unverified. Artifacts are under `test-results/duck-oral-backing/`.

Export inventory is now computed after attachment animation baking, and
`exportReport` runs the same bake as file export. The focused deform-follower
test compares preflight and export reports, confirms generated targets exist,
checks their count against actual `.fun3d` meshes, and preserves the editable
source. This fixes missing generated targets in reports; the broader runtime
capability/loss declaration is now available as versioned `report.transfer`.
The actual duck inventory reports 3 recipes and 9 surface attachments baked,
10 source morph meshes and 6 skins transferred, 7 controls baked, 13 clips
sampled, and 15 relation policies, 8 view presets and 5 reference records kept
source-only on the rim baseline. Counts change as new parts are authored.
It explicitly reports `readbackChecked: false`; it does not replace runtime
readback, compressed-geometry contact checks or editable-source integrity.

### Side-wall repair accepted locally

The latest saved source is now `test-results/duck-cheeks/authored.json`, with
`duck.funmodel.glb` and `duck.fun3d` alongside it. The original rim source remains
untouched. The rear-wall-only candidate above is superseded by this combined
rear-wall and paired cheek-membrane version.

`duck-cheek-study.mjs` uses matching roof/floor boundary samples, a 4 mm thick
shell, upper-surface ray fitting, a closing target sampled from the lower lip,
and skin weights following the fixed mouth frame and jaw. Smile/surprise deltas
are interpolated from the corresponding bill surfaces and bound to the existing
controls. These are persisted recipes, targets and bindings using the generic
APIs, not new duck-specific core behavior. Original character nodes remain
exactly unchanged.

The 54 sampled combinations pass declared relationships and new-membrane
self-intersection checks. Membrane/lining intersections are intentional lateral
joins, bounded in source-local space and excluding the central tongue corridor.
Bill exceptions cover recessed underside/inner-bowl faces and bounded lateral
root caps; exterior bill bands remain checked. Separate sampled boundary-seat
distances are limited to 25 mm, and signed normal gaps to -20 mm. Signed normal
gap is a local surface measure, not a volumetric penetration-depth proof. A
400 mm detached closed-target specimen fails the declared checks and is retained
as `negative.json`.

Twelve front/side/oblique observations cover neutral, open, half-closed and
closed poses. Three before/after images keep identical cameras and quality
(`comparison-half-*.png`, before left / after right). The previously exposed
head pixels and suspended side silhouette are now covered. Existing oral
intersections, tongue containment and proximity checks still pass. Atomic
acceptance, undo/redo and exact editable reload passed; runtime playback checks
passed 76 morph entries across 10 rendered poses without console errors.
This does not certify continuous motion or contacts after compression. The
rear backing/bill seating has not received the same pair-specific audit as the
new cheek membranes; retain that in the final contact audit.

Reproduce from the retained rim baseline and integrated sample specifications:

```sh
node scripts/examples/duck-oral-backing.mjs
node scripts/examples/duck-cheek-study.mjs
DUCK_ORAL_STUDY_DIR=test-results/duck-cheeks node scripts/examples/duck-oral-backing-browser.mjs
node scripts/examples/duck-cheek-comparison.mjs
node scripts/examples/duck-cheek-save.mjs
node scripts/fun3d.mjs convert test-results/duck-cheeks/duck.funmodel.glb --type character --name duck-cheeks -o test-results/duck-cheeks/duck.fun3d
DUCK_SKIN=1 DUCK_MOUTH=1 DUCK_CLOSE=1 DUCK_DEFORM=1 DUCK_RUNTIME_DIR=test-results/duck-cheeks node scripts/examples/duck-runtime-character.mjs
```

### Runtime contact verification and export precision

The saved editable source remains `duck-cheeks/authored.json`. Its canonical
runtime `duck-cheeks/duck.fun3d` now uses Float32 base/morph positions; the earlier
quantized file is retained as `duck-quantized.fun3d`. The generic Agent action
`workflow.verifyRuntime` verifies unique base correspondence and oriented
triangles, requires exact equality of split vertex copies, and runs declared
relations on actual runtime positions. Byte/source SHA256 provenance and the
draft revision are retained. Missing/ambiguous correspondence is not_checked;
budgets are incomplete. Default summaries and full diagnostic reports are both
available. Concurrent edits are retained and make the report stale.

`duck-runtime-contact-acceptance.mjs` checks 24 distinct poses: every authored
clip's midpoint, selected previously rendered poses and nine points through the
walking cycle. The retained quantized file passes 22/24; the two fully closed
poses invalidate the derived oral volume through self-intersection/degeneracy.
The Float32 file passes 24/24 across all 33 currently declared relations, with
verified triangle correspondence and zero spread between runtime vertex copies.
The full positive/negative diagnostics are in `runtime-contact-acceptance.json`.
The change increases this file from approximately 158 KiB to 225 KiB. It retains
lossless stream compression and existing normal/skin-weight/animation encodings;
Float32 position selection does not promise every channel is lossless.

The actual browser runtime probe now renders 14 poses (including blink, smile,
surprise and their combination) and invokes the public runtime inspection API
on those same poses. All 76 morph entries, pose parity and declared contact
checks passed with no console errors; the scene remained unchanged by inspection.
Closed-mouth and mixed-expression runtime images were inspected. This establishes
sampled runtime contact coverage, not continuous motion or undeclared pairs.
The rear backing versus bill-root pair audit remains outstanding.

#### Rear backing diagnostic follow-up

`node scripts/examples/duck-backing-contact-audit.mjs` now reproduces an isolated,
unexempted audit of that previously undeclared pair. It preserves the source file
byte-for-byte and saves the candidate relations and full diagnostics to
`test-results/duck-backing-audit/report.json`. Across the same 54 source poses,
the upper boundary's nearest-surface distance stays below 6 mm. The lower
boundary exceeds the provisional 25 mm seating threshold in 16 poses, reaching
38.265 mm. Both unexempted intersection checks report contacts in all 54 poses.
These contacts have not yet been classified as intentional root seating versus
unwanted crossings; the threshold is a diagnostic probe, not an approved design
tolerance. Do not widen it merely to make the report pass. The canonical source
and runtime have not been replaced by this diagnostic candidate.

The retained open-oblique and closed-front rendered views were inspected again;
their exterior appearance alone cannot resolve the internal seating findings.
The remaining work is to establish the backing's intended lower-jaw relationship,
repair it if necessary, then repeat source/save/runtime checks on the accepted
result. Earlier 33-relation runtime passes do not cover these new probe relations.

The production build and its standalone workshop bundle also passed the focused
runtime inspection smoke example (`duck-runtime-bundle-smoke.mjs`, closed-mouth
and walking samples). The three runtime inspection tests pass, including budget,
ambiguous correspondence, duration serialization and concurrent-edit cases.

Use these commands instead of the earlier default-precision conversion above:

```sh
node scripts/fun3d.mjs convert test-results/duck-cheeks/duck.funmodel.glb --type character --name duck-cheeks -o test-results/duck-cheeks/duck-quantized.fun3d
node scripts/fun3d.mjs convert test-results/duck-cheeks/duck.funmodel.glb --type character --name duck-cheeks --position-precision float32 -o test-results/duck-cheeks/duck.fun3d
node scripts/examples/duck-runtime-contact-acceptance.mjs
DUCK_SKIN=1 DUCK_MOUTH=1 DUCK_CLOSE=1 DUCK_DEFORM=1 DUCK_VERIFY_CONTACTS=1 DUCK_RUNTIME_DIR=test-results/duck-cheeks node scripts/examples/duck-runtime-character.mjs
```

The workbench is intentionally desktop-only at 1024px minimum, as specified in
`DESIGN.md`. Phone screenshots record that existing limitation. Neither deployment
nor publication is part of this acceptance.

### Rear backing/jaw refinement accepted locally

The latest editable source is now `test-results/duck-backing-jaw/authored.json`,
with `duck.funmodel.glb` and Float32 `duck.fun3d` alongside it. The previous
`duck-cheeks` source is retained unchanged. This follow-up resolves the rear
backing audit above for the sampled acceptance range.

`duck-backing-jaw-study.mjs` uses ordinary persistent `skinWeights`,
`morphTarget`, `characterControl` and `relation` commands. The lower central
boundary follows the jaw; influence tapers towards the fixed lateral roots.
An initially rigid lower edge passed distances but introduced corner
self-intersections, which the tapered weights eliminate. The closed fold is
derived from both bill inner boundaries: where the bands overlap, a 4 mm fold
is centred between them instead of being clamped entirely to the upper band.
Smile/surprise deltas are interpolated from the designated bill surfaces.

All 54 source combinations pass the previous relations, the new 25 mm upper
and lower boundary seating checks, bounded root-contact policies, and backing
self-intersection checks. Root exceptions cover designated rear bands/hinge
caps and require the complete contact geometry to stay within the source-local
rear strip `[-.49,-.5,.8]` to `[.49,-.13,.91]` metres. Front lip and other exterior
bands remain checked. A closing target displaced 400 mm forward is rejected.
This is sampled boundary proximity and declared-pair contact coverage, not
global thickness, penetration depth or continuous-time collision certification.

Twelve actual authoring views were generated; half-open oblique, side and
closed-front images were inspected. Atomic candidate acceptance, undo/redo,
exact editable reload and preservation of every node except `oral_backing`
passed. Existing smile/surprise controls only gain backing bindings.
Actual runtime verification passes all 37 declared relations at 24 sampled
poses. The browser renders 14 poses with 78 runtime morph entries, verifies
pose parity/contact checks, and reports no console errors. Mixed-expression
and closed runtime images were inspected. See `study.json`, `negative.json`,
`save.json`, `browser.json`, `runtime.json` and `runtime-contact-acceptance.json`
in the new artifact directory.

The added bindings exposed repeated animation streams exceeding the existing
4096-stream file cap. The writer now shares byte-identical encoded streams
with matching count/stride/codec/chunk semantics. Hash buckets only select
candidates; full byte equality prevents hash-collision aliasing. No format or
cap change is required. A 4200-stream regression fixture now uses three
streams, preserving a deliberately distinct track and actual playback in both
raw and meshopt modes. The refined Float32 duck exports at approximately
155.5 KiB. Production build, local links/import checks, three focused writer
tests and `git diff --check` passed.

```sh
node scripts/examples/duck-backing-jaw-study.mjs
DUCK_ORAL_STUDY_DIR=test-results/duck-backing-jaw node scripts/examples/duck-oral-backing-browser.mjs
node scripts/examples/duck-backing-jaw-save.mjs
node scripts/fun3d.mjs convert test-results/duck-backing-jaw/duck.funmodel.glb --type character --name duck-backing-jaw --position-precision float32 -o test-results/duck-backing-jaw/duck.fun3d
DUCK_RUNTIME_POSITIVE_ONLY=1 DUCK_RUNTIME_DIR=test-results/duck-backing-jaw node scripts/examples/duck-runtime-contact-acceptance.mjs
DUCK_SKIN=1 DUCK_MOUTH=1 DUCK_CLOSE=1 DUCK_DEFORM=1 DUCK_VERIFY_CONTACTS=1 DUCK_RUNTIME_DIR=test-results/duck-backing-jaw node scripts/examples/duck-runtime-character.mjs
```

The final requirement-by-requirement and failure-path audit follows below;
this section records the rear-wall phase rather than the whole track.

### Final integrated acceptance (2026-10-21)

The delivered continued-editing example is
`test-results/duck-final-reedit/duck.funmodel.glb` (editable source) and
`test-results/duck-final-reedit/duck.fun3d` (runtime). Its `authored.json` keeps
the readable project. Previous accepted duck versions remain intact.
`delivery.json` records final artifact SHA256 values, source equality results,
coverage and limitations. The runtime is 158,496 bytes with 78 morph entries,
13 clips and all the authored action/expression relationships baked as declared.

`duck-final-reedit.mjs` reopens the saved rear-wall model, then changes head
width .085→.09, forehead width .13→.135, both bill thickness parameters
.025→.027 metres and the left wing walk key at .3 seconds by one degree.
Candidate preparation leaves the current scene untouched. Seven attachment
anchors stay within 1e-8 metres, eight chin vertices stay exact, all 37 declared
relations pass 54 source poses, and acceptance/undo/redo/reload pass. Original
baseline files remain byte-identical. This verifies continued editing after
reopening, not merely the survival of an already baked mesh.

The actual browser checks seven paired presets (five overall, eyes and mouth),
asserts identical camera/quality metadata, renders walk/blink/mixed expression
previews, then saves and reopens exactly. Front, side, eye, mouth and mixed
renders were inspected. Runtime verification renders 14 poses with no console
errors and passes 24 explicit pose samples across all 37 relationships. The
current runtime byte hash and the evaluated-source hash match those reports.
Standing/walking/running/jumping, expression blending and attached head-surface
motion are included. Continuous motion and arbitrary control-range combinations
are explicitly not certified.

One precision detail is retained rather than hidden: the browser-written source
is stored exactly, and same-host save/reload is exact. Re-evaluation in Node
changes one derived nostril-frame Z angle by 1.1102230246251565e-16 degrees.
`delivery.json.editableIntegrity.evaluated.exact` remains false for that
cross-host comparison, with the full path and values. No authoring relationship
or source field is lost; this does not imply universal bitwise equality between
JavaScript hosts. The runtime checks use the matching evaluated-source hash.

The final source-code audit covered candidate safety/scope/diagnostics,
references/comparison/recovery, attachment/boundary/control APIs, morphs,
joints/skin/animation, persistence and export. It found one real driver conflict:
a frame-attached node could accept scale animation that attachment evaluation
silently overwrote. This now fails explicitly with node/channel/path information;
the focused test proves control and clip rejection are atomic and position-only
attachments still permit scaling. Documentation discovery tables/action lists
were updated. Other deliberately limited cases remain listed in the table above.
Production build (including links/imports/assets) and `git diff --check` pass.
This acceptance was run locally; no push, publication or deployment was performed.

### Pre-commit review (2026-10-21)

The follow-up review closed candidate report/input aliasing that could bypass
protected scope, and isolated acceptance receipts from mutable API results.
Regression checks mutate returned projects, scope reports and receipts, then
confirm the validated candidate and idempotent retry remain unchanged.

Scoped runtime exports now discard unrelated inspection presets and retain
morph geometry for deform followers whose driver is outside the exported scope.
The regression compares every exported follower vertex against its source pose
at a nonzero animation time. Numeric morph names retain their dictionary index
through export and actual runtime playback. Comparison renders explicitly reuse
the baseline height as well as camera and quality. The human keyframe selector
now offers only channels permitted by each attachment mode; the actual browser
DOM check reports no console errors.

Tool discovery stays below its original 25,000-byte limit (24,642 bytes), with
complete nested schemas available through `capabilities({tool})` and unchanged
strict execution validation. The production build and focused authoring,
import/export, runtime and recovery checks pass. A separate final-duck copy in
`test-results/workshop-review-runtime/` renders 14 poses with all 78 morph
entries, checked transform/weight/skin parity and no console errors; walk,
combined-expression and closed-mouth images were inspected. These replay checks
do not extend the declared contact or continuous-motion coverage above.

The standalone workshop smoke check also covers entry paths reached through
filesystem symlinks: direct execution starts once and importing through a
launcher leaves invocation to that launcher.

Local generated candidate JSON and preview images remain outside Git. The
example directory documents which duck scripts need earlier local model files;
the API regression fixtures are independent of those files.

With the earlier local duck files present, replay the integrated acceptance:

```sh
node scripts/examples/duck-final-reedit.mjs
DUCK_INTEGRATED_DIR=test-results/duck-final-reedit DUCK_INTEGRATED_SOURCE=test-results/duck-backing-jaw/authored.json node scripts/examples/duck-integrated-browser.mjs
node scripts/fun3d.mjs convert test-results/duck-final-reedit/duck.funmodel.glb --type character --name duck-final-reedit --position-precision float32 -o test-results/duck-final-reedit/duck.fun3d
DUCK_RUNTIME_POSITIVE_ONLY=1 DUCK_RUNTIME_DIR=test-results/duck-final-reedit node scripts/examples/duck-runtime-contact-acceptance.mjs
DUCK_SKIN=1 DUCK_MOUTH=1 DUCK_CLOSE=1 DUCK_DEFORM=1 DUCK_VERIFY_CONTACTS=1 DUCK_RUNTIME_DIR=test-results/duck-final-reedit node scripts/examples/duck-runtime-character.mjs
```
