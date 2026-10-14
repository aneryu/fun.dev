import { gameOrigin } from "./game-source.js";
export const API_VERSION = 2;
export const platforms = ["mobile", "desktop"];
export const orientations = ["any", "portrait", "landscape"];

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
    // Other API versions stay valid metadata; the lobby hides them and the player explains the mismatch.
    if (!Number.isInteger(game.apiVersion) || game.apiVersion < 1) fail("apiVersion must be a positive integer.");
    if (typeof game.version !== "string" || !/^\d+\.\d+\.\d+$/.test(game.version)) {
      fail("version must use the format 1.0.0.");
    }
    if (game.release !== undefined && (typeof game.release !== "string" || !/^[a-f0-9]{64}$/.test(game.release))) fail("release must be a SHA-256 digest.");
    for (const key of ["title", "description", "category", "howToPlay"]) {
      const value = game[key];
      if (key === "howToPlay" && value === undefined) continue;
      const valid = typeof value === "string" ? value.trim() : value &&
        typeof value === "object" && !Array.isArray(value) &&
        ["zh", "en"].every((locale) => typeof value[locale] === "string" && value[locale].trim());
      if (!valid) fail(`${key} must be text or an object with non-empty zh and en translations.`);
    }
    if (game.orientation !== undefined && !orientations.includes(game.orientation)) fail("orientation must be any, portrait, or landscape.");
    if (game.keepAwake !== undefined && typeof game.keepAwake !== "boolean") fail("keepAwake must be a boolean.");
    if (game.cover !== undefined && (typeof game.cover !== "string" || !/^[a-zA-Z0-9_-][a-zA-Z0-9_/-]*(?:\.[a-zA-Z0-9_-]+)*\.(?:webp|png|jpe?g)$/.test(game.cover) || game.cover.split("/").some((part) => !part || part.startsWith(".")))) {
      fail("cover must be a relative .webp, .png or .jpg path inside the bundle.");
    }
    if (!Array.isArray(game.platforms) || game.platforms.length === 0 ||
        game.platforms.some((platform) => !platforms.includes(platform)) ||
        new Set(game.platforms).size !== game.platforms.length) {
      fail("platforms must contain mobile and/or desktop without duplicates.");
    }
  }
  return data;
}

export function compatible(game) {
  return game.apiVersion === API_VERSION;
}

export function bundleBase(game, origin = gameOrigin) {
  return `${origin}/games/${game.id}/${game.version}/${game.release ? `${game.release}/` : ""}`;
}

export function bundlePath(game, origin = gameOrigin) {
  return `${bundleBase(game, origin)}game.js`;
}

export function coverURL(game, origin = gameOrigin) {
  return game.cover ? `${bundleBase(game, origin)}${game.cover}` : null;
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
