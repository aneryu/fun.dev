import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { results } from "./harness.mjs";

// The .fun3d runtime under the player CSP: the page module scripts/browser/fun3d-page.js writes
// synthetic models, loads them alone and in batches, renders both and compares, drives a Jolt
// vehicle, plays a clip, and converts real library GLBs when FUNDEV_FUN3D_SAMPLES names a
// directory of <id>.glb files (typed by name: *car*/*taxi* vehicle, *worker*/*player* character).
const here = fileURLToPath(new URL("./", import.meta.url));

async function sampleFiles() {
  const directory = process.env.FUNDEV_FUN3D_SAMPLES;
  if (!directory) return [];
  const names = (await readdir(directory).catch(() => [])).filter((f) => f.endsWith(".glb")).sort();
  return names.map((file) => { const name = file.replace(/\.glb$/, ""); return { name, file: resolve(directory, file), type: /car|taxi|truck|bus/.test(name) ? "vehicle" : /worker|player|character|person/.test(name) ? "character" : "prop" }; });
}

export async function fun3dChecks({ browser, base }) {
  const samples = await sampleFiles();
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 800, height: 600 } });
  await context.route("**/fun3d-check/page.js", async (route) => route.fulfill({ body: await readFile(resolve(here, "fun3d-page.js")), headers: { "content-type": "text/javascript" } }));
  await context.route("**/fun3d-check/samples/*.glb", async (route) => {
    const name = decodeURIComponent(route.request().url().split("/").at(-1)).replace(/\.glb$/, ""), sample = samples.find((s) => s.name === name);
    if (!sample) return route.fulfill({ status: 404 });
    return route.fulfill({ body: await readFile(sample.file), headers: { "content-type": "model/gltf-binary" } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`${base}/games/probe`);
  const report = await page.evaluate(async (list) => {
    const { run } = await import("/fun3d-check/page.js");
    return run({ samples: list });
  }, samples.map(({ name, type }) => ({ name, type })));
  await context.close();
  await mkdir(results, { recursive: true });
  for (const [name, data] of Object.entries(report.images ?? {})) await writeFile(resolve(results, `fun3d-${name}.png`), Buffer.from(data, "base64"));

  assert.deepEqual(errors, [], "no page errors");
  assert.deepEqual(report.warnings, [], "no runtime warnings for release 1 data");
  // A batched street and the same street drawn alone look the same, in far fewer draws.
  assert.ok(report.parity.mean < 1.5 && report.parity.big < 0.01, `batched vs single: ${JSON.stringify(report.parity)}\n  each: ${JSON.stringify(report.each)}`);
  assert.ok(report.parity.batchedCalls < report.parity.singleCalls / 2, `draw calls ${report.parity.batchedCalls} batched vs ${report.parity.singleCalls} single`);
  assert.ok(report.roles.changed > 0.05 && report.roles.parity < 1.5, `roles: ${JSON.stringify(report.roles)}`);
  assert.ok(report.tint > 0.02, `tint changes the picture: ${report.tint}`);
  // Jolt: the car drove, its wheels turned, the crate fell and settled.
  const p = report.physics;
  assert.ok(p.drove > 2 && p.speed > 1 && p.wheelTurned > 0.01, `vehicle: ${JSON.stringify(p)}`);
  assert.ok(Math.abs(p.crateY - 0.4) < 0.06, `crate rests on the ground (its box shape is centred on the node): y ${p.crateY}`);
  assert.ok(p.moved > 0.05, "the picture changed after driving");
  assert.ok(Math.abs(report.animation.spineZ - 0.3826834) < 1e-3 && Math.abs(report.animation.original) < 1e-6, `clip on the copy only: ${JSON.stringify(report.animation)}`);
  for (const sample of report.samples) {
    assert.equal(sample.error, undefined, `${sample.name}: ${sample.error}`);
    assert.deepEqual(sample.problems, [], `${sample.name} validates`);
    assert.ok(sample.fun3d < sample.glb, `${sample.name}: ${sample.fun3d} bytes from ${sample.glb}`);
    if (sample.report.kind === "model") assert.ok(sample.triangles > 0, `${sample.name} draws`);
  }
  console.log(`  ${report.backend}: parity mean ${report.parity.mean.toFixed(2)}, ${report.parity.batchedCalls} draws batched vs ${report.parity.singleCalls}; car drove ${p.drove.toFixed(1)} m${report.samples.length ? `; samples: ${report.samples.map((s) => `${s.name} ${(s.fun3d / 1024).toFixed(0)} KB/${(s.glb / 1024).toFixed(0)} KB in ${s.convertMs} ms`).join(", ")}` : ""}`);
}
