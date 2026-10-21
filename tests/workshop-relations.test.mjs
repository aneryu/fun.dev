import test from "node:test";
import assert from "node:assert/strict";
import { createStore, emptyProject, evaluateProject } from "../site/workshop/document.js";
import { openWorkshop } from "../scripts/workshop-node.mjs";
import { toolInvocation } from "../site/workshop/agent-tools.js";
import { triangulate } from "../site/workshop/mesh.js";
import { Vector3 } from "three";

test("bounded exceptions require the entire contact in source-local space and survive transforms/export",async()=>{
  const store=createStore(emptyProject()),material=store.snapshot().materials[0].id;
  const mesh=vertices=>({vertices,faces:[{id:"f",vertices:[0,1,2],material}]});
  store.apply([{op:"create",kind:"mesh",id:"a",mesh:mesh([[-1,-1,0],[1,-1,0],[0,1,0]])},
    {op:"create",kind:"mesh",id:"b",mesh:mesh([[0,-.5,-1],[0,-.5,1],[0,.5,0]])}]);
  const definition={id:"seam",kind:"surfaceIntersection",source:"a",target:"b",tolerance:1e-8,
    allowed:[{sourceFaces:["f"],targetFaces:["f"],reason:"Joint region",bounds:{min:[-.1,-.1,-.1],max:[.1,.1,.1]}}]};
  assert.ok(toolInvocation("fun_editor_apply",{ifRevision:store.revision,commands:[{op:"relation",definition}]}));
  store.apply([{op:"relation",definition}]);
  const baseline=store.snapshot();assert.equal(baseline.relations[0].version,4);
  assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(baseline))),baseline);
  const old=structuredClone(baseline);old.relations[0].version=2;
  assert.throws(()=>evaluateProject(old),/Bounded intersection exceptions require relation version 4/);
  const invalid=structuredClone(definition);invalid.allowed[0].bounds.min=[1,1,1];
  assert.throws(()=>store.apply([{op:"relation",definition:invalid}]),/min <= max/);
  const session=await openWorkshop({record:{project:baseline,revision:0},width:64,height:64});
  try {
    const report=await session.api.workflow({action:"relations"}),sample=report.results[0].samples[0];
    assert.equal(report.results[0].status,"failed");
    assert.ok(Math.abs(sample.point[1])<1e-12,"The midpoint fits, but the endpoints do not");
    assert.equal(sample.rejectedBounds.length,1);assert.equal(sample.sourceLocalContact.space,"source-local");
    const diagnosis=await session.api.workflow({action:"diagnose",views:[]});
    assert.ok(diagnosis.diagnostics.some(d=>d.rejectedBounds?.length===1 && d.sourceLocalContact.space==="source-local"));
    const wide=structuredClone(definition);wide.allowed[0].bounds={min:[-.1,-.6,-.1],max:[.1,.6,.1]};
    const transformed=await session.api.workflow({action:"prepare",views:[],commands:[
      {op:"relation",definition:wide},{op:"create",kind:"group",id:"frame",position:[1000,-3000,5000],rotation:[17,37,11],scale:[2,3,.5]},
      {op:"set",id:"a",parent:"frame",keepWorld:false},{op:"set",id:"b",parent:"frame",keepWorld:false},
    ]});
    assert.equal(transformed.relations.results[0].status,"passed");
    assert.equal(transformed.relations.results[0].samples[0].exceptionBounds.space,"source-local");
    const exported=await session.api.workflow({action:"verifyExport",candidateId:transformed.candidateId});
    assert.equal(exported.editable.integrity.exact,true);
    assert.deepEqual(session.api.getProject(),baseline);
  } finally {session.dispose();}
});

