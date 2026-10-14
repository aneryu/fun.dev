import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {openLocal} from '../site/progress/local.js';
import {ProgressClient} from '../site/progress/client.js';
import {snapshot} from '../site/progress/format.js';
import {randomSecret,transferId,TRANSFER_TTL,packet} from '../site/progress/transfer.js';
const value=merit=>({schemaVersion:1,data:{merit}});
const fresh=()=>openLocal('test',new IDBFactory());
async function setup(t){const local=await fresh();const c=new ProgressClient({gameId:'game',local,locks:null});t.after(()=>c.close());await c.prepare();return c;}
test('snapshots capture input and local generations fence displaced tabs',async t=>{
  const local=await fresh();t.after(()=>local.close());const identity=await local.identity(),a=await local.claim(identity,'game');
  const input=value(1),saving=local.save(identity,'game',a.writerGeneration,input);input.data.merit=999;await saving;
  const b=await local.claim(identity,'game');await assert.rejects(local.save(identity,'game',a.writerGeneration,value(2)),{code:'writer_changed'});
  assert.equal((await local.get(identity,'game')).snapshot.data.merit,1);await local.save(identity,'game',b.writerGeneration,value(3));
});
test('profile freeze fences writers across games, even when messages are missed',async t=>{
  const local=await fresh();t.after(()=>local.close());const identity=await local.identity(),a=await local.claim(identity,'game'),b=await local.claim(identity,'other');
  await local.save(identity,'other',b.writerGeneration,value(4));
  const secret=randomSecret(),deadline=Date.now()+TRANSFER_TTL;
  const next=await local.beginOutgoing(identity,{id:await transferId(secret,deadline),secret,deadline,token:randomSecret()});
  for(const [game,writer] of [['game',a],['other',b]])await assert.rejects(local.save(identity,game,writer.writerGeneration,value(99)),{code:'identity_mismatch'});
  await assert.rejects(local.claim(next,'game'),{code:'profile_frozen'});assert.equal(JSON.parse(next.pending.payload).saves.find(x=>x.gameId==='other').snapshot.data.merit,4);
});
test('invalid, circular, oversized and downgraded saves never mutate the last good snapshot',async t=>{
  for(const data of [NaN,Infinity,undefined,new Date(),{x:undefined}])assert.throws(()=>snapshot({schemaVersion:1,data}));
  const circular={};circular.x=circular;assert.throws(()=>snapshot({schemaVersion:1,data:circular}));
  const c=await setup(t);await c.capability().api.save({schemaVersion:2,data:{merit:2}});
  await assert.rejects(c.capability().api.save(value(1)),{code:'newer_schema'});assert.equal((await c.local.get(c.identity,'game')).snapshot.schemaVersion,2);
  assert.throws(()=>snapshot({schemaVersion:1,data:'x'.repeat(65536)}),{code:'save_too_large'});
});
test('game disposal rejects new saves and finishes an accepted save',async t=>{
  const c=await setup(t),context=c.capability();const pending=context.api.save(value(9));context.close();await pending;
  await assert.rejects(context.api.save(value(10)),{code:'stale_context'});await c.prepare();assert.equal((await c.capability().api.load()).snapshot.data.merit,9);
});
test('storage failure retains memory for export and blocks destructive reload',async t=>{
  const c=await setup(t);c.local.save=async()=>{throw Error('quota');};await assert.rejects(c.capability().api.save(value(12)));await c.prepare();
  assert.equal(c.prepared,false);assert.equal(c.status,'unavailable');assert.equal((await c.exportData()).saves[0].snapshot.data.merit,12);
});
test('incoming staging is atomic and cannot activate without a matching completion',async t=>{
  const c=await setup(t);await c.capability().api.save(value(99));const old=c.identity;
  c.identity=await c.local.beginIncoming(old,{id:'a'.repeat(64),secret:randomSecret()});
  const incoming=packet({format:'fun.dev.transfer',version:1,profileId:crypto.randomUUID(),saves:[{gameId:'game',snapshot:value(7)}],alternatives:[]});
  c.identity=await c.local.stage(c.identity,incoming,'d'.repeat(64));
  await assert.rejects(c.local.finish(c.identity,{id:'a'.repeat(64),state:'committed',digest:'e'.repeat(64)}),{code:'transfer_unknown'});
  assert.equal((await c.local.identity()).state,'incoming');assert.equal((await c.local.get(old,'game')).snapshot.data.merit,99);
});
test('version 1 migration preserves latest local snapshot, uncertain operations, conflicts and other owners',async t=>{
  const factory=new IDBFactory();const db=await new Promise((resolve,reject)=>{const r=factory.open('legacy',1);r.onupgradeneeded=()=>{r.result.createObjectStore('meta');r.result.createObjectStore('slots',{keyPath:'key'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction(['meta','slots'],'readwrite');tx.oncomplete=resolve;tx.onabort=reject;
    tx.objectStore('meta').put({bucket:'account-old',accountId:crypto.randomUUID(),generation:3,pending:{kind:'restore',id:crypto.randomUUID()}},'identity');
    tx.objectStore('slots').put({key:'account-old/game',bucket:'account-old',gameId:'game',snapshot:value(20),seq:2,ackSeq:2,writerGeneration:5,inflight:{body:{snapshot:value(10)}},conflict:{remote:{snapshot:value(7)},resolution:{selected:value(15)}}});
    tx.objectStore('slots').put({key:'guest-old/game',bucket:'guest-old',gameId:'game',snapshot:value(1),seq:1});
  });db.close();
  const local=await openLocal('legacy',factory),c=new ProgressClient({gameId:'game',local,locks:null,transfers:true,fetch:()=>{throw Error('no network');}});t.after(()=>c.close());
  await c.prepare();assert.equal((await c.capability().api.load()).snapshot.data.merit,20);assert.equal(c.identity.generation,4);assert.ok(c.identity.legacy);
  const exported=await c.exportData();for(const n of [7,10,15,20])assert.ok(exported.alternatives.some(x=>x.snapshot.data.merit===n));assert.ok(exported.saves.some(x=>x.snapshot?.data.merit===1));
  const next=await local.beginOutgoing(c.identity,{id:randomSecret()});const data=JSON.parse(next.pending.payload);assert.equal(data.saves[0].snapshot.data.merit,20);assert.equal(data.alternatives.length,3);
});
test('reset retains separate backups; clearing a pending profile is prohibited',async t=>{
  const c=await setup(t);await c.capability().api.save(value(4));await c.reset();await c.prepare();assert.equal((await c.capability().api.load()).kind,'empty');
  c.identity=await c.local.beginIncoming(c.identity,{id:randomSecret(),secret:randomSecret()});await assert.rejects(c.clearDevice(),{code:'profile_frozen'});
});

test('an unconfirmed legacy cloud-only slot never silently becomes a default local save',async t=>{
  const c=await setup(t);
  await c.local.edit(c.identity,'game',row=>{row.review=true;row.snapshot=null;});
  await c.prepare();assert.equal(c.prepared,false);assert.equal(c.status,'legacy_unknown');
  await assert.rejects(c.local.save(c.identity,'game',c.writer,value(0)),{code:'legacy_unknown'});
  await assert.rejects(c.local.beginOutgoing(c.identity,{id:randomSecret()}),{code:'legacy_unknown'});
  await c.importSnapshot(value(25));await c.prepare();assert.equal((await c.capability().api.load()).snapshot.data.merit,25);
});

test('a save failing during the pre-transfer drain prevents any upload',async t=>{
  const c=await setup(t);let calls=0;c.transfers=true;c.fetcher=async()=>{calls++;throw Error('unexpected');};
  c.local.save=async()=>{throw Error('quota');};
  const saving=c.capability().api.save(value(23)).catch(error=>error);
  await assert.rejects(c.createTransfer(),{code:'storage_unavailable'});await saving;
  assert.equal(calls,0);assert.equal((await c.local.identity()).pending,null);
  assert.equal((await c.exportData()).saves[0].snapshot.data.merit,23);
});
