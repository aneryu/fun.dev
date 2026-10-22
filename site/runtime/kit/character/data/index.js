// The repository's character data (docs/character-generator.md#data): bodies, faces, garments and hair
// fitted from MakeHuman's CC0 assets (scripts/character-makehuman.mjs), with their textures in
// ./textures. A game or the lab may pass another set (same shape) to the generator; the reference
// sets the fitting tools make stay outside the repository.
import { MAKEHUMAN } from "./makehuman.js";

export const CC0 = { id: "cc0", ...MAKEHUMAN, textureRoot: new URL("./textures/", import.meta.url).href };
