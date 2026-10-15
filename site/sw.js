// Offline play for games opened before. The build replaces this line with the real values.
const BUILD = { version: "source", shell: [], gameOrigin: "" };

// Pages, host and catalog: network first, falling back to the cache after 3 s or offline,
// so online visitors always get the current platform. Game releases are immutable and
// cached on first use, together with every file listed in their files.json except those in a
// lazy/ directory, which are cached only once the game asks for them.
// A new worker takes over only after every fun.dev tab has closed (no skipWaiting).
const SHELL = `shell-${BUILD.version}`;
const RELEASES = "releases-v1";
const MAX_GAMES = 8;
const LRU_KEY = "/__sw/recent-releases";
const releasePath = /^\/games\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(\d+\.\d+\.\d+)\/(?:([a-f0-9]{64})\/)?/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(BUILD.shell)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith("shell-") && name !== SHELL) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const local = url.origin === self.location.origin;
  if (!local && url.origin !== BUILD.gameOrigin) return;
  if (local && /^\/(?:api|__dev)\//.test(url.pathname)) return;
  const release = url.pathname.match(releasePath);
  if (release) event.respondWith(fromRelease(event, url, release));
  else if (local || url.pathname === "/games.json") event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  const options = { ignoreSearch: request.mode === "navigate" };
  const network = fetch(request).then(async (response) => {
    if (response.ok) await cache.put(request, response.clone());
    return response;
  });
  network.catch(() => {}); // A late failure after serving the cache is not an error.
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000, "timeout"));
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== "timeout") return first;
    return (await cache.match(request, options)) ?? await network;
  } catch {
    const cached = await cache.match(request, options) ?? await caches.match(request, options);
    if (cached) return cached;
    if (request.mode === "navigate") return (await cache.match("/404.html")) ?? Response.error();
    return Response.error();
  }
}

async function fromRelease(event, url, [prefix, id, version, hash]) {
  const cache = await caches.open(RELEASES);
  const key = `${id}/${version}/${hash ?? ""}`;
  const cached = await cache.match(url.href);
  if (cached) {
    event.waitUntil(remember(cache, key));
    return cached;
  }
  let response;
  try { response = await fetch(event.request); }
  // Offline and never cached (e.g. the cover of a game not opened yet).
  catch { return new Response(null, { status: 504, statusText: "Offline" }); }
  if (response.ok) {
    await cache.put(url.href, response.clone());
    const base = `${url.origin}${prefix}`;
    if (url.pathname.endsWith("/game.js")) event.waitUntil(cacheRelease(cache, base).then(() => remember(cache, key)));
  }
  return response;
}

async function cacheRelease(cache, base) {
  try {
    const response = await fetch(`${base}files.json`, { mode: "cors", credentials: "omit" });
    if (!response.ok) return;
    const { files } = await response.json();
    await cache.put(`${base}files.json`, new Response(JSON.stringify({ files }), { headers: { "Content-Type": "application/json" } }));
    for (const file of files) {
      if (/(?:^|\/)lazy\//.test(file)) continue;
      const href = new URL(file, base).href;
      if (!href.startsWith(base) || await cache.match(href)) continue;
      const asset = await fetch(href, { mode: "cors", credentials: "omit" });
      if (asset.ok) await cache.put(href, asset);
    }
  } catch { /* Missing files load from the network next time. */ }
}

// Keeps the most recently used releases and evicts older ones.
async function remember(cache, key) {
  const recent = (await (await cache.match(LRU_KEY))?.json()) ?? [];
  const next = [key, ...recent.filter((item) => item !== key)];
  for (const old of next.splice(MAX_GAMES)) {
    const [id, version, hash] = old.split("/");
    const prefix = `/games/${id}/${version}/${hash ? `${hash}/` : ""}`;
    for (const request of await cache.keys()) if (new URL(request.url).pathname.startsWith(prefix)) await cache.delete(request);
  }
  await cache.put(LRU_KEY, new Response(JSON.stringify(next), { headers: { "Content-Type": "application/json" } }));
}
