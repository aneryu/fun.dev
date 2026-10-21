// Distinguish import error from the source author's existing runtime bake error.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { AnimationMixer, Vector3, Triangle } from "three";
import { triangulate } from "../../site/workshop/mesh.js";
import { parseModelFile, writeGLB, WORKSHOP_EXTENSION } from "../../site/workshop/glb.js";
import { importModel } from "../../site/workshop/import-glb.js";
import { evaluateProject } from "../../site/workshop/document.js";
import { point, worldMatrix } from "../../site/workshop/spatial.js";

const out = "test-results/duck-animation-import"; await mkdir(out, {recursive:true});
const { json, buffers } = parseModelFile(await readFile("test-results/duck-joint-panel/duck.funmodel.glb"));
delete json.extensions[WORKSHOP_EXTENSION];
json.extensionsUsed = json.extensionsUsed.filter(name => name !== WORKSHOP_EXTENSION);
const bytes = writeGLB(json, buffers[0]);
const imported = importModel(bytes), project = evaluateProject(imported.project);
const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset+bytes.byteLength), "");
const mixer = new AnimationMixer(gltf.scene), results = [];
try {
  for (const clip of gltf.animations) {
    mixer.stopAllAction(); const action = mixer.clipAction(clip).reset().play();
    const time = clip.duration*.37; action.time=time; mixer.update(0);
    gltf.scene.updateMatrixWorld(true);
    const source = structuredClone(project); source.character.pose={clip:clip.name,time};
    const pose = evaluateProject(source), nodes = new Map(pose.nodes.map(n=>[n.id,n]));
    const points = new Map(pose.nodes.filter(n=>n.mesh).map(n => {
      const matrix = worldMatrix(pose,n.id);
      return [n.id, n.mesh.vertices.map(v=>point(matrix,v))];
    }));
    const surfaces = new Map(pose.nodes.filter(n=>n.mesh && !n.morph && !n.skin).map(n =>
      [n.id, n.mesh.faces.flatMap(f => triangulate(n.mesh.vertices,f.vertices)).map(ids =>
        new Triangle(...ids.map(i=>new Vector3(...points.get(n.id)[i]))))]));
    let maximumError = 0, vertices = 0, worst = null;
    gltf.scene.traverse(mesh => {
      if (!mesh.isMesh) return;
      let owner = mesh;
      while (owner && !nodes.get(owner.name)?.mesh) owner=owner.parent;
      assert.ok(owner, `No source mesh for ${mesh.name}`);
      const expected=points.get(owner.name); mesh.skeleton?.update();
      for (let i=0;i<mesh.geometry.attributes.position.count;i++) {
        const v=mesh.getVertexPosition(i,new Vector3()).applyMatrix4(mesh.matrixWorld);
        // Static coplanar polygonization may remove internal triangle vertices;
        // compare their surface, not a nonexistent vertex correspondence.
        const surface=surfaces.get(owner.name);
        const error=surface
          ? Math.min(...surface.map(t=>t.closestPointToPoint(v,new Vector3()).distanceTo(v)))
          : Math.min(...expected.map(p=>Math.hypot(v.x-p[0],v.y-p[1],v.z-p[2])));
        if (error > maximumError) { maximumError=error; worst={node:owner.name,mesh:mesh.name,vertex:i,world:v.toArray()}; }
        vertices++;
      }
    });
    assert.ok(maximumError < 1e-5, `${clip.name}: ${maximumError}m ${JSON.stringify(worst)}`);
    results.push({clip:clip.name,time,vertices,maximumError});
  }
  await writeFile(`${out}/gltf-parity.json`, JSON.stringify({source:"duck-joint-panel/duck.funmodel.glb runtime data, editable extension removed",
    scope:"All rendered vertices at one intermediate time per clip; deforming vertex distance and static surface distance against the same GLB played by Three.js",
    results},null,2));
  console.log(JSON.stringify({clips:results.length,maximumError:Math.max(...results.map(r=>r.maximumError))}));
} finally {
  mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene);
  gltf.scene.traverse(o=>{o.geometry?.dispose(); for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[]) m.dispose();});
}
