import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { openWorkshop } from '../scripts/workshop-node.mjs';
import { createStore, emptyProject, normalizeProject } from '../site/workshop/document.js';
import { createConverter } from '../scripts/fun3d-convert.mjs';
import { createFun3d } from '../site/runtime/kit/fun3d.js';
import { createMaterials } from '../site/runtime/kit/materials.js';
import { importModel } from '../site/workshop/import-glb.js';
import { parseModelFile, writeGLB } from '../site/workshop/glb.js';
import { materialReadback } from '../site/workshop/runtime-transfer.js';
import { encodePNG } from '../scripts/png.mjs';
import { createTimeline } from '../site/runtime/kit/timeline.js';
import { normalizePresentation } from '../site/runtime/kit/presentation.js';
import { normalizeRipple, createRippleExtension } from '../site/runtime/kit/ripple.js';

const uri = `data:image/png;base64,${encodePNG({ width: 2, height: 2, pixels: Uint8Array.from([255,80,10,128, 40,220,80,255, 40,80,230,255, 255,255,255,255]) }).toString('base64')}`;
export function textureProject() {
  const store = createStore(emptyProject());
  store.apply([{ op: 'material', id: 'paint', name: 'Paint', color: '#ffffff', roughness: .3, metalness: .5, emissive: '#ffffff',
    ...Object.fromEntries(['baseColorTexture', 'normalTexture', 'metalRoughTexture', 'occlusionTexture', 'emissiveTexture'].map(key => [key, { uri, transform: { offset: [.1, .2], scale: [2, 1], rotation: .25 } }])),
    normalScale: .5, occlusionStrength: .6, opacity: .6, alphaTest: .3 },
  { op: 'material', id: 'glass', name: 'Glass', color: '#ffffff', roughness: .1, transmission: .9, ior: 1.4 },
  { op: 'create', id: 'painted', kind: 'box' }, { op: 'create', id: 'glass_ball', kind: 'sphere', material: 'glass', position: [2, 0, 0] }]);
  const project = store.snapshot(), box = project.nodes.find(n => n.id === 'painted');
  project.presentation = normalizePresentation({ version: 1, exposure: 1.2, lights: [{ position: [2, 3, 4] }], post: { bloom: .2 } });
  box.mesh.uvs = box.mesh.vertices.map(([x,y]) => [x + .5,y + .5]);
  box.mesh.faces.forEach(f => f.material = 'paint');
  delete box.generator; delete box.recipe;
  return normalizeProject(project);
}

