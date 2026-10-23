# Game hosts: the web player and fun

Status: decided 2026-10-19 ([roadmap](platform-roadmap.md#direction-decided-2026-10-19)). The
kit's seams (step 1 below) are implemented and the web host provides them; the fun host adapter
and the publisher output are not yet. The first game on fun is 帝都.

A **host** is what runs a game bundle: it owns the window, the Three.js renderer, the frame
loop, input, audio, storage and assets, and hands the game the `context` of
[game bundles](game-bundles.md). There are two hosts:

| Host | Role | Where |
| --- | --- | --- |
| Web player | Preview, share link, the agent-facing path, pixel reference | `site/runtime/core/host.js`, `site/player/` |
| fun | Shipping: native Android, iOS, macOS, Linux and Windows apps | `../fun` (C++ + V8, Dawn WebGPU, native Jolt); the host adapter lives here |

Games and the **runtime kit** (`site/runtime/kit/`, `site/runtime/core/`) are written once
against the same contract and run on both. The kit is the shared JavaScript layer: it must not
touch the DOM, `fetch`, `window` or any other browser global directly, only what the host
hands it. `tests/runtime-hostless.test.mjs` imports every kit module in Node without a DOM;
the seams below move the remaining call-time uses behind the context.

## What the host provides, what is shared

| Context member | Provided by | Web player | fun |
| --- | --- | --- | --- |
| `THREE`, `scene`, `camera`, `renderer`, `graphics`, `setRenderPipeline`, `viewport`, `invalidate` | host | `WebGPURenderer` on a page canvas | `WebGPURenderer` on `fun:window`'s canvas; `graphics.backend` is `"webgpu"`, `tier` from the device |
| `canvas` (input target) | host | the page canvas | an `EventTarget` the host adapter builds from `fun:window` input, with the same `pointer*`, `keydown`, `keyup`, `blur` event shapes |
| `asset(path)`, `readAsset(path)` (new) | host | URL, `fetch` | `fun:assets` `readBytes`; `asset()` returns an opaque key |
| `decodeImage(bytes, mime)` (new) | host | `createImageBitmap` | `fun:assets` `decodeImage` → `DataTexture` source |
| `createCanvas2D(width, height)` (new) | host | `OffscreenCanvas` | `fun:canvas` `createCanvas` (Skia 2D) |
| `.fun3d` inflation | kit | `DecompressionStream` | the app profile has no `DecompressionStream`: `kit/inflate.js` decodes into the declared length (`tests/inflate.test.mjs` checks it against zlib) |
| Jolt loading: `createPhysics({ loadJolt })` | kit option | the platform's WebAssembly build by URL | `loadJolt` instantiates the same build from asset bytes; native `fun:physics` behind the same interface once it covers vehicles |
| `audio` | host, optional | Web Audio | gap: a Web Audio subset, or absent (the contract already allows absent) |
| `progress`, `deviceStorage`, settings | host, optional | account transfer, IndexedDB, localStorage | `site/runtime/fun/storage.js` on `navigator.storage`: `games/<id>/progress.json`, `device/<key>`, `settings.json` in fun's data directory; writes commit on close, so a crash keeps the previous file |
| `runtime(name)` | host | import by URL | resolved at bundle time |
| `pickImage`, `haptics`, `announce`, recording | host, optional | yes | `pickImage` absent (games must treat it as optional); `haptics.vibrate` a no-op; `announce` prints |
| platform menu (pause, restart, sound, language, options, reset progress, quit) | host | the player's ☰ menu | `site/runtime/fun/menu.js`: drawn over the game with kit text, opened by the ☰ button or Escape, driven by taps and arrow keys; the button reserves `safeArea.top` 56 as on the web; preferences (muted, volume, locale) persist in `preferences.json` |
| `locale`, `options`, `updateOption`, `cheatsUsed`, `launchReason`, `reducedMotion`, `reportLoading`, `signal`, `track`, `onCleanup` | shared (`core/scope.js`, `core/options.js`) | | same code |
| frame loop, `update(delta, elapsed)`, pause/resume, resize, adaptive resolution | shared loop, host clock | `requestAnimationFrame`, `visibilitychange` | `requestAnimationFrame` driven by `fun:window`; pause on window focus loss |

The kit reached platform features directly in five places, all at call time; each is now a
function it receives, with the web behaviour unchanged: `kit/assets.js` takes `readAsset` and
`decodeImage` from the context (falling back to `fetch` and `createImageBitmap` for older
hosts), `createFun3d({ decodeImage })` decodes textures, `kit/fun3d-container.js` inflates
with the kit's own decoder when `DecompressionStream` is missing, `createText(options,
{ createCanvas2D })` draws on the host's canvas, and `createPhysics({ loadJolt })` takes the
host's Jolt loader. `kit/input.js` already took the canvas as an argument.
`kit/fun3d-write.js` and `core/recorder.js` are authoring and recording features of the web
host and stay web-only.

Three.js: the kit imports `../three.js`, which on the site is the vendored WebGPU build, in
Node the `three/webgpu` package (`scripts/workshop-resolve.mjs`), and in a fun bundle the
project's `node_modules`. Both repositories pin the same Three.js version.

## Delivery to fun

fun runs an ES module and reads published assets through `fun:assets`; it does not resolve
site paths or embed Three.js. `scripts/fun-app.mjs` is the publisher's fun output (done
2026-10-19): from a `game.json` it validates and collects the release exactly like the web
publisher (`prepareRelease`), then writes

```text
dist/fun/<id>/
  app.mjs         # esbuild: the game's code, the fun host adapter, the runtime kit, Three.js; `fun:*` external
  assets.json     # fun's asset manifest: every non-code runtime file by its bundle path, with size and SHA-256
  files/…         # those files (assets/, converted .fun3d, pinned library models)
  game.json       # the catalog entry, with the release hash
  entry.mjs       # the generated entry, for reading
```

```sh
node scripts/fun-app.mjs games/<id>/game.json [--out DIR] [--capture-at N] [--locale zh|en]
fun --bundle dist/fun/<id>/app.mjs --assets dist/fun/<id>/assets.json
```

The entry registers the adapter's debug RPC methods, so an agent can drive the game through
fun's debug socket: start the app with `--debug-socket PATH`, then from `../fun`
`python3 scripts/dev/rpc.py PATH game.stats --fun BIN --wait-active` or
`… game.capture '{"name":"shot.png"}'` (the PNG lands in the artifact directory);
`game.quit` ends the app and answers `HOST_CLOSED`, since the host closes before replying.
fun's third round also packages such an app as a Linux deb (its own `fun`, `app.mjs`, the
assets, a launcher and a desktop entry); the packaging recipe lives in `../fun`. `--capture-at N` bakes in a self-check: the app writes `frame-N.png` to
fun's artifact directory after N frames (or 5 s, for on-demand games) and quits.
`tests/fun-app.test.mjs` builds the fixture game; on 2026-10-19 that app ran on fun's Linux
host and captured its frame. Game code that imports a platform module (`/runtime/…`) fails the
build, as the contract requires. The window is 1280 × 720, or 720 × 1280 for portrait games.
`game.json` supplies the title and `apiVersion`; the adapter reports the same `apiVersion` as
the web player, and the compatibility window applies to both hosts.

## Verification

- `tests/runtime-hostless.test.mjs`: every kit and core module imports in Node without a DOM.
- `node scripts/fun-probe.mjs`: the kit on fun's graphics runner (`fun --test fun_graphics_runner`,
  the development build); `--app` runs the kit under fun's application host in a window (Xvfb,
  the product build). `FUN_ROOT` and `FUN_BIN` override the sibling checkout. The script writes
  small `.fun3d` models (raw, meshopt, with a physics body) and a PNG, bundles
  `scripts/fun-probe/entry.mjs` or `app-entry.mjs` with this checkout's Three.js, runs every
  kit feature as one step, reports the host's globals and saves frames as PNG under
  `test-results/fun-probe/` and `test-results/fun-probe-app/`.
  Results on 2026-10-19 (Linux ARM64, GB10, Vulkan), after fun's second round of fixes:
  - runner, 14 of 14: renderer init, TSL materials, `.fun3d` load and render, a meshopt file
    through the WebAssembly decoder, batched placement, light slots, post (AO, bloom, grade),
    text with real glyphs on a 2D canvas rendered as a sprite, animation, fixed step, Jolt from
    WebAssembly with a body falling under gravity, `fun3d.write`; no GPU errors, clean shutdown.
  - application host, 6 of 6: window and renderer, `.fun3d` render, `fun:assets` bytes and
    `decodeImage` to a `DataTexture`, a Chinese text label, `kit/input.js` listeners on the
    window canvas, 30 `requestAnimationFrame` frames with a capture written as PNG by `fun:debug`.
  Rules the fun host adapter must follow, learned here: the host starts driving frames only
  after the entry module's top-level evaluation finishes, so never await frames at top level;
  the application device is host-owned, so never call `renderer.dispose()` (it is refused as
  `HOST_OWNED_DEVICE`) and never `saveFrame`; release every 2D canvas view before shutdown
  (`createText(...).dispose()` does); Jolt loads from the single-file build (`jolt-physics`,
  wasm embedded), since fun has no `fetch` and the split build cannot take bytes.
- Host conformance, `node scripts/fun-conformance.mjs [game.json]`: one game bundle run by
  the web player (Playwright, in a copy of `dist/` with the game injected) and by fun (the
  publisher's app with a capture baked in), the same still frame at 1280 × 720 compared pixel
  for pixel, masks for what legitimately differs (HUD text in each host's fonts, the web
  player's menu button and safe area). Without a game it builds the demo from the probe's
  sample game: a `.fun3d` model, an opaque and a transparent texture, HUD text. On 2026-10-19
  the demo agreed on 99.9% of pixels within 8 levels (mean difference 0.1), the rest
  antialiasing at edges. The runs exposed two real seams, both fixed in the kit: pixel-data
  textures sampled nearest instead of linear with mipmaps (`textureFromImage` and the `.fun3d`
  loader), and web textures decoded with premultiplied alpha while Three.js expects straight
  alpha (`kit/assets.js` now asks `createImageBitmap` for `premultiplyAlpha: "none"`, as
  Three.js's own ImageBitmapLoader does), which darkened soft edges on the web. Linux ARM64 Chromium and
  Chrome have no WebGPU, so the web side ran the renderer's WebGL 2 backend there; the script
  takes WebGPU when the browser offers it, which a macOS run should. 帝都 is the acceptance
  game once it moves to `fundev-games`.
- Gaps found in fun are reported to `../fun` as implementation gaps, consumer first. Two rounds
  on 2026-10-19 closed everything the probes found: WebAssembly (V8 rebuilt with it, memory
  budget aligned to the application's 512 MiB), the compression streams, the offscreen 2D canvas,
  Fontconfig fonts with a CJK fallback, `structuredClone`, `crypto`, `atob`, a Web Audio subset
  (WAV, buffer source, gain, stereo panner), the Linux application host, and the host contract
  for frame start, device ownership, screenshots and disposal. Not provided, by design: `fetch`
  (assets come from the published snapshot) and `createImageBitmap` (the kit uses
  `decodeImage`). Still open, recorded in fun's status table: vehicles, ragdolls, mesh and
  height-field shapes in `fun:physics`; real audio hardware and macOS unverified (macOS
  deferred by the owner); `pickImage` has a scope proposal in fun. The third round
  (2026-10-19) made `Blob` and streams accept views over `fun:assets` buffers, passed fun's
  whole Skia gate, added `scripts/dev/rpc.py` in fun for the debug socket, and packaged the
  sample game as a Linux deb with its own fun binary and a desktop entry.

## Order of work (fun.dev side)

1. The five seams in the kit, with the web host unchanged in behaviour; `readAsset`,
   `decodeImage` and `createCanvas2D` documented in game bundles (done 2026-10-19).
2. The fun host adapter (done 2026-10-19): `site/runtime/fun/host.js`, `createFunHost({ fun,
   THREE, module, manifest, runtimeModules }).start()`. It gives a game the contract's context on
   `fun:window`, `fun:canvas`, `fun:assets` and fun's Web Audio subset, runs the lifecycle (locale,
   resize, resume, frames with the clamped delta, on-demand rendering, pause), options and cheats,
   and offers `capture()` (PNG through `fun:gpu` and `fun:debug`) and `registerDebug()` (RPC
   methods `game.stats`, `game.inspect` (optional application `snapshot()`), `game.focus`, `game.capture`, `game.option`, `game.pause`, `game.resume`,
   `game.locale`, `game.quit` for agents). It imports nothing from fun: the entry passes fun's
   modules in, so `tests/fun-host.test.mjs` runs it in Node against stand-ins.
   `scripts/fun-probe/host-entry.mjs` is the entry a published fun app will have, running
   `scripts/fun-probe/game.js`, a game written only against the contract; `node
   scripts/fun-probe.mjs --host` runs it in a fun window; run twice, its launch counter
   (progress) and kept blob (deviceStorage) survive. Absent on fun: `pickImage`;
   `haptics.vibrate` is a no-op, `announce` and `reportLoading` print. Account transfer of
   progress is the web player's; a fun save stays in the device's data directory.
3. The publisher's fun output: `scripts/fun-app.mjs` (done 2026-10-19). Later: the games
   repository's release CLI calls it beside the web release.
4. Host conformance with the pixel comparison: `scripts/fun-conformance.mjs` (done
   2026-10-19 with the demo). 帝都 on fun once it moves to `fundev-games`.
5. Later: a Web Audio subset in fun or an audio seam in the kit; native physics backend.
