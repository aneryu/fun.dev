import {readFile,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
import {launch,serve,watch,local} from "../browser/harness.mjs";
const out="test-results/duck-oral-volume";
const before=JSON.parse(await readFile("test-results/duck-joint-panel/authored.json","utf8")).project;
const after=JSON.parse(await readFile(`${out}/authored.json`,"utf8")).project;
const server=await serve(),browser=await launch(),errors=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:"block"});
  await context.route("https://static.fun.dev/**",local(server.base));
  const page=watch(await context.newPage(),errors,60000);
  await page.goto(`${server.base}/workshop/?renderer=webgl&lang=en`);
  await page.waitForFunction(()=>window.funEditor);
  const result=await page.evaluate(async({before,after})=>{
    funEditor.loadProject(before);
    const original=funEditor.getProject(),revision=funEditor.inspect().revision;
    const baseline=await funEditor.workflow({action:"prepare",views:[]});
    const candidate=await funEditor.workflow({action:"prepare",project:after,views:[]});
    if(!candidate.ok) throw new Error(JSON.stringify({error:candidate.error,relations:candidate.relations}));
    const images=[];
    for(const preset of ["mouth","character-front","character-left","character-perspective"])
      for(const [side,id] of [["before",baseline.candidateId],["after",candidate.candidateId]]) {
        const preview=await funEditor.workflow({action:"inspect",candidateId:id,render:{preset}});
        if(preview.renderError) throw new Error(preview.renderError.message);
        images.push({name:`${side}-${preset}`,shot:preview.observations[0]});
      }
    const volumes=await funEditor.workflow({action:"inspect",candidateId:candidate.candidateId,
      views:["front","left","perspective"],size:512,query:{showVolumes:true},
      render:{ids:["tongue"],shadows:false,overlays:{wire:true,selection:false,data:false}}});
    if(volumes.renderError) throw new Error(volumes.renderError.message);
    images.push(...volumes.observations.map(shot=>({name:`volume-${shot.view}`,shot})));
    const untouched=funEditor.getProject(),untouchedRevision=funEditor.inspect().revision;
    await funEditor.acceptCandidate({candidateId:candidate.candidateId,ifRevision:revision,operationId:crypto.randomUUID()});
    const accepted=funEditor.getProject();
    await funEditor.undo();const undone=funEditor.getProject();
    await funEditor.redo();const redone=funEditor.getProject();
    const saved=await funEditor.exportProject();
    const {importModel}=await import("/workshop/import-glb.js");
    funEditor.loadProject(importModel(Uint8Array.from(atob(saved.data),c=>c.charCodeAt(0))).project);
    return {original,untouched,revision,untouchedRevision,accepted,undone,redone,reopened:funEditor.getProject(),
      saved,images,relations:candidate.relations};
  },{before,after});
  assert.deepEqual(result.untouched,result.original);assert.equal(result.untouchedRevision,result.revision);
  assert.deepEqual(result.undone,result.original);assert.deepEqual(result.redone,result.accepted);
  assert.deepEqual(result.reopened,result.accepted);assert.deepEqual(errors,[]);
  assert.equal(result.accepted.nodes.length,result.original.nodes.length,"Volume overlay is not saved as a model part");
  for(const {name,shot} of result.images) await writeFile(`${out}/${name}.png`,Buffer.from(shot.dataUrl.split(",")[1],"base64"));
  await writeFile(`${out}/authored.json`,JSON.stringify({project:result.accepted}));
  await writeFile(`${out}/duck.funmodel.glb`,Buffer.from(result.saved.data,"base64"));
  await writeFile(`${out}/browser.json`,JSON.stringify({isolated:true,undoRedo:true,exactReload:true,
    overlayNotPersisted:true,relations:result.relations,errors,
    observations:result.images.map(({name,shot:{dataUrl,...metadata}})=>({name,...metadata}))},null,2));
  console.log("Oral volume: candidate, fixed comparisons, derived-volume views, undo and exact source reload passed.");
} finally {await browser.close();await server.close();}
