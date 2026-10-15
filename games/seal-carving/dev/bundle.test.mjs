import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("runtime resource graph stays inside the relocatable bundle and matches game.json", async () => {
  const seen = new Set();
  async function visit(url) {
    assert.ok(url.href.startsWith(root.href), `External dependency: ${url}`);
    const path = url.href.slice(root.href.length);
    assert.ok(!/^(?:dev\/|package\.json|README\.md)/.test(path), `Development dependency: ${path}`);
    assert.ok((await stat(url)).isFile(), `Missing runtime resource: ${path}`);
    if (seen.has(url.href)) return;
    seen.add(url.href);
    if (!/\.js$/.test(url.pathname)) return;
    const source = await readFile(url, "utf8");
    for (const match of source.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g)) {
      assert.ok(match[1].startsWith("."), `Import must be bundle-relative: ${match[1]}`);
      await visit(new URL(match[1], url));
    }
  }
  await visit(new URL("game.js", root));
  const manifest = JSON.parse(await readFile(new URL("game.json", root), "utf8"));
  for (const url of seen) assert.ok(manifest.files.includes(url.slice(root.href.length)), `game.json misses ${url}`);
  for (const file of manifest.files) assert.ok((await stat(new URL(file, root))).isFile(), `game.json lists a missing ${file}`);
});

test("game owns its Three.js HUD without DOM, CSS or platform widgets", async () => {
  for (const file of ["game.js", "hud.js", "stone.js", "knife.js", "effects.js", "carve.js"]) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.doesNotMatch(source, /\b(?:document|window)\b|\.innerHTML|\.style\b/, file);
  }
});