test('editable textures and glass reach decompressed classic and TSL runtime materials', async () => {
  const project = textureProject(), session = await openWorkshop({ record: { project, revision: 0 }, width: 64, height: 64 });
  try {
    const file = Buffer.from((await session.api.exportGLB({ encoding: 'base64' })).data, 'base64');
    const reimported = importModel(file).project;
    assert.deepEqual(reimported.presentation, project.presentation);
    assert.deepEqual(reimported.materials.find(m=>m.id==='paint'), { ...project.materials.find(m=>m.id==='paint'), name: 'paint' }, 'runtime GLB material names carry stable IDs; editable labels are checked by verifyExport');
    const saved = await session.api.workflow({ action: 'verifyExport' });
    assert.equal(saved.editable.integrity.exact, true);
    const converter = createConverter(), result = await converter.convert(file, { positionPrecision: 'float32' });
    assert.deepEqual(result.manifest.extensions['fun3d.presentation'], project.presentation);
    assert.equal(result.manifest.images.length, 1, 'byte-identical images deduplicate across roles');
    for (const builder of [null, createMaterials({ THREE, TSL })]) {
      const runtime = createFun3d({ THREE, decoder: (await import('three/addons/libs/meshopt_decoder.module.js')).MeshoptDecoder, materials: builder });
      const loaded = await runtime.load(result.bytes, { keepSources: true });
      try {
        const readback = materialReadback(project, loaded);
        assert.equal(readback.status, 'pass', JSON.stringify(readback.checks.filter(c => c.status !== 'pass')));
        assert.deepEqual(loaded.warnings, []);
        const paint = [...loaded.materials.values()].find(m=>m.id==='paint');
        assert.equal(builder?.batchable(paint) ?? false, false);
        const painted = loaded.node('painted').userData.mesh, glass = loaded.node('glass_ball').userData.mesh;
        const savedBinding = painted.material; painted.material = glass.material;
        assert.equal(materialReadback(project, loaded).checks.find(c => c.field === 'node.painted.binding').status, 'fail');
        painted.material = savedBinding;
      } finally { loaded.dispose(); }
    }
    const abort = new AbortController(); let decoded = 0, closed = 0;
    const cancellable = createFun3d({ THREE, decoder: (await import('three/addons/libs/meshopt_decoder.module.js')).MeshoptDecoder,
      decodeImage: async () => { if (++decoded === 2) abort.abort(); return { width: 2, height: 2, data: new Uint8Array(16), close() { closed++; } }; } });
    await assert.rejects(cancellable.load(result.bytes, { signal: abort.signal }), /abort/i);
    assert.equal(decoded, 2); assert.equal(closed, decoded, 'cancel closes both earlier and just-decoded image resources');
    const { json, buffers } = parseModelFile(file);
    for (const extension of ['KHR_materials_clearcoat', 'KHR_materials_volume', 'KHR_materials_unlit']) {
      assert.throws(() => importModel(writeGLB({ ...json, extensionsRequired: [extension] }, buffers[0])), /Unsupported required/);
    }
    const opaqueIOR = structuredClone(json);
    opaqueIOR.materials[0].extensions = { KHR_materials_ior: { ior: 2.1 } };
    for (const extensionsRequired of [[], ['KHR_materials_ior']]) {
      const opaqueGLB = writeGLB({ ...opaqueIOR, extensionsRequired }, buffers[0]);
      assert.throws(() => importModel(opaqueGLB), /opaque IOR/);
      await assert.rejects(converter.convert(opaqueGLB), /opaque IOR/);
    }
    opaqueIOR.materials[0].extensions.KHR_materials_ior.ior = 1.5;
    assert.doesNotThrow(() => importModel(writeGLB({ ...opaqueIOR, extensionsRequired: ['KHR_materials_ior'] }, buffers[0])));
    json.materials[0].normalTexture = { index: 99 };
    assert.throws(() => importModel(writeGLB(json, buffers[0])), /texture/i);
  } finally { session.dispose(); }
});

test('black emissive factor remains black when an emissive texture is present', async () => {
  const project = textureProject(), paint = project.materials.find(m => m.id === 'paint');
  paint.emissive = '#000000';
  const session = await openWorkshop({ record: { project, revision: 0 }, width: 64, height: 64 });
  try {
    const glb = Buffer.from((await session.api.exportGLB({ encoding: 'base64' })).data, 'base64');
    const result = await createConverter().convert(glb);
    const descriptor = result.manifest.materials.find(m => m.id === 'paint');
    assert.equal(descriptor.features.emitter.color, '#000000');
    assert.ok(descriptor.features.emitter.map);
    for (const materials of [undefined, createMaterials({ THREE, TSL })]) {
      const loaded = await createFun3d({ THREE, materials, decoder: (await import('three/addons/libs/meshopt_decoder.module.js')).MeshoptDecoder }).load(result.bytes, { keepSources: true });
      try {
        const readback = materialReadback(project, loaded);
        assert.equal(readback.status, 'pass', JSON.stringify(readback.checks.filter(c => c.status !== 'pass')));
      } finally { loaded.dispose(); }
    }
  } finally { session.dispose(); }
});

test('timeline play/pause/reset/seek is deterministic and state is recomputed without DOM', () => {
  const object = new THREE.Object3D();
  const config = { version: 1, duration: 2, tracks: [{ target: 'lid', property: 'position', keys: [{ time: 0, value: [0, 2, 0] }, { time: 2, value: [0, 0, 0] }] }], events: [{ time: 0, key: 'assembled', value: false }, { time: 2, key: 'assembled', value: true }] };
  const timeline = createTimeline(config, { lid: object });
  timeline.play(); timeline.update(1); assert.equal(object.position.y, 1);
  timeline.pause(); timeline.update(1); assert.equal(object.position.y, 1);
  assert.equal(timeline.seek(2).state.assembled, true);
  assert.equal(timeline.reset().state.assembled, false); assert.equal(object.position.y, 2);
  assert.throws(() => timeline.seek(NaN), /outside/);
  assert.throws(() => createTimeline({ ...config, tracks: [{ ...config.tracks[0], target: 'missing' }] }, {}), /binding/);
  assert.throws(() => normalizePresentation({ version: 1, environment: { source: 'eval(1)' } }), /environment/);
  timeline.dispose(); assert.throws(()=>timeline.play(), /disposed/);
});

