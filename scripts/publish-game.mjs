import { prepareRelease, publishRelease, unregisterGame } from "./game-release.mjs";
import { createWranglerStore } from "./r2-wrangler-store.mjs";

// Manual publishing; `npm run release` does this automatically for changed games.
const [action, input, ...flags] = process.argv.slice(2);
let store;
try {
  if (!["publish", "remove"].includes(action) || !input || flags.some((flag) => flag !== "--dry-run")) throw new Error("Usage: npm run game:remove -- <id>  (publishing: npm run release)");
  if (action === "publish") {
    const release = await prepareRelease(input);
    console.log(`${release.game.id}@${release.game.version}: ${release.assets.length} files, ${release.total} bytes, release ${release.game.release}`);
    if (flags.includes("--dry-run")) {
      for (const asset of release.assets) console.log(`  ${asset.path}${asset.blob ? ` → blobs/${asset.blob}` : ""}`);
    } else {
      store = createWranglerStore(undefined, { publicOrigin: "https://cdn.fun.dev" });
      await publishRelease(store, release);
      console.log("Published bundle and registered game in R2. Website deployment unchanged.");
    }
  } else {
    if (flags.length) throw new Error("remove does not accept flags.");
    store = createWranglerStore();
    await unregisterGame(store, input);
    console.log("Removed catalog entry. Released assets retained. Website deployment unchanged.");
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { store?.close(); }
