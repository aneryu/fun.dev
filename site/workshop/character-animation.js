import * as THREE from "/runtime/three.js";
import { evaluateProject } from "./document.js";
import { ModelError } from "./mesh.js";
import { morphGeometry } from "./morph-geometry.js";
import { applyCharacter } from "./character.js";

// Bake evaluated local transforms, including surface followers. UUID tracks avoid
// ambiguity from author names, socket names or export-root renaming.
export function characterAnimations(project, model) {
  const clips = project.character?.clips ?? [];
  // Plain imported rigs export transforms/weights only. Rebuilding their split
  // meshes for every sample cannot affect these channels. Dependent geometry
  // (surface followers, recipes, copies and assemblies) retains full evaluation.
  const directChannels = !project.assemblies?.length && project.nodes.every(n =>
    !n.attachment && !n.recipe && !n.instanceOf && !n.symmetry);
  const samplePose = (clip, time) => {
    if (!directChannels) {
      const input = structuredClone(project);
      input.character.pose = { clip: clip.name, time };
      return evaluateProject(input);
    }
    const pose = { ...project, character: { ...project.character, pose: { clip: clip.name, time } },
      nodes: project.nodes.map(n => ({ ...n, position: [...n.position], rotation: [...n.rotation], scale: [...n.scale],
        ...(n.morph ? { morph: { ...n.morph, weights: { ...n.morph.weights } } } : {}) })) };
    applyCharacter(pose);
    return pose;
  };
  const objects = [...model.objects].filter(([, o]) => {
    for (let p = o; p; p = p.parent) if (p === model.root) return true;
    return false;
  });
  const deformationTargets = new Map();
  const deformationSample = (node, object) => {
    const base = project.nodes.find(n => n.id === node.id).mesh.vertices;
    const deltas = node.mesh.vertices.map((p, i) => p.map((x, k) => x - base[i][k]));
    if (deltas.every(p => p.every(x => Math.abs(x) <= 1e-9))) return -1;
    let cache = deformationTargets.get(node.id);
    if (!cache) deformationTargets.set(node.id, cache = new Map());
    const key = JSON.stringify(deltas.map(p => p.map(x => Math.round(x * 1e9))));
    if (cache.has(key)) return cache.get(key);
    const index = cache.size;
    if (index >= 128 || (index + 1) * object.geometry.attributes.position.count > 1_000_000)
      throw new ModelError("Deformation attachment bake exceeds 128 shapes or one million render vertices; reduce clip fps/duration or export fewer clips",
        "budget", `nodes.${node.id}.attachment`);
    const { geometry } = morphGeometry({ ...node, morph: { base, targets: [{ name: `surface_${index}`, deltas }] } });
    object.geometry.morphAttributes.position.push(geometry.morphAttributes.position[0]);
    object.geometry.morphAttributes.normal.push(geometry.morphAttributes.normal[0]);
    geometry.dispose();
    cache.set(key, index);
    return index;
  };
  let budget = 0;
  const baked = clips.map(clip => {
    // glTF stores times as float32. Imported frame times and freshly generated
    // frame times may differ as doubles but collapse to the same exported key.
    // Keep the original evaluation time: rounding a symmetric deformation's
    // sample time can otherwise manufacture distinct, nearly identical shapes.
    const times = new Map([[0, 0], [Math.fround(clip.duration), clip.duration]]);
    for (let i = 1; i < Math.ceil(clip.duration * clip.fps); i++) {
      const time = i / clip.fps;
      if (!times.has(Math.fround(time))) times.set(Math.fround(time), time);
    }
    for (const track of clip.tracks) for (const k of track.keys) {
      times.set(Math.fround(k.time), k.time);
      // Keep step discontinuities within 10us in a shared linear bake. Authored
      // source retains exact steps; the runtime export reports this tolerance.
      if (track.interpolation === "step" && k.time > 0) {
        const before = Math.max(0, k.time - 1e-5);
        if (!times.has(Math.fround(before))) times.set(Math.fround(before), before);
      }
    }
    const samples = [...times.keys()].sort((a, b) => a - b);
    budget += samples.length * project.nodes.length;
    if (budget > 200000) throw new ModelError(
      "Animation bake exceeds 200000 node samples; reduce clip fps/duration or export fewer clips",
      "budget", `character.clips.${clip.name}`);
    const values = new Map(objects.map(([id]) => [id, { position: [], quaternion: [], scale: [], weights: [], deformation: [] }]));
    for (const time of samples) {
      // Rounding the final time upward must not wrap a looping authoring clip.
      const pose = samplePose(clip, Math.min(times.get(time), clip.duration));
      for (const [id, object] of objects) {
        const node = pose.nodes.find(n => n.id === id), v = values.get(id);
        if (node.attachment?.mode === "deform") {
          v.deformation.push(deformationSample(node, object));
        }
        const position = [...node.position];
        if (object === model.root && node.parent === null)
          position.forEach((p, i) => { position[i] = p - model.origin.point[i]; });
        v.position.push(...position);
        const q = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(...node.rotation.map(THREE.MathUtils.degToRad)));
        v.quaternion.push(...q.toArray());
        v.scale.push(...node.scale);
        if (node.morph && object.morphTargetInfluences?.length)
          v.weights.push(...node.morph.targets.map(t => node.morph.weights[t.name] ?? 0));
      }
    }
    return { clip, samples, values };
  });
  for (const [id, object] of objects) if (deformationTargets.has(id)) {
    object.updateMorphTargets();
    object.geometry.computeBoundingBox(); object.geometry.computeBoundingSphere();
  }
  return baked.map(({ clip, samples, values }) => {
    const tracks = [];
    for (const [id, object] of objects) {
      const v = values.get(id);
      // Include constant rest channels: switching clips must also reset channels
      // left posed by a previous clip.
      tracks.push(new THREE.VectorKeyframeTrack(`${object.uuid}.position`, samples, v.position),
        new THREE.QuaternionKeyframeTrack(`${object.uuid}.quaternion`, samples, v.quaternion),
        new THREE.VectorKeyframeTrack(`${object.uuid}.scale`, samples, v.scale));
      if (v.weights.length)
        tracks.push(new THREE.NumberKeyframeTrack(`${object.uuid}.morphTargetInfluences`, samples, v.weights));
      const count = deformationTargets.get(id)?.size ?? 0;
      if (count) tracks.push(new THREE.NumberKeyframeTrack(`${object.uuid}.morphTargetInfluences`, samples,
        v.deformation.flatMap(index => Array.from({ length: count }, (_, i) => i === index ? 1 : 0))));
    }
    const animation = new THREE.AnimationClip(clip.name, clip.duration, tracks);
    animation.userData = { loop: clip.loop ? "repeat" : "once", bakeFps: clip.fps, stepToleranceSeconds: 1e-5,
      deformationShapes: Object.fromEntries([...deformationTargets].map(([id, cache]) => [id, cache.size])) };
    return animation;
  });
}
