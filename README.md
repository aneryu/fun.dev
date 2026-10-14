# fun.dev

A personal Web game platform, built just for fun. One Three.js container runs
versioned game bundles; games do not ship their own HTML pages.

The catalog includes **Wooden Fish / 敲木鱼**: tap the wooden fish to earn merit, with
procedural Web Audio knocks. The lobby, player, and demo support Chinese and English.

The demo's original mesh has a hollow belly, a narrow slit, round sound holes,
and a tapered tail, with a plain wood-colored material. Its shape reference is
[this wooden-fish model preview](https://booth.pm/ja/items/2154190); no vendor mesh
or texture is included. Its self-contained source, tools and tests are documented
in [the game README](games/cyber-muyu/README.md). To regenerate the mesh:
`npm --prefix games/cyber-muyu run model`. Blender 4.0 is optional for
model editing and is not required to build or run the site.

## Develop, test, release

```sh
npm ci && npx playwright install chromium   # once; also: npx wrangler login
npm run dev [-- <game-id>]                  # live-reloading local site
npm run verify                              # unit + browser checks (~40 s)
npm run release                             # plan → confirm → ship to fun.dev
```

See [docs/workflow.md](docs/workflow.md) for the whole flow, credentials,
reference commands and operations. Requires Node.js 22+ and `tar`.

## Platform structure

- `site/index.html`: original personal homepage, with a Games entry.
- `site/games/index.html`: game lobby, with search and category filtering.
- `site/play/`: shared player, opened as `/play/?game=<id>`.
- `site/runtime/`: Three.js host (API v2: lifecycle, shared audio, options,
  safe area, announcements, haptics), the runtime kit (`kit/`: text, input,
  fixed-step loop, assets, seeded random) and built loaders (`addons/`: glTF,
  Draco, KTX2 with self-hosted decoders).
- `site/sw.js`, `site/manifest.webmanifest`, `site/icons/`: installable app and
  offline play for games opened before. The build writes the precache list.
- `site/404.html`: not-found page; it also forwards share links `/s/<id>/` that
  have no generated page yet. The production build generates `/s/<id>/` and
  `/s/<id>/en/` share pages with Open Graph tags from the R2 catalog.
- `games/<id>/`: each game's source, one directory per game; `game.json` holds its
  catalog metadata, version, and runtime file list. Local builds generate the
  preview catalog and bundles from it; production reads the independent R2 catalog.
- `examples/spinning-cube/`: integration example, excluded from the build/catalog.
- `docs/game-bundles.md`: bundle format, API, and publishing workflow.
- `docs/platform-roadmap.md`: planned shared platform capabilities and their order.

The frontend remains plain HTML/CSS/JavaScript. The small build exists to pin and
serve one local copy of Three.js, without a CDN, remote import map, or duplicated
engine in every game. `esbuild` minifies the engine files without bundling a UI
framework. The default build works as a static site. Optional account transfer
uses Pages Functions and D1 as a temporary relay.

## Local progress and account transfer

Supported games save automatically in IndexedDB without registration. Ordinary
play, reload, focus, and reconnection create no remote account, Cookie, or
progress API request. Wooden Fish uses the optional `context.progress`
capability. The service worker also lets visitors reopen the site and games they
played before without a network connection.

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
import; they never become empty saves automatically. Old session, recovery,
and sync API routes return 410, and migration 0005 dropped the legacy cloud
tables (production held no legacy rows). Existing Cookies are ignored; the new
service issues none.

Run the transfer stack locally with `npm run transfer:preview` (local D1 under
`.wrangler/`, https://localhost:8788) and test it with `npm run verify -- --transfer`.
Preview deployments have no production D1 binding and leave transfer disabled.

The relay accepts 64 KiB per save, 1 MiB per complete packet, and 128 total current
and alternate snapshots. Oversize transfers fail without omitting games. Links
expire after 10 minutes; commit/cancel clears the live payload immediately.
Terminal receipts expire seven days after the transfer deadline. The cleanup
Worker runs hourly and deletes in bounded batches, even with no
visitors. Expired links stop working regardless of cleanup timing.

Admission is capped transactionally at 4,096 transfer records and 64 MiB of live
payload. Network abuse counters use 256 hashed buckets per class (512 rows at
most), with 6 creation/cancellation requests and 120 other requests per minute
per bucket. Addresses are not stored; collisions share a limit. Capacity errors
leave local saves/export available. Monitor scheduled cleanup failures and the
reported aggregate usage; there is no gameplay analytics.

## Add a game

Create `games/<id>/` with `game.js` exporting `createGame(context)` and a
`game.json` manifest, develop it with `npm run dev -- <id>`, and ship it with
`npm run release`, which publishes changed games to the R2 catalog. See
[the bundle contract](docs/game-bundles.md) and [game registry](docs/game-registry.md).

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

`npm run release` deploys `dist/` (from `npm run build:production`) to the `fundev`
Pages project's production environment (Git branch `main`), by direct upload with Wrangler so `functions/`
is compiled too. The build includes the game-development Skill at
`/skills/fun-dev-games.tar.gz` and `/skills/fun-dev-games/SKILL.md`.

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
