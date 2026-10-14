import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCatalog, playPath, bundlePath, gameText } from "../site/catalog.js";

const game = {
  id: "test-game", version: "1.0.0", apiVersion: 1, title: "Test",
  description: "A test bundle", category: "Puzzle", platforms: ["mobile", "desktop"],
};
test("empty catalog and versioned bundles share a player URL", () => {
  assert.deepEqual(validateCatalog([]), []);
  assert.deepEqual(validateCatalog([game]), [game]);
  assert.equal(playPath(game), "/play/?game=test-game");
  assert.equal(bundlePath(game), "/games/test-game/1.0.0/game.js");
});
test("reject incompatible APIs, unsafe paths, duplicates, and invalid metadata", () => {
  for (const replacement of [
    { id: "../bad" }, { id: "%2fescape" }, { id: "https://elsewhere" },
    { version: "../1.0.0" }, { version: "1.0" }, { apiVersion: 2 },
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
