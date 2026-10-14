import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { relay, client, value, origin } from './helpers/relay.mjs';
import { hash, randomSecret, transferId, TRANSFER_TTL, RECEIPT_TTL, packet } from '../site/progress/transfer.js';
let service;
before(async()=>{service=await relay();});
beforeEach(async()=>{await service.db.batch([service.db.prepare('DELETE FROM transfers'),service.db.prepare('DELETE FROM transfer_rates')]);});
after(async()=>{await service?.runtime.dispose();});
async function request(merit=1) {
  const secret=randomSecret(),deadline=Date.now()+TRANSFER_TTL-1000;
  const payload=JSON.stringify(packet({format:'fun.dev.transfer',version:1,profileId:crypto.randomUUID(),saves:[{gameId:'game',snapshot:value(merit)}],alternatives:[]}));
  return {id:await transferId(secret,deadline),secret,deadline,digest:await hash(payload),token:randomSecret(),payload};
}
async function setup(t, fetch=service.fetch) {
  const a=await client(fetch), b=await client(service.fetch); t.after(async()=>{await a.close(); await b.close();});
  await a.prepare(); await b.prepare(); await a.capability().api.save(value(10)); return {a,b};
}
const claim=(r,secret=randomSecret())=>({id:r.id,token:r.token,secret});
const commit=(r,c)=>({id:r.id,secret:c.secret,role:'recipient',digest:r.digest});

