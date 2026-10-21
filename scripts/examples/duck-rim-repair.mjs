// Repair the lining's exterior seating rim without moving its oral-air boundary.
import {readFile,writeFile,mkdir} from "node:fs/promises";
import assert from "node:assert/strict";
import {createStore,evaluateProject} from "../../site/workshop/document.js";
import {surfaceDiagnostics} from "../../site/workshop/diagnostics.js";
import {openWorkshop} from "../workshop-node.mjs";
const out="test-results/duck-rim-repair";await mkdir(out,{recursive:true});
const {project}=JSON.parse(await readFile("test-results/duck-integrated/authored.json","utf8"));
const source=JSON.parse(await readFile("test-results/duck-integrated/samples.json","utf8"));
const cavity=project.nodes.find(n=>n.id==="mouth_cavity"),fit=cavity.morph.targets.find(t=>t.name==="liningFit"),
  closed=cavity.morph.targets.find(t=>t.name==="mouthClose");
const lower=project.nodes.find(n=>n.id==="lower_bill");
for(const field of ["parent","position","rotation","scale"]) assert.deepEqual(cavity[field],lower[field]);
const session=await openWorkshop({record:{project,revision:0},width:64,height:64});
try {
  const {checkRelations}=await import("../../site/workshop/relation-checks.js"),results=[];
  const variants=[["corners",[61,71]],["roof-rim",Array.from({length:11},(_,i)=>61+i)],["hinge-rim",[61,71]]];
  for(const [name,indices] of variants.filter(([name])=>!process.env.DUCK_RIM_VARIANT || name===process.env.DUCK_RIM_VARIANT)) {
    const desired=index=>name==="hinge-rim"?lower.mesh.vertices[index===61?0:10]:cavity.morph.base[index];
    const delta=index=>desired(index).map((v,k)=>v-cavity.morph.base[index][k]-fit.deltas[index][k]);
    const commands=[{op:"morphEdit",id:cavity.id,name:"liningFit",changes:indices.map(index=>({index,position:desired(index)}))},
      {op:"morphEdit",id:cavity.id,name:"mouthClose",changes:indices.map(index=>({index,
        position:cavity.morph.base[index].map((v,k)=>v+closed.deltas[index][k]+delta(index)[k]*[.1,.004,.1][k])}))},
      {op:"morphEdit",id:cavity.id,name:"closeClearance",changes:indices.map(index=>({index,
        position:cavity.morph.base[index].map((v,k)=>k===1?v+(desired(index)[1]>-.35?.95:.2)*(-.35-desired(index)[1]):v)}))}];
    const store=createStore(project);let authored;
    try {store.apply(commands);authored=store.snapshot();}
    catch(error) {results.push({name,error:{message:error.message,code:error.code,issues:error.issues}});continue;}
    for(let i=0;i<=60;i++) assert.deepEqual(authored.nodes.find(n=>n.id===cavity.id).mesh.vertices[i],cavity.mesh.vertices[i]);
    const samples=[];
    for(const specification of source.samples) {
      const input=structuredClone(authored);delete input.character.pose;
      if(specification.pose) input.character.pose={clip:specification.pose.name,time:specification.pose.time};
      else input.character.values={...input.character.values,...specification.values};
      const evaluated=evaluateProject(input),relations=checkRelations(evaluated),
        surface=surfaceDiagnostics(evaluated.nodes.find(n=>n.id===cavity.id).mesh);
      samples.push({values:specification.values,pose:specification.pose,ok:relations.ok && surface.complete &&
        !surface.issuesTruncated && !surface.issues.some(i=>["self-intersection","zero-volume"].includes(i.code)),relations,surface});
    }
    await writeFile(`${out}/${name}.json`,JSON.stringify({project:authored,commands,samples}));
    results.push({name,samples:samples.length,passed:samples.filter(s=>s.ok).length,
      failed:samples.filter(s=>!s.ok).map(s=>({values:s.values,pose:s.pose,surface:s.surface.issues,
        relations:s.relations.results.filter(r=>r.status!=="passed").map(r=>({id:r.id,status:r.status,reason:r.reason}))}))});
  }
  await writeFile(`${out}/result.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
} finally {session.dispose();}
