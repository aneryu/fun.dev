import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("runtime resource graph stays inside the relocatable bundle", async () => {
  const seen = new Set();
  async function visit(url) {
    assert.ok(url.href.startsWith(root.href), `External dependency: ${url}`);
    const path = url.href.slice(root.href.length);
    assert.ok(!/^(?:dev\/|package\.json|README\.md)/.test(path), `Development dependency: ${path}`);
    assert.ok((await stat(url)).isFile(), `Missing runtime resource: ${path}`);
    if (seen.has(url.href)) return;
    seen.add(url.href);
    if (!/\.(?:js|css)$/.test(url.pathname)) return;
    const source = await readFile(url, "utf8");
    for (const match of source.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g)) {
      assert.ok(match[1].startsWith("."), `Import must be bundle-relative: ${match[1]}`);
      await visit(new URL(match[1], url));
    }
    for (const match of source.matchAll(/\basset\(["']([^"']+)["']\)/g)) await visit(new URL(match[1], root));
    for (const match of source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) await visit(new URL(match[1], url));
  }
  await visit(new URL("game.js", root));
  assert.ok(seen.has(new URL("assets/wooden-fish.json", root).href));
});

test("game owns its Three.js HUD without platform widgets, DOM or CSS", async () => {
  const game = await readFile(new URL("game.js", root), "utf8") + await readFile(new URL("hud.js", root), "utf8");
  assert.doesNotMatch(game, /\b(?:document|window)\b|\.innerHTML|\.style\b|\.css["']/);
  assert.doesNotMatch(game, /context\.hud|hud\.(?:counter|button|target)\(/);
  await assert.rejects(stat(new URL("game.css", root)), { code: "ENOENT" });
});
