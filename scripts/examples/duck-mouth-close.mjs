// Builds persistent closing targets from the actual upper-bill surface.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { Ray, Triangle, Vector3 } from "three";
import { triangulate } from "../../site/workshop/mesh.js";

export default async function(ws) {
  const { project } = JSON.parse(await readFile("test-results/duck-jaw/authored.json", "utf8"));
  const out = resolve("test-results/duck-mouth-close"); await mkdir(out, { recursive: true });
  const initial = await ws.candidate({ project }); assert.ok(initial.ok); await ws.accept(initial);
  const upper = project.nodes.find(n => n.id === "upper_bill");
  const triangles = upper.mesh.faces.flatMap(f => triangulate(upper.mesh.vertices, f.vertices)
    .map(indices => new Triangle(...indices.map(i => new Vector3(...upper.mesh.vertices[i])))));
  const lip = project.nodes.find(n => n.id === "lower_bill").mesh.vertices.slice(0, 11);
  const ceilings = lip.map(v => {
    const ray = new Ray(new Vector3(v[0], -2, v[2]), new Vector3(0, 1, 0));
    return Math.min(...triangles.map(t => ray.intersectTriangle(t.a, t.b, t.c, false, new Vector3()))
      .filter(Boolean).map(p => p.y));
  });
  assert.ok(ceilings.every(Number.isFinite), "Every lip point needs an upper-bill intersection");
  const profile = x => {
    const found = lip.findIndex((v, i) => i < lip.length - 1 && x <= lip[i + 1][0]);
    const i = found < 0 ? lip.length - 2 : found;
    const t = Math.max(0, Math.min(1, (x - lip[i][0]) / (lip[i + 1][0] - lip[i][0])));
    return [lip[i][1] * (1 - t) + lip[i + 1][1] * t, ceilings[i] * (1 - t) + ceilings[i + 1] * t];
  };
  // Mouth meshes share an identical local frame in this source. Reject a
  // changed source frame rather than silently interpreting coordinates wrong.
  const commands = [];
  for (const id of ["lower_bill", "mouth_cavity", "tongue"]) {
    const n = project.nodes.find(n => n.id === id);
    for (const field of ["parent", "position", "rotation", "scale"]) assert.deepEqual(n[field], upper[field]);
    const changes = n.mesh.vertices.map((v, index) => {
      if (id !== "lower_bill") {
        // Retract the inner parts into a small nonzero volume behind the lip.
        // A single affine map preserves their topology and orientation.
        const center = id === "tongue" ? -.45 : -.35;
        return { index, position: [v[0] * .1,
          ceilings[5] - .004 + (v[1] - center) * .004,
          1.24 + (v[2] - 1.15) * .1] };
      }
      const [edge, ceiling] = profile(v[0]);
      return { index, position: [v[0], ceiling - .012 + (v[1] - edge) * .12, v[2]] };
    });
    commands.push({ op: "morphTarget", id, name: "mouthClose", changes });
  }
  commands.push({ op: "characterControl", id: "mouthClose", bindings: ["lower_bill", "mouth_cavity", "tongue"]
    .map(node => ({ node, channel: "morph", target: "mouthClose", gain: 1 })) });
  for (const control of project.character.controls.filter(c => ["smile", "surprise"].includes(c.id)))
    commands.push({ op: "characterControl", ...control, bindings: control.bindings.map(b =>
      ["mouth_cavity", "tongue"].includes(b.node) ? { ...b, attenuateBy: "mouthClose" } : b) });
  for (const name of ["mouth_close", "close_smile"]) commands.push({ op: "characterClip", name,
    duration: 1, fps: 24, loop: true, tracks: ["mouthClose", "smile"].map(control => ({
      control, channel: "control", keys: [{ time: 0, value: 0 },
        { time: .5, value: control === "mouthClose" ? 1 : name === "close_smile" ? .4 : 0 },
        { time: 1, value: 0 }],
    })) });
  await writeFile(resolve(out, "projection.json"), JSON.stringify({ lip, ceilings, space: "shared-mouth-local-metres" }, null, 2));
  const authored = await ws.candidate({ commands, file: resolve(out, "authored.json") });
  assert.ok(authored.ok, JSON.stringify(authored.error ?? authored.validation)); await ws.accept(authored);
  const baseline = await ws.candidate();
  const closed = await ws.candidate({ commands: [{ op: "characterPose", name: "mouth_close", time: .5 }],
    file: resolve(out, "closed.json") });
  await ws.compare({ baseline, candidate: closed, file: resolve(out, "comparison.html"), views: {
    front: { view: "front", size: 512, ids: ["head_pose"] }, side: { view: "left", size: 512, ids: ["head_pose"] },
    oblique: { view: "perspective", size: 512, ids: ["head_pose"] },
  } });
  assert.ok(closed.ok, JSON.stringify(closed.error ?? closed.validation));
  const samples = [];
  for (const mouthClose of [0, .25, .5, .75, 1]) for (const mouthOpen of [0, .5, 1])
    for (const expression of [{}, { smile: .4 }, { surprise: .4 }]) {
      const values = { mouthClose, mouthOpen, smile: 0, surprise: 0, ...expression };
      const c = await ws.candidate({ commands: [{ op: "characterValues", values }] });
      samples.push({ values, ok: c.ok, error: c.error, relations: c.relations });
    }
  await writeFile(resolve(out, "samples.json"), JSON.stringify(samples, null, 2));
  assert.ok(samples.every(s => s.ok), "Inspect samples.json for blend failures");
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  const roundtrip = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(roundtrip.editable.scope.changed, []);
  return { outputs: out, sampledCombinations: samples.length, editableRoundtrip: true };
}
