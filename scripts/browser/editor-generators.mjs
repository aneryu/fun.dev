import assert from "node:assert/strict";
import { resolve } from "node:path";
import { results, watch } from "./harness.mjs";

// The add-shape dialog builds revolved sections and sweeps, edits them again, and the parts
// panel's Array control repeats the selection.
export async function editorGeneratorChecks({ browser, base }) {
  const errors = [],
    context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      serviceWorkers: "block",
    }),
    page = watch(await context.newPage(), errors);
  const submit = async () => {
    await page.waitForFunction(() => !document.querySelector("#shape-submit").disabled);
    await page.locator("#shape-submit").click();
    await page.waitForFunction(() => !document.querySelector("#add-dialog").open);
  };
  try {
    await page.goto(`${base}/editor/?lang=en`);
    await page.waitForFunction(() => window.funEditor);
    await page.evaluate(async () =>
      funEditor.loadProject(
        (await import("/editor/document.js")).emptyProject("Generators"),
        { ifRevision: funEditor.inspect().revision },
      ),
    );
    // A quarter elbow from the default ring section.
    await page.locator("#add").click();
    await page.locator("#kind").selectOption("revolve");
    for (const field of ["outline", "segment", "round", "angle"])
      assert.equal(await page.locator(`#${field}-field`).isHidden(), false, field);
    assert.equal(await page.locator("#path-field").isHidden(), true);
    await page.locator("#angle").fill("90");
    await page.locator("#angle").dispatchEvent("change");
    await submit();
    const elbow = await page.evaluate(() => funEditor.inspect().selection.id);
    let node = await page.evaluate((id) => funEditor.inspect({ id }).node, elbow);
    assert.equal(node.generator.kind, "revolve");
    assert.equal(node.generator.options.angle, 90);
    // Its parameters reopen with the same angle and change in place.
    await page.locator("#parameters").click();
    assert.equal(await page.locator("#angle").inputValue(), "90");
    await page.locator("#angle").fill("180");
    await page.locator("#angle").dispatchEvent("change");
    await submit();
    node = await page.evaluate((id) => funEditor.inspect({ id }).node, elbow);
    assert.equal(node.generator.options.angle, 180);
    // A smoothed rail along the default path.
    await page.locator("#add").click();
    await page.locator("#kind").selectOption("sweep");
    assert.equal(await page.locator("#path-field").isHidden(), false);
    await submit();
    const rail = await page.evaluate(() => funEditor.inspect().selection.id);
    node = await page.evaluate((id) => funEditor.inspect({ id }).node, rail);
    assert.equal(node.generator.kind, "sweep");
    assert.equal(node.generator.options.smooth, true);
    assert.ok(node.generator.options.path.length >= 2);
    // Three linked rails, one metre apart.
    await page.locator("#array-tools summary").click();
    await page.locator("#array-count").fill("3");
    await page.locator('[data-vector="arrayOffset"] input').first().fill("1");
    await page.locator("#array-apply").click();
    const ids = await page.evaluate(() => funEditor.inspect().nodes.map((n) => n.id));
    assert.ok(ids.includes(`${rail}_2`) && ids.includes(`${rail}_3`), JSON.stringify(ids));
    const third = await page.evaluate((id) => funEditor.inspect({ id }).node, `${rail}_3`);
    assert.equal(third.instanceOf, rail);
    const validation = await page.evaluate(() => funEditor.validate());
    assert.deepEqual(validation.errors, []);
    await page.screenshot({ path: resolve(results, "editor-generators.png") });
    assert.deepEqual(errors, []);
    // Blueprints: a parametric family builds through the page API, re-derives through its asset
    // parameters, and exports a library-ready GLB.
    const blueprint = await page.evaluate(async () => {
      funEditor.loadProject((await import("/editor/document.js")).emptyProject("Blueprints"), { ifRevision: funEditor.inspect().revision });
      const listed = funEditor.blueprints().map((b) => b.id);
      funEditor.apply([{ op: "blueprint", id: "lamp-post", params: { height: 7, arms: 2 }, root: "lamp" }], { ifRevision: funEditor.inspect().revision });
      const tall = funEditor.inspect({ id: "lamp" }).bounds;
      funEditor.apply([{ op: "assemblyParameters", root: "lamp", values: { height: 4 } }], { ifRevision: funEditor.inspect().revision });
      const short = funEditor.inspect({ id: "lamp" }).bounds;
      const exported = await funEditor.exportGLB({ encoding: "base64", origin: "ground-center", rootName: "lamp_ROOT", mergeStatic: "auto" });
      return { listed, tall, short, stamp: funEditor.inspect().assemblies[0].blueprint, bytes: exported.data.length, validation: funEditor.validate().errors.length };
    });
    assert.deepEqual(blueprint.listed, ["lamp-post", "railing", "building-block"]);
    assert.ok(Math.abs(blueprint.tall.max[1] - 7) < 0.05 && Math.abs(blueprint.short.max[1] - 4) < 0.05, `the lamp follows its height: ${JSON.stringify([blueprint.tall.max, blueprint.short.max])}`);
    assert.deepEqual(blueprint.stamp, { id: "lamp-post", version: 1, params: { arms: 2 } });
    assert.equal(blueprint.validation, 0);
    assert.ok(blueprint.bytes > 1000, "the derived model exports");
  } finally {
    await context.close();
  }
}
