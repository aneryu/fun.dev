import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { worldMatrix, point, inverse } from "../../site/workshop/spatial.js";

export default async function(ws) {
  const input = JSON.parse(await readFile(process.env.DUCK_PROJECT ?? "test-results/duck-actions/authored.json", "utf8"));
  const out = resolve("test-results/duck-skin"); await mkdir(out, { recursive: true });
  const initial = await ws.candidate({ project: input.project ?? input });
  assert.ok(initial.ok); await ws.accept(initial);
  const p = await ws.call("getProject"), commands = [];
  for (const side of ["left", "right"]) {
    const id = `wing_${side}`, root = `${id}_joint`, tip = `${id}_tip`;
    const n = p.nodes.find(n => n.id === id), frame = worldMatrix(p, root);
    const vertices = n.mesh.vertices.map(v => point(inverse(frame), point(worldMatrix(p, id), v)));
    const sign = side === "left" ? 1 : -1;
    const extent = Math.max(...vertices.map(v => v[0] * sign));
    commands.push({ op: "create", kind: "group", id: tip, parent: root, position: [sign * extent * .5, 0, 0] },
      { op: "joint", id: tip }, { op: "skinBind", id, joints: [root, tip],
        weights: vertices.map((v, index) => {
          const t = Math.max(0, Math.min(1, (v[0] * sign / extent - .2) / .8));
          return { index, influences: [
            ...(t < 1 ? [{ joint: root, weight: 1 - t }] : []),
            ...(t > 0 ? [{ joint: tip, weight: t }] : []),
          ] };
        }) });
  }
  await ws.apply(commands);
  const clips = p.character.clips.map(c => ({ op: "characterClip", ...c,
    tracks: [...c.tracks, ...["left", "right"].map(side => ({
      node: `wing_${side}_tip`, channel: "rotation", keys: Array.from({ length: 9 }, (_, i) => ({
        time: c.duration * i / 8, value: [0, 0,
          (["walk", "run", "jump"].includes(c.name) ? 12 : 0) * (side === "left" ? 1 : -1) * Math.sin(Math.PI * 2 * i / 8)],
      })),
    }))] }));
  const authored = await ws.candidate({ commands: clips, file: resolve(out, "authored.json") });
  assert.ok(authored.ok, JSON.stringify(authored.error)); await ws.accept(authored);
  const baseline = await ws.candidate();
  const posed = await ws.candidate({ commands: [{ op: "characterPose", name: "walk", time: .3 }],
    file: resolve(out, "walk.json") });
  assert.ok(posed.ok, JSON.stringify(posed.error));
  await ws.compare({ baseline, candidate: posed, file: resolve(out, "walk.html"), views: {
    front: { view: "front", size: 512 }, side: { view: "left", size: 512 },
    oblique: { view: "perspective", size: 512 },
  } });
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  await ws.exportGLB({ file: resolve(out, "duck.glb") });
  const result = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(result.editable.scope.changed, []);
  return { outputs: out, skinnedMeshes: 2, joints: 8 };
}
