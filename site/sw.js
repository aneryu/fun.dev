// Offline play for games opened before. The build replaces this line with the real values.
const BUILD = { version: "source", shell: [], gameOrigin: "", assetOrigin: "" };

// Pages, host and catalog: network first, falling back to the cache after 3 s or offline,
// so online visitors always get the current platform. Game releases, their content-addressed
// blobs and the vision runtime are immutable and cache first. Opening a game caches its whole
// release from files.json except files in a lazy/ directory, which are cached once the game
// asks for them. The cache is bounded by size: the least recently played games go first, and a
// blob shared by several games stays until none of them is cached.
// A new worker takes over only after every fun.dev tab has closed (no skipWaiting).
const SHELL = `shell-${BUILD.version}`;
const RELEASES = "releases-v2";
const MAX_BYTES = 300 * 1024 * 1024;
const INDEX_KEY = "/__sw/cache-index";
const releasePath = /^\/games\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(\d+\.\d+\.\d+)\/(?:([a-f0-9]{64})\/)?/;
const blobPath = /^\/blobs\/[a-f0-9]{64}\.[a-z0-9]+$/;
const visionPath = /^\/runtime\/vision\/([a-f0-9]{16})\//;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(BUILD.shell)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if ((name.startsWith("shell-") && name !== SHELL) || name === "releases-v1") await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Platform files come from the site itself or, in production, from the asset origin.
  const local = url.origin === self.location.origin || url.origin === BUILD.assetOrigin;
  if (!local && url.origin !== BUILD.gameOrigin) return;
  if (local && /^\/(?:api|__dev)\//.test(url.pathname)) return;
  const release = url.pathname.match(releasePath);
  const vision = local && url.pathname.match(visionPath);
  if (release) event.respondWith(cacheFirst(event, url, `${release[1]}/${release[2]}/${release[3] ?? ""}`, release[0]));
  else if (blobPath.test(url.pathname)) event.respondWith(cacheFirst(event, url, null));
  else if (vision) event.respondWith(cacheFirst(event, url, `runtime/vision/${vision[1]}`));
  else if (local || url.pathname === "/games.json" || url.pathname.startsWith("/library/")) event.respondWith(networkFirst(request));
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

// key names the cache entry a file belongs to (a release or the vision runtime); blobs belong to
// the releases whose files.json lists them.
async function cacheFirst(event, url, key, releasePrefix) {
  const cache = await caches.open(RELEASES);
  const cached = await cache.match(url.href);
  if (cached) {
    if (key) event.waitUntil(update((index) => touch(index, key)));
    return cached;
  }
  let response;
  try { response = await fetch(event.request); }
  // Offline and never cached (e.g. the cover of a game not opened yet).
  catch { return new Response(null, { status: 504, statusText: "Offline" }); }
  if (response.ok && response.type !== "opaque") {
    const size = await sizeOf(response);
    await cache.put(url.href, response.clone());
    event.waitUntil((async () => {
      const urls = releasePrefix && url.pathname.endsWith("/game.js") ? await cacheRelease(cache, `${url.origin}${releasePrefix}`) : [];
      await update((index) => {
        index.sizes[url.href] = size;
        for (const [href, bytes] of urls) if (bytes) index.sizes[href] = bytes;
        if (key) touch(index, key, [url.href, ...urls.map(([href]) => href)]);
      }, cache);
    })());
  }
  return response;
}

async function sizeOf(response) {
  const length = Number(response.headers.get("Content-Length"));
  return Number.isFinite(length) && length > 0 ? length : (await response.clone().blob()).size;
}

// Caches every non-lazy file of a release; returns [url, size] for all of its files (lazy ones
// with size 0 until requested), so the entry knows which blobs it uses.
async function cacheRelease(cache, base) {
  const result = [];
  try {
    const response = await fetch(`${base}files.json`, { mode: "cors", credentials: "omit" });
    if (!response.ok) return result;
    const { files, blobs = {} } = await response.json();
    const indexHref = `${base}files.json`;
    const body = JSON.stringify({ files, blobs });
    await cache.put(indexHref, new Response(body, { headers: { "Content-Type": "application/json" } }));
    result.push([indexHref, body.length]);
    for (const file of files) {
      const href = blobs[file] ? new URL(`/blobs/${blobs[file]}`, base).href : new URL(file, base).href;
      if (!blobs[file] && !href.startsWith(base)) continue;
      const lazy = /(?:^|\/)lazy\//.test(file);
      const hit = await cache.match(href);
      if (hit || lazy) { result.push([href, hit ? await sizeOf(hit) : 0]); continue; }
      const asset = await fetch(href, { mode: "cors", credentials: "omit" });
      if (!asset.ok) continue;
      result.push([href, await sizeOf(asset)]);
      await cache.put(href, asset);
    }
  } catch { /* Missing files load from the network next time. */ }
  return result;
}

// The index lists cache entries, most recently used first, with the URLs each one uses, and the
// size of every cached URL. Updates run one at a time.
let queue = Promise.resolve();
function update(change, cacheOrNull) {
  queue = queue.then(async () => {
    const cache = cacheOrNull ?? await caches.open(RELEASES);
    const index = (await (await cache.match(INDEX_KEY))?.json().catch(() => null)) ?? { entries: [], sizes: {} };
    if (change(index) === false) return;
    await evict(cache, index);
    await cache.put(INDEX_KEY, new Response(JSON.stringify(index), { headers: { "Content-Type": "application/json" } }));
  }).catch(() => { /* The cache is an optimization; a failed update is retried by the next request. */ });
  return queue;
}

function touch(index, key, urls = []) {
  const found = index.entries.find((entry) => entry.key === key);
  if (found && !urls.length && index.entries[0] === found) return false;
  const entry = found ?? { key, urls: [] };
  for (const href of urls) if (!entry.urls.includes(href)) entry.urls.push(href);
  index.entries = [entry, ...index.entries.filter((item) => item !== entry)];
}

// Drops the least recently used entries until the cache fits, never the one in use.
async function evict(cache, index) {
  let total = Object.values(index.sizes).reduce((sum, size) => sum + size, 0);
  while (total > MAX_BYTES && index.entries.length > 1) {
    const old = index.entries.pop();
    const kept = new Set(index.entries.flatMap((entry) => entry.urls));
    for (const href of old.urls) {
      if (kept.has(href) || !(href in index.sizes)) continue;
      await cache.delete(href);
      total -= index.sizes[href];
      delete index.sizes[href];
    }
  }
}
