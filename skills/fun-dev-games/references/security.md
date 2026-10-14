# Security boundary

Published game bundles execute with the fun.dev document privileges, even when
loaded from the configured R2 resource origin. The container
lifecycle API is not a security sandbox: games can access the page DOM and
same-origin storage and endpoints. Review game code and dependencies before
adding them to the catalog; keep credentials out of bundles and public assets.

The public site loads published bundles only from its configured resource origin. It has no connection
to local game servers, CORS bridge, or development-page CSP exception. Iterate
with the game's tools and test integration in a local platform preview.

CSP restricts resource and network destinations; it does not isolate allowed
JavaScript from the site. Untrusted third-party uploads would require a separate
security design. Do not relax production headers to make a development tool work.
