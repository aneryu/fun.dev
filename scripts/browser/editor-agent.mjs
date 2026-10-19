import assert from "node:assert/strict";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { results, watch } from "./harness.mjs";

export async function editorAgentChecks({ browser, base }) {
  const errors = [],
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
    }),
    page = watch(await context.newPage(), errors);
  page.on("dialog", (dialog) => dialog.accept());
  try {
    await page.goto(`${base}/workshop/?lang=zh`);
    await page.waitForFunction(() => window.funEditor?.version === 3);
    const output = await page.evaluate(async () => {
      const a = funEditor,
        { emptyProject } = await import("/workshop/document.js"),
        { hollowBoxRecipe } = await import("/workshop/recipe.js");
      a.loadProject(emptyProject("Agent toolbox"));
      const built = a.apply(
        [
          { op: "create", id: "asset", kind: "group" },
          {
            op: "create",
            id: "body",
            kind: "box",
            parent: "asset",
            position: [0, 0.25, 0],
            material: "orange",
          },
          { op: "recipe", id: "body", definition: hollowBoxRecipe() },
          {
            op: "create",
            id: "lid",
            kind: "box",
            parent: "asset",
            options: { size: [0.74, 0.055, 0.48], bevel: 0.012 },
            position: [0, 0.485, 0],
            material: "ink",
          },
          { op: "pivot", id: "lid", offset: [0, 0, -0.23] },
          { op: "set", id: "lid", rotation: [-32, 0, 0] },
          {
            op: "create",
            id: "foot",
            kind: "box",
            parent: "asset",
            options: { size: [0.12, 0.07, 0.12], bevel: 0.01 },
            position: [-0.28, 0.035, 0.15],
            material: "ink",
          },
          ...[
            [0.56, 0, 0],
            [0, 0, -0.3],
            [0.56, 0, -0.3],
          ].map((offset, i) => ({
            op: "duplicate",
            id: "foot",
            newId: `foot-${i}`,
            offset,
            linked: true,
          })),
        ],
        { ifRevision: a.inspect().revision, operationId: "build-toolbox" },
      );
      const old = a.query({ id: "body", kind: "edges" }).items[0].ref,
        revision = a.inspect().revision,
        checkpoint = a.checkpoint({ name: "72 cm" });
      const preview = a.preview(
        [{ op: "recipeParameters", id: "body", values: { width: 0.82 } }],
        { ifRevision: revision, views: ["perspective"], size: 128 },
      );
      const previewUnchanged =
        a.inspect().revision === revision &&
        a.inspect({ id: "body" }).node.recipe.parameters.width.value === 0.72;
      a.apply(
        [{ op: "recipeParameters", id: "body", values: { width: 0.82 } }],
        { ifRevision: revision, operationId: "widen" },
      );
      const replay = a.apply(
        [{ op: "recipeParameters", id: "body", values: { width: 0.82 } }],
        { ifRevision: revision, operationId: "widen" },
      );
      let stale = false;
      try {
        a.apply([{ op: "bevel", id: "body", edges: [old], distance: 0.001 }], {
          ifRevision: a.inspect().revision,
        });
      } catch (e) {
        stale = e.code === "stale_component";
      }
      const edge = a
          .query({
            id: "body",
            kind: "edges",
            space: "local",
            at: { axis: "y", value: -0.2 },
          })
          .items.find((e) =>
            e.endpoints.every((p) => Math.abs(p[2] + 0.23) < 1e-9),
          ),
        before = JSON.stringify(a.getProject());
      let crossing = false;
      try {
        a.apply(
          [
            { op: "set", id: "lid", name: "Rejected" },
            { op: "bevel", id: "body", edges: [edge.ref], distance: 0.3 },
          ],
          { ifRevision: a.inspect().revision },
        );
      } catch (e) {
        crossing =
          e.code === "geometry" &&
          e.commandIndex === 1 &&
          e.issues.some((i) => i.code === "self-intersection");
      }
      a.select("body", {
        mode: "face",
        faces: [
          a.query({
            id: "body",
            kind: "faces",
            normal: [0, 1, 0],
            largest: true,
          }).items[0].ref,
        ],
      });
      const state = JSON.stringify(a.inspect().viewState),
        plain = a.renderViews(["perspective"], {
          size: 256,
          visibility: "all",
          helpers: false,
        })[0],
        wire = a.renderViews(["perspective"], {
          size: 256,
          visibility: "all",
          helpers: false,
          overlays: { wire: true, selection: true },
        })[0],
        ids = a.renderViews(["perspective"], {
          size: 256,
          ids: ["body"],
          shading: "ids",
        })[0];
      const exported = await a.exportGLB({ encoding: "base64" }),
        merged = await a.exportGLB({
          encoding: "base64",
          mergeStatic: ["foot", "foot-0", "foot-1", "foot-2"],
        }),
        part = await a.exportGLB({ encoding: "base64", ids: ["lid"] });
      const { GLTFLoader } = await import("/runtime/addons/GLTFLoader.js"),
        load = async (data) =>
          new GLTFLoader().parseAsync(
            Uint8Array.from(atob(data), (c) => c.charCodeAt(0)).buffer,
            "",
          );
      const gltf = await load(exported.data),
        foot = gltf.scene.getObjectByName("foot"),
        other = gltf.scene.getObjectByName("foot-0");
      const report = {
        builtResults: built.results.length,
        previewUnchanged,
        previewImage: preview.observations.length,
        previewWidth: preview.nodes.find((n) => n.node.id === "body").node
          .recipe.parameters.width.value,
        compactPreview:
          preview.project === undefined &&
          preview.nodes.every((n) => n.node.mesh === undefined),
        replayed: replay.replayed,
        stale,
        crossing,
        rollback: before === JSON.stringify(a.getProject()),
        wireDiff: plain.dataUrl !== wire.dataUrl,
        ids: ids.observation,
        viewRestored: state === JSON.stringify(a.inspect().viewState),
        shared: foot.geometry === other.geometry,
        bodyIndexed: !!gltf.scene.getObjectByName("body").geometry.index,
        exported: exported.report,
        merged: merged.report,
        part: part.report,
        checkpoint,
        source: a.getProject(),
        image: plain.dataUrl,
      };
      for (const loaded of [
        gltf,
        await load(merged.data),
        await load(part.data),
      ])
        loaded.scene.traverse((o) => {
          o.geometry?.dispose();
          for (const m of Array.isArray(o.material) ? o.material : [o.material])
            m?.dispose();
        });
      return report;
    });
    assert.equal(output.builtResults, 10);
    assert.ok(
      output.previewUnchanged &&
        output.previewImage === 1 &&
        output.previewWidth === 0.82 &&
        output.compactPreview,
    );
    assert.ok(
      output.replayed && output.stale && output.crossing && output.rollback,
    );
    assert.ok(output.wireDiff && output.viewRestored);
    assert.deepEqual(output.ids.visibleIds, ["body"]);
    assert.equal(output.ids.helpers, false);
    assert.ok(output.ids.nodeColors.body);
    assert.ok(output.shared && output.bodyIndexed);
    assert.equal(output.exported.uniqueGeometries, 3);
    assert.equal(output.exported.meshes, 6);
    assert.equal(output.merged.meshes, 3);
    assert.equal(output.part.meshes, 1);
    assert.equal(output.merged.triangles, output.exported.triangles);
    await writeFile(
      resolve(results, "editor-agent-toolbox.png"),
      Buffer.from(output.image.split(",")[1], "base64"),
    );
    await writeFile(
      resolve(results, "editor-agent-evidence.json"),
      JSON.stringify({ ...output, image: undefined }, null, 2),
    );
    await page.reload();
    await page.waitForFunction(() => window.funEditor);
    assert.equal(await page.evaluate(() => funEditor.checkpoints().length), 1);
    await page.evaluate(
      (id) =>
        funEditor.restoreCheckpoint(id, {
          ifRevision: funEditor.inspect().revision,
        }),
      output.checkpoint.id,
    );
    assert.equal(
      await page.evaluate(
        () =>
          funEditor.inspect({ id: "body" }).node.recipe.parameters.width.value,
      ),
      0.72,
    );
    await page.evaluate(() => funEditor.select("body", { mode: "object" }));
    await page.locator('[data-parameter="width"]').fill("0.82");
    await page
      .locator("#recipe-tools button")
      .filter({ hasText: "按参数重建" })
      .click();
    assert.equal(
      await page.evaluate(
        () =>
          funEditor.inspect({ id: "body" }).node.recipe.parameters.width.value,
      ),
      0.82,
    );
    await page.locator("#activity").click();
    await page.getByRole("button", { name: "对比最近修改" }).click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.comparison canvas[data-ready="true"]')
          .length === 2,
    );
    await page.screenshot({
      path: resolve(results, "editor-agent-comparison.png"),
    });
    await page.locator('[data-close="info-dialog"]').click();
    await page.locator("#export-report").click();
    await page.locator("#info-content details summary").click();
    assert.ok(
      (await page.locator("#info-content pre").innerText()).includes(
        "sharedGeometry",
      ),
    );
    await page.locator('[data-close="info-dialog"]').click();
    await agentReliabilityChecks(page, base);
    await assetIterationChecks(page);
    await deliveryIterationChecks(page);
    await modelingIterationChecks(page, base);
    await recipeScopeIterationChecks(page, base);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

