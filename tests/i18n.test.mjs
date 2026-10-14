import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseLocale, languagePath, messages } from "../site/i18n.js";

test("explicit language overrides a saved choice and browser preferences", () => {
  assert.equal(chooseLocale("en", "zh", ["zh-CN"]), "en");
  assert.equal(chooseLocale(null, "zh", ["en-US"]), "zh");
  assert.equal(chooseLocale("invalid", null, ["fr-FR", "zh-TW", "en"]), "zh");
  assert.equal(chooseLocale(null, null, ["en-GB", "zh"]), "en");
  assert.equal(chooseLocale(null, null, ["fr"]), "en");
});
test("language links preserve the game ID and anchors", () => {
  assert.equal(languagePath("/play/?game=cyber-muyu&lang=zh#scene", "auto"), "/play/?game=cyber-muyu#scene");
  assert.equal(languagePath("/play/?game=cyber-muyu", "en"), "/play/?game=cyber-muyu&lang=en");
  assert.equal(languagePath("/?lang=en#games", "zh"), "/?lang=zh#games");
});
test("both interface languages have complete messages and correct counts", () => {
  assert.deepEqual(Object.keys(messages.zh).sort(), Object.keys(messages.en).sort());
  assert.equal(messages.en.count(1), "1 game");
  assert.equal(messages.en.count(2), "2 games");
  assert.equal(messages.zh.count(1), "1 款游戏");
});
