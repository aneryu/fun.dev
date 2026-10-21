// Bounded shape exploration on isolated copies, never the user's draft.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createStore, evaluateProject } from "../../site/workshop/document.js";
import { openWorkshop } from "../workshop-node.mjs";

const out="test-results/duck-tongue-probe";await mkdir(out,{recursive:true});
const {project}=JSON.parse(await readFile("test-results/duck-joint-panel/authored.json","utf8"));
const session=await openWorkshop({record:{project,revision:0},width:64,height:64});
try {
  const {checkRelations}=await import("../../site/workshop/relation-checks.js");
  const shapes=[
    {name:"baseline",width:1,height:1,depth:1,lift:0},
    {name:"lifted",width:1,height:1,depth:1,lift:.1},
    {name:"flattened",width:1,height:.5,depth:.85,lift:.08},
    {name:"compact",width:.8,height:.4,depth:.8,lift:.1},
  ];
  const results=[];
  for(const shape of shapes) {
    const store=createStore(project),tongue=project.nodes.find(n=>n.id==="tongue");
    const changes=tongue.morph.base.map((v,index)=>({index,position:[
      v[0]*shape.width, -.456+(v[1]+.456)*shape.height+shape.lift,1.12+(v[2]-1.12)*shape.depth,
    ]}));
    store.apply([{op:"morphTarget",id:"tongue",name:"floorClearance",changes},
      {op:"characterControl",id:"tongueShape",bindings:[{node:"tongue",channel:"morph",target:"floorClearance",gain:1,attenuateBy:"mouthClose"}]},
      {op:"characterValues",values:{tongueShape:1}},
      ...["upper_bill","lower_bill","mouth_cavity"].map((target,i)=>({op:"relation",definition:{
        id:`tongue_surface_${i}`,kind:"surfaceIntersection",source:"tongue",target,tolerance:.00001,
      }}))]);
    const source=store.snapshot(),samples=[];
    for(const [pose,values] of [
      ["neutral",{}],["open",{mouthOpen:1}],["closed",{mouthClose:1}],
      ["smile",{smile:.4,mouthOpen:.5}],["surprise",{surprise:.4,mouthOpen:.5}],
    ]) {
      const input=structuredClone(source);
      input.character.values={...input.character.values,mouthOpen:0,mouthClose:0,smile:0,surprise:0,...values};
      delete input.character.pose;
      const evaluated=evaluateProject(input);
      // This probe covers only tongue pairs, not the rest of the mouth.
      evaluated.relations=evaluated.relations.filter(r=>r.id.startsWith("tongue_surface_"));
      const report=checkRelations(evaluated);
      samples.push({pose,values,results:report.results.map(r=>({target:r.target,status:r.status,contacts:r.samples.length,
        kinds:r.samples.reduce((counts,s)=>(counts[s.kind]=(counts[s.kind]??0)+1,counts),{})}))});
    }
    await writeFile(`${out}/${shape.name}.json`,JSON.stringify({project:source}));
    results.push({shape,samples});
    process.stderr.write(`${shape.name}: ${samples.map(s=>`${s.pose}=${s.results.map(r=>r.contacts).join("/")}`).join(" ")}\n`);
  }
  await writeFile(`${out}/result.json`,JSON.stringify(results,null,2));
  console.log(JSON.stringify(results));
} finally {session.dispose();}
