import { test } from "node:test";
import assert from "node:assert/strict";
import { sharePage, sharePages } from "../scripts/share-pages.mjs";

const game = { id: "my-game", version: "1.0.0", apiVersion: 2, title: { zh: "我的<游戏>", en: "My \"game\"" }, description: "A & B", category: "Puzzle", platforms: ["mobile"] };
test("share pages carry escaped per-language Open Graph tags and continue to the player", () => {
  const zh = sharePage({ ...game, cover: "cover.jpg", release: "f".repeat(64) }, "zh", { origin: "https://games.example.com" });
  assert.match(zh, /<meta property="og:title" content="我的&#60;游戏&#62;">/);
  assert.match(zh, /<meta property="og:description" content="A &#38; B">/);
  assert.match(zh, new RegExp(`og:image" content="https://games.example.com/games/my-game/1.0.0/${"f".repeat(64)}/cover.jpg"`));
  assert.match(zh, /og:url" content="https:\/\/fun.dev\/s\/my-game\/"/);
  assert.match(zh, /http-equiv="refresh" content="0; url=\/play\/\?game=my-game&#38;lang=zh"/);
  const en = sharePage(game, "en");
  assert.match(en, /og:title" content="My &#34;game&#34;"/);
  assert.match(en, /twitter:card" content="summary"/);
  assert.doesNotMatch(en, /og:image/);
});
test("one page per language for compatible games only", () => {
  assert.deepEqual(sharePages([game, { ...game, id: "old", apiVersion: 1 }]).map((page) => page.path), ["s/my-game/index.html", "s/my-game/en/index.html"]);
});
