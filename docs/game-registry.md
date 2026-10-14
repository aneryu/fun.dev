# Independent game registry

The public website and games have separate release lifecycles:

- Pages serves the homepage, lobby and shared Three.js container.
- A dedicated R2 bucket serves `games.json` and immutable bundles through a
  configured HTTPS custom domain. The provisioned bucket is `fundev-games`,
  with custom domain `games.fun.dev`.
- A local/CI publisher writes through the authenticated R2 S3 API. The browser
  has read-only access. There is no public registration API or server database.

## One-time setup

1. Create a dedicated bucket and connect an HTTPS custom domain. Do not use the
   rate-limited `r2.dev` development endpoint for production.
2. Apply `config/r2-cors.json` using Wrangler. It permits only `GET`/`HEAD`
   from `https://fun.dev` and `https://fundev.pages.dev`.
   Add exact preview origins only when needed; do not allow browser writes.
3. Bypass CDN caching for `/games.json`. Its object metadata is also `no-store`.
   Do not override it with a Cache Everything rule. Versioned assets use
   `public, max-age=31536000, immutable`; old releases remain available.
4. Configure a bucket-scoped Object Read & Write R2 S3 credential in the local
   environment or CI secret store: `R2_ENDPOINT`, `R2_BUCKET`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. The endpoint is the S3 API origin,
   not the public custom domain. The publisher reads an optional `.env` in the
   checkout root (Git-ignored); existing environment variables take precedence.
   Never put these credentials in Pages/frontend config.
5. Publish the initial games with the command below. Set the non-secret Pages
   build variable `FUNDEV_GAME_ORIGIN` to the public HTTPS origin and deploy the
   website once. That build removes the bundled catalog and demo releases from
   `dist/`, writes the fixed read origin and permits it in CSP. No wildcard
   origins, query-selected origins or local-server connection are supported.

Changing the resource origin or container API requires a website deployment.
Registering, updating and removing compatible games does not.

## Publish and register

Each game's source directory `games/<id>/` has a `game.json` beside `game.js`:

```json
{
  "id": "my-game",
  "version": "1.0.0",
  "apiVersion": 2,
  "title": {"zh": "我的游戏", "en": "My game"},
  "description": {"zh": "一句话玩法", "en": "One-line description"},
  "category": "Puzzle",
  "platforms": ["mobile", "desktop"],
  "cover": "assets/cover.jpg",
  "files": ["game.js", "assets/model.glb", "assets/cover.jpg"]
}
```

`npm run release` publishes every game whose content differs from the live
catalog (see [workflow](workflow.md)); `npm run game:remove -- my-game` removes an
entry. To inspect a release without publishing:

```sh
node scripts/publish-game.mjs publish games/my-game/game.json --dry-run
```

The dry run needs no credentials and prints the exact file list, size and hash.
Only listed files are uploaded. It rejects unsafe paths, symlinks, unsupported
file types and literal imports outside the list. Limits are 4096 files/64 MiB
per release for this simple publisher; it does not use multipart upload.
These checks are not code review or a sandbox. Review file contents, computed
asset URLs and runtime behavior separately. HTML/CSS pages are not game bundles.

The publisher reads the current catalog and ETag, uploads all files under
`games/<id>/<version>/<content-hash>/` plus a `files.json` list of them (used by
the site's service worker to cache a whole release), then conditionally replaces
`games.json`. It accepts only the platform's current `apiVersion`.
The manifest is not uploaded. Repeating a release verifies existing immutable
objects and can resume a partial upload. Changed bytes produce a new hash;
use a new semantic version for an intentional release. Existing ID updates
retain catalog order; new IDs append. Unlisted folders never appear by discovery.

The final catalog write uses `If-Match` (or `If-None-Match: *` when creating it).
An upload failure leaves the catalog unchanged. A concurrent catalog change
stops publication without overwriting it; inspect the latest state and rerun.
There is no automatic conflict merge. Partial/unreferenced uploads may remain;
cleanup is a separate deliberate task. The publisher does not delete assets.

Removal hides the game after the next catalog fetch, not from already running
sessions or anyone holding its public asset URL. Roll back by publishing the
previous version's `games/<id>/` from Git history. Each lobby visit/player load fetches the live
catalog; an already open lobby must be refreshed to see changes.

The initial Wooden Fish release was uploaded with authenticated Wrangler into
the verified-empty bucket, with the catalog written last. This was a single-writer
bootstrap, not the conditional-write publisher. The regular publication commands
still require bucket-scoped S3 credentials; Wrangler/MCP OAuth does not create
those credentials automatically. Do not use unconditional catalog writes for
routine or concurrent updates.

## Security and local preview

Only the preconfigured resource origin supplies code. Registry entries contain
IDs, versions and hashes rather than arbitrary script URLs. HTTPS, CSP and CORS
must all work; an unavailable registry shows a loading error, with no stale
bundled-catalog fallback in a remote build.

Cross-origin files still execute inside the fun.dev document. Only publish
trusted games; this is deployment independence, not isolation from DOM/storage.
R2 write credentials therefore grant the ability to publish code run on fun.dev.

`npm run build`, `npm run dev` and `npm run verify` bundle the local `games/`
sources and catalog; `npm run build:production` reads the R2 catalog. During
`npm run release`, the production build is smoke-tested against the live R2
catalog through a local proxy, because R2 CORS admits only the public origins. It does not connect the online
site to a local server. Production must explicitly configure the remote origin.

Sources: [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/),
[CORS](https://developers.cloudflare.com/r2/buckets/cors/),
[conditional writes](https://developers.cloudflare.com/r2/api/s3/extensions/).
