import assert from "node:assert/strict";
import { resolve } from "node:path";
import { results, watch } from "./harness.mjs";

export async function editorWorkflowChecks({ browser, base }) {
  const errors = [],
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      serviceWorkers: "block",
    }),
    page = watch(await context.newPage(), errors);
  page.on("dialog", (d) => d.accept());
  const click = (id) => page.locator("#" + id).click();
  try {
    await page.goto(`${base}/workshop/?lang=zh`);
    await page.waitForFunction(() => window.funEditor);
    await click("stool");
    await page.locator('[data-node="seat"]').click();
    await page.locator('[data-node="leg"]').click({ modifiers: ["Shift"] });
    await click("duplicate");
    assert.equal(
      await page.evaluate(() => funEditor.getProject().nodes.length),
      8,
    );
    assert.equal(
      await page.evaluate(() => funEditor.inspect().selection.ids.length),
      2,
    );
    await click("duplicate");
    assert.equal(
      await page.evaluate(() => funEditor.getProject().nodes.length),
      10,
    );
    await click("undo");
    await click("undo");
    await page.locator('[data-node="seat"]').click();
    await page.locator('[data-node="leg"]').click({ modifiers: ["Shift"] });
    await page.locator("#material").selectOption("ink");
    await click("paint");
    assert.ok(
      await page.evaluate(() =>
        funEditor
          .getProject()
          .nodes.filter((n) => n.mesh)
          .every((n) => n.mesh.faces.every((f) => f.material === "ink")),
      ),
    );
    await click("undo");
    await page.locator('[data-node="leg"]').click();
    await page.locator("#selection-mode").selectOption("vertex");
    await page.locator("#canvas").focus();
    const revision = await page.evaluate(() => funEditor.inspect().revision),
      faces = await page.evaluate(
        () => funEditor.inspect({ id: "leg" }).node.faces,
      );
    // Delete in component mode removes the faces at the selection, never the part.
    await page.keyboard.press("Delete");
    assert.equal(
      await page.evaluate(() => funEditor.inspect().revision),
      revision + 1,
    );
    assert.ok(
      (await page.evaluate(() => funEditor.inspect({ id: "leg" }).node.faces)) <
        faces,
    );
    assert.ok(await page.locator("#delete").isDisabled());
    await click("undo");
    assert.equal(
      await page.evaluate(() => funEditor.inspect({ id: "leg" }).node.faces),
      faces,
    );
    await page.locator("#selection-mode").selectOption("object");
    await click("focus");
    const focused = await page.evaluate(() => funEditor.inspect().camera);
    await click("projection");
    const ortho = await page.evaluate(() => funEditor.inspect().camera);
    ortho.target.forEach((v, i) =>
      assert.ok(Math.abs(v - focused.target[i]) < 1e-8),
    );
    const halfHeight =
      Math.tan(((focused.fov / 2) * Math.PI) / 180) *
      Math.hypot(...focused.position.map((v, i) => v - focused.target[i]));
    assert.ok(Math.abs(halfHeight - ortho.top) < 1e-6);
    await page.locator('[data-view="front"]').click();
    (await page.evaluate(() => funEditor.inspect().camera.target)).forEach(
      (v, i) => assert.ok(Math.abs(v - focused.target[i]) < 1e-8),
    );
    await page.locator("#length-unit").selectOption("mm");
    assert.equal(await page.locator('[name="position-1"]').inputValue(), "210");
    await page.locator('[name="position-1"]').fill("220");
    await page.locator('[name="position-1"]').press("Enter");
    assert.equal(
      await page.evaluate(
        () => funEditor.inspect({ id: "leg" }).node.position[1],
      ),
      0.22,
    );
    await click("undo");
    await page.locator("#length-unit").selectOption("m");
    // Visible and through-selection differ for two overlapping legs.
    await page.locator('[data-view="perspective"]').click();
    await page.locator('[data-view="front"]').click();
    const screen = await page.evaluate(async () => {
      const T = await import("/runtime/three.js"),
        c = funEditor.inspect().camera,
        b = funEditor.inspect({ id: "leg" }).bounds,
        r = document.querySelector("#canvas").getBoundingClientRect(),
        p = new T.Vector3(...b.center)
          .applyMatrix4(new T.Matrix4().fromArray(c.worldMatrix).invert())
          .applyMatrix4(new T.Matrix4().fromArray(c.projectionMatrix));
      return {
        x: r.x + ((p.x + 1) * r.width) / 2,
        y: r.y + ((1 - p.y) * r.height) / 2,
      };
    });
    const box = async () => {
      await click("box-select");
      await page.mouse.move(screen.x - 20, screen.y - 30);
      await page.mouse.down();
      await page.mouse.move(screen.x + 20, screen.y + 30, { steps: 4 });
      await page.mouse.up();
    };
    await box();
    assert.deepEqual(
      await page.evaluate(() => funEditor.inspect().selection.ids),
      ["leg"],
    );
    await click("xray");
    await box();
    assert.deepEqual(
      await page.evaluate(() => funEditor.inspect().selection.ids),
      ["leg", "leg-back"],
    );
    await click("xray");
    await page.locator('[data-node="seat"]').click();
    await click("isolate");
    assert.deepEqual(
      await page.evaluate(() => funEditor.inspect().viewState.isolated),
      ["seat"],
    );
    await click("show-all");
    await page.locator('[data-lock="seat"]').click();
    assert.ok(await page.locator("#duplicate").isDisabled());
    assert.ok(await page.locator('[name="position-0"]').isDisabled());
    await page.locator('[data-lock="seat"]').click();
    // The profile keeps screen-to-SVG direction and supports dialog-local history.
    await click("planter");
    await click("parameters");
    await page.waitForFunction(
      () => !document.querySelector("#shape-submit").disabled,
    );
    const original = await page.locator("#outline").inputValue(),
      circle = await page
        .locator('#profile-editor [data-point="2"]')
        .boundingBox();
    await page.mouse.move(
      circle.x + circle.width / 2,
      circle.y + circle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      circle.x + circle.width / 2 + 10,
      circle.y + circle.height / 2,
      { steps: 4 },
    );
    await page.mouse.up();
    const changed = (await page.locator("#outline").inputValue())
      .split("\n")[2]
      .split(",")
      .map(Number);
    assert.ok(changed[0] > 0.45 && changed[0] < 0.49);
    assert.equal(changed[1], 0.7);
    assert.equal(
      await page.evaluate(
        () =>
          funEditor.inspect({ id: "planter" }).node.generator.options
            .profile[2][0],
      ),
      0.45,
      "preview does not commit",
    );
    await click("profile-undo");
    assert.equal(await page.locator("#outline").inputValue(), original);
    await page.screenshot({
      path: resolve(results, "editor-profile-live.png"),
    });
    await page.locator('[data-close="add-dialog"]').click();
    // Reproduce the reviewed crate, then finish its top rim with selected edges.
    await click("new");
    await click("add");
    await page.locator("#kind").selectOption("box");
    for (const [i, v] of [0.6, 0.4, 0.4].entries())
      await page.locator(`[name="primitiveSize-${i}"]`).fill(String(v));
    await click("shape-submit");
    await click("convert");
    await page.locator("#selection-mode").selectOption("face");
    await page.locator("#face").selectOption("f5");
    const insetBox = await page.locator("#inset").boundingBox();
    assert.ok(
      insetBox.y + insetBox.height < 770,
      "inset above viewport bottom at 1280×800",
    );
    await page.locator("#inset-distance").fill(".04");
    await click("inset");
    await page.locator("#extrude-distance").fill("-.05");
    await click("extrude");
    // A top lip consists of boundaries shared by horizontal rim faces and vertical walls.
    await page.evaluate(() => {
      const d = funEditor.inspect({ id: "box-1", detail: "full" }),
        edges = d.edges.filter(
          (e) =>
            e.vertices.every(
              (i) => Math.abs(d.node.mesh.vertices[i][1] - 0.2) < 1e-7,
            ) &&
            e.vertices.every(
              (i) =>
                Math.abs(d.node.mesh.vertices[i][0]) < 0.29 &&
                Math.abs(d.node.mesh.vertices[i][2]) < 0.19,
            ),
        );
      funEditor.select("box-1", {
        mode: "edge",
        edges: edges.map((e) => e.id),
      });
    });
    assert.equal(
      await page.evaluate(() => funEditor.inspect().selection.edges.length),
      4,
    );
    await page.locator("#edge-bevel-distance").fill(".008");
    await click("bevel-edges");
    assert.deepEqual(
      await page.evaluate(() => funEditor.validate().warnings),
      [],
    );
    await page.locator("#selection-mode").selectOption("object");
    await page.locator("#shading").selectOption("clay");
    await page.locator('[data-view="perspective"]').click();
    await page.screenshot({
      path: resolve(results, "editor-recess-beveled.png"),
    });
    // Edge picking is a real screen interaction, and the quad strip can be cut.
    await click("new");
    await click("add");
    await page.locator("#kind").selectOption("box");
    await click("shape-submit");
    await click("convert");
    await page.locator("#selection-mode").selectOption("edge");
    const edgePoint = await page.evaluate(async () => {
      const T = await import("/runtime/three.js"),
        d = funEditor.inspect({ id: "box-1", detail: "full" }),
        c = funEditor.inspect().camera,
        r = document.querySelector("#canvas").getBoundingClientRect(),
        v = new T.Vector3(...d.node.mesh.vertices[6])
          .add(new T.Vector3(...d.node.mesh.vertices[7]))
          .multiplyScalar(0.5)
          .applyMatrix4(new T.Matrix4().fromArray(d.worldMatrix))
          .applyMatrix4(new T.Matrix4().fromArray(c.worldMatrix).invert())
          .applyMatrix4(new T.Matrix4().fromArray(c.projectionMatrix));
      return {
        x: r.x + ((v.x + 1) * r.width) / 2,
        y: r.y + ((1 - v.y) * r.height) / 2,
      };
    });
    await page.mouse.click(edgePoint.x, edgePoint.y);
    assert.deepEqual(
      await page.evaluate(() => funEditor.inspect().selection.edges),
      ["6:7"],
    );
    await click("loop-cut");
    assert.equal(
      await page.evaluate(
        () =>
          funEditor.inspect({ id: "box-1", detail: "full" }).node.mesh.faces
            .length,
      ),
      10,
    );
    assert.deepEqual(
      await page.evaluate(() => funEditor.validate().warnings),
      [],
    );
    await page.screenshot({ path: resolve(results, "editor-loop-cut.png") });
    assert.deepEqual(errors, []);
  } catch (error) {
    await page
      .screenshot({ path: resolve(results, "editor-workflows-failure.png") })
      .catch(() => {});
    if (errors.length) error.message += "\n" + errors.join("\n");
    throw error;
  } finally {
    await context.close();
  }
}
