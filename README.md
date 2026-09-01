# fun.dev

A small static personal website built just for fun.

## Local preview

Serve the `site` directory with any static file server. For example:

```sh
python3 -m http.server --directory site 8000
```

Then open <http://localhost:8000>.

## Cloudflare Pages

- Build command: leave empty
- Build output directory: `site`
- Production branch: `production`

The site has no package manager, build step, or runtime dependencies.

## Analytics

Use **Cloudflare Web Analytics** for privacy-first page-view, visitor, and Web
Vitals reporting. Enable automatic setup for `fun.dev` in the Cloudflare Web
Analytics dashboard. Cloudflare then injects the beacon at the edge, so this
repository does not need to contain a site token or third-party tracking code.
The production Content Security Policy permits only Cloudflare's beacon script
and same-origin analytics submissions.
