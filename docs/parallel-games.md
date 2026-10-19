# Parallel game development

Several agents (or people) can build different games at the same time. Game
sources live in the private repository `fundev-games`, checked out beside the
platform (`~/fundev` and `~/fundev-games`); each game lives in its own `<id>/`
directory there, the catalog is generated from those directories, and tests use
random ports, so games do not touch shared files. The only shared points are the
platform code, the shared `sources/` library, `main` of each repository, and the
release.

## Roles

| Role | Where | Owns | May run |
| --- | --- | --- | --- |
| Coordinator (one) | main checkouts of both repositories, branch `main` | game IDs, `sources/`, merges, releases | everything, including `npm run release` and `npm run game:remove` |
| Game agent (one per game) | own worktree of `fundev-games`, branch `game/<id>` | `<id>/` only | the platform's `npm run dev`, `npm run assets` and `npm run verify` against its worktree; the game's own `dev/` tests |
| Platform agent (at most one at a time) | own worktree, branch `platform/<topic>` | `site/`, `scripts/`, `server/`, `functions/`, `migrations/`, `skills/`, docs | same as a game agent |

Game and platform agents never push, release, publish, or run remote Wrangler
commands. The publisher's catalog check is not atomic, so releases are serial and
come only from the coordinator.

## Start a game

The coordinator reserves a unique ID (the directory name is the only shared
namespace), then creates a worktree of the games repository from its current
`main`:

```sh
cd ~/fundev-games
git worktree add ../fundev-games-wt/<id> -b game/<id> main
ln -s "$PWD/node_modules" ../fundev-games-wt/<id>/node_modules
cd ~/fundev
FUNDEV_GAMES=../fundev-games-wt/<id> npm run assets   # binary files from the shared local cache
```

The symlink shares the games checkout's dependencies (Playwright for the games'
dev scripts, whose browser download is shared anyway), so a worktree costs no
install time or disk. The platform tools run from the platform checkout and are
pointed at the worktree with `FUNDEV_GAMES` (or `--games=` for verify). Give each
agent its own dev port:
`FUNDEV_GAMES=../fundev-games-wt/<id> PORT=8001 npm run dev -- <id>`.

A new game starts from `skills/fun-dev-games/assets/game.js` copied to
`<id>/game.js`, plus an `<id>/game.json` whose `id` matches the directory. See [game bundles](game-bundles.md) and the
[fun-dev-games skill](../skills/fun-dev-games/SKILL.md).

## Game agent rules

- Change only `<id>/` in the games repository. New files for the platform's shared
  `sources/` library go through the coordinator, who adds them (never changing or
  deleting listed ones; see [assets](assets.md)). If the game needs a platform
  change (a new host capability, a kit helper, a player fix), stop and describe it
  to the coordinator instead of editing the platform.
- Bump the game's `version` in `game.json` when its code or assets change.
- After adding or changing files in `<id>/assets/`, run
  `FUNDEV_GAMES=<worktree> npm run assets` from the platform checkout and commit
  `<id>/assets.lock`. Never run `--push` or `--pull`: they use Wrangler.
- Verify with the platform's
  `npm run verify -- --games=<path to the fundev-games worktree> --game=<id>` (the
  build and the smoke test of this game on phone and desktop), plus the game's
  own tests: `node --test <id>/dev/*.test.mjs` in the worktree. Both must pass
  before handing back.
- Commit on `game/<id>` and report the branch, the last commit, the verify
  summary, and anything left open. Do not merge.

## Merge (coordinator)

Each game agent already ran its smoke test, so merging is only a scope check;
verification runs once for the whole batch. In the games repository's main
checkout, on `main`:

```sh
git diff --name-only main...game/<id>    # must list only <id>/
git -C ../fundev-games-wt/<id> status --short  # must be clean (all work committed)
git -C ../fundev-games-wt/<id> rebase main
git merge --ff-only game/<id>
(cd ~/fundev && npm run assets)          # bring the merged files from the shared cache
```

Repeat for each finished game, then run
`npm run verify -- --games=../fundev-games` once from the platform checkout (or go
straight to `npm run release`, which smoke-tests each game it is about to
publish). Reject a branch that touches files outside its directory; move platform
needs to a platform branch and new sources to the platform's `sources/`. Game
branches rebase without conflicts because they share no files.
If the batch verify fails, find the game with
`npm run verify -- --games=../fundev-games --game=<id>` and `git revert` its
commits rather than blocking the other games.

## Platform changes

- One platform branch at a time. It affects every game, so run the full
  `npm run verify` (the platform's test game) and
  `npm run verify -- --games=../fundev-games` in its worktree before merging it on
  its own (not in a batch). It merges before the games that depend on it;
  afterwards every open game branch rebases onto `main` and re-runs its smoke test.
- The platform runs a single game API version, with no compatibility window: every
  game is ported before the platform's major release. Make such a change while no
  game branch is open, or let the platform agent port all games on a branch of the
  games repository that merges together with the platform change.

## Release

Only the coordinator releases, from the platform's `main`, after merging. Several
merged games can ship in one `npm run release`; it publishes every game in
`../fundev-games` whose content differs from the R2 catalog, and refuses to run
while that repository has uncommitted changes. See [workflow](workflow.md#3-release).

## Finish

```sh
cd ~/fundev-games
git worktree remove ../fundev-games-wt/<id>
git branch -d game/<id>
```

## Claude Code and other agents

Every agent reads `AGENTS.md`, which points here. Claude Code's worktree isolation
creates a worktree of the repository it is started in (from `origin/main` by
default); for a game agent that must be the games repository, so either start it
there (push its `main` first) or give it a worktree made as in
[Start a game](#start-a-game). The rules above still apply: one game per agent,
its own directory only, no release.

Prompt template for a game agent:

> You are a game agent for fun.dev. Read AGENTS.md and docs/parallel-games.md.
> Build the game `<id>` in `<id>/` of the fundev-games worktree `<path>` on branch
> `game/<id>`: <idea>. Change only `<id>/`. Verify from the platform checkout with
> `npm run verify -- --games=<path> --game=<id>` and run the game's own `dev/`
> tests; finish with both passing, commit, and report the branch, commit, verify
> summary and open questions. Do not push, merge, release or publish.
