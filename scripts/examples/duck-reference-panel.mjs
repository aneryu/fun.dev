import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { launch, serve, watch, local } from "../browser/harness.mjs";

const out = "test-results/duck-reference-history";
const { project } = JSON.parse(await readFile(`${out}/authored.json`, "utf8"));
const server = await serve(), browser = await launch(), errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route("https://static.fun.dev/**", local(server.base));
  const page = watch(await context.newPage(), errors);
  await page.goto(`${server.base}/workshop/?renderer=webgl&lang=zh`);
  await page.waitForFunction(() => window.funEditor);
  await page.evaluate(p => { funEditor.loadProject(p); funEditor.focus(); }, project);
  await page.locator("#reference").click();
  await page.getByLabel("已保存的参考版本", { exact: true }).selectOption("duck-front-v1");
  await page.getByRole("button", { name: "应用参考图", exact: true }).click();
  await page.waitForFunction(() => funEditor.getProject().designReferences.selected[0] === "duck-front-v1");
  await page.getByRole("button", { name: "保存当前参考为新版本", exact: true }).click();
  await page.waitForFunction(count => funEditor.getProject().designReferences.records.length === count + 1,
    project.designReferences.records.length);
  const after = await page.evaluate(() => funEditor.getProject());
  assert.deepEqual(after.nodes, project.nodes);
  assert.deepEqual(after.designReferences.selected, ["duck-front-v1"]);
  assert.equal(after.designReferences.records.at(-1).origin, "render");
  await page.screenshot({ path: `${out}/reference-panel-desktop.png` });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.screenshot({ path: `${out}/reference-panel-1024.png` });
  const report = watch(await context.newPage(), errors);
  await report.setViewportSize({ width: 1440, height: 1000 });
  await report.setContent(await readFile(`${out}/comparison.html`, "utf8"));
  const opacity = report.locator('input[type="range"]').first();
  await opacity.fill("75"); await opacity.dispatchEvent("input");
  assert.equal(await opacity.evaluate(el => el.closest("figure").querySelectorAll("img")[1].style.opacity), "0.75");
  await report.screenshot({ path: `${out}/comparison-desktop.png` });
  assert.deepEqual(errors, []);
  await writeFile(`${out}/browser.json`, JSON.stringify({ noConsoleErrors: true, savedVersion: true,
    preservesChosenVersion: true, unchangedGeometry: true, overlayOpacity: .75, widths: [1440, 1024] }, null, 2));
} finally { await browser.close(); server.close(); }
