import assert from "node:assert/strict";
import { resolve } from "node:path";
import { results, watch } from "./harness.mjs";

export async function editorRefinementChecks({ browser, base }) {
  const errors = [],
    context = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      serviceWorkers: "block",
    }),
    page = watch(await context.newPage(), errors);
  try {
    await page.goto(`${base}/editor/?lang=zh`);
    await page.waitForFunction(() => window.funEditor);
    const before = await page.evaluate(async () => {
      const { emptyProject } = await import("/editor/document.js");
      funEditor.loadProject(emptyProject("Refine existing shape"));
      funEditor.apply([
        {
          op: "create",
          id: "part",
          kind: "box",
          options: { size: [0.3, 0.4, 0.2] },
        },
        { op: "pivot", id: "part", offset: [0.02, 0, 0] },
      ]);
      funEditor.select(["part"]);
      return funEditor.getProject().nodes[0];
    });
    await page.locator("#recipe-tools").evaluate((el) => {
      el.open = true;
    });
    await page.locator("#start-recipe").click();
    const promoted = await page.evaluate(() => funEditor.getProject().nodes[0]);
    assert.deepEqual(promoted.mesh, before.mesh);
    assert.deepEqual(promoted.position, before.position);
    assert.equal(promoted.recipe.steps.length, 0);
    await page.locator("#recipe-step-scope .recipe-scope-preview").click();
    await page.locator("#recipe-step-add").click();
    assert.equal(
      await page.evaluate(
        () => funEditor.getRecipe({ id: "part" }).recipe.steps.length,
      ),
      1,
    );
    await page.locator("#recipe-shape").click();
    await page.locator('[name="primitiveSize-1"]').fill("0.6");
    await page.locator("#shape-submit").click();
    const resized = await page.evaluate(() => ({
      recipe: funEditor.getRecipe({ id: "part" }).recipe,
      bounds: funEditor.inspect({ id: "part" }).bounds,
    }));
    assert.equal(resized.recipe.steps.length, 1);
    assert.ok(Math.abs(resized.bounds.size[1] - 0.6) < 1e-9);
    await page.locator("#undo").click();
    assert.ok(
      Math.abs(
        (await page.evaluate(
          () => funEditor.inspect({ id: "part" }).bounds.size[1],
        )) - 0.4,
      ) < 1e-9,
    );
    await page.locator("#redo").click();
    for (const [width, height] of [
      [1024, 768],
      [1920, 1080],
    ]) {
      await page.setViewportSize({ width, height });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: resolve(results, `editor-refinement-${width}.png`),
      });
    }
    await page.evaluate(() => {
      funEditor.apply([
        {
          op: "duplicate",
          id: "part",
          newId: "copy",
          linked: true,
          offset: [0.5, 0, 0],
        },
        { op: "group", ids: ["part", "copy"], newId: "asset" },
        {
          op: "assembly",
          definition: {
            root: "asset",
            parameters: { height: { value: 0.6 } },
            bindings: [{ id: "part", position: [0, 0, 0] }],
          },
        },
      ]);
      funEditor.select(["part"]);
    });
    assert.equal(await page.locator("#recipe-shape").isEnabled(), true);
    await page.locator("#recipe-tools").evaluate((el) => {
      el.open = true;
    });
    await page.locator("#recipe-shape").click();
    await page.locator("#add-dialog").waitFor({ state: "visible" });
    await page.locator('[data-close="add-dialog"]').click();
    await page.evaluate(() => {
      const definition = funEditor.inspect().assemblies[0];
      definition.bindings[0].options = {
        size: [0.3, { $param: "height" }, 0.2],
      };
      funEditor.apply([{ op: "assembly", definition }]);
    });
    assert.equal(await page.locator("#recipe-shape").isDisabled(), true);
    await page.locator('[data-inspector-target="assembly-tools"]').click();
    await page.locator('#assembly-tools [data-parameter="height"]').fill("0.8");
    await page
      .locator("#assembly-tools button")
      .filter({ hasText: "按参数重建" })
      .click();
    const bound = await page.evaluate(async () => {
      await funEditor.flush();
      return {
        height: funEditor.inspect({ id: "copy" }).bounds.size[1],
        project: funEditor.getProject(),
      };
    });
    assert.ok(Math.abs(bound.height - 0.8) < 1e-9);
    await page.reload();
    await page.waitForFunction(() => window.funEditor);
    assert.deepEqual(
      await page.evaluate(() => funEditor.getProject()),
      bound.project,
    );
    assert.equal(await page.evaluate(() => funEditor.validate().ok), true);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  await paintedShapeChecks({ browser, base });
}

