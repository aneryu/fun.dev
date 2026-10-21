// Isolated jaw-following backing study; never replaces the accepted source.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Ray,Triangle,Vector3} from 'three';
import {triangulate} from '../../site/workshop/mesh.js';
import {surfaceDiagnostics} from '../../site/workshop/diagnostics.js';
import {createStore,evaluateProject} from '../../site/workshop/document.js';
import {openWorkshop} from '../workshop-node.mjs';
const source='test-results/duck-cheeks/authored.json',out='test-results/duck-backing-jaw';
const bytes=await readFile(source),{project}=JSON.parse(bytes),store=createStore(project);
const closed=structuredClone(project);delete closed.character.pose;
closed.character.values={...closed.character.values,mouthClose:1,mouthOpen:0,smile:0,surprise:0};
const closedNodes=evaluateProject(closed).nodes,backing=project.nodes.find(n=>n.id==='oral_backing');
const hits=(id,x,z)=>{const mesh=closedNodes.find(n=>n.id===id).mesh,ray=new Ray(new Vector3(x,2,z),new Vector3(0,-1,0));
 return mesh.faces.flatMap(f=>triangulate(mesh.vertices,f.vertices).map(t=>new Triangle(...t.map(i=>new Vector3(...mesh.vertices[i])))))
 .map(t=>ray.intersectTriangle(t.a,t.b,t.c,false,new Vector3())).filter(Boolean).map(p=>p.y);};
// When the closing bill bands overlap, retain a 4 mm rear fold centred between
// their inner boundaries instead of clamping the entire fold to the upper band.
const closing=Array.from({length:11},(_,i)=>{const x=backing.morph.base[i][0],z=.9;
 const roof=Math.min(...hits('upper_bill',x,z)),floor=Math.max(...hits('lower_bill',x,z));
 assert.ok(Number.isFinite(roof)&&Number.isFinite(floor));
 return floor-.006>=roof+.002?{top:(roof+floor)/2+.002,bottom:(roof+floor)/2-.002}:
 {top:roof+.006,bottom:floor-.006};});
const commands=[{op:'skinWeights',id:'oral_backing',weights:Array.from({length:46},(_,index)=>{
 const x=Math.abs(backing.morph.base[index][0]);
 const weight=index>=11&&index<33?Math.min(1,Math.max(0,(.48-x)/.192)):0;
 return {index,influences:[...(weight<1?[{joint:'mouth_fixed_joint',weight:1-weight}]:[]),...(weight>0?[{joint:'jaw_joint',weight}]:[])]};})},
 {op:'morphTarget',id:'oral_backing',name:'mouthClose',changes:backing.morph.base.map((v,index)=>({index,
 position:[v[0],index>=44?(closing[index===44?0:10].top+closing[index===44?0:10].bottom)/2:
 closing[index%11][index>=11&&index<33?'bottom':'top'],v[2]]}))}];
const deltaAt=(id,name,v)=>{const n=project.nodes.find(n=>n.id===id),q=new Vector3(...v),d=n.morph.targets.find(t=>t.name===name).deltas;let best;
 for(const f of n.mesh.faces)for(const indices of triangulate(n.mesh.vertices,f.vertices)){const t=new Triangle(...indices.map(i=>new Vector3(...n.mesh.vertices[i]))),p=t.closestPointToPoint(q,new Vector3()),distance=p.distanceToSquared(q);
  if(!best||distance<best.distance){const weights=t.getBarycoord(p,new Vector3()).toArray();best={distance,delta:[0,1,2].map(k=>indices.reduce((s,i,j)=>s+d[i][k]*weights[j],0))};}}
 return best.delta;};
for(const name of ['smile','surprise']){
 commands.push({op:'morphTarget',id:'oral_backing',name,changes:backing.morph.base.map((v,index)=>{
  const target=index>=11&&index<33?'lower_bill':'upper_bill',delta=deltaAt(target,name,v);
  return {index,position:v.map((x,k)=>x+delta[k])};})});
 const control=project.character.controls.find(c=>c.id===name);
 commands.push({op:'characterControl',...control,bindings:[...control.bindings,{node:'oral_backing',channel:'morph',target:name,gain:1}]});
}
for(const target of ['upper_bill','lower_bill'])commands.push({op:'relation',definition:{id:`backing_${target}_seat`,kind:'distance',source:'oral_backing',target,
 vertices:Array.from({length:44},(_,i)=>i).filter(i=>target==='upper_bill'?i<11||i>=33:i>=11&&i<33),min:0,max:.025}});
for(const target of ['upper_bill','lower_bill'])commands.push({op:'relation',definition:{id:`backing_${target}_root`,kind:'surfaceIntersection',source:'oral_backing',target,tolerance:1e-5,
 allowed:[{sourceFaces:backing.mesh.faces.map(f=>f.id),targetFaces:project.nodes.find(n=>n.id===target).mesh.faces.filter(f=>{
  const i=Number(f.id.slice(1));return target==='upper_bill'?i>=168&&i<192:(i>=40&&i<100)||i>=160;
 }).map(f=>f.id),bounds:{min:[-.49,-.5,.8],max:[.49,-.13,.91]},
 reason:'Rear oral partition seats through the recessed rear bill bands and hinge caps. The complete contact must stay in the rear hinge strip, including jaw rotation; front lip and side exterior bands remain checked.'}]}});
store.apply(commands);const candidate=store.snapshot(),session=await openWorkshop({record:{project:candidate,revision:0},width:64,height:64});
try {
 const {checkRelations}=await import('../../site/workshop/relation-checks.js'),samples=[];
 for(const spec of JSON.parse(await readFile('test-results/duck-integrated/samples.json')).samples) {
  const p=structuredClone(candidate);delete p.character.pose;
  if(spec.pose)p.character.pose={clip:spec.pose.name,time:spec.pose.time};else p.character.values={...p.character.values,...spec.values};
  const evaluated=evaluateProject(p),report=checkRelations(evaluated),surface=surfaceDiagnostics(evaluated.nodes.find(n=>n.id==='oral_backing').mesh);
  samples.push({...spec,ok:report.ok&&surface.complete&&!surface.issuesTruncated&&!surface.issues.some(i=>['self-intersection','zero-volume'].includes(i.code)),report,surface});
 }
 const bad=structuredClone(candidate);delete bad.character.pose;bad.character.values={...bad.character.values,mouthClose:1,mouthOpen:0};
 for(const delta of bad.nodes.find(n=>n.id==='oral_backing').morph.targets.find(t=>t.name==='mouthClose').deltas)delta[2]+=.4;
 const negative=checkRelations(evaluateProject(bad));assert.ok(negative.results.some(r=>r.id.startsWith('backing_')&&r.status==='failed'));
 assert.deepEqual(await readFile(source),bytes);await mkdir(out,{recursive:true});
 await writeFile(`${out}/negative.json`,JSON.stringify({project:bad,report:negative}));
 await writeFile(`${out}/study.json`,JSON.stringify({project:candidate,commands,samples,sourceUnchanged:true,negativeRejected:true}));
 console.log(JSON.stringify({passed:samples.filter(s=>s.ok).length,total:samples.length,failed:samples.filter(s=>!s.ok).map(s=>({values:s.values,pose:s.pose,relations:s.report.results.filter(r=>r.status!=='passed').map(r=>({id:r.id,status:r.status,max:r.kind==='distance'?Math.max(...r.samples.map(s=>s.actual??0)):undefined}))}))}));
}finally{session.dispose();}