test('static merge keeps mixed UV layouts separate without losing authored coordinates', async () => {
  const store = createStore(emptyProject());
  store.apply([{op:'create',id:'uv_box',kind:'box'},{op:'create',id:'plain_box',kind:'box',position:[2,0,0]}]);
  const project=store.snapshot(),node=project.nodes.find(n=>n.id==='uv_box');
  node.mesh.uvs=node.mesh.vertices.map(([x,y])=>[x+.5,y+.5]);delete node.recipe;delete node.generator;
  const session=await openWorkshop({record:{project,revision:0},width:64,height:64});
  try {
    const file=Buffer.from((await session.api.exportGLB({encoding:'base64',mergeStatic:'auto'})).data,'base64');
    const {json}=parseModelFile(file);assert.equal(json.meshes.length,2);
    assert.deepEqual(json.meshes.flatMap(m=>m.primitives.map(p=>p.attributes.TEXCOORD_0!==undefined)).sort(),[false,true]);
  } finally {session.dispose();}
});

test('transmission degradation is explicit and texture-only alpha blend survives writing', async () => {
  const root = new THREE.Group(); root.name = 'root';
  const glass = new THREE.MeshPhysicalMaterial({ name: 'glass', transmission: .8, thickness: .2, attenuationColor: '#abcdee', attenuationDistance: 2 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), glass); mesh.name = 'glass'; root.add(mesh);
  const bytes = await createFun3d({ THREE }).write(root);
  const fallback = await createFun3d({ THREE, transmission: 'opaque' }).load(bytes, { warn() {} });
  assert.equal(fallback.warnings.length, 1); fallback.dispose();
  await assert.rejects(createFun3d({ THREE, transmission: 'reject' }).load(bytes), /refused/);
  const loaded = await createFun3d({ THREE }).load(bytes);
  const actual = [loaded.node('glass').userData.mesh.material].flat()[0];
  assert.equal(actual.transmission, .8); assert.equal(actual.thickness, .2); assert.equal(actual.attenuationDistance, 2);
  loaded.dispose();
  glass.transmission = 0; glass.transparent = true; glass.opacity = 1;
  const alpha = await createFun3d({ THREE }).load(await createFun3d({ THREE }).write(root));
  assert.equal([alpha.node('glass').userData.mesh.material].flat()[0].transparent, true); alpha.dispose();
  mesh.geometry.dispose(); glass.dispose();
});

test('trusted ripple validates parameters, missing resources, backend policy and repeated lifecycle', async () => {
  const root=new THREE.Group();root.name='root';
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial({name:'paint'}));mesh.name='part';root.add(mesh);
  const writer=createFun3d({THREE}), spec={version:1,material:'paint',amplitude:1,frequency:8,speed:2,color:'#4ba3c7',fallback:'reject'};
  const bytes=await writer.write(root,{extensions:{'fun3d.ripple':spec},requires:['fun3d.ripple']});
  await assert.rejects(writer.load(bytes),/requires the extension/);
  for(const bad of [{...spec,amplitude:-1},{...spec,version:2},{...spec,code:'eval(1)'}])assert.throws(()=>normalizeRipple(bad),/Invalid/);
  const loader=backend=>createFun3d({THREE,materials:createMaterials({THREE,TSL}),extensions:{'fun3d.ripple':createRippleExtension({THREE,TSL,backend})}});
  await assert.rejects(loader('none').load(bytes),/unsupported on backend/);
  const missing=await writer.write(root,{extensions:{'fun3d.ripple':{...spec,material:'missing'}}});
  await assert.rejects(loader('webgpu').load(missing),/Missing ripple material/);
  const fallback=await writer.write(root,{extensions:{'fun3d.ripple':{...spec,fallback:'base'}}});
  const degraded=await loader('none').load(fallback);assert.equal(degraded.effects.get('fun3d.ripple').status,'unsupported');assert.equal(degraded.warnings.length,1);degraded.dispose();
  for(let i=0;i<3;i++){
    const model=await loader('webgpu').load(bytes),effect=model.effects.get('fun3d.ripple');
    effect.update(.5);assert.equal(effect.uniforms.time.value,.5);
    assert.equal(createMaterials({THREE,TSL}).batchable(model.materials.get('paint')),false);
    model.dispose();model.dispose();assert.throws(()=>effect.update(1),/disposed/);
  }
  const abort=new AbortController();abort.abort();await assert.rejects(writer.load(bytes,{signal:abort.signal}),/abort/i);
  mesh.geometry.dispose();mesh.material.dispose();
});
