# AGENTS.md

## Project

This repository contains the source for `fun.dev`, a static personal website
deployed with Cloudflare Pages.

The site's theme is **just for fun**. Prefer playful, personal, lightweight
ideas over a corporate portfolio aesthetic. The site should feel intentional
without taking itself too seriously.

## Current State

The repository starts without an established framework or build system. Do not
introduce one unless the task benefits materially from it. For small pages,
prefer plain HTML, CSS, and JavaScript.

## Development Principles

- Keep the site fully usable as a static deployment on Cloudflare Pages.
- Prefer simple, maintainable code and few dependencies.
- Avoid server-only features unless they are explicitly implemented with
  Cloudflare Pages Functions and requested by the user.
- Keep content, interaction, and visual design aligned with the "just for fun"
  theme.
- Make pages responsive and usable on both mobile and desktop.
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

For every change, run the narrowest relevant checks available. Before handing
off a deployable change, verify at minimum:

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
