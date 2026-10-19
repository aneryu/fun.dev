import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveBridge, bridgeRequest, readConnection } from '../scripts/workshop-bridge.mjs';
import { parseConnection } from '../site/workshop/agent-connection.js';
import { executeAgentCall } from '../site/workshop/agent-call.js';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workshop-bridge-test-'));
  const bridge = await serveBridge({ file: join(directory, 'connection.json'), pageURL: 'http://localhost:8001/workshop/', ...options });
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const request = (route, body) => bridgeRequest(bridge.connection, route, body);
  return { bridge, request };
}
test('loopback bridge authenticates origins, identifies the tab and delivers structured results once', async t => {
  const { bridge, request } = await fixture(t);
  assert.deepEqual(parseConnection(bridge.code), { endpoint: bridge.connection.endpoint, token: bridge.connection.token });
  assert.throws(() => parseConnection('https://remote.example/#' + bridge.connection.token));
  assert.equal((await stat(bridge.file)).mode & 0o777, 0o600);
  assert.equal((await readConnection(bridge.file)).token, bridge.connection.token);
  assert.equal((await fetch(bridge.connection.endpoint + '/status')).status, 401);
  assert.equal((await fetch(bridge.connection.endpoint + '/status', { headers: { Origin: 'https://evil.example', Authorization: `Bearer ${bridge.connection.token}` } })).status, 403);
  await assert.rejects(request('/call', { method: 'inspect', args: [] }), /Connect the current/);
  await request('/attach', { pageId: 'tab-a', info: { title: 'Brand duck', revision: 3 } });
  await assert.rejects(request('/attach', { pageId: 'tab-b' }), /Another workshop/);
  await assert.rejects(serveBridge({ file: bridge.file }), /already running/);
  assert.equal((await request('/status')).page.title, 'Brand duck');
  await assert.rejects(request('/call', { method: 'constructor', args: [] }), /Unknown workshop/);
  const response = request('/call', { method: 'inspect', args: [] });
  const next = await request('/poll', { pageId: 'tab-a' });
  assert.equal(next.call.method, 'inspect');
  await request('/result', { pageId: 'tab-a', id: next.id, result: { ok: true, result: { revision: 3 } } });
  assert.deepEqual(await response, { ok: true, result: { revision: 3 } });
  await assert.rejects(request('/result', { pageId: 'tab-a', id: next.id, result: { ok: true } }), /expired/);
  await request('/detach', { pageId: 'tab-a' });
  assert.equal((await request('/status')).connected, false);
});
test('a lost in-flight operation is ambiguous and is never redelivered', async t => {
  const { request } = await fixture(t, { timeout: 80 });
  await request('/attach', { pageId: 'tab' });
  const result = request('/call', { method: 'apply', args: [[], { ifRevision: 1 }] });
  const next = await request('/poll', { pageId: 'tab' });
  assert.equal(next.call.method, 'apply');
  const response = await result;
  assert.equal(response.ok, false);
  assert.equal(response.error.applied, 'unknown');
  assert.equal((await request('/status')).connected, false);
  await assert.rejects(request('/result', { pageId: 'tab', id: next.id, result: { ok: true } }), /not connected/);
});
test('direct execution retains conflict errors and acknowledges a mutation only after flush', async () => {
  const order = [];
  const api = {
    inspect: () => ({ revision: 5 }),
    apply: (_commands, options) => { if (options.ifRevision !== 5) throw Object.assign(new Error('Conflict'), { code: 'revision_conflict' }); order.push('apply'); return { revision: 6 }; },
    flush: async () => { order.push('flush'); return { state: 'saved' }; },
  };
  const conflict = await executeAgentCall(api, { method: 'apply', args: [[], { ifRevision: 4 }] });
  assert.equal(conflict.error.code, 'revision_conflict'); assert.equal(conflict.error.applied, false);
  const success = await executeAgentCall(api, { method: 'apply', args: [[], { ifRevision: 5 }] });
  assert.deepEqual(order, ['apply', 'flush']); assert.equal(success.result.persistence.state, 'saved');
});
