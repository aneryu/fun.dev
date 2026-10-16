import { compatible, coverURL, gameText, playPath } from "../site/catalog.js";

// One page per game at /games/<id>: the player page (site/player/index.html) with the game's
// title, description, canonical URL and Open Graph tags, so a game's address is also its share
// link and each game has its own path in page analytics. Share cards use Chinese, the main
// audience; the page itself still follows the visitor's language.
const escape = (text) => String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function gamePage(template, game, { site = "https://fun.dev", origin = "" } = {}) {
  const title = gameText(game.title, "zh");
  const description = gameText(game.description, "zh");
  const url = `${site}${playPath(game)}`;
  const cover = coverURL(game, origin || site);
  const tags = [
    ["og:type", "website"], ["og:site_name", "fun.dev"], ["og:title", title], ["og:description", description],
    ["og:url", url], ["og:locale", "zh_CN"],
    ...(cover ? [["og:image", cover], ["og:image:width", "1200"], ["og:image:height", "630"]] : []),
  ];
  const meta = [
    `<meta name="description" content="${escape(description)}">`,
    `<link rel="canonical" href="${escape(url)}">`,
    ...tags.map(([property, content]) => `<meta property="${property}" content="${escape(content)}">`),
    `<meta name="twitter:card" content="${cover ? "summary_large_image" : "summary"}">`,
  ].map((line) => `    ${line}`).join("\n");
  if (!template.includes("<!-- game-meta -->")) throw new Error("The player page needs a <!-- game-meta --> marker.");
  return template
    .replace(/^ *<!-- game-meta -->$/m, meta)
    .replace(/<title>[^<]*<\/title>/, `<title>${escape(title)} — fun.dev</title>`)
    .replace(/<h1 id="game-title">[^<]*<\/h1>/, `<h1 id="game-title">${escape(title)}</h1>`);
}

export function gamePages(games, template, options) {
  return games.filter(compatible).map((game) => ({ path: `games/${game.id}.html`, html: gamePage(template, game, options) }));
}

// Home, lobby and every playable game, at their canonical addresses (no trailing slash).
export function sitemap(games, site = "https://fun.dev") {
  const paths = ["/", "/games", "/models", ...games.filter(compatible).map(playPath)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((path) => `  <url>\n    <loc>${escape(`${site}${path}`)}</loc>\n  </url>`).join("\n")}
</urlset>
`;
}
