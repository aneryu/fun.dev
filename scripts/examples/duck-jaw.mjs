// A joint-driven mouth inside the same surface-attached frame.
// node scripts/editor-agent.mjs --run scripts/examples/duck-jaw.mjs
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

export default async function(ws) {
  const { project } = JSON.parse(await readFile("test-results/duck-controls/authored.json", "utf8"));
  const out = resolve("test-results/duck-jaw"); await mkdir(out, { recursive: true });
  const initial = await ws.candidate({ project }); assert.ok(initial.ok); await ws.accept(initial);
  const lower = project.nodes.find(n => n.id === "lower_bill");
  const hinge = lower.mesh.vertices[0].map((v, k) => (k === 0 ? 0 : v) + lower.position[k]);
  const commands = [
    { op: "create", kind: "group", id: "mouth_fixed_joint", parent: "mouth_mount" },
    { op: "joint", id: "mouth_fixed_joint" },
    { op: "create", kind: "group", id: "jaw_joint", parent: "mouth_mount", position: hinge },
    { op: "joint", id: "jaw_joint" },
  ];
  for (const id of ["lower_bill", "mouth_cavity", "tongue"]) {
    const n = project.nodes.find(n => n.id === id);
    commands.push({ op: "skinBind", id, joints: ["mouth_fixed_joint", "jaw_joint"],
      weights: n.mesh.vertices.map((v, index) => {
        // The lining's roof stays fixed; its lower portion follows the jaw.
        const w = id === "mouth_cavity" ? Math.max(0, Math.min(1, (-v[1] - .18) / .3)) : 1;
        return { index, influences: [
          ...(w < 1 ? [{ joint: "mouth_fixed_joint", weight: 1 - w }] : []),
          ...(w > 0 ? [{ joint: "jaw_joint", weight: w }] : []),
        ] };
      }) });
  }
  commands.push({ op: "characterControl", id: "mouthOpen", bindings: [
    { node: "jaw_joint", channel: "rotation", delta: [15, 0, 0] },
  ] });
  for (const name of ["mouth_open", "mouth_expression"]) commands.push({
    op: "characterClip", name, duration: 1, fps: 24, loop: true,
    tracks: ["mouthOpen", "smile", "surprise"].map(control => ({
      control, channel: "control", keys: [{ time: 0, value: 0 },
        { time: .5, value: control === "mouthOpen" ? 1 : name === "mouth_expression" ? .4 : 0 },
        { time: 1, value: 0 }],
    })),
  });
  // Exercise the mouth together with an existing walking clip.
  const walk = project.character.clips.find(c => c.name === "walk");
  commands.push({ op: "characterClip", ...walk, tracks: [...walk.tracks, {
    control: "mouthOpen", channel: "control",
    keys: [{ time: 0, value: 0 }, { time: walk.duration / 2, value: 1 }, { time: walk.duration, value: 0 }],
  }] });
  const authored = await ws.candidate({ commands, file: resolve(out, "authored.json") });
  assert.ok(authored.ok, JSON.stringify(authored.error ?? authored.relations)); await ws.accept(authored);
  const baseline = await ws.candidate();
  const posed = await ws.candidate({ commands: [{ op: "characterPose", name: "mouth_expression", time: .5 }],
    file: resolve(out, "open.json") });
  assert.ok(posed.ok, JSON.stringify(posed.error ?? posed.relations));
  await ws.compare({ baseline, candidate: posed, file: resolve(out, "comparison.html"), views: {
    front: { view: "front", size: 512, ids: ["head_pose"] },
    side: { view: "left", size: 512, ids: ["head_pose"] },
    oblique: { view: "perspective", size: 512, ids: ["head_pose"] },
  } });
  const samples = [];
  for (const name of ["mouth_open", "mouth_expression", "walk"])
    for (let i = 0; i <= 8; i++) {
      const time = i / 8 * (name === "walk" ? walk.duration : 1);
      const c = await ws.candidate({ commands: [{ op: "characterPose", name, time }] });
      samples.push({ name, time, ok: c.ok, relations: c.relations });
    }
  await writeFile(resolve(out, "samples.json"), JSON.stringify(samples, null, 2));
  assert.ok(samples.every(s => s.ok), "Inspect sampled relation results");
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  await ws.exportGLB({ file: resolve(out, "duck.glb") });
  const roundtrip = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(roundtrip.editable.scope.changed, []);
  return { outputs: out, samples: samples.length, editableRoundtrip: true,
    limitation: "0..1 opens the already-open reference by another 15 degrees; no fully closed pose or continuous cavity collision certification." };
}
