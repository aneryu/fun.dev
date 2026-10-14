# Release and deployment

## Runtime artifact

Export browser ESM at `game.js`, relative modules and assets. Do not publish the
game's own HTML/CSS, another Three.js copy, source secrets, node_modules or build
tools. Source tooling may live in bundle-root `dev/`, `package.json` and README;
the platform build omits these development files. Other files remain publishable,
so inspect the complete artifact, not only the entry module.

## Independent game publication

Create `game.json` beside the game entry with `id`, `version`, `apiVersion: 1`,
`title`, `description`, `category`, `platforms` and an explicit `files` array
including `game.js`. Text supports both zh/en translations. Publish only reviewed
runtime files. The game may live outside the platform checkout.

From the fun.dev checkout, inspect `docs/game-registry.md` and run:

```sh
npm run game:publish -- /absolute/path/to/game.json --dry-run
# Only when game publication is authorized:
npm run game:publish -- /absolute/path/to/game.json
npm run game:remove -- my-game
```

The publisher uses locally configured `R2_ENDPOINT`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. Never embed these in browser code.
It uploads immutable content-addressed files first, then conditionally updates
`games.json`. Conflicts stop without overwrite; inspect and retry. Removal only
changes the catalog, preserving releases and active sessions. Rollback republishes
an older saved bundle. No Pages build, deploy or Git push is part of registration.

A one-time website deployment must configure `FUNDEV_GAME_ORIGIN`, the trusted
public HTTPS resource origin, with CORS and caching configured on R2. Subsequent
game releases need no website deployment. `site/games.json` and bundled demo files
are local preview fixtures, removed from production builds with a remote origin.

Verify browser loading, resource paths, mobile/desktop, touch/keyboard,
pause/resume, restart and cleanup. Check `/games/?lang=zh`, `/games/?lang=en`
and the direct player URL. Publishing files does not establish browser success.

## Authorized Pages publication

The recorded target is the existing `fundev` Pages project, production branch
`production`, custom domain `fun.dev`. Read current repository instructions and
verify the authenticated project, domain and branch before uploading. Use the
available Wrangler CLI; do not install a framework or add Workers configuration
to a purely static Pages site.

For production website builds, set `FUNDEV_GAME_ORIGIN` to the verified public
resource origin. A build without it contains local demo fixtures and is not the
independent-registry production artifact. Inspect `dist/game-source.js`, CSP and
the absence of `dist/games.json` before deploying.

```sh
wrangler pages project list
wrangler pages deployment list --project-name fundev
# Only with the user's deployment authorization and the target verified:
wrangler pages deploy dist --project-name fundev --branch production
```

If deploying a deliberately reviewed dirty tree, report that fact and use
`--commit-dirty=true`; do not pretend its contents match the recorded Git commit.
A publish request does not itself request a Git commit or push. Preserve unrelated
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