export async function recipeScopeIterationChecks(page, base) {
  await page.goto(base + "/workshop/?lang=zh&draft=recipe-scope-iteration");
  await page.waitForFunction(() => window.funEditor?.getRecipe);
  await page.evaluate(async () => {
    const { emptyProject } = await import("/workshop/document.js"),
      { hollowBoxRecipe } = await import("/workshop/recipe.js");
    funEditor.loadProject(emptyProject("Local recipe scope"));
    funEditor.apply([
      { op: "create", id: "body", kind: "box" },
      { op: "recipe", id: "body", definition: hollowBoxRecipe() },
    ]);
    const edge = funEditor.query({
      id: "body",
      kind: "edges",
      space: "local",
      boundary: { axis: "y", side: "min" },
    }).items[0].ref;
    funEditor.select("body", { mode: "edge", edges: [edge] });
    funEditor.view();
  });
  assert.equal(
    await page
      .locator('.recipe-step[data-step="1"] input[readonly]')
      .inputValue(),
    "-0.31",
  );
  const scope = page.locator("#recipe-step-scope"),
    before = await page.evaluate(() => ({
      project: funEditor.getProject(),
      revision: funEditor.inspect().revision,
      selection: funEditor.inspect().selection,
      camera: funEditor.inspect().camera,
    }));
  assert.equal(await scope.locator("select").inputValue(), "current");
  assert.equal(await page.locator("#recipe-step-add").isDisabled(), true);
  await scope.locator(".recipe-scope-preview").click();
  await scope.locator('canvas[data-ready="true"]').waitFor();
  assert.match(await scope.innerText(), /1 条边/);
  assert.ok(
    await scope.locator("canvas").evaluate((canvas) => canvas.width === 320),
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      project: funEditor.getProject(),
      revision: funEditor.inspect().revision,
      selection: funEditor.inspect().selection,
      camera: funEditor.inspect().camera,
    })),
    before,
  );
  await page.locator("#recipe-step-add").click();
  const fixed = await page.evaluate(() =>
    funEditor.getRecipe({ id: "body", index: 3 }),
  );
  assert.equal(fixed.step.edges.length, 1);
  assert.ok(fixed.step.topology);
  await page.evaluate(() => funEditor.undo());
  await scope.locator("select").selectOption("y:min");
  await scope.locator(".recipe-scope-preview").click();
  await scope.locator('canvas[data-ready="true"]').waitFor();
  assert.match(await scope.innerText(), /4 条边/);
  await page.locator("#recipe-step-add").click();
  await page.locator('#recipe-tools [data-parameter="width"]').fill("1");
  await page
    .locator("#recipe-tools")
    .getByRole("button", { name: "按参数重建", exact: true })
    .click();
  assert.equal(
    await page.evaluate(() => funEditor.inspect({ id: "body" }).bounds.size[0]),
    1,
  );
  const existing = page.locator(
    '.recipe-step[data-step="3"] .recipe-step-scope',
  );
  await existing.locator("summary").click();
  await existing.locator(".recipe-scope-preview").click();
  await existing.locator('canvas[data-ready="true"]').waitFor();
  assert.match(await existing.innerText(), /4 条边/);
  for (const width of [1024, 1920]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 1080 });
    await existing.locator("canvas").scrollIntoViewIfNeeded();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: resolve(results, `editor-recipe-scope-${width}.png`),
    });
  }
  await existing.locator("select").selectOption("z:max");
  assert.equal(
    await existing.getByRole("button", { name: "更新此步选区" }).isDisabled(),
    true,
  );
  await existing.locator(".recipe-scope-preview").click();
  await existing.getByRole("button", { name: "更新此步选区" }).click();
  const rebound = await page.evaluate(() =>
    funEditor.getRecipe({ id: "body", index: 3 }),
  );
  assert.deepEqual(rebound.step.select.boundary, { axis: "z", side: "max" });
  const consistency = await page.evaluate(async () => {
    const { emptyProject } = await import("/workshop/document.js"),
      { GLTFLoader } = await import("/runtime/addons/GLTFLoader.js"),
      { Box3, Vector3 } = await import("/runtime/three.js");
    funEditor.loadProject(emptyProject("Recipe and mirror export"));
    funEditor.apply([
      { op: "create", id: "rig", kind: "group" },
      {
        op: "create",
        id: "source",
        kind: "box",
        parent: "rig",
        position: [1, 0, 0],
      },
      {
        op: "recipe",
        id: "source",
        definition: {
          parameters: {},
          generator: { kind: "box" },
          steps: [
            { op: "transform", scale: [2, 1, 1], translation: [0, 1, 0] },
            { op: "cut", axis: "y", offset: 1 },
          ],
        },
      },
      {
        op: "symmetry",
        id: "source",
        newId: "mirror",
        axis: "x",
        space: "parent",
        linked: true,
      },
      {
        op: "create",
        id: "marker",
        kind: "box",
        parent: "rig",
        options: { size: [0.1, 0.1, 0.1] },
      },
      {
        op: "assembly",
        definition: {
          root: "rig",
          parameters: { spacing: { value: 1 } },
          bindings: [
            {
              id: "marker",
              position: [
                { $anchor: { node: "mirror", point: "origin", axis: "x" } },
                0,
                0,
              ],
            },
            { id: "source", position: [{ $param: "spacing" }, 0, 0] },
          ],
        },
      },
      { op: "assemblyParameters", root: "rig", values: { spacing: 2 } },
    ]);
    const live = {
      bounds: funEditor.inspect({ id: "source" }).bounds,
      marker: funEditor.inspect({ id: "marker" }).node.position[0],
    };
    const { scene } = await new GLTFLoader().parseAsync(
        await funEditor.exportGLB(),
        "",
      ),
      bounds = new Box3().setFromObject(scene.getObjectByName("source"));
    await funEditor.flush();
    return {
      live,
      exported: {
        size: bounds.getSize(new Vector3()).toArray(),
        center: bounds.getCenter(new Vector3()).toArray(),
        marker: scene.getObjectByName("marker").position.x,
      },
    };
  });
  assert.deepEqual(consistency.exported, {
    size: [2, 1, 1],
    center: [2, 1, 0],
    marker: -2,
  });
  assert.deepEqual(consistency.live.bounds.size, consistency.exported.size);
  assert.deepEqual(consistency.live.bounds.center, consistency.exported.center);
  assert.equal(consistency.live.marker, -2);
  await page.reload();
  await page.waitForFunction(() => window.funEditor?.getRecipe);
  const reloaded = await page.evaluate(() => ({
    bounds: funEditor.inspect({ id: "source" }).bounds,
    marker: funEditor.inspect({ id: "marker" }).node.position[0],
  }));
  assert.deepEqual(reloaded, consistency.live);
  await writeFile(
    resolve(results, "editor-recipe-scope-evidence.json"),
    JSON.stringify({ fixed, rebound, consistency, reloaded }, null, 2),
  );
}

