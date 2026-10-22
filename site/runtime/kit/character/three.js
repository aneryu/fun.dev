// Generated characters in three.js (docs/character-generator.md#in-a-game): the skinned mesh, clips
// as AnimationClips, and a walker that runs the gait with planted feet.
//
//   const character = generateCharacter({ seed: 7 });                 // THREE: the game's three.js
//   const object = characterObject(THREE, character);                 // a SkinnedMesh, standing at the origin
//   await applyTextures(THREE, object, character, DEFAULT_DATA, load); // load(url, colorSpace) → THREE.Texture
//   const mixer = new THREE.AnimationMixer(object);
//   mixer.clipAction(clipToThree(THREE, character, roleClip)).play(); // a clip by role (kit/character/clips) or by bone
//   const walker = createWalker(THREE, object, character, [idle, walk, jog, sprint]);   // role or bone clips
//   walker.update(dt, { speed: 1.5, turn: 0 });                       // each frame; moves the object forward

import { createFootLock } from "./feet.js";
import { createGait } from "./gait.js";
import { clipTracks, retargetClip } from "./motion.js";

// Default colours by island: the body's parts, the eyes, then garments by slot.
const COLOURS = { body: "#e9dcc4", joints: "#5c5133", head: "#e3b48f", upper: "#e3b48f", lower: "#e3b48f", feet: "#e3b48f", eyes: "#fff7d6" };
const SLOT_COLOURS = { top: "#064f67", bottom: "#211f17", shoes: "#9c3a12", hair: "#3b2a1a" };

/**
 * A THREE.SkinnedMesh for a generated character: one material (MeshStandardMaterial) per island,
 * named after it and coloured by `colours` (island → colour) or the defaults; garments by slot.
 * `data` is the character's data set, for its garments' slots.
 */
export function characterObject(THREE, character, { colours = {}, data = null } = {}) {
  const { mesh, skeleton } = character;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(mesh.joints, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(mesh.weights, 4));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  mesh.groups.forEach((g, i) => geometry.addGroup(g.start, g.count, i));
  geometry.computeBoundingSphere();

  const bones = skeleton.bones.map((b) => Object.assign(new THREE.Bone(), { name: b.id }));
  const world = skeleton.bones.map((b) => ({ p: new THREE.Vector3(...b.position), q: new THREE.Quaternion(...b.rotation) }));
  skeleton.bones.forEach((b, i) => {
    const bone = bones[i];
    if (b.parentIndex < 0) { bone.position.copy(world[i].p); bone.quaternion.copy(world[i].q); return; }
    const parent = world[b.parentIndex], inv = parent.q.clone().invert();
    bone.position.copy(world[i].p).sub(parent.p).applyQuaternion(inv);
    bone.quaternion.copy(inv).multiply(world[i].q);
    bones[b.parentIndex].add(bone);
  });
  const slotOf = (island) => data?.garments?.[character.semantic.body]?.[island]?.slot;
  const materials = mesh.groups.map((g) => {
    const slot = slotOf(g.island);
    return new THREE.MeshStandardMaterial({
      name: g.island, roughness: 0.85,
      color: colours[g.island] ?? COLOURS[g.island] ?? SLOT_COLOURS[slot] ?? "#e9dcc4",
      // Hair is cards, seen from both sides.
      side: slot === "hair" ? THREE.DoubleSide : THREE.FrontSide,
    });
  });
  const object = new THREE.SkinnedMesh(geometry, materials);
  object.name = `character ${character.seed}`;
  object.add(bones[0]);
  object.updateMatrixWorld(true);
  object.bind(new THREE.Skeleton(bones));
  object.userData.rest = bones.map((b) => b.quaternion.clone());
  object.userData.character = { seed: character.seed, data: character.data, semantic: character.semantic };
  return object;
}

/**
 * The textures of a character's islands from its data set (`data.textures`, `data.textureRoot`):
 * island → { diffuse, normal, alphaTest, tint } (URLs). The skin is its dominant face's when the set
 * has faces; a garment's colour picks its tint.
 */
