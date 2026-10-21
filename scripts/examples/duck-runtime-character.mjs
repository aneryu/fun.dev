// After npm run build:production and duck-character + fun3d conversion.
// Real browser rendering of the runtime file, not the authoring mesh.
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { launch, serve, watch, local } from "../browser/harness.mjs";

const skins = process.env.DUCK_SKIN === "1";
const mouth = process.env.DUCK_MOUTH === "1";
const close = process.env.DUCK_CLOSE === "1";
const deform = process.env.DUCK_DEFORM === "1";
const checkContacts = process.env.DUCK_VERIFY_CONTACTS === "1";
const actions = skins || process.env.DUCK_ACTIONS === "1";
const out = process.env.DUCK_RUNTIME_DIR ?? (skins ? "test-results/duck-skin" : actions ? "test-results/duck-actions" : "test-results/duck-character");
const bytes = (await readFile(`${out}/duck.fun3d`)).toString("base64");
const authored = JSON.parse(await readFile(`${out}/authored.json`, "utf8")).project;
const server = await serve(), browser = await launch(), errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route("https://static.fun.dev/**", local(server.base));
  const page = watch(await context.newPage(), errors);
  await page.goto(`${server.base}/workshop/?renderer=webgl`);
  await page.waitForFunction(() => window.funEditor);
  const result = await page.evaluate(async ({ base64, authored, actions, mouth, close, deform, checkContacts }) => {
    const THREE = await import("/runtime/three.js");
    const { MeshoptDecoder } = await import("/runtime/addons/MeshoptDecoder.js");
    const { createFun3d } = await import("/runtime/kit/fun3d.js");
    const { evaluateProject } = await import("/workshop/document.js");
    const { worldMatrix, point } = await import("/workshop/spatial.js");
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
    const mixer = new THREE.AnimationMixer(model.root);
    try {
      const poses = actions
        ? [["stand", 0], ["walk", .3], ["run", .1625], ["jump", .6]]
        : [["neutral", 0], ["blink", .5], ["smile", .5], ["surprise", .5], ["combination", .5]];
      if(actions)poses.push(["blink",.5],["smile",.5],["surprise",.5],["combination",.5]);
      if (mouth) poses.push(["mouth_open", .5], ["mouth_expression", .5]);
      if (close) poses.push(["mouth_close", .5], ["close_smile", .5], ["mouth_close", .25,"half_close"]);
      if (deform) poses.push(["head_surface_motion", .5]);
      for (const [name, time, label=name] of poses) {
        mixer.stopAllAction();
        const clip = model.animations.find(c => c.name === (name === "neutral" ? "blink" : name));
        if (!clip) throw new Error(`Missing exported clip ${name}`);
        const action = mixer.clipAction(clip); action.reset().play();
        action.time = time; mixer.update(0);
        const source = structuredClone(authored);
        source.character.pose = { clip: name === "neutral" ? "blink" : name, time: action.time };
        const expected = evaluateProject(source);
        model.root.updateMatrixWorld(true);
        const skinParity = [];
        model.root.traverse(mesh => {
          if (!mesh.isMesh) return;
          mesh.skeleton?.update();
          let owner = mesh, reference;
          while (owner && !reference) {
            reference = expected.nodes.find(n => n.id === owner.name && (n.skin || n.attachment?.mode === "deform"));
            owner = owner.parent;
          }
          if (!reference) {
            if (mesh.isSkinnedMesh) throw new Error(`No authoring source for skin ${mesh.name}`);
            return;
          }
          const vertices = reference.mesh.vertices.map(v => new THREE.Vector3(...point(worldMatrix(expected, reference.id), v)));
          let maximumError = 0;
          for (let i = 0; i < mesh.geometry.getAttribute("position").count; i++) {
            const v = mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
            maximumError = Math.max(maximumError, Math.min(...vertices.map(p => p.distanceTo(v))));
          }
          if (maximumError > .001) throw new Error(`Skin mismatch ${name}:${reference.id}: ${maximumError}`);
          skinParity.push({ node: reference.id, maximumError });
        });
        for (const mesh of meshes) {
          let owner = mesh, reference;
          while (owner && !reference) {
            reference = expected.nodes.find(n => n.id === owner.name && (n.morph || n.attachment?.mode === "deform"));
            owner = owner.parent;
          }
          if (!reference) throw new Error(`No authoring source for morph mesh ${mesh.name}`);
          if (reference.attachment?.mode === "deform") continue; // baked vertex parity is checked above
          for (const [target, index] of Object.entries(mesh.morphTargetDictionary))
            if (Math.abs(mesh.morphTargetInfluences[index] - (reference.morph.weights[target] ?? 0)) > 1e-4)
              throw new Error(`Weight mismatch ${name}:${reference.id}.${target}`);
        }
        const parity = expected.nodes.map(n => {
          const actual = [...model.nodes.values()].find(o => o.name === n.id);
          if (!actual) return { node: n.id, missing: true };
          const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...n.rotation.map(THREE.MathUtils.degToRad)));
          return { node: n.id,
            positionError: actual.position.distanceTo(new THREE.Vector3(...n.position)),
            quaternionError: 1 - Math.abs(actual.quaternion.dot(q)),
            scaleError: actual.scale.distanceTo(new THREE.Vector3(...n.scale)) };
        });
        renderer.render(scene, camera);
        frames.push({ name:label,clip:name,time:action.time,image: renderer.domElement.toDataURL(),
          parity,
          skinParity,
          weights: meshes.map(m => ({ name: m.name, weights: [...m.morphTargetInfluences] })) });
      }
      const generatedTargets = meshes.reduce((sum, mesh) => {
        for (let owner = mesh; owner; owner = owner.parent)
          if (authored.nodes.some(n => n.id === owner.name && n.attachment?.mode === "deform"))
            return sum + mesh.morphTargetInfluences.length;
        return sum;
      }, 0);
      let runtimeContacts;
      if(checkContacts) {
        funEditor.loadProject(authored);const before=JSON.stringify(funEditor.getProject()),revision=funEditor.inspect().revision;
        runtimeContacts=await funEditor.workflow({action:"verifyRuntime",ifRevision:revision,
          query:{data:base64,poses:frames.map(f=>({clip:f.clip,time:f.time}))}});
        if(before!==JSON.stringify(funEditor.getProject())||revision!==funEditor.inspect().revision)throw new Error("Runtime inspection changed the draft");
      }
      return { problems, warnings: model.warnings, morphMeshes: meshes.length, generatedTargets,runtimeContacts,
        targets: meshes.reduce((sum, m) => sum + m.morphTargetInfluences.length, 0), frames };
    } finally { mixer.stopAllAction(); mixer.uncacheRoot(model.root); model.dispose(); await renderer.dispose(); }
  }, { base64: bytes, authored, actions, mouth, close, deform, checkContacts });
  assert.deepEqual(result.problems, []); assert.deepEqual(errors, []);
  if(checkContacts)assert.equal(result.runtimeContacts.ok,true,"Inspect compressed runtime contact diagnostics");
  const expectedTargets = authored.nodes.filter(n => n.morph).reduce((sum, n) =>
    sum + n.morph.targets.length * new Set(n.mesh.faces.map(f => f.material)).size, 0);
  assert.equal(result.targets - result.generatedTargets, expectedTargets, "Every authored target survives each material split");
  if (deform && authored.nodes.some(n => n.attachment?.mode === "deform"))
    assert.ok(result.generatedTargets > 0, "Animated surface followers need baked geometry targets");
  assert.notEqual(result.frames[0].image, result.frames[1].image);
  for (const frame of result.frames) for (const n of frame.parity) {
    assert.ok(!n.missing && n.positionError < 1e-4 && Math.abs(n.quaternionError) < 1e-4 && n.scaleError < 1e-4,
      `${frame.name} ${JSON.stringify(n)}`);
  }
  for (const frame of result.frames) {
    await writeFile(`${out}/runtime-${frame.name}.png`, Buffer.from(frame.image.split(",")[1], "base64"));
    delete frame.image;
  }
  await writeFile(`${out}/runtime.json`, JSON.stringify({ ...result, errors, renderer: "WebGL software",
    parity: "All author node local transforms and morph weights match at recorded sampled clip poses within 1e-4. Unsampled times are not certified; declared runtime contact coverage is reported separately in runtimeContacts when requested." }, null, 2));
  console.log(`Runtime: ${result.targets} targets, ${result.frames.length} rendered poses, no console errors`);
} finally { await browser.close(); server.close(); }
