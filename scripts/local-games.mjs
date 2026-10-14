import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRelease } from "./game-release.mjs";

export const gamesRoot = fileURLToPath(new URL("../games/", import.meta.url));

// Each games/<id>/ directory is one game's source; its game.json lists the runtime files.
export async function loadLocalGames(root = gamesRoot) {
  const releases = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    let release;
    try { release = await prepareRelease(join(root, entry.name, "game.json")); }
    catch (error) { throw new Error(`games/${entry.name}: ${error.message}`, { cause: error }); }
    if (release.game.id !== entry.name) throw new Error(`games/${entry.name}/game.json must use id "${entry.name}".`);
    releases.push(release);
  }
  return releases;
}

// Local previews use unhashed /games/<id>/<version>/ paths; R2 releases add a content hash.
export function localCatalog(releases) {
  return releases.map(({ game: { release, ...game } }) => game);
}
