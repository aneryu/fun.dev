# Workshop → runtime implementation and acceptance

Local work, started 2026-10-23. The implementation phase authorized local changes
only. A subsequent user request authorizes committing and pushing this scoped
change; deployment and asset publication remain unauthorized.
Baseline: `main` and the locally available `origin/main` both point to
`62be3324a77a170d986495865606721b52c738a5` (2026-10-21 13:26:14 +08:00).
Remote freshness is not checked. Existing edits are preserved in place;
`test-results/workshop-toolchain/preexisting.patch` and `preexisting-status.txt`
record the starting working tree. No branch switch or reset is needed.

## Initial audit and implementation order

Statuses: pass, fail, blocked, not_checked, incomplete, unsupported. Source
presence is not verification or deployment. Node image placeholders establish
encoded-resource/geometry checks only, never shader or GPU correctness.

| Capability | Author / import / export | Runtime consumer | Host / backend | Initial verification |
| --- | --- | --- | --- | --- |
| Recipes, transactions, editable source | `document.js`, `workflow.js`, `project-file.js` | Evaluated geometry, no executable source | Node + web authoring | baseline running |
| Morph, skin, clips | Existing `morph-*`, `skin.js`, `character-animation.js` | `fun3d.js`, `animation.js` | shared core | existing tests; rerun pending |
| Texture resources | Existing UV0/base color, rejects other slots | all core maps in `fun3d.js` | image decode injected | incomplete authoring chain |
| Transmission | Workshop and writer retain factors | both classic and TSL consumers drop it | no glass guarantee | fail by source inspection |
| Required extensions | Some understood-but-dropped imports accepted | unknown required runtime extensions refused | shared | fail for editable import |
| Transfer evidence | `runtime-transfer.js` declarations, `runtime-inspection.js` correspondence | sampled geometry readback exists | Node + browser | material/resource coverage incomplete |
| Worlds, streaming, Jolt | `world-export.js`, terrain/roads/rules | `world.js`, `physics.js`, `loop.js` | shared | existing tests; rerun pending |
| Scene environment/post | studio environment is separate | `lights.js`, `post.js` exist | host context | configuration delivery incomplete |
| App sequencing | game API v3 and animator exist | no bounded timeline configuration | shared + optional web input | incomplete |
| GPU extension | required-extension rejection exists | no selected effect consumer | TSL | incomplete |

1. P0: correct required-feature rejection, capability/budget declarations and
   add reproducible source → GLB → compressed fun3d → actual load checks.
2. P1: extend the existing texture path; consume transmission in existing
   materials; deliver explicit scene configuration and real rendering checks.
3. P2: reuse game manifests, host, animator, fixed step, World and Jolt for
   A product, B character, C exploration, D timeline assembly.
4. P3: one trusted, data-parameterized TSL effect E, with validation and lifecycle.
5. Resume audit: confirm files/evidence, finish unresolved independent work.
6. Independent read-only review: rerun relevant checks and report remaining gates.

Five deterministic original fixtures: F1/A painted metal/glass toy with HDR
environment; F2/B morph+skin toy; F3/C seeded terrain/road exploration;
F4/D assembly using A; F5/E emissive ripple using A. Each needs an independent
game entry, seed, hashes, replay and assertions. Generated files belong under
`test-results/workshop-toolchain/`, never the live character files or library.

## Evidence and limits

Baseline command: `node --test > test-results/workshop-toolchain/baseline-tests.log 2>&1`.
The first sandbox attempt could not bind localhost; rerun with local-server
permission. Final outcomes and commands are appended as implementation proceeds.
The installed Three version remains pinned to 0.186.1. Existing ordinary mesh,
dense mesh, project JSON, textures, residency and preview quality budgets remain
separate. Existing source artifacts and Yello candidates are not inputs here.

Native macOS dev/product binaries and the V8 manifest exist under `../fun`;
availability alone is not acceptance. Desktop WebGPU/WebGL2 and native rendering
will be attempted. Mobile-device performance needs an actual device; desktop
mobile-sized screenshots do not satisfy it. Initial 16.7/33.3 ms and 3 s cold-load
targets stay unverified until a device, network and sampling method are recorded.

## Implemented vertical slices (local, 2026-10-23)

