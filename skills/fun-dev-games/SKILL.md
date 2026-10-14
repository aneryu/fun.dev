---
name: fun-dev-games
description: Develop, debug, integrate, and deploy self-contained Three.js game bundles for fun.dev. Use for game lifecycle integration, catalog releases, and authorized Cloudflare Pages publication.
---

# fun.dev games

Build a self-contained game bundle; the platform supplies the online Three.js
container. Games do not ship HTML, CSS, a renderer, or their own animation loop.
Game visuals, HUD, hit testing, audio, resources and state belong to the game.
Do not add game-specific platform APIs for counters, buttons, inventories, etc.

Use this skill with the user's game repository. When integrating or deploying,
locate the fun.dev checkout and read its current AGENTS.md and DESIGN.md. The
reference platform repository is https://github.com/aneryu/fun.dev; do not assume
it exists at a particular local path. Inspect the implementation if its contract
has changed since this skill was downloaded.

## Develop a game

Read [the runtime contract](references/runtime.md). Keep resources and relative
ESM imports inside the bundle. Use `context.THREE`; externalize the engine if a
build tool is needed. Prefer mobile-friendly geometry, bounded pixel ratio,
on-demand rendering when idle, touch controls and reduced motion.

Use [the starter](assets/game.js) as an optional example, not as required gameplay.
It creates one Three.js object and implements input, resource ownership and pause.

Games may use their preferred source language/build tools. Their exported
runtime must be browser ESM with `game.js` exporting `createGame(context)`.
Use the game’s own tools for iteration. Validate integration using the local
platform build and preview; the public site does not connect to local servers.

Read [the trust boundary](references/security.md) before integrating game code.

## Integrate a release

Read [release and deployment](references/release.md). Publish the bundle and
register it in the independent R2 catalog without deploying the website. The game
must not need changes to the shared player or platform styles. New development
code is not automatically approved for the public catalog.

Verify production build, resource paths, direct player links, mobile/desktop,
touch/keyboard, pause/resume, restart and cleanup.
Keep automated checks and actual browser observations distinct.

## Publish only when authorized

An instruction to create/test a game is not permission to publish it. An explicit
instruction to deploy/publish is sufficient within its stated scope; do not ask
again just because this skill is in use. Complete the reviewable build first.

For Cloudflare Pages, inspect the existing project/domain/production branch,
build `dist/`, and use the installed authenticated Wrangler CLI. The repository's
recorded project is `fundev`, branch `production`, domain `fun.dev`; verify these
before mutating remote state. Do not create a substitute project, change DNS,
commit/push unrelated work or broaden credentials to bypass a deployment failure.
If authentication or target verification fails, preserve the prepared artifact
and report that deployment is incomplete. Never include tokens/account IDs in
this public skill, game code, assets or logs.

After an authorized deployment, verify the returned deployment URL and intended
public domain: game catalog, entry/resources, player, security headers,
and this skill download if included. A successful upload alone is not proof of
public-domain behavior. Report any checks that could not be completed.

For games with persistent state, use the optional `context.progress` capability
as described in [runtime.md](references/runtime.md#progress). Validate the saved
schema before play, save at meaningful checkpoints, handle local-write failures,
and feature-detect older hosts. Do not build game-owned accounts or storage.
