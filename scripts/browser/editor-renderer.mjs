import assert from "node:assert/strict";
import { resolve } from "node:path";
import { results, watch } from "./harness.mjs";
import { decodePNG } from "../png.mjs";

export async function editorRendererChecks({ browser, base, expectedBackend }) {
  // software: forced with ?renderer=software; no-webgl: a browser without WebGPU and WebGL
  // (cloud browsers without a GPU), where the workshop draws in software on its own.
  for (const mode of ["auto", "forced", "unavailable", "adapter-missing", "software", "no-webgl"]) {
    const errors = [],
      context = await browser.newContext({
        viewport: { width: 1024, height: 768 },
        serviceWorkers: "block",
      });
    try {
      if (mode === "unavailable")
        await context.addInitScript(() => {
          Object.defineProperty(navigator, "gpu", { value: undefined });
        });
      if (mode === "no-webgl")
        await context.addInitScript(() => {
          Object.defineProperty(navigator, "gpu", { value: undefined });
          const getContext = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
            return /^(webgl2?|experimental-webgl|webgpu)$/.test(type) ? null : getContext.call(this, type, ...rest);
          };
        });
      if (mode === "adapter-missing")
        await context.addInitScript(() => {
          Object.defineProperty(navigator, "gpu", {
            value: {
              requestAdapter() {
                if (window.delayPreview) {
                  window.previewStarted = true;
                  return new Promise((resolve) => {
                    window.releasePreview = () => resolve(null);
                  });
                }
                return Promise.resolve(null);
              },
            },
          });
        });
      const page = watch(await context.newPage(), errors);
      await page.goto(
        `${base}/workshop/?lang=zh${mode === "forced" ? "&renderer=webgl" : mode === "software" ? "&renderer=software" : ""}`,
      );
      await page.waitForFunction(() => window.funEditor);
      const info = await page.evaluate(() => funEditor.inspect().renderer);
      const software = mode === "software" || mode === "no-webgl";
      assert.ok(["webgpu", "webgl2", "software"].includes(info.backend));
      if (mode !== "auto" || expectedBackend)
        assert.equal(
          info.backend,
          mode === "auto" ? expectedBackend : software ? "software" : "webgl2",
        );
      const requested = { forced: "webgl2", software: "software" }[mode] ?? "auto";
      assert.equal(info.requested, requested);
      assert.equal(info.fallback, requested === "auto" && info.backend !== "webgpu");
      assert.equal(
        await page.locator("#renderer-label").textContent(),
        { webgpu: "WebGPU", webgl2: "WebGL2", software: "软件渲染" }[info.backend],
      );
      if (software)
        assert.match(await page.locator("#status").textContent(), /软件绘制/);
      const shots = await page.evaluate(() =>
        funEditor.renderViews(["front", "perspective"], { size: 256 }),
      );
      assert.ok(
        shots.every(
          (s) => s.width === 256 && s.height === 256 && s.dataUrl.length > 5000,
        ),
      );
      assert.notEqual(shots[0].dataUrl, shots[1].dataUrl);
      if (mode === "adapter-missing") {
        await page.evaluate(() => {
          window.delayPreview = true;
        });
        await page.locator("#parameters").click();
        await page.waitForFunction(() => window.previewStarted);
        await page.locator('[data-close="add-dialog"]').click();
        await page.evaluate(() => {
          window.delayPreview = false;
        });
      }
      await page.locator("#parameters").click();
      await page.waitForFunction(
        () => !document.querySelector("#shape-submit").disabled,
      );
      if (mode === "adapter-missing")
        await page.evaluate(() => window.releasePreview());
      assert.equal(
        await page.locator("#shape-canvas").getAttribute("data-renderer"),
        info.backend,
      );
      await page.locator("#radius").fill("1.1");
      await page.locator("#shape-submit").click();
      assert.equal(
        await page.evaluate(
          () =>
            funEditor.getProject().nodes.find((n) => n.id === "body").generator
              .options.radius,
        ),
        1.1,
      );
      await page.locator("#undo").click();
      assert.equal(
        await page.evaluate(() => funEditor.inspect().pendingInput),
        false,
      );
      await page.screenshot({
        path: resolve(results, `editor-renderer-${mode}-${info.backend}.png`),
      });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}

// The software renderer against the GPU path (SwiftShader WebGL 2 here): one project with
// curved, metal, glass and glowing parts, three views, the mean difference per pixel.
export async function softwareParityChecks({ browser, base }) {
  const arc = (cx, cy, r, from, to, n) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const a = ((from + ((to - from) * i) / n) * Math.PI) / 180;
      return [+(cx + r * Math.cos(a)).toFixed(4), +(cy + r * Math.sin(a)).toFixed(4)];
    });
  const project = {
    format: "fun.dev/model",
    version: 1,
    name: "parity",
    materials: [
      { id: "wood", name: "wood", color: "#c9a27a", roughness: 0.6 },
      { id: "blue", name: "blue", color: "#7f9fb5", roughness: 0.5 },
      { id: "steel", name: "steel", color: "#9aa3ab", roughness: 0.3, metalness: 1 },
      { id: "glass", name: "glass", color: "#d8eef5", roughness: 0.05, transmission: 0.9, ior: 1.5 },
      { id: "glow", name: "glow", color: "#202020", roughness: 0.8, emissive: "#ffb040", emissiveIntensity: 1.5 },
    ],
    nodes: [],
  };
  const commands = [
    { op: "create", id: "sphere", kind: "sphere", material: "wood", position: [-1.2, 0.3, 0], options: { radius: 0.3, segments: 32, rings: 16 } },
    { op: "create", id: "cylinder", kind: "cylinder", material: "blue", position: [-0.45, 0.3, 0], options: { radius: 0.25, height: 0.6, segments: 32 } },
    { op: "create", id: "metal", kind: "sphere", material: "steel", position: [0.35, 0.3, 0], options: { radius: 0.3, segments: 32, rings: 16 } },
    { op: "create", id: "pane", kind: "box", material: "glass", position: [1.1, 0.35, 0.2], options: { size: [0.5, 0.7, 0.05] } },
    { op: "create", id: "lamp", kind: "box", material: "glow", position: [1.1, 0.15, -0.3], options: { size: [0.3, 0.3, 0.3] } },
    { op: "create", id: "torus", kind: "revolve", material: "blue", position: [0, 0.08, 1], options: { profile: arc(0.25, 0, 0.08, 0, 345, 23), segments: 32 } },
  ];
  const views = ["perspective", "front", "top"],
    shots = {};
  for (const renderer of ["auto", "software"]) {
    const errors = [],
      context = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: "block" });
    try {
      const page = watch(await context.newPage(), errors);
      await page.goto(`${base}/workshop/?lang=en${renderer === "software" ? "&renderer=software" : ""}`);
      await page.waitForFunction(() => window.funEditor);
      shots[renderer] = await page.evaluate(
        ({ project, commands, views }) => {
          funEditor.loadProject(project, { ifRevision: funEditor.inspect().revision });
          funEditor.apply(commands);
          return {
            backend: funEditor.inspect().renderer.backend,
            images: funEditor.renderViews(views, { size: 256 }).map((s) => s.dataUrl),
          };
        },
        { project, commands, views },
      );
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  assert.equal(shots.software.backend, "software");
  assert.notEqual(shots.auto.backend, "software");
  for (const [i, view] of views.entries()) {
    const [a, b] = [shots.auto, shots.software].map((s) => decodePNG(Buffer.from(s.images[i].split(",")[1], "base64")));
    let sum = 0;
    for (let p = 0; p < a.width * a.height; p++)
      for (let k = 0; k < 3; k++) sum += Math.abs(a.pixels[p * a.channels + k] - b.pixels[p * b.channels + k]);
    const mean = sum / (a.width * a.height * 3);
    assert.ok(mean < 3, `${view}: software differs from ${shots.auto.backend} by ${mean.toFixed(2)}/255 on average`);
  }
}