test("contact geometry retains full crossing segments and coplanar overlap polygons",async()=>{
  const session=await openWorkshop({record:{project:emptyProject(),revision:0},width:64,height:64});
  try {
    const {triangleContact}=await import("../site/workshop/surface-relations.js");
    const points=a=>a.map(p=>new Vector3(...p));
    const a=points([[-1,-1,0],[1,-1,0],[0,1,0]]);
    const crossing=triangleContact(a,points([[0,-.5,-1],[0,-.5,1],[0,.5,0]]),1e-8);
    assert.equal(crossing.kind,"crossing");
    const ends=crossing.geometry.points.sort((a,b)=>a[1]-b[1]);
    for(let i=0;i<2;i++) assert.ok(new Vector3(...ends[i]).distanceTo(new Vector3(0,i-.5,0))<1e-12);
    const inner=[[0,0,0],[-.25,-.5,0],[.25,-.5,0]],overlap=triangleContact(a,points(inner),1e-8);
    assert.equal(overlap.kind,"coplanar-overlap");
    for(const p of inner) assert.ok(overlap.geometry.points.some(q=>new Vector3(...q).distanceTo(new Vector3(...p))<1e-12));
    assert.equal(overlap.geometry.points.length,3);
  } finally {session.dispose();}
});

test("derived inspection volumes follow target deformation, persist caps and reject invalid enclosures",async()=>{
  const store=createStore(emptyProject());
  store.apply([{op:"create",kind:"box",id:"lining"},{op:"create",kind:"box",id:"part",options:{size:[.1,.1,.1]}}]);
  const target=store.snapshot().nodes.find(n=>n.id==="lining"),cap=target.mesh.faces.at(-1);
  const definition={id:"enclosure",kind:"insideVolume",source:"part",target:"lining",vertices:[0,1,2,3,4,5,6,7],min:0,max:2,
    volume:{faces:target.mesh.faces.filter(f=>f!==cap).map(f=>f.id),caps:triangulate(target.mesh.vertices,cap.vertices)}};
  assert.ok(toolInvocation("fun_editor_apply",{ifRevision:store.revision,commands:[{op:"relation",definition}]}));
  store.apply([{op:"relation",definition}]);
  const baseline=store.snapshot();
  assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(baseline))),baseline);
  assert.throws(()=>store.apply([{op:"triangulate",id:"lining"}]),/unchanged target topology/);
  const session=await openWorkshop({record:{project:baseline,revision:0},width:64,height:64});
  try {
    const inside=await session.api.workflow({action:"relations"});
    assert.equal(inside.results[0].status,"passed");
    assert.equal(inside.results[0].volume.status,"passed");
    assert.equal(inside.results[0].volume.space,"target-local");
    assert.equal(inside.results[0].boundary.status,"passed");
    assert.equal(inside.results[0].coverage.wholeMeshContained,true);
    const seeded=await session.api.workflow({action:"prepare",views:[],commands:[{op:"relation",definition:{...definition,vertices:[0]}}]});
    assert.equal(seeded.relations.results[0].coverage.wholeMeshContained,true);
    const material=baseline.materials[0].id;
    const disconnected=await session.api.workflow({action:"prepare",views:[],commands:[
      {op:"create",id:"parts",kind:"mesh",mesh:{vertices:[[0,0,0],[.1,0,0],[0,.1,0],[2,0,0],[2.1,0,0],[2,.1,0]],
        faces:[{id:"a",vertices:[0,1,2],material},{id:"b",vertices:[3,4,5],material}]}},
      {op:"relation",definition:{...definition,id:"partial",source:"parts",vertices:[0]}},
    ]});
    const partial=disconnected.relations.results.find(r=>r.id==="partial");
    assert.equal(partial.status,"not_checked");assert.equal(partial.reason,"unsampled-source-components");
    assert.equal(partial.coverage.sourceComponents,2);assert.equal(partial.coverage.sampledSourceComponents,1);
    assert.deepEqual(partial.coverage.uncoveredSeedVertices,[3]);
    const outside=await session.api.workflow({action:"prepare",views:[],commands:[{op:"set",id:"part",position:[.6,0,0]}]});
    assert.equal(outside.relations.results[0].status,"failed");
    const expanded=await session.api.workflow({action:"prepare",views:[],commands:[
      {op:"set",id:"part",position:[.6,0,0]},
      {op:"morphTarget",id:"lining",name:"wide",changes:target.mesh.vertices.map((p,index)=>({index,position:[p[0]*2,p[1],p[2]]}))},
      {op:"morphWeights",id:"lining",values:{wide:1}},
    ]});
    assert.equal(expanded.relations.results[0].status,"passed");
    const invalid=structuredClone(definition);invalid.volume.caps[0].reverse();
    const broken=await session.api.workflow({action:"prepare",views:[],commands:[{op:"relation",definition:invalid}]});
    assert.equal(broken.relations.results[0].status,"not_checked");
    assert.equal(broken.relations.results[0].reason,"volume-not-closed-oriented");
    const limited=await session.api.workflow({action:"relations",query:{maxTests:1}});
    assert.equal(limited.results[0].status,"incomplete");
    const preview=await session.api.workflow({action:"inspect",views:["perspective"],size:64,
      query:{showVolumes:true},render:{ids:["part"]}});
    assert.equal(preview.renderError,undefined);assert.equal(preview.observations.length,1);
    assert.deepEqual(session.api.getProject(),baseline);
    const exported=await session.api.workflow({action:"verifyExport"});
    assert.equal(exported.editable.integrity.exact,true);
  } finally {session.dispose();}
});

