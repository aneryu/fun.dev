import { test } from "node:test";
import assert from "node:assert/strict";
import { check, mime, probe } from "../server/uptime.js";

const kv = () => { const map = new Map(); return { get: async (key) => map.get(key) ?? null, put: async (key, value) => { map.set(key, value); } }; };
const site = (status, body = "<title>fun.dev</title>") => async () => new Response(body, { status });
const down = async () => { throw new TypeError("fetch failed"); };
const wait = async () => {};

test("a page that answers 200 with the site is up; errors and other pages are not", async () => {
  assert.equal(await probe(site(200)), null);
  assert.equal(await probe(site(502)), "HTTP 502");
  assert.equal(await probe(site(200, "parked domain")), "HTTP 200");
  assert.equal(await probe(down), "fetch failed");
});

test("one email when the site goes down, none while it stays down, one when it is back", async () => {
  const state = kv();
  assert.equal(await check({ kv: state, fetcher: site(200), wait }), null);
  const alert = await check({ kv: state, fetcher: down, wait, now: Date.UTC(2026, 9, 16, 10) });
  assert.equal(alert.subject, "fun.dev is down");
  assert.equal(await check({ kv: state, fetcher: down, wait }), null);
  const back = await check({ kv: state, fetcher: site(200), wait, now: Date.UTC(2026, 9, 16, 10, 30) });
  assert.equal(back.subject, "fun.dev is back");
  assert.match(back.text, /about 30 min/);
});

test("a single failed request is retried before it counts", async () => {
  let calls = 0;
  const flaky = async () => (++calls === 1 ? down() : site(200)());
  assert.equal(await check({ kv: kv(), fetcher: flaky, wait }), null);
  assert.equal(calls, 2);
});

test("alerts are plain-text emails from monitor@fun.dev", () => {
  const message = mime({ subject: "fun.dev is down", text: "x" }, "someone@example.com", Date.UTC(2026, 9, 16));
  assert.match(message, /^From: fun.dev monitor <monitor@fun.dev>\r\nTo: someone@example.com\r\nSubject: fun.dev is down\r\n/);
  assert.match(message, /\r\nMessage-ID: <\d+\.[0-9a-f-]+@fun.dev>\r\n/);
});
