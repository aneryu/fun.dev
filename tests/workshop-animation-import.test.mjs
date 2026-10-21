import test from "node:test";
import assert from "node:assert/strict";
import { Quaternion, Euler, MathUtils } from "three";
import { importAnimations } from "../site/workshop/import-animation.js";
import { rotationQuaternion, quaternionRotation, slerpRotation } from "../site/workshop/rotation-keys.js";
import { sampleKeys } from "../site/workshop/character.js";
import { createStore, emptyProject, evaluateProject } from "../site/workshop/document.js";
import { toolInvocation } from "../site/workshop/agent-tools.js";

const quat = v => new Quaternion().setFromEuler(new Euler(...v.map(MathUtils.degToRad)));
test("spherical rotation matches quaternion interpolation across wrap and gimbal poses", () => {
  const zero = quaternionRotation([0,0,0,1]);
  assert.deepEqual(JSON.parse(JSON.stringify(zero)), zero, "signed zero must survive JSON as canonical zero");
  for (const [a, b] of [[[0, 170, 0], [0, -170, 0]], [[35, 89.999, 80], [-80, 100, 35]], [[0,90,50], [30,-90,-10]], [[20,40,60],[70,30,10]]]) {
    assert.ok(Math.abs(quat(a).dot(new Quaternion(...rotationQuaternion(a)))) > 1-1e-12);
    assert.ok(Math.abs(quat(a).dot(quat(quaternionRotation(quat(a).toArray())))) > 1-1e-12);
    for (const t of [0, .1, .33, .5, .9, 1])
      assert.ok(Math.abs(quat(slerpRotation(a,b,t)).dot(quat(a).slerp(quat(b), t))) > 1-1e-10);
  }
});
function fixture() {
  const store = createStore(emptyProject());
  store.apply([{ op: "create", kind: "group", id: "joint" }, { op: "joint", id: "joint" }]);
  const node = store.snapshot().nodes.find(n => n.id === "joint");
  return { store, nodes: new Map([[0, node]]),
    values: [[0,1], [...quat([0,170,0]).toArray(), ...quat([0,-170,0]).toArray()], [0,0,0, 1,2,3]],
    json: { accessors: [{type:"SCALAR", componentType:5126,count:2}, {type:"VEC4",componentType:5126,count:2}, {type:"VEC3",componentType:5126,count:2}],
      animations: [{ name:"turn", samplers:[{ input:0,output:1 }, { input:0,output:2,interpolation:"STEP" }],
        channels:[{sampler:0,target:{node:0,path:"rotation"}},{sampler:1,target:{node:0,path:"translation"}}] }] } };
}
test("imported tracks remain editable, exact on reload and retain step/slerp semantics", () => {
  const f = fixture(), processing = [];
  const character = importAnimations(f.json, i => f.values[i], f.nodes, processing, () => assert.fail());
  assert.equal(character.version, 3); assert.equal(character.clips[0].loop, false);
  assert.equal(character.clips[0].tracks[0].interpolation, "slerp");
  const p = f.store.snapshot(); p.character = character;
  const store = createStore(p);
  store.apply([{op:"characterPose",name:"turn",time:.5}]);
  const pose = store.snapshot(), node = pose.nodes.find(n => n.id === "joint");
  assert.ok(Math.abs(quat(node.rotation).dot(quat([0,180,0]))) > 1-1e-12);
  assert.deepEqual(node.position, [0,0,0]);
  assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(pose))), pose);
  const clip = structuredClone(character.clips[0]); clip.tracks[0].keys[1].value = [0,-160,0];
  assert.ok(toolInvocation("fun_editor_apply", { ifRevision: store.revision,
    commands: [{op:"characterClip", name:clip.name, duration:clip.duration, tracks:clip.tracks}] }));
  store.apply([{op:"characterClip", ...clip}]); store.undo(); assert.deepEqual(store.snapshot(), pose);
  assert.deepEqual(sampleKeys(clip.tracks[1], 1), [1,2,3]);
});
test("unsupported or malformed animation fails instead of dropping data", () => {
  for (const mutate of [
    f => { f.json.animations[0].samplers[0].interpolation="CUBICSPLINE"; },
    f => { f.json.animations[0].channels[0].target.node=99; },
    f => { f.values[0]=[1,0]; },
    f => { f.values[1][3]=5; },
    f => { f.json.accessors[1].count=1; },
  ]) {
    const f=fixture(); mutate(f);
    assert.throws(() => importAnimations(f.json, i=>f.values[i], f.nodes, [], ()=>{}),
      e => e.path.startsWith("animations.0") && e.retryable === false);
  }
});
