import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

// The published single-file agent tool drives a workshop by URL, without the repository.
export async function editorToolChecks({ base, output }) {
  const child = spawn(
    process.execPath,
    [resolve(output, "tools/fundev-workshop.mjs"), "--url", `${base}/editor/?lang=en`],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
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
    assert.ok(capabilities.ok, stderr);
    assert.ok(capabilities.result.commands.includes("boolean"));
    const { revision } = (await call("inspect")).result;
    const applied = await call("apply", {
      ifRevision: revision,
      commands: [
        { op: "create", id: "plate", kind: "box", options: { size: [1, 0.1, 1] } },
        { op: "create", id: "drill", kind: "cylinder", options: { radius: 0.2, height: 1 } },
        { op: "boolean", id: "plate", operation: "difference", with: ["drill"] },
      ],
    });
    assert.ok(applied.ok, JSON.stringify(applied.error));
    const exported = await call("exportGLB", { ids: ["plate"] });
    assert.ok(exported.ok && exported.result.report.triangles > 12);
  } finally {
    child.stdin.end();
    await new Promise((done) => child.once("exit", done));
  }
  // --guide works offline; --run builds a model from a script in one call.
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const tool = resolve(output, "tools/fundev-workshop.mjs");
  assert.match(execFileSync(process.execPath, [tool, "--guide"], { encoding: "utf8" }), /Workshop for agents/);
  const dir = await mkdtemp(resolve(tmpdir(), "workshop-run-"));
  await writeFile(resolve(dir, "model.mjs"), `export default async function (ws) {
  await ws.load({ name: "post_01", materials: [{ id: "mat_wood", color: "#c89969" }] });
  await ws.apply([
    { op: "create", id: "post_01", kind: "group" },
    { op: "create", id: "post", kind: "box", parent: "post_01", material: "mat_wood", position: [0, 0.5, 0], options: { size: [0.1, 1, 0.1] } },
    { op: "create", id: "cap_hinge", kind: "group", parent: "post_01", position: [0, 1, 0] },
    { op: "create", id: "cap", kind: "cone", parent: "cap_hinge", material: "mat_wood", position: [0, 0.05, 0], options: { radius: 0.08, height: 0.1 } },
  ]);
  await ws.observe(["perspective"], { file: "preview.png", size: 256 });
  await ws.exportGLB({ file: "model.glb", origin: "ground-center", rootName: "post_01_ROOT", mergeStatic: "auto" });
}
`);
  // Asynchronous: the preview server answering the tool runs in this process.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(process.execPath, [tool, "--url", `${base}/editor/?lang=en`, "--run", resolve(dir, "model.mjs")], { encoding: "utf8" });
  const run = JSON.parse(stdout);
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.deepEqual(run.validation.errors, []);
  assert.deepEqual(run.files.map((f) => f.split("/").at(-1)), ["preview.png", "model.glb"]);
  const glb = await readFile(resolve(dir, "model.glb")),
    json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8"));
  assert.deepEqual(json.nodes.map((n) => n.name).sort(), ["cap", "cap_hinge", "post_01_ROOT", "static__mat_wood"]);
}