async function modelingIterationChecks(page, base) {
  await page.goto(base + "/workshop/?lang=zh&draft=modeling-iteration");
  await page.waitForFunction(() => window.funEditor?.presets);
  await page.evaluate(async () => {
    const { emptyProject } = await import("/workshop/document.js");
    funEditor.loadProject(emptyProject("Refinable box"));
    funEditor.apply([
      { op: "create", id: "box", kind: "box", material: "orange" },
      {
        op: "recipe",
        id: "box",
        definition: {
          parameters: { width: { value: 1 } },
          generator: {
            kind: "box",
            options: { size: [{ $param: "width" }, 1, 1] },
          },
          steps: [],
        },
      },
    ]);
    funEditor.select("box");
    funEditor.view();
  });
  await page.locator("#recipe-step-scope .recipe-scope-preview").click();
  await page.locator("#recipe-step-add").click();
  await page
    .locator('.recipe-step[data-step="0"] input[type="number"]')
    .fill("0.02");
  await page
    .locator('.recipe-step[data-step="0"] input[type="number"]')
    .dispatchEvent("change");
  await page.locator('#recipe-tools [data-parameter="width"]').fill("1.5");
  await page
    .locator("#recipe-tools")
    .getByRole("button", { name: "按参数重建", exact: true })
    .click();
  const refined = await page.evaluate(() => funEditor.inspect({ id: "box" }));
  assert.equal(refined.bounds.size[0], 1.5);
  assert.equal(refined.node.faces, 26);
  await page
    .getByRole("checkbox", { name: "启用步骤 1", exact: true })
    .uncheck();
  assert.equal(
    await page.evaluate(() => funEditor.inspect({ id: "box" }).node.faces),
    6,
  );
  await page.getByRole("checkbox", { name: "启用步骤 1", exact: true }).check();
  await page.locator("#recipe-step-kind").selectOption("mirror");
  await page.locator("#recipe-step-scope .recipe-scope-preview").click();
  await page.locator("#recipe-step-add").click();
  await page
    .locator('.recipe-step[data-step="1"]')
    .getByRole("button", { name: "上移", exact: true })
    .click();
  assert.equal(
    await page.evaluate(
      () => funEditor.inspect({ id: "box" }).node.recipe.steps[0].op,
    ),
    "mirror",
  );
  await page
    .locator('.recipe-step[data-step="0"]')
    .getByRole("button", { name: "删除", exact: true })
    .click();
  for (const [width, height] of [
    [1024, 768],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    await page.locator(".recipe-step").scrollIntoViewIfNeeded();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: resolve(results, "editor-recipe-steps-" + width + ".png"),
    });
  }
  const copied = await page.evaluate(async () => {
    const command = {
      op: "duplicate",
      id: "box",
      newId: "copy",
      offset: [2, 0, 0],
    };
    const result = funEditor.apply([command], {
      ifRevision: funEditor.inspect().revision,
      operationId: "mapped-copy",
    });
    await funEditor.flush();
    return result;
  });
  await page.reload();
  await page.waitForFunction(() => window.funEditor?.presets);
  const replay = await page.evaluate(() =>
    funEditor.apply(
      [{ op: "duplicate", id: "box", newId: "copy", offset: [2, 0, 0] }],
      { operationId: "mapped-copy" },
    ),
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.results[0].idMap, copied.results[0].idMap);
  const anchored = await page.evaluate(async () => {
    const { emptyProject } = await import("/workshop/document.js");
    const { GLTFLoader } = await import("/runtime/addons/GLTFLoader.js");
    funEditor.loadProject(emptyProject("Linked anchor"));
    funEditor.apply([
      { op: "create", id: "module", kind: "group" },
      { op: "create", id: "source", parent: "module", kind: "box" },
      {
        op: "duplicate",
        id: "source",
        newId: "copy",
        linked: true,
        offset: [2, 0, 0],
      },
      {
        op: "create",
        id: "marker",
        parent: "module",
        kind: "box",
        options: { size: [0.1, 0.1, 0.1] },
      },
      {
        op: "assembly",
        definition: {
          root: "module",
          parameters: { width: { value: 1 } },
          bindings: [
            {
              id: "marker",
              position: [
                { $anchor: { node: "copy", point: "max", axis: "x" } },
                0,
                0,
              ],
            },
            { id: "copy", position: [2, 0, 0] },
            { id: "source", options: { size: [{ $param: "width" }, 1, 1] } },
          ],
        },
      },
      { op: "assemblyParameters", root: "module", values: { width: 2 } },
    ]);
    const live = funEditor.inspect({ id: "marker" }).node.position[0];
    const { scene } = await new GLTFLoader().parseAsync(
      await funEditor.exportGLB(),
      "",
    );
    const exported = scene.getObjectByName("marker").position.x;
    await funEditor.flush();
    return { live, exported };
  });
  await page.reload();
  await page.waitForFunction(() => window.funEditor?.presets);
  anchored.reloaded = await page.evaluate(
    () => funEditor.inspect({ id: "marker" }).node.position[0],
  );
  assert.deepEqual(anchored, { live: 3, exported: 3, reloaded: 3 });
  await page.evaluate(async () => {
    const { emptyProject } = await import("/workshop/document.js");
    funEditor.loadProject(emptyProject("Keep detached dimensions"));
    funEditor.apply([
      ...funEditor.presets().toolbox,
      { op: "duplicate", id: "toolbox", newId: "second", assetMode: "linked" },
      { op: "group", ids: ["toolbox", "second"], newId: "rack" },
      {
        op: "assembly",
        definition: {
          root: "rack",
          parameters: { width: { value: 1 } },
          bindings: [
            { id: "second", assetValues: { width: { $param: "width" } } },
          ],
        },
      },
    ]);
    funEditor.select("second");
  });
  await page.locator('[data-inspector-target="assembly-tools"]').click();
  await page.locator('[data-detach-field="assetValues"]').click();
  const kept = await page.evaluate(
    () => funEditor.inspect({ id: "second-1" }).bounds.size[0],
  );
  assert.ok(Math.abs(kept - 1) < 1e-9);
  await page.evaluate(() => {
    funEditor.undo();
    funEditor.select("second");
  });
  await page
    .getByRole("button", { name: "解除并恢复共享值", exact: true })
    .click();
  const inherited = await page.evaluate(
    () => funEditor.inspect({ id: "second-1" }).bounds.size[0],
  );
  assert.ok(Math.abs(inherited - 0.72) < 1e-9);
  await writeFile(
    resolve(results, "editor-modeling-iteration-evidence.json"),
    JSON.stringify(
      {
        anchored,
        kept,
        inherited,
        idMap: replay.results[0].idMap,
        refined: { width: refined.bounds.size[0], faces: refined.node.faces },
      },
      null,
      2,
    ),
  );
}

