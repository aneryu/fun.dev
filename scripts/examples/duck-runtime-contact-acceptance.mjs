// Compare compressed runtime contact checks without changing an editing scene.
import {readFile,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
import {openWorkshop} from "../workshop-node.mjs";
const out=process.env.DUCK_RUNTIME_DIR??"test-results/duck-cheeks";
const {project}=JSON.parse(await readFile(`${out}/authored.json`));
const walk=project.character.clips.find(c=>c.name==="walk");
const poses=[...new Map([
  ...project.character.clips.map(c=>({clip:c.name,time:c.duration/2})),
  {clip:"stand",time:0},{clip:"walk",time:.3},{clip:"run",time:.1625},{clip:"mouth_close",time:.25},
  ...Array.from({length:9},(_,i)=>({clip:"walk",time:i*walk.duration/8})),
].map(p=>[`${p.clip}:${p.time.toFixed(8)}`,p])).values()];
const session=await openWorkshop({record:{project,revision:0},width:64,height:64});
try {
  const before=session.api.getProject(),revision=session.api.inspect().revision,reports={};
  const files=process.env.DUCK_RUNTIME_POSITIVE_ONLY==='1'?[["float32","duck.fun3d"]]:[["quantized","duck-quantized.fun3d"],["float32","duck.fun3d"]];
  for(const [name,file] of files) {
    reports[name]=await session.api.workflow({action:"verifyRuntime",detail:"full",ifRevision:revision,
      query:{data:(await readFile(`${out}/${file}`)).toString("base64"),poses}});
    console.log(name,reports[name].samples.filter(s=>s.ok).length,"/",poses.length,"passed");
  }
  if(reports.quantized)assert.equal(reports.quantized.ok,false,"Retained low-precision specimen must expose the closed-volume defect");
  assert.equal(reports.float32.ok,true,"Inspect actual runtime failures; never substitute author geometry");
  assert.deepEqual(session.api.getProject(),before);assert.equal(session.api.inspect().revision,revision);
  await writeFile(`${out}/runtime-contact-acceptance.json`,JSON.stringify({isolated:true,unchanged:true,poses,reports}));
}finally{session.dispose();}
