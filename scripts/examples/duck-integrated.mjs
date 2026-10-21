// Final-scenario composition on one editable source. Upper/lower seam audit is
// retained separately; passing this script alone does not complete the ledger.
import {readFile,writeFile,mkdir} from "node:fs/promises";
import assert from "node:assert/strict";
import {createStore,evaluateProject} from "../../site/workshop/document.js";
import {worldMatrix,point,inverse} from "../../site/workshop/spatial.js";
import {triangulate} from "../../site/workshop/mesh.js";
import {Triangle,Vector3} from "three";
import {surfaceDiagnostics} from "../../site/workshop/diagnostics.js";
import {openWorkshop} from "../workshop-node.mjs";
const out="test-results/duck-integrated";await mkdir(out,{recursive:true});
const {project}=JSON.parse(await readFile("test-results/duck-lining-fit/render-0.016/authored.json","utf8"));
const walk=structuredClone(project.character.clips.find(c=>c.name==="walk"));
const key=walk.tracks.find(t=>t.node==="wing_left_joint" && t.channel==="rotation").keys.find(k=>k.time===.3);
const previousKey=[...key.value];key.value[2]+=5;
const upper=project.nodes.find(n=>n.id==="upper_bill"),definition=structuredClone(upper.recipe);
const oldThickness=definition.parameters.extraThickness.value;
definition.generator.options.curves=definition.generator.options.curves.map((curve,row)=>curve.map((v,i)=>{
  const p=v.map(x=>typeof x==="number"?x:x.offset+x.factor*oldThickness);
  const factor=row>=1 && row<=4 ? Math.sin(Math.PI*i/(curve.length-1))**2 : 0;
  if(factor) p[1]={$param:"extraThickness",factor,offset:p[1]-factor*oldThickness};
  return p;
}));
definition.name="Boundary-section bill, outward thickness with fixed oral roof";
const upperTriangles=upper.mesh.faces.flatMap(f=>triangulate(upper.mesh.vertices,f.vertices).map(t=>
  new Triangle(...t.map(i=>new Vector3(...point(worldMatrix(project,upper.id),upper.mesh.vertices[i]))))));
const nostrils=["nostril_right","nostril_left"].map(id=>{
  const n=project.nodes.find(n=>n.id===id),center=point(worldMatrix(project,id),[0,1,2].map(k=>
    n.mesh.vertices.reduce((s,p)=>s+p[k],0)/n.mesh.vertices.length));
  const query=new Vector3(...center),hits=upperTriangles.map(t=>t.closestPointToPoint(query,new Vector3()));
  hits.sort((a,b)=>a.distanceToSquared(query)-b.distanceToSquared(query));const at=hits[0].toArray();
  return {op:"attachSurface",id,targetId:upper.id,at,anchor:point(inverse(worldMatrix(project,id)),at),mode:"frame"};
});
const commands=[
  {op:"recipe",id:"upper_bill",definition},...nostrils,
  {op:"recipeParameters",id:"head",values:{headWidth:.085,foreheadWidth:.13}},
  ...["upper_bill","lower_bill"].map(id=>({op:"recipeParameters",id,values:{extraThickness:.025}})),
  {op:"characterClip",...walk},
];
const store=createStore(project);store.apply(commands);const authored=store.snapshot();
const attachments=authored.nodes.filter(n=>n.attachment && n.attachment.mode!=="deform").map(n=>{
  const a=n.attachment,target=authored.nodes.find(t=>t.id===a.target);
  assert.equal(a.offset,0,"This example checks zero-offset anchor coincidence");
  const vertices=a.vertices.map(i=>point(worldMatrix(authored,target.id),target.mesh.vertices[i]));
  const expected=[0,1,2].map(k=>vertices.reduce((sum,p,i)=>sum+p[k]*a.weights[i],0));
  const actual=point(worldMatrix(authored,n.id),a.anchor),error=Math.hypot(...actual.map((v,k)=>v-expected[k]));
  assert.ok(error<1e-8,`${n.id} attachment drifted`);return {id:n.id,errorMetres:error};
});
const head=project.nodes.find(n=>n.id==="head"),changedHead=authored.nodes.find(n=>n.id==="head");
const chin=head.mesh.vertices.flatMap((p,i)=>p[1]<=-.65?[i]:[]);
for(const i of chin) assert.deepEqual(changedHead.mesh.vertices[i],head.mesh.vertices[i]);
const session=await openWorkshop({record:{project:authored,revision:0},width:64,height:64});
try {
  const {checkRelations}=await import("../../site/workshop/relation-checks.js");
  const specifications=[0,.25,.5,.75,1].flatMap(mouthClose=>[0,.5,1].flatMap(mouthOpen=>
    [{},{smile:.4},{surprise:.4}].map(expression=>({values:{mouthClose,mouthOpen,smile:0,surprise:0,...expression}}))));
  specifications.push(...Array.from({length:9},(_,i)=>({pose:{name:"walk",time:i*walk.duration/8}})));
  const samples=[];
  for(const specification of specifications) {
    const input=structuredClone(authored);delete input.character.pose;
    if(specification.pose) input.character.pose={clip:specification.pose.name,time:specification.pose.time};
    else input.character.values={...input.character.values,...specification.values};
    const evaluated=evaluateProject(input),relations=checkRelations(evaluated);
    const surfaces=["mouth_cavity","tongue","upper_bill","lower_bill"].map(id=>({id,
      ...surfaceDiagnostics(evaluated.nodes.find(n=>n.id===id).mesh)}));
    samples.push({...specification,ok:relations.ok && surfaces.every(s=>s.complete && !s.issuesTruncated &&
      !s.issues.some(i=>["self-intersection","zero-volume"].includes(i.code))),relations,surfaces});
  }
  await writeFile(`${out}/authored.json`,JSON.stringify({project:authored}));
  await writeFile(`${out}/commands.json`,JSON.stringify(commands,null,2));
  await writeFile(`${out}/samples.json`,JSON.stringify({attachments,protectedChin:chin,previousKey,editedKey:key,samples},null,2));
  console.log(JSON.stringify({samples:samples.length,passed:samples.filter(s=>s.ok).length,attachments,
    failed:samples.filter(s=>!s.ok).map(s=>({values:s.values,pose:s.pose,
      relations:s.relations.results.filter(r=>r.status!=="passed").map(r=>({id:r.id,status:r.status,reason:r.reason})),
      surfaces:s.surfaces.filter(r=>r.issues.length).map(r=>({id:r.id,issues:r.issues}))}))}));
  assert.ok(samples.every(s=>s.ok),"Inspect the integrated combination failures before accepting or exporting");
} finally {session.dispose();}
