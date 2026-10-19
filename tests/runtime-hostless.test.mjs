import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { register } from "node:module";

// The runtime kit and core are the JavaScript layer shared by every game host: the web
// player and fun, the native runtime (docs/hosts.md). A host provides the DOM-like things a
// module needs as arguments; no module may touch the DOM when imported. This imports every
// module in Node with no document, window or navigator, so a DOM dependency fails here first.
register("../scripts/workshop-resolve.mjs", import.meta.url);

const root = new URL("../site/runtime/", import.meta.url);
for (const dir of ["core", "kit", "fun"]) {
  for (const name of (await readdir(new URL(dir + "/", root))).filter((n) => n.endsWith(".js")).sort()) {
    test(`runtime/${dir}/${name} imports without a DOM`, async () => {
      assert.equal(typeof globalThis.document, "undefined");
      assert.equal(typeof globalThis.window, "undefined");
      const module = await import(new URL(`${dir}/${name}`, root));
      assert.ok(Object.keys(module).length > 0, "exports something");
    });
  }
}
