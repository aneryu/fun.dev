import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { launch, serve, watch, local } from "../browser/harness.mjs";

const out = "test-results/duck-character-panel"; await mkdir(out, { recursive: true });
const project = JSON.parse(await readFile("test-results/duck-relations-verified/authored.json", "utf8")).project;
const server = await serve(), browser = await launch(), errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await context.route("https://static.fun.dev/**", local(server.base));
  const page = watch(await context.newPage(), errors, 60000);
  await page.goto(`${server.base}/workshop/?renderer=webgl&lang=zh`);
  await page.waitForFunction(() => window.funEditor);
  await page.evaluate(p => { funEditor.loadProject(p); funEditor.select("head_pose"); }, project);
  const panel = page.locator("#character-tools");
  await panel.locator(":scope > summary").click();
  await panel.locator('[data-field="clip"]').selectOption("walk");
  const before = await page.evaluate(() => JSON.stringify(funEditor.getProject()));
  await panel.locator('[data-action="play"]').click();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => JSON.stringify(funEditor.getProject())), before, "Playback must not mutate the document");
  await page.screenshot({ path: `${out}/playing-desktop.png` });
  await panel.locator('[data-action="play"]').click();
  await panel.locator('[data-field="time"]').evaluate(el => {
    el.value = ".3"; el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await panel.locator(":scope > details:not([data-section]) > summary").click();
  await panel.locator('[data-field="track"]').selectOption("4"); // selected head rotation, after three expression controls
  await panel.locator('[data-field="values"] input').nth(0).fill("12");
  await panel.locator('[data-action="key"]').click();
  const key = () => page.evaluate(() => funEditor.getProject().character.clips.find(c => c.name === "walk")
    .tracks.find(t => t.node === "head_pose" && t.channel === "rotation").keys.find(k => Math.abs(k.time - .3) < 1e-6)?.value[0]);
  assert.equal(await key(), 12);
  await page.locator("#undo").click();
  assert.notEqual(await key(), 12);
  await page.locator("#redo").click();
  assert.equal(await key(), 12);
  await page.screenshot({ path: `${out}/keyframe-desktop.png` });
  const saved = await page.evaluate(async () => {
    const before = funEditor.getProject(), exported = await funEditor.exportProject();
    const { importModel } = await import("/workshop/import-glb.js");
    const bytes = Uint8Array.from(atob(exported.data), c => c.charCodeAt(0));
    funEditor.loadProject(importModel(bytes).project); funEditor.select("head_pose");
    return { before, after: funEditor.getProject(), exported };
  });
  await writeFile(`${out}/reload-before.json`, JSON.stringify(saved.before));
  await writeFile(`${out}/reload-after.json`, JSON.stringify(saved.after));
  assert.deepEqual(saved.after, saved.before);
  saved.preserved = true;
  await writeFile(`${out}/edited.funmodel.glb`, Buffer.from(saved.exported.data, "base64"));
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: `${out}/minimum-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/mobile-limitation.png` });
  assert.deepEqual(errors, []);
  await writeFile(`${out}/result.json`, JSON.stringify({ playbackDoesNotWrite: true, keyframeSetUndoRedo: true,
    editableReload: saved.preserved, errors, mobile: "Existing 1024px desktop-only workbench; no mobile authoring claim" }, null, 2));
  console.log("Character panel: playback isolation, key edit/undo/redo and editable reload passed; no console errors");
} finally { await browser.close(); server.close(); }
