import { Vector3, Triangle } from "/runtime/three.js";
import { triangulate } from "./mesh.js";
import { worldMatrix, point, inverse } from "./spatial.js";

function section(vertices, origin, normal, epsilon) {
  const distances = vertices.map(p => p.clone().sub(origin).dot(normal)), points = [];
  for (let i=0;i<3;i++) {
    const j=(i+1)%3, a=distances[i], b=distances[j];
    if (Math.abs(a)<=epsilon) points.push(vertices[i].clone());
    if (a*b<0) points.push(vertices[i].clone().lerp(vertices[j],a/(a-b)));
  }
  return {points, interior:distances.some(d=>d>epsilon) && distances.some(d=>d<-epsilon)};
}
function coplanar(a,b,normal,epsilon) {
  const axis=normal.toArray().map(Math.abs).indexOf(Math.max(...normal.toArray().map(Math.abs)));
  const project = p=>p.clone().sub(a[0]).toArray().filter((_,i)=>i!==axis);
  const clip=b.map(project);
  const area=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
  const sign=Math.sign(area(...clip)); if (!sign) return {kind:"ambiguous",point:a[0].toArray()};
  let polygon=a.map(p=>({p:p.clone(),uv:project(p)}));
  for(let i=0;i<3 && polygon.length;i++) {
    const p=clip[i],q=clip[(i+1)%3], length=Math.hypot(q[0]-p[0],q[1]-p[1]);
    if (!length) return {kind:"ambiguous",point:a[0].toArray()};
    const distance=v=>sign*area(p,q,v.uv)/length, next=[];
    for(let j=0;j<polygon.length;j++) {
      const s=polygon[j],e=polygon[(j+1)%polygon.length],ds=distance(s),de=distance(e);
      if(ds>=-epsilon) next.push(s);
      if((ds>=-epsilon)!==(de>=-epsilon)) {
        const t=Math.max(0,Math.min(1,ds/(ds-de))), v=s.p.clone().lerp(e.p,t);
        next.push({p:v,uv:project(v)});
      }
    }
    polygon=next;
  }
  if(!polygon.length) return null;
  const p=polygon.map(v=>v.uv), doubled=Math.abs(p.reduce((s,v,i)=>
    s+v[0]*p[(i+1)%p.length][1]-v[1]*p[(i+1)%p.length][0],0));
  return {kind:doubled>2*epsilon*epsilon ? "coplanar-overlap":"touch",
    geometry:{kind:"polygon",points:polygon.map(v=>v.p.toArray())},
    point:polygon.reduce((s,v)=>s.add(v.p),new Vector3()).divideScalar(polygon.length).toArray()};
}
// Includes boundaries. A declared touch policy decides whether a boundary-only
// intersection is acceptable; a pass never implies volumetric containment.
export function triangleContact(a,b,epsilon) {
  const n=new Triangle(...a).getNormal(new Vector3()), m=new Triangle(...b).getNormal(new Vector3());
  if(!n.lengthSq() || !m.lengthSq()) return {kind:"ambiguous",point:a[0].toArray()};
  const line=n.clone().cross(m), length=line.length();
  if(length<1e-10) {
    if(b.some(p=>Math.abs(p.clone().sub(a[0]).dot(n))>epsilon)) return null;
    return coplanar(a,b,n,epsilon);
  }
  line.divideScalar(length);
  const first=section(a,b[0],m,epsilon), second=section(b,a[0],n,epsilon);
  if(!first.points.length || !second.points.length) return null;
  const origin=a[0], value=p=>p.clone().sub(origin).dot(line);
  const x=first.points.map(value),y=second.points.map(value);
  const low=Math.max(Math.min(...x),Math.min(...y)), high=Math.min(Math.max(...x),Math.max(...y));
  if(high<low-epsilon) return null;
  const p=first.points[0].clone().addScaledVector(line,(low+high)/2-value(first.points[0]));
  const half=Math.max(0,(high-low)/2);
  return {kind:high-low>epsilon && first.interior && second.interior ? "crossing":"touch",point:p.toArray(),
    geometry:half ? {kind:"segment",points:[p.clone().addScaledVector(line,-half).toArray(),
      p.clone().addScaledVector(line,half).toArray()]} : {kind:"point",points:[p.toArray()]}};
}
export function checkSurfaceRelation(project, relation, consume, maxIssues=1000) {
  const triangles=id=>{
    const node=project.nodes.find(n=>n.id===id), transform=worldMatrix(project,id);
    const vertices=node.mesh.vertices.map(v=>new Vector3(...point(transform,v)));
    return node.mesh.faces.flatMap(f=>triangulate(node.mesh.vertices,f.vertices).map(indices=>{
      const p=indices.map(i=>vertices[i]);
      return {face:f.id,indices,p,min:[0,1,2].map(k=>Math.min(...p.map(v=>v.getComponent(k)))),
        max:[0,1,2].map(k=>Math.max(...p.map(v=>v.getComponent(k))))};
    }));
  };
  const source=triangles(relation.source),target=triangles(relation.target),samples=[];
  const toSource=relation.allowed.some(rule=>rule.bounds)?inverse(worldMatrix(project,relation.source)):null;
  const localTolerance=toSource?[0,1,2].map(k=>relation.tolerance*Math.hypot(toSource[k],toSource[k+4],toSource[k+8])):null;
  let completedPairs=0, allowed=0, exhausted=false, reason;
  outer:for(const a of source) for(const b of target) {
    if(!consume()) {exhausted=true;reason="triangle-test-budget";break outer;}
    completedPairs++;
    if([0,1,2].some(k=>a.max[k]<b.min[k]-relation.tolerance || b.max[k]<a.min[k]-relation.tolerance)) continue;
    const contact=triangleContact(a.p,b.p,relation.tolerance);
    if(!contact) continue;
    const matching=relation.allowed.map((rule,index)=>({rule,index})).filter(({rule})=>
      rule.sourceFaces.includes(a.face) && rule.targetFaces.includes(b.face));
    const localPoints=toSource && contact.geometry?.points.map(p=>point(toSource,p));
    const within=({rule})=>!rule.bounds || (localPoints?.length && localPoints.every(p=>p.every((v,k)=>
      v>=rule.bounds.min[k]-localTolerance[k] && v<=rule.bounds.max[k]+localTolerance[k])));
    const selected=matching.find(within),exception=selected?.rule;
    const rejected=matching.filter(entry=>!within(entry)).map(({rule,index})=>({index,bounds:rule.bounds}));
    const accepted=contact.kind!=="ambiguous" && (exception || (contact.kind==="touch" && relation.touching==="allow"));
    if(accepted) allowed++;
    samples.push({status:contact.kind==="ambiguous" ? "not_checked":accepted?"allowed":"failed",
      kind:contact.kind,point:contact.point,face:a.face,vertices:a.indices,
      ...(contact.geometry?{contactGeometry:{...contact.geometry,space:"world",units:"metres"}}:{}),
      ...(selected?{exceptionIndex:selected.index,...(exception.bounds?{exceptionBounds:{...exception.bounds,space:"source-local",units:"metres"}}:{})}:{}),
      ...(rejected.length?{rejectedBounds:rejected,sourceLocalContact:{points:localPoints??[],space:"source-local",units:"metres"}}:{}),
      target:{face:b.face,vertices:b.indices},actual:1,...(exception?{reason:exception.reason}:{})});
    if(samples.length>=maxIssues) {exhausted=true;reason="contact-report-budget";break outer;}
  }
  return {id:relation.id,kind:relation.kind,source:relation.source,target:relation.target,
    description:relation.description,space:"world",units:"count",positionUnits:"metres",numericalToleranceUnits:"metres",
    threshold:{maxUnapprovedIntersections:0},numericalTolerance:relation.tolerance,
    status:exhausted?"incomplete":samples.some(s=>s.status==="failed")?"failed":
      samples.some(s=>s.status==="not_checked")?"not_checked":"passed",
    retryable:exhausted && reason==="triangle-test-budget",
    samples,allowedIntersections:allowed,requestedPairs:source.length*target.length,completedPairs,
    coverage:{declaredMeshPairSurfaceIntersection:!exhausted && !samples.some(s=>s.status==="not_checked"),containment:false,continuousAnimation:false},
    ...(reason?{reason}:samples.some(s=>s.status==="not_checked")?{reason:"ambiguous-triangle-contact"}:{})};
}
