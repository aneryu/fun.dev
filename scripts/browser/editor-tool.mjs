import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { decodePNG } from "../png.mjs";
import { parseModelFile, workshopProject } from "../../site/workshop/glb.js";

// The published agent tool (tools/fundev-workshop.mjs), without the repository: the launcher
// fetches the workshop from `base`, which runs in Node by default and drives a page with --url.
export async function editorToolChecks({ base, output }) {
  const tool = resolve(output, "tools/fundev-workshop.mjs"),
    cache = await mkdtemp(resolve(tmpdir(), "workshop-cache-")),
    env = { ...process.env, FUNDEV_WORKSHOP_ORIGIN: `${base}/tools/`, FUNDEV_WORKSHOP_CACHE: cache };
  for (const mode of ["node", "browser"]) {
    const child = spawn(process.execPath, [tool, ...(mode === "browser" ? ["--url", `${base}/workshop/?lang=en`] : [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const lines = createInterface({ input: child.stdout }),
      pending = [];
    lines.on("line", (line) => pending.shift()?.(JSON.parse(line)));
    const call = (method, args = {}) =>
      new Promise((done) => {
        pending.push(done);
        child.stdin.write(JSON.stringify({ method, arguments: args }) + "\n");
      });
    try {
      const capabilities = await call("capabilities");
      assert.ok(capabilities.ok, `${mode}: ${JSON.stringify(capabilities).slice(0, 600)} ${stderr}`);
      assert.ok(capabilities.result.commands.includes("boolean"));
      const inspected = (await call("inspect")).result;
      assert.equal(inspected.renderer.backend, mode === "node" ? "software" : inspected.renderer.backend, mode);
      const applied = await call("apply", {
        ifRevision: inspected.revision,
        commands: [
          { op: "create", id: "plate", kind: "box", options: { size: [1, 0.1, 1] } },
          { op: "create", id: "drill", kind: "cylinder", options: { radius: 0.2, height: 1 } },
          { op: "boolean", id: "plate", operation: "difference", with: ["drill"] },
        ],
      });
      assert.ok(applied.ok, JSON.stringify(applied.error));
      const exported = await call("exportGLB", { ids: ["plate"] });
      assert.ok(exported.ok && exported.result.report.triangles > 12, mode);
      const observed = await call("observe", { names: ["front"], size: 128 });
      assert.ok(observed.ok && observed.result.observations[0].dataUrl.startsWith("data:image/png;base64,"), mode);
    } finally {
      child.stdin.end();
      await new Promise((done) => child.once("exit", done));
    }
    assert.match(stderr, mode === "node" ? /Node workshop/ : /connected/, stderr);
  }
  // The launcher fetched one checked workshop file into the cache.
  assert.deepEqual((await readdir(cache)).filter((name) => /^workshop-[0-9a-f]{16}\.mjs$/.test(name)).length, 1);
  // --guide works offline; --run builds a model from a script in one call, in Node and in a
  // page drawing in software: the same modules give the same files.
  const { stdout: guide } = await promisify(execFile)(process.execPath, [tool, "--guide"], { encoding: "utf8", env });
  assert.match(guide, /Workshop for agents/);
  const script = `export default async function (ws) {
  await ws.load({ name: "post_01", materials: [{ id: "mat_wood", color: "#c89969" }] });
  await ws.apply([
    { op: "create", id: "post_01", kind: "group" },
    { op: "create", id: "post", kind: "box", parent: "post_01", material: "mat_wood", position: [0, 0.5, 0], options: { size: [0.1, 1, 0.1] } },
    { op: "create", id: "cap_hinge", kind: "group", parent: "post_01", position: [0, 1, 0] },
    { op: "create", id: "cap", kind: "cone", parent: "cap_hinge", material: "mat_wood", position: [0, 0.05, 0], options: { radius: 0.08, height: 0.1, segments: "auto" }, smooth: true },
  ]);
  await ws.observe(["perspective"], { file: "preview.png", size: 256 });
  await ws.exportGLB({ file: "model.glb", origin: "ground-center", rootName: "post_01_ROOT", mergeStatic: "auto" });
  await ws.exportProject({ file: "source.funmodel.glb" });
}
`;
  const outputs = {};
  for (const mode of ["node", "browser"]) {
    const dir = await mkdtemp(resolve(tmpdir(), `workshop-run-${mode}-`));
    await writeFile(resolve(dir, "model.mjs"), script);
    // Asynchronous: the preview server answering the tool runs in this process.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [tool, ...(mode === "browser" ? ["--url", `${base}/workshop/?lang=en&renderer=software`] : []), "--run", resolve(dir, "model.mjs")],
      { encoding: "utf8", env },
    );
    const run = JSON.parse(stdout);
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.deepEqual(run.validation.errors, []);
    assert.deepEqual(run.files.map((f) => f.split("/").at(-1)), ["preview.png", "model.glb", "source.funmodel.glb"]);
    const glb = await readFile(resolve(dir, "model.glb")),
      json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8"));
    assert.deepEqual(json.nodes.map((n) => n.name).sort(), ["cap", "cap_hinge", "post_01_ROOT", "static__mat_wood"]);
    outputs[mode] = Object.fromEntries(
      await Promise.all(["preview.png", "model.glb", "source.funmodel.glb"].map(async (file) => [file, await readFile(resolve(dir, file))])),
    );
  }
  // The model is byte for byte the same; the project and the picture are compared by content
  // (a browser encodes PNG its own way).
  assert.ok(outputs.node["model.glb"].equals(outputs.browser["model.glb"]), "model.glb: Node and the page differ");
  // Projects keep full doubles: the two JavaScript engines' sine and cosine may differ in the
  // last bit, which float32 GLBs round away.
  const project = (bytes) => workshopProject(parseModelFile(new Uint8Array(bytes)).json);
  const close = (x, y, path) => {
    if (typeof x === "number" && typeof y === "number")
      return assert.ok(Math.abs(x - y) <= 1e-12 * Math.max(1, Math.abs(x)), `${path}: ${x} vs ${y}`);
    if (x && y && typeof x === "object" && typeof y === "object") {
      assert.deepEqual(Object.keys(x), Object.keys(y), path);
      for (const key of Object.keys(x)) close(x[key], y[key], `${path}.${key}`);
      return;
    }
    assert.equal(x, y, path);
  };
  close(project(outputs.node["source.funmodel.glb"]), project(outputs.browser["source.funmodel.glb"]), "project");
  const [a, b] = ["node", "browser"].map((mode) => decodePNG(outputs[mode]["preview.png"]));
  assert.ok(a.width === b.width && a.height === b.height, "preview size");
  let differing = 0;
  for (let i = 0; i < a.width * a.height; i++)
    for (let k = 0; k < 3; k++) if (a.pixels[i * a.channels + k] !== b.pixels[i * b.channels + k]) differing++;
  assert.equal(differing, 0, "Node and the page's software renderer draw the same preview");
}
