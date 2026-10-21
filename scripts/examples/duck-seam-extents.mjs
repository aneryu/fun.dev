// Read-only classification aid. It does not adopt intersection exceptions.
import { readFile,writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { evaluateProject } from "../../site/workshop/document.js";
import { worldMatrix,inverse,point } from "../../site/workshop/spatial.js";

const directory=process.env.DUCK_AUDIT_OUT || "test-results/duck-seam-extents";
const {project}=JSON.parse(await readFile(`${directory}/authored.json`,"utf8"));
const audit=JSON.parse(await readFile(`${directory}/result.json`,"utf8"));
const bounds=points=>points.length ? {min:[0,1,2].map(k=>Math.min(...points.map(p=>p[k]))),
  max:[0,1,2].map(k=>Math.max(...points.map(p=>p[k])))} : null;
const samples=audit.samples.map(sample=>{
  const input=structuredClone(project);
  input.character.values={...input.character.values,mouthOpen:0,mouthClose:0,smile:0,surprise:0,...sample.values};
  delete input.character.pose;
  const evaluated=evaluateProject(input),toLocal=inverse(worldMatrix(evaluated,"mouth_mount"));
  const pairs=sample.results.map(result=>{
    const node=evaluated.nodes.find(n=>n.id===result.source),groups={};
    for(const contact of result.samples) {
      assert.ok(contact.contactGeometry,"Run the audit with full contact-geometry support first");
      const face=node.mesh.faces.find(f=>f.id===contact.face);
      // This duck's three 20-vertex inner rings and pole are 0..60;
      // the outer material shell is 61..121. This is model metadata, not a core rule.
      const region=result.source!=="mouth_cavity" ? "bill" :
        face.vertices.every(i=>i<=60) ? "inner" : face.vertices.every(i=>i>=61) ? "outer" : "rim";
      (groups[region]??=[]).push({sourceFace:contact.face,targetFace:contact.target.face,kind:contact.kind,
        points:contact.contactGeometry.points.map(p=>point(toLocal,p))});
    }
    return {source:result.source,target:result.target,status:result.status,
      regions:Object.fromEntries(Object.entries(groups).map(([name,contacts])=>[name,{
        contacts:contacts.length,bounds:bounds(contacts.flatMap(c=>c.points)),geometry:contacts,
      }]))};
  });
  return {name:sample.name,values:sample.values,pairs};
});
await writeFile(`${directory}/extents.json`,JSON.stringify({space:"mouth_mount-local",units:"metres",
  interpretation:"Measured contact extents only; no intended seam classification or exception adopted",samples},null,2));
console.log(JSON.stringify(samples.map(s=>({name:s.name,pairs:s.pairs.filter(p=>p.status!=="passed").map(p=>({
  source:p.source,target:p.target,regions:Object.fromEntries(Object.entries(p.regions).map(([k,v])=>[k,{contacts:v.contacts,bounds:v.bounds}]))
}))})),null,2));