test('ordinary visits, saves, reload and foreground checks make no progress requests or relay records',async t=>{
  let calls=0; const c=await client(async()=>{calls++;throw Error('unexpected network');});t.after(()=>c.close());
  await c.prepare(); await c.capability().api.save(value(8));await c.resumeCheck();await c.prepare();
  assert.equal((await c.capability().api.load()).snapshot.data.merit,8);assert.equal(calls,0);
  assert.equal((await service.db.prepare('SELECT COUNT(*) n FROM transfers').first()).n,0);
});
test('complete profile transfers once, retains source read-only and supports A to B to C',async t=>{
  const {a,b}=await setup(t), oldIdentity=a.identity;
  const row=await a.local.claim(oldIdentity,'other-game');await a.local.save(oldIdentity,'other-game',row.writerGeneration,value(88));
  const link=await a.createTransfer();
  await assert.rejects(a.local.save(oldIdentity,'other-game',row.writerGeneration,value(89)),{code:'identity_mismatch'});
  await b.acceptTransfer(link);await b.prepare();assert.equal(b.identity.profileId,oldIdentity.profileId);
  assert.equal((await b.local.get(b.identity,'other-game')).snapshot.data.merit,88);
  await a.resumeTransfer();assert.equal(a.identity.state,'moved');await a.prepare();assert.equal(a.prepared,false);
  assert.equal((await a.exportData()).saves.find(x=>x.gameId==='other-game').snapshot.data.merit,88);
  assert.equal((await service.db.prepare('SELECT SUM(bytes) n FROM transfers').first()).n,0);
  const c=await client(service.fetch);t.after(()=>c.close());await c.prepare();
  await b.capability().api.save(value(11));await c.acceptTransfer(await b.createTransfer());await c.prepare();
  assert.equal((await c.capability().api.load()).snapshot.data.merit,11);await b.resumeTransfer();assert.equal(b.identity.state,'moved');
});
test('a moved source can receive its profile back; cancelled receiving never reactivates the moved copy',async t=>{
  const {a,b}=await setup(t);await b.acceptTransfer(await a.createTransfer());await b.prepare();await a.resumeTransfer();
  const p=await a.local.beginIncoming(a.identity,{id:randomSecret(),secret:randomSecret()});a.identity=p;
  await a.declineIncoming();assert.equal(a.identity.state,'moved');
  await b.capability().api.save(value(42));await a.acceptTransfer(await b.createTransfer());await a.prepare();
  assert.equal((await a.capability().api.load()).snapshot.data.merit,42);await b.resumeTransfer();assert.equal(b.identity.state,'moved');
});
test('target keeps its previous local profile separately and preserves unknown schemas',async t=>{
  const {a,b}=await setup(t);await b.capability().api.save(value(99));
  const old=b.identity;const row=await a.local.claim(a.identity,'unlisted');await a.local.save(a.identity,'unlisted',row.writerGeneration,{schemaVersion:999,data:{x:1}});
  await b.acceptTransfer(await a.createTransfer());await b.prepare();
  assert.equal((await b.local.get(old,'game')).snapshot.data.merit,99);assert.equal((await b.local.get(b.identity,'unlisted')).snapshot.schemaVersion,999);
});
test('one claimant wins and same recipient can retry the exact claim',async()=>{
  const r=await request();await service.call('create',r);const x=claim(r),y=claim(r);
  const both=await Promise.all([service.call('claim',x),service.call('claim',y)]);assert.deepEqual(both.map(x=>x.status).sort(),[200,409]);
  const winner=both[0].status===200?x:y;assert.equal((await service.call('claim',winner)).data.payload,r.payload);
  await service.call('commit',commit(r,winner));const retry=await service.call('claim',winner);assert.equal(retry.data.state,'committed');assert.equal(retry.data.payload,undefined);
});
test('cancel and commit racing have exactly one terminal winner; no payload survives',async()=>{
  const r=await request();await service.call('create',r);const c=claim(r);await service.call('claim',c);
  const [a,b]=await Promise.all([service.call('cancel',{id:r.id,secret:r.secret,deadline:r.deadline,digest:r.digest}),service.call('commit',commit(r,c))]);
  assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.data.state,b.data.state);
  const row=await service.db.prepare('SELECT * FROM transfers WHERE id=?').bind(r.id).first();assert.ok(['committed','cancelled'].includes(row.state));assert.equal(row.payload,null);
  assert.equal((await service.call('commit',commit(r,c))).data.state,row.state);
});
test('cancellation before delayed creation fences it, and changed bodies cannot reuse the ID',async()=>{
  const r=await request();assert.equal((await service.call('cancel',{id:r.id,secret:r.secret,deadline:r.deadline,digest:r.digest})).data.state,'cancelled');
  assert.equal((await service.call('create',r)).data.state,'cancelled');
  assert.equal((await service.call('create',{...r,digest:randomSecret()})).status,409);
  assert.equal((await service.db.prepare('SELECT bytes FROM relay_usage').first()).bytes,0);
});
test('create response loss survives reload, cancellation response loss reconciles',async t=>{
  let drop='create';const fetch=async(path,options)=>{const response=await service.fetch(path,options);if(path.endsWith('/'+drop)){drop='';throw Error('lost response');}return response;};
  const {a}=await setup(t,fetch);await assert.rejects(a.createTransfer());const id=a.identity.pending.id;
  await a.prepare();assert.ok(a.link());assert.equal(a.identity.pending.id,id);
  drop='cancel';await assert.rejects(a.cancelTransfer());assert.equal(a.identity.pending.cancel,true);
  await a.prepare();assert.equal(a.identity.state,'active');assert.equal((await a.capability().api.load()).snapshot.data.merit,10);
});
test('claim reply loss and commit reply loss keep durable staging and reconcile after reopening',async t=>{
  const {a,b}=await setup(t);let drop='claim';
  b.fetcher=async(path,options)=>{const response=await service.fetch(path,options);if(path.endsWith('/'+drop)){drop='';throw Error('lost');}return response;};
  await assert.rejects(b.acceptTransfer(await a.createTransfer()));assert.equal(b.identity.state,'incoming');assert.equal(b.identity.pending.staged,undefined);
  drop='commit';await assert.rejects(b.resumeTransfer());assert.ok((await b.local.identity()).pending.staged);
  await b.prepare();assert.equal((await b.capability().api.load()).snapshot.data.merit,10);await a.resumeTransfer();assert.equal(a.identity.state,'moved');
});
test('storage failure before staging cannot commit or delete the source packet',async t=>{
  const {a,b}=await setup(t);const stage=b.local.stage.bind(b.local);b.local.stage=async()=>{throw Error('quota');};
  await assert.rejects(b.acceptTransfer(await a.createTransfer()));
  assert.equal((await service.db.prepare('SELECT state FROM transfers').first()).state,'claimed');
  assert.ok((await service.db.prepare('SELECT payload FROM transfers').first()).payload);
  b.local.stage=stage;await b.resumeTransfer();assert.equal(b.identity.state,'active');
});
test('target cannot activate its staged data after source cancellation',async t=>{
  const {a,b}=await setup(t);await b.capability().api.save(value(99));
  b.fetcher=async(path,options)=>{if(path.endsWith('/commit'))throw Error('offline');return service.fetch(path,options);};
  await assert.rejects(b.acceptTransfer(await a.createTransfer()));assert.ok(b.identity.pending.staged);
  await a.cancelTransfer();b.fetcher=service.fetch;await b.prepare();
  assert.equal((await b.capability().api.load()).snapshot.data.merit,99);assert.equal(a.identity.state,'active');
});
test('expiry removes payloads without visitors; receipt purge cannot reopen an ID or prove cancellation',async t=>{
  const {a,b}=await setup(t);const link=await a.createTransfer(),p=a.identity.pending;
  const cleaned=await service.cleanup(p.deadline+1);assert.ok(cleaned.expired>=1);assert.equal(cleaned.usage.bytes,0);
  await b.acceptTransfer(link);assert.equal(b.identity.state,'active');await a.resumeTransfer();assert.equal(a.identity.state,'active');
  await service.cleanup(p.deadline+RECEIPT_TTL+1);assert.equal((await service.db.prepare('SELECT records FROM relay_usage').first()).records,0);
  const old={...p,deadline:Date.now()-RECEIPT_TTL-1};old.id=await transferId(old.secret,old.deadline);
  assert.equal((await service.call('create',old)).data.error,'transfer_unknown');
});
test('missing outcome after a completed handoff never resumes the source',async t=>{
  const {a,b}=await setup(t);await b.acceptTransfer(await a.createTransfer());
  const p=a.identity.pending;
  // Simulate a source returning after receipt retention, without trusting its clock.
  await service.cleanup(p.deadline+RECEIPT_TTL+1);
  const fetch=service.fetch;a.fetcher=async(path,options)=>{if(path.endsWith('/create'))return Response.json({error:'transfer_unknown'},{status:410});return fetch(path,options);};
  await a.prepare();assert.equal(a.status,'transfer_unknown');assert.equal(a.frozen,true);assert.equal(a.prepared,false);
});
test('digest corruption, cross-origin calls, oversized packets and retired routes fail closed',async()=>{
  const r=await request();assert.equal((await service.call('create',{...r,digest:randomSecret()})).status,400);
  const response=await service.runtime.dispatchFetch(origin+'/api/transfers/create',{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json','X-Fun-Transfer':'1'},body:JSON.stringify(r)});assert.equal(response.status,403);
  assert.equal((await service.call('create',{...r,payload:'x'.repeat(1024*1024+1)})).status,413);
  for(const path of ['session','session/connect','session/restore','progress/game/main'])assert.equal((await service.runtime.dispatchFetch(origin+'/api/'+path,{method:'POST'})).status,410);
  const valid=await service.call('create',r);assert.equal(valid.headers.get('set-cookie'),null);assert.equal(valid.headers.get('cache-control'),'private, no-store');
});
test('admission caps include metadata rows and concurrent insert rollback preserves accounting',async()=>{
  // Fill with metadata only to exercise the real trigger, rather than payload quota.
  for(let start=0;start<4095;start+=50)await service.db.batch(Array.from({length:Math.min(50,4095-start)},(_,i)=>service.db.prepare("INSERT INTO transfers VALUES(?, 's', 'l', NULL, 0, 0, 'd', 'cancelled', NULL, 0)").bind('test-'+(start+i))));
  const a=await request(),b=await request();const results=await Promise.all([service.call('create',a),service.call('create',b)]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,503]);
  const expired=await request();expired.deadline=Date.now()-1000;expired.id=await transferId(expired.secret,expired.deadline);
  assert.equal((await service.call('cancel',{id:expired.id,secret:expired.secret,deadline:expired.deadline,digest:expired.digest})).data.state,'expired');
  const actual=await service.db.prepare('SELECT COUNT(*) records,SUM(bytes) bytes FROM transfers').first();assert.deepEqual(await service.db.prepare('SELECT records,bytes FROM relay_usage').first(),actual);
  await service.cleanup(Date.now());assert.equal((await service.db.prepare('SELECT records FROM relay_usage').first()).records,1);
});
test('scheduled Worker runs cleanup without a visitor request',async()=>{
  const r=await request();await service.call('create',r);
  const response=await service.runtime.dispatchFetch(origin+'/scheduled-test',{method:'POST',body:JSON.stringify({now:r.deadline+1})});
  assert.equal(response.status,200);assert.equal((await service.db.prepare('SELECT state FROM transfers').first()).state,'expired');
  assert.equal((await service.db.prepare('SELECT bytes FROM relay_usage').first()).bytes,0);
});
test('network rate-limit keys have fixed cardinality and do not contain raw addresses',async()=>{
  for(let i=0;i<8;i++)await service.call('create',await request());
  assert.equal((await service.call('create',await request())).status,429);
  const rows=await service.db.prepare('SELECT bucket,count FROM transfer_rates').all();assert.equal(rows.results.length,1);assert.ok(rows.results[0].bucket>=256&&rows.results[0].bucket<=511);
});
