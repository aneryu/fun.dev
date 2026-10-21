// Ordinary GLB (without the editable source extension), imported in isolation.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { launch, serve, watch, local } from "../browser/harness.mjs";

const out = "test-results/duck-skin-import"; await mkdir(out, { recursive: true });
const { project } = JSON.parse(await readFile("test-results/duck-joint-panel/authored.json", "utf8"));
const server = await serve(), browser = await launch(), errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await context.route("https://static.fun.dev/**", local(server.base));
  const page = watch(await context.newPage(), errors, 60000);
  await page.exposeFunction("reportImportPhase", phase => process.stderr.write(`${phase}\n`));
  await page.goto(`${server.base}/workshop/?renderer=webgl&lang=en`);
  await page.waitForFunction(() => window.funEditor);
  const result = await page.evaluate(async project => {
    const { importModel } = await import("/workshop/import-glb.js");
    const { createStore, evaluateProject } = await import("/workshop/document.js");
    const { worldMatrix, point } = await import("/workshop/spatial.js");
    const { resolveViewPreset } = await import("/workshop/view-presets.js");
    funEditor.loadProject(project);
    await window.reportImportPhase("Exporting source duck");
    const source = funEditor.getProject(), exported = await funEditor.exportGLB({ encoding: "base64" });
    const imported = importModel(Uint8Array.from(atob(exported.data), c => c.charCodeAt(0)));
    const store = createStore(imported.project);
    await window.reportImportPhase("Imported skin and animation data");
    const compare = (a, b) => a.nodes.filter(n => n.skin).map(n => {
      const next = b.nodes.find(x => x.id === n.id);
      if (!next?.skin) throw new Error(`Missing skin ${n.id}`);
      const expected = n.mesh.vertices.map(v => point(worldMatrix(a, n.id), v));
      const maximumError = Math.max(...next.mesh.vertices.map(v => {
        const actual = point(worldMatrix(b, next.id), v);
        return Math.min(...expected.map(p => Math.hypot(...p.map((x, k) => x - actual[k]))));
      }));
      if (maximumError > 1e-6) throw new Error(`Skin geometry mismatch ${n.id}: ${maximumError}`);
      return { node: n.id, sourceVertices: n.mesh.vertices.length, importedVertices: next.mesh.vertices.length, maximumError };
    });
    const neutral = compare(source, store.snapshot()), shots = [];
    const poses = [];
    for (const clip of source.character.clips) {
      const time = clip.duration * .37;
      const a = structuredClone(source), b = store.snapshot();
      a.character.pose = { clip: clip.name, time }; b.character.pose = { clip: clip.name, time };
      const expected = evaluateProject(a), actual = evaluateProject(b);
      let maximumError = 0;
      for (const n of expected.nodes.filter(n => n.mesh)) {
        const next = actual.nodes.find(x => x.id === n.id);
        if (!next?.mesh) throw new Error(`Missing animated geometry ${n.id}`);
        const vertices = n.mesh.vertices.map(v => point(worldMatrix(expected, n.id), v));
        for (const v of next.mesh.vertices) {
          const p = point(worldMatrix(actual, next.id), v);
          maximumError = Math.max(maximumError, Math.min(...vertices.map(q => Math.hypot(...q.map((x,k)=>x-p[k])))));
        }
      }
      if (maximumError > .001) throw new Error(`Imported clip ${clip.name} error ${maximumError}m`);
      poses.push({ clip: clip.name, time, maximumError });
      await window.reportImportPhase(`Compared ${clip.name}: ${maximumError}m`);
    }
    for (const id of ["character-front", "character-left", "character-perspective"]) {
      const preset = resolveViewPreset(source, id);
      funEditor.loadProject(source);
      const [before] = funEditor.renderViews([preset.view], { size: preset.size, ...preset.render });
      funEditor.loadProject(store.snapshot());
      const [after] = funEditor.renderViews([preset.view], { size: preset.size, ...preset.render });
      shots.push({ id, before: before.dataUrl, after: after.dataUrl });
    }
    const authored = createStore(source);
    const command = { op: "set", id: "wing_left_tip", rotation: [0, 0, 25] };
    // Use the actual palette joint, without assuming a character-specific id.
    command.id = source.nodes.find(n => n.id === "wing_left").skin.joints.at(-1);
    authored.apply([command]); store.apply([command]);
    const edited = compare(authored.snapshot(), store.snapshot());
    const reloaded = evaluateProject(JSON.parse(JSON.stringify(store.snapshot())));
    await window.reportImportPhase("Multi-view rendering and joint edit checked; exporting imported source");
    funEditor.loadProject(reloaded);
    const saved = await funEditor.exportProject();
    const reopened = evaluateProject(importModel(Uint8Array.from(atob(saved.data), c => c.charCodeAt(0))).project);
    const roundtrip = await funEditor.workflow({ action: "verifyExport" });
    await window.reportImportPhase("Editable and runtime export verification complete");
    return { neutral, edited, poses, shots, warnings: imported.warnings, processing: imported.processing,
      imported: store.snapshot(), reloaded, reopened, saved, roundtrip };
  }, project);
  assert.equal(result.neutral.length, 6);
  assert.deepEqual(result.imported, result.reloaded);
  assert.deepEqual(result.reloaded, result.reopened);
  assert.equal(result.roundtrip.editable.integrity.exact, true);
  assert.equal(result.warnings.some(w => w.code === "animations"), false);
  assert.equal(result.poses.length, project.character.clips.length);
  assert.deepEqual(errors, []);
  for (const shot of result.shots) for (const side of ["before", "after"])
    await writeFile(`${out}/${shot.id}-${side}.png`, Buffer.from(shot[side].split(",")[1], "base64"));
  await writeFile(`${out}/duck.funmodel.glb`, Buffer.from(result.saved.data, "base64"));
  await writeFile(`${out}/authored.json`, JSON.stringify({ project: result.reloaded }));
  const { shots, saved, imported, reloaded, reopened, ...report } = result;
  await writeFile(`${out}/result.json`, JSON.stringify({ ...report, errors }, null, 2));
  console.log(JSON.stringify({ out, neutral: result.neutral, edited: result.edited, warnings: result.warnings }));
} finally { await browser.close(); await server.close(); }
