import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleWorkshop } from "../scripts/workshop-bundle.mjs";

// The one-file workshop the site and the npm package ship (scripts/workshop-bundle.mjs) runs a
// model script outside the repository: every page path it imports resolves inside the bundle.
test("the bundled workshop runs a script on its own", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "fundev-bundle-"));
  try {
    await writeFile(join(dir, "workshop.mjs"), await bundleWorkshop(new URL("../", import.meta.url)));
    await writeFile(join(dir, "model.mjs"), `export default async function (ws) {
      await ws.load({ name: "post", materials: [{ id: "wood", color: "#c9a27a" }] });
      await ws.apply([{ op: "create", id: "post", kind: "box", material: "wood", position: [0, 0.5, 0], options: { size: [0.1, 1, 0.1] } }]);
      await ws.exportGLB({ file: "post.glb" });
    }`);
    await symlink("workshop.mjs", join(dir, "workshop-link.mjs"));
    await writeFile(join(dir, "launcher.mjs"), `import { main } from "./workshop.mjs"; await main();`);
    for (const [entry, flags = []] of [["workshop.mjs"], ["workshop-link.mjs"], ["launcher.mjs"], ["workshop-link.mjs", ["--preserve-symlinks-main"]]]) {
      const out = execFileSync(process.execPath, [...flags, join(dir, entry), "--run", "model.mjs"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const lines = out.trim().split("\n");
      assert.equal(lines.length, 1, `${entry} must run exactly once: ${out}`);
      const result = JSON.parse(lines[0]);
      assert.equal(result.ok, true, out);
      assert.ok(result.files.some((file) => file.endsWith("post.glb")));
    }
    const imported = execFileSync(process.execPath, ["--input-type=module", "-", "--run", "model.mjs"], {
      cwd: dir,
      encoding: "utf8",
      input: `import { main } from "./workshop.mjs"; if (typeof main !== "function") throw new Error("missing main"); console.log("imported");`,
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.equal(imported, "imported\n", "stdin import must not start main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
