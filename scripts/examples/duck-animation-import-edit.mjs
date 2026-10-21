import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { launch, serve, watch, local } from "../browser/harness.mjs";

const out = "test-results/duck-animation-import"; await mkdir(out, { recursive: true });
const { project } = JSON.parse(await readFile("test-results/duck-skin-import/authored.json", "utf8"));
const server = await serve(), browser = await launch(), errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await context.route("https://static.fun.dev/**", local(server.base));
  const page = watch(await context.newPage(), errors, 60000);
  await page.goto(`${server.base}/workshop/?renderer=webgl&lang=en`);
  await page.waitForFunction(() => window.funEditor);
  await page.evaluate(project => {
    funEditor.loadProject(project); funEditor.select("duck"); funEditor.focus(); funEditor.select("wing_left_joint");
  }, project);
  const panel = page.locator("#character-tools");
  await panel.locator(":scope > summary").click();
  await panel.locator('[data-field="clip"]').selectOption("walk");
  await panel.locator(":scope > details:not([data-section]) > summary").click();
  await panel.locator('[data-field="track"]').selectOption("1");
  assert.equal(await panel.locator('[data-field="interpolation"]').inputValue(), "slerp");
  await panel.locator('[data-field="time"]').evaluate(el => {
    el.value = "0.3"; el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const value = panel.locator('[data-field="values"] input').nth(2);
  const z = Number(await value.inputValue()) + 5;
  await value.fill(String(z)); await panel.locator('[data-action="key"]').click();
  const edited = await page.evaluate(() => funEditor.getProject());
  const track = edited.character.clips.find(c => c.name === "walk").tracks.find(t => t.node === "wing_left_joint" && t.channel === "rotation");
  assert.equal(track.interpolation, "slerp");
  assert.equal(track.keys.find(k => Math.abs(k.time-.3)<1e-6).value[2], z);
  await page.screenshot({ path: `${out}/key-editor.png` });
  await page.locator("#undo").click();
  const undone = await page.evaluate(() => funEditor.getProject());
  assert.deepEqual(undone.character.clips, project.character.clips);
  await page.locator("#redo").click();
  assert.deepEqual(await page.evaluate(() => funEditor.getProject()), edited);
  const saved = await page.evaluate(async () => {
    const exported = await funEditor.exportProject();
    const { importModel } = await import("/workshop/import-glb.js");
    funEditor.loadProject(importModel(Uint8Array.from(atob(exported.data), c=>c.charCodeAt(0))).project);
    return { exported, reloaded: funEditor.getProject() };
  });
  assert.deepEqual(saved.reloaded, edited); assert.deepEqual(errors, []);
  await writeFile(`${out}/authored.json`, JSON.stringify({ project: edited }));
  await writeFile(`${out}/duck.funmodel.glb`, Buffer.from(saved.exported.data, "base64"));
  await writeFile(`${out}/result.json`, JSON.stringify({ importedClips: edited.character.clips.length,
    sphericalKeyEdit: true, undoRedo: true, exactReload: true, errors }, null, 2));
  console.log(`Imported ${edited.character.clips.length} clips: spherical key editing, undo and editable reload passed.`);
} finally { await browser.close(); await server.close(); }
