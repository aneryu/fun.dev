import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { launch, serve, watch, local } from "../browser/harness.mjs";
const out = "test-results/duck-view-presets";
const { project } = JSON.parse(await readFile(`${out}/authored.json`, "utf8"));
const server = await serve(), browser = await launch(), errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route("https://static.fun.dev/**", local(server.base));
  const page = watch(await context.newPage(), errors);
  await page.goto(`${server.base}/workshop/?renderer=webgl&lang=zh`);
  await page.waitForFunction(() => window.funEditor);
  await page.evaluate(p => { funEditor.loadProject(p); funEditor.focus(); }, project);
  await page.locator("#screenshot").click();
  await page.locator("#view-preset-select").selectOption("eyes");
  const expected = await page.evaluate(() => funEditor.renderViews(undefined, { preset: "eyes" })[0]);
  const downloaded = page.waitForEvent("download"); await page.locator("#preview-save").click();
  await (await downloaded).saveAs(`${out}/eyes-from-ui.png`);
  assert.equal((await readFile(`${out}/eyes-from-ui.png`)).toString("base64"), expected.dataUrl.split(",")[1]);
  await page.locator("#screenshot").click();
  await page.locator("#view-preset-name").fill("manual-current");
  await page.locator("#preview-size").selectOption("300");
  await page.locator("#preview-aa").selectOption("native");
  await page.locator("#view-preset-save").click();
  await page.waitForFunction(() => funEditor.getProject().viewPresets.some(p => p.id === "manual-current"));
  assert.equal(await page.locator("#preview-size").isDisabled(), true);
  const before = await page.evaluate(() => funEditor.renderViews(undefined, { preset: "manual-current" })[0]);
  await page.screenshot({ path: `${out}/preset-panel-desktop.png` });
  await page.setViewportSize({ width: 1024, height: 900 });
  const after = await page.evaluate(() => funEditor.renderViews(undefined, { preset: "manual-current" })[0]);
  assert.equal(after.width, before.width); assert.equal(after.height, before.height);
  assert.deepEqual(after.camera, before.camera);
  assert.equal(after.dataUrl, before.dataUrl);
  await page.screenshot({ path: `${out}/preset-panel-1024.png` });
  assert.deepEqual(errors, []);
  await writeFile(`${out}/browser.json`, JSON.stringify({ noConsoleErrors: true, downloadedPreset: "eyes",
    manualPreset: "manual-current", width: after.width, height: after.height, identicalAfterWindowResize: true }, null, 2));
} finally { await browser.close(); server.close(); }