| Phase / capability | Author / import / export | Runtime / host | Executed evidence and scope |
| --- | --- | --- | --- |
| P0 source and fidelity | Existing transactions, revisions, source save/reopen; stricter required-extension refusal; transfer v2 distinguishes declarations from readback | Compressed `.fun3d` actual load; material objects, source-node bindings, encoded bytes, UV transforms, colour spaces and scalar readback | `fixtures/report.json`, `final-tests.log`: pass for the five bounded fixtures and regressions. Transfer declarations alone stay `not_checked` |
| P1 textures | Embedded PNG/JPEG UV0; base colour/normal/metalRough/occlusion/emissive, sampling and transforms; alpha through base-colour alpha; normal/AO strength | Existing classic and TSL material consumers; no texture-dropping batch fallback | Source → source save/reopen → GLB → compressed `.fun3d` → actual material/resource readback: pass |
| P1 glass and environment | `presentation` command stores version-1 camera, exposure, generated floating HDR/IBL, light slots, AO/bloom/saturation and MSAA choice | Physical transmission; explicit `physical` / warning-producing `opaque` / `reject` policy; `createPresentation` reuses lights/post | Hardware WebGPU and WebGL2 plus native Metal captures; opaque control differs from physical glass. Studio and target runtime are separate views |
| P2 A product | Original textured, metal and glass toy | Pointer/Enter rotates; pause/reset; same game bundle on both hosts | Desktop/mobile layouts, keyboard/touch and native options/state/captures: pass |
| P2 B character | Existing two-joint skin, one morph and sampled clip; a deliberately simple block rig | Existing animator; action triggers deformation and resets | Geometry correspondence at 0/1/2 seconds, error < 0.0002; actual native/browser state and pictures: pass. No IK/retarget claim |
| P2 C exploration | Seeded terrain/road/three-house World, near/far assets, dynamic sphere | Existing World, models, Jolt WASM and 60 Hz fixed step; fixed camera route | Collision at 3 s; ten route round trips with 60 residency samples: pass. Exploration fixture, not a new vehicle implementation |
| P2 D assembly | A asset plus bounded app-level timeline v1; transform tracks and scalar state | Core play/pause/reset/seek; camera/component/state at t=2 | Node contract, browser and native completion state/capture: pass. Physics exposes reset/replay, not seek |
| P3 E ripple | `ripple` command → saved source/GLB extras → validated `fun3d.ripple` v1 | Application explicitly registers trusted TSL module; uniform time; material excluded from generic batches; reversible disposal | Parameter/version/resource/backend/lifecycle negatives; real shaders and pixel changes excluding HUD text: pass |

Key code: `site/workshop/{materials,textures,texture-export,import-glb,runtime-transfer,document,agent-contract,viewport,world-export}.js`,
`site/runtime/kit/{fun3d,fun3d-import,fun3d-write,fun3d-schema,materials,material-features,presentation,timeline,ripple,post}.js`,
and `site/runtime/fun/{host,menu}.js`. The host's optional `snapshot()` / local
`game.inspect` keeps application state separate from rendering counters.

Three stays **0.186.1**, `.fun3d` schema **1.1**, Workshop/game API **3**, local
runtime package **0.1.0**. The package peer range is narrowed to r186 because
the newly exported presentation helpers use its RenderPipeline/TSL APIs.
The converter stamp now hashes all kit modules and pinned dependency versions.
`acceptance.json` records exact versions, hashes and native runtime fingerprint.
There was no dependency installation or upgrade. No package has been published.

Important fixes found by real rendering:

- AO's normal prepass now uses a dedicated normal material and zero MSAA,
  preventing refraction from copying an uninitialised or stale framebuffer.
- The native HUD is composited inside the final RenderPipeline. A separate
  scene render after it had replaced the scene with black pixels.
- The TSL ripple and unlit emitter now pass colour vector components correctly;
  the previous array argument compiled to a black vector. Shader source and
  pixels, rather than a changing uniform alone, caught this.
- Narrow layouts expand vertical FOV to preserve horizontal framing. Initial
  clipped mobile screenshots were replaced only after this camera fix and rerun.
- Partial-load cancellation releases textures and decoded image resources.
  `dispose()` is idempotent; registered effects restore their prior state.

## Reproduce and inspect the five fixtures

Run from the repository root; all outputs are ignored local test artifacts.

