# Candidate modeling and inspection

The duck v7/v8 study exposed a gap between individually safe calls and a safe script.
This workflow reuses the document evaluator, atomic replacement, history, recipes,
surface diagnostics and viewport. It adds no service or alternate geometry validator.

## Audit (2026-10-20)

| Classification | Existing capability and code | Finding |
| --- | --- | --- |
| Available | `document.js:createStore`, `engine.js:preview/loadProject/checkpoint` | Atomic apply, isolated preview, undo and persistent checkpoints already work. |
| Script problem | Study v7/v8 `duck.mjs`: `ws.load` before `ws.apply` | The successful empty replacement cannot be rolled back by a subsequent failed batch. |
| Hard to use | `diagnostics.js:surfaceDiagnostics`, `document.js:validateProject`, `editor-script.mjs:compactError` | Face IDs and intersections exist; the script previously truncated issues and discarded `checks`. |
| Missing | Failed geometry inspection | Previously rejected candidate geometry was unavailable to the caller. |
| Hard to use | `components.js:queryComponents`, `spatial.js:nodeInfo`, viewport picking | World coordinates and normals exist, but pixel-to-surface and contact sampling lacked a script entry point. |
| Missing | Declared joins | Independent valid shells do not prove contact. Samples are measurements, not automatic intent classification. |
| Available | `viewport.js:renderProject/renderViews`, `preview-quality.js` | Isolation, clay/silhouette, camera matrices and quality metadata already exist. |
| Hard to use | `recipe.js`, `changes.js:describeChanges` | Stable IDs and local parameter updates exist; protected scope and reusable comparison orchestration were absent. |
| Hard to use | `import-glb.js:importModel`, `project-file.js`, `viewport.js:exportAsset` | Pure conversion can run without replacing the draft; scripts were importing sequentially into the live document. |
| Available | `agent-connection.js`, `workshop-bridge.mjs`, `engine.js` receipts | Loopback token/origin checks, one writer, operation receipts and revision checks remain in force. |

All workshop source files above are under `site/workshop/`; adapter files are under
`scripts/`. The supplied comparison manifest identifies its generated images as AI
references, not model measurements. Visual resemblance remains a modeling judgment.

## Safe default

For a complete rebuild use `ws.replace({name, materials, commands})`. It prepares and
validates a candidate, then replaces once at its original revision. For local work:

```js
const proposal = await ws.candidate({
  commands: [{op:"recipeParameters", id:"eye", values:{width:0.2}}],
  protectedIds: ["head", "body", "feet"],
  provenance: {parameterVersion:"v2", source:"model.mjs", sourceHash:"your-sha256"},
  file: "proposal.json",
});
if (!proposal.ok) return proposal; // Includes full diagnostics and an isolated error view.
await ws.accept(proposal, {operationId:"eye-v2-accept"});
```

Use the actual recipe parameter names. `protectedIds` protects descendants, ancestor
transforms and material users too. `scope.nodes` distinguishes connectivity changes
from coordinate changes. Both can invalidate query references: re-query after acceptance.
`scope.fields` retains the existing explicit `truncatedFields` marker; full projects are
available with `detail:"full"` and parameters remain in them.

The shared API is `workflow({action:"prepare"|"inspect"|"diagnose"|"surface"|
"relations"|"verifyExport"|"verifyRuntime", ifRevision, candidateId?, ...})`, plus
`acceptCandidate({candidateId,ifRevision,operationId})`. MCP exposes both.
Prepare accepts a full project, commands against it, or commands against the current draft.
Only acceptance mutates the draft. There are three in-memory candidates; old candidates
expire on eviction or reload. Save the report/project to retain one. A stopped batch has
`candidateComplete:false`; its retained geometry is the rejected command's inspection
snapshot, not an executable completed script. Syntax/normalization failures can precede
geometry construction; those report the error without fabricating an error view.

Failed preparation returns `applied:false,partialCommit:false`. This describes that call.
Script errors also report whether earlier mutating calls in the script already committed.
There is no implicit rollback of arbitrary scripts. A failed durable save after acceptance
can have `applied:true`; inspect the revision and original operation ID before recovery.
Use existing checkpoints for named durable milestones; acceptance itself is undoable.

## Diagnostics, surfaces and joins

`ws.validate({detail:"full",file:"validation.json"})` preserves structured errors and
coverage. Its compact default retains `checks`. `ws.diagnose({candidateId,file})` exposes
`surfaceDiagnostics` with local coordinates, world matrices, scan limits and truncation.
Failed candidates include local/world intersection positions, face vertices and edges.
Requested `views` render error faces using existing selection/wire overlays and isolation.
Dense surface scans remain unchecked. Neither candidate acceptance nor export uses a
force override.

