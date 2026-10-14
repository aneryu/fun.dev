# Workflow: develop, test, release

Three commands cover day-to-day work. Everything else is in the reference below.

```sh
npm run dev [-- <game-id>]   # develop with live reload
npm run verify               # check everything locally (~40 s)
npm run release              # ship to fun.dev (plan → confirm → execute → live checks)
```

Setup once: Node.js 22+, `npm ci`, `npx playwright install chromium`, and
`npx wrangler login` (an account with access to the `fundev` Pages project, the
`fundev-games` R2 bucket and the production D1 database). `.env` is optional; see
[Credentials](#credentials).

## 1. Develop

```sh
npm run dev                  # http://127.0.0.1:8000, rebuilds and reloads on save
npm run dev -- cyber-muyu    # prints the player URL for one game, with ?debug=1
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
- `npm test` (~20 s) runs only the unit tests, including each game's `dev/` tests.

## 2. Verify

`npm run verify` builds once and runs, in one Chromium:

| Suite | Checks |
| --- | --- |
| unit | `node --test`: catalog, publisher, CSP, kit, share pages, progress protocol with local D1, game tests |
| smoke | every game at phone and desktop size: runs, not blank, language switch, pause/resume, restart, clean exit, no console errors |
| kit | text/HUD placement, pointer/keyboard/joystick, glTF with embedded textures, Draco/KTX2 under the player CSP |
| player | loading bar, announcements, options/settings/cheats, mute, share, restart, debug panel, rotation prompt, API mismatch |
| site | lobby covers, share pages and 404 forwarding, manifest/icons, offline play through the service worker |

`npm run verify -- smoke player` runs only some browser suites;
`npm run verify -- --transfer` adds the slower account-transfer test (local D1 with
`wrangler pages dev`). Screenshots go to `test-results/`. Commit when it passes.

## 3. Release

Commit on `production`, then:

```sh
npm run release              # shows the plan and asks for confirmation
npm run release -- --yes     # same, without the prompt
npm run release -- --check   # only the live checks against fun.dev
```

`release` refuses a dirty tree or another branch. It reads the live state and
prints a plan: which commit fun.dev runs, pending D1 migrations, whether the
cleanup Worker changed (or is missing), which games differ from the R2 catalog
(by content hash), and whether the website needs deploying (site code changed or
games were published, which refreshes the share pages). After confirmation:

1. `verify` (plus the transfer test when progress, player, server, functions or
   migrations changed). Failure stops before any remote change.
2. Apply pending D1 migrations.
3. Deploy the cleanup Worker if it changed or does not exist.
4. Publish changed games to R2: files under a content-hashed path, a
   `files.json` list, then the catalog.
5. Build for production and smoke-test it against the live catalog. If this fails,
   the previous catalog is restored and nothing else changes.
6. Deploy `dist/` to Pages with the commit hash (the next release diffs from it).
7. Wait until fun.dev serves the new build, then check the service worker flag,
   player and site CSP, share pages, and the smoke test on fun.dev itself.
8. Push `production` to GitHub.

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
| `npm run build` | Local build into `dist/` (games from `games/`, transfer off) |
| `npm run build:production` | Production build (R2 catalog origin, transfer on) |
| `npm run preview` | Serve `dist/` with the production headers |
| `npm run game:remove -- <id>` | Remove a game from the live catalog |
| `npm run transfer:preview` | Local transfer stack: build, local D1, `wrangler pages dev` on https://localhost:8788 |
| `npm run transfer:types` | Regenerate `server/env.d.ts` from Wrangler bindings |

Build environment variables (set by the commands above, not by `.env`):
`FUNDEV_GAME_ORIGIN` (remote catalog origin; empty = local games),
`FUNDEV_TRANSFER=1` (enable the transfer UI), `FUNDEV_NO_SW=1` (no service worker).

## Operations

- Production: Pages project `fundev` (direct upload, branch `production`, domains
  `fun.dev`, `fundev.pages.dev`); R2 bucket `fundev-games` at `games.fun.dev`;
  D1 `fundev-progress-production`; Worker `fundev-transfer-cleanup-production`
  (every five minutes; no HTTP endpoint).
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
