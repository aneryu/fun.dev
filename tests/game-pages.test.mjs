import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gamePage, gamePages, sitemap } from "../scripts/game-pages.mjs";

const template = readFileSync(new URL("../site/player/index.html", import.meta.url), "utf8");
const game = { id: "my-game", version: "1.0.0", apiVersion: 2, title: { zh: "我的<游戏>", en: "My \"game\"" }, description: "A & B", category: "Puzzle", platforms: ["mobile"] };
test("each game page is the player with the game's escaped meta, canonical URL and Chinese share card", () => {
  const html = gamePage(template, { ...game, cover: "cover.jpg", release: "f".repeat(64) }, { origin: "https://games.example.com" });
  assert.match(html, /<title>我的&#60;游戏&#62; — fun.dev<\/title>/);
  assert.match(html, /<h1 id="game-title">我的&#60;游戏&#62;<\/h1>/);
  assert.match(html, /<meta name="description" content="A &#38; B">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/fun.dev\/games\/my-game">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/fun.dev\/games\/my-game">/);
  assert.match(html, new RegExp(`og:image" content="https://games.example.com/games/my-game/1.0.0/${"f".repeat(64)}/cover.jpg"`));
  assert.match(html, /<script type="module" src="\/player\/player.js"><\/script>/);
  assert.doesNotMatch(html, /game-meta|noindex/);
  assert.match(gamePage(template, game), /twitter:card" content="summary"/);
  assert.doesNotMatch(gamePage(template, game), /og:image/);
});
test("pages and sitemap cover the model library and compatible games only, at addresses without a trailing slash", () => {
  const games = [game, { ...game, id: "old", apiVersion: 1 }];
  assert.deepEqual(gamePages(games, template).map((page) => page.path), ["games/my-game.html"]);
  const xml = sitemap(games);
  assert.deepEqual([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]), ["https://fun.dev/", "https://fun.dev/games", "https://fun.dev/models", "https://fun.dev/games/my-game"]);
});
