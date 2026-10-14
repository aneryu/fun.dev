import assert from "node:assert/strict";
import { smoke } from "./smoke.mjs";

// Post-deployment checks against the public site: the deployed build is the expected one,
// security headers and share pages are in place, then every game passes the smoke test.
export async function liveCheck({ browser, site, games, version, log = console.log }) {
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
  const player = (await text("/play/")).headers.get("content-security-policy") ?? "";
  assert.match(player, /'wasm-unsafe-eval'/, "player CSP allows the loaders");
  assert.doesNotMatch((await text("/games/")).headers.get("content-security-policy") ?? "", /wasm-unsafe-eval/, "site CSP stays strict");
  for (const game of games) {
    const share = (await text(`/s/${game.id}/en/`)).body;
    assert.ok(share.includes('property="og:title"'), `share page for ${game.id}`);
  }
  log("  ok   build, headers, share pages");
  await smoke({ browser, base: site, games, log });
}
