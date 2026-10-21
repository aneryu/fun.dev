// A separate persistent oral backing surface, sampled from the bill boundaries.
// Kept isolated until all contact and rendered-view checks pass.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Ray,Triangle,Vector3} from 'three';
import {createStore,evaluateProject} from '../../site/workshop/document.js';
import {triangulate} from '../../site/workshop/mesh.js';
import {surfaceDiagnostics} from '../../site/workshop/diagnostics.js';
import {openWorkshop} from '../workshop-node.mjs';
const out='test-results/duck-oral-backing';await mkdir(out,{recursive:true});
const {project}=JSON.parse(await readFile('test-results/duck-rim-repair/authored.json'));
const node=id=>project.nodes.find(n=>n.id===id),cavity=node('mouth_cavity');
const hits=(mesh,x,z)=>{
 const ray=new Ray(new Vector3(x,2,z),new Vector3(0,-1,0));
 return mesh.faces.flatMap(f=>triangulate(mesh.vertices,f.vertices).map(t=>new Triangle(...t.map(i=>new Vector3(...mesh.vertices[i])))))
  .map(t=>ray.intersectTriangle(t.a,t.b,t.c,false,new Vector3())).filter(Boolean).map(p=>p.y);
};
const closed=structuredClone(project);delete closed.character.pose;
closed.character.values={...closed.character.values,mouthOpen:0,mouthClose:1};
const closedLower=evaluateProject(closed).nodes.find(n=>n.id==='lower_bill');
const xs=Array.from({length:11},(_,i)=>-.48+i*.096),z=.90,depth=.008;
const top=xs.map(x=>{const h=hits(node('upper_bill').mesh,x,z);assert.ok(h.length);return [x,Math.min(...h)+.006,z];});
const floor=(mesh)=>xs.map((x,i)=>{const h=hits(mesh,x,z);assert.ok(h.length);return [x,Math.min(top[i][1]-.004,Math.max(...h)-.006),z];});
const bottom=floor(node('lower_bill').mesh),closedBottom=floor(closedLower.mesh);
const curves=[top,bottom,bottom.map(p=>[p[0],p[1],z-depth]),top.map(p=>[p[0],p[1],z-depth])];
const id='oral_backing',options={curves,samples:11,spans:1,closedSections:true,caps:true,flip:true};
const store=createStore(project),commands=[{op:'create',id,kind:'boundarySurface',parent:cavity.parent,
 position:cavity.position,rotation:cavity.rotation,scale:cavity.scale,material:'mouth_dark',options},
 {op:'recipe',id,definition:{parameters:{},name:'Oral backing between bill boundary samples',generator:{kind:'boundarySurface',material:'mouth_dark',options},steps:[]}}];
store.apply(commands);const mesh=store.snapshot().nodes.find(n=>n.id===id).mesh;
const closure=mesh.vertices.map((v,index)=>({index,position:[v[0],v[1]+(index>=11&&index<33?closedBottom[index%11][1]-bottom[index%11][1]:index>=44?(closedBottom[index===44?0:10][1]-bottom[index===44?0:10][1])/2:0),v[2]]}));
commands.push({op:'morphTarget',id,name:'mouthClose',changes:closure},
 {op:'skinBind',id,joints:['mouth_fixed_joint','jaw_joint'],weights:mesh.vertices.map((v,index)=>{
  const w=0; // The rear oral backing stays in the head frame; the separate bowl follows the jaw.
  return {index,influences:[...(w<1?[{joint:'mouth_fixed_joint',weight:1-w}]:[]),...(w>0?[{joint:'jaw_joint',weight:w}]:[])]};
 })},
 {op:'characterControl',...project.character.controls.find(c=>c.id==='mouthClose'),bindings:[...project.character.controls.find(c=>c.id==='mouthClose').bindings,
 {node:id,channel:'morph',target:'mouthClose',gain:1}]},
 ...['tongue','mouth_cavity'].map(target=>({op:'relation',definition:{id:`backing_${target}`,kind:'surfaceIntersection',source:id,target,tolerance:1e-5}})));
commands.push(...project.viewPresets.filter(v=>v.ids.includes('mouth_cavity')).map(v=>({op:'viewPreset',id:v.id,definition:{...v,ids:[...v.ids,id]}})));
store.apply(commands.slice(2));const authored=store.snapshot();
const session=await openWorkshop({record:{project:authored,revision:0},width:64,height:64});
try {
 const {checkRelations}=await import('../../site/workshop/relation-checks.js'),samples=[];
 for(const spec of JSON.parse(await readFile('test-results/duck-integrated/samples.json')).samples) {
  const p=structuredClone(authored);delete p.character.pose;
  if(spec.pose)p.character.pose={clip:spec.pose.name,time:spec.pose.time};else p.character.values={...p.character.values,...spec.values};
  const evaluated=evaluateProject(p),relations=checkRelations(evaluated),surface=surfaceDiagnostics(evaluated.nodes.find(n=>n.id===id).mesh);
  samples.push({values:spec.values,pose:spec.pose,ok:relations.ok&&surface.complete&&!surface.issuesTruncated&&!surface.issues.some(i=>['self-intersection','zero-volume'].includes(i.code)),
   failed:relations.results.filter(r=>r.status!=='passed'),surface});
 }
 await writeFile(`${out}/study.json`,JSON.stringify({project:authored,commands,samples}));
 console.log(JSON.stringify({passed:samples.filter(s=>s.ok).length,total:samples.length,failed:samples.filter(s=>!s.ok).map(s=>({values:s.values,pose:s.pose,relations:s.failed.map(r=>r.id),surface:s.surface.issues.map(i=>i.code)}))}));
}finally{session.dispose();}
