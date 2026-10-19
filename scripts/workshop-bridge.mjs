// A loopback-only mailbox. The browser pulls structured API calls; no eval, CDP or sockets.
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { validAgentCall } from '../site/workshop/agent-call.js';
export const connectionFile = () => join(tmpdir(), `fundev-workshop-${process.getuid?.() ?? 'local'}`, 'connection.json');
const problem = (code, message, applied = false) => ({ ok: false, error: { code, message, applied } });
export async function readConnection(file = connectionFile()) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') throw new Error('No workshop bridge. Start: fundev-workshop --serve'); throw e; }
}
export async function bridgeRequest(connection, route, body) {
  const url = new URL(connection.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Bridge must be on 127.0.0.1');
  const response = await fetch(new URL(route, url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(130_000),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error?.message ?? 'Bridge request failed'), result.error);
  return result;
}
export async function serveBridge({ file = connectionFile(), pageURL = 'https://fun.dev/workshop/', timeout = 120_000, pollTimeout = 20_000, lease = 45_000 } = {}) {
  const page = new URL(pageURL);
  if (!['http:', 'https:'].includes(page.protocol)) throw new Error('Expected an HTTP workshop URL');
  // One discoverable bridge per file. Refuse to steal a live service from another agent.
  try {
    const previous = await readConnection(file);
    try { await bridgeRequest(previous, '/status'); throw new Error('Workshop bridge is already running; use --connect'); }
    catch (e) { if (e.message.includes('already running')) throw e; }
  } catch (e) { if (!e.message.startsWith('No workshop bridge') && e.code !== 'ENOENT') throw e; }
  const token = randomBytes(32).toString('hex');
  let endpoint, attached = null, poll = null, active = null;
  const queue = [];
  const send = (res, status, value) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
  const finish = (item, result) => { clearTimeout(item.timer); send(item.response, 200, result); };
  function disconnect(message) {
    if (poll) { clearTimeout(poll.timer); send(poll.response, 409, problem('disconnected', message)); poll = null; }
    if (active) { finish(active, problem('disconnected', `${message}; inspect before retrying the operation`, 'unknown')); active = null; }
    for (const item of queue.splice(0)) finish(item, problem('disconnected', message));
    attached = null;
  }
  function deliver() {
    if (!poll || active || !queue.length) return;
    active = queue.shift();
    clearTimeout(poll.timer);
    send(poll.response, 200, { id: active.id, call: active.call });
    poll = null;
  }
  const server = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      if (req.headers.host !== new URL(endpoint).host || (origin && origin !== page.origin)) return send(res, 403, problem('origin', 'Untrusted bridge origin'));
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, problem('auth', 'Invalid connection token'));
      let body = {}, length = 0;
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) { length += chunk.length; if (length > 96 * 1024 * 1024) throw new Error('Bridge message exceeds 96 MB'); chunks.push(chunk); }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      }
      if (attached && !active && Date.now() - attached.seen > lease) disconnect('The workshop tab stopped responding');
      if (req.url === '/status' && req.method === 'GET') return send(res, 200, { connected: !!attached, page: attached?.info ?? null });
      if (req.url === '/attach' && req.method === 'POST') {
        if (typeof body.pageId !== 'string' || !body.pageId || body.pageId.length > 100) throw new Error('Missing page identity');
        if (attached && attached.id !== body.pageId) return send(res, 409, problem('occupied', 'Another workshop tab is connected. Disconnect it first.'));
        attached = { id: body.pageId, info: body.info, seen: Date.now() };
        return send(res, 200, { connected: true });
      }
      if (req.url === '/call' && req.method === 'POST') {
        if (!validAgentCall(body)) return send(res, 400, problem('method', 'Unknown workshop method'));
        if (!attached) return send(res, 409, problem('not_connected', 'Connect the current workshop tab using its Agent button'));
        if (queue.length >= 16) return send(res, 429, problem('busy', 'Workshop command queue is full'));
        const item = { id: randomUUID(), call: body, response: res };
        item.timer = setTimeout(() => {
          if (active === item) disconnect('Workshop command timed out');
          else { const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1); finish(item, problem('timeout', 'Command expired before delivery')); }
        }, timeout);
        queue.push(item); deliver(); return;
      }
      if (!attached || attached.id !== body.pageId) return send(res, 409, problem('not_connected', 'This tab is not connected'));
      attached.seen = Date.now();
      if (req.url === '/detach' && req.method === 'POST') { disconnect('Workshop disconnected'); return send(res, 200, { connected: false }); }
      if (req.url === '/poll' && req.method === 'POST') {
        if (poll) return send(res, 409, problem('busy', 'A tab poll is already pending'));
        const current = { response: res };
        current.timer = setTimeout(() => { if (poll === current) { poll = null; send(res, 200, { id: null }); } }, pollTimeout);
        poll = current;
        res.once('close', () => { if (poll === current) { clearTimeout(current.timer); poll = null; } });
        deliver(); return;
      }
      if (req.url === '/result' && req.method === 'POST') {
        if (!active || body.id !== active.id || typeof body.result?.ok !== 'boolean') return send(res, 409, problem('stale', 'Unknown or expired command result'));
        finish(active, body.result); active = null;
        if (body.info) attached.info = body.info;
        send(res, 200, { received: true }); deliver(); return;
      }
      send(res, 404, problem('route', 'Unknown bridge route'));
    } catch (error) { send(res, 400, problem('request', error.message)); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  endpoint = `http://127.0.0.1:${server.address().port}`;
  const connection = { endpoint, token, pid: process.pid, pageURL: page.href };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(connection), { mode: 0o600 });
  await chmod(file, 0o600);
  const code = `${endpoint}/#${token}`;
  page.hash = new URLSearchParams({ agent: code }).toString();
  const cleanup = setInterval(() => { if (attached && !active && Date.now() - attached.seen > lease) disconnect('Workshop connection expired'); }, 5000);
  cleanup.unref();
  return {
    connection, code, pageURL: page.href, file,
    async close() {
      clearInterval(cleanup); disconnect('Bridge stopped');
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      try { if ((await readConnection(file)).token === token) await unlink(file); } catch { /* already removed */ }
    },
  };
}
