import assert from "node:assert/strict";
import { watch } from "./harness.mjs";

// The geometry kernel, PBR material export, naming conventions and reference images, in
// the page itself (WebAssembly under the workshop's policy).
const glbJSON = (base64) => {
  const bytes = Buffer.from(base64, "base64"),
    length = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + length).toString("utf8"));
};

export async function editorSolidChecks({ browser, base }) {
  const errors = [],
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      serviceWorkers: "block",
    }),
    page = watch(await context.newPage(), errors);
  try {
    await page.goto(`${base}/editor/?lang=zh`);
    await page.waitForFunction(() => window.funEditor);
    await page.evaluate(async () => {
      const { emptyProject } = await import("/editor/document.js");
      funEditor.loadProject({
        ...emptyProject("Kernel"),
        materials: [
          { id: "mat_steel", name: "steel", color: "#8c9399", roughness: 0.3, metalness: 1 },
          { id: "mat_glass", name: "glass", color: "#9fc3cf", roughness: 0.05, transmission: 0.9, ior: 1.45 },
          { id: "mat_light", name: "light", color: "#fff3c4", emissive: "#ffe9a8", emissiveIntensity: 4 },
          { id: "mat_veil", name: "veil", color: "#ffffff", opacity: 0.5, doubleSided: true },
        ],
      });
      funEditor.apply([
        { op: "create", id: "crate", kind: "group" },
        { op: "create", id: "body", kind: "box", parent: "crate", material: "mat_steel", options: { size: [1, 1, 1] } },
        { op: "create", id: "lid", kind: "box", parent: "crate", material: "mat_glass", position: [0, 0.55, 0], options: { size: [1, 0.1, 1] } },
        { op: "create", id: "lamp", kind: "sphere", parent: "crate", material: "mat_light", position: [0, 0.8, 0], options: { radius: 0.1 } },
        { op: "create", id: "veil", kind: "box", parent: "crate", material: "mat_veil", position: [0, 0, 0.6], options: { size: [1, 1, 0.01] } },
        { op: "create", id: "hole", kind: "cylinder", parent: "crate", position: [0, 0, 0], rotation: [90, 0, 0], options: { radius: 0.2, height: 2 } },
      ]);
    });

    // Boolean through the page: the last selected part is the target, the tool is used up.
    await page.evaluate(() => funEditor.select(["hole", "body"]));
    await page.locator('[data-boolean="difference"]').click();
    const cut = await page.evaluate(() => {
      const state = funEditor.inspect();
      return {
        ids: state.nodes.map((n) => n.id),
        body: funEditor.inspect({ id: "body" }).node.faces,
        warnings: funEditor.validate().warnings.map((w) => w.code),
      };
    });
    assert.ok(!cut.ids.includes("hole"), "the tool is consumed");
    assert.ok(cut.body > 6, "the cut adds faces");
    assert.deepEqual(cut.warnings.filter((c) => ["open-edges", "nonmanifold"].includes(c)), []);

    // PBR materials, the root name and library merge-group names reach the GLB.
    const exported = await page.evaluate(() =>
      funEditor.exportGLB({ rootName: "crate_01_ROOT", mergeStatic: ["body", "lid"], encoding: "base64" }),
    );
    const gltf = glbJSON(exported.data),
      material = (name) => gltf.materials.find((m) => m.name === name);
    assert.equal(material("mat_steel").pbrMetallicRoughness.metallicFactor, 1);
    assert.ok(material("mat_glass").extensions.KHR_materials_transmission.transmissionFactor > 0.89);
    assert.equal(material("mat_glass").extensions.KHR_materials_ior.ior, 1.45);
    assert.equal(material("mat_light").extensions.KHR_materials_emissive_strength.emissiveStrength, 4);
    assert.equal(material("mat_veil").alphaMode, "BLEND");
    assert.equal(material("mat_veil").doubleSided, true);
    for (const extension of ["KHR_materials_transmission", "KHR_materials_ior", "KHR_materials_emissive_strength"])
      assert.ok(gltf.extensionsUsed.includes(extension), extension);
    const names = gltf.nodes.map((n) => n.name);
    assert.ok(gltf.meshes.every((m) => m.name), "meshes carry their node names, as Blender exports do");
    assert.ok(names.includes("crate_01_ROOT"), names.join(","));
    // One top-level asset group becomes the named root itself; its static parts merge into
    // static__<material> beside the moving ones.
    assert.ok(names.includes("static__mat_steel") && names.includes("static__mat_glass"), names.join(","));
    assert.ok(!names.includes("crate"), "no extra wrapper around the root");

    // "auto" merges the static parts directly under the root; observe also takes views.
    const auto = await page.evaluate(() => funEditor.exportReport({ rootName: "crate_01_ROOT", mergeStatic: "auto" }));
    assert.ok(auto.mergeGroups.some((g) => g.id === "static__mat_steel"), JSON.stringify(auto.mergeGroups));

    // Renaming through the object panel keeps the part selected.
    await page.evaluate(() => funEditor.select("lamp"));
    await page.locator("#node-id").fill("lamp_light");
    await page.locator("#node-id").press("Enter");
    assert.deepEqual(
      await page.evaluate(() => [funEditor.inspect().selection.id, funEditor.inspect().nodes.some((n) => n.id === "lamp")]),
      ["lamp_light", false],
    );

    // A reference image appears in its own view only, and only when asked for.
    const shots = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 32;
      const g = canvas.getContext("2d");
      g.fillStyle = "#d02020";
      g.fillRect(0, 0, 64, 32);
      await funEditor.setReference({ view: "front", image: canvas.toDataURL("image/png"), width: 3, center: [0, 0.3], opacity: 1 });
      const plain = funEditor.renderViews(["front"], { size: 128 })[0].dataUrl,
        traced = funEditor.renderViews(["front"], { size: 128, references: true })[0].dataUrl,
        side = funEditor.renderViews(["left"], { size: 128, references: true })[0].dataUrl,
        sidePlain = funEditor.renderViews(["left"], { size: 128 })[0].dataUrl;
      const listed = funEditor.references();
      await funEditor.clearReference({ view: "front" });
      return { plain, traced, side, sidePlain, listed, after: funEditor.references() };
    });
    assert.notEqual(shots.plain, shots.traced, "the reference shows in its view");
    assert.equal(shots.side, shots.sidePlain, "other views stay clean");
    assert.deepEqual(shots.listed.map((r) => r.view), ["front"]);
    assert.deepEqual(shots.after, []);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
