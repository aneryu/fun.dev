// Real local fun/C++/V8/Dawn integration. No host mocks and no asset publication.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { buildFunApp } from '../fun-app.mjs';
import { decodePNG } from '../png.mjs';

const binary=resolve(process.env.FUN_BIN ?? '../fun/build/macos-arm64/product/bin/fun');
const output=resolve('test-results/workshop-toolchain/native');await mkdir(output,{recursive:true});
const report={date:new Date().toISOString(),binary,binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),results:[]};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function rpc(socket,method,params={}) {
  return new Promise((resolve,reject)=>{
    const client=connect(socket);let data='';
    client.setTimeout(5000,()=>client.destroy(new Error(`RPC timeout: ${method}`)));
    client.on('connect',()=>client.write(JSON.stringify({id:method,method,params})+'\n'));
    client.on('data',chunk=>data+=chunk);client.on('error',reject);
    client.on('end',()=>{try{const response=JSON.parse(data);if(!response.ok)throw new Error(JSON.stringify(response.error));resolve(response);}catch(e){reject(e);}});
  });
}
for(const kind of (process.env.TOOLCHAIN_KINDS??'ABCDE')) {
  const folder=resolve(output,`${kind}-${Date.now()}`),socket=`/private/tmp/toolchain-${process.pid}-${kind}.sock`;
  await mkdir(folder,{recursive:true});
  await mkdir(resolve(folder,'data'),{recursive:true});await mkdir(resolve(folder,'captures'),{recursive:true});
  const built=await buildFunApp(resolve(`test-results/workshop-toolchain/fixtures/toy-${kind.toLowerCase()}/game.json`),{out:folder});
  const result={kind,folder,status:'incomplete',assets:JSON.parse(await readFile(resolve(folder,'assets.json'),'utf8')),appSha256:createHash('sha256').update(await readFile(resolve(folder,'app.mjs'))).digest('hex')};report.results.push(result);
  let logs='',exited=false;
  const child=spawn(binary,['--bundle',resolve(folder,'app.mjs'),'--assets',resolve(folder,'assets.json'),'--data-root',resolve(folder,'data'),'--artifact-root',resolve(folder,'captures'),'--debug-socket',socket,'--no-watch','--run-seconds','45'],{stdio:['ignore','pipe','pipe']});
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>{exited=true;result.exit={code,signal};resolve();}));
  child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  try {
    const start=performance.now();let ready=false,last,focused=false;
    while(performance.now()-start<30000&&!exited){
      try {last=await rpc(socket,'game.stats');if(!focused&&last.result.frames>0){await rpc(socket,'game.focus');focused=true;}if(last.result.frames>2&&last.result.calls>0&&!last.result.paused){ready=true;break;}}catch{}
      await delay(100);
    }
    assert.ok(ready,`No rendered game: ${JSON.stringify(last)} ${logs.slice(-1500)}`);
    result.firstObservedRenderedMs=performance.now()-start;result.stats=last;
    result.initial=await rpc(socket,'game.inspect');assert.equal(result.initial.result.activated,false);
    result.initialCapture=await rpc(socket,'game.capture',{name:'initial.png'});
    await rpc(socket,'game.focus');
    await rpc(socket,'game.option',{id:'activate'});
    const targetTime=kind==='C'?3.1:kind==='D'?2.1:.8,playStart=performance.now();let refocus=0;
    while(performance.now()-playStart<15000) {
      const snapshot=(await rpc(socket,'game.inspect')).result;if(snapshot.time>=targetTime)break;
      if((await rpc(socket,'game.stats')).result.paused&&refocus++<3)await rpc(socket,'game.focus');
      await delay(75);
    }
    result.refocusAttempts=refocus;
    await rpc(socket,'game.option',{id:'pause'});
    result.active=await rpc(socket,'game.inspect');const state=result.active.result;
    assert.equal(state.activated,true);assert.ok(state.time>.25);
    if(kind==='A')assert.ok(Math.abs(state.angle-Math.PI/3)<1e-6);
    if(kind==='B')assert.ok(state.morph.some(w=>w>.1));
    if(kind==='C'){assert.ok(state.bodies>0);assert.ok(state.ball[1]>.2&&state.ball[1]<.8);}
    if(kind==='D')assert.equal(state.timeline.state.assembled,true);
    if(kind==='E')assert.ok(state.effectTime>.25);
    await delay(100);result.activeCapture=await rpc(socket,'game.capture',{name:'active.png'});
    const a=decodePNG(await readFile(result.initialCapture.result.path)),b=decodePNG(await readFile(result.activeCapture.result.path));
    let changed=0;for(let i=0;i<a.pixels.length;i++)if(Math.abs(a.pixels[i]-b.pixels[i])>4)changed++;
    result.changedChannels=changed;assert.ok(changed>100,'Input must change actual native pixels');
    await rpc(socket,'game.option',{id:'reset'});result.reset=await rpc(socket,'game.inspect');assert.equal(result.reset.result.time,0);assert.equal(result.reset.result.activated,false);
    if(kind==='C')assert.deepEqual(result.reset.result.camera,result.initial.result.camera,'World reset restores the authored camera');
    result.finalStats=await rpc(socket,'game.stats');result.status='pass';
  }catch(error){result.status='fail';result.error=error.stack;}
  finally {
    if(!exited)await rpc(socket,'game.quit').catch(()=>{});
    if(!exited)await Promise.race([closed,delay(3000)]);
    if(!exited){child.kill('SIGTERM');await closed;}
    await writeFile(resolve(folder,'run.log'),logs);
    result.resources=logs.split('\n').flatMap(line=>{try{const e=JSON.parse(line);return e.graphics_closed?[e]:[];}catch{return [];}});
    if(/"event":"active_fault"|host uncaptured type=/.test(logs)||result.resources.some(r=>r.uncaptured_errors!==0||r.gpu_payload_live!==0)) {result.status='fail';result.error=(result.error??'')+' Native GPU fault or unbalanced shutdown; see run.log';}
    result.performance={gpuTime:'not_checked',framePresentMs:'not_checked',note:'Host stats are counters; they are not per-frame GPU timings.'};
    await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));
  }
  console.log(JSON.stringify({kind,status:result.status,error:result.error,folder}));
}
if(report.results.some(r=>r.status!=='pass'))process.exitCode=1;
