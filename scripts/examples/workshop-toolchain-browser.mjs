import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { serve } from '../browser/harness.mjs';
import { decodePNG } from '../png.mjs';

const mode = process.argv.includes('--software') ? 'software' : process.argv.includes('--webgl') ? 'webgl' : 'webgpu';
const out = resolve('test-results/workshop-toolchain', mode); await mkdir(out,{recursive:true});
const server = await serve(resolve('dist'));
const browser = await chromium.launch({headless: mode==='software', args:mode==='software'?['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']:['--no-sandbox','--use-angle=metal']});
const cdp = await browser.newBrowserCDPSession(), system = await cdp.send('SystemInfo.getInfo');
const report = {date:new Date().toISOString(),mode,browser:browser.version(),system,results:[]};
report.fixtureManifestSha256=createHash('sha256').update(await readFile(resolve('test-results/workshop-toolchain/fixtures/report.json'))).digest('hex');
report.runtimeSha256=Object.fromEntries(await Promise.all((await readdir(resolve('dist/runtime/kit'))).filter(n=>n.endsWith('.js')).map(async n=>[n,createHash('sha256').update(await readFile(resolve('dist/runtime/kit',n))).digest('hex')])));
try {
  for (const kind of (process.env.TOOLCHAIN_KINDS ?? 'ABCDE')) {
    let source;
    try { source=await readFile(resolve(`test-results/workshop-toolchain/fixtures/toy-${kind.toLowerCase()}/game.js`),'utf8'); } catch { continue; }
    const context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1,locale:'en-US',serviceWorkers:'block',reducedMotion:'reduce'});
    const page=await context.newPage(),errors=[];page.setDefaultTimeout(30000);
    const presented=async()=>{
      const calls=await page.evaluate(()=>toolchainProbe.context.renderer.info.render.calls);
      await page.waitForFunction(calls=>toolchainProbe.context.renderer.info.render.calls>calls+64,calls);
    };
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await context.route(`**/games/toy-${kind.toLowerCase()}/1.0.0/game.js`,route=>route.fulfill({contentType:'text/javascript',body:source.replace('export async function createGame(context)', 'async function createGameImpl(context)')+`
export async function createGame(context) {
  const start=performance.now(), cpu=[];
  const game=await createGameImpl(context), original=game.update;
  game.update=function(dt){const start=performance.now();original.call(game,dt);cpu.push(performance.now()-start);if(cpu.length>1000)cpu.shift();};
  globalThis.toolchainProbe={game,context,cpu,interactive:performance.now(),createMs:performance.now()-start};
  return game;
}` }));
    const result={kind,sourceSha256:createHash('sha256').update(source).digest('hex'),status:'incomplete',errors};report.results.push(result);
    try {
      await page.goto(`${server.base}/games/toy-${kind.toLowerCase()}?lang=en&debug=1&renderer=${mode==='webgpu'?'webgpu':'webgl'}`);
      await page.waitForFunction(()=>globalThis.toolchainProbe || (!document.querySelector('#error-back')?.hidden));
      assert.ok(await page.evaluate(()=>!!globalThis.toolchainProbe),errors.join('\n'));
      await page.waitForFunction(()=>document.querySelector('#player-message').hidden && toolchainProbe.context.renderer.info.render.drawCalls > 0, null, {timeout:60000});
      result.firstPresentedMs = await page.evaluate(()=>performance.now());
      result.device=await page.evaluate(async()=>{
        const a=await navigator.gpu?.requestAdapter();const i=a?.info;
        return {adapter:i?{vendor:i.vendor,architecture:i.architecture,device:i.device,description:i.description,isFallbackAdapter:i.isFallbackAdapter}:null,
          backend:toolchainProbe.context.graphics,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},userAgent:navigator.userAgent};
      });
      result.hardware = mode==='software' ? 'unsupported' : result.device.adapter && !result.device.adapter.isFallbackAdapter && !/swiftshader|llvmpipe/i.test(JSON.stringify(system.gpu.devices)) ? 'pass' : 'blocked';
      result.requestedBackend = mode;
      result.backendMatch = result.device.backend.backend === (mode==='software'?'webgl':mode) ? 'pass' : 'blocked';
      result.initial=await page.evaluate(()=>toolchainProbe.game.snapshot());
      assert.equal(result.initial.playing,false,'reduced-motion never autoplays');
      await page.locator('.game-surface canvas').press('Enter');
      await page.evaluate(()=>{const g=toolchainProbe.game;g.command('pause');g.command('activate');for(let i=0;i<60;i++)g.update(1/60);g.command('pause');});
      await page.evaluate(async()=>{await toolchainProbe.game.settle();});await presented();
      result.active=await page.evaluate(()=>toolchainProbe.game.snapshot()); assert.equal(result.active.activated,true);
      if(kind==='A')assert.ok(Math.abs(result.active.angle-Math.PI/3)<1e-6);
      if(kind==='B')assert.ok(result.active.morph.some(w=>w>.5));
      if(kind==='E')assert.ok(Math.abs(result.active.effectTime-1)<.1);
      if(kind==='D') {
        const end=await page.evaluate(()=>toolchainProbe.game.seek(2));assert.equal(end.state.assembled,true);result.seekEnd=end;await presented();
      }
      await page.screenshot({path:resolve(out,`${kind}-desktop.png`)});
      if(kind==='E') {
        result.effectMaterials=await page.evaluate(async()=>{
          const p=toolchainProbe,found=[];p.context.scene.traverse(o=>{if([o.material??[]].flat().some(m=>m.userData?.fun3d?.id==='paint'))found.push(o);});
          return Promise.all(found.map(async o=>({name:o.name,materials:[o.material].flat().map(m=>({type:m.type,id:m.userData?.fun3d?.id,emissiveNode:m.emissiveNode?.constructor.name,cacheKey:m.customProgramCacheKey()})),shader:await p.context.renderer.debug.getShaderAsync(p.context.scene,p.context.camera,o)})));
        });
        const before=decodePNG(await page.screenshot());
        await page.evaluate(()=>toolchainProbe.game.command('reset'));
        await presented();
        const after=decodePNG(await page.screenshot());let changed=0;
        for(let i=before.width*100*before.channels;i<before.pixels.length;i++)if(Math.abs(before.pixels[i]-after.pixels[i])>4)changed++;
        result.effectChangedChannels=changed;assert.ok(changed>100,'TSL time must change rendered pixels');
      }
      if(kind==='A') {
        const before=decodePNG(await page.screenshot());
        await page.evaluate(()=>{toolchainProbe.transmission=[];toolchainProbe.context.scene.traverse(o=>{for(const m of [o.material??[]].flat())if(m.transmission>0){toolchainProbe.transmission.push([m,m.transmission]);m.transmission=0;m.needsUpdate=true;}});});
        await presented();
        const afterBytes=await page.screenshot();await writeFile(resolve(out,'A-opaque-control.png'),afterBytes);const after=decodePNG(afterBytes);
        let changed=0;for(let i=0;i<before.pixels.length;i++)if(Math.abs(before.pixels[i]-after.pixels[i])>4)changed++;
        result.transmissionChangedChannels=changed;assert.ok(changed>100,'physical transmission must change rendered pixels');
        await page.evaluate(()=>{for(const [m,value] of toolchainProbe.transmission){m.transmission=value;m.needsUpdate=true;}});
      }
      await page.evaluate(()=>{toolchainProbe.cpu.length=0;toolchainProbe.game.command('activate');});
      result.performance=await page.evaluate(async()=>{
        const times=[];let previous;for(let i=0;i<45;i++){const t=await new Promise(requestAnimationFrame);if(previous!==undefined)times.push(t-previous);previous=t;}
        const q=(a,f)=>[...a].sort((x,y)=>x-y)[Math.floor((a.length-1)*f)]??null;
        const p=toolchainProbe,r=p.context.renderer;
        return {warmup:'60 fixed input steps plus at least four rendered frames',playback:'active',samples:times.length,timingMethod:'rAF cadence; presentation proxy, not a GPU timestamp',framePresentMs:{p50:q(times,.5),p95:q(times,.95)},updateCpuMs:{p50:q(p.cpu,.5),p95:q(p.cpu,.95)},gpuTime:'not_checked',
          firstInteractiveMs:p.interactive,network:'local server, new browser context; no cold-network SLA claim',resolution:r.getDrawingBufferSize(new p.context.THREE.Vector2()).toArray(),pixelRatio:r.getPixelRatio(),render:{...r.info.render},memory:{...r.info.memory}};
      });
      await page.locator('.game-surface canvas').press('r');
      result.reset=await page.evaluate(()=>toolchainProbe.game.snapshot());assert.equal(result.reset.activated,false);assert.equal(result.reset.time,0);
      if(kind==='C')assert.deepEqual(result.reset.camera,result.initial.camera,'World reset restores the authored camera');
      await page.setViewportSize({width:390,height:844});await presented();
      await page.screenshot({path:resolve(out,`${kind}-mobile-layout.png`)});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      const input=await context.newCDPSession(page);await input.send('Emulation.setTouchEmulationEnabled',{enabled:true});
      await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:195,y:600}]});await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      result.touch=await page.evaluate(()=>toolchainProbe.game.snapshot());assert.equal(result.touch.activated,true);
      await input.detach();
      assert.deepEqual(errors,[]);result.status='pass';
    }catch(error){result.status='fail';result.error=error.stack;await page.screenshot({path:resolve(out,`${kind}-failure.png`)}).catch(()=>{});}
    finally { await context.close();await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)); }
  }
} finally {await browser.close();server.close();}
console.log(JSON.stringify(report.results.map(r=>({kind:r.kind,status:r.status,error:r.error,errors:r.errors}))));
if(report.results.some(r=>r.status!=='pass'))process.exitCode=1;
