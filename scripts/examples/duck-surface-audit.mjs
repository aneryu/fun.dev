// New relations diagnose the current duck; this does not adopt or hide failures.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { launch, serve, watch, local } from "../browser/harness.mjs";
const out=process.env.DUCK_AUDIT_OUT || "test-results/duck-surface-audit";
await mkdir(out,{recursive:true});
const {project}=JSON.parse(await readFile(
  process.env.DUCK_AUDIT_SOURCE || "test-results/duck-joint-panel/authored.json","utf8"));
const server=await serve(), browser=await launch(), errors=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:"block"});
  await context.route("https://static.fun.dev/**",local(server.base));
  const page=watch(await context.newPage(),errors,60000);
  await page.goto(`${server.base}/workshop/?renderer=webgl&lang=en`);
  await page.waitForFunction(()=>window.funEditor);
  const result=await page.evaluate(async project=>{
    funEditor.loadProject(project);
    const pairs=[["upper_bill","lower_bill"],["tongue","upper_bill"],["tongue","lower_bill"],
      ["tongue","mouth_cavity"],["mouth_cavity","upper_bill"],["mouth_cavity","lower_bill"]];
    funEditor.apply(pairs.map(([source,target],i)=>({op:"relation",definition:{
      id:`surface_${i}`,kind:"surfaceIntersection",source,target,tolerance:.00001,touching:"forbid",
      description:"Audit only: no intentional overlap exceptions have been adopted",
    }})));
    const baseline=funEditor.getProject(), revision=funEditor.inspect().revision;
    const samples=[];
    for(const [name,values] of [
      ["neutral",{}],["open",{mouthOpen:1}],["closed",{mouthClose:1}],
      ["smile_open",{mouthOpen:.5,smile:.4}],["surprise_closed",{mouthClose:1,surprise:.4}],
    ]) {
      const candidate=await funEditor.workflow({action:"prepare",views:[],commands:[
        {op:"characterValues",values:{mouthOpen:0,mouthClose:0,smile:0,surprise:0,...values}},
      ]});
      samples.push({name,values,candidateId:candidate.candidateId,ok:candidate.ok,
        results:candidate.relations.results.filter(r=>/^surface_[0-5]$/.test(r.id))});
    }
    const diagnosis=await funEditor.workflow({action:"diagnose",views:["front","left","perspective"],
      query:{ids:[]},size:512,render:{ids:["upper_bill","lower_bill","mouth_cavity","tongue"]}});
    const afterPreview=funEditor.getProject(), afterPreviewRevision=funEditor.inspect().revision;
    const saved=await funEditor.exportProject();
    const {importModel}=await import("/workshop/import-glb.js");
    funEditor.loadProject(importModel(Uint8Array.from(atob(saved.data),c=>c.charCodeAt(0))).project);
    return {baseline,reloaded:funEditor.getProject(),samples,saved,diagnosis,revision,
      afterPreview,afterPreviewRevision};
  },project);
  assert.deepEqual(result.baseline,result.reloaded);
  assert.deepEqual(result.baseline,result.afterPreview);
  assert.equal(result.revision,result.afterPreviewRevision);
  assert.ok(result.samples.every(s=>s.results.length===6));
  assert.deepEqual(errors,[]);
  for(const [i,shot] of result.diagnosis.observations.entries())
    await writeFile(`${out}/diagnostic-${i}-${shot.view}.png`,Buffer.from(shot.dataUrl.split(",")[1],"base64"));
  await writeFile(`${out}/audit.funmodel.glb`,Buffer.from(result.saved.data,"base64"));
  await writeFile(`${out}/authored.json`,JSON.stringify({project:result.baseline}));
  const {observations,...diagnosis}=result.diagnosis;
  await writeFile(`${out}/result.json`,JSON.stringify({samples:result.samples,diagnosis,exactReload:true,errors},null,2));
  console.log(JSON.stringify(result.samples.map(s=>({name:s.name,pairs:s.results.map(r=>({
    source:r.source,target:r.target,status:r.status,contacts:r.samples.length,completed:r.completedPairs,total:r.requestedPairs,
  }))}))));
} finally {await browser.close();await server.close();}
