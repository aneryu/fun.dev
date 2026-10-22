// Procedural characters: the generator's public entry (docs/character-generator.md).
export { generateCharacter, resolveParameters, sampleSemantic, garmentsFor, parametersFor, faceTint, DEFAULT_DATA, PARAMETERS, SLOTS, FEATURES, GENERATOR, GENERATOR_VERSION, LODS } from "./character/index.js";
export { clipTracks, retargetClip } from "./character/motion.js";
export { actionClip, actionNames, KEY_RULE, locomotionClip, locomotionClips, locomotionGaits, locomotionStyle, STYLE, TRANSITIONS, transitionClip, transitionProgress } from "./character/locomotion.js";
export { clipContacts, clipGait, clipPassing, createGait, sample, trackPositions } from "./character/gait.js";
export { bodyPoints, characterSoles, createFootLock, groundFeet, raiseBody, shiftBody, twoBoneIK } from "./character/feet.js";
export { bankAngle, bankPose, lookPose, pitchPose } from "./character/steer.js";
export { armClearance, clearArms } from "./character/clear.js";
export { actionFit, applyTextures, characterObject, characterTextures, characterTracks, clipToThree, createWalker } from "./character/three.js";
