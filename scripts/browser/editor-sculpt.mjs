import assert from "node:assert/strict";
import { resolve } from "node:path";
import { results, watch } from "./harness.mjs";

// Sculpt mode in the page: pointer strokes on a dense part become one sculpt command each
// (one undo step), the brush settings travel with them, and a drag off the part orbits.
export async function editorSculptChecks({ browser, base }) {
  const errors = [],
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" }),
    page = watch(await context.newPage(), errors);
  try {
    await page.goto(`${base}/workshop/?lang=en`);
    await page.waitForFunction(() => window.funEditor);
    await page.evaluate(async () => {
      const { emptyProject } = await import("/workshop/document.js");
      funEditor.loadProject(
        { ...emptyProject("Sculpt"), materials: [{ id: "clay", name: "Clay", color: "#c8a888", roughness: 0.7 }] },
        { ifRevision: funEditor.inspect().revision },
      );
      funEditor.apply([{ op: "create", id: "head", kind: "sphere", material: "clay", smooth: 180, options: { radius: 0.5, geodesic: 5 } }], {
        ifRevision: funEditor.inspect().revision,
      });
      funEditor.select("head");
    });
    await page.locator('[data-view="perspective"]').click();
    await page.locator('[data-view="front"]').click();
    await page.locator("#selection-mode").selectOption("sculpt");
    assert.equal(await page.locator("#sculpt-tools").isHidden(), false, "the sculpt panel shows");
    // The first radius is a tenth of the part's size (1 m across).
    assert.equal(Number(await page.locator("#brush-radius").inputValue()), 0.1);
    const box = await page.locator("#canvas").boundingBox(),
      cx = box.x + box.width / 2,
      cy = box.y + box.height / 2;
    const positions = () => page.evaluate(() => Array.from(funEditor.inspect({ id: "head", detail: "full" }).node.mesh.dense.positions));
    const before = await positions(),
      revision = await page.evaluate(() => funEditor.inspect().revision),
      drawings = () => page.evaluate(async () => ({ ...(await import("/workshop/dense.js")).geometryCounts }));
    const drawn = await drawings();
    // A clay stroke across the front of the ball.
    await page.mouse.move(cx - 60, cy - 20);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(cx - 60 + i * 10, cy - 20 + i * 2);
    await page.mouse.up();
    await page.waitForFunction((r) => funEditor.inspect().revision === r + 1, revision);
    const after = await positions();
    const moved = after.filter((v, i) => Math.abs(v - before[i]) > 1e-9).length;
    assert.ok(moved > 30, `the stroke moved vertices (${moved / 3})`);
    // The smooth part's live copy is what the commit draws: no rebuild.
    const redrawn = await drawings();
    assert.deepEqual([redrawn.adopted - drawn.adopted, redrawn.built - drawn.built], [1, 0], "the committed stroke draws its live copy");
    const activity = await page.evaluate(() => funEditor.inspect({ id: "head" }).node);
    assert.ok(activity, "the part is still there");
    await page.screenshot({ path: resolve(results, "editor-sculpt-clay.png") });
    // One undo step puts every vertex back.
    await page.locator("#undo").click();
    assert.deepEqual(await positions(), before, "one stroke, one undo step");
    await page.locator("#redo").click();
    // Grab, with mirroring off: the region under the pointer follows it.
    await page.locator('[data-brush="grab"]').click();
    await page.locator("#brush-mirror-x").uncheck();
    const top = await positions();
    await page.mouse.move(cx, cy + 40);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(cx, cy + 40 + i * 8);
    await page.mouse.up();
    await page.waitForFunction((r) => funEditor.inspect().revision >= r + 3, revision);
    const grabbed = await positions();
    let lowest = 0;
    for (let i = 1; i < grabbed.length; i += 3) lowest = Math.min(lowest, grabbed[i] - top[i]);
    assert.ok(lowest < -0.05, `grab pulls the surface down (${lowest})`);
    // A drag off the part orbits instead of sculpting.
    const settled = await page.evaluate(() => funEditor.inspect().revision),
      camera = await page.evaluate(() => JSON.stringify(funEditor.inspect().camera ?? null));
    // (Bottom right: the view buttons cover the top left of the canvas.)
    await page.mouse.move(box.x + box.width - 200, box.y + box.height - 120);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 100, box.y + box.height - 100, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => funEditor.inspect().revision), settled, "no stroke off the part");
    assert.notEqual(await page.evaluate(() => JSON.stringify(funEditor.inspect().camera ?? null)), camera, "the view turned");
    // Leaving sculpt mode hides the panel.
    await page.locator("#selection-mode").selectOption("object");
    assert.equal(await page.locator("#sculpt-tools").isHidden(), true);
    await page.screenshot({ path: resolve(results, "editor-sculpt.png") });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