```js
const hit = await ws.surface({ids:["head"], at:[0.4,2.5,1], offset:-0.002});
// hit: node, face, vertices, point/localPoint, normal, distance, normalDistance, offsetPoint.
await ws.fit({id:"eye", at:eyeContactPoint, targets:["head"], offset:-0.002});
const seam = await ws.surface({
  ids:["upper_bill"], path:lowerLipWorldPoints, spacing:0.005, tolerance:0.003,
});
// Every segment includes interior samples; seam.samples identifies the worst points.
const pixel = await ws.surface({observation:shotMetadata, pixel:[x,y]});
```

All input measurements are world-space metres. `fit` translates the chosen contact
anchor to the closest surface plus its normal offset; it does not rotate or deform the
part. Negative offsets permit intentional embedding. `normalDistance` is a local normal
projection, not a watertight-solid inside/outside test. Sampling tests supplied polylines
or a region covered by such paths, not a continuous collision proof. Increase density
around corners; at most 4096 samples are allowed. It does not claim minimum wall thickness
or whole-object intersection coverage. Pixel queries use recorded camera matrices,
top-left pixel coordinates and the observation's visible parts. Misses explain whether
the pixel was outside the image, there were no target meshes, or the ray missed.
Images from a different revision/candidate are rejected.

## Repeatable visual comparison and export

`ws.compare({baseline,candidate,views,reference?,overlay?,file})` writes a self-contained HTML
comparison, individual PNGs and a JSON manifest. `views` is a named configuration map:

```js
const views = {
  front: {view:"front", size:512, shading:"material"},
  side: {view:"left", size:512},
  eye: {view:"front", ids:["eye","head"], size:512, camera:eyeCamera},
  mouth: {view:"left", ids:["upper_bill","lower_bill"], size:512, shading:"clay"},
};
```

The baseline's exact camera/projection, studio light placement/shadow range, exposure
and sampling are reused for the candidate. Each image carries revision, candidate ID,
provenance and render metadata; filenames include candidate IDs. A supplied reference
is explicitly labeled **reference**, alongside **real model render**. Reference
cropping is not implemented; provide a previously cropped reference. The configuration
is ordinary script data that can be versioned with model parameters.

`ws.verifyExport({file:"roundtrip.json"})` exports standard GLB and an editable container,
imports both into isolated documents and reports parts, transforms, materials, bounds
and geometry counts. `generic.processing` attributes count changes to welded collapsed
triangles versus polygon reconstruction. It does not certify visual equivalence from
counts alone. Export options here are the default world-space, unmerged form; use existing
export reports for origin shifts and merged delivery. The current project, selection,
camera and undo history are untouched.

Use `report.editable.integrity.exact` to assess source preservation. It compares
the complete original project with both the file's embedded source (`stored`)
and the source after evaluation (`evaluated`). Unlike the concise activity log,
this includes every persisted field: clips, controls, bindings, skin weights,
morph deltas, reference bytes, named views and future metadata fields.
Numbers are compared exactly, without geometric tolerance; dense/typed buffers
are compared by contents rather than object identity. This is source equality,
not a claim of runtime pixel or generic GLB import equality.

Each comparison returns `status: "passed" | "failed" | "incomplete"`, `complete`,
`comparedValues`, `totalDifferences`, and up to 100 differences with JSON Pointer
paths and bounded value summaries. It checks at most five million values; reaching
that budget makes `exact` false. `truncated` only limits displayed differences,
not comparison coverage; use `complete` to distinguish the two. Missing subtrees
are reported at their root. An empty `scope.fields` or unchanged vertex count is
not a substitute for this check.

```js
const report = await ws.verifyExport({file:"roundtrip.json"});
if (!report.editable.integrity.exact)
  throw new Error(JSON.stringify(report.editable.integrity));
```

`scripts/examples/duck-export-integrity.mjs` verifies the saved duck and separately
probes loss of character, relations, references, view presets, attachments, morphs,
skin and joints. These probes modify isolated copies only.

