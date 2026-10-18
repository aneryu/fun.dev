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
}
