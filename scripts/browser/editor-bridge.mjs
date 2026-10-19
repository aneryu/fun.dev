import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { serveBridge } from '../workshop-bridge.mjs';

export async function editorBridgeChecks({ browser, base }) {
  const directory = await mkdtemp(join(tmpdir(), 'workshop-browser-bridge-'));
  const bridge = await serveBridge({ file: join(directory, 'connection.json'), pageURL: `${base}/workshop/?lang=en&renderer=webgl` });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  async function cli(messages, extra = []) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/editor-agent.mjs', '--connect', '--connection-file', bridge.file, ...extra]);
      let output = '', stderr = '';
      child.stdout.on('data', b => output += b);
      child.stderr.on('data', b => stderr += b);
      child.on('error', reject);
      child.on('close', code => code ? reject(new Error(stderr + output)) : resolve(output.trim().split('\n').map(line => JSON.parse(line))));
      child.stdin.end(messages.map(m => JSON.stringify(m)).join('\n') + '\n');
    });
  }
  try {
    await page.goto(bridge.pageURL);
    await page.getByRole('button', { name: 'Connect this project', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#agent').textContent === 'Agent connected');
    await page.locator('#info-dialog [data-close]').click();
    assert.ok(!page.url().includes('agent='));
    const [state] = await cli([{ method: 'inspect' }]);
    assert.equal(state.ok, true);
    const revision = state.result.revision;
    const [changed] = await cli([{ method: 'apply', arguments: { commands: [{ op: 'set', id: 'body', name: 'Connected body' }], ifRevision: revision } }]);
    assert.equal(changed.ok, true);
    assert.equal(changed.result.persistence.state, 'saved');
    await page.getByRole('button', { name: '◇ Connected body', exact: true }).waitFor();
    const [stale] = await cli([{ method: 'apply', arguments: { commands: [{ op: 'set', id: 'body', name: 'Stale' }], ifRevision: revision } }]);
    assert.equal(stale.ok, false);
    assert.match(stale.error.code, /conflict/);
    const mcp = await cli([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fun_editor_inspect', arguments: {} } },
    ], ['--mcp']);
    assert.equal(mcp[1].result.structuredContent.revision, revision + 1);
    const [exported] = await cli([{ method: 'exportProject' }]);
    assert.ok(exported.result.data.length > 100);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#agent').textContent === 'Agent connected');
    assert.equal((await cli([{ method: 'inspect' }]))[0].result.revision, revision + 1);
    await page.locator('#agent').click();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    const [disconnected] = await cli([{ method: 'inspect' }]);
    assert.equal(disconnected.ok, false);
    assert.deepEqual(errors, []);
    console.log('Direct tab bridge: CLI/MCP, mutation, conflict, export, reload and disconnect passed.');
  } finally {
    await context.close(); await bridge.close(); await rm(directory, { recursive: true, force: true });
  }
}
