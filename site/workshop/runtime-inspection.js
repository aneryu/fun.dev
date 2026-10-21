// Read-only inspection of the actual decompressed, posed runtime geometry.
import * as THREE from "/runtime/three.js";
import { MeshoptDecoder } from "/runtime/addons/MeshoptDecoder.js";
import { createFun3d } from "../runtime/kit/fun3d.js";
import { evaluateProject } from "./document.js";
import { triangulate, ModelError } from "./mesh.js";
import { worldMatrix, inverse, point } from "./spatial.js";
import { connectivityToken } from "./components.js";
import { checkRelations } from "./relation-checks.js";

const key = ids => [...ids].sort((a,b)=>a-b).join(":");
const cyclic = (a,b) => a.some((_,i)=>a.every((v,j)=>v===b[(j+i)%3]));
const compactRelation = r => {
  const {samples=[],volume,boundary,...rest}=r;
  const failed=samples.filter(s=>s.status!=="passed");
  const counts=samples.reduce((all,s)=>(all[s.status]=(all[s.status]??0)+1,all),{});
  const volumeSummary=volume&&Object.fromEntries(Object.entries(volume).filter(([key])=>key!=="mesh"));
  return {...rest,sampleCounts:counts,samples:failed.slice(0,50),diagnosticsTruncated:failed.length>50,
    ...(volume?{volume:{...volumeSummary,meshOmitted:true}}:{}),
    ...(boundary?{boundary:compactRelation(boundary)}:{})};
};

export function runtimeCorrespondence(project, root, ids, { maxError=.001, maxComparisons=5000000 }={}) {
  if(!Number.isFinite(maxError)||maxError<=0||maxError>.01||!Number.isInteger(maxComparisons)||maxComparisons<1||maxComparisons>5000000)
    throw new ModelError("Runtime mapping needs maxError in (0,0.01] metres and maxComparisons 1–5000000", "schema", "query.mapping");
  const nodes=new Map(project.nodes.filter(n=>ids.includes(n.id)).map(n=>[n.id,n]));
  const groups=new Map([...nodes.keys()].map(id=>[id,[]]));
  root.traverse(mesh=>{
    if(!mesh.isMesh)return;
    let owner=mesh;while(owner&&!nodes.has(owner.name))owner=owner.parent;
    if(owner)groups.get(owner.name).push(mesh);
  });
  let comparisons=0;const records=[],diagnostics=ids.filter(id=>!nodes.has(id)).map(node=>({node,status:"not_checked",reason:"missing-source-node"}));
  for(const [id,n] of nodes) {
    const base=n.morph?.base??n.skin?.base??n.mesh?.vertices;
    const fail=(reason,details={})=>diagnostics.push({node:id,status:reason==="mapping-budget"?"incomplete":"not_checked",reason,...details});
    if(!base||!groups.get(id).length){fail("missing-runtime-mesh");continue;}
    const expected=new Map();
    for(const f of n.mesh.faces)for(const indices of triangulate(base,f.vertices)) {
      const k=key(indices);if(expected.has(k)){fail("ambiguous-source-triangle",{face:f.id});break;}
      expected.set(k,{face:f,indices});
    }
    const copies=base.map(()=>[]),faces=[],faceMap=new Map(n.mesh.faces.map(f=>[f.id,[]])),seen=new Set();
    let maximumBaseError=0,problem=false;
    for(const mesh of groups.get(id)) {
      const attribute=mesh.geometry.getAttribute("position"),decode=mesh.geometry.userData.fun3d?.dequantize,map=[];
      for(let i=0;i<attribute.count;i++) {
        const p=[0,1,2].map(k=>decode?decode.offset[k]+attribute.getComponent(i,k)*decode.scale:attribute.getComponent(i,k));
        let found=-1,error=Infinity,eligible=0;
        for(let j=0;j<base.length;j++) {
          if(++comparisons>maxComparisons){fail("mapping-budget",{maxComparisons});problem=true;break;}
          const distance=Math.hypot(...p.map((v,k)=>v-base[j][k]));
          if(distance<=maxError){eligible++;if(distance<error){found=j;error=distance;}}
        }
        if(problem)break;
        if(eligible!==1){fail(eligible?"ambiguous-base-vertex":"unmatched-base-vertex",{mesh:mesh.name,vertex:i,point:p,space:"mesh-local",units:"metres",maxError,eligible});problem=true;break;}
        map.push(found);copies[found].push({mesh,index:i});maximumBaseError=Math.max(maximumBaseError,error);
      }
      if(problem)break;
      const index=mesh.geometry.index,count=index?.count??attribute.count;
      for(let i=0;i<count;i+=3) {
        const indices=[0,1,2].map(j=>map[index?index.getX(i+j):i+j]),k=key(indices),match=expected.get(k);
        if(!match||seen.has(k)||!cyclic(indices,match.indices)) {
          fail("runtime-triangle-mismatch",{mesh:mesh.name,triangle:i/3,vertices:indices,duplicate:seen.has(k)});problem=true;break;
        }
        seen.add(k);const faceId=`${match.face.id}/runtime-${faceMap.get(match.face.id).length}`;
        faces.push({...match.face,id:faceId,vertices:indices});faceMap.get(match.face.id).push(faceId);
      }
      if(problem)break;
    }
    if(problem)continue;
    if(seen.size!==expected.size){fail("missing-runtime-triangles",{expected:expected.size,actual:seen.size});continue;}
    if(copies.some(c=>!c.length)){fail("unmapped-source-vertices",{vertices:copies.flatMap((c,i)=>c.length?[]:[i])});continue;}
    records.push({id,copies,faces,faceMap,maximumBaseError});
  }
  return {records,diagnostics,comparisons,complete:!diagnostics.length&&records.length===ids.length};
}

