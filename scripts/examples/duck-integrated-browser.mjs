import {readFile,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
import {launch,serve,watch,local} from "../browser/harness.mjs";
const out=process.env.DUCK_INTEGRATED_DIR??"test-results/duck-integrated";
const before=JSON.parse(await readFile(process.env.DUCK_INTEGRATED_SOURCE??"test-results/duck-lining-fit/render-0.016/authored.json","utf8")).project;
const after=JSON.parse(await readFile(`${out}/authored.json`,"utf8")).project;
const server=await serve(),browser=await launch(),errors=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:"block"});
  await context.route("https://static.fun.dev/**",local(server.base));
  const page=watch(await context.newPage(),errors,60000);
  await page.goto(`${server.base}/workshop/?renderer=webgl&lang=en`);await page.waitForFunction(()=>window.funEditor);
  const result=await page.evaluate(async({before,after})=>{
    funEditor.loadProject(before);const original=funEditor.getProject(),revision=funEditor.inspect().revision;
    const baseline=await funEditor.workflow({action:"prepare",views:[]});
    const candidate=await funEditor.workflow({action:"prepare",project:after,views:[]});
    if(!candidate.ok) throw new Error(JSON.stringify({error:candidate.error,relations:candidate.relations}));
    const images=[],comparisons=[];
    for(const preset of ["character-front","character-left","character-back","character-top","character-perspective","eyes","mouth"]) {
      const pair=[],metadata=[];
      for(const [side,id] of [["before",baseline.candidateId],["after",candidate.candidateId]]) {
        const preview=await funEditor.workflow({action:"inspect",candidateId:id,render:{preset}});
        if(preview.renderError) throw new Error(preview.renderError.message);
        const shot=preview.observations[0];images.push({name:`${side}-${preset}`,shot});metadata.push(shot);
        const img=new Image();img.src=shot.dataUrl;await img.decode();pair.push(img);
      }
      for(const key of ["camera","quality"])if(JSON.stringify(metadata[0][key])!==JSON.stringify(metadata[1][key]))
        throw new Error(`Comparison ${preset} differs in ${key}`);
      const canvas=document.createElement("canvas");canvas.width=pair[0].width+pair[1].width;canvas.height=pair[0].height;
      const ctx=canvas.getContext("2d");ctx.drawImage(pair[0],0,0);ctx.drawImage(pair[1],pair[0].width,0);
      comparisons.push({name:`comparison-${preset}`,dataUrl:canvas.toDataURL("image/png")});
    }
    const unchanged=funEditor.getProject(),unchangedRevision=funEditor.inspect().revision;
    await funEditor.acceptCandidate({candidateId:candidate.candidateId,ifRevision:revision,operationId:crypto.randomUUID()});
    const accepted=funEditor.getProject();await funEditor.undo();const undone=funEditor.getProject();
    await funEditor.redo();const redone=funEditor.getProject();
    const poses=[];
    for(const [name,command] of [
      ["walk",{op:"characterPose",name:"walk",time:.3}],
      ["blink",{op:"characterValues",values:{blink:1}}],
      ["mixed",{op:"characterValues",values:{blink:.5,smile:.4,surprise:.4,mouthClose:.5}}],
    ]) {
      const pose=await funEditor.workflow({action:"prepare",commands:[command],views:[]});
      poses.push({name,ok:pose.ok,relations:pose.relations,validation:pose.validation});
      if(!pose.ok) throw new Error(`Integrated ${name} pose failed: ${JSON.stringify(pose.relations)}`);
      const preview=await funEditor.workflow({action:"inspect",candidateId:pose.candidateId,render:{preset:"character-perspective"}});
      if(preview.renderError) throw new Error(preview.renderError.message);
      images.push({name:`pose-${name}`,shot:preview.observations[0]});
    }
    const afterPreviews=funEditor.getProject(),saved=await funEditor.exportProject();
    const {importModel}=await import("/workshop/import-glb.js");
    funEditor.loadProject(importModel(Uint8Array.from(atob(saved.data),c=>c.charCodeAt(0))).project);
    return {original,revision,unchanged,unchangedRevision,accepted,undone,redone,afterPreviews,
      reopened:funEditor.getProject(),saved,images,comparisons,poses};
  },{before,after});
  assert.deepEqual(errors,[]);assert.deepEqual(result.unchanged,result.original);
  assert.equal(result.unchangedRevision,result.revision);assert.deepEqual(result.undone,result.original);
  for(const value of [result.redone,result.afterPreviews,result.reopened]) assert.deepEqual(value,result.accepted);
  for(const {name,shot} of result.images) await writeFile(`${out}/${name}.png`,Buffer.from(shot.dataUrl.split(",")[1],"base64"));
  for(const {name,dataUrl} of result.comparisons) await writeFile(`${out}/${name}.png`,Buffer.from(dataUrl.split(",")[1],"base64"));
  await writeFile(`${out}/authored.json`,JSON.stringify({project:result.accepted}));
  await writeFile(`${out}/duck.funmodel.glb`,Buffer.from(result.saved.data,"base64"));
  await writeFile(`${out}/browser.json`,JSON.stringify({isolated:true,undoRedo:true,exactReload:true,errors,
    poses:result.poses,observations:result.images.map(({name,shot:{dataUrl,...metadata}})=>({name,...metadata}))},null,2));
  console.log("Integrated duck: seven fixed comparisons, edited walk and mixed expressions, undo/redo and exact source reload passed.");
} finally {await browser.close();await server.close();}
