// Uptime check for fun.dev, which is served by one server (docs/edge.md). Every five minutes it
// loads a page; after a failure and a retry it emails once, and once more when the site is back.
const SITE = "https://fun.dev/games";
export const FROM = "monitor@fun.dev";

export async function probe(fetcher = fetch) {
  try {
    const response = await fetcher(SITE, { redirect: "manual", signal: AbortSignal.timeout(10000), headers: { "User-Agent": "fun.dev uptime monitor" } });
    const body = await response.text();
    return response.status === 200 && body.includes("fun.dev") ? null : `HTTP ${response.status}`;
  } catch (error) {
    return error.name === "TimeoutError" ? "timeout after 10 s" : error.message;
  }
}

// Returns the alert to send, if the state changed, and stores the new state.
export async function check({ kv, now = Date.now(), fetcher = fetch, wait = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  let problem = await probe(fetcher);
  if (problem) { await wait(5000); problem = await probe(fetcher); }
  const previous = JSON.parse((await kv.get("state")) ?? '{"down":false}');
  const time = new Date(now).toISOString();
  if (problem && !previous.down) {
    await kv.put("state", JSON.stringify({ down: true, since: now }));
    return { subject: "fun.dev is down", text: `${SITE} failed twice at ${time}: ${problem}.\n\nCheck the server (ssh fundev-cn; journalctl -u caddy) or roll back as in docs/edge.md.` };
  }
  if (!problem && previous.down) {
    await kv.put("state", JSON.stringify({ down: false, since: now }));
    const minutes = Math.round((now - previous.since) / 60000);
    return { subject: "fun.dev is back", text: `${SITE} answers again at ${time}, after about ${minutes} min.` };
  }
  return null;
}

export function mime({ subject, text }, to, now = Date.now()) {
  return [
    `From: fun.dev monitor <${FROM}>`, `To: ${to}`, `Subject: ${subject}`, `Date: ${new Date(now).toUTCString()}`,
    `Message-ID: <${now}.${crypto.randomUUID()}@fun.dev>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", text, "",
  ].join("\r\n");
}
