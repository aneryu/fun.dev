import { compatible, coverURL, gameText, loadCatalog, playPath } from "./catalog.js";
import { getLocale, initLocale, languagePath, onLocaleChange, t } from "./i18n.js";
import { registerServiceWorker } from "./pwa.js";

const list = document.querySelector("#game-list");
const tools = document.querySelector("#catalog-tools");
const search = document.querySelector("#search");
const category = document.querySelector("#category");
const random = document.querySelector("#random-game");
const status = document.querySelector("#result-status");
const count = document.querySelector("#catalog-count");
const empty = document.querySelector("#empty-state");
const noResults = document.querySelector("#no-results");
const error = document.querySelector("#load-error");
let games = [];
let visibleGames = [];
let loadState = "loading";
const categoryKey = (game) => gameText(game.category, "en");

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function gameItem(game) {
  const item = element("li", "game-item", "");
  const link = element("a", "game-link", "");
  link.href = languagePath(playPath(game));
  // A cover thumbnail replaces the row number when the game has one; both are decorative.
  let number;
  if (game.cover) {
    number = Object.assign(document.createElement("img"), { className: "game-cover", src: coverURL(game), alt: "", loading: "lazy", decoding: "async", width: 112, height: 112 });
  } else {
    number = element("span", "game-number", String(games.indexOf(game) + 1).padStart(2, "0"));
    number.setAttribute("aria-hidden", "true");
  }
  const info = element("div", "game-info", "");
  const platforms = game.platforms.map((platform) => t(platform)).join(" / ");
  info.append(
    element("p", "game-meta", `${gameText(game.category, getLocale())} · ${platforms}`),
    element("h3", "", gameText(game.title, getLocale())),
    element("p", "muted", gameText(game.description, getLocale())),
  );
  const play = element("span", "play-label", t("play"));
  const arrow = element("span", "", "↗");
  arrow.setAttribute("aria-hidden", "true");
  play.append(arrow);
  link.append(number, info, play);
  item.append(link);
  return item;
}

function render() {
  count.textContent = games.length > 1 ? t("count", games.length) : "";
  if (loadState !== "ready") {
    status.textContent = t(loadState === "loading" ? "loading" : "loadError");
    return;
  }
  const query = search.value.trim().toLocaleLowerCase();
  visibleGames = games.filter((game) =>
    (!category.value || categoryKey(game) === category.value) &&
    ["zh", "en"].some((locale) => [game.title, game.description, game.category]
      .map((text) => gameText(text, locale)).join(" ").toLocaleLowerCase().includes(query)));
  list.replaceChildren(...visibleGames.map(gameItem));
  list.hidden = visibleGames.length === 0;
  empty.hidden = games.length !== 0;
  noResults.hidden = games.length === 0 || visibleGames.length !== 0;
  random.disabled = visibleGames.length === 0;
  random.hidden = games.length < 2;
  status.textContent = search.value || category.value ? t("matches", visibleGames.length) : "";
}

function translateCatalog() {
  const selected = category.value;
  category.replaceChildren(new Option(t("allCategories"), ""));
  const categories = new Map(games.map((game) => [categoryKey(game), gameText(game.category, getLocale())]));
  for (const [key, label] of categories) category.add(new Option(label, key));
  category.value = selected;
  render();
}

async function load() {
  error.hidden = true;
  empty.hidden = true;
  tools.hidden = true;
  noResults.hidden = true;
  list.hidden = true;
  loadState = "loading";
  render();
  try {
    // Entries for another container API cannot run here; the player explains direct links.
    games = (await loadCatalog(AbortSignal.timeout(10000))).filter(compatible);
    search.value = "";
    category.value = "";
    loadState = "ready";
    tools.hidden = games.length < 2;
    translateCatalog();
  } catch {
    loadState = "error";
    render();
    error.hidden = false;
  }
}

search.addEventListener("input", render);
category.addEventListener("change", render);
document.querySelector("#clear-filters").addEventListener("click", () => {
  search.value = "";
  category.value = "";
  render();
  search.focus();
});
random.addEventListener("click", () => {
  if (visibleGames.length) window.location.assign(languagePath(playPath(visibleGames[Math.floor(Math.random() * visibleGames.length)])));
});
document.querySelector("#retry").addEventListener("click", async () => {
  await load();
  if (!error.hidden) document.querySelector("#retry").focus();
  else if (!tools.hidden) search.focus();
  else document.querySelector("#games-title").focus();
});
initLocale();
onLocaleChange(translateCatalog);
load();
registerServiceWorker();
