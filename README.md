# fun.dev

Little games, made for fun (做着玩的小游戏，点开就玩). A personal Web game platform:
one Three.js container runs versioned game bundles; games do not ship their own HTML pages.
Each game plays at `/games/<id>`, so page analytics count every game on its own path.

The catalog includes **敲木鱼 / Wooden Fish** (`muyu`): tap the wooden fish for merit,
keep a steady beat to reach samadhi, collect twelve relics and draw a daily fortune lot.
Everything on the site and in the game supports Chinese and English. Its self-contained
source, tools and tests are documented in [the game README](games/muyu/README.md).

## Develop, test, release

```sh
npm ci && npx playwright install chromium   # once; also: npx wrangler login
npm run assets -- --pull                    # once per machine: binary files are not in Git
npm run dev [-- <game-id>]                  # live-reloading local site
npm run verify                              # unit + browser checks (~40 s)
npm run release                             # plan → confirm → ship to fun.dev
```

See [docs/workflow.md](docs/workflow.md) for the whole flow, credentials,
reference commands and operations. Requires Node.js 22+ and `tar`.

## Platform structure

- `site/index.html`: original personal homepage, with a Games entry.
- `site/games.html`: game lobby at `/games`, with search and category filtering.
- `site/editor/`: low-poly model workshop at `/editor/`, with a shared command API
  for people and agents, editable projects, booleans and GLB export. See [model editor](docs/model-editor.md).
- `site/player/`: shared player. Its `index.html` is a template: the build writes one page per
  game to `/games/<id>` with that game's title, description, canonical URL and Chinese Open
  Graph tags, so a game's address is also its share link. The build also writes
  `sitemap.xml` (home, lobby, games) and `i18n-boot.js`, which sets the visitor's language
  before the first paint. Game addresses have no trailing slash (`_redirects`);
  the workshop uses `/editor/`.
- `site/runtime/`: Three.js host (API v2: lifecycle, shared audio, options,
  safe area, announcements, haptics), the runtime kit (`kit/`: text, input,
  fixed-step loop, assets, seeded random, MediaPipe vision, and `.fun3d` models: loader and
  writer, TSL materials, batched placement, Jolt physics, clips; see
  [docs/model-format.md](docs/model-format.md)) and built loaders (`addons/`: glTF,
  Draco, KTX2 with self-hosted decoders).
- `site/sw.js`, `site/manifest.webmanifest`, `site/icons/`: installable app and
  offline play for games opened before. The build writes the precache list.
- `site/404.html`: not-found page, also for unknown game IDs. The production build reads the
  R2 catalog for the game pages and stops if it is unavailable.
- `games/<id>/`: each game's source, one directory per game; `game.json` holds its
  catalog metadata, version, and runtime file list. Local builds generate the
  preview catalog and bundles from it; production reads the independent R2 catalog.
- `sources/`: shared library of asset pipeline inputs. It and each game's `assets/`
  are not in Git; locks record them and `npm run assets` syncs them
  ([docs/assets.md](docs/assets.md)).
- `examples/spinning-cube/`: integration example, excluded from the build/catalog.
- `docs/game-bundles.md`: bundle format, API, and publishing workflow.
- `docs/platform-roadmap.md`: planned shared platform capabilities and their order.

The frontend remains plain HTML/CSS/JavaScript. The small build exists to pin and
serve one local copy of Three.js, without a CDN, remote import map, or duplicated
engine in every game. `esbuild` minifies the engine files without bundling a UI
framework. `@mediapipe/tasks-vision` is pinned the same way, as the platform's
vision runtime, so games share one copy instead of each bundling 17 MB.
`manifold-3d` is pinned as the workshop's geometry kernel (booleans and other solid
operations, WebAssembly, loaded only by `/editor/`); the build copies its module and
`.wasm` to `editor/vendor/`, and bundles the agent tool: `tools/workshop-<hash>.mjs` (the
workshop for Node, kernel included), `tools/workshop.json` naming it, and the launcher
`tools/fundev-workshop.mjs`.
`jolt-physics` is pinned as the physics runtime (`/runtime/physics/<hash>/`, loaded by
games on first use, cached forever) and `meshoptimizer` encodes `.fun3d` geometry (the
encoder serves the workshop and the converter; games only decode). The
default build works as a static site. Optional account transfer
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

The project answers on three hostnames: `fun.dev` (pages, through a CN2 server that makes the
site fast in mainland China), `static.fun.dev` (every other platform file) and `api.fun.dev` (the
transfer API). See [docs/edge.md](docs/edge.md).

## Analytics

Use **Cloudflare Web Analytics** for unified page-view, visitor, and Web Vitals
reporting across `/`, `/games` and each game's `/games/<id>`. The existing `fun.dev` analytics
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

The PC model workshop also provides parameter recipes, persistent checkpoints,
reproducible observations and a local Agent CLI / stdio MCP adapter:
`npm run editor:agent -- --help`. See [model editor](docs/model-editor.md).
