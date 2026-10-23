import { transformNormals } from "../site/workshop/normal-transform.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { importModel } from '../site/workshop/import-glb.js';
import { normalizeProject } from '../site/workshop/document.js';
import { packMesh, denseGeometry, denseData } from '../site/workshop/dense.js';
import { writeGLB, parseModelFile, withWorkshopProject } from '../site/workshop/glb.js';
import { textureBytes } from '../site/workshop/textures.js';
import { embedBaseColorTextures } from '../site/workshop/texture-export.js';
import { openWorkshop } from '../scripts/workshop-node.mjs';
import { encodePNG } from '../scripts/png.mjs';

const uri = `data:image/png;base64,${encodePNG({width:1,height:1,pixels:Uint8Array.of(255,0,0,255)}).toString('base64')}`;
function fixture(change = () => {}) {
  // Coincident vertices deliberately have different UVs on the two triangles.
  const p = new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,0,0, 0,1,0, -1,0,0]);
  const uv = new Float32Array([0,0, .5,0, .5,1, 1,0, 1,1, .5,0]);
  const bytes = new Uint8Array(p.byteLength + uv.byteLength);
  bytes.set(new Uint8Array(p.buffer)); bytes.set(new Uint8Array(uv.buffer), p.byteLength);
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{nodes:[0]}], nodes:[{mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1}, material:0}]}],
    accessors:[{bufferView:0,componentType:5126,count:6,type:'VEC3'}, {bufferView:1,componentType:5126,count:6,type:'VEC2'}],
    bufferViews:[{buffer:0,byteLength:p.byteLength}, {buffer:0,byteOffset:p.byteLength,byteLength:uv.byteLength}],
    buffers:[{byteLength:bytes.length}], images:[{uri}], textures:[{source:0,sampler:0}],
    samplers:[{wrapS:33071,wrapT:33648,minFilter:9728,magFilter:9728}],
    materials:[{name:'paint',pbrMetallicRoughness:{baseColorTexture:{index:0},metallicFactor:0}}] };
  change(json); return writeGLB(json, bytes);
}
test('base-colour import preserves split UV seams and sampler; project reopen is lossless in polygon and dense forms', () => {
  const project = normalizeProject(importModel(fixture()).project), node = project.nodes.find(n => n.mesh);
  assert.equal(node.mesh.vertices.length, 6);
  assert.deepEqual(node.mesh.uvs[0], [0,0]); assert.deepEqual(node.mesh.uvs[3], [1,0]);
  assert.equal(project.materials[0].baseColorTexture.wrapT,33648);
  for (const dense of [false,true]) {
    if (dense) node.mesh = packMesh(node.mesh);
    const reopened = normalizeProject(importModel(withWorkshopProject(fixture(), project)).project);
    const mesh = reopened.nodes.find(n => n.mesh).mesh;
    assert.deepEqual(mesh.uvs ?? Array.from(denseData(mesh).uvs), node.mesh.uvs ?? Array.from(denseData(node.mesh).uvs));
    assert.deepEqual(reopened.materials, project.materials);
    if (dense) { const g = denseGeometry(mesh); assert.equal(g.uvs.length, g.positions.length / 3 * 2); }
  }
});
test('export embeds original PNG bytes and sampler without recoding', () => {
  const project = normalizeProject(importModel(fixture()).project);
  const {json,buffers} = parseModelFile(embedBaseColorTextures(fixture(),project.materials));
  const info = json.materials[0].pbrMetallicRoughness.baseColorTexture;
  const texture = json.textures[info.index], image = json.images[texture.source], view = json.bufferViews[image.bufferView];
  assert.deepEqual(buffers[0].subarray(view.byteOffset,view.byteOffset+view.byteLength),textureBytes(uri));
  assert.equal(json.samplers[texture.sampler].wrapS,33071);
});
test('textured alpha masks retain the factor and cutoff without becoming blended', () => {
  const project = normalizeProject(importModel(fixture(j => {
    j.materials[0].alphaMode = 'MASK';
    j.materials[0].alphaCutoff = .3;
    j.materials[0].pbrMetallicRoughness.baseColorFactor = [1,1,1,.6];
  })).project);
  assert.equal(project.materials[0].opacity,.6);
  assert.equal(project.materials[0].alphaTest,.3);
  assert.equal(project.materials[0].transparent,undefined);
});
test('unsupported or malformed texture inputs fail explicitly rather than silently losing appearance', () => {
  for (const change of [
    j=>j.images[0].uri='https://example.com/texture.png',
    j=>j.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord=1,
    j=>j.materials[0].pbrMetallicRoughness.baseColorTexture.extensions={KHR_texture_transform:{offset:[.1]}},
    j=>delete j.meshes[0].primitives[0].attributes.TEXCOORD_0,
    j=>j.materials[0].normalTexture={index:99},
    j=>j.samplers[0].wrapS=123,
  ]) assert.throws(()=>importModel(fixture(change)),/texture|TEXCOORD|UV|base-colour/i);
  const project = normalizeProject(importModel(fixture()).project);
  project.nodes.find(n=>n.mesh).mesh.uvs.pop();
  assert.throws(()=>normalizeProject(project),/uvs/);
});

test('retained normals follow rotation and mirrored nonuniform scale', () => {
  const rotated = transformNormals([1,0,0],[0,1,0,0,-1,0,0,0,0,0,1,0,0,0,0,1]);
  assert.deepEqual(Array.from(rotated),[0,1,0]);
  const mirrored = transformNormals([1,1,0],[-2,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  assert.ok(Math.abs(mirrored[0]+1/Math.sqrt(5))<1e-12);
  assert.ok(Math.abs(mirrored[1]-2/Math.sqrt(5))<1e-12);
});

test('candidate observations wait for image decoding and preserve the current draft', async () => {
  const session = await openWorkshop({ width: 64, height: 64 });
  const OriginalImage = globalThis.Image;
  let decoded = 0;
  globalThis.Image = class extends OriginalImage {
    async decode() {
      await new Promise(resolve => setTimeout(resolve, 10));
      await super.decode();
      decoded++;
    }
  };
  try {
    const before = session.api.inspect({detail:'full'});
    const result = await session.api.workflow({action:'prepare',
      project:importModel(fixture()).project,views:['front'],size:64,
      render:{overlays:{wire:false,selection:false},shadows:false}});
    assert.equal(result.renderError,undefined);
    assert.equal(result.observations.length,1);
    assert.ok(decoded > 0);
    assert.ok(result.observations[0].dataUrl.startsWith('data:image/png;base64,'));
    assert.deepEqual(session.api.inspect({detail:'full'}).nodes,before.nodes);
    assert.equal(session.api.inspect().revision,before.revision);
  } finally {
    globalThis.Image = OriginalImage;
    session.dispose();
  }
});
