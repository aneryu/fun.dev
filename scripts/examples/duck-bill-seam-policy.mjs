// Bounded design policy for the duck's hinge insertion and closing inner lip.
// Reports every remaining contact; does not accept a failing candidate.
import {readFile,writeFile} from "node:fs/promises";
import {createStore,evaluateProject} from "../../site/workshop/document.js";
import {openWorkshop} from "../workshop-node.mjs";
import assert from "node:assert/strict";
const out="test-results/duck-rim-repair";
const {project}=JSON.parse(await readFile(`${out}/roof-rim.json`,"utf8"));
const {samples:specifications}=JSON.parse(await readFile("test-results/duck-integrated/samples.json","utf8"));
const upper=project.nodes.find(n=>n.id==="upper_bill"),lower=project.nodes.find(n=>n.id==="lower_bill");
const faceRange=(start,end)=>Array.from({length:end-start},(_,i)=>`f${start+i}`);
const root=lower.mesh.vertices.flatMap((v,i)=>v[2]<=1.06 || Math.abs(v[0])>.45?[i]:[]);
const lip=lower.mesh.vertices.flatMap((_,i)=>root.includes(i)?[]:[i]);
const commands=[{op:"relation",definition:{id:"bill_seam",kind:"surfaceIntersection",source:upper.id,target:lower.id,
  tolerance:.00001,allowed:[
    {sourceFaces:faceRange(144,192),targetFaces:lower.mesh.faces.map(f=>f.id),
      bounds:{min:[-.58,-.30,.63],max:[.58,-.13,1.13]},
      reason:"The closed solid bill roots interlock at the hinge/rear bowl. Entire contact must remain inside the local root compartment; a separate signed-gap relation limits sampled insertion depth."},
    {sourceFaces:faceRange(144,168),targetFaces:faceRange(0,80),
      bounds:{min:[-.48,-.26,1.05],max:[.48,-.12,1.37]},
      reason:"The closing lower inner lip seats against the recessed upper underside. Exterior bill bands are excluded and a separate signed-gap relation limits sampled overlap to 15 mm."},
  ]}},
  ...[["bill_root_depth",root,-.055],["bill_lip_depth",lip,-.015]].map(([id,vertices,min])=>({op:"relation",definition:{
    id,kind:"signedGap",source:lower.id,target:upper.id,vertices,min,max:2,
    description:"Metre-scale duck: declared sampled insertion depth. Does not certify a global penetration depth between vertices.",
  }})),
];
const store=createStore(project);store.apply(commands);const authored=store.snapshot();
const session=await openWorkshop({record:{project:authored,revision:0},width:64,height:64});
try {
  const {checkRelations}=await import("../../site/workshop/relation-checks.js"),samples=[];
  for(const specification of specifications) {
    const input=structuredClone(authored);delete input.character.pose;
    if(specification.pose) input.character.pose={clip:specification.pose.name,time:specification.pose.time};
    else input.character.values={...input.character.values,...specification.values};
    const report=checkRelations(evaluateProject(input));
    samples.push({values:specification.values,pose:specification.pose,...report});
  }
  // Move the closed lower bill 200 mm through the upper shell in an invalid
  // test specimen. Face labels must not waive outer-shell/deep intersections.
  // Do not submit this specimen as an edit or replace the accepted candidate.
  const bad=structuredClone(authored);delete bad.character.pose;
  const badTarget=bad.nodes.find(n=>n.id===lower.id).morph.targets.find(t=>t.name==="mouthClose");
  for(const delta of badTarget.deltas) delta[1]+=.2;
  bad.character.values={...bad.character.values,mouthOpen:0,mouthClose:1,smile:0,surprise:0};
  const negative=checkRelations(evaluateProject(bad)).results.filter(r=>r.id.startsWith("bill_"));
  assert.ok(negative.some(r=>r.status==="failed"),"Reject the invalid overclosed jaw");
  await writeFile(`${out}/bill-policy.json`,JSON.stringify({project:authored,commands,samples,negative}));
  console.log(JSON.stringify({samples:samples.length,passed:samples.filter(s=>s.ok).length,
    failed:samples.filter(s=>!s.ok).map(s=>({values:s.values,pose:s.pose,
      failures:s.results.filter(r=>r.status!=="passed").map(r=>({id:r.id,status:r.status,reason:r.reason,
        contacts:r.samples.filter(s=>s.status==="failed").length,
        minimum:Math.min(...r.samples.map(s=>s.actual).filter(Number.isFinite))}))}))}));
  assert.ok(samples.every(s=>s.ok),"Unapproved seam/depth failures remain; inspect bill-policy.json");
} finally {session.dispose();}
