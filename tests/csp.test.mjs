import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { addOriginToHeaders, addOriginToPolicy } from "../scripts/csp.mjs";
import { headersFor, parseHeaders } from "../scripts/headers.mjs";

const origin = "https://games.example.com";
test("remote origin joins script, connect, image and media sources in every policy", () => {
  const policy = addOriginToPolicy("default-src 'self'; script-src 'self'; connect-src 'self' blob:; img-src 'self' blob:; base-uri 'none'", origin);
  assert.equal(policy, `default-src 'self'; script-src 'self' ${origin}; connect-src 'self' blob: ${origin}; img-src 'self' blob: ${origin}; media-src 'self' ${origin}; base-uri 'none'`);
  assert.equal(addOriginToPolicy(policy, origin), policy);
});
test("only the player relaxes CSP for loaders; the site keeps workers same-origin", async () => {
  const rules = parseHeaders(addOriginToHeaders(await readFile(new URL("../site/_headers", import.meta.url), "utf8"), origin));
  const site = headersFor(rules, "/games")["content-security-policy"];
  const player = headersFor(rules, "/games/muyu")["content-security-policy"];
  assert.doesNotMatch(site, /wasm-unsafe-eval|blob:/);
  assert.match(site, /worker-src 'self'(;|$)/);
  assert.match(player, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(player, /worker-src 'self' blob:/);
  assert.match(player, /img-src 'self' blob: https:\/\/games\.example\.com/);
  assert.match(player, /media-src 'self' blob: https:\/\/games\.example\.com/, "recorded clips preview from blob URLs");
  assert.doesNotMatch(site, /media-src[^;]*blob:/);
  assert.ok(!player.includes(", "), "detached site policy is not combined with the player policy");
  for (const policy of [site, player]) assert.match(policy, new RegExp(`connect-src [^;]*${origin.replaceAll(".", "\\.")}`));
  assert.equal(headersFor(rules, "/sw.js")["cache-control"], "no-cache");
});
