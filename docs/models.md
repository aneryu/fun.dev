# Model library

Status: decided and implemented on 2026-10-16; not yet deployed (see [Setup](#setup)). fun.dev keeps a public library of 3D models
so games use models instead of building them. Models are made by a Blender pipeline outside
this repository, uploaded through an API, reviewed by hand, and published under CC0.

```
pipeline ── PUT ──▶ api.fun.dev/api/models/…   (token)      ──▶ D1 fundev-models + private R2
you      ── review ▶ console.fun.dev            (Access)     ──▶ approve
approve  ─────────────────────────────────────────────────────▶ games.fun.dev/blobs/<sha256>.<ext>
                                                                 games.fun.dev/models.json
players  ◀── fun.dev/models, fun.dev/models/<id> (static pages that read catalog.json)
games    ◀── https://games.fun.dev/blobs/<sha256>.glb
```

## Contents

Every model has a `type`. Only `prop` and `piece` are accepted so far; the others are decided
below and implemented when the first one is uploaded. Models made for one game stay in that
game's `assets/`.

| Type | What | Main file |
| --- | --- | --- |
| `prop` | a single object | `model.glb` |
| `piece` | a modular building piece (wall, road, stair) | `model.glb` |
| `character` | a humanoid on the shared skeleton | `model.glb` (planned) |
| `creature` | a non-humanoid with its own skeleton | `model.glb` (planned) |
| `animation` | CC0 clips for the shared skeleton, no mesh | `model.glb` (planned) |
| `scene` | a composition of library models | `scene.json` (planned) |
| `world` | a composition of scenes and terrain | `world.json` (planned) |

- Every GLB follows the pipeline's production spec: metres, glTF +Y up, front +Z, root at the
  centre of the bounding box's floor, real-world size.
- Licence: CC0. The `.blend` source is published too when the pipeline uploaded one.
- The type is set at upload and can be corrected in review until a version is approved; after
  that it is fixed, because games may rely on it.

### Characters, creatures and animations (planned)

- Humanoid characters are made by the pipeline and rigged to a Mixamo-compatible skeleton
  (`mixamorig:*` bone names and hierarchy), so any clip for that skeleton plays on any character.
  Rest pose, bone and weight limits for phones (at most 64 bones, 4 influences per vertex) and a
  triangle budget are fixed when the first character is made.
- Mixamo's own characters and animations are not in the library: its terms allow use inside a
  project but not redistribution as assets. A game that uses Mixamo clips keeps them in its own
  `assets/`. Shared `animation` entries are CC0 only (for example Quaternius UAL clips retargeted to
  the skeleton).
- Creatures carry their own skeleton and clips, with common names where they apply: `idle`,
  `walk`, `run`, `attack`, `hit`, `die`.

### Scenes and worlds (planned)

A scene is a list of placements, not a baked GLB, so repeated models are stored and downloaded
once, render as instances, and stay identifiable in games:

```json
{ "items": [{ "model": "desk_chair_01", "version": "v002", "position": [1.2, 0, -0.4], "rotation": [0, 0.707, 0, 0.707] }] }
```

- Placed in Blender as linked instances of library models; an export script writes the list
  (metres, glTF axes, rotation as a quaternion). There is no scale: models have real sizes.
- Every referenced version must be approved. A platform helper (`kit/models.js`: `loadModel`,
  `loadScene`) loads a scene as one group with instancing; the pages and the console preview
  scenes with it.
- A world is a larger composition of scenes and terrain, loaded by area.

## Identity

- A model's id is `<name>_<NN>` as the pipeline names it, e.g. `desk_chair_01`. It is also the
  address `/models/desk_chair_01`. Ids use `[a-z0-9_]`.
- A version is `v<NNN>`. Revisions get a new version; the newest approved one is shown.
- Models that belong together (a modular sofa, a set of street pieces) share a `kit`.
  There are no other variant dimensions.

## Storage

The D1 database `fundev-models` is the source of truth for the catalog:

| Table | Columns |
| --- | --- |
| `models` | `id`, `name`, `kit`, `tags`, `extra` (JSON for any other field), timestamps |
| `versions` | `model`, `version`, `status` (`pending`, `approved`, `rejected`), `files` (name → sha256, size), `stats` (size in metres, triangles, bytes), `note` (review note), timestamps |

`name`, `kit` and `tags` belong to the model and can be edited during review. Uploaded files
are kept in the private bucket `fundev-sources` under `models/<id>/<version>/<file>`.

## Upload

The upload API is described for the pipeline in [models-api](models-api.md). It is a Pages
Function on `api.fun.dev`, authorised by one bearer token (Pages secret `MODELS_TOKEN`) that
can only upload and read status. A version is pending once its metadata, `model.glb` and
`preview.png` are present. The server checks only that the GLB is valid glTF 2.0 binary with no
external references and within the size limit, and computes the stats shown in review.
Approved versions cannot be changed.

## Review

`console.fun.dev` is a Worker (`fundev-console`, `wrangler.console.jsonc`) serving the console
page and its API. The whole host is behind Cloudflare Access (email one-time PIN for the
owner), and the Worker verifies the Access JWT on every request as well. `fun.dev` itself
cannot host it: it is DNS-only to the CN2 server ([edge](edge.md)), so Access does not apply.

The console's upload page takes zips or folders, checks them in the browser with the server's
rules (`server/model-rules.js`) and uploads through `/api/upload/…`, so a person signed in
through Access can upload without the token. The console lists pending versions with their preview and stats, shows the model in 3D, and
lets the owner edit `name`, `kit` and `tags`, approve, or reject with a note the pipeline can
read.

## Publishing

Approving a version copies its files to the public bucket `fundev-games` as
`blobs/<sha256>.<ext>`, the same content-addressed store games use ([assets](assets.md)), and
rewrites `models.json` there from D1, next to `games.json`. Both are served from `games.fun.dev`.

Published model blobs are never deleted, because games reference them by address.
Unlisting a model only removes it from the catalog.

## Pages

- `/models`: grid of previews with search and type, kit and tag filters (`/models?type=…&kit=…`).
- `/models/<id>`: 3D view, name, size, triangles, file size and kit; buttons to copy the GLB
  address, download the GLB, and download the `.blend` when there is one; older versions.

Both are static pages from the build (`site/models.html`, and `site/model.html`, which
`_redirects` serves at every `/models/<id>`) that render `models.json` in the browser, so an
approval is live at once without a deploy. The 3D view is `site/model-viewer.js`, shared with the
console. Model files must not require Draco, KTX2 or meshopt decoders; the API rejects them.

## Using a model in a game

Copy the address from the model's page and load it directly:

```js
const gltf = await loader.loadAsync("https://games.fun.dev/blobs/<sha256>.glb");
```

The address never changes. The player's CSP already admits `games.fun.dev`, and the service
worker caches blobs on first use. Such a model is not precached when a game opens, and local
development needs a network connection.

## Code

| Piece | Files |
| --- | --- |
| Upload API (Pages Function) | `functions/api/[[path]].js` → `server/models.js`, GLB checks in `server/glb.js` |
| Console Worker | `server/console.js`, `console/` (built by `npm run console:build` into `dist-console/`), `wrangler.console.jsonc` |
| Database | `migrations-models/`, binding `MODELS_DB` in `wrangler.jsonc` and `wrangler.console.jsonc` |
| Pages | `site/models.html`, `site/model.html`, `site/models.js`, `site/model.js`, `site/models-catalog.js`, `site/model-viewer.js` |
| Command-line tool | `scripts/fundev-models.mjs`, shared rules in `server/model-rules.js`; the build bundles it into `dist/tools/fundev-models.mjs` |
| Tests | `tests/models.test.mjs`, `tests/models-upload.test.mjs` (API, review, publishing and Access checks over local D1 and R2) |

`npm run release` applies `migrations-models/` and deploys the console Worker when it changed.
Locally, the build writes an empty `dist/models.json`.

## Setup

Once, before the first release that contains the library:

1. Create the D1 database `fundev-models` (done 2026-10-16, location hint APAC; its id is in
   `wrangler.jsonc` and `wrangler.console.jsonc`).
2. Pages project `fundev`: the secret `MODELS_TOKEN` (done 2026-10-16; a copy for the pipeline is
   kept outside the repository).
3. Zero Trust: the self-hosted Access application "fun.dev console" on `console.fun.dev`
   allows only the owner's email with one-time PIN, sessions of 30 days. The console Worker's
   secrets `ACCESS_TEAM`, `ACCESS_AUD` and `CONSOLE_EMAIL` match it (done 2026-10-16; a new
   application needs a new `ACCESS_AUD`).
4. CN2 server: install the updated `config/Caddyfile` ([edge](edge.md)), which lets `/models`
   through to Pages.
5. `npm run release` applies the migration, deploys the console Worker on `console.fun.dev` and
   the site with the upload API.

## Later

Deferred for future consideration, not rejected:

- Share cards for individual models.
- Showing which games use a model.
- Style, state or level-of-detail variants.
- Named sockets (`socket_top`, `socket_wall`) for placing items relative to other models.
- Adding models from the repository through `assets.lock` instead of addresses.
