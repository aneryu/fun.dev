# fun.dev

A personal Web game platform, built just for fun. One Three.js container runs
versioned game bundles; games do not ship their own HTML pages.

The catalog includes **Wooden Fish / 敲木鱼**: tap the wooden fish to earn merit, with
procedural Web Audio knocks. The lobby, player, and demo support Chinese and English.

The demo's original mesh has a hollow belly, a narrow slit, round sound holes,
and a tapered tail, with a plain wood-colored material. Its shape reference is
[this wooden-fish model preview](https://booth.pm/ja/items/2154190); no vendor mesh
or texture is included. Its self-contained source, tools and tests are documented
in [the game README](site/games/cyber-muyu/1.1.0/README.md). To regenerate the mesh:
`npm --prefix site/games/cyber-muyu/1.1.0 run model`. Blender 4.0 is optional for
model editing and is not required to build or run the site.

## Local preview

Requires Node.js 22 or newer and npm:
The build also uses `tar` to package the downloadable game-development Skill.

```sh
npm ci
npm run build
npm run preview
```

Then open <http://127.0.0.1:8000>. The preview listens on all interfaces, so
other devices on the same network can use this machine's address, for example
<http://192.168.1.12:8000>. It serves `dist/` and applies the repository's
response headers, including its Content Security Policy. Rebuild after editing
source files. Set `PORT` for another port, or `HOST=127.0.0.1` to keep the
preview on this machine only.

## Platform structure

- `site/index.html`: original personal homepage, with a Games entry.
- `site/games/index.html`: game lobby, with search and category filtering.
- `site/games.json`: local preview catalog; production reads the independent R2 catalog.
- `site/play/`: shared player, opened as `/play/?game=<id>`.
- `site/runtime/`: Three.js host, lifecycle, and resource ownership helpers.
- `site/games/<id>/<version>/game.js`: each game's ESM bundle and adjacent assets.
- `examples/spinning-cube/`: integration example, excluded from the build/catalog.
- `docs/game-bundles.md`: bundle format, API, and publishing workflow.

The frontend remains plain HTML/CSS/JavaScript. The small build exists to pin and
serve one local copy of Three.js, without a CDN, remote import map, or duplicated
engine in every game. `esbuild` minifies the engine files without bundling a UI
framework. The default build works as a static site. Optional account transfer
uses Pages Functions and D1 as a temporary relay.

## Local progress and account transfer

Supported games save automatically in IndexedDB without registration. Ordinary
play, reload, focus, and reconnection create no remote account, Cookie, or
progress API request. Wooden Fish 1.1.0 uses the optional `context.progress`
capability; older bundles remain compatible. Offline saving covers an already
loaded game, not offline loading of the site and its assets.

In **My progress / 我的进度**, choose **Transfer to another device**, open the
private one-use link there, and choose **Receive and continue**. All games in the
current profile move together. The source is frozen before packaging; the target
activates only after durable local storage and server confirmation. The source
then becomes read-only. Cancellation and uncertain responses are reconciled
before either device resumes. Opening a link alone never changes accounts.

The receiving browser keeps its previous profile separately in exports. Local
export/import and reset remain available. Losing the only device or clearing
browser data without an exported backup loses the progress: there is no cloud
backup or multi-device synchronization. See the [transfer design](docs/account-transfer.md)
for guarantees and the [historical review](docs/anonymous-progress.md) for the
retired synchronization implementation.

IndexedDB v1 upgrades transactionally to v2 with a new local profile ID,
retaining the latest local snapshot,
other profiles, and legacy conflict/in-flight alternatives for export.
Unconfirmed legacy cloud-only slots remain blocked until an explicit reset or
import; they never become empty saves automatically. Existing
cloud tables are preserved by the additive migration, but old session, recovery,
and sync API routes now return 410. Old cloud-only saves require an operator
export before retiring any legacy database; the browser does not silently fetch
or choose them. Existing Cookies are ignored; the new service issues none.

## Local transfer preview

```sh
npm run build:transfer-local
npm run db:local
npm run preview:transfer
```

Open <https://localhost:8788> and accept the development certificate. These
commands use an isolated local D1 database under `.wrangler/`; they do not modify
Cloudflare resources. Stop the plain static preview if it uses the same port.
The default `npm run build` disables transfer unless `FUNDEV_TRANSFER=1` is set.
Preview deployments have no production D1 binding and leave transfer disabled.
The old `FUNDEV_PROGRESS_CLOUD` flag has no effect.

```sh
npm test                 # Includes real local D1/workerd and IndexedDB fault tests
npx playwright install chromium
npm run test:browser     # Temporary local D1; desktop/mobile, screenshots in test-results/
npm run types:cloud
npm run check:cleanup    # Bundle the scheduled Worker with --dry-run; no deployment
npm run build:production # Remote game catalog + transfer-enabled frontend
```

The relay accepts 64 KiB per save, 1 MiB per complete packet, and 128 total current
and alternate snapshots. Oversize transfers fail without omitting games. Links
expire after 10 minutes; commit/cancel clears the live payload immediately.
Terminal receipts expire seven days after the transfer deadline. The cleanup
Worker runs every five minutes and deletes in bounded batches, even with no
visitors. Expired links stop working regardless of cleanup timing.

Admission is capped transactionally at 4,096 transfer records and 64 MiB of live
payload. Network abuse counters use 256 hashed buckets per class (512 rows at
most), with 6 creation/cancellation requests and 120 other requests per minute
per bucket. Addresses are not stored; collisions share a limit. Capacity errors
leave local saves/export available. Monitor scheduled cleanup failures and the
reported aggregate usage; there is no gameplay analytics.

## Production activation

The production D1 resource is referenced by `env.production`. Deployment must
include both the Pages application and the cleanup Worker; existing dashboard
flags alone do not activate the new protocol. Compatibility date 2026-10-13
matches the installed workerd binary.

After deployment is authorized:

1. Inspect existing remote data and preserve/export any legacy cloud saves.
   Apply additive migration 0004 with `npm run db:production`. Keep old tables
   until their retention/export decision is made; migration does not drop them.
2. Deploy the cleanup Worker with `wrangler deploy --config wrangler.cleanup.jsonc
   --env production --env-file /dev/null`. Verify its five-minute trigger and
   successful cleanup execution before opening transfers to users.
3. Build with `npm run build:production`, then deploy `dist/` to the `fundev`
   Pages project on branch `production`. The checked-in production settings use
   `TRANSFER_ENABLED=true`, `TRANSFER_ORIGIN=https://fun.dev`, and the existing
   `DB` binding. The frontend uses `FUNDEV_TRANSFER=1`; legacy progress flags
   do not enable it. Verify preview isolation and the one-use transfer flow.
4. Publish Wooden Fish 1.1.0 separately if the independent R2 catalog still
   references 1.0.0. Website deployment does not publish a game release.

The cleanup Worker is independently configured in `wrangler.cleanup.jsonc` and
has no public HTTP endpoint. It is necessary for bounded retention, not an
optional request-driven optimization. Local cron tests can use `wrangler dev
--config wrangler.cleanup.jsonc --persist-to <isolated-directory>` and invoke
`/cdn-cgi/local/scheduled`; they must share the intended local D1 state.

Document the actual D1 Time Travel/backup retention for the production plan.
Application deletion removes live records, not old database backups. Before restoring this database, disable transfer access and record that time.
Keep access disabled for at least 7 days plus 10 minutes after the last possible
pre-restore relay request, then remove all restored relay rows before reopening.
This quarantine lets every old creation/cancellation credential expire; merely
clearing rows and reopening immediately could falsely imply cancellation of a
completed handoff. Ordinary local play is unaffected during quarantine.
Never reopen restored ready/claimed transfers: they may already have completed.
Do not restore or reactivate legacy synchronization endpoints during rollback.

## Add a game

Export `createGame(context)` from `game.js` and list the runtime files in a
`game.json` manifest. Publish/register directly to R2 with `npm run game:publish
-- /path/to/game.json`; use `--dry-run` to inspect first. Game updates and removals
do not rebuild or deploy the website. See [independent registration](docs/game-registry.md)
for one-time storage/domain setup, credentials, caching, rollback and commands,
and [the bundle contract](docs/game-bundles.md) for the runtime interface.

`@aws-sdk/client-s3` is a pinned development dependency used only by the publisher.
It is not shipped to browsers. Local preview retains the bundled demo.

## Validation

```sh
npm test
npm run build
git diff --check
```

The build checks catalog metadata, bundle entry files, JavaScript syntax, literal
module imports, HTML links/fragments, and CSS asset references. It cannot infer
computed asset URLs or validate gameplay. Preview new bundles in a browser at
mobile and desktop sizes, including pause/resume, restart, backgrounding, and
the console. Test fixtures are separate from the published demo.

## Language

Language follows the browser by default. A quiet top-right selector (inside the
player menu on mobile) offers Auto, 中文 and English. An explicit choice is
kept in local storage and propagated through `?lang=zh` / `?lang=en` links; Auto
clears the override and leaves links unpinned. Browser language changes update
the current page in Auto mode. Language selection uses no
cookies; local progress and account transfer do not create session Cookies. An explicit URL language takes precedence, followed by the
saved preference and the browser's language. Game progress survives switching.
Game metadata supports `{ "zh": "中文", "en": "English" }` fields, and bundles
receive the current locale through the shared container.

## Cloudflare Pages

The build includes the game-development Skill at `/skills/fun-dev-games.tar.gz`
and its readable entry at `/skills/fun-dev-games/SKILL.md`. These addresses have
no visible page entry; publishing the website publishes the matching Skill.

- Production build command: `npm run build:production` (static/local preview: `npm run build`)
- Build output directory: `dist`
- Production branch: `production`

These are the settings for deploying this version. The existing Cloudflare
project settings have not been changed; if they still publish `site`, update
them to the above when deployment is authorized. `dist/` contains static
files; deploy from this repository so Wrangler also compiles `functions/`. See Cloudflare's [static HTML guide](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/).

## Analytics

Use **Cloudflare Web Analytics** for unified page-view, visitor, and Web Vitals
reporting across `/`, `/games/`, and `/play/`. The existing `fun.dev` analytics
site injects the beacon through the domain's automatic setup. Pages project
analytics is disabled to avoid duplicate snippets. Do not add another script to
individual pages or game bundles. Site identifiers stay in Cloudflare settings.
The existing exclusion of EU visitors from automatic injection is retained.

The former Pages analytics site allowed only `fundev.pages.dev`, which rejected
reports from the production custom domain. Keep Pages analytics disabled when
changing settings or deploying; use the `fun.dev` Web Analytics dashboard.
Verify one beacon per page and successful collection POST responses outside
excluded regions. A loaded script alone does not prove that reporting works.
The player removes private transfer fragments before the deferred beacon runs.
Do not send account IDs, transfer credentials, save contents, or gameplay events
to analytics.

The production Content Security Policy permits Cloudflare's beacon script,
including its versioned path, and both same-origin collection and the
`https://cloudflareinsights.com/cdn-cgi/rum` endpoint.
