import { bathDuckScene, BATH_DUCK_PRESET, BATH_DUCK_BLOCKS } from "./bath-duck.js";

export { bathDuckScene, BATH_DUCK_PRESET, BATH_DUCK_BLOCKS };

export const SCENES = [bathDuckScene];

export function findSceneById(id) {
  return SCENES.find((s) => s.id === id) || bathDuckScene;
}
