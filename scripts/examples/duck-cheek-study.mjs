// Persistent side membranes from corresponding roof/floor boundary samples.
// This remains an isolated study until multi-view and contact acceptance pass.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Ray,Triangle,Vector3} from 'three';
import {triangulate} from '../../site/workshop/mesh.js';
import {createStore,evaluateProject} from '../../site/workshop/document.js';
import {surfaceDiagnostics} from '../../site/workshop/diagnostics.js';
import {openWorkshop} from '../workshop-node.mjs';
const out='test-results/duck-cheeks';await mkdir(out,{recursive:true});
const {project}=JSON.parse(await readFile('test-results/duck-oral-backing/study.json'));
const cavity=project.nodes.find(n=>n.id==='mouth_cavity'),store=createStore(project),commands=[];
assert.equal(project.nodes.find(n=>n.id==='lower_bill').mesh.vertices.length,90,'Expected eight 11-point lower sections and two caps');
assert.equal(project.nodes.find(n=>n.id==='upper_bill').mesh.vertices.length,119,'Expected nine 13-point upper sections and two caps');
const ceilingMesh=project.nodes.find(n=>n.id==='upper_bill').mesh;
const triangles=ceilingMesh.faces.flatMap(f=>triangulate(ceilingMesh.vertices,f.vertices).map(t=>new Triangle(...t.map(i=>new Vector3(...ceilingMesh.vertices[i])))));
const fitRoof=v=>{const ray=new Ray(new Vector3(v[0],2,v[2]),new Vector3(0,-1,0));const hits=triangles.map(t=>ray.intersectTriangle(t.a,t.b,t.c,false,new Vector3())).filter(Boolean);assert.ok(hits.length,'Cheek roof must lie under bill');return [v[0],Math.min(...hits.map(p=>p.y))+.004,v[2]];};
const closedSource=structuredClone(project);delete closedSource.character.pose;closedSource.character.values={...closedSource.character.values,mouthClose:1,mouthOpen:0};
const closedLip=evaluateProject(closedSource).nodes.find(n=>n.id==='lower_bill').mesh.vertices.slice(0,11);
const lipAt=x=>{let i=closedLip.findIndex((p,i)=>i<10&&p[0]<=x&&closedLip[i+1][0]>=x);assert.ok(i>=0);let a=closedLip[i],b=closedLip[i+1],t=(x-a[0])/(b[0]-a[0]);return [x,a[1]+(b[1]-a[1])*t+.004,a[2]+(b[2]-a[2])*t];};
const sampleMorph=(id,name,p)=>{const n=project.nodes.find(n=>n.id===id),d=n.morph.targets.find(t=>t.name===name).deltas,q=new Vector3(...p);let best;
 for(const f of n.mesh.faces)for(const indices of triangulate(n.mesh.vertices,f.vertices)){const t=new Triangle(...indices.map(i=>new Vector3(...n.mesh.vertices[i]))),hit=t.closestPointToPoint(q,new Vector3()),distance=hit.distanceToSquared(q);
 if(!best||distance<best.distance){const w=t.getBarycoord(hit,new Vector3()).toArray();best={distance,delta:[0,1,2].map(k=>indices.reduce((sum,i,j)=>sum+d[i][k]*w[j],0))};}}
 return best.delta;};
