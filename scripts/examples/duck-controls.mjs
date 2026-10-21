// node scripts/editor-agent.mjs --run scripts/examples/duck-controls.mjs
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { worldMatrix, point } from "../../site/workshop/spatial.js";

export default async function(ws) {
  const { project } = JSON.parse(await readFile("test-results/duck-relations-verified/authored.json", "utf8"));
  const out = resolve("test-results/duck-controls"); await mkdir(out, { recursive: true });
  const initial = await ws.candidate({ project }); assert.ok(initial.ok); await ws.accept(initial);
  const head = project.nodes.find(n => n.id === "head");
  const parameters = Object.fromEntries(["headWidth", "foreheadWidth", "crownFlatten", "headDepth"]
    .map(name => [name, { value: 0, min: name === "crownFlatten" ? 0 : -.1, max: .15 }]));
  await ws.apply([{ op: "recipe", id: "head", definition: {
    parameters, generator: { kind: "mesh", mesh: head.mesh, material: head.mesh.faces[0].material },
    steps: [{ op: "controlDeform", label: "Local head controls", mirrorAxis: "x", handles: [
      { center: [1.1, 0, .15], radius: .65, delta: [{ $param: "headWidth" }, 0, 0] },
      { center: [.7, .72, .18], radius: .7, delta: [{ $param: "foreheadWidth" }, 0, 0] },
      { center: [0, .885, .19], radius: .7, delta: [0, { $param: "crownFlatten", factor: -1 }, 0] },
      { center: [0, 0, .85], radius: .75, delta: [0, 0, { $param: "headDepth" }] },
    ] }],
  } }]);
  const baseline = await ws.candidate();
  const followers = ["eye_right", "eye_left", "eye_highlight_right", "eye_highlight_left", "mouth_mount",
    "upper_bill", "lower_bill", "mouth_cavity", "tongue", "nostril_right", "nostril_left"];
  const protectedVertices = { head: head.mesh.vertices.flatMap((v, i) => v[1] <= -.65 ? [i] : []) };
  const candidate = await ws.candidate({
    commands: [{ op: "recipeParameters", id: "head", values: { headWidth: .04, foreheadWidth: .06, crownFlatten: .04 } }],
    allowed: { parameters: { head: Object.keys(parameters) }, followers }, protectedVertices,
    protectedIds: ["body", "foot_left", "foot_right", "wing_left", "wing_right"],
    file: resolve(out, "authored.json"),
  });
  assert.ok(candidate.ok, JSON.stringify({ scope: candidate.scope, relations: candidate.relations, error: candidate.error }));
  await ws.compare({ baseline, candidate, file: resolve(out, "comparison.html"),
    views: Object.fromEntries(["front", "left", "back", "top", "perspective"].map(view =>
      [view, { view, size: 512, ids: ["head_pose"] }])) });
  await ws.accept(candidate);
  const current = await ws.call("getProject");
  const bindings = current.nodes.filter(n => n.attachment).map(n => {
    const a = n.attachment, target = current.nodes.find(t => t.id === a.target);
    const points = a.vertices.map(i => point(worldMatrix(current, target.id), target.mesh.vertices[i]));
    const expected = [0, 1, 2].map(k => points.reduce((s, v, i) => s + v[k] * a.weights[i], 0));
    const actual = point(worldMatrix(current, n.id), a.anchor);
    const error = Math.hypot(...actual.map((v, i) => v - expected[i]));
    assert.ok(error < 1e-8); return { id: n.id, anchorErrorMeters: error };
  });
  const poses = [];
  for (const clip of current.character.clips) for (const fraction of [0, .25, .5, .75, 1]) {
    const pose = await ws.candidate({ commands: [{ op: "characterPose", name: clip.name, time: clip.duration * fraction }] });
    poses.push({ clip: clip.name, time: clip.duration * fraction, ok: pose.ok, relations: pose.relations });
  }
  await writeFile(resolve(out, "poses.json"), JSON.stringify(poses, null, 2));
  assert.ok(poses.every(p => p.ok), "Inspect sampled relation failures in poses.json");
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  await ws.exportGLB({ file: resolve(out, "duck.glb") });
  const roundtrip = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(roundtrip.editable.scope.changed, []);
  await writeFile(resolve(out, "acceptance.json"), JSON.stringify({
    parameterChanges: candidate.scope.parameterChanges, protectedVertices, bindings,
    sampledPoses: poses.length, editableRoundtrip: true, continuousTimeChecked: false,
  }, null, 2));
  return { outputs: out, bindings: bindings.length, sampledPoses: poses.length };
}