export function runtimePoseProject(expected, mapping) {
  const project=structuredClone(expected),diagnostics=[],summaries=[];
  for(const node of project.nodes) {
    const object=mapping.frames?.get(node.id);if(!object)continue;
    node.position=object.position.toArray();node.scale=object.scale.toArray();
    node.rotation=new THREE.Euler().setFromQuaternion(object.quaternion,"XYZ").toArray().slice(0,3).map(THREE.MathUtils.radToDeg);
  }
  for(const r of mapping.records) {
    const node=project.nodes.find(n=>n.id===r.id),matrix=inverse(worldMatrix(project,r.id));
    const vertices=[];let maximumCopySpread=0;
    for(const copies of r.copies) {
      const points=copies.map(({mesh,index})=>{
        mesh.skeleton?.update();const p=mesh.getVertexPosition(index,new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
        return point(matrix,p.toArray());
      });
      const first=points[0];vertices.push(first);
      for(const p of points)maximumCopySpread=Math.max(maximumCopySpread,Math.hypot(...p.map((v,k)=>v-first[k])));
    }
    // Never weld differing runtime copies to make an inspection volume look closed.
    if(maximumCopySpread!==0)diagnostics.push({node:r.id,status:"not_checked",reason:"runtime-seam-copies-differ",maximumCopySpread,units:"metres"});
    node.mesh={vertices,faces:structuredClone(r.faces)};
    summaries.push({node:r.id,vertices:vertices.length,triangles:r.faces.length,maximumBaseError:r.maximumBaseError,maximumCopySpread});
  }
  const maps=new Map(mapping.records.map(r=>[r.id,r.faceMap]));
  const expand=(id,faces)=>faces.flatMap(f=>maps.get(id)?.get(f)??[]);
  project.relations=project.relations.map(r=>({...r,
    connectivity:connectivityToken(project.nodes.find(n=>n.id===r.source).mesh),
    ...(r.targetConnectivity?{targetConnectivity:connectivityToken(project.nodes.find(n=>n.id===r.target).mesh)}:{}),
    ...(r.allowed?{allowed:r.allowed.map(a=>({...a,sourceFaces:expand(r.source,a.sourceFaces),targetFaces:expand(r.target,a.targetFaces)}))}:{}),
    ...(r.volume?{volume:{...r.volume,faces:expand(r.target,r.volume.faces)}}:{}),
  }));
  return {project,diagnostics,summaries,complete:!diagnostics.length};
}

export async function inspectRuntimeRelations(project, bytes, { poses, relationIds, mapping:options, maxTests, detail="summary" }={}) {
  if(!["summary","full"].includes(detail))throw new ModelError("detail must be summary or full","schema","detail");
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>32*1024*1024)
    throw new ModelError("Runtime inspection needs up to 32 MiB of fun3d bytes", "schema", "query.data");
  if(!Array.isArray(poses)||!poses.length||poses.length>64||poses.some(p=>typeof p.clip!=="string"||!Number.isFinite(p.time)||p.time<0))
    throw new ModelError("Provide 1–64 explicit {clip,time} samples; time is nonnegative seconds", "schema", "query.poses");
  if(maxTests!==undefined&&(!Number.isInteger(maxTests)||maxTests<1||maxTests>2000000))
    throw new ModelError("maxTests must be 1–2000000 per pose", "schema", "query.maxTests");
  if(relationIds!==undefined&&(!Array.isArray(relationIds)||!relationIds.length||new Set(relationIds).size!==relationIds.length||relationIds.some(id=>!project.relations?.some(r=>r.id===id))))
    throw new ModelError("Choose unique existing relation ids", "schema", "query.relationIds");
  const source=structuredClone(project);source.relations=(source.relations??[]).filter(r=>!relationIds||relationIds.includes(r.id));
  if(!source.relations.length)throw new ModelError("No design relations selected", "schema", "query.relationIds");
  const ids=[...new Set(source.relations.flatMap(r=>[r.source,r.target]))];
  const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");
  const provenance={runtimeSha256:await hash(bytes),sourceSha256:await hash(new TextEncoder().encode(JSON.stringify(project))),
    runtimeBytes:bytes.byteLength,sourceEncoding:"JSON.stringify(evaluated project snapshot)",runtimeEncoding:"raw fun3d bytes"};
  const fun3d=createFun3d({THREE,decoder:MeshoptDecoder}),model=await fun3d.load(bytes),mixer=new THREE.AnimationMixer(model.root);
  try {
    const mapping=runtimeCorrespondence(source,model.root,ids,options);
    if(!mapping.complete)return {version:1,ok:false,status:mapping.diagnostics.some(d=>d.status==="incomplete")?"incomplete":"not_checked",provenance,mapping:{complete:false,comparisons:mapping.comparisons,diagnostics:mapping.diagnostics},samples:[],coverage:{runtimeRelations:false}};
    mapping.frames=new Map([...model.nodes.values()].map(o=>[o.name,o]));
    const samples=[];
    for(const pose of poses) {
      const clip=model.animations.find(c=>c.name===pose.clip);
      const sourceClip=source.character?.clips.find(c=>c.name===pose.clip);
      if(!clip||!sourceClip)throw new ModelError(`Missing runtime/source clip ${pose.clip}`,"not_found","query.poses");
      const timeTolerance=1e-6+sourceClip.duration*2e-7;
      if(Math.abs(clip.duration-sourceClip.duration)>timeTolerance)throw new ModelError(`Runtime/source clip duration mismatch for ${pose.clip}`,"conflict","query.poses");
      if(pose.time>clip.duration+timeTolerance)throw new ModelError(`Sample time exceeds clip ${pose.clip} duration ${clip.duration}`,"schema","query.poses");
      const runtimeTime=Math.min(pose.time,clip.duration);
      mixer.stopAllAction();const action=mixer.clipAction(clip).reset().play();action.time=runtimeTime;mixer.update(0);model.root.updateMatrixWorld(true);
      const input=structuredClone(source);input.character.pose={clip:pose.clip,time:Math.min(pose.time,sourceClip.duration)};
      const snapshot=runtimePoseProject(evaluateProject(input),mapping);
      if(!snapshot.complete){samples.push({...pose,runtimeTime,ok:false,status:"not_checked",diagnostics:snapshot.diagnostics,meshes:snapshot.summaries});continue;}
      const report=checkRelations(snapshot.project,{...(maxTests===undefined?{}:{maxTests})});
      samples.push({...pose,runtimeTime,...report,results:detail==="full"?report.results:report.results.map(compactRelation),meshes:snapshot.summaries});
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    const statuses=samples.flatMap(s=>s.status?[s.status]:s.results.map(r=>r.status));
    const status=["failed","incomplete","not_checked"].find(s=>statuses.includes(s))??"passed";
    return {version:1,ok:status==="passed",status,detail,provenance,mapping:{complete:true,comparisons:mapping.comparisons},samples,
      coverage:{runtimeRelations:!statuses.some(s=>s==="not_checked"||s==="incomplete"),relationIds:source.relations.map(r=>r.id),continuousMotion:false,undeclaredPairs:false,animationParity:false},
      interpretation:"Actual posed runtime vertices and triangles, with exact agreement of split vertex copies. Correspondence is established once from unique base positions and matching oriented triangles. No source geometry substitutes for runtime positions; no averaging or tolerance welding."};
  }finally{mixer.stopAllAction();mixer.uncacheRoot(model.root);model.dispose();}
}
