import { assert, snapshot, ProgressError } from "./format.js";
import { openLocal, legacySnapshots } from "./local.js";
import { hash, randomSecret, transferId, decodeLink, packet, TRANSFER_TTL } from "./transfer.js";

export class ProgressClient {
  constructor({ gameId, bundleVersion, transfers = false, apiOrigin = "", fetch: fetcher = globalThis.fetch.bind(globalThis), onChange = () => {}, local, locks = globalThis.navigator?.locks } = {}) {
    Object.assign(this, { gameId, bundleVersion, transfers, apiOrigin, fetcher, onChange, local, locks });
    this.status = "loading"; this.tail = Promise.resolve(); this.epoch = 0;
    this.channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("fun.dev.progress") : null;
    if (this.channel) this.channel.onmessage = () => { void this.checkWriter(); };
  }
  setStatus(status) { this.status = status; this.onChange(this); }
  enqueue(task) { const result = this.tail.then(task); this.tail = result.catch(() => {}); return result; }
  async drain() { await this.tail; }
  async api(action, body) {
    assert(this.transfers, "transfer_unavailable", 503);
    const response = await this.fetcher(`${this.apiOrigin}/api/transfers/${action}`, { method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json", "X-Fun-Transfer": "1" }, body: JSON.stringify(body) });
    assert(response.headers.get("Content-Type")?.includes("application/json"), "transfer_unavailable", 503);
    const data = await response.json();
    if (!response.ok) throw new ProgressError(data.error || "transfer_unavailable", response.status);
    return data;
  }
  releaseWriter() { this.releaseLock?.(); this.releaseLock = null; }
  async acquireWriter(takeover) {
    if (this.releaseLock || !this.locks) return true;
    let ready;
    const promise = new Promise(resolve => { ready = resolve; });
    void this.locks.request(`fun.dev.game.${this.identity.bucket}.${this.gameId}`, { ifAvailable: true }, lock => {
      if (!lock) { ready(false); return; }
      return new Promise(resolve => { this.releaseLock = resolve; ready(true); });
    }).catch(() => ready(false));
    return await promise || takeover; // IDB generations fence the displaced writer.
  }
  async prepare({ takeover = false } = {}) {
    await this.freeze(); this.releaseWriter(); this.prepared = false;
    if (this.saveFailure) { this.setStatus("unavailable"); return; }
    try { this.local ||= await openLocal(); this.identity = await this.local.identity(); }
    catch {
      this.local = null; this.selected = { kind: "empty" }; this.prepared = true; this.frozen = false; this.setStatus("unavailable"); return;
    }
    if (this.identity.pending) {
      try { await this.resumeTransfer(); } catch (error) { this.setStatus(error.code || "transfer_unavailable"); return; }
    }
    if (this.identity.state !== "active") { this.setStatus(this.identity.state); return; }
    if (!await this.acquireWriter(takeover)) { this.setStatus("writer_busy"); return; }
    try {
      this.row = await this.local.claim(this.identity, this.gameId); this.writer = this.row.writerGeneration;
      assert(!this.row.review, "legacy_unknown");
      this.selected = this.row.snapshot ? { kind: "saved", snapshot: snapshot(this.row.snapshot) } : { kind: "empty" };
    } catch (error) { this.setStatus(error.code || "unavailable"); return; }
    this.memory = this.selected.snapshot || null; this.prepared = true; this.frozen = false;
    this.channel?.postMessage("writer"); this.setStatus("local");
  }
  capability() {
    const epoch = this.epoch; let active = true;
    return {
      api: Object.freeze({ version: 1,
        load: async () => { this.used = true; this.onChange(this); return active && epoch === this.epoch && this.prepared ? structuredClone(this.selected) : { kind: "unavailable", reason: this.status }; },
        save: value => {
          this.used = true;
          if (!active || epoch !== this.epoch || this.frozen) return Promise.reject(new ProgressError("stale_context"));
          let captured;
          try { captured = snapshot(value); } catch (error) { this.setStatus(error.code); return Promise.reject(error); }
          this.memory = captured;
          if (!this.local) { this.setStatus("unavailable"); return Promise.reject(new ProgressError("storage_unavailable")); }
          const identity = this.identity, writer = this.writer;
          return this.enqueue(async () => {
            const result = await this.local.save(identity, this.gameId, writer, captured);
            this.row = await this.local.get(identity, this.gameId); this.setStatus("local"); return result;
          }).catch(error => {
            this.saveFailure = !["identity_mismatch", "writer_changed", "profile_frozen"].includes(error.code);
            if (!this.saveFailure) { this.frozen = true; this.releaseWriter(); }
            this.setStatus(error.code || "unavailable"); throw error;
          });
        },
      }), close() { active = false; },
    };
  }
  async freeze() { this.frozen = true; this.epoch++; await this.drain(); }
  async checkWriter() {
    if (!this.local || !this.identity || this.closed) return;
    try {
      const current = await this.local.identity(), row = await this.local.get(this.identity, this.gameId);
      if (current.generation !== this.identity.generation || (row && row.writerGeneration !== this.writer)) {
        this.frozen = true; this.releaseWriter();
        this.setStatus(current.generation !== this.identity.generation ? "identity_mismatch" : "writer_changed");
      }
    } catch { this.frozen = true; this.setStatus("unavailable"); }
  }
  async resumeCheck() {
    await this.checkWriter();
    if (this.identity?.pending && this.transfers) {
      const generation = this.identity.generation;
      try { await this.resumeTransfer(); return this.identity.state === "active" && this.identity.generation !== generation; }
      catch (error) { this.setStatus(error.code || "transfer_unavailable"); }
    }
    return false;
  }
  notifyIdentity() { this.releaseWriter(); this.channel?.postMessage("identity"); this.setStatus(this.identity.state); }
  async createTransfer() {
    assert(this.local && !this.saveFailure, "storage_unavailable");
    await this.freeze();
    assert(!this.saveFailure, "storage_unavailable");
    this.transferState = null;
    try {
      const { now } = await this.api("time", {});
      assert(Number.isSafeInteger(now), "transfer_unavailable");
      const secret = randomSecret(), deadline = now + TRANSFER_TTL;
      this.identity = await this.local.beginOutgoing(this.identity, { id: await transferId(secret, deadline), secret, token: randomSecret(), deadline });
      this.notifyIdentity();
      await this.resumeTransfer();
    } catch (error) {
      this.setStatus(error.code || "transfer_unavailable"); throw error;
    }
    return this.link();
  }
  link() {
    const p = this.identity?.pending;
    return this.identity?.state === "outgoing" && this.transferState && ["ready", "claimed"].includes(this.transferState) ? `${p.id}.${p.token}` : null;
  }
  async acceptTransfer(link) {
    assert(this.local && !this.saveFailure, "storage_unavailable");
    const token = decodeLink(link);
    await this.freeze();
    assert(!this.saveFailure, "storage_unavailable");
    this.identity = await this.local.beginIncoming(this.identity, { ...token, secret: randomSecret() });
    this.notifyIdentity(); await this.resumeTransfer();
  }
  resumeTransfer() {
    if (this.transferring) return this.transferring;
    this.transferring = this.performTransfer().finally(() => { this.transferring = null; });
    return this.transferring;
  }
  async performTransfer() {
    const state = this.identity.state;
    let p = this.identity.pending, result;
    if (!p) return;
    if (state === "outgoing") {
      if (!p.digest) {
        const digest = await hash(p.payload);
        this.identity = await this.local.updatePending(this.identity, current => { current.digest = digest; }); p = this.identity.pending;
      }
      const request = { id: p.id, secret: p.secret, deadline: p.deadline, digest: p.digest };
      const create = async () => {
        try { return await this.api("create", { ...request, token: p.token, payload: p.payload }); }
        catch (error) { if (error.code !== "transfer_expired") throw error; return this.api("cancel", request); }
      };
      if (p.cancel) result = await this.api("cancel", request);
      else if (!p.sent) {
        this.identity = await this.local.updatePending(this.identity, current => { current.sent = true; }); p = this.identity.pending;
        result = await create();
      } else {
        try { result = await this.api("status", { id: p.id, secret: p.secret, role: "source" }); }
        catch (error) { if (error.code !== "transfer_unknown") throw error; result = await create(); }
      }
      assert(result.id === p.id && result.digest === p.digest && result.deadline === p.deadline, "transfer_mismatch");
      this.transferState = result.state;
    } else if (state === "incoming") {
      if (!p.staged) {
        result = await this.api("claim", { id: p.id, secret: p.secret, token: p.token });
        assert(result.id === p.id && (result.recipient === await hash(p.secret) || (!result.recipient && ["cancelled", "expired"].includes(result.state))), "transfer_mismatch");
        if (result.state === "claimed") {
          assert(typeof result.payload === "string" && await hash(result.payload) === result.digest, "transfer_mismatch");
          const value = packet(JSON.parse(result.payload));
          this.identity = await this.local.stage(this.identity, value, result.digest); p = this.identity.pending;
        }
      }
      if (p.staged) result = await this.api("commit", { id: p.id, secret: p.secret, role: "recipient", digest: p.staged.digest });
      assert(result.id === p.id && (result.recipient === await hash(p.secret) || (!result.recipient && ["cancelled", "expired"].includes(result.state))), "transfer_mismatch");
      if (result.state === "committed") assert(p.staged && result.digest === p.staged.digest, "transfer_unknown");
    } else throw new ProgressError("profile_frozen");
    if (["committed", "cancelled", "expired"].includes(result.state)) {
      this.identity = await this.local.finish(this.identity, result); this.notifyIdentity();
    } else this.setStatus(state);
  }
  async cancelTransfer() {
    assert(this.identity.state === "outgoing", "profile_frozen");
    // Wait for an older attempt, then persist cancellation before dispatch/retry.
    await this.transferring?.catch(() => {});
    this.identity = await this.local.updatePending(this.identity, p => { p.cancel = true; });
    await this.resumeTransfer();
  }
  async declineIncoming() {
    await this.transferring?.catch(() => {});
    assert(this.identity.state === "incoming" && !this.identity.pending.staged, "profile_frozen");
    this.identity = await this.local.finish(this.identity, { id: this.identity.pending.id, state: "cancelled" }); this.notifyIdentity();
  }
  async reset() {
    await this.freeze();
    await this.local.edit(this.identity, this.gameId, row => { row.snapshot = null; row.review = false; row.seq++; }, this.writer);
    this.saveFailure = false;
  }
  async importSnapshot(value) {
    const captured = snapshot(value); await this.freeze();
    if (this.identity.state !== "active") this.identity = await this.local.newIdentity(this.identity);
    this.row = await this.local.claim(this.identity, this.gameId); this.writer = this.row.writerGeneration;
    await this.local.edit(this.identity, this.gameId, row => { row.snapshot = captured; row.review = false; row.seq++; row.updatedAt = Date.now(); }, this.writer); this.saveFailure = false; this.notifyIdentity();
  }
  async newIdentity() { await this.freeze(); this.identity = await this.local.newIdentity(this.identity); this.saveFailure = false; this.notifyIdentity(); }
  async clearDevice() { await this.freeze(); this.identity = await this.local.clearBucket(this.identity); this.saveFailure = false; this.notifyIdentity(); }
  async exportData() {
    await this.drain();
    const rows = this.local ? await this.local.all() : [];
    const alternatives = this.local ? (await this.local.archiveRows()).flatMap(row => legacySnapshots(row).map(value => ({ gameId: row.gameId, snapshot: value, source: "backup" }))) : [];
    const saves = rows.map(row => ({ gameId: row.gameId, snapshot: row.snapshot, source: row.bucket === this.identity?.bucket ? "current" : "backup", updatedAt: row.updatedAt }));
    if (this.memory) saves.unshift({ gameId: this.gameId, snapshot: this.memory, source: "memory" });
    return { format: "fun.dev.progress", version: 1, exportedAt: new Date().toISOString(), saves, alternatives };
  }
  async close() { this.closed = true; await this.freeze(); await this.transferring?.catch(() => {}); this.releaseWriter(); this.channel?.close(); this.local?.close(); }
}
