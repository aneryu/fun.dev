import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { openLocal } from '../../site/progress/local.js';
import { IDBFactory } from 'fake-indexeddb';
import { ProgressClient } from '../../site/progress/client.js';
export const origin = 'https://transfer.test';
export async function relay(bindings = {}) {
  const bundle = await build({ stdin: { contents: 'import cleanup from "./server/cleanup.js"; import {handleTransfer,cleanupTransfers} from "./server/transfer.js"; export default {fetch(r,e) {if(new URL(r.url).pathname === "/scheduled-test") return r.json().then(b=>cleanup.scheduled({scheduledTime:b.now},e)).then(()=>Response.json({ok:true})); return new URL(r.url).pathname === "/cleanup-test" ? r.json().then(b=>cleanupTransfers(e.DB,b.now)).then(v=>Response.json(v)) : handleTransfer(r,e)}};', resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-13', d1Databases: ['DB'], bindings: { TRANSFER_ENABLED: 'true', TRANSFER_ORIGIN: origin, ...bindings } }));
  const db = await runtime.getD1Database('DB');
  for (const name of (await readdir(new URL('../../migrations/', import.meta.url))).filter(x=>x.endsWith('.sql')).sort()) {
    const schema = (await readFile(new URL(`../../migrations/${name}`, import.meta.url),'utf8')).replace(/^--.*$/gm,'');
    let statement = '';
    for (const line of schema.split('\n')) {
      statement += line + '\n';
      if (!line.trim().endsWith(';') || (/^\s*CREATE TRIGGER/i.test(statement) && !line.trim().endsWith('END;'))) continue;
      await db.prepare(statement).run(); statement = '';
    }
  }
  const fetch = (path, options = {}) => runtime.dispatchFetch(origin + path, { ...options, headers: { ...options.headers, Origin: origin, 'CF-Connecting-IP':'127.0.0.1' } });
  const call = async (action, body, headers = {}) => {
    const response = await fetch('/api/transfers/' + action, { method:'POST', headers:{'Content-Type':'application/json','X-Fun-Transfer':'1',...headers}, body:JSON.stringify(body) });
    return { status:response.status, data:await response.json(), headers:response.headers };
  };
  return { runtime, db, fetch, call, cleanup: async now => (await runtime.dispatchFetch(origin+'/cleanup-test',{method:'POST',body:JSON.stringify({now})})).json() };
}
export async function client(fetch, gameId = 'game', local) {
  return new ProgressClient({ gameId, bundleVersion:'1.0.0', transfers:true, locks:null, local:local || await openLocal('test',new IDBFactory()), fetch });
}
export const value = merit => ({schemaVersion:1,data:{merit}});
