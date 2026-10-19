import assert from "node:assert/strict";
import { resolve } from "node:path";
import { results, watch } from "./harness.mjs";
import { parseModelFile } from "../../site/workshop/glb.js";

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
    await page.goto(`${base}/workshop/?lang=en`);
    await page.waitForFunction(() => window.funEditor);
    await page.evaluate(async () =>
      funEditor.loadProject(
        (await import("/workshop/document.js")).emptyProject("Generators"),
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
      funEditor.loadProject((await import("/workshop/document.js")).emptyProject("Blueprints"), { ifRevision: funEditor.inspect().revision });
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

    // Round shapes from the dialog: a torus with automatic segments, a hollow half frustum
    // along X; an agent's arched outline survives the dialog; smooth shading reaches the GLB.
    await page.evaluate(async () =>
      funEditor.loadProject((await import("/workshop/document.js")).emptyProject("Round"), { ifRevision: funEditor.inspect().revision }),
    );
    await page.locator("#add").click();
    await page.locator("#kind").selectOption("torus");
    for (const field of ["radius", "tube", "segment", "angle", "axis"])
      assert.equal(await page.locator(`#${field}-field`).isHidden(), false, field);
    assert.equal(await page.locator("#segments").inputValue(), "", "tori start with automatic segments");
    await submit();
    const torus = await page.evaluate(() => funEditor.inspect().selection.id);
    node = await page.evaluate((id) => funEditor.inspect({ id }).node, torus);
    assert.equal(node.generator.kind, "torus");
    assert.equal(node.generator.options.segments, "auto");
    await page.locator("#add").click();
    await page.locator("#kind").selectOption("cylinder");
    await page.locator("#radius").fill("0.5");
    await page.locator("#radius-top").fill("0.3");
    await page.locator("#inner-radius").fill("0.4");
    await page.locator("#angle").fill("180");
    await page.locator("#shape-axis").selectOption("x");
    await page.locator("#angle").dispatchEvent("change");
    await submit();
    const pipe = await page.evaluate(() => funEditor.inspect().selection.id);
    node = await page.evaluate((id) => funEditor.inspect({ id }).node, pipe);
    assert.deepEqual(
      { ...node.generator.options, segments: undefined },
      { radius: 0.5, height: 1, radiusTop: 0.3, innerRadius: 0.4, segments: undefined, axis: "x", angle: 180 },
    );
    const arch = { points: [[-0.3, 0], [0.3, 0], [0.3, 0.4, 0.05], { arc: { through: [0, 0.7], to: [-0.3, 0.4] } }], depth: 0.1 };
    await page.evaluate((options) => {
      funEditor.apply([{ op: "create", id: "arch", kind: "extrude", options }], { ifRevision: funEditor.inspect().revision });
      funEditor.select("arch");
    }, arch);
    await page.locator("#parameters").click();
    assert.match(await page.locator("#outline").inputValue(), /^-0\.3, 0\n0\.3, 0\n0\.3, 0\.4, 0\.05\n\{"arc":/);
    await submit();
    node = await page.evaluate(() => funEditor.inspect({ id: "arch" }).node);
    assert.deepEqual(node.generator.options.points, arch.points, "arcs and corner radii survive the dialog");
    const exported = async () => {
      const glb = await page.evaluate(async (id) => (await funEditor.exportGLB({ encoding: "base64", ids: [id] })).data, torus);
      const { json } = parseModelFile(new Uint8Array(Buffer.from(glb, "base64")));
      return json.meshes.flatMap((m) => m.primitives).reduce((sum, p) => sum + json.accessors[p.attributes.POSITION].count, 0);
    };
    const flat = await exported();
    await page.evaluate((id) => funEditor.select(id), torus);
    await page.locator("#smooth").check();
    assert.equal(await page.evaluate((id) => funEditor.inspect({ id }).node.smooth, torus), 60);
    const smooth = await exported();
    assert.ok(smooth < flat / 2, `smooth vertices share their normals: ${smooth} vs ${flat}`);
    await page.locator("#smooth").uncheck();
    assert.equal(await page.evaluate((id) => funEditor.inspect({ id }).node.smooth ?? null, torus), null);
    await page.screenshot({ path: resolve(results, "editor-round-shapes.png") });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
