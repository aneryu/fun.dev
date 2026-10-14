import { createR2Store } from "./r2-store.mjs";
import { createWranglerStore } from "./r2-wrangler-store.mjs";

// S3 keys in .env give conditional catalog writes; otherwise use the logged-in Wrangler.
export function openGameStore(env = process.env) {
  if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) return { store: createR2Store(env), kind: "R2 S3 API" };
  return { store: createWranglerStore(env.R2_BUCKET || "fundev-games"), kind: "Wrangler" };
}
