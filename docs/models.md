# Model library

Status: live since 2026-10-16; architecture reviewed twice on 2026-10-17. fun.dev keeps a public
library of 3D models so games use models instead of building them. Models are made by a Blender
pipeline outside this repository, uploaded in one console, reviewed by the maintainer, and
published under CC0.

Who it is for, in order: agents making games (a catalog they can search and models they can pin),
the owner (browsing and managing), and visitors (a public showcase with CC0 downloads).

```
upload  ──▶ console.fun.dev 上传 (Access)   ──▶ D1 fundev-models; files: games.fun.dev/blobs/<sha256>.<ext>
review  ──▶ npm run models (maintainer), console.fun.dev 审核 (owner)  ──▶ listed in D1, snapshots rewritten
pages   ◀── games.fun.dev/library/index.<zh|en>.json, games.fun.dev/library/<id>.json
games   ◀── game.json "models" → pinned blobs at models/<id>.glb
```

Principles from the reviews: one source of truth (D1) and nothing that has to be kept in step by a
client; the simplest thing that fits the actual scale (hundreds of models); every change goes
through the same server functions, whether from the console or the maintenance script.

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
- Provisional rule, may change: an approved version's `model.glb` and `source.blend` never change
  (games pin them); its thumbnail, a rendering, may be replaced; the model's name, description,
  kit, tags and listing may change at any time; its type is fixed once a version is approved.
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

`name`, `description`, `kit` and `tags` belong to the model and can be edited any time.

Files are stored at upload. The public ones (`model.glb`, `thumbnail.png`, `source.blend`) go
straight to the public bucket `fundev-games` as `blobs/<sha256>.<ext>`, the content-addressed
store games use ([assets](assets.md)): an address cannot be guessed, so a file is effectively
private until its version is listed, and approving needs no copying. The rest (`preview.png`,
`qa.json`, `readme.md`, …) stays in the private bucket `fundev-sources` under
`models/<id>/<version>/<file>`, for review only. A public file replaced before its version was
ever listed is deleted unless another version uses it; files of listed versions are never deleted,
because games reference them by address.

## Console

There is one way in, for uploads and review alike: `console.fun.dev`.

`console.fun.dev` is a Worker (`fundev-console`, `wrangler.console.jsonc`) serving the console
page and its API. The whole host is behind Cloudflare Access (email one-time PIN for the
owner), and the Worker verifies the Access JWT on every request as well. `fun.dev` itself
cannot host it: it is DNS-only to the CN2 server ([edge](edge.md)), so Access does not apply.

- **上传** takes zips or folders in the layout of [models-upload](models-upload.md), checks
  them in the browser with the server's rules (`server/model-rules.js`) and uploads through
  `/api/upload/…`, sending each file's SHA-256 (R2 verifies it; the Worker need not hash large
  files). A version is pending once its metadata (with a description), `model.glb` and
  `thumbnail.png` are there; the server rechecks the GLB and computes the stats shown in review.
  Tags that say nothing (`low-poly`, `static`, the type or kit again) are dropped; production
  jargon in names and descriptions is flagged.
- The upload page renders each model's `thumbnail.png` in the browser with the library's viewer
  (one angle, light and background), so every thumbnail matches the 3D view on model pages. A
  maker's `preview.png` is optional.
- **审核** is a wall of thumbnails with size, triangles and warnings under each (not on the
  floor, off centre, no description, no thumbnail, production jargon). Versions without warnings
  can be selected and approved in bulk; one with a warning is opened and approved on its own.
  The detail view shows the model in 3D and edits `name`, `description`, `type`, `kit`, `tags` and
  listing; approve, or reject with a note. **重建公开目录** rewrites the snapshots as a fallback.

## Review

Approving a version lists it; with the files already public, that is reversible (unlist the
model). Day to day the maintainer (Claude) reviews new uploads with `npm run models` and the owner
spot-checks in the console, unlisting anything at any time:

```sh
npm run models -- list [pending|rejected|approved|incomplete|all]   # with warnings
npm run models -- sheet [status]            # contact sheets in test-results/models-review/
npm run models -- apply plan.json [--dry-run]
npm run models -- rebuild                   # rewrite every page and the indexes
```

`scripts/models-admin.mjs` runs the console's own functions against the live data through
Wrangler's remote bindings (`wrangler.models-admin.jsonc`, the Wrangler login); nothing is exposed
on the web. A plan is one reviewed file, applied in order and published once:

