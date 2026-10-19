import assert from "node:assert/strict";
import { resolve } from "node:path";
import { results, watch } from "./harness.mjs";

export async function editorMaterialChecks({ browser, base }) {
  const errors = [],
    context = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      serviceWorkers: "block",
    }),
    page = watch(await context.newPage(), errors);
  try {
    await page.goto(`${base}/workshop/?lang=zh`);
    await page.waitForFunction(() => window.funEditor);
    await page.evaluate(async () => {
      funEditor.loadProject(
        (await import("/workshop/document.js")).emptyProject(
          "Material iteration",
        ),
      );
      funEditor.apply(
        Array.from({ length: 27 }, (_, i) => ({
          op: "material",
          id: `draft-${i}`,
          color: "#112233",
        })),
      );
    });
    await page.locator("#material-library").click();
    assert.equal(await page.locator("#library-material option").count(), 32);
    await page.locator("#library-purge").click();
    assert.equal(await page.locator("#library-material option").count(), 1);
    assert.equal(await page.locator("#library-remove").isDisabled(), true);
    await page.locator('[data-close="info-dialog"]').click();
    await page.locator("#undo").click();
    assert.equal(
      await page.evaluate(() => funEditor.inspect().materials.length),
      32,
    );
    await page.locator("#redo").click();
    await page.evaluate(() => {
      funEditor.apply([
        { op: "material", id: "blue", color: "#112233" },
        { op: "material", id: "retained", color: "#cc8844" },
        { op: "material", id: "final", name: "Final walnut", color: "#664422" },
        { op: "create", id: "body", kind: "box", material: "blue" },
        {
          op: "recipeStep",
          id: "body",
          action: "append",
          step: { op: "paint", material: "retained", enabled: false },
        },
        { op: "paint", id: "body", material: "final" },
        {
          op: "duplicate",
          id: "body",
          newId: "copy",
          linked: true,
          offset: [1.4, 0, 0],
        },
      ]);
      funEditor.select("body");
    });
    await page.locator("#manage-materials").click();
    await page.locator("#library-material").selectOption("retained");
    assert.equal(await page.locator("#library-remove").isDisabled(), true);
    const retained = await page.evaluate(() =>
      funEditor.inspect().materials.find((m) => m.id === "retained"),
    );
    assert.deepEqual(retained.users, []);
    assert.deepEqual(retained.retainedBy, ["body"]);
    await page.locator("#library-material").selectOption("blue");
    await page.locator("#library-replacement").selectOption("final");
    await page.locator("#library-replace").click();
    assert.equal(await page.locator("#library-material").inputValue(), "final");
    assert.equal(
      await page.evaluate(
        () => funEditor.getProject().nodes[0].recipe.generator.material,
      ),
      "final",
    );
    // A stale, already displayed cleanup cannot operate on a changed project.
    await page.evaluate(() =>
      funEditor.apply([{ op: "renameProject", name: "Concurrent change" }]),
    );
    await page.locator("#library-purge").click();
    assert.match(
      await page.locator("#library-error").textContent(),
      /工程已发生变化/,
    );
    assert.equal(
      await page.evaluate(() => funEditor.inspect().materials.length),
      3,
    );
    await page.locator('[data-close="info-dialog"]').click();
    await page.locator("#material-library").click();
    await page.locator("#library-purge").click();
    assert.deepEqual(
      await page.evaluate(() => funEditor.inspect().materials.map((m) => m.id)),
      ["retained", "final"],
    );
    for (const width of [1024, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: resolve(results, `editor-materials-${width}.png`),
      });
    }
    await page.locator('[data-close="info-dialog"]').click();
    const saved = await page.evaluate(async () => {
      await funEditor.flush();
      return funEditor.getProject();
    });
    await page.reload();
    await page.waitForFunction(() => window.funEditor);
    assert.deepEqual(await page.evaluate(() => funEditor.getProject()), saved);
    const exported = await page.evaluate(async () => {
      const { GLTFLoader } = await import("/runtime/addons/GLTFLoader.js");
      const { scene } = await new GLTFLoader().parseAsync(
        await funEditor.exportGLB(),
        "",
      );
      const meshes = [];
      scene.traverse((n) => {
        if (n.isMesh)
          meshes.push({
            name: n.name,
            material: n.material.name,
            color: n.material.color.getHexString(),
          });
      });
      return {
        meshes,
        valid: funEditor.validate().ok,
        renderer: funEditor.inspect().renderer,
      };
    });
    assert.equal(exported.valid, true);
    assert.equal(exported.meshes.length, 2);
    assert.ok(
      exported.meshes.every(
        (m) => m.material === "final" && m.color === "664422",
      ),
      JSON.stringify(exported),
    );
    // Full metal reflects the ambient sky instead of rendering black.
    const metal = await page.evaluate(async () => {
      funEditor.loadProject(
        (await import("/workshop/document.js")).emptyProject("Chrome"),
      );
      funEditor.apply([
        {
          op: "material",
          id: "chrome",
          color: "#949aa1",
          roughness: 0.25,
          metalness: 1,
        },
        { op: "create", id: "ball", kind: "sphere", material: "chrome" },
      ]);
      const [shot] = funEditor.renderViews(["perspective"], { size: 128 }),
        image = new Image();
      image.src = shot.dataUrl;
      await image.decode();
      const context = new OffscreenCanvas(128, 128).getContext("2d");
      context.drawImage(image, 0, 0);
      return [...context.getImageData(64, 64, 1, 1).data.slice(0, 3)];
    });
    assert.ok(Math.max(...metal) > 60, `chrome renders ${metal}`);
    assert.deepEqual(errors, []);
    return exported;
  } finally {
    await context.close();
  }
}
