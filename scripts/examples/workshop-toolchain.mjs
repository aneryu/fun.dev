import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { openWorkshop } from '../workshop-node.mjs';
import { createStore, emptyProject, normalizeProject } from '../../site/workshop/document.js';
import { importModel } from '../../site/workshop/import-glb.js';
import { createConverter, converterStamp } from '../fun3d-convert.mjs';
import { materialReadback } from '../../site/workshop/runtime-transfer.js';
import { evaluateProject } from '../../site/workshop/document.js';
import { normalizePresentation } from '../../site/runtime/kit/presentation.js';
import { encodePNG } from '../png.mjs';
import { prepareRelease } from '../game-release.mjs';
import * as THREE from 'three';
import * as GPU from 'three/webgpu';
import * as TSL from 'three/tsl';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { createFun3d } from '../../site/runtime/kit/fun3d.js';
import { createMaterials } from '../../site/runtime/kit/materials.js';
import { createRippleExtension } from '../../site/runtime/kit/ripple.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const png = (color) => encodePNG({ width: 2, height: 2, pixels: Uint8Array.from([...color, ...color, ...color, ...color]) });
const texture = color => ({ uri: `data:image/png;base64,${png(color).toString('base64')}` });
const presentation = normalizePresentation({ version: 1, camera: { position: [3.5,2.6,4.5], target: [0,.6,0], fov: 40 },
  environment: { sky: [.3,.4,.6], ground: [.15,.12,.06], key: [10,8,5], intensity: 1 },
  lights: [{ position: [2,4,3], intensity: 60 }], post: { bloom: .15, ao: true, saturation: 1.05, samples: 0 } });
function product() {
  const s = createStore(emptyProject());
  s.apply([
    { op:'material', id:'paint', color:'#ffd43b', roughness:.5, baseColorTexture: texture([240,180,40,255]), normalTexture:texture([128,128,255,255]), metalRoughTexture:texture([255,180,30,255]), occlusionTexture:texture([255,255,255,255]) },
    { op:'material', id:'metal', color:'#d9b67b', roughness:.2, metalness:1 },
    { op:'material', id:'glass', color:'#ffffff', roughness:.04, transmission:1, ior:1.45 },
    { op:'material', id:'glow', color:'#f28c28', emissive:'#f28c28', emissiveIntensity:2, roughness:.4 },
    { op:'create', id:'base', kind:'box', position:[0,.15,0], options:{size:[1.7,.3,1.3]} },
    { op:'create', id:'rim', kind:'cylinder', material:'metal', position:[0,.45,0], options:{radius:.65,height:.15} },
    { op:'create', id:'dome', kind:'sphere', material:'glass', position:[0,.95,0], options:{radius:.6} },
    { op:'create', id:'heart', kind:'box', material:'glow', position:[0,.85,0], rotation:[15,30,15], options:{size:[.35,.35,.35]} },
    { op:'presentation', definition:presentation },
  ]);
  const p = s.snapshot(), n = p.nodes.find(n=>n.id==='base');
  n.mesh.uvs = n.mesh.vertices.map(([x,y,z])=>[x+1,z+y+1]); n.mesh.faces.forEach(f=>f.material='paint'); delete n.generator; delete n.recipe;
  p.name = 'Little light'; return normalizeProject(p);
}
function character() {
  const s = createStore(emptyProject());
  s.apply([{op:'material',id:'toy',color:'#ffd43b',roughness:.6},
    {op:'create',kind:'group',id:'root_joint'}, {op:'joint',id:'root_joint'},
    {op:'create',kind:'group',id:'tip',parent:'root_joint',position:[0,.4,0]}, {op:'joint',id:'tip'},
    {op:'create',kind:'box',id:'body',material:'toy'}, {op:'presentation',definition:{...presentation,camera:{position:[2,1.5,3],target:[0,0,0],fov:40}}}]);
  const n = s.snapshot().nodes.find(n=>n.id==='body');
  s.apply([{op:'skinBind',id:'body',joints:['root_joint','tip'],weights:n.mesh.vertices.map((p,index)=>({index,influences:[{joint:p[1]>0?'tip':'root_joint',weight:1}]}))},
    {op:'morphTarget',id:'body',name:'wide',changes:n.mesh.vertices.map((v,index)=>({index,position:[v[0]*1.4,v[1],v[2]]}))},
    {op:'characterClip',name:'wave',duration:2,fps:12,loop:false,tracks:[
      {node:'tip',channel:'rotation',keys:[{time:0,value:[0,0,0]},{time:1,value:[0,0,35]},{time:2,value:[0,0,0]}]},
      {node:'body',channel:'morph',target:'wide',keys:[{time:0,value:0},{time:1,value:1},{time:2,value:0}]},
    ]}]);
  return s.snapshot();
}

