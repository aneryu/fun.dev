import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCatalog, playPath, bundlePath, coverURL, compatible, gameText } from "../site/catalog.js";

const game = {
  id: "test-game", version: "1.0.0", apiVersion: 2, title: "Test",
  description: "A test bundle", category: "Puzzle", platforms: ["mobile", "desktop"],
};
test("empty catalog and versioned bundles share a player URL", () => {
  assert.deepEqual(validateCatalog([]), []);
  assert.deepEqual(validateCatalog([game]), [game]);
  assert.equal(playPath(game), "/games/test-game");
  assert.equal(bundlePath(game), "/games/test-game/1.0.0/game.js");
});
test("reject incompatible APIs, unsafe paths, duplicates, and invalid metadata", () => {
  for (const replacement of [
    { id: "../bad" }, { id: "%2fescape" }, { id: "https://elsewhere" },
    { version: "../1.0.0" }, { version: "1.0" }, { apiVersion: 0 }, { apiVersion: "2" },
    { orientation: "sideways" }, { keepAwake: "yes" }, { cover: "../cover.png" }, { cover: "/cover.png" }, { cover: "cover.gif" }, { howToPlay: { zh: "只有中文" } },
    { title: " " }, { platforms: [] }, { platforms: ["mobile", "mobile"] },
    { platforms: ["unknown"] }, { platforms: [null] },
  ]) assert.throws(() => validateCatalog([{ ...game, ...replacement }]));
  for (const invalid of [null, {}, [null], [game, game]]) assert.throws(() => validateCatalog(invalid));
});

test("bilingual metadata requires both languages, while plain titles remain valid", () => {
  const title = { zh: "赛博敲木鱼", en: "Cyber Muyu" };
  assert.equal(validateCatalog([{ ...game, title }])[0].title, title);
  assert.equal(gameText(title, "en"), "Cyber Muyu");
  assert.equal(gameText(title, "zh"), "赛博敲木鱼");
  assert.equal(gameText("Demo", "zh"), "Demo");
  for (const invalid of [{ zh: "只有中文" }, { zh: "中文", en: " " }, []]) {
    assert.throws(() => validateCatalog([{ ...game, title: invalid }]));
  }
});

test("v2 metadata: optional orientation, how-to-play, cover and API compatibility", () => {
  const full = { ...game, orientation: "landscape", keepAwake: true, cover: "assets/cover.jpg", howToPlay: { zh: "点击", en: "Tap" } };
  assert.deepEqual(validateCatalog([full]), [full]);
  assert.equal(coverURL(full, ""), "/games/test-game/1.0.0/assets/cover.jpg");
  assert.equal(coverURL({ ...full, release: "a".repeat(64) }, "https://g.example"), `https://g.example/games/test-game/1.0.0/${"a".repeat(64)}/assets/cover.jpg`);
  assert.equal(coverURL(game), null);
  assert.ok(compatible(game));
  assert.ok(!compatible(validateCatalog([{ ...game, apiVersion: 1 }])[0]));
});