test("whole declared mesh pairs detect crossings, persist design exceptions and locate failures", async () => {
  const store=createStore(emptyProject());
  store.apply([{op:"create",kind:"box",id:"a"},{op:"create",kind:"box",id:"b",position:[.4,.3,.2]}]);
  const definition={id:"separation",kind:"surfaceIntersection",source:"a",target:"b",tolerance:1e-6};
  assert.ok(toolInvocation("fun_editor_apply",{ifRevision:store.revision,commands:[{op:"relation",definition}]}));
  store.apply([{op:"relation",definition}]);
  const baseline=store.snapshot();
  assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(baseline))),baseline);
  assert.throws(()=>store.apply([{op:"triangulate",id:"b"}]),/target topology changed/);
  const session=await openWorkshop({record:{project:baseline,revision:0},width:64,height:64});
  try {
    const report=await session.api.workflow({action:"relations"}), result=report.results[0];
    assert.equal(result.status,"failed"); assert.ok(result.samples.some(s=>s.kind==="crossing"));
    assert.ok(result.samples.filter(s=>s.kind==="crossing").every(s=>
      s.contactGeometry.kind==="segment" && s.contactGeometry.points.length===2));
    assert.equal(result.completedPairs,result.requestedPairs);
    assert.equal(report.coverage.declaredMeshPairIntersections,true);
    assert.equal(report.coverage.interObjectIntersection,false);
    assert.equal(report.coverage.containment,false);
    const diagnostic=await session.api.workflow({action:"diagnose",views:[],query:{ids:[]}});
    assert.ok(diagnostic.diagnostics.some(d=>d.relation==="separation" && d.face && d.targetFace && d.worldPoint));
    assert.ok(diagnostic.diagnostics.some(d=>d.contactGeometry?.space==="world"));
    const limited=await session.api.workflow({action:"relations",query:{maxTests:1}});
    assert.equal(limited.results[0].status,"incomplete"); assert.equal(limited.ok,false);
    assert.equal(limited.coverage.declaredMeshPairIntersections,false);
    const transformed=await session.api.workflow({action:"prepare",views:[],commands:[
      {op:"create",kind:"group",id:"frame",position:[1000,-3000,5000],rotation:[17,37,11],scale:[2,2,2]},
      {op:"set",id:"a",parent:"frame",keepWorld:false},{op:"set",id:"b",parent:"frame",keepWorld:false},
    ]});
    assert.equal(transformed.relations.results[0].status,"failed");
    assert.equal(transformed.relations.results[0].samples.length,result.samples.length);
    assert.ok(transformed.relations.results[0].samples.every(s=>s.point.every(Number.isFinite)));
    assert.ok(transformed.relations.results[0].samples.some(s=>s.point[0]>900));
    const pairs=[...new Map(result.samples.map(s=>[`${s.face}:${s.target.face}`,{
      sourceFaces:[s.face],targetFaces:[s.target.face],reason:"Explicit interlocking test parts",
    }])).values()];
    const candidate=await session.api.workflow({action:"prepare",views:[],commands:[{op:"relation",
      definition:{...definition,allowed:pairs}}]});
    assert.equal(candidate.relations.results[0].status,"passed");
    assert.ok(candidate.relations.results[0].allowedIntersections>0);
    assert.deepEqual(session.api.getProject(),baseline);
    store.apply([{op:"relation",definition:{...definition,allowed:pairs}},{op:"rename",id:"b",newId:"part_b"}]);
    assert.equal(store.snapshot().relations[0].target,"part_b");
    assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(store.snapshot()))),store.snapshot());
  } finally {session.dispose();}
});

