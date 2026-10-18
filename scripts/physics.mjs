import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// Builds the platform's physics runtime into dist/runtime/physics/<hash>/: Jolt Physics
// (single-threaded WebAssembly, MIT) at the pinned version. Like the vision runtime, its
// address is its content hash, so browsers and the service worker cache it forever and the
// shell precache leaves it out; kit/physics.js loads it on first use.
export async function buildPhysics(root, output) {
  const library = new URL("node_modules/jolt-physics/", root);
  const files = [
    ["jolt-physics.wasm.js", await readFile(new URL("dist/jolt-physics.wasm.js", library))],
    ["jolt-physics.wasm.wasm", await readFile(new URL("dist/jolt-physics.wasm.wasm", library))],
    ["LICENSE.txt", await readFile(new URL("LICENSE", library))],
  ];
  const hash = createHash("sha256");
  for (const [name, body] of files) hash.update(name).update("\0").update(body).update("\0");
  const version = hash.digest("hex").slice(0, 16);
  const directory = new URL(`runtime/physics/${version}/`, output);
  await mkdir(directory, { recursive: true });
  for (const [name, body] of files) await writeFile(new URL(name, directory), body);
  const kit = new URL("runtime/kit/physics.js", output);
  const source = await readFile(kit, "utf8");
  if (!/^const VERSION = "source";$/m.test(source)) throw new Error("kit/physics.js lost its VERSION line.");
  await writeFile(kit, source.replace(/^const VERSION = "source";$/m, `const VERSION = ${JSON.stringify(version)};`));
  return version;
}
