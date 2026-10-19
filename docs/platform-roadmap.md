# Platform roadmap

Status: the [direction](#direction-decided-2026-10-19) was re-scoped on
2026-10-19 and governs everything below it. The game-platform plan was decided
on 2026-10-14; its phases 1–4 are implemented and live (API v2 shipped with
Wooden Fish 1.2.0). Asset delivery and storage, added on 2026-10-16, are
described in [assets](assets.md). Items marked Later are deferred for future
consideration, not rejected.

## Direction (decided 2026-10-19)

fun.dev's product is a **3D content production toolchain**; games validate and
show it. The decisions:

- **Product**: the workshop, the model library, `.fun3d` with its runtime, and
  parametric derivation. The small-game site stays, as showcase and test bed.
- **Users**: external AI agents and their developers, reached through
  commands with schemas (npm package, MCP, CLI) before UI. Our own agents (the
  library and Beijing pipelines, the game agents) are the first users and the
  test of every capability.
- **Outputs, equal weight**: standard GLB that works in any engine, and a
  one-stop path of `.fun3d` plus the fun.dev runtime and player that publishes
  a playable work on fun.dev.
- **Visual range**: not limited. The early phase concentrates on stylized
  low-poly (flat colours, PBR metal, glass and emission, faceted or smooth
  shading, no textures). Formats, project files and command schemas must leave
  room for UVs, textures and realism later.
- **Games** leave this public repository for one private repository,
  `fundev-games`. The platform API becomes versioned with a compatibility
  window (the player supports the current and the previous major version),
  replacing "all games upgrade together" in [Scope](#scope). The publisher
  becomes a CLI that the games repository calls. Later: game bundles uploaded
  through the console with review, open to outside developers.
- **帝都** (the Beijing driving game) is the main showcase and the stress test
  for the toolchain. The layers of the showcase are still to be decided, before
  the site redesign.
- **Model library**: public and read-only, CC0; agents search, download and
  derive through an API. Uploads and review stay internal. Later: outside
  uploads with review.
- **Workshop delivery**: local first. An npm package with a pure Node runtime
  (engine and software renderer, no browser) and an MCP mode; computation runs on
  the user's machine. The web workshop is for people to look and adjust. Later:
  a hosted API.
- **Site**: the homepage presents the toolchain (workshop, library, agent
  docs) with 帝都 as what it made, in the playful tone; games stay at
  `/games/<id>`; `/editor/` becomes `/workshop/` without the old address.

### Disposition of existing work

| Work | Status |
| --- | --- |
| Workshop stages 1–2, blueprints and derivation | Mainline |
| Model library, console, review | Mainline (public read-only) |
| `.fun3d` and runtime (kit, light slots, physics) | Mainline, as the one-stop path |
| Player and host API | Maintained; gains versioning |
| 帝都 (`game/didu`, `game/didu-fun3d`) | Moves to `fundev-games`; main showcase |
| Wooden Fish, Slap, Seal Carving | Move to `fundev-games`; maintenance only |
| Clock Out, Slap Puppet, Cyber Muyu branches | Move to `fundev-games`; Later |
| Workshop stage 4: skeletons and animation (low-poly characters) | Next after the early phase |
| Workshop stage 3: UVs, textures, baking | Later |
| Realistic humans, MetaHuman (archive branches) | Stay archived |
| China access, monitor, cleanup Workers | Maintained, not extended |
| Douyin promotion | Later, with the showcase plan |

### Early phase: exit criteria

The early phase ends when all three hold:

1. A fresh Claude agent and a fresh Codex agent with no fun.dev context,
   following only the homepage's agent docs, install the package and build
   models that pass library review (a lamp post, a sedan, a building), unaided
   and at no more cost than the Blender route.
2. 帝都 M1 (a drivable Beijing block: road kit, vehicles, building families,
   signals) is made entirely with the toolchain; no model comes from Blender.
3. The library and Beijing pipelines no longer use Blender; they report gaps
   in the toolchain instead of working around them.

Then workshop stage 4 follows; stage 3 comes after it or earlier if a real
need appears.

### Order of work

0. Rewrite `AGENTS.md` and this roadmap for the direction (done 2026-10-19).
1. Pure Node workshop runtime, published as an npm package with an MCP mode.
2. Public read-only library API; search, open and derive in the workshop.
3. Versioned platform API with the compatibility window; games move to
   `fundev-games`; the publisher becomes a CLI; `games/` leaves this repository.
4. Site redesign: toolchain homepage, `/workshop/`, agent docs (after the
   showcase layers are decided).
5. The outside-agent acceptance test (exit criterion 1).

## Scope

The rest of this document records the game-platform plan of 2026-10-14 and
the workshop and parametric plans of 2026-10-18 and 2026-10-19; where it
disagrees with the direction above, the direction wins.

- Game types: tap/idle/casual, puzzle/turn-based, and arcade/action.
- Layering: capabilities that need cross-game state, user preferences,
  browser-level coordination, or a server belong to the host (`context.*`).
  Gameplay helpers belong to a shared runtime kit at `/runtime/kit/*.js`.
- The kit and Three.js are served from single, unversioned runtime paths.
  All games upgrade together with the platform; there is no backward
  compatibility layer. A contract upgrade accepts a short outage and
  possible Pages rollback mismatch.
- Game sources live in this repository as `games/<id>/`, one source tree per
  game. Versions are recorded in `game.json`; history is kept by Git and the
  immutable R2 releases. Builds generate local preview bundles from these
  sources.

## Host capabilities (API v2)

All contract changes ship together in one API v2 cutover.

| Capability | Decision |
| --- | --- |
| `context.audio` | One shared `AudioContext` and master gain node. The host unlocks audio on the first gesture, suspends it while paused, and offers global mute/volume in the player menu, remembered across games. Games no longer draw their own mute buttons. |
| Safe area | Display cutouts plus the area reserved by the player menu button, so games can keep HUD clear of them. |
| `reportLoading(fraction)` | Progress bar on the loading screen. |
| `adaptiveResolution` | Opt-in. The host lowers the pixel ratio in steps during sustained frame drops and notifies the game through `resize`. No device tier guessing. |
| `announce(text)` | Host-owned `aria-live` region, rate-limited and coalesced. Canvas `aria-label` changes are not reliably announced. |
| `haptics` | Preset patterns over `navigator.vibrate`, with a menu toggle next to mute. Silently ignored where unsupported (iOS Safari). |
| Wake lock | Manifest `keepAwake`; held while running, released while paused. |
| Orientation lock | Manifest `orientation` plus a rotate prompt; `screen.orientation.lock` in fullscreen where supported (Android). |
| Game options panel | See below. |
| `pickImage()` | Added 2026-10-15 for Slap: the host owns the file input so games stay canvas-only; returns an upright, scaled `ImageBitmap` that stays on the device. |
| `deviceStorage` | Added 2026-10-15 for Slap: per-game blobs that stay on this device, so a picked photo is remembered without entering progress, transfer or export. |
| Vision runtime | Added 2026-10-16: MediaPipe Tasks Vision and its models are platform runtime (`kit/vision.js`), pinned like Three.js and downloaded only when used. See [assets](assets.md). |
| WebGPU renderer (API v3) | Added 2026-10-17: the host renders with `THREE.WebGPURenderer` (`three/webgpu`): WebGPU when the browser offers a hardware adapter, otherwise its WebGL 2 backend (`?renderer=` overrides). Materials are TSL node materials; GLSL (`onBeforeCompile`, `ShaderMaterial`) no longer runs, so the API version moved to 3 and every game was ported. `context.graphics` reports backend and tier (phones `low`: low-power GPU; desktops `high`: high-performance GPU), and `setRenderPipeline` lets a game draw through a postprocessing pipeline. The adapter request starts with the player page and the device with the bundle download, to hide WebGPU's start-up time. See [game bundles](game-bundles.md#rendering). |
| Video recording | Added 2026-10-16 for Slap: manifest `recording` puts **Record video** in the menu. The host copies each rendered frame into a 9:16 canvas with a watermark and records it with the session's sound through `MediaRecorder`; the clip stays on the device until shared or saved. |
| `shareText(locale)` | Optional lifecycle hook used by the platform share button. |
| Manifest fields | `orientation`, bilingual `howToPlay` (shown in the player menu as real text), and `cover`. |

### Game options panel

- `game.js` statically exports `options` beside `createGame`. The host reads
  them after import, validates and restores stored settings, passes current
  values as `context.options`, and calls `optionChanged(id, value)` on changes.
  `context.updateOption(id, { disabled, max, value })` adjusts state at runtime.
- Control types: `toggle`, `range` (min/max/step), `choice`, and `action`.
  Labels use `{ zh, en }`.
- Two sections: `settings` persist per game in `localStorage` on this device
  only (not transferred or exported); `cheats` last for the current session.
- Each item declares `audience: "player"` (shown in the menu) or `"debug"`
  (shown only with `?debug=1`).
- Whether a session with cheats saves progress is the game's decision. The
  host reports which cheats are active.
- Platform-wide switches such as mute and haptics are not part of this panel.

## Runtime kit

Each module is written together with the first game that needs it.
`text.js` and `input.js` can start by extracting code from Wooden Fish.

- `text.js`: Canvas 2D text with system fonts rendered into a
  `CanvasTexture`, for camera-attached HUD planes and in-world sprites/planes.
  Re-rasterizes for the pixel ratio and only when content changes; supports an
  explicit raster resolution for world-space text.
- `input.js`: pointer normalization (viewport pixels, tap/drag/long-press,
  multi-touch); action mapping across keyboard, touch, and gamepad; virtual
  joystick/buttons drawn in Three.js with `text.js`.
- `loop.js`: fixed-step accumulator with interpolation, consistent on 120 Hz
  displays.
- `assets.js`: `asset()` resolution, `signal` cancellation, automatic
  `track`, and loading progress. Textures may be KTX2, which stays compressed in
  GPU memory.
- `post.js` (2026-10-17, with the WebGPU renderer, ahead of its first game): one
  render pipeline with GTAO ambient occlusion (high tier only), bloom (half
  resolution on the low tier) and a light grade, for games that want a richer
  look without writing their own pipeline.
- `random.js`: seeded random numbers and a daily seed by UTC date by default
  (configurable time zone).
- Three.js addons served by the platform at the same pinned version:
  `GLTFLoader`, `DRACOLoader`, `KTX2Loader` and `OrbitControls`, with
  self-hosted decoders, and the postprocessing nodes `BloomNode` and `GTAONode`
  (their TSL imports share `/runtime/tsl.js`).
  Their loaders create Blob URL workers and compile WebAssembly, so only
  game pages (`/games/*`) relax CSP with `img-src`/`connect-src blob:`, `worker-src blob:`,
  and `'wasm-unsafe-eval'`. The site-wide policy is detached with
  `! Content-Security-Policy` and replaced; adding a second policy would only
  narrow it.

## Platform and tooling

- Low-poly workshop at `/editor/`: static model authoring with shared human/agent
  commands, editable projects, geometry diagnostics and GLB export into the existing
  asset pipeline. See [model editor](model-editor.md) for the desktop scope and limits.

### Workshop: replacing Blender (decided 2026-10-18)

Goal: the workshop takes over as much of Blender's work as possible. Blender's users here
are agents (the library uploader, the Beijing asset pipeline, the game pipelines), so every
capability is an agent command first; the page adds only the most common controls. Projects
are GLB files with the editable document in a `FUNDEV_workshop` extension: one file both
previews anywhere and edits in the workshop. Libraries: manifold-3d (solids), later xatlas
(UVs) and three-mesh-bvh (baking, weight transfer), loaded only by the workshop.

1. **Static flat-colour models** (the library's props and pieces, 93% of it): PBR materials
   (metal, emission, opacity, glass), node renaming and named copies, export naming
   conventions, booleans, outlines with holes, revolve, basic mesh editing (delete, weld,
   bridge, fill, connect, solidify, separate, join), sweeps and arrays, rounded outlines,
   static GLB import, library integration (workshop source files, "open in workshop"),
   reference images, an agent runtime package that needs no repository, limits of 50,000
   triangles and 512 parts.
2. **Organic shapes and large models** (food, plants, rocks, terrain, whole buildings): binary
   mesh storage and incremental history, subdivision (smooth shading came early, with
   round shapes and curves in outlines, 2026-10-19), procedural shaping
   (displace, inflate, smooth, soft selection, voxel remesh, decimate), scatter and
   instancing, scene assembly from library models.
3. **UVs, textures and baking**: corner attributes (two UV sets, vertex colours), unwrapping
   and packing, textures embedded in GLB, AO/normal/colour baking and direct-light
   lightmaps, compression, LOD chains, colliders.
4. **Characters and animation**: skeletons (Mixamo template, rest-pose fixes), automatic
   weights and weight transfer, shape keys, animation import, retargeting and baking.
5. **Parametric humans**: the MakeHuman CC0 data (base mesh, targets, rigs, proxies) read
   directly for body sliders and fitted clothes and hair; non-rigid wrapping onto the shared
   topology; projection of reference views onto UVs.

Later: Cycles-quality global illumination baking, cloth and fluid simulation, a general
geometry-nodes system, arbitrary third-party FBX rigs.

### Parametric and procedural: extend and derive (decided 2026-10-19)

The owner's second pillar beside the format: content is programs and parameters at the source,
data at runtime. Runtime files (`.fun3d`) stay compiled data; derivation happens at build and
conversion time, deterministic and cached by (source, generator, parameters). What exists and
what follows:

1. **Done**: parameter recipes per mesh and asset parameters with bindings and expressions
   (workshop stage 1); runtime parameters in the format (placements with tints, morph targets,
   emitter roles; variants and references in release 2); **blueprints** — parametric families
   (`site/editor/blueprints.js`: lamp post, railing, building block) built by
   `{op:"blueprint"}`, re-derived by `assemblyParameters`, stamped on the asset, and
   `npm run derive` writing library upload folders with their provenance
   ([model editor](model-editor.md#blueprints-and-derivation)).
2. **Next**: blueprints for the library's commonest families (trees, benches, signs, fences,
   kit pieces), each judged against the library's hand-built counterparts; the model pages and
   the console showing a model's family and parameters (`extra.blueprint`), with "derive" in the
   console; scatter rules (along a path, on a surface, on a grid) whose result is placements
   (workshop stage 2); game builds deriving variants with the same blueprints (`derive` beside
   `convert` in `game.json`), so a city gets fifty lamp heights without fifty uploads.
3. **Later**: node graphs for shading (`fun3d.nodes`), generators over textures and baking
   (stage 3), parametric humans (stage 5).

- Regression gate: a Playwright smoke test for every catalog game at mobile and
  desktop sizes: reaches running, no console errors, non-blank canvas,
  menu pause/resume, language switch, restart, and error-free cleanup when leaving.
  Routine kit/host changes test the live R2 catalog through a local proxy;
  contract upgrades test the local game sources about to be published.
- Share previews: the build fetches the R2 catalog and writes each game's page at
  `/games/<id>` with its Open Graph tags (Chinese), so the game's address is its share link.
- PWA: web app manifest (installable, `display: standalone`, which is the
  only near-fullscreen mode on iPhone) and a Service Worker for offline play of
  previously opened games. Pages, host, and catalog are network-first with a
  3-second fallback to cache; immutable releases are cache-first; a new worker
  takes over only after all tabs close; the host refuses catalog entries whose
  `apiVersion` differs and asks for a refresh. The publisher writes an
  immutable `files.json` per release so the worker can cache it completely.
  The runtime is precached as one hashed set. Total cache size is bounded (LRU):
  since 2026-10-16 by 300 MB rather than a number of games, with blobs shared by
  several games kept until none of them is cached (see [assets](assets.md)).
  Release files under a `lazy/` directory are cached on first use instead of with
  the release (added 2026-10-15 so Slap's 17 MB face model downloads only for photos).
- `npm run dev`: watches `site/`, `games/`, and the kit, rebuilds `dist/`,
  serves it with the production headers, and reloads pages through
  server-sent events. The reload script exists only in dev mode, which never
  registers a Service Worker. `npm run dev -- <id>` prints the player URL with
  `?debug=1`.
- `?debug=1` in the player shows frame rate, draw calls, and GPU memory, plus
  `debug` options.

## Phases

1. **Foundation** (no contract change): single-repository game sources,
   smoke test gate, `npm run dev`.
2. **API v2 cutover**: every host contract change above, with Wooden Fish
   migrated in the same release; one outage.
3. **Kit on demand**: modules land with the first game that needs them.
4. **Share pages and PWA/offline**.

## Conventions to update

- [Game bundles](game-bundles.md) currently says the platform has no game UI
  API. The options panel and `howToPlay` are platform-rendered from game
  declarations; rewrite that principle in phase 2.
- `DESIGN.md` specifies a text-only lobby list. Update it before adding cover
  thumbnails.
- The `fun-dev-games` skill assumes games are developed in their own
  repositories; rewrite it for this repository's `games/<id>/` layout.
- The publisher reads game sources from `games/<id>/` and, in phase 4, writes
  `files.json`.

## Later

Deferred for future consideration:

- Online leaderboards (requires D1, an API, abuse prevention, and nickname
  moderation).
- A platform score/records API with lobby personal bests (requires changing
  IndexedDB, export, and transfer formats).
- A DOM overlay layer for game HUD.
- Transferring game settings between devices.
- WeChat share cards (require the official-account JS-SDK).
- Real-time multiplayer.
