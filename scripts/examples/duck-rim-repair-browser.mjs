import {readFile,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
import {launch,serve,watch,local} from "../browser/harness.mjs";
const out="test-results/duck-rim-repair";
const sources=Object.fromEntries(await Promise.all([
  ["before","test-results/duck-integrated/authored.json"],["corners",`${out}/corners.json`],["roof-rim",`${out}/roof-rim.json`],
].map(async([name,file])=>[name,JSON.parse(await readFile(file,"utf8")).project])));
const server=await serve(),browser=await launch(),errors=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:"block"});
  await context.route("https://static.fun.dev/**",local(server.base));const page=watch(await context.newPage(),errors,60000);
  await page.goto(`${server.base}/workshop/?renderer=webgl&lang=en`);await page.waitForFunction(()=>window.funEditor);
  const result=await page.evaluate(async sources=>{
    funEditor.loadProject(sources.before);const original=funEditor.getProject(),revision=funEditor.inspect().revision,images=[],rays=[];
    let selectedCandidate;
    for(const [name,project] of Object.entries(sources)) {
      const candidate=await funEditor.workflow({action:"prepare",project,views:[]});
      if(!candidate.ok) throw new Error(`${name} failed validation`);
      if(name==="roof-rim") selectedCandidate=candidate.candidateId;
      for(const view of ["front","left","perspective"]) {
        const preview=await funEditor.workflow({action:"inspect",candidateId:candidate.candidateId,
          ...(view==="front"?{render:{preset:"mouth"}}:{views:[view],size:768,render:{ids:["head","mouth_mount"]}})});
        if(preview.renderError) throw new Error(preview.renderError.message);
        images.push({name:`${name}-${view}`,shot:preview.observations[0]});
        if(view==="front" && name!=="corners") for(const pixel of [[176,183],[177,183],[178,183],[333,183],[334,183],[335,183]]) {
          const hit=await funEditor.workflow({action:"surface",candidateId:candidate.candidateId,
            query:{observation:preview.observations[0],pixel}});
          rays.push({name,pixel,hit});
        }
      }
    }
    const unchanged=funEditor.getProject(),endRevision=funEditor.inspect().revision;
    await funEditor.acceptCandidate({candidateId:selectedCandidate,ifRevision:revision,operationId:crypto.randomUUID()});
    const accepted=funEditor.getProject();await funEditor.undo();const undone=funEditor.getProject();
    await funEditor.redo();const redone=funEditor.getProject();
    for(const [name,values] of [["half-closed",{mouthClose:.5}],["open",{mouthOpen:1}],["closed",{mouthClose:1}]]) {
      const pose=await funEditor.workflow({action:"prepare",commands:[{op:"characterValues",values}],views:[]});
      if(!pose.ok) throw new Error(`${name} pose failed`);
      for(const view of ["front","left","perspective"]) {
        const preview=await funEditor.workflow({action:"inspect",candidateId:pose.candidateId,
          ...(view==="front"?{render:{preset:"mouth"}}:{views:[view],size:768,render:{ids:["head","mouth_mount"]}})});
        if(preview.renderError) throw new Error(preview.renderError.message);
        images.push({name:`pose-${name}-${view}`,shot:preview.observations[0]});
      }
    }
    const saved=await funEditor.exportProject(),afterPreviews=funEditor.getProject();
    const {importModel}=await import("/workshop/import-glb.js");
    funEditor.loadProject(importModel(Uint8Array.from(atob(saved.data),c=>c.charCodeAt(0))).project);
    return {original,revision,unchanged,endRevision,images,rays,accepted,undone,redone,afterPreviews,saved,reopened:funEditor.getProject()};
  },sources);
  assert.deepEqual(errors,[]);assert.deepEqual(result.original,result.unchanged);assert.equal(result.revision,result.endRevision);
  assert.deepEqual(result.undone,result.original);
  for(const p of [result.redone,result.afterPreviews,result.reopened]) assert.deepEqual(p,result.accepted);
  for(const ray of result.rays) assert.equal(ray.hit.node,ray.name==="before"?"head":"mouth_cavity");
  for(const view of ["front","left","perspective"]) {
    const shots=result.images.filter(i=>!i.name.startsWith("pose-") && i.name.endsWith(`-${view}`)).map(i=>i.shot);
    for(const shot of shots.slice(1)) {assert.deepEqual(shot.camera,shots[0].camera);assert.deepEqual(shot.quality,shots[0].quality);}
  }
  for(const {name,shot} of result.images) await writeFile(`${out}/${name}.png`,Buffer.from(shot.dataUrl.split(",")[1],"base64"));
  await writeFile(`${out}/authored.json`,JSON.stringify({project:result.accepted}));
  await writeFile(`${out}/duck.funmodel.glb`,Buffer.from(result.saved.data,"base64"));
  await writeFile(`${out}/browser.json`,JSON.stringify({isolated:true,fixedCameras:true,undoRedo:true,exactReload:true,errors,rays:result.rays,
    images:result.images.map(({name,shot:{dataUrl,...metadata}})=>({name,...metadata}))},null,2));
  console.log("Rim repair: 18 views, six former crack rays now hit lining, atomic acceptance, undo/redo and exact reload passed.");
} finally {await browser.close();await server.close();}