```sh
node scripts/examples/workshop-toolchain.mjs
FUNDEV_GAMES=test-results/workshop-toolchain/fixtures FUNDEV_NO_SW=1 npm run build
FUNDEV_GAMES=test-results/workshop-toolchain/fixtures npm run dev -- toy-a
node scripts/examples/workshop-toolchain-world.mjs
node scripts/examples/workshop-toolchain-native.mjs
node scripts/examples/workshop-toolchain-browser.mjs
node scripts/examples/workshop-toolchain-browser.mjs --webgl
node scripts/examples/workshop-toolchain-browser.mjs --software
node scripts/examples/workshop-toolchain-errors.mjs
node --test --test-reporter=tap > test-results/workshop-toolchain/final-tests.log 2>&1
node --test --test-reporter=tap tests/fun-host.test.mjs tests/workshop-toolchain.test.mjs tests/runtime-package.test.mjs > test-results/workshop-toolchain/final-focused.log 2>&1
node scripts/examples/workshop-toolchain-audit.mjs
```

Native runner uses installed `../fun/build/macos-arm64/product/bin/fun`; override
with `FUN_BIN`. It opens owned local windows, uses a local debug socket, waits
for actual simulation time, captures pixels and checks clean GPU shutdown.
It never edits the sibling repository. `TOOLCHAIN_KINDS=A` selects a diagnostic
subset; **only the full five-entry reports count for acceptance**.

Entries `test-results/workshop-toolchain/fixtures/toy-{a,b,c,d,e}/game.json`
are independently packable through `scripts/fun-app.mjs`. Each directory
contains `source.json`, `README.md`, `game.js`, `assets/app.json`, a resource
manifest and `evidence.json`. A/B/D/E also contain editable `.funmodel.glb` and
runtime GLB; C has exported World files plus the dynamic sphere. All generated
assets are original CC0-1.0; no third-party artwork was copied. Seed **23**,
input replay and 0/1/2 s sample points are data. Guarantees are semantic and
geometric tolerances, not cross-GPU bitwise equality.

## Validation and performance interpretation

Evidence root: `test-results/workshop-toolchain/`.

- Baseline: **580/580** tests. Final full suite: **590/590** (`final-tests.log`).
  Final focused host/toolchain/package checks: **14/14** (`final-focused.log`).
- `production-build.log`: production configuration builds and checks local
  links/modules/assets. It has zero bundled local games; the separate fixture
  build (`build.log`) validates all **five** local bundles.
- `webgpu/report.json`, `webgl/report.json`, `software/report.json`: all five
  functional checks pass on each path. Each report identifies actual backend,
  hardware status, OS/browser/adapter, 1280×800 DPR 1 and high quality, shader
  source for E, input state, captures and runtime counters. Resized 390×844
  captures and actual injected touch events check layout/input, not mobile speed.
- `native/report.json`: five actual C++/V8/Dawn/Metal runs at 2560×1440 DPR 2,
  state before/after/reset, captured pixels, binary/app/asset hashes, frame
  counters and GPU payload peak/live accounting. All end with zero live GPU
  payload and zero uncaptured GPU errors. No native frame-time percentile is
  fabricated from counters.
- `world-report.json`: ten fixed-route round trips; after each unload, zero
  geometry/texture/physics bodies and one data-only World file; after dispose,
  zero files/bodies. This is real Jolt WASM and runtime resource ownership, not
  a GPU/VRAM measurement.
- `error-report.json`: corrupt `.fun3d` shows the player error UI; restoring
  the resource and reloading recovers. Unit tests cover mid-decode abort cleanup,
  missing resources, unknown required extensions and existing format budgets.

Desktop machine: Apple M1 Pro / macOS 15.7.7, Chromium 156. Hardware WebGPU uses
Metal; WebGL2 uses ANGLE/Metal; the software run uses SwiftShader explicitly.
The browser probe samples 44 rAF intervals while playback is active, after 60
fixed semantic updates and at least four actual rendered frames. **rAF cadence
is a presentation proxy, not GPU execution time or a sustained performance
certification.** CPU update durations are separate. Exact per-fixture p50/p95,
draw calls and renderer pass-call counters are in `acceptance.json`; the current
hardware short probes are around 8.3 ms p50 and 8.9–9.3 ms p95. Software p95
is 100–216.7 ms and fails the initial 16.7 ms candidate. Renderer memory byte counters
are accounting estimates, not measured VRAM. There was no comparable pre-change
GPU baseline, so no speedup claim is made.

The initial default 4-sample scene plus AO exceeded native's per-session 512 MiB
GPU payload cap. Fixtures explicitly select zero scene MSAA; the AO prepass no
longer allocates a duplicate multisampled colour buffer. The memory limit and
16.7/33.3 ms/3 s candidate budgets were **not raised**. This quality choice is
serialized and appears in the evidence; four samples remain selectable but
are not certified for native Retina scenes with these effects.

## Compatibility, open gates and next work

