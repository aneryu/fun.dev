import assert from "node:assert/strict";
import { resolve } from "node:path";
import { results, watch } from "./harness.mjs";

export async function editorDeliveryChecks({ browser, base }) {
  const errors = [],
    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      serviceWorkers: "block",
      acceptDownloads: true,
    });
  const page = watch(await context.newPage(), errors);
  try {
    await page.goto(`${base}/editor/?lang=zh`);
    await page.waitForFunction(() => window.funEditor);
    await page.evaluate(async () =>
      funEditor.loadProject(
        (await import("/editor/document.js")).emptyProject("Millimeter panel"),
      ),
    );
    await page.locator("#length-unit").selectOption("mm");
    await page.locator("#snap-step").selectOption("0.001");
    await page.locator("#add").click();
    await page.locator("#kind").selectOption("extrude");
    await page.locator("#outline").fill("0, 0\n20, 0\n20, 10\n0, 10");
    await page.locator("#outline").dispatchEvent("change");
    await page.locator("#depth").fill("2");
    await page.locator("#depth").dispatchEvent("input");
    await page.locator('#profile-editor [data-point="0"]').press("ArrowRight");
    assert.equal(await page.locator("#profile-x").inputValue(), "1");
    await page.locator("#profile-undo").click();
    await page.locator("#shape-submit").click();
    const size = await page.evaluate(
      () => funEditor.inspect({ id: "extrude-1" }).bounds.size,
    );
    [0.02, 0.01, 0.002].forEach((n, i) =>
      assert.ok(Math.abs(size[i] - n) < 1e-9),
    );
    await page.locator("#length-unit").selectOption("cm");
    await page.evaluate(() =>
      funEditor.apply([
        { op: "create", id: "other", kind: "box", position: [10, 0, 0] },
      ]),
    );
    await page.locator("#parameters").click();
    assert.equal(
      await page.locator("#outline").inputValue(),
      "0, 0\n2, 0\n2, 1\n0, 1",
    );
    assert.equal(await page.locator("#depth").inputValue(), "0.2");
    await page.waitForFunction(() =>
      document
        .querySelector("#shape-preview-status")
        .textContent.endsWith("2 × 1 × 0.2 cm"),
    );
    await page.locator("#shape-submit").click();
    assert.deepEqual(
      await page.evaluate(
        () => funEditor.inspect({ id: "extrude-1" }).bounds.size,
      ),
      size,
    );
    await page.evaluate(() =>
      funEditor.apply([
        { op: "convert", id: "extrude-1" },
        {
          op: "recipeStep",
          id: "extrude-1",
          action: "append",
          step: { op: "cut", axis: "x", offset: 0.01 },
        },
      ]),
    );
    assert.equal(await page.locator("#parameters").isVisible(), false);
    await page.locator("#convert").click();
    assert.equal(
      await page.evaluate(() => !!funEditor.getProject().nodes[0].recipe),
      false,
    );
    await page.locator("#undo").click();
    assert.equal(
      await page.evaluate(
        () => funEditor.getProject().nodes[0].recipe.generator.kind,
      ),
      "mesh",
    );

    const parity = await page.evaluate(async () => {
      const { emptyProject } = await import("/editor/document.js");
      funEditor.loadProject(emptyProject("Delivery cases"));
      funEditor.apply(funEditor.presets().toolbox);
      const commands = [{ op: "set", id: "toolbox", position: [100, 0, 0] }];
      const before = JSON.stringify(funEditor.getProject());
      const preview = funEditor.preview(commands, {
        views: ["perspective"],
        size: 384,
      });
      const unchanged = before === JSON.stringify(funEditor.getProject());
      funEditor.apply(commands);
      const committed = funEditor.renderViews(["perspective"], {
        size: 384,
        helpers: false,
        visibility: "all",
      })[0];
      return {
        unchanged,
        camera: committed.camera,
        previewCamera: preview.observations[0].camera,
        equal: committed.dataUrl === preview.observations[0].dataUrl,
      };
    });
    assert.ok(parity.unchanged);
    assert.deepEqual(parity.camera, parity.previewCamera);
    assert.ok(
      parity.equal,
      "preview lighting and committed lighting must match",
    );

    const exported = await page.evaluate(async () => {
      const { GLTFLoader } = await import("/runtime/addons/GLTFLoader.js"),
        THREE = await import("/runtime/three.js");
      funEditor.apply([
        {
          op: "create",
          id: "layout",
          kind: "group",
          position: [8, 1, -2],
          rotation: [0, 35, 0],
          scale: [1.2, 1, 0.8],
        },
        {
          op: "set",
          id: "toolbox",
          parent: "layout",
          keepWorld: false,
          position: [2, 0, 0],
        },
      ]);
      const original = JSON.stringify(funEditor.getProject()),
        outputs = {};
      for (const origin of ["world", "asset-root", "ground-center"]) {
        const options = { ids: ["toolbox"], origin };
        const { scene } = await new GLTFLoader().parseAsync(
          await funEditor.exportGLB(options),
          "",
        );
        scene.updateMatrixWorld(true);
        const positions = {};
        scene.traverse((o) => {
          if (o.isMesh)
            positions[o.name] = new THREE.Vector3()
              .setFromMatrixPosition(o.matrixWorld)
              .toArray();
        });
        const box = new THREE.Box3().setFromObject(scene, true);
        outputs[origin] = {
          report: funEditor.exportReport(options),
          positions,
          min: box.min.toArray(),
          max: box.max.toArray(),
          hinge: scene.getObjectByName("hinge").quaternion.toArray(),
        };
      }
      let rejected = false;
      try {
        funEditor.exportReport({ origin: "asset-root" });
      } catch {
        rejected = true;
      }
      return {
        outputs,
        unchanged: original === JSON.stringify(funEditor.getProject()),
        rejected,
      };
    });
    assert.ok(exported.unchanged && exported.rejected);
    const world = exported.outputs.world;
    for (const mode of ["asset-root", "ground-center"]) {
      const out = exported.outputs[mode];
      assert.deepEqual(out.hinge, world.hinge);
      for (const [id, position] of Object.entries(out.positions))
        position.forEach((v, i) =>
          assert.ok(
            Math.abs(v + out.report.origin.point[i] - world.positions[id][i]) <
              1e-5,
          ),
        );
      out.min.forEach((v, i) =>
        assert.ok(Math.abs(v - out.report.bounds.min[i]) < 1e-5),
      );
    }
    const ground = exported.outputs["ground-center"];
    assert.ok(Math.abs(ground.min[1]) < 1e-6);
    for (const i of [0, 2])
      assert.ok(Math.abs(ground.min[i] + ground.max[i]) < 1e-6);
    await page.evaluate(() => {
      funEditor.select("toolbox");
      funEditor.view();
    });
    await page.locator("#export").click();
    await page.locator("#export-scope").selectOption("selection");
    await page.locator("#export-origin").selectOption("asset-root");
    await page.screenshot({
      path: resolve(results, "editor-export-origin.png"),
    });
    const download = page.waitForEvent("download");
    await page.locator("#export-confirm").click();
    assert.match((await download).suggestedFilename(), /\.glb$/);
    await page.evaluate(() => funEditor.select("body"));
    await page.locator('[data-inspector-target="recipe-tools"]').click();
    assert.ok(await page.locator("#recipe-tools").evaluate((el) => el.open));
    assert.equal(await page.locator(".recipe-step[open]").count(), 1);
    await page.locator("#length-unit").selectOption("mm");
    assert.equal(
      await page
        .locator('.recipe-step[data-step="0"] input[type="number"]')
        .count(),
      0,
    ); // expression remains driven
    assert.equal(
      await page
        .locator('.recipe-step[data-step="0"] input[readonly]')
        .inputValue(),
      "35",
    );
    for (const [width, height] of [
      [1024, 768],
      [1366, 768],
      [1920, 1080],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: resolve(results, `editor-delivery-${width}.png`),
      });
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
