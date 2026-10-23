// Resume audit: verify evidence against the current generated assets, not a prior summary.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { converterStamp } from '../fun3d-convert.mjs';
import { VERSION } from '../../site/runtime/kit/fun3d-schema.js';
const dir=resolve('test-results/workshop-toolchain'),json=async p=>JSON.parse(await readFile(resolve(dir,p),'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex'),fixtureBytes=await readFile(resolve(dir,'fixtures/report.json')),fixtures=JSON.parse(fixtureBytes);
assert.equal(fixtures.converter,await converterStamp());
const report={date:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),status:'incomplete',publication:'not_published',
  versions:{workshopAPI:3,gameHostAPI:3,fun3d:VERSION,runtimePackage:JSON.parse(await readFile('packages/fundev-runtime/package.json','utf8')).version,
    three:JSON.parse(await readFile('node_modules/three/package.json','utf8')).version,node:process.version,converter:fixtures.converter},
  checks:[],fixtures:[],backends:{},limitations:{mobileDevice:'blocked: no physical midrange mobile device tested',coldNetwork:'not_checked: no network profile specified',gpuTimestamp:'not_checked',nativeFrameTiming:'not_checked',visualParity:'not_checked: no cross-backend pixel equality claim'}};
for(const f of fixtures.fixtures){
  const folder=`fixtures/toy-${f.kind.toLowerCase()}`;
  for(const a of f.assets)assert.equal(sha(await readFile(resolve(dir,folder,a.path))),a.sha256,`${f.kind}/${a.path}`);
  report.fixtures.push({kind:f.kind,seed:f.seed,checks:f.checks.status,release:f.release,assetCount:f.assets.length});
}
for(const backend of ['webgpu','webgl','software']){
  const r=await json(`${backend}/report.json`);assert.equal(r.fixtureManifestSha256,sha(fixtureBytes),`${backend}: fixture evidence changed`);
  for(const [name,hash] of Object.entries(r.runtimeSha256))assert.equal(sha(await readFile(resolve('dist/runtime/kit',name))),hash,`${backend}: built runtime changed: ${name}`);
  for(const f of r.results)assert.equal(f.sourceSha256,sha(await readFile(resolve(dir,`fixtures/toy-${f.kind.toLowerCase()}/game.js`))));
  assert.equal(r.results.length,5);assert.ok(r.results.every(f=>f.status==='pass'));
  report.backends[backend]=r.results.map(f=>({kind:f.kind,status:f.status,hardware:f.hardware,backendMatch:f.backendMatch,p50:f.performance.framePresentMs.p50,p95:f.performance.framePresentMs.p95,drawCalls:f.performance.render.drawCalls,renderCallsPerFrame:f.performance.render.frameCalls,firstPresentedMs:f.firstPresentedMs,timingMethod:f.performance.timingMethod,desktopCandidateBudget:f.performance.framePresentMs.p95<=16.7?'within_short_probe':'fail'}));
}
const native=await json('native/report.json');assert.equal(native.results.length,5);assert.equal(sha(await readFile(native.binary)),native.binarySha256,'Native executable changed');
for(const f of native.results){assert.equal(f.status,'pass');for(const a of f.assets.assets){assert.equal(sha(await readFile(a.source)),a.sha256);assert.equal(sha(await readFile(resolve(dir,`fixtures/toy-${f.kind.toLowerCase()}`,a.name))),a.sha256);}assert.equal(sha(await readFile(resolve(f.folder,'app.mjs'))),f.appSha256);}
report.backends.native=native.results.map(f=>({kind:f.kind,status:f.status,resources:f.resources,frames:f.finalStats.result.frames,capture:f.activeCapture.result.path}));
report.nativeRuntimeFingerprint=native.results[0].stats.identity.runtimeFingerprint;
const world=await json('world-report.json');assert.equal(world.status,'pass');assert.equal(world.fixtureEvidenceSha256,sha(await readFile(resolve(dir,'fixtures/toy-c/evidence.json'))));assert.equal(world.samples.length,60);
report.checks.push({name:'World ten-round resource release',status:'pass',samples:world.samples.length});
const errors=await json('error-report.json');assert.equal(errors.status,'pass');report.checks.push({name:'corrupt-resource error and retry',status:'pass'});
const tests=await readFile(resolve(dir,'final-tests.log'),'utf8'),testCount=Number(tests.match(/^# tests (\d+)$/m)?.[1]),passCount=Number(tests.match(/^# pass (\d+)$/m)?.[1]);
// The scoped repository commit has 550 tests. The original 590-test workspace
// also contained unrelated, uncommitted reference/Gaussian/Yello test files.
assert.ok(testCount>=550,'Full suite must contain at least the scoped commit test count');assert.equal(passCount,testCount);assert.match(tests,/^# fail 0$/m);assert.match(tests,/^# skipped 0$/m);assert.match(tests,/^# cancelled 0$/m);report.checks.push({name:'unit and integration tests',status:'pass',count:passCount,logSha256:sha(tests)});
assert.match(await readFile(resolve(dir,'production-build.log'),'utf8'),/Built dist/);report.checks.push({name:'production build',status:'pass'});
report.sourceSha256={};for(const base of ['site/runtime/kit','site/runtime/fun','site/workshop'])for(const name of await readdir(base)){if(name.endsWith('.js'))report.sourceSha256[`${base}/${name}`]=sha(await readFile(resolve(base,name)));}
execFileSync('git',['diff','--check']);report.checks.push({name:'git diff --check',status:'pass'});
report.status='pass';report.scope='Artifact freshness and executed desktop checks only; open gates remain in limitations and docs/workshop-toolchain.md.';
await writeFile(resolve(dir,'acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,versions:report.versions,checks:report.checks,limitations:report.limitations}));
