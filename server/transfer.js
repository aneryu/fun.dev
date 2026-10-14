import { assert, ProgressError } from "../site/progress/format.js";
import { packet, hex, hash, transferId, byteLength, MAX_PACKET_BYTES, TRANSFER_TTL, RECEIPT_TTL } from "../site/progress/transfer.js";
import { equal, readJSON } from "./security.js";
const sql = (db, query, ...args) => db.prepare(query).bind(...args);
const response = (data, status = 200) => Response.json(data, { status, headers: {
  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  ...(status === 429 ? { "Retry-After": "60" } : {}),
} });
const get = (db, id) => sql(db, "SELECT * FROM transfers WHERE id=?", id).first();
const outcome = row => ({ id: row.id, state: row.state, digest: row.digest, deadline: row.deadline, recipient: row.recipient });
async function expire(db, id, now) {
  await sql(db, "UPDATE transfers SET state='expired',payload=NULL,bytes=0 WHERE id=? AND state IN ('ready','claimed') AND deadline<=?", id, now).run();
}
async function rate(db, ip, creating, now) {
  const bucket = parseInt((await hash(ip)).slice(0, 2), 16) + (creating ? 256 : 0);
  const limit = creating ? 6 : 120;
  const row = await sql(db, `INSERT INTO transfer_rates VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET
    count=CASE WHEN expires_at<=? THEN 1 ELSE MIN(count+1,?) END,
    expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END RETURNING count`,
  bucket, now + 60000, now, limit + 1, now, now + 60000).first();
  assert(row.count <= limit, "rate_limited", 429);
}

