// Isolated study: preserve lateral lining coverage during closing.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createStore,evaluateProject} from '../../site/workshop/document.js';
import {surfaceDiagnostics} from '../../site/workshop/diagnostics.js';
import {Ray,Triangle,Vector3} from 'three';
import {triangulate} from '../../site/workshop/mesh.js';
import {openWorkshop} from '../workshop-node.mjs';
const out='test-results/duck-closure-fit';await mkdir(out,{recursive:true});
const {project}=JSON.parse(await readFile('test-results/duck-rim-repair/authored.json'));
const specifications=JSON.parse(await readFile('test-results/duck-integrated/samples.json')).samples;
const cavity=project.nodes.find(n=>n.id==='mouth_cavity');
const corrective=cavity.morph.targets.find(t=>t.name==='closeClearance');
const session=await openWorkshop({record:{project,revision:0},width:64,height:64});
try {
 const {checkRelations}=await import('../../site/workshop/relation-checks.js');const results=[];
 for(const [name,select,gain] of [['fit',()=>true,1.2]]) {
  const commands=[{op:'morphEdit',id:cavity.id,name:'closeClearance',changes:cavity.morph.base.flatMap((v,index)=>select(index)?[{index,
   position:v.map((p,k)=>p+corrective.deltas[index][k]+(k===0?v[0]*gain:k===2?(v[2]-1.25)*gain:0))}]:[])}];
  const store=createStore(project);store.apply(commands);
  const probe=store.snapshot();delete probe.character.pose;
  probe.character.values={...probe.character.values,mouthClose:.5,mouthOpen:0,smile:0,surprise:0};
  const evaluatedProbe=evaluateProject(probe),shell=evaluatedProbe.nodes.find(n=>n.id==='mouth_cavity'),upper=evaluatedProbe.nodes.find(n=>n.id==='upper_bill');
  const ts=upper.mesh.faces.flatMap(f=>triangulate(upper.mesh.vertices,f.vertices).map(t=>new Triangle(...t.map(i=>new Vector3(...upper.mesh.vertices[i])))));
  const current=store.snapshot().nodes.find(n=>n.id===cavity.id).morph.targets.find(t=>t.name==='closeClearance');
  const shifts=Array.from({length:61},(_,i)=>{
   const v=shell.mesh.vertices[i];if(i===60||i%20>10)return 0;
   const ray=new Ray(new Vector3(v[0],2,v[2]),new Vector3(0,-1,0));
   const h=ts.map(t=>ray.intersectTriangle(t.a,t.b,t.c,false,new Vector3())).filter(Boolean).map(p=>p.y);
   return h.length?4*Math.min(0,Math.min(...h)-.016-v[1]):0;
  });
  const correction={op:'morphEdit',id:cavity.id,name:'closeClearance',changes:cavity.morph.base.map((v,index)=>({index,position:v.map((p,k)=>p+current.deltas[index][k]+(k===1?shifts[index%61]:0))}))};
  commands.push(correction);store.apply([correction]);const authored=store.snapshot(),samples=[];
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
