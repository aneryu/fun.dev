import { readFile,writeFile,mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { createStore,evaluateProject } from "../../site/workshop/document.js";
import { openWorkshop } from "../workshop-node.mjs";
import { Ray,Triangle,Vector3 } from "three";
import { triangulate } from "../../site/workshop/mesh.js";

const out="test-results/duck-oral-volume";await mkdir(out,{recursive:true});
const {project}=JSON.parse(await readFile("test-results/duck-joint-panel/authored.json","utf8"));
const store=createStore(project),cavity=project.nodes.find(n=>n.id==="mouth_cavity"),tongue=project.nodes.find(n=>n.id==="tongue");
// This source's bowl has three 20-vertex inner rings and an inner back pole.
// Validate connectivity instead of treating every dark surface as oral air.
const faces=cavity.mesh.faces.filter(f=>f.vertices.every(i=>i<=60)).map(f=>f.id);
assert.equal(faces.length,100);
const caps=[];
for(let i=0;i<10;i++) {
  const quad=[i,i+1,(19-i)%20,(20-i)%20].filter((v,j,a)=>a.indexOf(v)===j);
  if(quad.length===3) caps.push(quad);
  else caps.push([quad[0],quad[1],quad[2]],[quad[0],quad[2],quad[3]]);
}
const closed=cavity.morph.targets.find(t=>t.name==="mouthClose");
const affine=[0,1,2].map(k=>{
  const base=cavity.morph.base,a=base.findIndex(v=>v[k]===Math.min(...base.map(p=>p[k]))),
    b=base.findIndex(v=>v[k]===Math.max(...base.map(p=>p[k])));
  const scale=((base[b][k]+closed.deltas[b][k])-(base[a][k]+closed.deltas[a][k]))/(base[b][k]-base[a][k]);
  const offset=base[a][k]+closed.deltas[a][k]-scale*base[a][k];
  assert.ok(base.every((v,i)=>Math.abs(v[k]+closed.deltas[i][k]-v[k]*scale-offset)<1e-10));
  return {scale,offset};
});
const floor=cavity.mesh.faces.filter(f=>faces.includes(f.id)).flatMap(f=>triangulate(cavity.morph.base,f.vertices))
  .map(ids=>new Triangle(...ids.map(i=>new Vector3(...cavity.morph.base[i]))));
const low=Math.min(...tongue.morph.base.map(v=>v[1])),high=Math.max(...tongue.morph.base.map(v=>v[1]));
const compact=tongue.morph.base.map(v=>{
  const x=v[0]*.8,z=1.12+(v[2]-1.12)*.8,ray=new Ray(new Vector3(x,1,z),new Vector3(0,-1,0));
  const hits=floor.map(t=>ray.intersectTriangle(t.a,t.b,t.c,false,new Vector3())).filter(Boolean);
  assert.ok(hits.length,"Tongue footprint must lie over the actual inner floor");
  return [x,Math.min(...hits.map(p=>p.y))+.008+(v[1]-low)/(high-low)*.08,z];
});
const underside=tongue.morph.base.flatMap((v,i)=>(v[1]-low)/(high-low)<=.15?[i]:[]);
const opening=project.character.controls.find(c=>c.id==="mouthOpen");
const commands=[
  {op:"morphTarget",id:"tongue",name:"floorClearance",changes:compact.map((position,index)=>({index,position}))},
  {op:"characterControl",id:"tongueShape",bindings:[{node:"tongue",channel:"morph",target:"floorClearance",gain:1,attenuateBy:"mouthClose"}]},
  {op:"morphTarget",id:"tongue",name:"mouthClose",changes:compact.map((v,index)=>({
    index,position:v.map((x,k)=>x*affine[k].scale+affine[k].offset),
  }))},
  {op:"characterControl",...opening,bindings:opening.bindings.map(b=>({...b,attenuateBy:"mouthClose"}))},
  {op:"characterValues",values:{tongueShape:1,mouthOpen:0,mouthClose:0,smile:0,surprise:0}},
  ...["upper_bill","lower_bill","mouth_cavity"].map((target,i)=>({op:"relation",definition:{
    id:`tongue_surface_${i}`,kind:"surfaceIntersection",source:"tongue",target,tolerance:.00001,
    description:"Tongue must not cross the bill or the material of its inner lining",
  }})),
  {op:"relation",definition:{id:"oral_air",kind:"insideVolume",source:"tongue",target:"mouth_cavity",
    vertices:compact.map((_,i)=>i),min:.00001,max:1,volume:{faces,caps},
    description:"Oral air: inner bowl faces closed across the actual upper/lower aperture arcs; not lining material"}},
  {op:"relation",definition:{id:"tongue_floor_proximity",kind:"distance",source:"tongue",target:"mouth_cavity",
    vertices:underside,min:.00001,max:.025,description:"Underside rests near the inner floor, including the contracted closed pose"}},
  {op:"relation",definition:{id:"tongue_jaw_proximity",kind:"distance",source:"tongue",target:"lower_bill",
    vertices:underside,min:.00001,max:.05,description:"Underside stays within 50 mm of the lower bill in this metre-scale character"}},
];
store.apply(commands);const authored=store.snapshot();
const session=await openWorkshop({record:{project:authored,revision:0},width:64,height:64});
try {
  const {checkRelations}=await import("../../site/workshop/relation-checks.js");
  const samples=[];
  for(const mouthClose of [0,.25,.5,.75,1]) for(const mouthOpen of [0,.5,1])
    for(const expression of [{},{smile:.4},{surprise:.4}]) {
      const input=structuredClone(authored),values={mouthClose,mouthOpen,smile:0,surprise:0,...expression};
      input.character.values={...input.character.values,...values};delete input.character.pose;
      const p=evaluateProject(input),report=checkRelations(p);
      samples.push({values,ok:report.ok,results:report.results.map(r=>({
        id:r.id,status:r.status,reason:r.reason,contacts:r.kind==="surfaceIntersection"?r.samples.length:undefined,
        minimum:r.samples.length?Math.min(...r.samples.map(s=>s.actual).filter(Number.isFinite)):null,
        maximum:r.samples.length?Math.max(...r.samples.map(s=>s.actual).filter(Number.isFinite)):null,
        coverage:r.coverage,boundary:r.boundary?{status:r.boundary.status,contacts:r.boundary.samples.length,reason:r.boundary.reason}:undefined,
        failed:r.samples.filter(s=>s.status==="failed"),volume:r.volume?{
          status:r.volume.status,reason:r.volume.reason,issues:r.volume.issues,signedVolume:r.volume.signedVolume,
        }:undefined,
      }))});
  }
  await writeFile(`${out}/authored.json`,JSON.stringify({project:authored}));
  await writeFile(`${out}/commands.json`,JSON.stringify(commands,null,2));
  await writeFile(`${out}/samples.json`,JSON.stringify(samples,null,2));
  assert.ok(samples.every(s=>s.ok && s.results.find(r=>r.id==="oral_air")?.coverage?.wholeMeshContained),
    "Inspect samples.json: tongue surfaces, full derived-volume containment or proximity failed");
  console.log(JSON.stringify({samples:samples.length,passed:samples.filter(s=>s.ok).length,
    failures:samples.filter(s=>!s.ok).map(s=>({values:s.values,results:s.results.filter(r=>r.status!=="passed").map(r=>({
      id:r.id,status:r.status,reason:r.reason,contacts:r.contacts,failed:r.failed.length,volume:r.volume,
    }))}))}));
} finally {session.dispose();}
