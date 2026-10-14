import { prepareRelease, publishRelease, unregisterGame } from "./game-release.mjs";
import { createR2Store } from "./r2-store.mjs";

const [action, input, ...flags] = process.argv.slice(2);
let store;
try {
  if (!["publish", "remove"].includes(action) || !input || flags.some((flag) => flag !== "--dry-run")) throw new Error("Usage: npm run game:publish -- /path/to/game.json [--dry-run] OR npm run game:remove -- <id>");
  if (action === "publish") {
    const release = await prepareRelease(input);
    console.log(`${release.game.id}@${release.game.version}: ${release.assets.length} files, ${release.total} bytes, release ${release.game.release}`);
    if (flags.includes("--dry-run")) {
      for (const asset of release.assets) console.log(`  ${asset.path}`);
    } else {
      store = createR2Store();
      await publishRelease(store, release);
      console.log("Published bundle and registered game in R2. Website deployment unchanged.");
    }
  } else {
    if (flags.length) throw new Error("remove does not accept flags.");
    store = createR2Store();
    await unregisterGame(store, input);
    console.log("Removed catalog entry. Released assets retained. Website deployment unchanged.");
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { store?.close(); }