export async function deliveryIterationChecks(page) {
  const painted = await page.evaluate(async () => {
    const { emptyProject } = await import("/workshop/document.js");
    funEditor.loadProject(emptyProject("Painted mirror"));
    funEditor.apply([
      { op: "create", id: "box", kind: "box", material: "orange" },
      {
        op: "recipe",
        id: "box",
        definition: {
          parameters: { width: { value: 1 } },
          generator: {
            kind: "box",
            options: { size: [{ $param: "width" }, 1, 1] },
          },
          steps: [],
        },
      },
      {
        op: "paint",
        id: "box",
        select: { kind: "faces", normal: [0, 0, -1], space: "local" },
        material: "cream",
      },
      { op: "mirror", id: "box", axis: "x" },
    ]);
    await funEditor.flush();
    const buffer = await funEditor.exportGLB();
    const view = new DataView(buffer);
    const gltf = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(buffer, 20, view.getUint32(12, true)),
      ),
    );
    return {
      materials: gltf.materials.length,
      primitives: gltf.meshes[0].primitives.length,
      project: funEditor.getProject(),
    };
  });
  assert.equal(painted.materials, 2);
  assert.equal(painted.primitives, 2);
  await page.reload();
  await page.waitForFunction(() => window.funEditor?.presets);
  assert.deepEqual(
    await page.evaluate(() => funEditor.getProject()),
    painted.project,
  );
  await page.evaluate(async () => {
    const { emptyProject } = await import("/workshop/document.js");
    funEditor.loadProject(emptyProject("Linked tools"));
    funEditor.apply(funEditor.presets().toolbox);
    funEditor.apply([
      {
        op: "duplicate",
        id: "toolbox",
        newId: "second",
        assetMode: "linked",
        offset: [1.2, 0, 0],
      },
    ]);
    funEditor.select("second");
    funEditor.view();
  });
  await page.locator('[data-override-parameter="openAngle"]').click();
  await page
    .locator('#assembly-tools [data-parameter="openAngle"]')
    .fill("-90");
  await page
    .locator("#assembly-tools")
    .getByRole("button", { name: "按参数重建", exact: true })
    .click();
  await page.evaluate(() =>
    funEditor.apply([
      { op: "assemblyParameters", root: "toolbox", values: { height: 0.6 } },
    ]),
  );
  assert.equal(
    await page.evaluate(
      () =>
        funEditor.getProject().nodes.find((n) => n.id === "second-2")
          .rotation[0],
    ),
    -90,
  );
  for (const width of [1024, 1920]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 1080 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: resolve(results, `editor-instance-overrides-${width}.png`),
    });
  }
  await page.evaluate(() => funEditor.select("second-2"));
  await page.locator('[data-inspector-target="assembly-tools"]').click();
  await page.locator('[data-detach-field="rotation"]').click();
  await page.evaluate(() =>
    funEditor.apply([
      { op: "set", id: "second-2", rotation: [-70, 0, 0] },
      { op: "assemblyParameters", root: "toolbox", values: { height: 0.7 } },
    ]),
  );
  const merged = await page.evaluate(async () => {
    const THREE = await import("/runtime/three.js");
    const { GLTFLoader } = await import("/runtime/addons/GLTFLoader.js");
    const project = funEditor.getProject();
    const ids = project.nodes
      .filter((n) => n.mesh && n.name.startsWith("foot-"))
      .map((n) => n.id);
    const report = funEditor.exportReport({ mergeStatic: ids });
    const buffer = await funEditor.exportGLB({ mergeStatic: ids });
    const { scene } = await new GLTFLoader().parseAsync(buffer, "");
    const groups = [];
    scene.traverse((o) => {
      if (o.userData.sourceIds) groups.push(o);
    });
    const center = (o) =>
      new THREE.Box3().setFromObject(o, true).getCenter(new THREE.Vector3()).x;
    const before = groups.map(center);
    scene.getObjectByName("toolbox").position.x += 1;
    scene.updateMatrixWorld(true);
    return {
      report: report.mergeGroups,
      parents: groups.map((o) => o.parent.name),
      moved: groups.map((o, i) => center(o) - before[i]),
      selected: ids.length,
    };
  });
  assert.equal(merged.selected, 8);
  assert.deepEqual(merged.parents, ["toolbox", "second"]);
  assert.ok(Math.abs(merged.moved[0] - 1) < 1e-6);
  assert.ok(Math.abs(merged.moved[1]) < 1e-6);
  assert.ok(merged.report.every((g) => g.sourceIds.length === 4));
  assert.ok(merged.report.every((g) => g.material === "ink"));
  await page.evaluate(async () => {
    await funEditor.flush();
    const project = funEditor.getProject();
    project.nodes.find((n) => n.id === "body").recipe.paint = {
      layout: "damaged-layout",
      faces: [{ id: "f0", vertices: [0, 1, 2], material: "cream" }],
    };
    localStorage.setItem(
      "fun.dev.editor.project.v2:" + funEditor.inspect().draftId,
      JSON.stringify({ project, revision: funEditor.inspect().revision + 1 }),
    );
  });
  await page.reload();
  await page.waitForFunction(() => window.funEditor?.presets);
  const recovery = await page.evaluate(() => {
    const session = funEditor.getSession(),
      state = funEditor.inspect();
    let code;
    try {
      funEditor.apply([{ op: "renameProject", name: "Should not write" }]);
    } catch (e) {
      code = e.code;
    }
    return {
      name: session.project.name,
      code,
      recovery: session.recovery,
      writable: state.writable,
      layout: session.project.nodes.find((n) => n.id === "body").recipe.paint
        .layout,
      cached: funEditor.getProject().nodes.length,
    };
  });
  assert.equal(recovery.name, "Linked tools");
  assert.equal(recovery.writable, false);
  assert.equal(recovery.code, "recovery");
  assert.equal(recovery.layout, "damaged-layout");
  assert.ok(recovery.cached > 0);
  assert.ok(await page.locator("#draft-original").isVisible());
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#draft-original").click(),
  ]);
  await download.saveAs(
    resolve(results, "editor-recovery-original.funmodel.json"),
  );
  await page.screenshot({
    path: resolve(results, "editor-protected-recovery.png"),
  });
  const [copy] = await Promise.all([
    page.context().waitForEvent("page"),
    page.locator("#draft-copy").click(),
  ]);
  await copy.waitForFunction(() => window.funEditor?.presets);
  assert.equal(await copy.evaluate(() => funEditor.inspect().writable), true);
  assert.equal(
    await copy.evaluate(() => funEditor.getProject().name),
    "Linked tools",
  );
  await copy.close();
  await writeFile(
    resolve(results, "editor-delivery-iteration-evidence.json"),
    JSON.stringify(
      {
        painted: {
          materials: painted.materials,
          primitives: painted.primitives,
        },
        merged,
        recovery,
      },
      null,
      2,
    ),
  );
}