/** @param {Request} request @param {TransferEnv} env */
export async function handleTransfer(request, env) {
  try {
    const url = new URL(request.url), action = url.pathname.match(/^\/api\/transfers\/(time|create|claim|status|commit|cancel)$/)?.[1];
    // Legacy routes are permanently retired, regardless of old dashboard flags/cookies.
    assert(action, "retired_endpoint", 410);
    assert(env.DB && env.TRANSFER_ENABLED === "true", "transfer_unavailable", 503);
    assert(request.method === "POST", "method_not_allowed", 405);
    assert(url.origin === env.TRANSFER_ORIGIN && request.headers.get("Origin") === url.origin && request.headers.get("X-Fun-Transfer") === "1", "origin_denied", 403);
    assert(!["cross-site", "same-site"].includes(request.headers.get("Sec-Fetch-Site")), "origin_denied", 403);
    const db = env.DB, now = Date.now();
    await rate(db, request.headers.get("CF-Connecting-IP") || "local", action === "create" || action === "cancel", now);
    const body = await readJSON(request, action === "create" ? MAX_PACKET_BYTES * 2 + 8192 : 2048);
    if (action === "time") return response({ now });
    const id = hex(body.id);
    if (action === "create" || action === "cancel") {
      const source = await hash(hex(body.secret)), digest = hex(body.digest), deadline = body.deadline;
      assert(Number.isSafeInteger(deadline) && equal(id, await transferId(body.secret, deadline)), "invalid_transfer");
      // The ID binds the absolute deadline. Even after receipt cleanup, stale
      // create/cancel requests cannot change it and reopen an old transfer.
      assert(deadline + RECEIPT_TTL > now && deadline <= now + TRANSFER_TTL, "transfer_unknown", 410);
      let row = await get(db, id);
      if (row) assert(equal(row.source, source) && row.digest === digest && row.deadline === deadline, "transfer_mismatch", 409);
      if (action === "create") {
        const link = await hash(hex(body.token));
        assert(typeof body.payload === "string" && byteLength(body.payload) <= MAX_PACKET_BYTES, "save_too_large", 413);
        const normalized = JSON.stringify(packet(JSON.parse(body.payload)));
        assert(normalized === body.payload && equal(await hash(normalized), digest), "invalid_transfer");
        if (!row) {
          assert(deadline > now, "transfer_expired", 410);
          await sql(db, `INSERT INTO transfers(id,source,link,deadline,receipt_until,digest,state,payload,bytes)
            VALUES(?,?,?,?,?,?,'ready',?,?) ON CONFLICT(id) DO NOTHING`, id, source, link, deadline, deadline + RECEIPT_TTL, digest, normalized, byteLength(normalized)).run();
        }
        row = await get(db, id);
        assert(equal(row.source, source) && row.digest === digest && (row.state === "cancelled" || equal(row.link, link)), "transfer_mismatch", 409);
      } else {
        // After the immutable deadline, creation is impossible. Within receipt
        // retention, absence also rules out a committed handoff. This proof
        // needs no new row, so even a full relay can release an expired source.
        if (!row && deadline <= now) return response({ id, state: "expired", digest, deadline, recipient: null });
        // A cancellation receipt also fences an upload that has not arrived yet.
        await sql(db, `INSERT INTO transfers(id,source,link,deadline,receipt_until,digest,state,payload,bytes)
          VALUES(?,?,'',?,?,?,'cancelled',NULL,0) ON CONFLICT(id) DO NOTHING`, id, source, deadline, deadline + RECEIPT_TTL, digest).run();
        await sql(db, "UPDATE transfers SET state='cancelled',payload=NULL,bytes=0 WHERE id=? AND source=? AND digest=? AND state IN ('ready','claimed')", id, source, digest).run();
        row = await get(db, id);
        assert(equal(row.source, source) && row.digest === digest, "transfer_mismatch", 409);
      }
      await expire(db, id, Date.now());
      return response(outcome(await get(db, id)));
    }
    let row = await get(db, id);
    assert(row && row.receipt_until > now, "transfer_unknown", 410);
    if (action === "claim") {
      const recipient = await hash(hex(body.secret)), link = await hash(hex(body.token));
      assert(equal(row.link, link), "invalid_transfer", 401);
      await sql(db, "UPDATE transfers SET state='claimed',recipient=? WHERE id=? AND link=? AND state='ready' AND deadline>?", recipient, id, link, Date.now()).run();
      await expire(db, id, Date.now());
      row = await get(db, id);
      assert(equal(row.recipient || "", recipient) || (!row.recipient && ["cancelled", "expired"].includes(row.state)), "transfer_taken", 409);
      return response({ ...outcome(row), ...(row.state === "claimed" ? { payload: row.payload } : {}) });
    }
    const verifier = await hash(hex(body.secret));
    const source = body.role === "source";
    assert(source || body.role === "recipient", "invalid_transfer");
    assert(equal((source ? row.source : row.recipient) || "", verifier), "invalid_transfer", 401);
    if (action === "commit") {
      assert(!source && hex(body.digest) === row.digest, "transfer_mismatch", 409);
      await sql(db, "UPDATE transfers SET state='committed',payload=NULL,bytes=0 WHERE id=? AND recipient=? AND digest=? AND state='claimed' AND deadline>?", id, verifier, body.digest, Date.now()).run();
    }
    await expire(db, id, Date.now());
    return response(outcome(await get(db, id)));
  } catch (error) {
    if (`${error.message} ${error.cause?.message || ""}`.includes("relay_capacity")) return response({ error: "relay_full" }, 503);
    if (error instanceof SyntaxError) return response({ error: "invalid_transfer" }, 400);
    if (error instanceof ProgressError) return response({ error: error.code }, error.status);
    console.error("Transfer API failure", { kind: error.name });
    return response({ error: "transfer_unavailable" }, 503);
  }
}

export async function cleanupTransfers(db, now = Date.now()) {
  let expired = 0, removed = 0;
  for (let i = 0; i < 10; i++) {
    const results = await db.batch([
      sql(db, "UPDATE transfers SET state='expired',payload=NULL,bytes=0 WHERE id IN (SELECT id FROM transfers WHERE state IN ('ready','claimed') AND deadline<=? LIMIT 500) RETURNING id", now),
      sql(db, "DELETE FROM transfers WHERE id IN (SELECT id FROM transfers WHERE receipt_until<=? LIMIT 500) RETURNING id", now),
    ]);
    expired += results[0].results.length; removed += results[1].results.length;
    if (!results.some(r => r.results.length)) break;
  }
  await sql(db, "DELETE FROM transfer_rates WHERE expires_at<=?", now).run();
  return { expired, removed, usage: await sql(db, "SELECT records,bytes FROM relay_usage WHERE id=1").first() };
}
