import test from "node:test";
import assert from "node:assert/strict";
import {createStore,emptyProject} from "../site/workshop/document.js";
import {openWorkshop} from "../scripts/workshop-node.mjs";
import {createConverter} from "../scripts/fun3d-convert.mjs";
import {toolInvocation} from "../site/workshop/agent-tools.js";

async function fixture(duration=1) {
  const store=createStore(emptyProject());
  store.apply([{op:"create",id:"part",kind:"box"},{op:"create",id:"target",kind:"box",position:[2,0,0]},
    {op:"relation",definition:{id:"spacing",kind:"distance",source:"part",target:"target",vertices:[0],min:0,max:4}},
    {op:"characterClip",name:"move",duration,fps:4,loop:false,tracks:[{node:"part",channel:"position",keys:[{time:0,value:[0,0,0]},{time:duration,value:[.2,0,0]}]}]}]);
  const project=store.snapshot(),session=await openWorkshop({record:{project,revision:0},width:64,height:64});
  const file=await session.api.exportGLB({encoding:"base64"}),converter=createConverter();
  const converted=await converter.convert(Buffer.from(file.data,"base64"),{positionPrecision:"float32"});
  return {project,session,converted,converter};
}

test("runtime inspection API preserves the draft and reports actual checked sample provenance",async()=>{
  const {project,session,converted}=await fixture();
  try {
    const before=session.api.getProject(),revision=session.api.inspect().revision;
    const args={action:"verifyRuntime",ifRevision:revision,query:{data:Buffer.from(converted.bytes).toString("base64"),poses:[{clip:"move",time:.5}]}};
    toolInvocation("fun_editor_workflow",args);
    const r=await session.api.workflow(args);
    assert.equal(r.ok,true);assert.equal(r.status,"passed");assert.equal(r.currentUnchanged,true);
    assert.match(r.provenance.runtimeSha256,/^[a-f0-9]{64}$/);assert.equal(r.samples[0].results[0].status,"passed");
    assert.ok(r.samples[0].meshes.every(m=>m.maximumCopySpread===0));
    assert.deepEqual(session.api.getProject(),before);assert.equal(session.api.inspect().revision,revision);
    const budget=await session.api.workflow({...args,query:{...args.query,mapping:{maxComparisons:1}}});
    assert.equal(budget.status,"incomplete");assert.equal(budget.coverage.runtimeRelations,false);assert.deepEqual(budget.samples,[]);
    const limited=await session.api.workflow({...args,query:{...args.query,maxTests:1}});
    assert.equal(limited.status,"incomplete");assert.equal(limited.coverage.runtimeRelations,false);
    await assert.rejects(session.api.workflow({...args,query:{...args.query,poses:[{clip:"missing",time:0}]}}),/Missing runtime\/source clip/);
    await assert.rejects(session.api.workflow({...args,query:{...args.query,data:"not-base64"}}),/base64/);
    assert.deepEqual(session.api.getProject(),before);
    assert.equal(converted.manifest.asset.source.positionPrecision,"float32");
    const pending=session.api.workflow(args);
    session.api.apply([{op:"transform",id:"target",translation:[0,.1,0]}]);
    const edited=session.api.getProject(),concurrent=await pending;
    assert.equal(concurrent.currentUnchanged,false);assert.equal(concurrent.stale,true);
    assert.deepEqual(session.api.getProject(),edited,"Inspection must not restore over a concurrent edit");
  }finally{session.dispose();}
});

test("runtime sample endpoints account for duration serialization without hiding mismatched clips",async()=>{
  const duration=.12345649,{session,converted}=await fixture(duration);
  try {
    const query={data:Buffer.from(converted.bytes).toString("base64"),poses:[{clip:"move",time:duration}]};
    const r=await session.api.workflow({action:"verifyRuntime",query});
    assert.equal(r.ok,true);assert.ok(Math.abs(r.samples[0].runtimeTime-duration)<1e-6);
    const clip=session.api.getProject().character.clips[0];session.api.apply([{op:"characterClip",...clip,duration:1}]);
    await assert.rejects(session.api.workflow({action:"verifyRuntime",query}),/duration mismatch/);
  }finally{session.dispose();}
});

test("correspondence rejects ambiguous bases, changed triangles and divergent runtime copies",async()=>{
  const {project,session,converted,converter}=await fixture(),model=await converter.fun3d.load(converted.bytes);
  try {
    const {runtimeCorrespondence,runtimePoseProject}=await import("../site/workshop/runtime-inspection.js");
    const ids=["part","target"],mapping=runtimeCorrespondence(project,model.root,ids);
    assert.equal(mapping.complete,true);
    const ambiguous=structuredClone(project);ambiguous.nodes[0].mesh.vertices.push([...ambiguous.nodes[0].mesh.vertices[0]]);
    assert.equal(runtimeCorrespondence(ambiguous,model.root,ids).diagnostics[0].reason,"ambiguous-base-vertex");
    const copy=mapping.records[0].copies.find(c=>c.length>1)[0],attribute=copy.mesh.geometry.attributes.position;
    model.root.updateMatrixWorld(true);
    const value=attribute.getX(copy.index);attribute.setX(copy.index,value+.0001);
    const posed=runtimePoseProject(project,mapping);
    assert.equal(posed.complete,false);assert.equal(posed.diagnostics[0].reason,"runtime-seam-copies-differ");
    attribute.setX(copy.index,value);
    const indices=copy.mesh.geometry.index,first=indices.getX(0),second=indices.getX(1);
    indices.setX(0,second);indices.setX(1,first);
    assert.equal(runtimeCorrespondence(project,model.root,ids).diagnostics[0].reason,"runtime-triangle-mismatch");
  }finally{model.dispose();session.dispose();}
});
