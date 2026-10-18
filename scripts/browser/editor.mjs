import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { editorAgentChecks } from "./editor-agent.mjs";
import { editorWorkflowChecks } from "./editor-workflows.mjs";
import { editorRecoveryChecks } from "./editor-recovery.mjs";
import { editorRefinementChecks } from "./editor-refinement.mjs";
import { editorRendererChecks } from "./editor-renderer.mjs";
import { editorDeliveryChecks } from "./editor-delivery.mjs";
import { editorMaterialChecks } from "./editor-materials.mjs";
import { editorSolidChecks } from "./editor-solids.mjs";
import { results, watch } from "./harness.mjs";
import { headersFor, parseHeaders } from "../headers.mjs";

export async function editorChecks({ browser, base }) {
  const errors = [],
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
      acceptDownloads: true,
    });
  const page = watch(await context.newPage(), errors);
  let exportedBytes;
  await context.route("**/__editor-glb", async (route) => {
    if (route.request().method() === "POST") {
      exportedBytes = route.request().postDataBuffer();
      await route.fulfill({ status: 200, body: "ok" });
    } else
      await route.fulfill({
        status: 200,
        contentType: "model/gltf-binary",
        body: exportedBytes,
      });
  });
  page.on("dialog", (dialog) => dialog.accept());
  try {
    await page.goto(`${base}/editor/?lang=en`);
    await page.waitForFunction(() => window.funEditor);
    assert.equal(
      await page.evaluate(() => funEditor.validate().warnings.length),
      0,
    );
    await page.screenshot({ path: resolve(results, "editor-desktop.png") });
    // Blurring a numeric field commits before the clicked part changes selection.
    await page.locator('[data-node="body"]').click();
    await page.locator('[name="position-1"]').fill("1.25");
    await page.locator('[data-node="head"]').click();
    assert.equal(
      await page.evaluate(
        () => funEditor.inspect({ id: "body" }).node.position[1],
      ),
      1.25,
    );
    assert.equal(await page.locator("#node-name").inputValue(), "Head");
    const committedRevision = await page.evaluate(
      () => funEditor.inspect().revision,
    );
    await page.locator('[name="position-1"]').fill("3");
    await page.locator('[name="position-1"]').press("Escape");
    assert.equal(
      await page.locator('[name="position-1"]').inputValue(),
      "1.65",
    );
    assert.equal(
      await page.evaluate(() => funEditor.inspect().revision),
      committedRevision,
    );
    await page.locator("#undo").click();
    // Real UI edit, history, downloaded editable source and reopening it.
    await page.locator('[data-node="beak"]').click();
    await page.locator('[name="scale-1"]').fill("0.12");
    await page.locator('#transform-form button[type="submit"]').click();
    assert.equal(
      await page.evaluate(
        () => funEditor.inspect({ id: "beak" }).node.scale[1],
      ),
      0.12,
    );
    await page.locator("#undo").click();
    assert.equal(
      await page.evaluate(
        () => funEditor.inspect({ id: "beak" }).node.scale[1],
      ),
      0.18,
    );
    await page.locator("#redo").click();
    const saved = page.waitForEvent("download");
    await page.locator("#save").click();
    const projectFile = await saved,
      projectPath = await projectFile.path(),
      project = JSON.parse(await readFile(projectPath, "utf8"));
    await page.locator("#new").click();
    assert.equal(await page.evaluate(() => funEditor.inspect().stats.nodes), 0);
    await page.locator("#project-file").setInputFiles({
      name: "duck.funmodel.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await page.waitForFunction(
      () => window.funEditor?.inspect().stats.nodes === 11,
    );
    assert.deepEqual(
      await page.evaluate(() => funEditor.getProject()),
      project,
    );
    await page.reload();
    await page.waitForFunction(() => window.funEditor);
    assert.deepEqual(
      await page.evaluate(() => funEditor.getProject()),
      project,
      "draft restored after reload",
    );
    // Agent transaction, multi-view observation, export snapshot and existing runtime loader.
    const output = await page.evaluate(async () => {
      const initial = funEditor.inspect();
      funEditor.apply(
        [{ op: "set", id: "wing-left", position: [-0.59, 0, -0.12] }],
        { ifRevision: initial.revision },
      );
      let conflict = false;
      try {
        funEditor.apply([{ op: "delete", id: "duck" }], {
          ifRevision: initial.revision,
        });
      } catch (error) {
        conflict = error.code === "conflict";
      }
      const views = funEditor.renderViews(
        ["front", "left", "back", "perspective"],
        { size: 512 },
      );
      const file = await funEditor.exportGLB({ encoding: "base64" });
      return {
        conflict,
        views,
        file,
        sourceBounds: funEditor.inspect().bounds,
      };
    });
    // The game asset kit initializes Meshopt WASM. Exercise it under the game's
    // real policy, independently of the editor's more restrictive document.
    const runtimePage = watch(await context.newPage(), errors);
    const gameHeaders = headersFor(
      parseHeaders(
        await readFile(new URL("../../site/_headers", import.meta.url), "utf8"),
      ),
      "/games/editor-export-check",
      base,
    );
    await runtimePage.route("**/games/editor-export-check", (route) =>
      route.fulfill({
        status: 200,
        headers: gameHeaders,
        contentType: "text/html",
        body: "<!doctype html><title>Export runtime check</title>",
      }),
    );
    await runtimePage.goto(`${base}/games/editor-export-check`);
    output.loaded = await runtimePage.evaluate(async (data) => {
      const { createAssets } = await import("/runtime/kit/assets.js"),
        THREE = await import("/runtime/three.js");
      const bytes = Uint8Array.from(atob(data), (v) => v.charCodeAt(0));
      await fetch("/__editor-glb", { method: "POST", body: bytes });
      const controller = new AbortController(),
        resources = new Set(),
        cleanup = [];
      const renderer = new THREE.WebGPURenderer({
        canvas: document.createElement("canvas"),
        forceWebGL: true,
      });
      await renderer.init();
      const assets = createAssets({
        THREE,
        renderer,
        signal: controller.signal,
        asset: () => "/__editor-glb",
        track: (v) => resources.add(v),
        onCleanup: (fn) => cleanup.push(fn),
      });
      const gltf = await assets.gltf("assets/duck.glb");
      const beak = gltf.scene.getObjectByName("beak"),
        wing = gltf.scene.getObjectByName("wing-left");
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const loaded = {
        beakScale: beak.scale.toArray(),
        wingPosition: wing.position.toArray(),
        beakParent: beak.parent.name,
        bounds: { min: box.min.toArray(), max: box.max.toArray() },
        resources: resources.size,
      };
      for (const resource of resources) resource.dispose?.();
      for (const fn of cleanup) fn();
      await renderer.dispose();
      return loaded;
    }, output.file.data);
    await runtimePage.close();
    assert.ok(output.conflict);
    assert.deepEqual(output.loaded.beakScale, [0.62, 0.12, 0.55]);
    assert.deepEqual(output.loaded.wingPosition, [-0.59, 0, -0.12]);
    assert.equal(output.loaded.beakParent, "head");
    assert.ok(output.loaded.resources > 0);
    for (const key of ["min", "max"])
      output.loaded.bounds[key].forEach((v, i) =>
        assert.ok(Math.abs(v - output.sourceBounds[key][i]) < 1e-5),
      );
    for (const shot of output.views) {
      const png = Buffer.from(shot.dataUrl.split(",")[1], "base64");
      assert.ok(png.length > 5000, "nonblank model view");
      await writeFile(resolve(results, `editor-duck-${shot.view}.png`), png);
    }
    await writeFile(
      resolve(results, "editor-duck.glb"),
      Buffer.from(output.file.data, "base64"),
    );
    await writeFile(
      resolve(results, "editor-duck.funmodel.json"),
      JSON.stringify(
        await page.evaluate(() => funEditor.getProject()),
        null,
        2,
      ),
    );
    // Face editing via controls, then vertex editing. A fresh cube makes the targeted face explicit.
    await page.locator("#add").click();
    await page.locator("#add-form button[type=submit]").click();
    await page.locator("#convert").click();
    await page.locator("#selection-mode").selectOption("face");
    await page.locator("#face").selectOption("f5");
    await page.locator("#extrude").click();
    assert.equal(
      await page.evaluate(
        () =>
          funEditor.inspect({ id: "box-1", detail: "full" }).node.mesh.faces
            .length,
      ),
      10,
    );
    await page.locator("#selection-mode").selectOption("vertex");
    await page.locator("#vertex").selectOption("0");
    await page.locator('[name="vertex-0"]').fill("-0.6");
    await page.locator("#vertex-form button[type=submit]").click();
    assert.equal(
      await page.evaluate(
        () =>
          funEditor.inspect({ id: "box-1", detail: "full" }).node.mesh
            .vertices[0][0],
      ),
      -0.6,
    );
    await page.locator("#language-toggle").selectOption("zh");
    assert.equal(await page.locator("#export").textContent(), "导出 GLB");
    await page.locator('[data-view="front"]').click();
    assert.equal(
      await page.evaluate(() => funEditor.inspect().camera.projection),
      "orthographic",
    );
    const observations = await page.evaluate(() =>
      funEditor.renderViews(["front", "perspective"], { size: 128 }),
    );
    assert.equal(
      observations[0].revision,
      await page.evaluate(() => funEditor.inspect().revision),
    );
    assert.equal(observations[0].camera.projection, "orthographic");
    assert.equal(observations[1].camera.projection, "perspective");
    // Independent material copies change only the selected part.
    await page.locator("#selection-mode").selectOption("object");
    await page.locator('[data-node="beak"]').click();
    await page.locator("#unique-material").click();
    const unique = await page.locator("#material").inputValue();
    await page.locator("#color").fill("#40a080");
    await page.locator("#color").dispatchEvent("change");
    assert.deepEqual(
      await page.evaluate(
        (id) => funEditor.inspect().materials.find((m) => m.id === id).users,
        unique,
      ),
      ["beak"],
    );
    // Parametric hollow container: edit a retained profile and radial resolution.
    await page.locator("#new").click();
    await page.locator("#add").click();
    await page.locator("#kind").selectOption("lathe");
    await page.locator("#add-form button[type=submit]").click();
    assert.deepEqual(
      await page.evaluate(() => funEditor.validate().warnings),
      [],
    );
    await page.locator("#parameters").click();
    await page.locator("#segments").fill("12");
    await page.locator("#add-form button[type=submit]").click();
    assert.equal(
      await page.evaluate(
        () =>
          funEditor.inspect({ id: "lathe-1" }).node.generator.options.segments,
      ),
      12,
    );
    await page.locator("#shading").selectOption("clay");
    await page.locator("#focus").click();
    await page.screenshot({ path: resolve(results, "editor-planter.png") });
    // A complete asset workflow: four linked legs, actual box selection and gizmo drag.
    await page.locator("#stool").click();
    await page.locator('[data-node="leg"]').click();
    await page.locator("#selection-mode").selectOption("vertex");
    await page.locator('[data-view="front"]').click();
    await page.locator("#xray").click();
    const bottom = await page.evaluate(async () => {
      const T = await import("/runtime/three.js"),
        d = funEditor.inspect({ id: "leg", detail: "full" }),
        c = funEditor.inspect().camera,
        r = document.querySelector("#canvas").getBoundingClientRect();
      const m = new T.Matrix4().fromArray(d.worldMatrix),
        p = new T.Matrix4()
          .fromArray(c.projectionMatrix)
          .multiply(new T.Matrix4().fromArray(c.worldMatrix).invert());
      return [0, 1, 4, 5].map((i) => {
        const v = new T.Vector3(...d.node.mesh.vertices[i])
          .applyMatrix4(m)
          .applyMatrix4(p);
        return {
          x: r.x + ((v.x + 1) * r.width) / 2,
          y: r.y + ((1 - v.y) * r.height) / 2,
        };
      });
    });
    await page.locator("#box-select").click();
    await page.mouse.move(
      Math.min(...bottom.map((p) => p.x)) - 8,
      bottom[0].y - 8,
    );
    await page.mouse.down();
    await page.mouse.move(
      Math.max(...bottom.map((p) => p.x)) + 8,
      bottom[0].y + 8,
      { steps: 4 },
    );
    await page.mouse.up();
    assert.deepEqual(
      await page.evaluate(() =>
        funEditor.inspect().selection.vertices.sort((a, b) => a - b),
      ),
      [0, 1, 4, 5],
    );
    await page.locator('[data-transform="scale"]').click();
    await page.locator('[name="selectionScale-0"]').fill(".8");
    await page.locator('[name="selectionScale-2"]').fill(".8");
    await page.locator("#scale-selection").click();
    assert.equal(
      await page.evaluate(() => {
        const p = funEditor.getProject();
        return p.nodes
          .filter((n) => n.instanceOf === "leg")
          .every(
            (n) =>
              JSON.stringify(n.mesh) ===
              JSON.stringify(p.nodes.find((n) => n.id === "leg").mesh),
          );
      }),
      true,
    );
    await page.locator("#focus").click();
    await page.locator('[data-transform="translate"]').click();
    const beforeDrag = await page.evaluate(
        () =>
          funEditor.inspect({ id: "leg", detail: "full" }).node.mesh.vertices,
      ),
      canvas = await page.locator("#canvas").boundingBox();
    const x = canvas.x + canvas.width / 2 + canvas.height * 0.08,
      y = canvas.y + canvas.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + canvas.height * 0.06, y, { steps: 8 });
    await page.mouse.up();
    const afterDrag = await page.evaluate(
      () => funEditor.inspect({ id: "leg", detail: "full" }).node.mesh.vertices,
    );
    assert.ok(afterDrag[0][0] > beforeDrag[0][0]);
    assert.deepEqual(afterDrag[2], beforeDrag[2]);
    await page.locator("#undo").click();
    assert.deepEqual(
      await page.evaluate(
        () =>
          funEditor.inspect({ id: "leg", detail: "full" }).node.mesh.vertices,
      ),
      beforeDrag,
    );
    await page.locator("#selection-mode").selectOption("object");
    await page.locator("#shading").selectOption("material");
    await page.locator('[data-view="perspective"]').click();
    await page.screenshot({ path: resolve(results, "editor-stool.png") });
    const stool = await page.evaluate(async () => ({
      project: funEditor.getProject(),
      file: await funEditor.exportGLB({ encoding: "base64" }),
    }));
    await writeFile(
      resolve(results, "editor-stool.funmodel.json"),
      JSON.stringify(stool.project, null, 2),
    );
    await writeFile(
      resolve(results, "editor-stool.glb"),
      Buffer.from(stool.file.data, "base64"),
    );
    // Create a live mirror using the GUI, then edit the source's retained parameters.
    await page.locator("#duck").click();
    await page.evaluate(() =>
      funEditor.apply([{ op: "delete", id: "wing-right" }]),
    );
    await page.locator('[data-node="wing-left"]').click();
    await page
      .locator("details")
      .filter({ has: page.locator("#symmetry") })
      .locator("summary")
      .click();
    await page.locator("#symmetry").click();
    assert.equal(
      await page.evaluate(
        () => funEditor.inspect({ id: "mirror-1" }).node.symmetry.source,
      ),
      "wing-left",
    );
    await page.locator("#select-source").click();
    await page.locator("#parameters").click();
    await page.locator("#radius").fill(".6");
    await page.locator("#add-form button[type=submit]").click();
    assert.deepEqual(
      await page.evaluate(() => funEditor.validate().warnings),
      [],
    );
    await page.screenshot({ path: resolve(results, "editor-linked-duck.png") });
    // Two windows may observe one draft, but never silently overwrite it.
    const peer = watch(await context.newPage(), errors);
    await peer.goto(`${base}/editor/?lang=zh`);
    await peer.waitForFunction(() => window.funEditor);
    assert.equal(
      await peer.evaluate(() => funEditor.inspect().writable),
      false,
    );
    assert.equal(
      await peer.evaluate(() => {
        try {
          funEditor.apply([{ op: "renameProject", name: "stale" }]);
          return "accepted";
        } catch (e) {
          return e.code;
        }
      }),
      "readonly",
    );
    assert.ok(await peer.locator("#draft-banner").isVisible());
    await page.goto(`${base}/editor/guide`);
    assert.ok(await page.locator("h1").isVisible());
    await peer.locator("#draft-retry").click();
    await peer.waitForFunction(
      () => window.funEditor?.inspect().writable === true,
    );
    assert.equal(
      await peer.evaluate(
        () =>
          funEditor.inspect({ id: "wing-left" }).node.generator.options.radius,
      ),
      0.6,
    );
    await peer.close();
  } catch (error) {
    await page
      .screenshot({ path: resolve(results, "editor-failure.png") })
      .catch(() => {});
    if (errors.length)
      error.message += `\nBrowser errors:\n${errors.join("\n")}`;
    throw error;
  } finally {
    await context.close();
  }
  for (const [width, height] of [
    [1024, 768],
    [1920, 1080],
  ]) {
    const desktop = await browser.newContext({
      viewport: { width, height },
      serviceWorkers: "block",
      reducedMotion: "reduce",
    });
    const p = watch(await desktop.newPage(), errors);
    try {
      await p.goto(`${base}/editor/?lang=zh`);
      await p.waitForFunction(() => window.funEditor);
      assert.ok(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        "no horizontal desktop overflow",
      );
      await p.locator('[data-node="beak"]').click();
      assert.equal(await p.locator("#node-name").inputValue(), "Beak");
      await p.screenshot({
        path: resolve(results, `editor-desktop-${width}.png`),
      });
    } finally {
      await desktop.close();
    }
  }
  assert.deepEqual(errors, []);
  await editorWorkflowChecks({ browser, base });
  await editorAgentChecks({ browser, base });
  await editorRecoveryChecks({ browser, base });
  await editorRefinementChecks({ browser, base });
  await editorRendererChecks({ browser, base });
  await editorDeliveryChecks({ browser, base });
  await editorMaterialChecks({ browser, base });
  await editorSolidChecks({ browser, base });
}
