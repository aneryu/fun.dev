# Model library

Status: live since 2026-10-16; reviewed 2026-10-17. fun.dev keeps a public library of 3D models
so games use models instead of building them. Models are made by a Blender pipeline outside this
repository, uploaded and reviewed in one console, and published under CC0.

Who it is for, in order: agents making games (a catalog they can search and models they can pin),
the owner (browsing and managing), and visitors (a public showcase with CC0 downloads).

```
upload   ──▶ console.fun.dev 上传 (Access)  ──▶ D1 fundev-models + private R2
review   ──▶ console.fun.dev 审核 (Access)  ──▶ games.fun.dev/blobs/<sha256>.<ext>, games.fun.dev/models.json
players  ◀── fun.dev/models, fun.dev/models/<id> (static pages that read models.json)
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
- Every model has a bilingual `description`: what it is, how it looks, where it fits. Agents
  choose by reading descriptions, so they matter more than tags; tags are free and optional.
- A `kit` means "built to one set of dimensions, so these fit together" (a modular sofa, wall
  and floor modules on a 3 m grid with 2.8 m storeys). Each kit has a description of that
  agreement. Models that are merely related share no kit; their descriptions say so. There are
  no other variant dimensions.

## Storage

The D1 database `fundev-models` is the source of truth for the catalog:

| Table | Columns |
| --- | --- |
| `models` | `id`, `name`, `type`, `description`, `kit`, `tags`, `listed`, `extra` (JSON for any other field), timestamps |
| `kits` | `id`, `description` (the fitting agreement, `{zh, en}`), timestamp |
| `versions` | `model`, `version`, `status` (`pending`, `approved`, `rejected`), `files` (name → sha256, size), `stats` (size in metres, triangles, bytes), `note` (review note), timestamps |

`name`, `kit` and `tags` belong to the model and can be edited during review. Uploaded files
are kept in the private bucket `fundev-sources` under `models/<id>/<version>/<file>`.

## Console

There is one way in, for uploads and review alike: `console.fun.dev`.

`console.fun.dev` is a Worker (`fundev-console`, `wrangler.console.jsonc`) serving the console
page and its API. The whole host is behind Cloudflare Access (email one-time PIN for the
owner), and the Worker verifies the Access JWT on every request as well. `fun.dev` itself
cannot host it: it is DNS-only to the CN2 server ([edge](edge.md)), so Access does not apply.

- **上传** takes zips or folders in the layout of [models-upload](models-upload.md), checks
  them in the browser with the server's rules (`server/model-rules.js`) and uploads through
  `/api/upload/…`. A version is pending once its metadata (with a description), `model.glb` and `thumbnail.png` are
  there; the server rechecks the GLB and computes the stats shown in review.
- The upload page renders each model's `thumbnail.png` in the browser with the library's viewer
  (one angle, light and background), so every thumbnail matches the 3D view on model pages. A
  maker's `preview.png` is optional.
- **审核** is a wall of thumbnails with size, triangles and warnings under each (not on the
  floor, off centre, no description, no thumbnail). Versions without warnings can be selected
  and approved in bulk; any version with a warning must be opened and approved on its own. The
  detail view shows the model in 3D and edits `name`, `description`, `type`, `kit`, `tags` and
  listing; approve, or reject with a note. Approved versions cannot change.
- Large metadata changes (descriptions, kits) are made by the maintainer directly in D1 followed
  by a catalog rewrite, not through the console.

## Publishing

Approving a version copies its files to the public bucket `fundev-games` as
`blobs/<sha256>.<ext>`, the same content-addressed store games use ([assets](assets.md)), and
rewrites `models.json` there from D1, next to `games.json`. Both are served from `games.fun.dev`.

Published model blobs are never deleted, because games reference them by address.
Unlisting a model only removes it from the catalog.

## Pages

- `/models`: grid of thumbnails with search (names, descriptions, tags) and type, kit and tag filters (`/models?type=…&kit=…`).
- `/models/<id>`: 3D view, name, size, triangles, file size and kit; buttons to copy the GLB
  address, download the GLB, and download the `.blend` when there is one; older versions.

Both are static pages from the build (`site/models.html`, and `site/model.html`, which
`_redirects` serves at every `/models/<id>`) that render `models.json` in the browser, so an
approval is live at once without a deploy. The 3D view is `site/model-viewer.js`, shared with the
console. Model files must not require Draco, KTX2 or meshopt decoders; uploads reject them.
The pages work on `fun.dev` only: `games.fun.dev` allows that origin, not `cdn.fun.dev`.

## Using a model in a game

A game declares its library models in `game.json`, pinned by version:

```json
"models": { "desk_chair_01": "v002" }
```

and loads them like its own files: `context.asset("models/desk_chair_01.glb")`. Preparing a
release (`scripts/library-models.mjs`, used by every build and the publisher) looks each one up in
`models.json`, fetches the blob into the shared cache (`~/.cache/fundev-blobs`, with a copy of the
catalog, so builds also work offline) and adds it to the release's blob map. The release pins the
file, the player caches it with the game for offline play, and a model shared by games downloads
once. `models/` cannot hold the game's own files. The game skill documents this for agents.

A model's public address (`games.fun.dev/blobs/<sha256>.glb`, copied from its page) also works
anywhere and never changes, but is not cached with a game.

## Code

| Piece | Files |
| --- | --- |
| Console Worker | `server/console.js` (routes, Access check), `server/models.js` (upload, review, publishing), `server/model-rules.js` and `server/glb.js` (checks), `console/` (built by `npm run console:build` into `dist-console/`), `wrangler.console.jsonc` |
| Database | `migrations-models/`, binding `MODELS_DB` in `wrangler.console.jsonc` |
| Pages | `site/models.html`, `site/model.html`, `site/models.js`, `site/model.js`, `site/models-catalog.js`, `site/model-viewer.js` |
| Games | `scripts/library-models.mjs` (resolve `models` in `game.json`), `scripts/game-release.mjs` |
| Tests | `tests/models.test.mjs` (upload, review, publishing and Access checks over local D1 and R2), `tests/console-zip.test.mjs`, `tests/library-models.test.mjs` |

`npm run release` applies `migrations-models/` and deploys the console Worker when it changed.
Locally, the build writes an empty `dist/models.json`.

## Setup

Done on 2026-10-16:

1. D1 `fundev-models` (location hint APAC); its id is in `wrangler.console.jsonc`.
2. Zero Trust: the self-hosted Access application "fun.dev console" on `console.fun.dev` allows
   only the owner's email with one-time PIN, sessions of 30 days. The console Worker's secrets
   `ACCESS_TEAM`, `ACCESS_AUD` and `CONSOLE_EMAIL` match it; a new application needs a new
   `ACCESS_AUD`.
3. CN2 server: `config/Caddyfile` lets `/models` through to Pages ([edge](edge.md)).

## Later

Deferred for future consideration, not rejected:

- Share cards for individual models.
- Showing which games use a model.
- Style, state or level-of-detail variants.
- Named sockets (`socket_top`, `socket_wall`) for placing items relative to other models.
- Adding models from the repository through `assets.lock` instead of addresses.