export function characterTextures(character, data) {
  const root = data?.textureRoot;
  if (!root) return {};
  const t = data.textures ?? {}, { semantic } = character, body = semantic.body, url = (file) => (file ? new URL(file, root).href : null);
  const faces = data.faces?.[body], dominant = faces && (semantic.faceMix < 0.5 ? semantic.face : semantic.face2);
  const skin = faces?.skins?.[faces.faces.indexOf(dominant)] ?? t[`${body}/skin`];
  const out = {};
  for (const { island } of character.mesh.groups) {
    const garment = data.garments?.[body]?.[island];
    if (island === "skin") out.skin = { diffuse: url(skin), normal: url(t[`${body}/skin_normal`]) };
    else if (island === "eyes") out.eyes = { diffuse: url(t.eyes) };
    else if (garment) out[island] = { diffuse: url(garment.texture), normal: url(garment.normal), alphaTest: garment.alpha ? 0.5 : 0, tint: garment.tints?.[semantic[`${garment.slot}Colour`]] ?? null };
  }
  return out;
}

/**
 * Puts a character's textures on its object's materials: `load(url, colorSpace)` gives a
 * THREE.Texture (or its promise; with `flipY` off). Resolves when every texture is on.
 */
export function applyTextures(THREE, object, character, data, load) {
  const layers = characterTextures(character, data);
  return Promise.all(character.mesh.groups.map(async ({ island }, i) => {
    const layer = layers[island], m = object.material[i];
    if (!layer?.diffuse) return;
    m.color.set(layer.tint ?? "#ffffff");
    const [map, normal] = await Promise.all([load(layer.diffuse, THREE.SRGBColorSpace), layer.normal ? load(layer.normal, THREE.NoColorSpace) : null]);
    m.map = map; m.normalMap = normal; m.alphaTest = layer.alphaTest ?? 0;
    m.needsUpdate = true;
  }));
}

/** Tracks for a clip on this character: a role clip (with `rest`) is retargeted first. */
export function characterTracks(character, clip) {
  return clipTracks(character.skeleton, clip.rest ? retargetClip(clip, character.skeleton, character.rig) : clip);
}

/** A THREE.AnimationClip for a clip on this character (bones by id; the hips move). */
export function clipToThree(THREE, character, clip) {
  const t = characterTracks(character, clip);
  const tracks = Object.entries(t.rotations).map(([id, q]) => new THREE.QuaternionKeyframeTrack(`${id}.quaternion`, t.times, q));
  tracks.push(new THREE.VectorKeyframeTrack(`${character.skeleton.bones[0].id}.position`, t.times, t.hips));
  const out = new THREE.AnimationClip(clip.name, t.duration, tracks);
  out.userData = { loop: t.loop };
  return out;
}

/**
 * A walker: the gait over locomotion clips (role or bone clips, any order, an idle among them)
 * with planted feet. `update(dt, { speed, turn })` poses the object's bones and moves the object
 * forward (its +z) at `speed` m/s while turning at `turn` rad/s; `feet: false` lets them slide.
 */
export function createWalker(THREE, object, character, clips, { feet = true } = {}) {
  const gait = createGait(character.skeleton, clips.map((clip) => characterTracks(character, clip)));
  const lock = createFootLock(character.skeleton);
  const byName = new Map(object.skeleton.bones.map((b) => [b.name, b]));
  const forward = new THREE.Vector3();
  return {
    gait,
    update(dt, { speed = 0, turn = 0 } = {}) {
      const pose = gait.update(dt, speed);
      if (feet) lock.apply(pose, { forward: speed * dt, turn: turn * dt, dt });
      for (const [id, q] of Object.entries(pose.rotations)) byName.get(id)?.quaternion.set(q[0], q[1], q[2], q[3]);
      object.skeleton.bones[0].position.set(...pose.hips);
      object.rotation.y += turn * dt;
      object.position.add(forward.set(Math.sin(object.rotation.y), 0, Math.cos(object.rotation.y)).multiplyScalar(speed * dt));
      return pose;
    },
  };
}