async function agentReliabilityChecks(page, base) {
  // A pending human parameter must survive an unrelated agent mutation attempt.
  await page.locator('[data-parameter="width"]').fill("0.91");
  const pending = await page.evaluate(() => {
    let code;
    try {
      funEditor.apply([{ op: "material", id: "ink", roughness: 0.6 }]);
    } catch (e) {
      code = e.code;
    }
    return { code, pending: funEditor.inspect().pendingInput };
  });
  assert.equal(pending.code, "pending_input");
  assert.ok(pending.pending);
  assert.equal(
    await page.locator('[data-parameter="width"]').inputValue(),
    "0.91",
  );
  await page
    .locator("#recipe-tools button")
    .filter({ hasText: "取消" })
    .click();
  const paint = await page.evaluate(() => {
    const a = funEditor,
      faces = a.query({
        id: "body",
        kind: "faces",
        space: "local",
        normal: [0, 1, 0],
        at: { axis: "y", value: 0.2 },
      }).items;
    a.apply([
      {
        op: "paint",
        id: "body",
        faces: faces.map((f) => f.ref),
        material: "cream",
      },
    ]);
    a.apply([{ op: "recipeParameters", id: "body", values: { width: 0.92 } }]);
    return {
      recipe: !!a.inspect({ id: "body" }).node.recipe,
      colors: faces.map(
        (f) =>
          a
            .inspect({ id: "body", detail: "full" })
            .node.mesh.faces.find((v) => v.id === f.id).material,
      ),
    };
  });
  assert.ok(paint.recipe && paint.colors.every((c) => c === "cream"));
  // Reproduce the previous quota issue at the original, modest geometry budget.
  const storage = await page.evaluate(async () => {
    const a = funEditor,
      { emptyProject } = await import("/workshop/document.js");
    a.loadProject(emptyProject("Storage regression"));
    a.apply([
      {
        op: "create",
        id: "lamp",
        kind: "sphere",
        options: { segments: 16, rings: 8 },
      },
      ...Array.from({ length: 23 }, (_, i) => ({
        op: "duplicate",
        id: "lamp",
        newId: `lamp-${i}`,
        linked: true,
      })),
    ]);
    let replyBytes = 0;
    for (let i = 0; i < 18; i++) {
      const result = a.apply(
        [
          {
            op: "parameters",
            id: "lamp",
            options: { radius: 0.2 + i * 0.005 },
          },
        ],
        { operationId: `radius-${i}`, ifRevision: a.inspect().revision },
      );
      replyBytes = Math.max(replyBytes, JSON.stringify(result).length);
    }
    a.apply(
      Array.from({ length: 8 }, (_, i) => ({
        op: "duplicate",
        id: "lamp",
        newId: `extra-${i}`,
        linked: true,
      })),
    );
    a.checkpoint({ name: "32 lamps" });
    const saved = await a.flush(),
      record = a.getSession();
    return {
      revision: a.inspect().revision,
      nodes: record.project.nodes.length,
      replyBytes,
      saved,
      recordBytes: JSON.stringify(record).length,
    };
  });
  assert.equal(storage.nodes, 32);
  assert.equal(storage.saved.state, "saved");
  assert.ok(storage.replyBytes < 15000 && storage.recordBytes < 1500000);
  await page.reload();
  await page.waitForFunction(() => window.funEditor);
  assert.equal(
    await page.evaluate(() => funEditor.getProject().nodes.length),
    32,
  );
  assert.equal(
    await page.evaluate(() => funEditor.inspect().revision),
    storage.revision,
  );
  // IndexedDB failure must remain visible to API callers, and be recoverable.
  const failure = await page.evaluate(async () => {
    await funEditor.flush();
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("Controlled quota failure", "QuotaExceededError");
    };
    const result = funEditor.apply([
      { op: "renameProject", name: "Applied but unsaved" },
    ]);
    let error;
    try {
      await funEditor.flush();
    } catch (e) {
      error = { code: e.code, persistence: e.persistence };
    }
    IDBObjectStore.prototype.put = original;
    return { result, error, state: funEditor.inspect().persistence };
  });
  assert.equal(failure.result.persistence.state, "pending");
  assert.equal(failure.error.code, "storage");
  assert.equal(failure.state.state, "failed");
  await page.locator("#draft-retry").click();
  await page.evaluate(() => funEditor.flush());
  assert.equal(
    await page.evaluate(() => funEditor.inspect().persistence.state),
    "saved",
  );
  // Validate the selected export, not an unrelated invalid part.
  const exported = await page.evaluate(async () => {
    const a = funEditor,
      { emptyProject } = await import("/workshop/document.js");
    a.loadProject(emptyProject());
    a.apply([
      { op: "create", id: "bad", kind: "box" },
      { op: "create", id: "lid", kind: "box" },
    ]);
    const p = a.getProject();
    delete p.nodes[0].generator;
    p.nodes[0].mesh.faces.push({
      ...structuredClone(p.nodes[0].mesh.faces[0]),
      id: "overlap",
    });
    a.loadProject(p);
    let blocked;
    try {
      await a.exportGLB();
    } catch (e) {
      blocked = e.code;
    }
    const part = await a.exportGLB({ ids: ["lid"], encoding: "base64" }),
      forced = await a.exportGLB({ force: true, encoding: "base64" });
    const { GLTFLoader } = await import("/runtime/addons/GLTFLoader.js"),
      g = await new GLTFLoader().parseAsync(
        Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0)).buffer,
        "",
      );
    const result = {
      blocked,
      valid: part.report.validation.ok,
      forced: forced.report.forced,
      errors: forced.report.validation.errors.length,
      hasBad: !!g.scene.getObjectByName("bad"),
    };
    g.scene.traverse((o) => {
      o.geometry?.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material])
        m?.dispose();
    });
    return result;
  });
  assert.equal(exported.blocked, "export_validation");
  assert.ok(
    exported.valid &&
      exported.forced &&
      exported.errors > 0 &&
      !exported.hasBad,
  );
  await page.locator("#assembly-preset").click();
  await page.locator('#assembly-tools [data-parameter="width"]').fill("0.92");
  await page
    .locator("#assembly-tools button")
    .filter({ hasText: "按参数重建" })
    .click();
  assert.ok(
    Math.abs(
      (await page.evaluate(
        () => funEditor.inspect({ id: "lid" }).node.generator.options.size[0],
      )) - 0.94,
    ) < 1e-9,
  );
  await page.evaluate(() => funEditor.flush());
  await page.screenshot({ path: resolve(results, "editor-assembly-wide.png") });
  await page.locator("#export-report").click();
  await page.locator(".delivery-summary").waitFor({ state: "visible" });
  await page.screenshot({
    path: resolve(results, "editor-delivery-report.png"),
  });
  assert.ok(await page.locator(".delivery-summary").isVisible());
  await page.locator('[data-close="info-dialog"]').click();
  // Existing localStorage drafts retain project, checkpoints and retry IDs during migration.
  await page.evaluate(async () => {
    await funEditor.flush();
    const project = funEditor.getProject();
    localStorage.setItem(
      "fun.dev.editor.project.v2:legacy-migration",
      JSON.stringify({
        project,
        revision: 17,
        checkpoints: [
          {
            id: "legacy-checkpoint",
            name: "Before migration",
            revision: 16,
            project,
          },
        ],
        receipts: [
          [
            "legacy-edit",
            {
              signature: JSON.stringify([
                { op: "renameProject", name: "Legacy" },
              ]),
              result: {
                revision: 17,
                changed: [],
                geometry: Array(100).fill({ faces: [1, 2, 3] }),
              },
            },
          ],
        ],
      }),
    );
  });
  await page.goto(`${base}/workshop/?lang=zh&draft=legacy-migration`);
  await page.waitForFunction(() => window.funEditor);
  const migrated = await page.evaluate(async () => ({
    saved: await funEditor.flush(),
    session: funEditor.getSession(),
    journal: JSON.parse(
      localStorage.getItem("fun.dev.editor.project.v2:legacy-migration"),
    ),
  }));
  assert.equal(migrated.saved.persistedRevision, 17);
  assert.equal(migrated.session.checkpoints[0].id, "legacy-checkpoint");
  assert.equal(migrated.session.receipts[0][0], "legacy-edit");
  assert.ok(
    !migrated.session.receipts[0][1].result.geometry &&
      !migrated.journal.receipts,
  );
  await writeFile(
    resolve(results, "editor-reliability-evidence.json"),
    JSON.stringify({ storage, pending, paint, failure, exported }, null, 2),
  );
}

