import assert from "node:assert/strict";
import { smoke } from "./smoke.mjs";

// Post-deployment checks against the public site: the deployed build is the expected one,
// security headers and game pages are in place, then every game passes the smoke test.
export async function liveCheck({ browser, site, assetOrigin, apiOrigin, games, version, log = console.log }) {
  const text = async (path) => {
    const response = await fetch(new URL(path, site), { cache: "no-store" });
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
    const response = await fetch(`${assetOrigin}/platform.css`, { cache: "no-store" });
    assert.equal(response.status, 200, `${assetOrigin}/platform.css returned ${response.status}`);
    assert.equal(response.headers.get("access-control-allow-origin"), site, "asset origin allows the site");
  }
  if (apiOrigin) {
    const response = await fetch(`${apiOrigin}/api/transfers/time`, { method: "OPTIONS", headers: { Origin: site, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-fun-transfer" } });
    assert.equal(response.status, 204, `API preflight returned ${response.status}`);
    assert.equal(response.headers.get("access-control-allow-origin"), site, "API allows the site");
  }
  if (assetOrigin || apiOrigin) log("  ok   asset and API origins");
  await smoke({ browser, base: site, games, log });
}
