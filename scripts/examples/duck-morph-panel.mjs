import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { launch, serve, watch, local } from "../browser/harness.mjs";

const out = "test-results/duck-morph-panel"; await mkdir(out, { recursive: true });
const project = JSON.parse(await readFile("test-results/duck-mirror-followers/authored.json", "utf8")).project;
const server = await serve(), browser = await launch(), errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await context.route("https://static.fun.dev/**", local(server.base));
  const page = watch(await context.newPage(), errors, 60000);
  await page.goto(`${server.base}/workshop/?renderer=webgl&lang=en`);
  await page.waitForFunction(() => window.funEditor);
  await page.evaluate(p => { funEditor.loadProject(p); funEditor.select("head_pose", { mode: "object" }); funEditor.focus();
    funEditor.select("eye_right", { mode: "vertex", vertices: [0] }); }, project);
  const character = page.locator("#character-tools"), panel = character.locator('[data-section="morph"]');
  await character.locator(":scope > summary").click();
  await panel.locator(":scope > summary").click();
  await panel.locator('[data-morph="target"]').selectOption("smile");
  await panel.locator('[data-morph="name"]').fill("smile_detail");
  await panel.locator('[data-morph-action="copy"]').click();
  const read = () => page.evaluate(() => funEditor.getProject());
  const copied = await read(), eye = p => p.nodes.find(n => n.id === "eye_right");
  assert.deepEqual(eye(copied).morph.targets.find(t => t.name === "smile_detail").deltas,
    eye(copied).morph.targets.find(t => t.name === "smile").deltas);
  await panel.locator('[data-morph-action="preview"]').click();
  await page.screenshot({ path: `${out}/before-desktop.png` });
  const revision = await page.evaluate(() => funEditor.inspect().revision);
  await panel.locator('[data-morph="move"] input').nth(0).fill(".005");
  await panel.locator('[data-morph-action="preview"]').click();
  assert.deepEqual(await read(), copied, "Preview must not write model/history");
  assert.equal(await page.evaluate(() => funEditor.inspect().revision), revision);
  await page.screenshot({ path: `${out}/preview-desktop.png` });
  await panel.locator('[data-morph-action="save"]').click();
  const edited = await read();
  const delta = p => eye(p).morph.targets.find(t => t.name === "smile_detail").deltas;
  assert.ok(Math.abs(delta(edited)[0][0] - delta(copied)[0][0] - .005) < 1e-10);
  assert.deepEqual(delta(edited).slice(1), delta(copied).slice(1));
  assert.deepEqual(edited.character, copied.character);
  assert.deepEqual(eye(edited).morph.base, eye(copied).morph.base);
  await page.locator("#undo").click(); assert.deepEqual(await read(), copied);
  await page.locator("#redo").click(); assert.deepEqual(await read(), edited);
  const saved = await page.evaluate(async () => {
    const exported = await funEditor.exportProject();
    const { importModel } = await import("/workshop/import-glb.js");
    const bytes = Uint8Array.from(atob(exported.data), c => c.charCodeAt(0));
    funEditor.loadProject(importModel(bytes).project);
    return { exported, project: funEditor.getProject() };
  });
  assert.deepEqual(saved.project, edited);
  await writeFile(`${out}/edited.funmodel.glb`, Buffer.from(saved.exported.data, "base64"));
  await writeFile(`${out}/authored.json`, JSON.stringify({ project: edited }));
  await page.evaluate(() => funEditor.select("eye_right", { mode: "vertex", vertices: [0] }));
  await character.locator('[data-field="clip"]').selectOption("walk");
  const playingSource = await read();
  await character.locator('[data-action="play"]').click();
  await panel.locator('[data-morph-action="preview"]').click();
  assert.equal(await character.locator('[data-action="play"]').textContent(), "Play preview");
  assert.deepEqual(await read(), playingSource);
  await panel.locator('[data-morph-action="restore"]').click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/minimum-desktop.png` });
  assert.deepEqual(errors, []);
  await writeFile(`${out}/result.json`, JSON.stringify({ targetCopy: true, selectedVertexEdit: true,
    previewIsolated: true, playbackStoppedForTargetPreview: true,
    otherVerticesAndControllersPreserved: true, undoRedo: true, editableReload: true, errors }, null, 2));
  console.log("Morph panel: copy, selected vertex preview/edit, undo/redo and editable reload passed.");
} finally { await browser.close(); await server.close(); }