`ws.verifyRuntime({runtimeFile,poses,relationIds?,mapping?,detail?,file?})`
checks declared relations using the actual `.fun3d` geometry at explicit clip
times. It retains byte/source hashes and checks correspondence before using
source policies; see [runtime inspection](workshop-characters.md#runtime-inspection-and-export-reports)
for limits, coverage and a complete example. This is separate from editable
source equality and does not mutate the draft.

The Agent panel now includes draft ID, revision and writable state. Transport failures
distinguish service availability, invalid connections and a result acknowledgement lost
after a command began. A browser pagehide still detaches using the existing lifecycle;
unexpected tab crashes are detected by bridge timeouts, not positively diagnosed as tab
closure. Do not blindly replay writes. Candidate IDs expire when their page disappears;
saved diagnostics plus the original revision and operation receipt guide recovery.

After reconnecting, query `inspect` and compare `documentId` with the original
request's document identity. `operationStatus({operationId})` is a compact,
read-only receipt lookup (also exposed as `fun_editor_operationStatus`):

```js
const state = await ws.inspect();
if (!state.documentId || state.documentId !== originalDocumentId)
  throw new Error("Different or unidentified document");
const recovery = await ws.call("operationStatus", {operationId: "head-wide-1"});
if (recovery.status === "recorded") {
  // Inspect recovery.receipt.revision; retry only the original request and id.
} else {
  // "unknown" is NOT "not applied": inspect state/history before another write.
}
```

The result includes current draft identity/revision, persistence state, the
recorded operation result, and the retention limit (latest 32 operations).
`draftId` is a local storage slot (often `default`); `documentId` is a UUID saved
in session metadata. It identifies the editable history across reloads, rather
than the model file: replacing/importing a model within that history keeps the
id and advances the revision. New writable legacy sessions acquire an id;
protected legacy sessions may return null until recovered. Persist this id with
the original request, and still check the revision and saved state.
Receipts survive a browser reload after durable save. They describe historical
operations: undo does not remove them, and a replay does not reapply an undone
edit. A missing/evicted receipt cannot establish non-execution. Keep the original
request, operation id and document identity in the caller's recovery record.

`node scripts/examples/duck-connection-recovery.mjs` exercises the real loopback
bridge and browser: it drops one `/result` acknowledgement after durable mutation,
waits for the bridge's unknown-outcome timeout, reloads the page, confirms the
same draft and incremented revision, queries the saved receipt, and retries
without another geometry change. Reusing that id with different commands must
fail. The example uses an isolated browser context and temporary bridge file.

## Duck acceptance example

From the repository:

```sh
DUCK_STUDY_ROOT=/absolute/path/to/outputs \
  node scripts/editor-agent.mjs --run scripts/examples/duck-workflow.mjs
```

The input directory contains `duck-study-v7/`, `duck-study-v8/` and
`duck-reference-comparison-v1/`. Inputs are never overwritten. Run in a fresh local
workshop; the example intentionally accepts its baseline and v8. It writes to
`test-results/duck-workflow/` and checks:

- A mouth-cavity vertex displaced by 0.5 m produces a rejected self-intersecting
  candidate and an isolated highlighted PNG, while the original project stays intact.
- Only eye/mouth changes are accepted; head, body, wings, legs, feet, tail and crest
  remain protected, including their world transforms and material dependencies.
- The outside mouth-corner rim is sampled every 3 mm at a declared 10 mm tolerance.
  The supplied v7 has 25 failing samples out of 33, maximum distance 48.57 mm;
  v8 has zero out of 36, maximum 4.68 mm. Different geometry lengths produce different
  sample counts. This excludes the intentionally open inner lip.
- Real eye and tongue anchors are translated along target normals with 2 mm and
  1 mm embedding, re-sampled, then undone to preserve the authored v8.
- Front, side, oblique, eye, mouth, clay and silhouette views use locked cameras
  and studio settings. The HTML and JSON retain AI-reference and render provenance.
- Editable roundtrip stays at 1750 triangles. Standard GLB roundtrip has 1742:
  polygon reconstruction accounts for upper bill −4, mouth cavity −2 and tail −2;
  no triangles were collapsed by the welding pass.

`acceptance.json`, `corner-contact.json`, `normal-fit.json`, `scope.json`,
`validation.json`, `roundtrip.json` and `comparison.html.json` are machine-readable
evidence. These measurements are specific to the supplied study versions, not
platform constants or automatic judgments of resemblance.

## Portable reference versions and design decisions

Draft `setReference` overlays remain view-placement aids. `referenceRecord`
commands instead append immutable records to `project.designReferences`
version 1; they are included in JSON and `.funmodel.glb`, not runtime geometry.
The reference dialog can load an archived image into a view, save the current
overlay as a new version, and display recorded decisions. These actions use
normal project history, candidates, revision guards and undo.

An image record is `{id,kind:"image",text,origin,image}`: origin is `user`,
`generated`, `render` or `external`; image is an embedded PNG/JPEG/WebP/GIF data
URL, at most 8 MB. There are at most 128 records and 32 MB of embedded data.
No network fetch occurs. Each id identifies one version. To revise, append a
new id with `supersedes` and `reason`; replacing an existing id fails.
`referenceSelect {ids:[...]}` records adopted image versions (an empty list
clears the choice). Adding a newer image never selects it automatically.

A feature record is `{id,kind:"feature",text,status,references,evidence?}`.
Status is `proposed`, `accepted` or `rejected`; non-proposals require evidence.
`references` names exact existing image-version ids; it may be empty for a
text-only user requirement. A proposal cannot supersede an accepted feature.
These are authored records of a decision, not proof that a human approved the
current render; agents must not invent approval evidence.
A decision record `{id,kind:"decision",text,references}` records conflicting
perspectives and explicit tradeoffs. Old records remain available when
superseded, and merging projects remaps all ids and references.

```js
await ws.apply([{ op: "referenceRecord", definition: {
  id: "keep-cheeks", kind: "feature", text: "Preserve cheek volume",
  status: "proposed", references: [],
} }]);
const saved = await ws.call("getProject");
// Inspect the exact portable records and images:
console.log(saved.designReferences);
```

`inspect`, standard observations and candidate observations expose summaries
without image bytes. Comparison JSON associates each render's document/candidate
revision with its selected versions and decisions; the HTML displays them.
`ws.compare` now includes an opacity slider over the aligned before/after renders
(disable with `overlay:false`). It does not align unrelated reference photographs
or imply pixel equivalence between differing perspectives.

Run `scripts/examples/duck-reference-history.mjs` through `editor-agent.mjs --run`
for the real duck study, then `node scripts/examples/duck-reference-panel.mjs`
after a production build for the manual dialog and comparison checks.
The study records the user's head-shape requirements as direction, while keeping
the new closed-mouth render explicitly proposed. Editable export/reload preserves
all records; standard GLB/fun3d meshes omit them. Older workshop readers that
predate this optional project field may discard it: reopen editable sources with
a current reader. Direct whole-project replacement is not a tamper-proof audit log.

## Saved inspection views

`project.viewPresets` stores up to 64 named version-1 presets. Each fixes a
standard view name, width (`size`) and `height` in pixels, world-space camera
(metres), studio/shadow framing, shading, antialiasing, exposure and optional
node ids. Camera fields and the studio version are validated when saving or
loading; a missing node dependency fails explicitly. Rename and editable merge
remap node ids. Removing a referenced node requires updating/removing the preset.
Presets are editable-source metadata, not runtime cameras. Older readers may
discard this optional project field.

```js
await ws.saveView("eyes", {
  view: "front", ids: ["eye_left", "eye_right"], size: 512, height: 384,
});
await ws.observe(["front"], { preset: "eyes", file: "eyes.png" });
await ws.compare({ baseline, candidate, views: { eyes: { preset: "eyes" } },
  file: "eyes-comparison.html" });
```

`ws.saveView` captures a real observation and submits the normal
`viewPreset {id,definition}` command. Direct API users can construct the same
definition from `observation.camera`, `quality.lightingSetup`, quality fields,
width/height, view and visible node ids; `view-presets.js` exports
`presetFromObservation` for this conversion. `removeViewPreset {id}` removes it.
Use `inspect().viewPresets` or `getProject()` to discover saved definitions.
All writes support candidate scope (`allowed.projectFields:["viewPresets"]`),
undo and normal revision/operation-id handling.

`observe({preset:"eyes"})` and
`workflow({action:"inspect",render:{preset:"eyes"}})` restore saved dimensions
and rendering settings. Explicit render options may override them; observations
retain both the preset definition and actual camera/quality. Comparison uses
the baseline's actual camera and lighting for both sides. Presets fix world
framing; they do not automatically follow moved parts or align unrelated photos.
The UI's Save view dialog can save the current view under a name or download an
existing preset. Fixed output height preserves non-square captures when the
window changes size. Path walkthrough height remains metres and is separate
from image height; a fixed preset cannot also be a walkthrough.

`duck-view-presets.mjs` creates front/side/back/top/three-quarter and
eyes/mouth/feet presets, checks local comparisons and verifies editable export.
`duck-view-preset-panel.mjs` exercises the dialog, downloaded pixels and exact
camera/image reproduction at 1440px and 1024px window widths.
Pixel reproducibility is checked within the same renderer backend. Software and
WebGL observations still report their actual backend and sampling; a saved
preset does not make different rasterizers pixel-identical.
