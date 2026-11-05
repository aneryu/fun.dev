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
# Static dev server: http://localhost:8000, plus HTTPS on :8443 with a self-signed
# certificate so phones on the LAN get a secure context for WebGPU.
# DEV_HOSTNAMES=name1,name2 adds extra certificate names (e.g. a tailnet name).
npm run dev

# Link/asset/syntax checks, home-page dependency isolation, and unit tests
npm test

# Everything above plus headless Chrome (SwiftShader WebGPU) screenshots of /, /studio
# in all three modes, and /studio at 375 px, written to test-results/
npm run verify
```

## Deployment

There is no build step: the `site/` directory is the deployment.

- Cloudflare Pages project `fundev`, deployed by direct upload (it is not connected to Git):

  ```sh
  npx wrangler pages deploy site --project-name fundev --branch production
  ```

- The Pages project answers on `static.fun.dev` (and `api.fun.dev`, `fundev.pages.dev`).
- `fun.dev` itself points at the CN2 server, whose Caddy (`config/Caddyfile`) proxies pages
  (`/`, `/studio`, any other one-segment path, `sw.js`, `robots.txt`, `sitemap.xml`) from
  `static.fun.dev` and 308-redirects every other path (CSS, JS, icons) there. Pages must
  therefore allow `https://static.fun.dev` in their Content-Security-Policy (`site/_headers`).
- After changing which paths are pages, update `config/Caddyfile` and apply it on the server
  (the commands are at the top of that file).
- `site/sw.js` only unregisters the service worker of older builds and clears their caches.

## Analytics

None is active. The pages carry no beacon, and Cloudflare cannot inject one on `fun.dev`
because that hostname is not proxied by Cloudflare. The CSP already allows the Cloudflare Web
Analytics beacon, so turning it on means adding its script tag with a site token.