test("surface intersection distinguishes contact, coplanar overlap and containment limits",async()=>{
  const store=createStore(emptyProject());
  store.apply([{op:"create",kind:"box",id:"a"},{op:"create",kind:"box",id:"b",position:[1,1,1]},
    {op:"relation",definition:{id:"pair",kind:"surfaceIntersection",source:"a",target:"b",tolerance:1e-6,touching:"allow"}}]);
  const session=await openWorkshop({record:{project:store.snapshot(),revision:0},width:64,height:64});
  try {
    const touching=await session.api.workflow({action:"relations"});
    assert.equal(touching.results[0].status,"passed");
    assert.ok(touching.results[0].samples.some(s=>s.kind==="touch"));
    const overlap=await session.api.workflow({action:"prepare",views:[],commands:[{op:"set",id:"b",position:[1,0,0]}]});
    assert.equal(overlap.relations.results[0].status,"failed");
    assert.ok(overlap.relations.results[0].samples.some(s=>s.kind==="coplanar-overlap"));
    const nested=await session.api.workflow({action:"prepare",views:[],commands:[{op:"set",id:"b",position:[0,0,0],scale:[.1,.1,.1]}]});
    assert.equal(nested.relations.results[0].status,"passed");
    assert.equal(nested.relations.coverage.containment,false);
  } finally {session.dispose();}
});

