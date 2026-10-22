// Procedural characters: the generator's public entry (docs/character-generator.md).
export { generateCharacter, resolveParameters, sampleSemantic, garmentsFor, parametersFor, faceTint, DEFAULT_DATA, PARAMETERS, SLOTS, FEATURES, GENERATOR, GENERATOR_VERSION, LODS } from "./character/index.js";
export { clipTracks, retargetClip } from "./character/motion.js";
export { clipGait, createGait, sample, trackPositions } from "./character/gait.js";
export { createFootLock, twoBoneIK } from "./character/feet.js";
export { applyTextures, characterObject, characterTextures, characterTracks, clipToThree, createWalker } from "./character/three.js";
