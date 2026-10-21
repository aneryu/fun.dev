// Isolated study: preserve lateral lining coverage during closing.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createStore,evaluateProject} from '../../site/workshop/document.js';
import {surfaceDiagnostics} from '../../site/workshop/diagnostics.js';
import {openWorkshop} from '../workshop-node.mjs';
const out='test-results/duck-closure-rim';await mkdir(out,{recursive:true});
const {project}=JSON.parse(await readFile('test-results/duck-rim-repair/authored.json'));
const specifications=JSON.parse(await readFile('test-results/duck-integrated/samples.json')).samples;
const cavity=project.nodes.find(n=>n.id==='mouth_cavity');
const corrective=cavity.morph.targets.find(t=>t.name==='closeClearance');
const session=await openWorkshop({record:{project,revision:0},width:64,height:64});
try {
 const {checkRelations}=await import('../../site/workshop/relation-checks.js');const results=[];
 for(const [name,select,gain] of [['outer',i=>i>=61,1.8],['aperture',i=>i>=61&&i<81,1.8],['all',()=>true,1.8]]) {
  const commands=[{op:'morphEdit',id:cavity.id,name:'closeClearance',changes:cavity.morph.base.flatMap((v,index)=>select(index)?[{index,
   position:v.map((p,k)=>p+corrective.deltas[index][k]+(k===0?v[0]*gain:0))}]:[])}];
  const store=createStore(project);store.apply(commands);const authored=store.snapshot(),samples=[];
  for(const spec of specifications) {
   const p=structuredClone(authored);delete p.character.pose;
   if(spec.pose)p.character.pose={clip:spec.pose.name,time:spec.pose.time};
   else p.character.values={...p.character.values,...spec.values};
   const evaluated=evaluateProject(p),relations=checkRelations(evaluated),surface=surfaceDiagnostics(evaluated.nodes.find(n=>n.id===cavity.id).mesh);
   samples.push({values:spec.values,pose:spec.pose,ok:relations.ok&&surface.complete&&!surface.issuesTruncated&&!surface.issues.some(i=>['self-intersection','zero-volume'].includes(i.code)),
    failed:relations.results.filter(r=>r.status!=='passed').map(r=>({id:r.id,status:r.status})),surface});
  }
  await writeFile(`${out}/${name}.json`,JSON.stringify({project:authored,commands,samples}));
  results.push({name,passed:samples.filter(s=>s.ok).length,total:samples.length,failed:samples.filter(s=>!s.ok).map(({surface,...s})=>({...s,surface:surface.issues.map(i=>i.code)}))});
  console.log(name,results.at(-1).passed,'/',samples.length);
 }
 await writeFile(`${out}/result.json`,JSON.stringify(results,null,2));
} finally {session.dispose();}
