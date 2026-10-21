import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { launch, serve, watch, local } from "../browser/harness.mjs";

const out = "test-results/duck-joint-panel"; await mkdir(out, { recursive: true });
const project = JSON.parse(await readFile("test-results/duck-skin-panel/authored.json", "utf8")).project;
const server = await serve(), browser = await launch(), errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await context.route("https://static.fun.dev/**", local(server.base));
  const page = watch(await context.newPage(), errors, 60000);
  await page.goto(`${server.base}/workshop/?renderer=webgl&lang=en`);
  await page.waitForFunction(() => window.funEditor);
  await page.evaluate(p => {
    funEditor.loadProject(p); funEditor.apply([{ op: "characterPose" }]);
    funEditor.select("duck", { mode: "object" }); funEditor.focus(); funEditor.select("wing_left_joint");
  }, project);
  const character = page.locator("#character-tools"), panel = character.locator('[data-section="joint"]');
  await character.locator(":scope > summary").click(); await panel.locator(":scope > summary").click();
  const read = () => page.evaluate(() => funEditor.getProject()), before = await read();
  const revision = await page.evaluate(() => funEditor.inspect().revision);
  const joint = p => p.nodes.find(n => n.id === "wing_left_joint");
  await page.screenshot({ path: `${out}/before.png` });
  await panel.locator('[data-joint="position"] input').nth(0).fill(String(joint(before).position[0] + .02));
  await panel.locator('[data-joint-action="preview"]').click();
  assert.deepEqual(await read(), before); assert.equal(await page.evaluate(() => funEditor.inspect().revision), revision);
  await page.screenshot({ path: `${out}/preview.png` });
  await panel.locator('[data-joint-action="save"]').click();
  const edited = await read();
  assert.ok(Math.abs(joint(edited).position[0] - joint(before).position[0] - .02) < 1e-10);
  assert.deepEqual(edited.character.clips, before.character.clips);
  assert.deepEqual(edited.nodes.find(n => n.id === "wing_left").skin.weights,
    before.nodes.find(n => n.id === "wing_left").skin.weights);
  const maxWorldError = await page.evaluate(async ({ a, b }) => {
    const { worldMatrix, point } = await import("/workshop/spatial.js");
    let maximum = 0;
    for (const n of a.nodes.filter(n => n.mesh)) {
      const next = b.nodes.find(o => o.id === n.id);
      n.mesh.vertices.forEach((v, i) => {
        const p = point(worldMatrix(a, n.id), v), q = point(worldMatrix(b, n.id), next.mesh.vertices[i]);
        maximum = Math.max(maximum, Math.hypot(...p.map((x, k) => x - q[k])));
      });
    }
    return maximum;
  }, { a: before, b: edited });
  assert.ok(maxWorldError < 1e-8, String(maxWorldError));
  await page.locator("#undo").click(); assert.deepEqual(await read(), before);
  await page.locator("#redo").click(); assert.deepEqual(await read(), edited);
  await panel.locator('[data-joint="name"]').fill("wing_detail_joint");
  await panel.locator('[data-joint="parent"]').selectOption("wing_left_joint");
  await panel.locator('[data-joint-action="create"]').click();
  const created = (await read()).nodes.find(n => n.id === "wing_detail_joint");
  assert.ok(created.joint); assert.equal(created.parent, "wing_left_joint");
  assert.deepEqual(created.position, [0, 0, 0]);
  const saved = await page.evaluate(async () => {
    const before = funEditor.getProject(), exported = await funEditor.exportProject();
    const { importModel } = await import("/workshop/import-glb.js");
    funEditor.loadProject(importModel(Uint8Array.from(atob(exported.data), c => c.charCodeAt(0))).project);
    return { before, after: funEditor.getProject(), exported };
  });
  assert.deepEqual(saved.after, saved.before);
  await writeFile(`${out}/duck.funmodel.glb`, Buffer.from(saved.exported.data, "base64"));
  await writeFile(`${out}/authored.json`, JSON.stringify({ project: saved.after }));
  await page.evaluate(() => funEditor.select("wing_left_joint"));
  await page.setViewportSize({ width: 1024, height: 768 }); await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/minimum-desktop.png` });
  assert.deepEqual(errors, []);
  await writeFile(`${out}/result.json`, JSON.stringify({ restEdit: true, maxNeutralWorldError: maxWorldError,
    absoluteKeysUnchanged: true, weightsUnchanged: true, jointCreation: true,
    previewIsolated: true, undoRedo: true, editableReload: true, errors }, null, 2));
  console.log(`Joint panel: rest edit, creation and editable reload passed; neutral world error ${maxWorldError}m.`);
} finally { await browser.close(); await server.close(); }
