# Parallel game development

Several agents (or people) can build different games at the same time. Each game
lives in its own `games/<id>/` directory, the catalog is generated from those
directories, and tests use random ports, so games do not touch shared files.
The only shared points are the platform code, `main`, and the release.

## Roles

| Role | Where | Owns | May run |
| --- | --- | --- | --- |
| Coordinator (one) | main checkout, branch `main` | game IDs, merges, releases | everything, including `npm run release` and `npm run game:remove` |
| Game agent (one per game) | own worktree, branch `game/<id>` | `games/<id>/` only | `npm run dev`, `npm test`, `npm run verify` |
| Platform agent (at most one at a time) | own worktree, branch `platform/<topic>` | `site/`, `scripts/`, `server/`, `functions/`, `migrations/`, `skills/`, docs | same as a game agent |

Game and platform agents never push, release, publish, or run remote Wrangler
commands. The publisher's catalog check is not atomic, so releases are serial and
come only from the coordinator.

## Start a game

The coordinator reserves a unique ID (the directory name is the only shared
namespace), then creates a worktree from the current `main`:

```sh
git worktree add ../fundev-wt/<id> -b game/<id> main
ln -s "$PWD/node_modules" ../fundev-wt/<id>/node_modules
(cd ../fundev-wt/<id> && npm run assets)   # binary files from the shared local cache
```

The symlink shares the main checkout's dependencies (and Playwright's browser
download is shared anyway), so a worktree costs no install time or disk. Do not
change dependencies while worktrees are open; a branch that needs to should run
`rm node_modules && npm ci` in its own worktree instead. Each worktree has its
own `dist/`, `test-results/` and `.wrangler/`. Give each agent its own dev port:
`PORT=8001 npm run dev -- <id>`.

A new game starts from `skills/fun-dev-games/assets/game.js` copied to
`games/<id>/game.js`, plus a `games/<id>/game.json` whose `id` matches the
directory. See [game bundles](game-bundles.md) and the
[fun-dev-games skill](../skills/fun-dev-games/SKILL.md).

## Game agent rules

- Change only `games/<id>/`, plus new files in the shared `sources/` library: add
  them, never change or delete listed ones (see [assets](assets.md)). If the game needs a platform change (a new host
  capability, a kit helper, a player fix), stop and describe it to the
  coordinator instead of editing `site/`.
- Bump the game's `version` in `game.json` when its code or assets change.
- After adding or changing files in `assets/` or `sources/`, run `npm run assets` and
  commit the locks. Never run `--push` or `--pull`: they use Wrangler.
- While iterating: `npm run verify -- smoke --game=<id>` (all unit tests, the
  build, and the smoke test of this game only).
- Before handing back: the full `npm run verify` must pass.
- Commit on `game/<id>` and report the branch, the last commit, the verify
  summary, and anything left open. Do not merge.

## Merge (coordinator)

Each game agent already ran the full verify, so merging is only a scope check;
verification runs once for the whole batch.

```sh
git diff --name-only main...game/<id>    # must list only games/<id>/ (and sources/sources.lock)
git diff main...game/<id> -- sources/sources.lock | grep '^-[^-]'   # must print nothing: sources are only added
git -C ../fundev-wt/<id> status --short  # must be clean (all work committed)
git -C ../fundev-wt/<id> rebase main
git merge --ff-only game/<id>            # in the main checkout, on main
npm run assets                           # bring the merged files from the shared cache
```

Repeat for each finished game, then run `npm run verify` once on `main` (or go
straight to `npm run release`, whose first step is the same verify). Reject a
branch that touches files outside its directory; move those changes to a platform
branch. Game branches rebase without conflicts because they share no files except
`sources/sources.lock`, which merges as a union.
If the batch verify fails, find the game with `npm run verify -- smoke --game=<id>`
and `git revert` its commits rather than blocking the other games.

## Platform changes

- One platform branch at a time. It affects every game, so run the full
  `npm run verify` in its worktree before merging it on its own (not in a batch).
  It merges before the games that depend on it;
  afterwards every open game branch rebases onto `main` and re-runs verify.
- The platform runs a single game API version. A change to the API version must
  update every game in the same merge, so make it while no game branch is open,
  or let the platform agent update all games in its branch.

## Release

Only the coordinator releases, from `main`, after merging. Several merged games
can ship in one `npm run release`; it publishes every game whose content differs
from the R2 catalog. See [workflow](workflow.md#3-release).

## Finish

```sh
git worktree remove ../fundev-wt/<id>
git branch -d game/<id>
```

## Claude Code and other agents

Every agent reads `AGENTS.md`, which points here. With Claude Code, a subagent
started with worktree isolation gets its own checkout under `.claude/worktrees/`
(ignored by Git); it is created from `origin/main` by default, so push `main`
first. The rules above still apply: one game per agent, its own directory only,
no release.

Prompt template for a game agent:

> You are a game agent for fun.dev. Read AGENTS.md and docs/parallel-games.md.
> Build the game `<id>` in `games/<id>/` on branch `game/<id>`: <idea>.
> Change only `games/<id>/`. Iterate with `npm run verify -- smoke --game=<id>`;
> finish with a passing `npm run verify`, commit, and report the branch, commit,
> verify summary and open questions. Do not push, merge, release or publish.