async function assetIterationChecks(page) {
  await page.locator("#assembly-preset").click();
  assert.equal(await page.locator('[name="position-1"]').isDisabled(), true);
  await page.locator("#detach-binding").click();
  assert.equal(await page.locator('[name="position-1"]').isDisabled(), false);
  await page.locator('[name="position-1"]').fill("0.32");
  await page.locator('[name="position-1"]').press("Tab");
  assert.equal(
    await page.evaluate(
      () => funEditor.inspect({ id: "body" }).node.position[1],
    ),
    0.32,
  );
  await page.locator("#assembly-preset").click();
  await page.locator('[data-node="toolbox"]').click();
  await page.locator("#asset-copy-mode").selectOption("independent");
  await page.locator("#duplicate").click();
  const root = await page.evaluate(() => funEditor.inspect().selection.id);
  await page.locator('#assembly-tools [data-parameter="width"]').fill("1.05");
  await page
    .locator("#assembly-tools")
    .getByRole("button", { name: "按参数重建", exact: true })
    .click();
  const scopes = await page.evaluate((root) => {
    const p = funEditor.getProject();
    const before = p.nodes.find((n) => n.id === root + "-2").position;
    funEditor.apply([
      { op: "set", id: root, rotation: [0, 0, 45], position: [1.4, 0.3, 0] },
    ]);
    funEditor.view();
    const after = funEditor
      .getProject()
      .nodes.find((n) => n.id === root + "-2").position;
    return {
      before,
      after,
      original: p.assemblies.find((a) => a.root === "toolbox").parameters.width
        .value,
      copy: p.assemblies.find((a) => a.root === root).parameters.width.value,
    };
  }, root);
  assert.equal(scopes.original, 0.72);
  assert.equal(scopes.copy, 1.05);
  scopes.before.forEach((v, i) =>
    assert.ok(Math.abs(v - scopes.after[i]) < 1e-9),
  );
  await page.screenshot({ path: resolve(results, "editor-scoped-assets.png") });
  const delivered = await page.evaluate(async (root) => {
    const p = funEditor.getProject();
    p.assemblies.find((a) => a.root === root).parameters.width.value = 1.2;
    funEditor.loadProject(p);
    const data = await funEditor.exportGLB({ ids: [root] });
    const json = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(data, 20, new DataView(data).getUint32(12, true)),
      ),
    );
    const mesh =
      json.meshes[json.nodes.find((n) => n.name === root + "-1").mesh];
    const position = json.accessors[mesh.primitives[0].attributes.POSITION];
    return position.max[0] - position.min[0];
  }, root);
  assert.ok(Math.abs(delivered - 1.2) < 1e-6);
  await page.evaluate(async () => {
    const { emptyProject } = await import("/workshop/document.js");
    funEditor.loadProject(emptyProject("Paint recovery"));
    funEditor.apply([
      { op: "create", id: "knob", kind: "cylinder", material: "ink" },
      {
        op: "recipe",
        id: "knob",
        definition: {
          parameters: { segments: { value: 8, min: 6, max: 24 } },
          generator: {
            kind: "cylinder",
            options: { segments: { $param: "segments" } },
          },
          steps: [],
        },
      },
      {
        op: "paint",
        id: "knob",
        select: { kind: "faces", space: "local", normal: [0, 1, 0] },
        material: "cream",
      },
    ]);
    funEditor.select("knob");
    funEditor.view();
  });
  await page.locator('#recipe-tools [data-parameter="segments"]').fill("12");
  await page
    .locator("#recipe-tools")
    .getByRole("button", { name: "按参数重建", exact: true })
    .click();
  await page
    .getByRole("button", { name: "按朝向绑定并重建", exact: true })
    .click();
  const paint = await page.evaluate(() => ({
    segments: funEditor.inspect({ id: "knob" }).node.recipe.parameters.segments
      .value,
    top: funEditor.query({ id: "knob", space: "local", normal: [0, 1, 0] })
      .items[0].material,
    pending: funEditor.inspect().pendingInput,
  }));
  assert.deepEqual(paint, { segments: 12, top: "cream", pending: false });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({
    path: resolve(results, "editor-paint-recovery-1024.png"),
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.screenshot({
    path: resolve(results, "editor-paint-recovery-1920.png"),
  });
  await writeFile(
    resolve(results, "editor-asset-iteration-evidence.json"),
    JSON.stringify({ scopes, delivered, paint }, null, 2),
  );
}