test("persistent sampled relations gate candidates, locate failures and report incomplete budgets", async () => {
  const s = createStore(emptyProject());
  s.apply([{ op: "create", kind: "box", id: "shell" },
    { op: "create", kind: "box", id: "eye", options: { size: [.1, .1, .1] }, position: [0, 0, .53] }]);
  s.apply([{ op: "relation", definition: { id: "contact", kind: "signedGap", source: "eye", target: "shell",
    vertices: [0, 1, 2, 3, 4, 5, 6, 7], min: -.03, max: .09 } }]);
  const baseline = s.snapshot();
  assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(baseline))), baseline);
  assert.throws(() => s.apply([{ op: "triangulate", id: "eye" }]), /topology changed/);
  const session = await openWorkshop({ record: { project: baseline, revision: 0 }, width: 64, height: 64 });
  try {
    const checked = await session.api.workflow({ action: "relations" });
    assert.equal(checked.results[0].status, "passed");
    assert.equal(checked.coverage.interObjectIntersection, false);
    const limited = await session.api.workflow({ action: "relations", query: { maxTests: 1 } });
    assert.equal(limited.results[0].status, "incomplete");
    assert.equal(limited.ok, false);
    const candidate = await session.api.workflow({ action: "prepare",
      commands: [{ op: "set", id: "eye", position: [0, 0, 1] }], views: [] });
    assert.equal(candidate.ok, false);
    assert.equal(candidate.relations.results[0].status, "failed");
    assert.ok(candidate.diagnostics.some(d => d.code === "relation" && d.worldPoint && d.threshold));
    assert.deepEqual(session.api.getProject(), baseline);
    const bad = await session.api.workflow({ action: "prepare", views: [],
      commands: [{ op: "relation", definition: { id: "contact", kind: "signedGap", source: "eye", target: "shell",
        vertices: [0, 1, 2, 3, 4, 5, 6, 7], min: .2, max: .3 } }] });
    const cleared = await session.api.workflow({ action: "prepare", views: [], commands: [{ op: "removeRelation", id: "contact" }] });
    const first = await session.api.workflow({ action: "inspect", candidateId: bad.candidateId, views: ["front"], size: 64 });
    const second = await session.api.workflow({ action: "inspect", candidateId: cleared.candidateId, views: ["front"], size: 64 });
    assert.equal(first.observations[0].dataUrl, second.observations[0].dataUrl,
      "Failed relation must not silently add wire overlays or change framing in a comparison");
  } finally { session.dispose(); }
});
test("directional wall samples hit opposite faces without counting the originating surface", async () => {
  const s = createStore(emptyProject());
  s.apply([{ op: "create", kind: "box", id: "wall" }]);
  const vertices = s.snapshot().nodes[0].mesh.vertices.flatMap((p, i) => p[1] > 0 ? [i] : []);
  s.apply([{ op: "relation", definition: { id: "wall_thickness", kind: "thickness",
    source: "wall", target: "wall", vertices, direction: [0, -1, 0], min: .99, max: 1.01 } }]);
  const session = await openWorkshop({ record: { project: s.snapshot(), revision: 0 }, width: 64, height: 64 });
  try {
    const check = await session.api.workflow({ action: "relations" });
    assert.equal(check.results[0].status, "passed");
    assert.ok(check.results[0].samples.every(s => Math.abs(s.actual - 1) < 1e-8));
    const roundtrip = await session.api.workflow({ action: "verifyExport" });
    assert.deepEqual(roundtrip.editable.scope.changed, []);
  } finally { session.dispose(); }
});
test("closed-shell containment distinguishes interior samples from exterior points", async () => {
  const s = createStore(emptyProject());
  s.apply([{ op: "create", kind: "box", id: "envelope" },
    { op: "create", kind: "box", id: "tongue", options: { size: [.1, .1, .1] } },
    { op: "relation", definition: { id: "contained", kind: "inside", source: "tongue", target: "envelope",
      vertices: [0, 1, 2, 3, 4, 5, 6, 7], min: .01, max: .5 } }]);
  const session = await openWorkshop({ record: { project: s.snapshot(), revision: 0 }, width: 64, height: 64 });
  try {
    const inside = await session.api.workflow({ action: "relations" });
    assert.equal(inside.results[0].status, "passed");
    assert.equal(inside.coverage.sampledContainment, true);
    assert.equal(inside.coverage.containment, false);
    const outside = await session.api.workflow({ action: "prepare", views: [],
      commands: [{ op: "set", id: "tongue", position: [0, 0, .7] }] });
    assert.equal(outside.ok, false);
    assert.ok(outside.relations.results[0].samples.every(s => s.actual < 0));
  } finally { session.dispose(); }
  const open = s.snapshot(), envelope = open.nodes.find(n => n.id === "envelope");
  delete envelope.generator; envelope.mesh.faces.pop();
  const unsupported = await openWorkshop({ record: { project: open, revision: 0 }, width: 64, height: 64 });
  try {
    const result = await unsupported.api.workflow({ action: "relations" });
    assert.equal(result.results[0].status, "not_checked");
    assert.equal(result.results[0].reason, "target-not-closed-oriented-shell");
  } finally { unsupported.dispose(); }
});