Implemented and verified locally for the bounded fixture scope; **not deployed
or uploaded**. At the implementation handoff these changes were uncommitted.
The later commit/push preparation is recorded below. Existing unrelated edits
and Yello assets were preserved. The initial audit used the local `origin/main`
reference; the follow-up fetched it and confirmed the same baseline commit.

P0's bounded roundtrip and P1/P3's real-GPU exit checks pass. P2's A–D desktop
web/native functional checks pass. The broader performance/host acceptance is
still incomplete:

- `blocked`: no physical midrange Android/iOS test device; desktop mobile-sized
  views do not establish ≤33.3 ms, touch hardware behavior or native mobile support.
- `not_checked`: specified cold-network ≤3 s, sustained frame-time/GPU timestamps,
  native frame-time percentiles, cross-backend image parity and Windows/Linux.
- `fail`: software-path candidate frame budget. Functional fallback still works.
- `unsupported`: editable UV1 conversion, standalone alpha/transmission maps,
  non-default opaque IOR (explicitly refused by editable import and runtime
  conversion/writing, whether optional or required),
  arbitrary required material extensions (including unlit editable conversion),
  UV unwrapping/baking, arbitrary asset-supplied code, IK/autoweights/retarget.
- Source GLB preserves exact Workshop document semantics; ordinary external
  editable conversion may weld/polygonize/bake and is not called lossless.
  A merged export needs its explicit source-to-output mapping for node-level
  material readback; the default fixture path keeps nodes separate.
- The B block rig, C fixed-route district and A's faceted toy are test experiences,
  not finished showcase artwork or a claim of homepage-level visual quality.

Priorities after this scope: physical mobile measurement, a defined cold-network
profile and sustained GPU profiling; then more substantial licensed art and
targeted fidelity cases. Do not widen budgets or silently certify untested hosts.

## Resume audit and independent acceptance

The resume audit checks current HEAD, converter stamp, every generated asset,
native app/resources, browser source/runtime hashes, World evidence and final
checks. Its machine-readable result is `acceptance.json`. A green audit means
those checks ran and hashes matched; it does not close the open gates above.
Independent read-only review found four P2 defects. Implementation fixes were
made by the primary task, then independently rechecked without changing code,
goldens, thresholds or reports:

| Finding | Fix and independent result |
| --- | --- |
| Same-material meshes with different UV layouts crashed static merge | Bucket by material and attribute layout; retain both layouts. Regression passes |
| Black emissive factor plus a map became white after conversion | Preserve the actual factor; classic and TSL decompressed material readback passes |
| Required non-default opaque IOR was silently discarded | Explicitly reject this unsupported case in editable import and runtime writing/conversion, including optional use; default 1.5 remains allowed. Negative tests pass |
| C reset left the camera at the previous route position | Restore authored position/orientation; actual game + World + Jolt probe and browser/native reset assertions pass |

The independent focused run passed **13/13** (toolchain and native-host contracts),
and its separate C probe confirmed the full camera quaternion as well as position.
That probe did not render GPU pixels. Independent visual review inspected five
WebGPU screenshots and native A/E captures and checked artifact hashes; real GPU
reruns were performed by the primary task, not represented as independent runs.
All four findings are closed within the bounded scope. Detailed review and final
evidence verification are in `test-results/workshop-toolchain/independent-review.md`.
The final independent hash check passed for 127 source files, 22 fixture assets,
three browsers' 31 built modules each, the native executable, five native apps
and 19 native resources. P0–P3 meet the stated bounded desktop fixture exits.
The mobile, performance and unsupported-feature gates above remain open.

## Scoped commit preparation

The follow-up commit includes this toolchain and the existing UV/texture plumbing
it requires. Reference registration, Gaussian viewing, Yello processing, export
progress and unrelated asset-lock edits remain outside the commit and intact in
the working tree. Shared files are staged selectively, not replaced on disk.

An isolated copy of the exact commit content passed **550/550** tests, including
the texture/import/runtime-package focused set (**23/23**). The earlier **590/590**
result includes 40 unrelated local tests and remains the full-workspace result;
no failing or skipped test was removed to obtain the commit result. Production
and five-fixture builds also pass from the isolated copy using existing locked
build assets. The regenerated five fixture manifests, asset hashes and release
IDs are byte-identical to the validated workspace outputs, and runtime code is
unchanged, so the recorded real GPU/native evidence applies to these bundles.
Local preparation logs are `commit-tests.log`, `commit-focused.log`,
`commit-production-build.log` and `commit-build.log` in the evidence directory.
