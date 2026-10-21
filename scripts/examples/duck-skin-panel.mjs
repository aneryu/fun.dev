import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { launch, serve, watch, local } from "../browser/harness.mjs";

const out = "test-results/duck-skin-panel"; await mkdir(out, { recursive: true });
const project = JSON.parse(await readFile("test-results/duck-mirror-followers/authored.json", "utf8")).project;
const server = await serve(), browser = await launch(), errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await context.route("https://static.fun.dev/**", local(server.base));
  const page = watch(await context.newPage(), errors, 60000);
  await page.goto(`${server.base}/workshop/?renderer=webgl&lang=en`);
  await page.waitForFunction(() => window.funEditor);
  await page.evaluate(p => {
    funEditor.loadProject(p); funEditor.select("duck", { mode: "object" }); funEditor.focus();
    funEditor.apply([{ op: "characterPose", name: "walk", time: .3 }]);
    funEditor.select("wing_left", { mode: "vertex", vertices: [0, 1] });
  }, project);
  const character = page.locator("#character-tools"), panel = character.locator('[data-section="skin"]');
  await character.locator(":scope > summary").click(); await panel.locator(":scope > summary").click();
  const read = () => page.evaluate(() => funEditor.getProject());
  const before = await read(), revision = await page.evaluate(() => funEditor.inspect().revision);
  await page.screenshot({ path: `${out}/weights-before.png` });
  const selects = panel.locator('[data-skin="weights"] select'), inputs = panel.locator('[data-skin="weights"] input');
  await selects.nth(0).selectOption("wing_left_joint"); await inputs.nth(0).fill(".6");
  await selects.nth(1).selectOption("wing_left_tip"); await inputs.nth(1).fill(".3");
  await panel.locator('[data-skin-action="normalize"]').click();
  await panel.locator('[data-skin-action="preview"]').click();
  assert.deepEqual(await read(), before);
  assert.equal(await page.evaluate(() => funEditor.inspect().revision), revision);
  await page.screenshot({ path: `${out}/weights-preview.png` });
  await panel.locator('[data-skin-action="save"]').click();
  const edited = await read(), wing = p => p.nodes.find(n => n.id === "wing_left");
  for (const index of [0, 1]) {
    assert.ok(Math.abs(wing(edited).skin.weights[index][0].weight - 2 / 3) < 1e-10);
    assert.ok(Math.abs(wing(edited).skin.weights[index][1].weight - 1 / 3) < 1e-10);
  }
  assert.deepEqual(wing(edited).skin.weights.slice(2), wing(before).skin.weights.slice(2));
  assert.deepEqual(wing(edited).skin.inverseBind, wing(before).skin.inverseBind);
  assert.deepEqual(edited.character, before.character);
  await page.locator("#undo").click(); assert.deepEqual(await read(), before);
  await page.locator("#redo").click(); assert.deepEqual(await read(), edited);
  await page.evaluate(() => funEditor.select("foot_left", { mode: "object" }));
  await panel.locator('[data-skin="joints"]').selectOption(["leg_left_joint"]);
  await selects.nth(0).selectOption("leg_left_joint"); await inputs.nth(0).fill("1");
  const unbound = await read();
  await panel.locator('[data-skin-action="bind"]').click();
  const bound = await read(), foot = p => p.nodes.find(n => n.id === "foot_left");
  assert.deepEqual(foot(bound).skin.joints, ["leg_left_joint"]);
  assert.ok(foot(bound).skin.weights.every(ws => ws.length === 1 && ws[0].weight === 1));
  foot(bound).mesh.vertices.forEach((p, i) => p.forEach((v, k) =>
    assert.ok(Math.abs(v - foot(unbound).mesh.vertices[i][k]) < 1e-9)));
  await panel.locator('[data-skin-action="unbind"]').click(); assert.equal(foot(await read()).skin, undefined);
  await page.locator("#undo").click(); assert.deepEqual(await read(), bound);
  const saved = await page.evaluate(async () => {
    const exported = await funEditor.exportProject();
    const { importModel } = await import("/workshop/import-glb.js");
    funEditor.loadProject(importModel(Uint8Array.from(atob(exported.data), c => c.charCodeAt(0))).project);
    return { exported, project: funEditor.getProject() };
  });
  assert.deepEqual(saved.project, bound);
  await writeFile(`${out}/duck.funmodel.glb`, Buffer.from(saved.exported.data, "base64"));
  await writeFile(`${out}/authored.json`, JSON.stringify({ project: bound }));
  await page.evaluate(() => funEditor.select("wing_left", { mode: "vertex", vertices: [0, 1] }));
  await page.setViewportSize({ width: 1024, height: 768 }); await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/minimum-desktop.png` });
  assert.deepEqual(errors, []);
  await writeFile(`${out}/result.json`, JSON.stringify({ selectedWeights: true, unaffectedVertices: true, previewIsolated: true,
    initialBinding: true, removeBindingUndo: true, undoRedo: true, editableReload: true, errors }, null, 2));
  console.log("Skin panel: selected weights, binding, preview isolation, undo/redo and exact editable reload passed.");
} finally { await browser.close(); await server.close(); }
