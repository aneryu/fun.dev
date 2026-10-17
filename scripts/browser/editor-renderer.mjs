import assert from "node:assert/strict";
import { resolve } from "node:path";
import { results, watch } from "./harness.mjs";

export async function editorRendererChecks({ browser, base, expectedBackend }) {
  for (const mode of ["auto", "forced", "unavailable", "adapter-missing"]) {
    const errors = [],
      context = await browser.newContext({
        viewport: { width: 1024, height: 768 },
        serviceWorkers: "block",
      });
    try {
      if (mode === "unavailable")
        await context.addInitScript(() => {
          Object.defineProperty(navigator, "gpu", { value: undefined });
        });
      if (mode === "adapter-missing")
        await context.addInitScript(() => {
          Object.defineProperty(navigator, "gpu", {
            value: {
              requestAdapter() {
                if (window.delayPreview) {
                  window.previewStarted = true;
                  return new Promise((resolve) => {
                    window.releasePreview = () => resolve(null);
                  });
                }
                return Promise.resolve(null);
              },
            },
          });
        });
      const page = watch(await context.newPage(), errors);
      await page.goto(
        `${base}/editor/?lang=zh${mode === "forced" ? "&renderer=webgl" : ""}`,
      );
      await page.waitForFunction(() => window.funEditor);
      const info = await page.evaluate(() => funEditor.inspect().renderer);
      assert.ok(["webgpu", "webgl2"].includes(info.backend));
      if (mode !== "auto" || expectedBackend)
        assert.equal(
          info.backend,
          mode === "auto" ? expectedBackend : "webgl2",
        );
      assert.equal(info.requested, mode === "forced" ? "webgl2" : "auto");
      assert.equal(
        info.fallback,
        mode !== "forced" && info.backend === "webgl2",
      );
      assert.equal(
        (await page.locator("#renderer-label").textContent()).toLowerCase(),
        info.backend,
      );
      const shots = await page.evaluate(() =>
        funEditor.renderViews(["front", "perspective"], { size: 256 }),
      );
      assert.ok(
        shots.every(
          (s) => s.width === 256 && s.height === 256 && s.dataUrl.length > 5000,
        ),
      );
      assert.notEqual(shots[0].dataUrl, shots[1].dataUrl);
      if (mode === "adapter-missing") {
        await page.evaluate(() => {
          window.delayPreview = true;
        });
        await page.locator("#parameters").click();
        await page.waitForFunction(() => window.previewStarted);
        await page.locator('[data-close="add-dialog"]').click();
        await page.evaluate(() => {
          window.delayPreview = false;
        });
      }
      await page.locator("#parameters").click();
      await page.waitForFunction(
        () => !document.querySelector("#shape-submit").disabled,
      );
      if (mode === "adapter-missing")
        await page.evaluate(() => window.releasePreview());
      assert.equal(
        await page.locator("#shape-canvas").getAttribute("data-renderer"),
        info.backend,
      );
      await page.locator("#radius").fill("1.1");
      await page.locator("#shape-submit").click();
      assert.equal(
        await page.evaluate(
          () =>
            funEditor.getProject().nodes.find((n) => n.id === "body").generator
              .options.radius,
        ),
        1.1,
      );
      await page.locator("#undo").click();
      assert.equal(
        await page.evaluate(() => funEditor.inspect().pendingInput),
        false,
      );
      await page.screenshot({
        path: resolve(results, `editor-renderer-${mode}-${info.backend}.png`),
      });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}
