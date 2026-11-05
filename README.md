# fun.dev

A static personal playground & studio on `fun.dev` for **WebGPU + WGSL Signed Distance Field (SDF)** procedural modeling and mesh baking, built just for fun.

## Architecture

- **Unified Bath Duck Source of Truth (`site/scenes/bath-duck.js`)**:
  - `BATH_DUCK_BLOCKS` and `BATH_DUCK_PRESET` define the canonical 10 SDF primitives (`duckBody`, `duckHead`, `duckBeak`, `duckEyes`, `duckWings`, `duckTail`, `waterPool`, `tubOuter`, `tubInner`, `tubRim`), shared 1:1 between `/` and `/studio`.
- **Two-Route Static Architecture (`/` & `/studio`)**:
  - **`/` (`site/index.html` + `site/home.js`) — Minimalist Poster Homepage**: Clean, poster-first Duck Yellow canvas pairing the `Code for / − work. / + fun.` identity (`Things I make for fun.`) with an interactive 3D WebGPU SDF Bath Duck (`bath-duck`) toy.
  - **`/studio` (`site/studio.html` + `site/studio.js` + `site/kernel/sdf-editor.js`) — SDF Block & Low-Poly Studio**:
    - **`✨ 丝滑高精` (`smooth`)**: SurfaceNets bounding hull + per-pixel live analytical SDF shading (`matId == 14`) driven by a 64×`vec4f` live block uniform buffer.
    - **`💎 晶面低模` (`lowpoly`)**: Adaptive per-island SurfaceNets mesh extraction + 2-pass tangential Laplacian relaxation + baked SDF AO & soft shadows.
    - **`🚀 36实例同屏` (`crowd`)**: 36 instanced Bath Ducks rendered in a single static vertex stream at 60 FPS, plus one-click `.gltf` 2.0, SDF JSON, and WGSL export.
- **Zero Runtime Dependencies**: Pure native WebGPU (`navigator.gpu`) + WGSL kernel (with zero-dependency WebGL2 GLSL ES 3.00 fallback in `site/kernel/webgl2-fallback.js`) serving directly from `site/` with no bundler or external runtime packages.

## Local Development & Verification

```sh
# Start local static dev server on http://127.0.0.1:8000
npm run dev

# Run static link/syntax checks and unit tests
npm test

# Run full verification (static checks + unit tests + headless Chrome WebGPU rendering & screenshot capture)
npm run verify
```

## Cloudflare Pages

- Build command: leave empty
- Build output directory: `site`
- Production branch: `production`

## Analytics

Use **Cloudflare Web Analytics** for privacy-first page-view, visitor, and Web
Vitals reporting. Enable automatic setup for `fun.dev` in the Cloudflare Web
Analytics dashboard. Cloudflare then injects the beacon at the edge, so this
repository does not need to contain a site token or third-party tracking code.