```json
{
  "kits": { "desk_lamps": { "zh": "…", "en": "…" } },
  "models": { "table_lamp_01": { "name": { "zh": "台灯", "en": "Table lamp" }, "description": { "zh": "…", "en": "…" }, "kit": null, "tags": ["lamp"], "listed": true } },
  "reject": { "lamp_draft_01/v001": "The shade is missing." },
  "approve": ["table_lamp_01/v001"]
}
```

## Publishing

D1 is the only source of truth. The public library is a snapshot of it in `fundev-games`, served
from `games.fun.dev` with a 60 s cache, and **the server rewrites it in the same request as every
change to what is listed** (approving, unlisting, editing a listed model or its kit, replacing a
listed thumbnail), so no client step can leave it behind:

- `library/index.zh.json` and `library/index.en.json`: every listed model's newest approved
  version in one language, a header of field names and one array per model, one model per line
  (`id`, `name`, `description`, `type`, `kit`, `tags`, `size`, `version`, `thumbnail` as the
  thumbnail's SHA-256), plus each kit's fitting agreement. About 150–200 bytes per model.
- `library/<id>.json`: a model's page data in both languages with every approved version and its
  public files, written for unlisted models too (games that pinned them still resolve).

A public query API would do the same with more moving parts; it waits until the library is far
larger (see Later).

## Pages

- `/models`: grid of thumbnails with search (names, descriptions, tags) and type, kit and tag
  filters (`/models?type=…&kit=…`), from the index in the reader's language.
- `/models/<id>`: 3D view, name, description, kit and its fitting agreement, size, triangles,
  file size; buttons to copy the GLB address, download the GLB, and download the `.blend` when
  there is one; older versions. From `library/<id>.json`; unlisted models have no page.

Both are static pages from the build (`site/models.html`, and `site/model.html`, which
`_redirects` serves at every `/models/<id>`), so a listing is live within the cache time. The 3D view is `site/model-viewer.js`, shared with the
console. Model files must not require Draco, KTX2 or meshopt decoders; uploads reject them.
The pages work on `fun.dev` only: `games.fun.dev` allows that origin, not `cdn.fun.dev`.

## Using a model in a game

A game declares its library models in `game.json`, pinned by version:

```json
"models": { "desk_chair_01": "v002" }
```

and loads them like its own files: `context.asset("models/desk_chair_01.glb")`. Preparing a
release (`scripts/library-models.mjs`, used by every build and the publisher) looks each one up in
`library/<id>.json`, fetches the blob into the shared cache (`~/.cache/fundev-blobs`, with copies
of the page data, so builds also work offline) and adds it to the release's blob map. The release pins the
file, the player caches it with the game for offline play, and a model shared by games downloads
once. `models/` cannot hold the game's own files. The game skill documents this for agents.

A model's public address (`games.fun.dev/blobs/<sha256>.glb`, copied from its page) also works
anywhere and never changes, but is not cached with a game.

## Code

| Piece | Files |
| --- | --- |
| Console Worker | `server/console.js` (routes, Access check), `server/models.js` (upload, review, snapshots), `server/model-rules.js` and `server/glb.js` (checks), `console/` (built by `npm run console:build` into `dist-console/`), `wrangler.console.jsonc` |
| Maintenance | `scripts/models-admin.mjs` (`npm run models`), `wrangler.models-admin.jsonc` |
| Database | `migrations-models/`, binding `MODELS_DB` in `wrangler.console.jsonc` |
| Pages | `site/models.html`, `site/model.html`, `site/models.js`, `site/model.js`, `site/models-catalog.js`, `site/model-viewer.js` |
| Games | `scripts/library-models.mjs` (resolve `models` in `game.json`), `scripts/game-release.mjs` |
| Tests | `tests/models.test.mjs` (upload, review, snapshots, maintenance plans and Access checks over local D1 and R2), `tests/console-zip.test.mjs`, `tests/library-models.test.mjs` |

`npm run release` applies `migrations-models/` and deploys the console Worker when it changed.
Locally, the build writes empty indexes under `dist/library/`.

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
- A public query API (search, paging) once the library reaches thousands of models.
- Validating the library with a real game built from it (skipped on 2026-10-17: until then the
  design may drift from what games need). Clock Out is realistic; the library is stylised.
- A scheduled agent that reviews new uploads without being asked.
- Regenerating thumbnails from the maintenance script.
