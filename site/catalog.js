import { gameOrigin } from "./game-source.js";
export const API_VERSION = 1;
export const platforms = ["mobile", "desktop"];

export function gameText(value, locale) {
  return typeof value === "string" ? value : value[locale];
}

export function validateCatalog(data) {
  if (!Array.isArray(data)) throw new Error("games.json must contain an array.");
  const ids = new Set();
  for (const [index, game] of data.entries()) {
    const fail = (message) => { throw new Error(`Game ${index + 1}: ${message}`); };
    if (!game || typeof game !== "object" || Array.isArray(game)) fail("expected an object.");
    if (typeof game.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(game.id)) {
      fail("id must use lowercase letters, numbers, and single hyphens.");
    }
    if (ids.has(game.id)) fail(`duplicate id: ${game.id}`);
    ids.add(game.id);
    if (game.apiVersion !== API_VERSION) fail(`apiVersion must be ${API_VERSION}.`);
    if (typeof game.version !== "string" || !/^\d+\.\d+\.\d+$/.test(game.version)) {
      fail("version must use the format 1.0.0.");
    }
    if (game.release !== undefined && (typeof game.release !== "string" || !/^[a-f0-9]{64}$/.test(game.release))) fail("release must be a SHA-256 digest.");
    for (const key of ["title", "description", "category"]) {
      const value = game[key];
      const valid = typeof value === "string" ? value.trim() : value &&
        typeof value === "object" && !Array.isArray(value) &&
        ["zh", "en"].every((locale) => typeof value[locale] === "string" && value[locale].trim());
      if (!valid) fail(`${key} must be text or an object with non-empty zh and en translations.`);
    }
    if (!Array.isArray(game.platforms) || game.platforms.length === 0 ||
        game.platforms.some((platform) => !platforms.includes(platform)) ||
        new Set(game.platforms).size !== game.platforms.length) {
      fail("platforms must contain mobile and/or desktop without duplicates.");
    }
  }
  return data;
}

export function bundlePath(game, origin = gameOrigin) {
  return `${origin}/games/${game.id}/${game.version}/${game.release ? `${game.release}/` : ""}game.js`;
}

export function playPath(game) {
  return `/play/?game=${encodeURIComponent(game.id)}`;
}

export async function loadCatalog(signal) {
  const response = await fetch(`${gameOrigin}/games.json`, { cache: "no-store", credentials: "omit", redirect: "error", signal });
  if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
  const games = validateCatalog(await response.json());
  if (gameOrigin && games.some((game) => !game.release)) throw new Error("Remote games require an immutable release.");
  return games;
}
