import {readFile,writeFile,mkdir} from "node:fs/promises";
import assert from "node:assert/strict";
import {launch,serve,watch,local} from "../browser/harness.mjs";
const margin=process.env.DUCK_LINING_MARGIN || "0.016";
const out=`test-results/duck-lining-fit/render-${margin}`;await mkdir(out,{recursive:true});
const before=JSON.parse(await readFile("test-results/duck-oral-volume/authored.json","utf8")).project;
const after=JSON.parse(await readFile(`test-results/duck-lining-fit/margin-${margin}.json`,"utf8")).project;
const server=await serve(),browser=await launch(),errors=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:"block"});
  await context.route("https://static.fun.dev/**",local(server.base));
  const page=watch(await context.newPage(),errors,60000);
  await page.goto(`${server.base}/workshop/?renderer=webgl&lang=en`);
  await page.waitForFunction(()=>window.funEditor);
  const result=await page.evaluate(async({before,after})=>{
    funEditor.loadProject(before);
    const original=funEditor.getProject(),revision=funEditor.inspect().revision,images=[],poses=[];
    for(const [name,values] of [["neutral",{}],["open",{mouthOpen:1}],["closed",{mouthClose:1}]]) {
      for(const [side,source] of [["before",before],["after",after]]) {
        const project=structuredClone(source);delete project.character.pose;
        project.character.values={...project.character.values,mouthOpen:0,mouthClose:0,smile:0,surprise:0,...values};
        const candidate=await funEditor.workflow({action:"prepare",project,views:[]});
        poses.push({name,side,ok:candidate.ok,error:candidate.error,validation:candidate.validation,
          relations:candidate.relations});
        for(const view of ["front","left","perspective"]) {
          const preview=await funEditor.workflow({action:"inspect",candidateId:candidate.candidateId,
            views:[view],size:512,render:{ids:["mouth_mount"],overlays:{wire:false,selection:false,data:false}}});
          if(preview.renderError) throw new Error(preview.renderError.message);
          images.push({name:`${name}-${side}-${view}`,shot:preview.observations[0]});
        }
      }
    }
    const candidate=await funEditor.workflow({action:"prepare",project:after,views:[]});
    const roundtrip=await funEditor.workflow({action:"verifyExport",candidateId:candidate.candidateId});
    const {projectFile}=await import("/workshop/project-file.js");
    const bytes=await projectFile(after),chunks=[];
    for(let i=0;i<bytes.length;i+=32768) chunks.push(String.fromCharCode(...bytes.subarray(i,i+32768)));
    const unchanged=funEditor.getProject(),endRevision=funEditor.inspect().revision;
    if(!candidate.ok) throw new Error("Finish declared relation checks before accepting this candidate");
    await funEditor.acceptCandidate({candidateId:candidate.candidateId,ifRevision:revision,operationId:crypto.randomUUID()});
    const accepted=funEditor.getProject();await funEditor.undo();const undone=funEditor.getProject();
    await funEditor.redo();const redone=funEditor.getProject();
    const {importModel}=await import("/workshop/import-glb.js");
    funEditor.loadProject(importModel(bytes).project);
    return {original,revision,unchanged,endRevision,accepted,undone,redone,reopened:funEditor.getProject(),
      images,poses,roundtrip,saved:btoa(chunks.join(""))};
  },{before,after});
  assert.deepEqual(result.original,result.unchanged);assert.equal(result.revision,result.endRevision);
  assert.deepEqual(errors,[]);assert.equal(result.roundtrip.editable.integrity.exact,true);
  assert.deepEqual(result.undone,result.original);assert.deepEqual(result.redone,result.accepted);
  assert.deepEqual(result.reopened,result.accepted);
  await writeFile(`${out}/authored.json`,JSON.stringify({project:result.accepted,accepted:true}));
  await writeFile(`${out}/duck.funmodel.glb`,Buffer.from(result.saved,"base64"));
  for(const {name,shot} of result.images) await writeFile(`${out}/${name}.png`,Buffer.from(shot.dataUrl.split(",")[1],"base64"));
  await writeFile(`${out}/browser.json`,JSON.stringify({isolated:true,exactReload:true,undoRedo:true,accepted:true,errors,
    poses:result.poses,roundtrip:result.roundtrip,
    images:result.images.map(({name,shot:{dataUrl,...metadata}})=>({name,...metadata}))},null,2));
  console.log("Lining: 18 fixed comparison renders, isolated acceptance, undo/redo and exact editable roundtrip passed. Upper/lower bill seam audit remains separate.");
} finally {await browser.close();await server.close();}
