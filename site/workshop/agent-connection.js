import { executeAgentCall } from './agent-call.js';
const storageKey = 'fun.dev.workshop.agent-connection';
// The connection code holds an ephemeral loopback credential, never a remote endpoint.
export function parseConnection(code) {
  const url = new URL(code.trim());
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || !/^#[a-f0-9]{64}$/.test(url.hash))
    throw new Error('Expected the local connection code printed by --serve');
  return { endpoint: url.origin, token: url.hash.slice(1) };
}
export function createAgentConnection({ api, onChange = () => {} }) {
  let running = false, connection = null, controller = null;
  const pageId = crypto.randomUUID();
  const info = () => { const s = api.inspect(); return { title: s.name, revision: s.revision, draftId: s.draftId, documentId: s.documentId, writable: s.writable, url: location.origin + location.pathname }; };
  const notify = (state, error, reason = null) => onChange({ state, error, reason, ...info(), project: info().title });
  async function request(route, body, keepalive = false) {
    const response = await fetch(connection.endpoint + route, {
      method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId, ...body }), ...(keepalive ? { keepalive: true } : { signal: controller.signal }),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error?.message ?? 'Connection failed'), { code: result.error?.code ?? 'connection_invalid' });
    return result;
  }
  async function loop() {
    let inFlight = null;
    try {
      while (running) {
        const { id, call } = await request('/poll', {});
        if (!id || !running) continue;
        inFlight = id;
        const result = await executeAgentCall(api, call);
        // Never repeat a mutation if its acknowledgement is lost.
        if (running) await request('/result', { id, result, info: info() });
        inFlight = null;
        notify('connected');
      }
    } catch (error) {
      if (running) { running = false; controller.abort(); notify('error', error.message, inFlight ? 'result_unknown' : error.code ?? 'service_unavailable'); }
    }
  }
  return {
    get connected() { return running; },
    async connect(code) {
      if (running) return;
      connection = parseConnection(code);
      controller = new AbortController();
      notify('connecting');
      try {
        await request('/attach', { info: info() });
        running = true;
        try { sessionStorage.setItem(storageKey, code); } catch { /* no storage */ }
        notify('connected');
        void loop();
      } catch (error) { controller.abort(); notify('error', error.message, error.code ?? 'service_unavailable'); throw error; }
    },
    disconnect({ forget = true } = {}) {
      running = false;
      if (connection) void request('/detach', {}, true).catch(() => {});
      controller?.abort();
      if (forget) try { sessionStorage.removeItem(storageKey); } catch { /* no storage */ }
      notify('disconnected');
    },
    saved() { try { return sessionStorage.getItem(storageKey) ?? ''; } catch { return ''; } },
  };
}