export async function buildFixtures(out = resolve('test-results/workshop-toolchain/fixtures')) {
  await mkdir(out, {recursive:true});
  const converter = createConverter(), sourceCode = await readFile(new URL('toolchain-game.js',import.meta.url));
  const report = { version:1, seed:23, license:'CC0-1.0 for generated original fixture assets', converter:await converterStamp(), fixtures:[] };
  for (const kind of ['A','B','C','D','E']) {
    const folder = resolve(out,`toy-${kind.toLowerCase()}`), files = [];
    const put = async (path, bytes) => { await mkdir(dirname(resolve(folder,path)),{recursive:true}); await writeFile(resolve(folder,path),bytes); files.push(path); return {path,sha256:hash(bytes),bytes:bytes.length}; };
    const project = kind === 'B' ? character() : kind === 'C' ? {...emptyProject(),name:'Toy district',tile:{size:[20,20],span:[3,1]},presentation} : product();
    const session = await openWorkshop({record:{project,revision:0},width:64,height:64});
    let checks, assets = [];
    try {
      if (kind === 'E') session.api.apply([{op:'ripple',definition:{version:1,material:'paint',amplitude:2,frequency:10,speed:3,color:'#4ba3c7',fallback:'reject'}}]);
      if (kind === 'C') {
        session.api.apply([
          {op:'create',id:'ground',kind:'terrain',position:[-30,0,-10],terrain:{cell:2,samples:[31,11],surfaceTable:[{id:'grass',color:'#7f9957'}]}},
          {op:'terrain',id:'ground',seed:23,ops:[{noise:{amplitude:.1,scale:15}}]},
          {op:'create',id:'road',kind:'path',tags:['road'],path:{points:[[-28,.12,0],[28,.12,0]],kind:'road',lanes:1}},
          {op:'rule',definition:{id:'road_mesh',kind:'sweep',on:{path:'road'},profile:{preset:'road',lanes:1,sidewalks:true},step:2,chunk:20}},
          ...[-20,0,20].map((x,i)=>({op:'create',id:`house_${i}`,kind:'box',position:[x,1,-5],options:{size:[3,2,3]}})),
        ]);
        await session.api.derive({}, {ifRevision:session.api.inspect().revision});
        const world = await session.api.exportWorld({name:'Toy district'});
        for (const f of world.files) assets.push(await put(`assets/world/${f.path}`,Buffer.from(f.data,'base64')));
        checks = {status:'pass',tiles:world.manifest.tiles.length,world:world.report};
        const ballRoot = new THREE.Group(); ballRoot.name='ball_root';
        const ball = new THREE.Mesh(new THREE.SphereGeometry(.3,12,8),new THREE.MeshStandardMaterial({name:'ball_paint',color:'#f28c28'})); ball.name='ball';ball.position.set(-20,3,0);ballRoot.add(ball);
        assets.push(await put('assets/ball.fun3d',await converter.fun3d.write(ballRoot,{physics:{shapes:[{id:'sphere',type:'sphere',radius:.3}],bodies:[{id:'ball',node:'ball',shape:'sphere',motion:'dynamic',mass:1,restitution:.2}]}})));
        ball.geometry.dispose();ball.material.dispose();
      } else {
        const glb = Buffer.from((await session.api.exportGLB({encoding:'base64'})).data,'base64');
        const saved = Buffer.from((await session.api.exportProject()).data,'base64');
        assert.deepEqual(normalizeProject(importModel(saved).project),session.api.getProject());
        assets.push(await put('source.funmodel.glb',saved)); assets.push(await put('model.glb',glb));
        const converted = await converter.convert(glb,{type:kind==='B'?'character':'prop',positionPrecision:'float32'});
        assets.push(await put('assets/model.fun3d',converted.bytes));
        const loader = kind==='E' ? createFun3d({THREE:GPU,decoder:MeshoptDecoder,materials:createMaterials({THREE:GPU,TSL}),extensions:{'fun3d.ripple':createRippleExtension({THREE:GPU,TSL,backend:'webgpu'})}}) : converter.fun3d;
        const model = await loader.load(converted.bytes,{keepSources:true});
        try { checks = materialReadback(project,model); assert.equal(checks.status,'pass',JSON.stringify(checks)); }
        finally { model.dispose(); }
        if (kind==='B') {
          const { runtimeCorrespondence, runtimePoseProject } = await import('../../site/workshop/runtime-inspection.js');
          const runtime = await converter.fun3d.load(converted.bytes);
          try {
            const mapping = runtimeCorrespondence(project,runtime.root,['body']); assert.equal(mapping.complete,true);
            const mixer = new THREE.AnimationMixer(runtime.root), action = mixer.clipAction(runtime.animations[0]); action.play();
            checks.character = [];
            for (const time of [0,1,2]) {
              action.setLoop(THREE.LoopOnce,1); action.clampWhenFinished=true; mixer.setTime(time);
              runtime.root.updateMatrixWorld(true);
              const actual = runtimePoseProject({...project,relations:[]},mapping); assert.equal(actual.complete,true);
              const input = structuredClone(project); input.character.pose={clip:'wave',time};
              const expected = evaluateProject(input).nodes.find(n=>n.id==='body').mesh.vertices;
              const vertices = actual.project.nodes.find(n=>n.id==='body').mesh.vertices;
              const error = Math.max(...vertices.map((v,i)=>Math.hypot(...v.map((c,k)=>c-expected[i][k]))));
              assert.ok(error<2e-4,`character sample ${time}: ${error}`);checks.character.push({time,error,status:'pass'});
            }
            mixer.stopAllAction();mixer.uncacheRoot(runtime.root);
          } finally { runtime.dispose(); }
        }
      }
      await put('source.json',JSON.stringify(session.api.getProject(),null,2));
    } finally { session.dispose(); }
    const app = {version:1,kind,seed:23,replay:[{at:0,command:'activate'},{at:1,command:'pause'},{at:2,command:'reset'}],samples:[0,1,2]};
    if(kind==='D') app.timeline={version:1,duration:2,tracks:[{target:'lid',property:'position',keys:[{time:0,value:[0,2.8,0]},{time:2,value:[0,.95,0]}]},{target:'camera',property:'position',keys:[{time:0,value:[3.5,2.6,4.5]},{time:2,value:[2,1.6,3.5]}]}],events:[{time:0,key:'assembled',value:false},{time:2,key:'assembled',value:true}]};
    await put('assets/app.json',JSON.stringify(app,null,2)); await put('game.js',sourceCode);
    await put('README.md',`# Toy lab ${kind}\n\nOriginal CC0-1.0 fixture assets; seed 23. Editable input: source.json${kind==='C'?'':' and source.funmodel.glb'}. Runtime resources and hashes: evidence.json and game.json.\n\nFrom the fun.dev repository root:\n\n\`\`\`sh\nFUNDEV_GAMES=test-results/workshop-toolchain/fixtures npm run dev -- toy-${kind.toLowerCase()}\nnode scripts/fun-app.mjs test-results/workshop-toolchain/fixtures/toy-${kind.toLowerCase()}/game.json --out test-results/workshop-toolchain/manual-${kind}\n\`\`\`\n\nTap or Enter plays; P pauses; R resets. The platform menu exposes the same actions. Only D supports seek; C resets and replays its fixed-step physics. assets/app.json records the input replay and sample times. See docs/workshop-toolchain.md for backend evidence and limits. No bundle is published.\n`);
    const manifest={id:`toy-${kind.toLowerCase()}`,version:'1.0.0',apiVersion:3,title:{en:`Toy lab ${kind}`,zh:`玩具实验 ${kind}`},description:{en:'Reproducible Workshop fixture',zh:'可重建的 Workshop 样例'},category:{en:'Test',zh:'测试'},platforms:['mobile','desktop'],orientation:'any',howToPlay:{en:'Tap or Enter plays. P pauses. R resets.',zh:'点击或回车播放，P 暂停，R 重置。'},files:files.filter(p=>p==='game.js'||p.startsWith('assets/'))};
    await put('game.json',JSON.stringify(manifest,null,2));
    const release=await prepareRelease(resolve(folder,'game.json'));
    const evidence={kind,seed:23,assets,checks,release:release.game.release,gpu:'not_checked',native:'not_checked'};
    await put('evidence.json',JSON.stringify(evidence,null,2));report.fixtures.push(evidence);
  }
  await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)); return report;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const report=await buildFixtures(process.argv[2] && resolve(process.argv[2])); console.log(JSON.stringify(report.fixtures.map(f=>({kind:f.kind,status:f.checks.status,assets:f.assets.length}))));
}