const controls=structuredClone(project.character.controls),close=controls.find(c=>c.id==='mouthClose');
for(const [side,sign] of [['left',-1],['right',1]]) {
 const id=`oral_cheek_${side}`;
 const top=[61,62,63,64].map(i=>{const v=cavity.mesh.vertices[i];return [sign*(Math.abs(v[0])+.012),v[1],v[2]];});
 const bottom=[80,79,78,77].map(i=>{const v=cavity.mesh.vertices[i];return [sign*(Math.abs(v[0])+.012),v[1],v[2]];});
 for(let i=0;i<top.length;i++)top[i]=fitRoof(top[i]);
 const options={curves:[top,bottom],samples:4,spans:1,flip:sign>0};
 const initial=[{op:'create',id,kind:'boundarySurface',parent:cavity.parent,position:cavity.position,
  rotation:cavity.rotation,scale:cavity.scale,material:'mouth_dark',options},
  {op:'recipe',id,definition:{name:'Paired oral side boundaries',parameters:{},generator:{kind:'boundarySurface',material:'mouth_dark',options},
   steps:[{op:'solidify',thickness:.004,offset:0}]}}];
 store.apply(initial);commands.push(...initial);
 const mesh=store.snapshot().nodes.find(n=>n.id===id).mesh;
 const edits=[{op:'morphTarget',id,name:'mouthClose',changes:mesh.vertices.map((v,index)=>{
  const i=index%8,k=i%4,q=lipAt(bottom[k][0]);return {index,position:v.map((p,j)=>p+(i>=4?q[j]-bottom[k][j]:0))};
 })},{op:'skinBind',id,joints:['mouth_fixed_joint','jaw_joint'],weights:mesh.vertices.map((v,index)=>({index,
  influences:[{joint:index%8>=4?'jaw_joint':'mouth_fixed_joint',weight:1}]}))}];
 for(const name of ['smile','surprise']){
  edits.push({op:'morphTarget',id,name,changes:mesh.vertices.map((v,index)=>{const i=index%8,k=i%4,d=sampleMorph(i<4?'upper_bill':'lower_bill',name,i<4?top[k]:bottom[k]);return {index,position:v.map((p,j)=>p+d[j])};})});
  controls.find(c=>c.id===name).bindings.push({node:id,channel:'morph',target:name,gain:1});
 }
 store.apply(edits);commands.push(...edits);close.bindings.push({node:id,channel:'morph',target:'mouthClose',gain:1});
}
const ids=['oral_cheek_left','oral_cheek_right'];
const finish=[...controls.filter(c=>['mouthClose','smile','surprise'].includes(c.id)).map(c=>({op:'characterControl',...c})),...project.viewPresets.filter(v=>v.ids.includes('mouth_cavity')).map(v=>({op:'viewPreset',id:v.id,definition:{...v,ids:[...v.ids,...ids]}})),
 ...ids.flatMap(id=>['tongue','mouth_cavity','upper_bill','lower_bill'].map(target=>({op:'relation',definition:{id:`${id}_${target}`,kind:'surfaceIntersection',source:id,target,tolerance:1e-5,
 ...(target==='mouth_cavity'?{allowed:[{sourceFaces:store.snapshot().nodes.find(n=>n.id===id).mesh.faces.map(f=>f.id),
  targetFaces:cavity.mesh.faces.filter(f=>f.vertices.reduce((sum,i)=>sum+cavity.mesh.vertices[i][0],0)/f.vertices.length*(id.endsWith('left')?-1:1)>.2).map(f=>f.id),
  bounds:{min:[id.endsWith('left')?-.56:.18,-.58,.94],max:[id.endsWith('left')?-.18:.56,-.10,1.34]},
  reason:'The thin cheek membrane joins the existing lateral oral shell, including its inner surface. The central tongue corridor and all bill surfaces remain outside this exception.'}]}:target.endsWith('_bill')?{allowed:[{sourceFaces:store.snapshot().nodes.find(n=>n.id===id).mesh.faces.map(f=>f.id),
 targetFaces:Array.from({length:target==='upper_bill'?72:80},(_,i)=>`f${i+(target==='upper_bill'?120:0)}`),
 bounds:{min:[id.endsWith('left')?-.56:.12,-.58,.94],max:[id.endsWith('left')?-.12:.56,-.10,1.34]},
 reason:'The cheek membrane seats into the recessed underside or inner bowl bands; exterior bill faces are not exempt.'},
 ...(target==='lower_bill'?[{sourceFaces:store.snapshot().nodes.find(n=>n.id===id).mesh.faces.map(f=>f.id),
 targetFaces:project.nodes.find(n=>n.id==='lower_bill').mesh.faces.slice(160).map(f=>f.id),bounds:{min:[id.endsWith('left')?-.56:.42,-.38,.94],max:[id.endsWith('left')?-.42:.56,-.10,1.08]},
 reason:'Lateral membrane root seats in the lower section end cap, confined to the hinge region.'}]:[])]}:{})}})))];
finish.push(...ids.flatMap(id=>['upper_bill','lower_bill'].map(target=>({op:'relation',definition:{id:`${id}_${target}_depth`,kind:'signedGap',source:id,target,vertices:store.snapshot().nodes.find(n=>n.id===id).mesh.vertices.map((_,i)=>i).filter(i=>target==='upper_bill'?i%8<4:i%8>=4),min:-.02,max:2}}))));
finish.push(...ids.flatMap(id=>['upper_bill','lower_bill'].map(target=>({op:'relation',definition:{id:`${id}_${target}_seat`,kind:'distance',source:id,target,
 vertices:store.snapshot().nodes.find(n=>n.id===id).mesh.vertices.map((_,i)=>i).filter(i=>target==='upper_bill'?i%8<4:i%8>=4),min:0,max:.025,
 description:'Sampled membrane boundary must stay within 25 mm of its designated bill surface (model metres). This is a seating check, not a global gap proof.'}}))));
store.apply(finish);commands.push(...finish);const authored=store.snapshot();
const session=await openWorkshop({record:{project:authored,revision:0},width:64,height:64});
try {
 const {checkRelations}=await import('../../site/workshop/relation-checks.js'),samples=[];
 for(const spec of JSON.parse(await readFile('test-results/duck-integrated/samples.json')).samples) {
  const p=structuredClone(authored);delete p.character.pose;
  if(spec.pose)p.character.pose={clip:spec.pose.name,time:spec.pose.time};else p.character.values={...p.character.values,...spec.values};
  const evaluated=evaluateProject(p),relations=checkRelations(evaluated),surfaces=ids.map(id=>({id,...surfaceDiagnostics(evaluated.nodes.find(n=>n.id===id).mesh)}));
  samples.push({values:spec.values,pose:spec.pose,ok:relations.ok&&surfaces.every(s=>s.complete&&!s.issuesTruncated&&!s.issues.some(i=>['self-intersection','zero-volume'].includes(i.code))),
   failed:relations.results.filter(r=>r.status!=='passed'),surfaces});
 }
 const bad=structuredClone(authored);delete bad.character.pose;bad.character.values={...bad.character.values,mouthClose:1,mouthOpen:0};
 for(const d of bad.nodes.find(n=>n.id===ids[0]).morph.targets.find(t=>t.name==='mouthClose').deltas)d[0]+=.4;
 const negative=checkRelations(evaluateProject(bad));assert.ok(negative.results.some(r=>r.id.startsWith(ids[0])&&r.status==='failed'),'Detached membrane must fail declared relationships');
 await writeFile(`${out}/negative.json`,JSON.stringify({project:bad,report:negative}));
 await writeFile(`${out}/study.json`,JSON.stringify({project:authored,commands,samples,negativeRejected:true}));
 console.log(JSON.stringify({passed:samples.filter(s=>s.ok).length,total:samples.length,failed:samples.filter(s=>!s.ok).map(s=>({values:s.values,pose:s.pose,relations:s.failed.map(r=>r.id),surface:s.surfaces.flatMap(s=>s.issues.map(i=>i.code))}))}));
}finally{session.dispose();}
