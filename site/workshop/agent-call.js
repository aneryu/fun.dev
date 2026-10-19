// The same result and durable-save contract for Node, browser automation and direct tabs.
import { agentTools } from './agent-tools.js';
import { errorInfo } from './agent-contract.js';
export const MUTATING = ['apply', 'place', 'derive', 'loadProject', 'importGLB', 'openLibraryModel', 'undo', 'redo', 'checkpoint', 'restoreCheckpoint', 'removeCheckpoint'];
const methods = new Set(agentTools.map(t => t.name.slice('fun_editor_'.length)));
methods.delete('observe');
methods.add('renderViews');
export function validAgentCall(call) {
  return call && methods.has(call.method) && Array.isArray(call.args);
}
export async function executeAgentCall(api, call) {
  let applied = false;
  try {
    if (!validAgentCall(call) || !Object.hasOwn(api, call.method)) throw new Error('Unknown editor method');
    let value = await api[call.method](...call.args);
    if (MUTATING.includes(call.method)) {
      applied = true;
      const persistence = await api.flush();
      if (value && !Array.isArray(value) && typeof value === 'object') value.persistence = persistence;
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) value = undefined;
    return { ok: true, result: value };
  } catch (error) {
    return { ok: false, error: { ...errorInfo(error), applied, revision: api.inspect().revision } };
  }
}
