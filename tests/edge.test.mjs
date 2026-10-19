import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assetHTML, assetManifest } from "../scripts/asset-origin.mjs";
import { addOriginToHeaders, apiDirectives, assetDirectives } from "../scripts/csp.mjs";
import { headersFor, parseHeaders } from "../scripts/headers.mjs";
import { relay, origin } from "./helpers/relay.mjs";

const assets = "https://cdn.example.com";
const api = "https://api.transfer.test";

test("editor documents stay on the site while editor modules and styles use the asset origin", async () => {
  const config = await readFile(new URL("../config/Caddyfile", import.meta.url), "utf8");
  const document = new RegExp(config.match(/path_regexp (\S+)/)[1]);
  for (const path of ["/workshop", "/workshop/", "/workshop/index.html", "/workshop/guide", "/workshop/guide.html", "/games/muyu", "/models/crate"])
    assert.equal(document.test(path), true, path);
  for (const path of ["/workshop/app.js", "/workshop/editor.css", "/workshop/materials.js", "/runtime/three.js"])
    assert.equal(document.test(path), false, path);
  for (const page of ["index", "guide"]) {
    const html = assetHTML(await readFile(new URL(`../site/workshop/${page}.html`, import.meta.url), "utf8"), assets);
    assert.match(html, /<link rel="stylesheet" href="https:\/\/cdn\.example\.com\/workshop\//);
    assert.doesNotMatch(html, /<script[^>]+src="\//);
    assert.match(html, page === "index" ? /href="\/games"/ : /href="\/workshop\/"/);
  }
});

test("pages load scripts, stylesheets and icons from the asset origin; links and the manifest stay", async () => {
  const html = assetHTML(await readFile(new URL("../site/player/index.html", import.meta.url), "utf8"), assets);
  assert.match(html, /<script src="https:\/\/cdn\.example\.com\/progress\/link-entry\.js">/);
  assert.match(html, /<script type="module" src="https:\/\/cdn\.example\.com\/player\/player\.js">/);
  assert.match(html, /<link rel="stylesheet" href="https:\/\/cdn\.example\.com\/platform\.css">/);
  assert.match(html, /<link rel="icon" href="https:\/\/cdn\.example\.com\/favicon\.svg"/);
  assert.match(html, /<link rel="apple-touch-icon" href="https:\/\/cdn\.example\.com\/icons\/apple-touch-icon\.png">/);
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<a class="back-link" href="\/games"/);
  assert.equal(assetHTML(html, assets), html, "rewriting twice changes nothing");
  const manifest = JSON.parse(assetManifest(await readFile(new URL("../site/manifest.webmanifest", import.meta.url), "utf8"), assets));
  assert.equal(manifest.start_url, "/games");
  assert.ok(manifest.icons.every((icon) => icon.src.startsWith(`${assets}/`)));
});

test("the asset origin joins script, style, connect and image sources; the API only connect", async () => {
  let source = addOriginToHeaders(await readFile(new URL("../site/_headers", import.meta.url), "utf8"), assets, assetDirectives);
  source = addOriginToHeaders(source, api, apiDirectives);
  const rules = parseHeaders(source);
  for (const path of ["/games", "/games/muyu"]) {
    const policy = headersFor(rules, path, "https://fun.dev")["content-security-policy"];
    for (const name of ["script-src", "style-src", "img-src"]) assert.match(policy, new RegExp(`${name} 'self'[^;]* https://cdn\\.example\\.com`), `${path} ${name}`);
    assert.match(policy, /connect-src 'self'[^;]* https:\/\/cdn\.example\.com https:\/\/api\.transfer\.test/);
    assert.doesNotMatch(policy, /(?:script|style|img)-src[^;]*api\.transfer\.test/);
  }
});

test("a separate API origin answers only the site, with CORS", async () => {
  const service = await relay({ TRANSFER_API_ORIGIN: api });
  after(() => service.runtime.dispose());
  const call = (path, init = {}) => service.runtime.dispatchFetch(api + path, { ...init, headers: { Origin: origin, "CF-Connecting-IP": "127.0.0.1", ...init.headers } });
  const preflight = await call("/api/transfers/time", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-fun-transfer" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.match(preflight.headers.get("access-control-allow-headers"), /X-Fun-Transfer/);
  const post = (headers, base = api) => service.runtime.dispatchFetch(`${base}/api/transfers/time`, { method: "POST", body: "{}", headers: { Origin: origin, "Content-Type": "application/json", "X-Fun-Transfer": "1", "CF-Connecting-IP": "127.0.0.1", ...headers } });
  const ok = await post({ "Sec-Fetch-Site": "same-site" });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), origin);
  assert.equal((await post({ "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post({ Origin: "https://games.transfer.test", "Sec-Fetch-Site": "same-site" })).status, 403, "only the site itself");
  assert.equal((await post({}, origin)).status, 403, "not on the site's own origin");
  assert.equal((await call("/api/transfers/time", { method: "OPTIONS", headers: { Origin: "https://evil.test", "Access-Control-Request-Method": "POST" } })).headers.get("access-control-allow-origin"), null);
});
