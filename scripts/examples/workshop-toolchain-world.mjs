import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import JoltFactory from 'jolt-physics';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { createFun3d } from '../../site/runtime/kit/fun3d.js';
import { createWorld } from '../../site/runtime/kit/world.js';
import { createModels } from '../../site/runtime/kit/models.js';
import { createPhysics } from '../../site/runtime/kit/physics.js';
import { createFixedStep } from '../../site/runtime/kit/loop.js';

const folder=resolve('test-results/workshop-toolchain/fixtures/toy-c');
const read=async path=>new Uint8Array(await readFile(resolve(folder,path))),json=async path=>JSON.parse(new TextDecoder().decode(await read(path)));
const scene=new THREE.Scene(),models=createModels({THREE,scene}),physics=await createPhysics({THREE,scene,loadJolt:JoltFactory,warn:m=>{throw new Error(m);}});
const base=createFun3d({THREE,decoder:MeshoptDecoder}), live=new Set();
const fun3d={async load(...args){const file=await base.load(...args);live.add(file);const dispose=file.dispose;file.dispose=()=>{if(live.delete(file))dispose();};return file;}};
const world=await createWorld({fun3d,models,physics,read,json,warn:m=>{throw new Error(m);}},'assets/world/world.json',{radius:8,far:28});
const report={date:new Date().toISOString(),fixtureEvidenceSha256:createHash('sha256').update(await readFile(resolve(folder,'evidence.json'))).digest('hex'),seed:23,simulation:'Jolt WASM, fixed 1/60 seconds, original generated World',samples:[]};
const sample=label=>{const s={label,files:live.size,geometries:[...live].reduce((n,f)=>n+f.geometries.size,0),textures:[...live].reduce((n,f)=>n+f.textures.size,0),bodies:physics.system.GetNumBodies(),tiles:world.tiles().map(t=>({x:t.x,z:t.z,state:t.state}))};report.samples.push(s);return s;};
try {
  world.focus([-20,0,0]);await world.settle();
  assert.ok(world.tiles().some(t=>t.state==='near'));assert.ok(world.tiles().some(t=>t.state==='far'));
  const ball=await base.load(await read('assets/ball.fun3d'));scene.add(ball.root);const handle=physics.add(ball),fixed=createFixedStep();
  for(let i=0;i<180;i++)fixed.advance(1/60,dt=>physics.step(dt));
  const y=ball.node('ball').position.y;report.collision={afterSeconds:3,y,status:y>.2&&y<.8?'pass':'fail'};assert.equal(report.collision.status,'pass');
  handle.remove();ball.dispose();
  for(let round=0;round<10;round++) {
    for(const x of [-20,0,20,0,-20]){world.focus([x,0,0]);await world.settle();sample(`${round}:${x}`);}
    world.focus([1000,0,0]);await world.settle();const s=sample(`${round}:unloaded`);assert.equal(s.bodies,0);assert.equal(s.files,1,'only World data stays resident');assert.equal(s.geometries,0);assert.equal(s.textures,0);
  }
  report.status='pass';
}finally{world.dispose();models.dispose();assert.equal(live.size,0);assert.equal(physics.system.GetNumBodies(),0);physics.dispose();await writeFile('test-results/workshop-toolchain/world-report.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify({status:report.status,collision:report.collision,rounds:10,samples:report.samples.length}));
