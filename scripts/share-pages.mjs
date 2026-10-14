import { compatible, coverURL, gameText } from "../site/catalog.js";

// Static Open Graph pages for share links: /s/<id>/ (Chinese) and /s/<id>/en/.
// Crawlers read the tags; people continue to the player through a meta refresh.
const escape = (text) => String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function sharePage(game, locale, { site = "https://fun.dev", origin = "" } = {}) {
  const title = gameText(game.title, locale);
  const description = gameText(game.description, locale);
  const path = `/s/${game.id}/${locale === "en" ? "en/" : ""}`;
  const player = `/play/?game=${encodeURIComponent(game.id)}&lang=${locale}`;
  const cover = coverURL(game, origin || site);
  const tags = [
    ["og:type", "website"], ["og:site_name", "fun.dev"], ["og:title", title], ["og:description", description],
    ["og:url", `${site}${path}`], ["og:locale", locale === "en" ? "en_US" : "zh_CN"],
    ...(cover ? [["og:image", cover], ["og:image:width", "1200"], ["og:image:height", "630"]] : []),
  ];
  return `<!doctype html>
<html lang="${locale === "en" ? "en" : "zh-CN"}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <meta name="description" content="${escape(description)}">
${tags.map(([property, content]) => `    <meta property="${property}" content="${escape(content)}">`).join("\n")}
    <meta name="twitter:card" content="${cover ? "summary_large_image" : "summary"}">
    <meta http-equiv="refresh" content="0; url=${escape(player)}">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="/platform.css">
    <title>${escape(title)} — fun.dev</title>
  </head>
  <body class="lobby-page">
    <main class="page-width message-state"><p><a href="${escape(player)}">${escape(title)}</a></p></main>
  </body>
</html>
`;
}

export function sharePages(games, options) {
  return games.filter(compatible).flatMap((game) => ["zh", "en"].map((locale) => ({
    path: `s/${game.id}/${locale === "en" ? "en/" : ""}index.html`, html: sharePage(game, locale, options),
  })));
}
