import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRelease } from "./game-release.mjs";

const platform = fileURLToPath(new URL("../", import.meta.url));
// The platform's own test game, used by npm run verify; never published.
export const fixtureGames = join(platform, "tests", "fixture-games");
// Game sources live outside this repository (docs/workflow.md): FUNDEV_GAMES, else the
// fundev-games checkout beside it. Without either there are no local games.
export const gamesRoot = () => (process.env.FUNDEV_GAMES ? resolve(process.env.FUNDEV_GAMES) : join(platform, "..", "fundev-games"));
export const isFixtureRoot = (root) => resolve(root) === resolve(fixtureGames);

// Each <root>/<id>/ directory is one game's source; its game.json lists the runtime files.
export async function loadLocalGames(root = gamesRoot()) {
  if (!existsSync(root)) return [];
  const releases = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (!existsSync(join(root, entry.name, "game.json"))) continue;
    let release;
    try { release = await prepareRelease(join(root, entry.name, "game.json")); }
    catch (error) { throw new Error(`${entry.name}: ${error.message}`, { cause: error }); }
    if (release.game.id !== entry.name) throw new Error(`${entry.name}/game.json must use id "${entry.name}".`);
    releases.push(release);
  }
  return releases;
}

// Local previews use unhashed /games/<id>/<version>/ paths; R2 releases add a content hash.
export function localCatalog(releases) {
  return releases.map(({ game: { release, ...game } }) => game);
}
