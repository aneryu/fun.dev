import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { watch } from "./harness.mjs";
import { parseModelFile, workshopProject } from "../../site/workshop/glb.js";

// Project files, GLB import and "Open in workshop" from the model library.
export async function editorImportChecks({ browser, base }) {
  const errors = [],
    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      serviceWorkers: "block",
      acceptDownloads: true,
    });
  const page = watch(await context.newPage(), errors);
  page.on("dialog", (dialog) => dialog.accept());
  try {
    await page.goto(`${base}/workshop/?lang=en&draft=import-check`);
    await page.waitForFunction(() => window.funEditor);
    // A project file restores the duck exactly, linked mirror included.
    const files = await page.evaluate(async () => {
      const before = funEditor.getProject(),
        project = await funEditor.exportProject(),
        plain = await funEditor.exportGLB({ encoding: "base64" }),
        opened = funEditor.importGLB(
          { data: project.data },
          { ifRevision: funEditor.inspect().revision },
        );
      return {
        nodes: before.nodes.length,
        same: JSON.stringify(before) === JSON.stringify(funEditor.getProject()),
        container: opened.container,
        filename: project.filename,
        project: project.data,
        plain: plain.data,
        bounds: funEditor.inspect().bounds,
      };
    });
    assert.ok(files.same, "project file round trip");
    assert.equal(files.container, true);
    assert.match(files.filename, /^Little-duck\.funmodel\.glb$/);
    // A plain GLB becomes editable parts in the same place, undoable in one step.
    const plain = await page.evaluate((data) => {
      const revision = funEditor.inspect().revision,
        result = funEditor.importGLB(
          { data, name: "Reimported" },
          { ifRevision: revision },
        ),
        project = funEditor.getProject(),
        bounds = funEditor.inspect().bounds;
      funEditor.undo({ ifRevision: funEditor.inspect().revision });
      return {
        container: result.container,
        warnings: result.warnings,
        name: project.name,
        ids: project.nodes.map((n) => n.id),
        linked: project.nodes.filter((n) => n.instanceOf).length,
        bounds,
        restored: funEditor.getProject().name,
        errors: funEditor.validate().errors.length,
      };
    }, files.plain);
    assert.equal(plain.container, false);
    assert.deepEqual(plain.warnings, []);
    assert.equal(plain.name, "Reimported");
    assert.ok(["body", "head", "beak", "wing-right"].every((id) => plain.ids.includes(id)), plain.ids.join());
    for (const key of ["min", "max"])
      plain.bounds[key].forEach((v, i) =>
        assert.ok(Math.abs(v - files.bounds[key][i]) < 1e-4, `${key} ${i}`),
      );
    assert.equal(plain.restored, "Little duck");
    // Adding parts under an existing node keeps every current part.
    const added = await page.evaluate((data) => {
      const count = funEditor.getProject().nodes.length,
        result = funEditor.importGLB(
          { data, mode: "add", parent: "duck" },
          { ifRevision: funEditor.inspect().revision },
        );
      const project = funEditor.getProject();
      return {
        before: count,
        after: project.nodes.length,
        roots: result.nodes.filter(
          (id) => project.nodes.find((n) => n.id === id).parent === "duck",
        ),
        clashes: result.nodes.filter((id) => /-\d+$/.test(id)).length,
      };
    }, files.plain);
    assert.equal(added.after, added.before * 2 + 1, "every part plus the root");
    assert.equal(added.roots.length, 1);
    assert.ok(added.clashes > 0, "clashing IDs get suffixes");
    // JSON projects still open from the page.
    const json = await page.evaluate(() => JSON.stringify(funEditor.getProject()));
    await page.locator("#project-file").setInputFiles({
      name: "scene.funmodel.json",
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });
    await page.waitForFunction(() => /opened/.test(document.querySelector("#status").textContent));
    assert.equal(await page.evaluate(() => JSON.stringify(funEditor.getProject())), json);
    // The page's own buttons: Open takes a GLB, Save downloads a project file.
    await page.locator("#project-file").setInputFiles({
      name: "duck.funmodel.glb",
      mimeType: "model/gltf-binary",
      buffer: Buffer.from(files.project, "base64"),
    });
    await page.waitForFunction(
      (count) => funEditor.getProject().nodes.length === count,
      files.nodes,
    );
    assert.match(await page.locator("#status").textContent(), /recipes and links/);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#save").click(),
    ]);
    assert.match(download.suggestedFilename(), /\.funmodel\.glb$/);
    const saved = parseModelFile(new Uint8Array(await readFile(await download.path())));
    assert.equal(workshopProject(saved.json).name, "Little duck");
    assert.ok(saved.json.nodes.some((n) => n.name === "body"));

    // "Open in workshop": a library version opens in a draft of its own.
    const sha = "a".repeat(64),
      source = "b".repeat(64),
      record = (files) => ({
        id: "test_duck_01",
        type: "prop",
        name: { zh: "鸭子", en: "Duck" },
        description: { zh: "测试", en: "Test" },
        listed: true,
        versions: [
          { version: "v002", files, stats: { size: [1, 1, 1], triangles: 10, bytes: 10 } },
          { version: "v001", files: { "model.glb": { sha256: sha, size: 10 } }, stats: { size: [1, 1, 1], triangles: 10, bytes: 10 } },
        ],
      });
    let withSource = false;
    await context.route("**/library/test_duck_01.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          record({
            "model.glb": { sha256: sha, size: 10 },
            ...(withSource ? { "source.funmodel.glb": { sha256: source, size: 10 } } : {}),
          }),
        ),
      }),
    );
    await context.route(`**/blobs/${sha}.glb`, (route) =>
      route.fulfill({ status: 200, contentType: "model/gltf-binary", body: Buffer.from(files.plain, "base64") }),
    );
    await context.route(`**/blobs/${source}.glb`, (route) =>
      route.fulfill({ status: 200, contentType: "model/gltf-binary", body: Buffer.from(files.project, "base64") }),
    );
    const library = await context.newPage();
    watch(library, errors);
    await library.goto(`${base}/workshop/?lang=en&open=test_duck_01&version=v001`);
    await library.waitForFunction(() => window.funEditor);
    const opened = await library.evaluate(() => ({
      search: location.search,
      name: funEditor.getProject().name,
      linked: funEditor.getProject().nodes.some((n) => n.symmetry),
      draft: funEditor.inspect().draftId,
    }));
    assert.match(opened.search, /^\?lang=en&draft=[0-9a-f-]{36}$/);
    assert.equal(opened.name, "test_duck_01 v001");
    assert.equal(opened.linked, false, "a plain GLB has no links");
    await library.reload();
    await library.waitForFunction(() => window.funEditor);
    assert.equal(await library.evaluate(() => funEditor.getProject().name), "test_duck_01 v001");
    await library.close();
    // A version with a workshop project restores its links and recipes.
    withSource = true;
    const project = await context.newPage();
    watch(project, errors);
    await project.goto(`${base}/workshop/?lang=en&open=test_duck_01`);
    await project.waitForFunction(() => window.funEditor);
    assert.equal(
      await project.evaluate(() => funEditor.getProject().nodes.some((n) => n.symmetry)),
      true,
    );
    await project.close();
    // The draft the page started in is untouched.
    assert.equal(
      await page.evaluate(() => funEditor.getProject().name),
      "Little duck",
    );
  } finally {
    await context.close();
  }
  assert.deepEqual(errors, []);
}
