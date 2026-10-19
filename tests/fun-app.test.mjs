import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFunApp } from "../scripts/fun-app.mjs";

// The publisher's fun output (docs/hosts.md): the fixture game becomes app.mjs plus fun's
// asset manifest, with the game's files under their bundle paths and fun's modules external.
test("a game bundle builds into a fun application", async () => {
  const out = await mkdtemp(join(tmpdir(), "fun-app-"));
  try {
    const result = await buildFunApp(new URL("fixture-games/probe/game.json", import.meta.url).pathname, { out, captureAt: 5 });
    assert.equal(result.game.id, "probe");
    const manifest = JSON.parse(await readFile(join(out, "assets.json"), "utf8"));
    const cover = manifest.assets.find((a) => a.name === "assets/cover.png");
    assert.ok(cover, "cover.png is a fun asset under its bundle path");
    assert.equal(cover.source, join(out, "files/assets/cover.png"));
    assert.match(cover.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!manifest.assets.some((a) => a.name.endsWith(".js")), "code is bundled, not an asset");
    const app = await readFile(join(out, "app.mjs"), "utf8");
    for (const m of ["fun:window", "fun:app", "fun:assets", "fun:canvas", "fun:gpu", "fun:debug"]) assert.match(app, new RegExp(`from\\s*"${m}"`), `${m} stays external`);
    assert.doesNotMatch(app, /from\s*"three\/webgpu"/, "three is bundled");
    assert.match(app, /createFunHost/);
    assert.match(app, /frame-5\.png/, "the capture self-check is baked in");
    assert.match(app, /loadJolt/, "kit/physics.js gets the host's Jolt loader");
    assert.ok(result.appBytes > 1_000_000 && result.appBytes < 20_000_000, `app.mjs size ${result.appBytes}`);
  } finally { await rm(out, { recursive: true, force: true }); }
});
