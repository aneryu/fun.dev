// Isolated lining repair study; never overwrites the accepted oral-volume source.
import { readFile,writeFile,mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { Ray,Triangle,Vector3 } from "three";
import { createStore,evaluateProject } from "../../site/workshop/document.js";
import { triangulate } from "../../site/workshop/mesh.js";
import { surfaceDiagnostics } from "../../site/workshop/diagnostics.js";
import { openWorkshop } from "../workshop-node.mjs";

const out="test-results/duck-lining-fit";await mkdir(out,{recursive:true});
const {project}=JSON.parse(await readFile("test-results/duck-oral-volume/authored.json","utf8"));
const node=id=>project.nodes.find(n=>n.id===id),cavity=node("mouth_cavity"),tongue=node("tongue");
for(const [id,rows,columns] of [["upper_bill",9,13],["lower_bill",8,11]]) {
  const curves=node(id).recipe.generator.options.curves;
  assert.equal(curves.length,rows);assert.ok(curves.every(c=>c.length===columns));
  assert.equal(node(id).mesh.vertices.length,rows*columns+2,"Backing face bands require the original section topology");
}
const triangles=(mesh,vertices=mesh.vertices,faces=mesh.faces)=>faces.flatMap(f=>
  triangulate(vertices,f.vertices).map(t=>new Triangle(...t.map(i=>new Vector3(...vertices[i])))));
const upper=triangles(node("upper_bill").mesh),lower=triangles(node("lower_bill").mesh);
const hits=(ts,x,z)=>{
  const ray=new Ray(new Vector3(x,2,z),new Vector3(0,-1,0));
  return ts.map(t=>ray.intersectTriangle(t.a,t.b,t.c,false,new Vector3())).filter(Boolean).map(p=>p.y);
};
const oldFloor=triangles(cavity.mesh,cavity.mesh.vertices,cavity.mesh.faces.filter(f=>f.vertices.every(i=>i<=60)));
const closed=cavity.morph.targets.find(t=>t.name==="mouthClose");
const affine=[0,1,2].map(k=>{
  const base=cavity.morph.base,a=base.findIndex(v=>v[k]===Math.min(...base.map(p=>p[k]))),
    b=base.findIndex(v=>v[k]===Math.max(...base.map(p=>p[k])));
  const scale=(base[b][k]+closed.deltas[b][k]-base[a][k]-closed.deltas[a][k])/(base[b][k]-base[a][k]);
  const offset=base[a][k]+closed.deltas[a][k]-scale*base[a][k];
  assert.ok(base.every((v,i)=>Math.abs(v[k]+closed.deltas[i][k]-v[k]*scale-offset)<1e-10));
  return {scale,offset};
});
const session=await openWorkshop({record:{project,revision:0},width:64,height:64});
try {
  const {checkRelations}=await import("../../site/workshop/relation-checks.js"),results=[];
  for(const margin of process.env.DUCK_LINING_MARGIN ? [Number(process.env.DUCK_LINING_MARGIN)] : [.004,.008,.016]) {
    const unresolved=[];
    const fit=cavity.mesh.vertices.slice(0,61).map((v,index)=>{
      let [x,y,z]=v;
      // Bring the two bowl corners inward where the solid upper/lower roots overlap.
      if(index%61===0 || index%61===10) x*=.94;
      const u=hits(upper,x,z),l=hits(lower,x,z),clearance=margin;
      const ceiling=u.length?Math.min(...u)-clearance:Infinity,
        floor=l.length?Math.max(...l)+clearance:-Infinity;
      if(floor>=ceiling) {unresolved.push(index);return v;}
      return [x,Math.min(ceiling,Math.max(floor,y)),z];
    });
    // Move the matching outer shell with its inner material point; independent
    // clipping can invert the wall between corresponding rings.
    for(let i=0;i<61;i++) fit.push(fit[i].map((v,k)=>v+cavity.mesh.vertices[i+61][k]-cavity.mesh.vertices[i][k]));
    const newFloor=triangles(cavity.mesh,fit,cavity.mesh.faces.filter(f=>f.vertices.every(i=>i<=60)));
    const tongueFit=tongue.mesh.vertices.map(v=>{
      const a=hits(oldFloor,v[0],v[2]),b=hits(newFloor,v[0],v[2]);
      assert.ok(a.length && b.length,"Tongue footprint must remain over both floor surfaces");
      return [v[0],v[1]+Math.min(...b)-Math.min(...a),v[2]];
    });
    const commands=[];
    for(const [n,positions] of [[cavity,fit],[tongue,tongueFit]]) {
      commands.push({op:"morphTarget",id:n.id,name:"liningFit",changes:positions.map((p,index)=>({index,
        position:p.map((v,k)=>v-n.mesh.vertices[index][k]+n.morph.base[index][k])}))});
      commands.push({op:"morphTarget",id:n.id,name:"mouthClose",changes:positions.map((p,index)=>({index,
        position:p.map((v,k)=>v*affine[k].scale+affine[k].offset)}))});
      if(process.env.DUCK_LINING_CORRECTIVE) commands.push({op:"morphTarget",id:n.id,name:"closeClearance",
        // Close weight c attenuated by itself gives c(1-c). The roof needs
        // more clearance than the floor; the floor stays near the lower jaw.
        changes:positions.map((p,index)=>({index,position:n.morph.base[index].map((v,k)=>
          k===1?v+(p[1]>-.35?.95:.2)*(-.35-p[1]):v)}))});
    }
    if(process.env.DUCK_LINING_CORRECTIVE) {
      const close=project.character.controls.find(c=>c.id==="mouthClose");
      commands.push({op:"characterControl",...close,bindings:[...close.bindings,
        ...[cavity,tongue].map(n=>({node:n.id,channel:"morph",target:"closeClearance",gain:1,attenuateBy:"mouthClose"}))]});
    }
    commands.push({op:"characterControl",id:"oralFit",bindings:[cavity,tongue].map(n=>({
      node:n.id,channel:"morph",target:"liningFit",gain:1,attenuateBy:"mouthClose"}))},
      {op:"characterValues",values:{oralFit:1}},
      ...["upper_bill","lower_bill"].map((target,i)=>({op:"relation",definition:{
        id:`lining_surface_${i}`,kind:"surfaceIntersection",source:"mouth_cavity",target,tolerance:.00001,
        ...(process.env.DUCK_LINING_BACKING?{allowed:[{
          sourceFaces:cavity.mesh.faces.filter(f=>!f.vertices.every(v=>v<=60)).map(f=>f.id),
          // Boundary-section bands: upper 5..7 are the recessed underside;
          // lower 0..3 run from the inner lip to the bowl's rear inner wall.
          targetFaces:Array.from({length:i===0?72:80},(_,j)=>`f${j+(i===0?120:0)}`),
          reason:"The lining's outer backing and rim seat into the bill's recessed inner bands. Air-facing lining faces and exterior bill bands are not permitted to intersect.",
        }]}:{}),
      }})));
    const store=createStore(project);store.apply(commands);const authored=store.snapshot(),samples=[];
    const poses=process.env.DUCK_LINING_MARGIN ? [0,.25,.5,.75,1].flatMap(mouthClose=>[0,.5,1].flatMap(mouthOpen=>
      [{},{smile:.4},{surprise:.4}].map(expression=>({mouthClose,mouthOpen,...expression})))) :
      [{},{mouthOpen:1},{mouthClose:1},{mouthOpen:.5,smile:.4}];
    for(const values of poses) {
      const input=structuredClone(authored);delete input.character.pose;
      input.character.values={...input.character.values,mouthOpen:0,mouthClose:0,smile:0,surprise:0,...values};
      const evaluated=evaluateProject(input),report=checkRelations(evaluated);
      const surfaces=["mouth_cavity","tongue"].map(id=>({id,...surfaceDiagnostics(evaluated.nodes.find(n=>n.id===id).mesh)}));
      samples.push({values,ok:report.ok,surfaces,results:report.results.map(r=>({id:r.id,status:r.status,reason:r.reason,
        coverage:r.coverage,contacts:r.samples.filter(s=>s.status==="failed").length,
        failed:r.samples.filter(s=>s.status==="failed")}))});
    }
    const innerFailures=samples.flatMap(s=>s.results.filter(r=>r.id.startsWith("lining_surface")).flatMap(r=>
      r.failed.filter(contact=>cavity.mesh.faces.find(f=>f.id===contact.face).vertices.every(i=>i<=60))));
    const nonLiningPass=samples.every(s=>s.results.filter(r=>!r.id.startsWith("lining_surface")).every(r=>r.status==="passed"));
    const completeLiningChecks=samples.every(s=>s.results.filter(r=>r.id.startsWith("lining_surface"))
      .every(r=>r.coverage?.declaredMeshPairSurfaceIntersection));
    const surfacesPass=samples.every(s=>s.surfaces.every(r=>r.complete && !r.issuesTruncated &&
      !r.issues.some(i=>["self-intersection","zero-volume"].includes(i.code))));
    const acceptance={accepted:false,samples:samples.length,innerContacts:innerFailures.length,
      nonLiningPass,completeLiningChecks,surfacesPass,backingPolicy:!!process.env.DUCK_LINING_BACKING,
      allDeclaredRelationsPassed:samples.every(s=>s.ok),upperLowerBillSeamsUnresolved:true};
    if(process.env.DUCK_LINING_BACKING) {
      const regression=structuredClone(authored);delete regression.character.pose;
      regression.character.values={...regression.character.values,oralFit:0,mouthClose:0,mouthOpen:0,smile:0,surprise:0};
      const failures=checkRelations(evaluateProject(regression)).results.filter(r=>r.id.startsWith("lining_surface") && r.status==="failed");
      assert.equal(failures.length,2,"Backing exceptions must not waive the old inner-wall defects");
      acceptance.oldInnerDefectsRejected=true;
    }
    await writeFile(`${out}/margin-${margin}.json`,JSON.stringify({project:authored,commands,samples,unresolved,acceptance}));
    if(process.env.DUCK_LINING_CORRECTIVE && margin===.016 && samples.length===45) {
      assert.equal(innerFailures.length,0,"Inner lining intersections remain");
      assert.ok(nonLiningPass && completeLiningChecks && surfacesPass,"Other relations, self intersections or coverage regressed");
    }
    results.push({margin,unresolved,samples:samples.map(s=>({values:s.values,ok:s.ok,
      failed:s.results.filter(r=>r.status!=="passed").map(({failed,...r})=>r)}))});
  }
  await writeFile(`${out}/result.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
} finally {session.dispose();}
