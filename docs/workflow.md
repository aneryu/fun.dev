# Workflow: develop, test, release

Three commands cover day-to-day work. Everything else is in the reference below.
Several games in parallel: [parallel game development](parallel-games.md).

```sh
npm run dev [-- <game-id>]   # develop with live reload
npm run verify               # check everything locally (~40 s)
npm run release              # ship to fun.dev (plan → confirm → execute → live checks)
```

Setup once: Node.js 22+, `npm ci`, `npx playwright install chromium`, and
`npx wrangler login` (an account with access to the `fundev` Pages project, the
`fundev-games` and `fundev-sources` R2 buckets and the production D1 database).
Binary files are not in Git: on a new machine, `npm run assets -- --pull` fetches
them (see [assets](assets.md)). `.env` is optional; see
[Credentials](#credentials).

## 1. Develop

```sh
npm run dev                  # http://127.0.0.1:8000, rebuilds and reloads on save
npm run dev -- muyu          # prints the player URL for one game, with ?debug=1
```

- Platform code: `site/` (pages, player, host and runtime kit), `scripts/build.mjs`.
- Games: `games/<id>/` with `game.js`, `game.json` (metadata, version, runtime
  `files`) and optional `dev/`, `README.md`, `package.json` (never published). See
  [game bundles](game-bundles.md) for the contract; the
  `skills/fun-dev-games/assets/game.js` starter is a working example.
- The dev server uses the production headers (CSP), local `games/` sources, and
  never registers the service worker. Other devices on the LAN can open the
  machine's address; `PORT` and `HOST` change where it listens.
- Change a game's `version` in `game.json` when its code or assets change: each
  version is an immutable release once published.
- `games/<id>/assets/` and `sources/` are not in Git. After adding or changing such
  files, or after a merge, run `npm run assets` and commit the changed locks; see
  [assets](assets.md). `npm run dev` restores missing files on start.
- `npm test` (~20 s) runs only the unit tests, including each game's `dev/` tests.
- `npm run fun3d -- inspect|validate|convert` works with `.fun3d` model files
  ([docs/fun3d-agents.md](fun3d-agents.md)); `npm run derive` builds a model from a
  blueprint or a project's parameters into a library upload folder
  ([model editor](model-editor.md#blueprints-and-derivation)).
- `npm run editor` develops the low-poly workshop without game binary assets;
  `npm run verify:editor` runs its focused build, geometry and browser checks
  ([model editor](model-editor.md)). The same guide covers `npm run editor:agent`
  for local CLI / stdio MCP modeling, previews and export reports.

## 2. Verify

`npm run verify` builds once and runs, in one Chromium:

| Suite | Checks |
| --- | --- |
| assets | `npm run assets -- --check`: every file matches its lock |
| unit | `node --test`: catalog, publisher, CSP, kit, game pages, progress protocol with local D1, model library API and review with local D1/R2, game tests |
| smoke | every game at phone and desktop size: runs, not blank, language switch, menu pause/resume, restart, clean exit, no console errors |
| kit | text/HUD placement, pointer/keyboard/joystick, glTF with embedded textures, Draco/KTX2 and the MediaPipe vision runtime under the player CSP |
| fun3d | `.fun3d` models: written, loaded, drawn alone and in batches (compared pixel for pixel), roles and tints, Jolt vehicles and bodies, clips; with `FUNDEV_FUN3D_SAMPLES=<dir of GLBs>` also real files converted in the browser |
| player | loading bar, announcements, options/settings/cheats, mute, share, restart, debug panel, rotation prompt, API mismatch |
| site | lobby covers, game pages and their redirects, sitemap, 404, manifest/icons, offline play through the service worker |
| editor | desktop editing, single-writer drafts, parametric shapes, agent transactions, observations and GLB round trip through the runtime kit |

`npm run verify -- smoke player` runs only some browser suites;
`npm run verify -- smoke --game=<id>` smoke-tests a single game;
`npm run verify -- --transfer` adds the slower account-transfer test (local D1 with
`wrangler pages dev`). Screenshots go to `test-results/`. It also prints each game's
download size (first load and `lazy/`), for information. Commit when it passes.

Headless Chromium has no GPU, so these suites run the games on the renderer's WebGL 2
backend in software. On a machine with a GPU, `npm run verify -- --webgpu` runs the
browser suites on it (Vulkan) with every game forced to WebGPU; run it after rendering
changes. On a phone, `?renderer=webgpu` or `?renderer=webgl` with `?debug=1` compares
the two backends (the debug panel names the one in use).

## 3. Release

Commit on `main`, then:

```sh
npm run release              # shows the plan and asks for confirmation
npm run release -- --yes     # same, without the prompt
npm run release -- --check   # only the live checks against fun.dev
```

`release` refuses a dirty tree or another branch. It reads the live state and
prints a plan: which commit fun.dev runs, pending D1 migrations, whether the
cleanup Worker changed (or is missing), which games differ from the R2 catalog
(by content hash), and whether the website needs deploying (site code changed or
games were published, which refreshes the game pages and sitemap). After confirmation:

1. `verify` (plus the transfer test when progress, player, server, functions or
   migrations changed). Failure stops before any remote change. Then back up new
   asset and source blobs to the private `fundev-sources` bucket.
2. Apply pending D1 migrations.
3. Deploy the cleanup Worker if it changed or does not exist.
4. Publish changed games to R2: `assets/` files as content-addressed blobs (only
   those not uploaded yet), code under a content-hashed release path, a
   `files.json` index, then the catalog.
5. Build for production and smoke-test it against the live catalog. If this fails,
   the previous catalog is restored and nothing else changes.
6. Deploy `dist/` to Pages with the commit hash (the next release diffs from it).
7. Wait until fun.dev serves the new build, then check the service worker flag,
   game-page and site CSP, game pages, and the smoke test on fun.dev itself.
8. Push `main` to GitHub.

Nothing is "half released" before step 6: a failure leaves the previous site
and catalog. After step 6 a failed live check means fixing forward with a new
commit and another `npm run release`.

### API version changes

The platform runs a single game API version. When a commit changes it (and
every game's `apiVersion`), the plan says so: between step 4 and step 6 the old
site cannot read the new catalog, for a few minutes. Rolling Pages back to a
deployment with another API version shows the same error until rolled forward.

### Removing a game

`npm run game:remove -- <id>` deletes its catalog entry (assets remain, running
sessions continue). Also delete `games/<id>/`, or the next release publishes it
again.

## Credentials

- Wrangler login (`npx wrangler login`) is enough for everything. Game files are
  uploaded with `wrangler r2 object put`; the catalog update is checked by
  re-reading it just before writing, which is safe with a single operator. Do not
  release from two machines at once. `R2_BUCKET` in `.env` overrides the bucket
  (default `fundev-games`).
- Never commit `.env`; never put R2 or Cloudflare credentials in `site/`, games or
  Pages variables. `.env` does not affect builds.

## Reference

| Command | Purpose |
| --- | --- |
| `npm run assets` | Sync binary files with their locks; `--check`, `--use-lock`/`--use-local`, `--push`/`--pull` ([assets](assets.md)) |
| `npm run build` | Local build into `dist/` (games from `games/`, transfer off) |
| `npm run build:production` | Production build (R2 catalog origin, transfer on) |
| `npm run preview` | Serve `dist/` with the production headers |
| `npm run game:remove -- <id>` | Remove a game from the live catalog |
| `npm run transfer:preview` | Local transfer stack: build, local D1, `wrangler pages dev` on https://localhost:8788 |
| `npm run transfer:types` | Regenerate `server/env.d.ts` from Wrangler bindings |
| `npm run models -- list\|sheet\|thumbnails\|apply\|rebuild` | Maintain the model library with the console's own functions against the live data ([models](models.md#review)) |
| `npm run console:build` | Build the model review console into `dist-console/` ([models](models.md)) |

Build environment variables (set by the commands above, not by `.env`):
`FUNDEV_GAME_ORIGIN` (remote catalog origin; empty = local games),
`FUNDEV_ASSET_ORIGIN` and `FUNDEV_API_ORIGIN` (platform files and transfer API on their own
hostnames, [edge](edge.md); empty = same-origin),
`FUNDEV_TRANSFER=1` (enable the transfer UI), `FUNDEV_NO_SW=1` (no service worker).

## Operations

- Production: Pages project `fundev` (direct upload to the production environment from Git `main`, domains
  `fun.dev`, `cdn.fun.dev`, `api.fun.dev`, `fundev.pages.dev`; `fun.dev` itself is served by the CN2
  server, see [edge](edge.md)); R2 bucket `fundev-games` at `games.fun.dev`;
  private R2 bucket `fundev-sources` (blob backups, no public domain);
  D1 `fundev-progress-production`; Worker `fundev-transfer-cleanup-production`
  (hourly; no HTTP endpoint). The model library ([models](models.md)): D1 `fundev-models`,
  Worker `fundev-console-production` on `console.fun.dev` behind Cloudflare Access (upload and
  review).
- The cleanup Worker bounds transfer retention. Check its cron runs in the
  Cloudflare dashboard (Workers → `fundev-transfer-cleanup-production` → Logs)
  after it is first deployed or changed. Local cron tests can use
  `wrangler dev --config wrangler.cleanup.jsonc --persist-to <dir>` and
  `/cdn-cgi/local/scheduled`.
- Restoring the D1 database: disable transfer access first and record the time.
  Keep it disabled for at least 7 days plus 10 minutes after the last possible
  pre-restore relay request, then remove all restored relay rows before reopening,
  so every old creation/cancellation credential expires. Never reopen restored
  ready/claimed transfers, and never reactivate the legacy sync endpoints.
  Ordinary local play is unaffected.
- R2 setup (bucket, custom domain, CORS, caching) is described in
  [game registry](game-registry.md).
