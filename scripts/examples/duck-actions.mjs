import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { worldMatrix, point } from "../../site/workshop/spatial.js";
import { evaluateProject } from "../../site/workshop/document.js";

export default async function(ws) {
  const input = JSON.parse(await readFile(process.env.DUCK_PROJECT ?? "test-results/duck-character/authored.json", "utf8"));
  const out = resolve("test-results/duck-actions"); await mkdir(out, { recursive: true });
  const initial = await ws.candidate({ project: input.project ?? input });
  assert.ok(initial.ok); await ws.accept(initial);
  const p = await ws.call("getProject");
  const commands = [{ op: "joint", id: "duck" }, { op: "joint", id: "head_pose" }];
  for (const side of ["left", "right"]) for (const part of ["leg", "wing"]) {
    const id = `${part}_${side}`, n = p.nodes.find(n => n.id === id);
    const points = n.mesh.vertices.map(v => point(worldMatrix(p, id), v));
    const min = [0, 1, 2].map(k => Math.min(...points.map(v => v[k])));
    const max = [0, 1, 2].map(k => Math.max(...points.map(v => v[k])));
    const position = min.map((v, k) => (v + max[k]) / 2);
    position[1] = max[1] - .03;
    if (part === "wing") position[0] = side === "left" ? min[0] : max[0];
    const joint = `${id}_joint`;
    commands.push({ op: "create", kind: "group", id: joint, parent: "duck", position },
      { op: "joint", id: joint }, { op: "set", id, parent: joint, keepWorld: true });
    if (part === "leg") commands.push({ op: "set", id: `foot_${side}`, parent: joint, keepWorld: true });
  }
  await ws.apply(commands);
  const rig = await ws.call("getProject");
  const clips = [];
  for (const [name, duration, amplitude, lift] of [
    ["stand", 2, 0, 0], ["walk", 1.2, 18, .05], ["run", .65, 32, .12], ["jump", 1.2, 12, .5],
  ]) {
    const keys = f => Array.from({ length: 9 }, (_, i) => ({ time: duration * i / 8, value: f(i / 8) }));
    const tracks = [];
    for (const side of ["left", "right"]) {
      const sign = side === "left" ? 1 : -1;
      tracks.push({ node: `leg_${side}_joint`, channel: "rotation",
        keys: keys(t => [amplitude * Math.sin(t * Math.PI * 2) * sign, 0, 0]) });
      tracks.push({ node: `wing_${side}_joint`, channel: "rotation",
        keys: keys(t => [0, 0, amplitude * .6 * Math.sin(t * Math.PI * 2) * sign]) });
    }
    tracks.push({ node: "duck", channel: "position",
      keys: keys(t => [0, name === "jump" ? lift * Math.sin(Math.PI * t) ** 2 : lift * Math.sin(Math.PI * 2 * t) ** 2, 0]) });
    tracks.push({ node: "head_pose", channel: "rotation",
      keys: keys(t => [amplitude * .12 * Math.sin(t * Math.PI * 2), 0, 0]) });
    for (const control of ["blink", "smile", "surprise"])
      tracks.push({ control, channel: "control", keys: keys(t =>
        control === "smile" ? .3 : control === "blink" && t === .5 ? 1 : 0) });
    clips.push({ op: "characterClip", name, duration, fps: 24, loop: name !== "jump", tracks });
  }
  await ws.apply(clips);
  const moving = await ws.call("getProject");
  const floor = Math.min(...rig.nodes.filter(n => n.id.startsWith("foot_")).flatMap(n =>
    n.mesh.vertices.map(v => point(worldMatrix(rig, n.id), v)[1])));
  for (const clip of clips) {
    const root = clip.tracks.find(t => t.node === "duck" && t.channel === "position");
    root.keys = Array.from({ length: 97 }, (_, i) => {
      const time = clip.duration * i / 96, input = structuredClone(moving);
      input.character.pose = { clip: clip.name, time };
      const pose = evaluateProject(input);
      const bottom = Math.min(...pose.nodes.filter(n => n.id.startsWith("foot_")).flatMap(n =>
        n.mesh.vertices.map(v => point(worldMatrix(pose, n.id), v)[1])));
      const y = pose.nodes.find(n => n.id === "duck").position[1];
      return { time, value: [0, y + (clip.name === "walk" ? floor - bottom : Math.max(0, floor - bottom)), 0] };
    });
  }
  const authored = await ws.candidate({ commands: clips, file: resolve(out, "authored.json") });
  assert.ok(authored.ok, JSON.stringify(authored.error)); await ws.accept(authored);
  const complete = await ws.call("getProject"), contacts = [];
  for (const clip of clips) {
    let minimumGap = Infinity;
    for (let i = 0; i < 96; i++) {
      const q = structuredClone(complete);
      q.character.pose = { clip: clip.name, time: clip.duration * (i + .5) / 96 };
      const pose = evaluateProject(q);
      const bottom = Math.min(...pose.nodes.filter(n => n.id.startsWith("foot_")).flatMap(n =>
        n.mesh.vertices.map(v => point(worldMatrix(pose, n.id), v)[1])));
      minimumGap = Math.min(minimumGap, bottom - floor);
    }
    contacts.push({ clip: clip.name, check: "sampled-foot-floor", minimumGap, threshold: -.002,
      samples: 96, coordinateSpace: "world", unit: "metre", floor });
    assert.ok(minimumGap >= -.002, `${clip.name} foot penetration ${minimumGap}`);
  }
  await writeFile(resolve(out, "contact.json"), JSON.stringify({ contacts,
    notChecked: ["continuous-time contact", "foot sliding", "inter-part collision"] }, null, 2));
  for (const [name, time] of [["stand", 0], ["walk", .3], ["run", .1625], ["jump", .6]]) {
    const baseline = await ws.candidate({ project: rig });
    const candidate = await ws.candidate({ commands: [{ op: "characterPose", name, time }],
      file: resolve(out, `${name}.json`) });
    assert.ok(candidate.ok, JSON.stringify(candidate.error));
    await ws.compare({ baseline, candidate, file: resolve(out, `${name}.html`), views: {
      front: { view: "front", size: 512 }, side: { view: "left", size: 512 },
      oblique: { view: "perspective", size: 512 },
    } });
  }
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  await ws.exportGLB({ file: resolve(out, "duck.glb") });
  const result = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(result.editable.scope.changed, []);
  return { outputs: out, joints: 6, clips: 8 };
}
