// Read-only, unexempted bill-root audit. Does not accept or replace the duck.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createStore,evaluateProject} from '../../site/workshop/document.js';
import {openWorkshop} from '../workshop-node.mjs';
const source=process.env.DUCK_BACKING_SOURCE??'test-results/duck-cheeks/authored.json',out=process.env.DUCK_BACKING_OUT??'test-results/duck-backing-audit';
const bytes=await readFile(source),{project}=JSON.parse(bytes),store=createStore(project);
const ids=[];
for(const target of ['upper_bill','lower_bill']) {
 const id=`backing_audit_${target}`;ids.push(id,`${id}_seat`);
 store.apply([{op:'relation',definition:{id,kind:'surfaceIntersection',source:'oral_backing',target,tolerance:1e-5}},
  {op:'relation',definition:{id:`${id}_seat`,kind:'distance',source:'oral_backing',target,
   vertices:Array.from({length:44},(_,i)=>i).filter(i=>target==='upper_bill'?i<11||i>=33:i>=11&&i<33),min:0,max:.025}}]);
}
const candidate=store.snapshot(),session=await openWorkshop({record:{project:candidate,revision:0},width:64,height:64});
try {
 const {checkRelations}=await import('../../site/workshop/relation-checks.js'),samples=[];
 for(const spec of JSON.parse(await readFile('test-results/duck-integrated/samples.json')).samples) {
  const p=structuredClone(candidate);delete p.character.pose;
  if(spec.pose)p.character.pose={clip:spec.pose.name,time:spec.pose.time};else p.character.values={...p.character.values,...spec.values};
  const evaluated=evaluateProject(p);evaluated.relations=evaluated.relations.filter(r=>ids.includes(r.id));
  samples.push({...spec,report:checkRelations(evaluated)});
 }
 assert.deepEqual(await readFile(source),bytes);
 await mkdir(out,{recursive:true});
 await writeFile(`${out}/report.json`,JSON.stringify({source,unchanged:true,policy:'Unexempted diagnostic probe; intersections require design classification, not automatic repair.',project:candidate,samples}));
 console.log(JSON.stringify({total:samples.length,relations:ids.map(id=>{const results=samples.map(s=>s.report.results.find(r=>r.id===id));return {id,statusCounts:results.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{}),maxDistance:id.endsWith('_seat')?Math.max(...results.flatMap(r=>r.samples.map(s=>s.actual??0))):undefined};})}));
}finally{session.dispose();}
