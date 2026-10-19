# AGENTS.md

## Project

This repository contains the source for `fun.dev`, a static website deployed
with Cloudflare Pages.

Since 2026-10-19 fun.dev's product is an **agent-first 3D content toolchain**:
the workshop (model authoring), the public model library, the `.fun3d` format
with its runtime, and parametric derivation. Its primary users are external AI
agents and their developers; our own agents are the first users. The
small-game site stays as validation and showcase (帝都 is the main showcase).
Scope, decisions and the order of work are in
[`docs/platform-roadmap.md`](docs/platform-roadmap.md#direction-decided-2026-10-19);
judge new work against it.

The theme is still **just for fun**. Prefer playful, personal, lightweight
ideas over a corporate SaaS or portfolio aesthetic, for the toolchain as much as
for the games. The site should feel intentional without taking itself too
seriously.

## Current State

The site uses plain HTML, CSS, and JavaScript, with a small Node.js build that
copies static assets and the pinned Three.js runtime into `dist/`. The shared
player loads game bundles using the contract in `docs/game-bundles.md`.
Game sources live in the private `fundev-games` repository, checked out beside
this one (`../fundev-games`, or `FUNDEV_GAMES`); the platform's tools build,
test and publish them from there. `npm run verify` tests the platform with its
own test game, `tests/fixture-games/probe/`; real games are smoke-tested with
`npm run verify -- --games=../fundev-games`. Planned capabilities and their
order are in `docs/platform-roadmap.md`. Binary files (each game's `assets/`,
`sources/`) are not in Git: run `npm run assets` after changing them and commit
the locks (`docs/assets.md`). When several agents work at once, follow
`docs/parallel-games.md` (one game per agent and worktree; only the coordinator
merges and releases).
Do not introduce a framework unless the task benefits materially from it.

## Development Principles

- Keep the site fully usable as a static deployment on Cloudflare Pages.
- Prefer simple, maintainable code and few dependencies.
- Avoid server-only features unless they are explicitly implemented with
  Cloudflare Pages Functions and requested by the user.
- Keep content, interaction, and visual design aligned with the "just for fun"
  theme.
- Prioritize mobile layouts, touch input, and game performance; adapt to desktop.
- On mobile, let game pages (`/games/<id>`) fill the available viewport and keep platform controls in a menu.
- Use semantic HTML, keyboard-accessible controls, visible focus states, and
  sufficient color contrast.
- Respect `prefers-reduced-motion` when adding animation.
- Optimize images and other assets; avoid unnecessary client-side work.
- Do not add analytics, tracking, cookies, remote fonts, or third-party embeds
  without explicit approval.
- Never commit credentials, Cloudflare tokens, account IDs, or local environment
  files.

## Repository Changes

- Inspect existing files and conventions before choosing tools or structure.
- Read `DESIGN.md` before changing visual styles, colors, typography, or layout.
- Preserve user-authored work and unrelated changes.
- Keep each change scoped to the requested feature.
- If a package manager or framework is introduced, document why and add the
  corresponding reproducible build commands to `README.md`.
- Keep Cloudflare Pages configuration minimal. Do not add `wrangler.toml` or
  Pages Functions for a purely static site unless they are needed.

## Validation

For every change, run the narrowest relevant checks available (`npm test`,
`npm run verify`; see `docs/workflow.md`). Release only with `npm run release`.
Before handing off a deployable change, verify at minimum:

- the production build succeeds, if a build step exists;
- internal links and referenced local assets resolve;
- the page has no obvious browser console errors;
- the layout works at representative mobile and desktop widths;
- `git diff --check` passes when the directory is a Git repository.

When adding a build system, record the Cloudflare Pages build command and output
directory in `README.md`.

## Deployment

The production domain is `fun.dev`. Treat deployment configuration, redirects,
headers, and canonical URLs as production-facing changes. Do not deploy, modify
DNS, or change Cloudflare project settings unless the user explicitly asks.
