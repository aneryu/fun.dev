// fundev-runtime: the fun.dev runtime kit for three.js (docs/model-format.md §7, docs/worlds.md §7).
// Three.js is injected (`{ THREE }`), never imported, so one copy serves the whole page.
export { createFun3d, CAPS, VERSION } from "./kit/fun3d.js";
export { createWriter } from "./kit/fun3d-write.js";
export { validateManifest, idFromName } from "./kit/fun3d-schema.js";
export { createModels } from "./kit/models.js";
export { createMaterials } from "./kit/materials.js";
export { createLightSlots } from "./kit/lights.js";
export { normalizePresentation, createPresentation } from './kit/presentation.js';
export { createPhysics } from "./kit/physics.js";
export { createAnimator } from "./kit/animation.js";
export { createFixedStep, lerp } from "./kit/loop.js";
export { createTimeline } from './kit/timeline.js';
export { RIPPLE_ID, RIPPLE_CONTRACT, normalizeRipple, createRippleExtension } from './kit/ripple.js';
export { worldData, createWorld, buildNetwork } from "./kit/world.js";
export { evaluateScatter, alongPath, inPolygon, onGrid, insidePolygon } from "./kit/scatter.js";
export { evaluateAssembly, boxSockets } from "./kit/assemble.js";
export { generateHeights, classifySurfaces, heightAt, surfaceAt, terrainMesh, terrainBounds } from "./kit/terrain.js";
export { cellAt, gridHeightAt, cellCentre, gridMesh, gridPath, gridBounds } from "./kit/grid.js";
export { sweepPath, sweepNetwork, weldPaths, resamplePath, cutPolyline, resolveProfile, SWEEP_PRESETS, SWEEP_MATERIALS } from "./kit/sweep.js";
export { evaluateLots, polylineAt } from "./kit/lots.js";
export { navPath, walkableAt, navCellAt, lineClear, reachable, stitchNavgrids } from "./kit/nav.js";
export { createRandom, hashString, dailySeed } from "./kit/random.js";
export { cloneObjects } from "./kit/objects.js";