export async function paintedShapeChecks({ browser, base }) {
  const errors = [],
    context = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      serviceWorkers: "block",
    }),
    page = watch(await context.newPage(), errors);
  try {
    await page.goto(`${base}/editor/?lang=zh`);
    await page.waitForFunction(() => window.funEditor);
    const initial = await page.evaluate(async () => {
      const { emptyProject } = await import("/editor/document.js");
      funEditor.loadProject(emptyProject("Painted knob"));
      funEditor.apply([
        {
          op: "create",
          id: "knob",
          kind: "cylinder",
          options: { radius: 0.2, height: 0.15, segments: 8 },
        },
      ]);
      const faces = funEditor
        .query({ id: "knob", kind: "faces", normal: [0, 1, 0] })
        .items.map((f) => f.ref);
      funEditor.apply([{ op: "paint", id: "knob", faces, material: "orange" }]);
      funEditor.select(["knob"]);
      await funEditor.flush();
      return {
        project: funEditor.getProject(),
        revision: funEditor.inspect().revision,
      };
    });
    const open = async () => {
      await page.locator("#parameters").click();
      await page.locator("#segments").fill("12");
      await page
        .locator('#shape-recovery [data-paint-repair="rules"]')
        .waitFor({ state: "visible" });
      assert.equal(await page.locator("#shape-submit").isDisabled(), true);
    };
    await open();
    const pending = await page.evaluate(async () => {
      const results = [];
      for (const action of [
        () => funEditor.apply([{ op: "renameProject", name: "Overwrite" }]),
        () => funEditor.loadProject(funEditor.getProject()),
        () => funEditor.undo(),
        () => funEditor.exportGLB(),
      ]) {
        try {
          await action();
          results.push("accepted");
        } catch (e) {
          results.push(e.code);
        }
      }
      return {
        results,
        pending: funEditor.inspect().pendingInput,
        revision: funEditor.inspect().revision,
        project: funEditor.getProject(),
      };
    });
    assert.deepEqual(pending.results, Array(4).fill("pending_input"));
    assert.equal(pending.pending, true);
    assert.equal(pending.revision, initial.revision);
    assert.deepEqual(pending.project, initial.project);
    assert.equal(await page.locator("#segments").inputValue(), "12");
    for (const [width, height] of [
      [1024, 768],
      [1920, 1080],
    ]) {
      await page.setViewportSize({ width, height });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: resolve(results, `editor-shape-paint-recovery-${width}.png`),
      });
    }
    await page.locator('[data-paint-repair="rules"]').click();
    await page.waitForFunction(
      () => !document.querySelector("#shape-submit").disabled,
    );
    assert.deepEqual(
      await page.evaluate(() => funEditor.getProject()),
      initial.project,
    );
    await page.locator('[data-close="add-dialog"]').click();
    assert.deepEqual(
      await page.evaluate(() => funEditor.getProject()),
      initial.project,
    );
    assert.equal(
      await page.evaluate(() => funEditor.inspect().pendingInput),
      false,
    );
    await open();
    await page.locator('[data-paint-repair="rules"]').click();
    await page.waitForFunction(
      () => !document.querySelector("#shape-submit").disabled,
    );
    await page.locator("#shape-submit").click();
    const applied = await page.evaluate(() => ({
      revision: funEditor.inspect().revision,
      project: funEditor.getProject(),
      faces: funEditor.query({ id: "knob", kind: "faces" }).items,
    }));
    assert.equal(applied.revision, initial.revision + 1);
    const colored = applied.faces.filter((f) => f.material === "orange");
    assert.equal(colored.length, 1);
    assert.ok(colored[0].normal[1] > 0.99);
    assert.equal(
      applied.project.nodes[0].recipe.generator.options.segments,
      12,
    );
    await page.locator("#undo").click();
    assert.deepEqual(
      await page.evaluate(() => funEditor.getProject()),
      initial.project,
    );
    await open();
    await page.locator('[data-paint-repair="clear"]').click();
    await page.waitForFunction(
      () => !document.querySelector("#shape-submit").disabled,
    );
    await page.locator("#shape-submit").click();
    assert.ok(
      await page.evaluate(() =>
        funEditor
          .getProject()
          .nodes[0].mesh.faces.every((f) => f.material === "yellow"),
      ),
    );
    await page.locator("#undo").click();
    await page.locator("#parameters").click();
    await page.locator("#height").fill(".25");
    await page.locator("#shape-submit").click();
    assert.equal(
      await page.evaluate(
        () =>
          funEditor.query({ id: "knob", kind: "faces", normal: [0, 1, 0] })
            .items[0].material,
      ),
      "orange",
    );
    await page.evaluate(() => funEditor.flush());
    const final = await page.evaluate(() => funEditor.getProject());
    await page.reload();
    await page.waitForFunction(() => window.funEditor);
    assert.deepEqual(await page.evaluate(() => funEditor.getProject()), final);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
