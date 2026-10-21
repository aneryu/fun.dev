// After npm run build:production and duck-morphs + fun3d conversion.
// Real browser rendering of the runtime file, not the authoring mesh.
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { launch, serve, watch, local } from "../browser/harness.mjs";

const out = "test-results/duck-morphs";
const bytes = (await readFile(`${out}/duck.fun3d`)).toString("base64");
const server = await serve(), browser = await launch(), errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route("https://static.fun.dev/**", local(server.base));
  const page = watch(await context.newPage(), errors);
  await page.goto(`${server.base}/workshop/?renderer=webgl`);
  await page.waitForFunction(() => window.funEditor);
  const result = await page.evaluate(async base64 => {
    const THREE = await import("/runtime/three.js");
    const { MeshoptDecoder } = await import("/runtime/addons/MeshoptDecoder.js");
    const { createFun3d } = await import("/runtime/kit/fun3d.js");
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const fun3d = createFun3d({ THREE, decoder: MeshoptDecoder });
    const problems = await fun3d.validate(bytes);
    const model = await fun3d.load(bytes);
    const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true });
    await renderer.init();
    renderer.setSize(512, 512);
    const scene = new THREE.Scene(); scene.background = new THREE.Color("#d4d4d4");
    scene.add(model.root);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x776644, 2));
    const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(-3, 5, 6); scene.add(light);
    const bounds = new THREE.Box3().setFromObject(model.root, true);
    const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3()).length();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    camera.position.copy(center).add(new THREE.Vector3(size * 0.8, size * 0.35, size * 1.45)); camera.lookAt(center);
    const meshes = [];
    model.root.traverse(o => { if (o.isMesh && o.morphTargetInfluences?.length) meshes.push(o); });
    const frames = [];
    try {
      for (const [name, values] of Object.entries({
        neutral: {}, blink: { blink: 1 }, smile: { smile: 1 }, surprise: { surprise: 1 },
        combination: { blink: 0.5, smile: 0.5 },
      })) {
        for (const mesh of meshes)
          for (const [target, index] of Object.entries(mesh.morphTargetDictionary))
            mesh.morphTargetInfluences[index] = values[target] ?? 0;
        renderer.render(scene, camera);
        frames.push({ name, image: renderer.domElement.toDataURL(),
          weights: meshes.map(m => ({ name: m.name, weights: [...m.morphTargetInfluences] })) });
      }
      return { problems, warnings: model.warnings, morphMeshes: meshes.length,
        targets: meshes.reduce((sum, m) => sum + m.morphTargetInfluences.length, 0), frames };
    } finally { model.dispose(); await renderer.dispose(); }
  }, bytes);
  assert.deepEqual(result.problems, []); assert.deepEqual(errors, []);
  assert.equal(result.targets, 39);
  assert.notEqual(result.frames[0].image, result.frames[1].image);
  for (const frame of result.frames) {
    await writeFile(`${out}/runtime-${frame.name}.png`, Buffer.from(frame.image.split(",")[1], "base64"));
    delete frame.image;
  }
  await writeFile(`${out}/runtime.json`, JSON.stringify({ ...result, errors, renderer: "WebGL software",
    parity: "Not yet certified: attachment-driven transforms need authored expression clips." }, null, 2));
  console.log(`Runtime: ${result.targets} targets, ${result.frames.length} rendered poses, no console errors`);
} finally { await browser.close(); server.close(); }
