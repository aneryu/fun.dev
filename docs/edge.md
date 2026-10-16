# Edge: fun.dev in mainland China

Status: live since 2026-10-16. `fun.dev` is an `A 45.194.22.14` record, DNS only, TTL 600 s.

Cloudflare's free plan has no nodes in mainland China, and fun.dev is not ICP-filed, so pages
served by Cloudflare load slowly there (about 1–4 s per page, with timeouts on some networks).
A small CN2 server with good routes to the mainland serves the pages instead; Cloudflare
still serves every other file.

| Hostname | Served by | Content |
| --- | --- | --- |
| `fun.dev` | CN2 server `45.194.22.14` (Caddy, DNS only) | pages, `/sw.js`, `/manifest.webmanifest`, `/robots.txt`, `/sitemap.xml`; everything else redirects (308) to `cdn.fun.dev` |
| `cdn.fun.dev` | Pages project `fundev` (custom domain, proxied) | platform files: CSS, JS, icons, Three.js, `/runtime/` |
| `api.fun.dev` | Pages project `fundev` (custom domain, proxied) | the transfer API, `/api/transfers/*` |
| `console.fun.dev` | Worker `fundev-console` (custom domain, behind Cloudflare Access) | the model library console: upload and review ([models](models.md)) |
| `games.fun.dev` | R2 (unchanged) | game releases and blobs |

Measured from 15 mainland probes after the switch (HTTPS, `/games`): through the server a median
of 0.71 s (14/15), of which DNS lookup was most (0.15–0.48 s, the zone's nameservers are
Cloudflare's, abroad); connection, TLS and first byte took 0.23–0.34 s. The same page from
Cloudflare: 1.2 s, up to 3.3 s. Resolvers that have cached the record skip the DNS part.

## How it works

- `npm run build:production` sets `FUNDEV_ASSET_ORIGIN=https://cdn.fun.dev` and
  `FUNDEV_API_ORIGIN=https://api.fun.dev`. The build points the pages' scripts, stylesheets and
  icons at the asset origin. Module imports are root-relative, so everything they import loads
  from there too. Runtime paths come from `import.meta.url`, never from the page's address.
  Without these variables (local builds) everything stays same-origin.
- The manifest stays on `fun.dev` (its `start_url` and `scope` must be same-origin with the
  pages); its icons point at the asset origin. The service worker stays on `fun.dev` and
  precaches the shell from the asset origin, so a returning visitor fetches only the pages.
- Module scripts and the service worker fetch platform files with CORS; Pages sends
  `Access-Control-Allow-Origin: *` with every static file. Every CSP allows the asset origin
  (scripts, styles, images, connections) and the API origin (connections).
- The transfer API checks that a request was sent to `TRANSFER_API_ORIGIN` from a page on
  `TRANSFER_ORIGIN`, and answers its CORS preflight. Other pages of the site, including games on
  `games.fun.dev`, are refused. `CF-Connecting-IP` is still the visitor's address.
- The server, `config/Caddyfile`: an uncached reverse proxy for documents (GET/HEAD only) to
  `cdn.fun.dev`, and a 308 redirect for every other path. It stores no files, cache or
  secrets, so a release never touches it, and it can be rebuilt from this file.

The server has 5 Mbps. A first visit costs it about 10 KB of pages; a returning visitor, a
revalidation of `/sw.js`. Files on Cloudflare stay as slow in the mainland as before: these are
the next thing to improve (a mainland-friendly asset origin is one variable away).

## Setup (in order)

1. **Cloudflare**: in the Pages project `fundev`, add the custom domains `cdn.fun.dev` and
   `api.fun.dev` and wait until both are active. In the zone's WAF, make sure the server's
   address `45.194.22.14` is not challenged (Bot Fight Mode or custom rules): every page request
   comes from it.
2. **Release** this code (`npm run release`). `fun.dev` still points to Pages; its pages now load
   files from `cdn.fun.dev` and call `api.fun.dev`, which the live checks verify.
3. **Switch**: change the `fun.dev` DNS record to `A 45.194.22.14`, DNS only (grey cloud), then
   right away install the Caddyfile and start Caddy. Caddy obtains the certificate as soon as
   Let's Encrypt resolves the new address, usually within a minute; visitors with the old
   address cached keep reaching Cloudflare for up to five minutes.

   ```sh
   scp config/Caddyfile fundev-cn:/tmp/Caddyfile
   ssh fundev-cn 'sudo cp /tmp/Caddyfile /etc/caddy/Caddyfile && caddy validate --config /etc/caddy/Caddyfile && sudo systemctl enable --now caddy'
   ```

   Do not start Caddy with the `fun.dev` site before the DNS change: failed certificate
   attempts count against Let's Encrypt's rate limits.
4. Check: `npm run release -- --check`, and a mainland speed test of `https://fun.dev/games`.

## Rollback

Point `fun.dev` back at Pages: a proxied `CNAME fun.dev → fundev.pages.dev` (keep `fun.dev` as a
custom domain of the Pages project). The split hostnames keep working behind it, so nothing
else needs to change. Resolvers may keep the server's address for up to the TTL (10 minutes).

While a resolver still has the old address after a switch either way, the visitor reaches the
wrong side: on 2026-10-16 Cloudflare answered the unproxied `fun.dev` with a redirect loop for
about five minutes.

## Server

Ubuntu 24.04, user `aneryu` (SSH key, passwordless sudo), alias `fundev-cn` in `~/.ssh/config`.
SSH accepts keys only, no root login (`/etc/ssh/sshd_config.d/00-hardening.conf`; add a device's
key to `~/.ssh/authorized_keys` first). The firewall (ufw) allows only 22/tcp, 80/tcp,
443/tcp+udp and mosh (60000–61000/udp).
Caddy comes from its official apt repository, and unattended-upgrades also installs its updates
(`/etc/apt/apt.conf.d/52unattended-caddy`). Logs: `journalctl -u caddy`. Nothing else on the
server belongs to fun.dev.

## Monitoring

The Worker `fundev-uptime` (`server/monitor.js`, `wrangler.monitor.jsonc`) loads
`https://fun.dev/games` every five minutes. After a failure and a retry five seconds later it
emails once ("fun.dev is down"), and once more when the site answers again. The state is in the
KV namespace `fundev-uptime-state`; the recipient is the Worker secret `ALERT_TO`, the Email
Routing destination, so the address stays out of this repository. Deploy changes with
`npx wrangler deploy --config wrangler.monitor.jsonc` (not part of `npm run release`).

## Known limits

- Single point of failure: if the server is down, `fun.dev` is down everywhere; roll back as
  above. `fun.dev` itself no longer has Cloudflare's DDoS protection.
- Pages are reachable on `cdn.fun.dev` and `api.fun.dev` too; their canonical links name
  `fun.dev`.
- Cloudflare Web Analytics injected the beacon on the proxied `fun.dev`; check after the switch
  whether pages still report (see README, Analytics).
