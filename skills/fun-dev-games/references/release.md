# Release and deployment

## Runtime artifact

Export browser ESM at `game.js`, relative modules and assets. Do not publish the
game's own HTML/CSS, another Three.js copy, source secrets, node_modules or build
tools. Source tooling may live in bundle-root `dev/`, `package.json` and README;
the platform build omits these development files. Other files remain publishable,
so inspect the complete artifact, not only the entry module.

## Independent game publication

Create `games/<id>/game.json` beside the game entry with `id` (matching the
directory name), `version`, `apiVersion: 2`, `title`, `description`, `category`,
`platforms`, optional `orientation`/`howToPlay`/`cover`/`keepAwake`, and an
explicit `files` array including `game.js` (and the cover). The publisher also
uploads a `files.json` list for offline caching. Text supports
both zh/en translations. Publish only reviewed runtime files. Bump `version` for
each release; Git keeps earlier versions.

From the fun.dev checkout, read `docs/workflow.md`. Inspect a release with
`node scripts/publish-game.mjs publish games/my-game/game.json --dry-run`.
Only when publication is authorized, commit on `production` and run
`npm run release`: it publishes changed games, deploys the site if needed, and
checks fun.dev afterwards. `npm run game:remove -- my-game` removes a game.

The publisher uses the local `npx wrangler login` session (bucket `fundev-games`,
or `R2_BUCKET`). Never embed Cloudflare credentials in browser code.
It uploads immutable content-addressed files first, then re-reads and updates
`games.json`. Conflicts stop without overwrite; inspect and retry. Removal only
changes the catalog, preserving releases and active sessions. Rollback republishes
an older saved bundle. No Pages build, deploy or Git push is part of registration.

A one-time website deployment must configure `FUNDEV_GAME_ORIGIN`, the trusted
public HTTPS resource origin, with CORS and caching configured on R2. Subsequent
game releases need no website deployment. Local builds bundle `games/` with a
generated catalog; production builds with a remote origin bundle no games.

Verify browser loading, resource paths, mobile/desktop, touch/keyboard,
pause/resume, restart and cleanup. Check `/games/?lang=zh`, `/games/?lang=en`
and the direct player URL. Publishing files does not establish browser success.

## Authorized Pages publication

The recorded target is the existing `fundev` Pages project, production branch
`production`, custom domain `fun.dev`. Read current repository instructions and
verify the authenticated project, domain and branch before uploading. Use the
available Wrangler CLI; do not install a framework or add Workers configuration
to a purely static Pages site.

Deploy only with `npm run release` (with the user's authorization). It refuses a
dirty tree or another branch, prints the plan (D1 migrations, cleanup Worker,
games, website) before changing anything, verifies locally, smoke-tests the
production build against the live catalog, deploys `dist/` from
`npm run build:production`, checks fun.dev, and pushes. `npm run release -- --check`
repeats only the live checks. A publish request does not itself request a Git
commit; ask before committing unrelated work. Preserve unrelated
changes and never deploy an unreviewed whole working tree merely for convenience.

Use configured credentials without printing them. If authentication fails, stop
remote mutation and explain how the user can configure authentication locally.
Do not ask them to paste secrets into chat, create a different project, or change
DNS/settings to bypass the failure.

After upload, check the deployment URL and fun.dev for the intended catalog,
bundle, assets and player. Also inspect effective CSP/Permissions-Policy on the
public site; Pages header matching can differ from a local
preview. The public Skill must match the same release's runtime contract.

Report deployment identity, verified URLs and remaining limitations. If the
public domain returns an access error, say so rather than treating a successful
upload as a successful public release.

[Current Wrangler Pages commands](https://developers.cloudflare.com/workers/wrangler/commands/pages/)
