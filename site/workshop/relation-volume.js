import { triangulate, sub, cross, dot } from "./mesh.js";
import { surfaceDiagnostics } from "./diagnostics.js";
import { point } from "./spatial.js";

export function volumeSourceCoverage(mesh, samples) {
  const parents=new Map(mesh.faces.flatMap(f=>f.vertices).map(i=>[i,i]));
  const root=i=>{
    let r=i;while(parents.get(r)!==r) r=parents.get(r);
    while(i!==r) {const next=parents.get(i);parents.set(i,r);i=next;}
    return r;
  };
  for(const face of mesh.faces) for(const i of face.vertices.slice(1)) parents.set(root(i),root(face.vertices[0]));
  const components=new Set([...parents.keys()].map(root));
  const covered=new Set(samples.filter(i=>parents.has(i)).map(root));
  return {sourceComponents:components.size,sampledSourceComponents:covered.size,
    uncoveredSeedVertices:[...components].filter(i=>!covered.has(i)),
    allComponentsSampled:components.size>0 && covered.size===components.size};
}

export function volumeOverlayProject(project, results) {
  const shown=results.filter(r=>r.volume?.mesh && r.volume.worldMatrix);
  if(!shown.length) return {project,ids:[]};
  const display=structuredClone(project),ids=[];
  let material="_inspection_volume";
  while(display.materials.some(m=>m.id===material)) material=`_${material}`;
  display.materials.push({id:material,name:"Inspection volume",color:"#064F67",opacity:.18,roughness:1,doubleSided:true});
  for(const r of shown) {
    let id=`_volume_${r.id}`;
    while(display.nodes.some(n=>n.id===id)) id=`_${id}`;
    const volume=r.volume;
    display.nodes.push({id,name:`Inspection volume: ${r.id}`,parent:null,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],
      mesh:{vertices:volume.mesh.vertices.map(v=>point(volume.worldMatrix,v)),
        faces:volume.mesh.faces.map(f=>({...f,material}))}});
    ids.push(id);
  }
  return {project:display,ids};
}

// An inspection volume follows evaluated target vertices, never a stale copy.
export function relationVolume(target, definition, {maxPairs=2000000}={}) {
  const selected=target.mesh.faces.filter(f=>definition.faces.includes(f.id));
  const names=new Set(selected.map(f=>f.id));
  const caps=definition.caps.map((vertices,i)=>{
    let id=`volume_cap_${i}`;while(names.has(id)) id=`_${id}`;names.add(id);
    return {id,vertices:[...vertices]};
  });
  const faces=[...selected.map(f=>({id:f.id,vertices:[...f.vertices]})),...caps];
  const indices=[...new Set(faces.flatMap(f=>f.vertices))].sort((a,b)=>a-b);
  const map=new Map(indices.map((index,i)=>[index,i]));
  const mesh={vertices:indices.map(i=>[...target.mesh.vertices[i]]),
    faces:faces.map(f=>({...f,vertices:f.vertices.map(i=>map.get(i))}))};
  const edges=new Map(), neighbors=mesh.faces.map(()=>new Set());
  mesh.faces.forEach((f,fi)=>f.vertices.forEach((a,i)=>{
    const b=f.vertices[(i+1)%f.vertices.length],key=a<b?`${a}:${b}`:`${b}:${a}`;
    const list=edges.get(key)??[];list.push({face:fi,direction:a<b?1:-1});edges.set(key,list);
  }));
  const base={mesh,sourceVertexIndices:indices,closureFaces:caps.map(f=>f.id),testedPairs:0};
  const invalid=[...edges].filter(([,list])=>list.length!==2 || list[0].direction+list[1].direction!==0);
  if(invalid.length) return {...base,status:"not_checked",reason:"volume-not-closed-oriented",
    edges:invalid.slice(0,32).map(([edge,faces])=>({vertices:edge.split(":").map(i=>indices[Number(i)]),faces:faces.map(f=>mesh.faces[f.face].id)}))};
  for(const list of edges.values()) {neighbors[list[0].face].add(list[1].face);neighbors[list[1].face].add(list[0].face);}
  const visited=new Set(),todo=[0];
  while(todo.length) {const i=todo.pop();if(visited.has(i)) continue;visited.add(i);todo.push(...neighbors[i]);}
  if(visited.size!==mesh.faces.length) return {...base,status:"not_checked",reason:"volume-needs-one-connected-shell"};
  try {
    const origin=mesh.vertices[0],points=mesh.vertices.map(v=>sub(v,origin));
    const triangles=mesh.faces.flatMap(f=>triangulate(mesh.vertices,f.vertices));
    const signedVolume=triangles.reduce((v,[a,b,c])=>v+dot(points[a],cross(points[b],points[c]))/6,0);
    const span=Math.max(...[0,1,2].map(k=>Math.max(...points.map(v=>v[k]))-Math.min(...points.map(v=>v[k]))));
    if(Math.abs(signedVolume)<=span**3*1e-12)
      return {...base,status:"not_checked",reason:"volume-zero-or-numerically-flat",signedVolume};
    if(maxPairs<1) return {...base,status:"incomplete",reason:"volume-validation-budget"};
    const diagnostics=surfaceDiagnostics(mesh,{maxPairs,maxIssues:64,maxOverlaps:64});
    const validity={...base,testedPairs:Math.min(diagnostics.checkedPairs,maxPairs),signedVolume,
      issues:diagnostics.issues,flipped:signedVolume<0};
    if(!diagnostics.complete) return {...validity,status:"incomplete",reason:"volume-validation-budget"};
    if(diagnostics.issues.some(i=>["self-intersection","zero-volume"].includes(i.code)))
      return {...validity,status:"not_checked",reason:"volume-self-intersection-or-degeneracy"};
    if(signedVolume<0) mesh.faces.forEach(f=>f.vertices.reverse());
    return {...validity,status:"passed"};
  } catch(error) {return {...base,status:"not_checked",reason:"volume-triangulation-failed",message:error.message};}
}
