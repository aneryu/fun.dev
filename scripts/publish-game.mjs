import { prepareRelease, publishRelease, unregisterGame } from "./game-release.mjs";
import { createR2Store } from "./r2-store.mjs";
import { createWranglerStore } from "./r2-wrangler-store.mjs";

const [action, input, ...flags] = process.argv.slice(2);
// --wrangler: upload through the logged-in Wrangler CLI when no R2 S3 keys are configured.
const openStore = () => flags.includes("--wrangler") ? createWranglerStore() : createR2Store();
let store;
try {
  if (!["publish", "remove"].includes(action) || !input || flags.some((flag) => !["--dry-run", "--wrangler"].includes(flag))) throw new Error("Usage: npm run game:publish -- /path/to/game.json [--dry-run] [--wrangler] OR npm run game:remove -- <id> [--wrangler]");
  if (action === "publish") {
    const release = await prepareRelease(input);
    console.log(`${release.game.id}@${release.game.version}: ${release.assets.length} files, ${release.total} bytes, release ${release.game.release}`);
    if (flags.includes("--dry-run")) {
      for (const asset of release.assets) console.log(`  ${asset.path}`);
    } else {
      store = openStore();
      await publishRelease(store, release);
      console.log("Published bundle and registered game in R2. Website deployment unchanged.");
    }
  } else {
    if (flags.some((flag) => flag !== "--wrangler")) throw new Error("remove only accepts --wrangler.");
    store = openStore();
    await unregisterGame(store, input);
    console.log("Removed catalog entry. Released assets retained. Website deployment unchanged.");
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { store?.close(); }
