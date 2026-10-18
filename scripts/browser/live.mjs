import assert from "node:assert/strict";
import { smoke } from "./smoke.mjs";

// Post-deployment checks against the public site: the deployed build is the expected one,
// security headers and game pages are in place, then every game passes the smoke test.
export async function liveCheck({ browser, site, assetOrigin, apiOrigin, games, version, log = console.log }) {
  // Right after a deploy, a request from here sometimes fails at the network level; retry those
  // (not HTTP errors) a few times before failing the release.
  const request = async (url, options) => {
    for (let attempt = 1; ; attempt++) {
      try { return await fetch(url, { ...options, signal: AbortSignal.timeout(30000) }); }
      catch (error) { if (attempt === 5) throw new Error(`${url}: ${error.cause?.code ?? error.message}`); await new Promise((done) => setTimeout(done, 2000 * attempt)); }
    }
  };
  const text = async (path) => {
    const response = await request(new URL(path, site), { cache: "no-store" });
    assert.equal(response.status, 200, `${path} returned ${response.status}`);
    return { body: await response.text(), headers: response.headers };
  };
  // Pages propagation can take a few seconds after the upload finishes.
  for (let attempt = 0; ; attempt++) {
    const deployed = (await text("/sw.js")).body.match(/"version":"([0-9a-f]+)"/)?.[1];
    if (!version || deployed === version) break;
    if (attempt === 20) throw new Error(`fun.dev still serves build ${deployed}, expected ${version}.`);
    await new Promise((done) => setTimeout(done, 3000));
  }
  assert.match((await text("/pwa-config.js")).body, /serviceWorker = true/, "service worker enabled");
  assert.doesNotMatch((await text("/games")).headers.get("content-security-policy") ?? "", /wasm-unsafe-eval/, "site CSP stays strict");
  for (const game of games) {
    const page = await text(`/games/${game.id}`);
    assert.match(page.headers.get("content-security-policy") ?? "", /'wasm-unsafe-eval'/, `game page CSP for ${game.id}`);
    assert.ok(page.body.includes('property="og:title"') && page.body.includes(`href="https://fun.dev/games/${game.id}"`), `game page for ${game.id}`);
  }
  log("  ok   build, headers, game pages");
  // The site's pages load platform files from the asset origin and call the API on its origin.
  if (assetOrigin) {
    const response = await request(`${assetOrigin}/platform.css`, { cache: "no-store" });
    assert.equal(response.status, 200, `${assetOrigin}/platform.css returned ${response.status}`);
    // Pages sends "*" with static files.
    assert.ok(["*", site].includes(response.headers.get("access-control-allow-origin")), "asset origin allows the site");
  }
  if (apiOrigin) {
    const response = await request(`${apiOrigin}/api/transfers/time`, { method: "OPTIONS", headers: { Origin: site, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-fun-transfer" } });
    assert.equal(response.status, 204, `API preflight returned ${response.status}`);
    assert.equal(response.headers.get("access-control-allow-origin"), site, "API allows the site");
  }
  if (assetOrigin || apiOrigin) log("  ok   asset and API origins");
  // The vision and physics runtimes live under their content hashes, which the build writes into
  // their kit modules: those directories must be deployed, cacheable for good and open to the site.
  for (const [kit, file] of [["vision", "vision_wasm_internal.wasm"], ["physics", "jolt-physics.wasm.wasm"]]) {
    const origin = assetOrigin || site;
    const module = await request(`${origin}/runtime/kit/${kit}.js`, { cache: "no-store" });
    assert.equal(module.status, 200, `kit/${kit}.js returned ${module.status}`);
    const runtime = (await module.text()).match(/const VERSION = "([a-f0-9]{16})";/)?.[1];
    assert.ok(runtime, `kit/${kit}.js names its runtime's hash`);
    const response = await request(`${origin}/runtime/${kit}/${runtime}/${file}`, { method: "HEAD" });
    assert.equal(response.status, 200, `the ${kit} runtime ${runtime} returned ${response.status}`);
    assert.match(response.headers.get("cache-control") ?? "", /immutable/, `the ${kit} runtime is immutable`);
    assert.equal(response.headers.get("content-type"), "application/wasm", `the ${kit} runtime's wasm type`);
    if (assetOrigin) assert.ok(["*", site].includes(response.headers.get("access-control-allow-origin")), `the ${kit} runtime allows the site`);
  }
  log("  ok   vision and physics runtimes");
  await smoke({ browser, base: site, games, log });
}
