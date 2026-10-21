// Run after duck-boundaries.mjs; all work is in the CLI's isolated local session.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { worldMatrix, point } from "../../site/workshop/spatial.js";

export default async function(ws) {
  const input = JSON.parse(await readFile(process.env.DUCK_PROJECT ?? "test-results/duck-boundaries/thicker.json", "utf8"));
  const out = resolve("test-results/duck-morphs"); await mkdir(out, { recursive: true });
  const initial = await ws.candidate({ project: input.project ?? input });
  assert.ok(initial.ok); await ws.accept(initial);
  const p = await ws.call("getProject");
  const eyeIds = ["eye_left", "eye_right", "eye_highlight_left", "eye_highlight_right"];
  const mouthIds = ["upper_bill", "lower_bill", "mouth_cavity", "tongue", "nostril_left", "nostril_right"];
  const commands = [], affected = [...eyeIds, ...mouthIds];
  for (const id of ["eye_highlight_left", "eye_highlight_right"]) {
    const n = p.nodes.find(n => n.id === id), a = n.attachment;
    commands.push({ op: "attachSurface", id, targetId: a.target, anchor: a.anchor,
      at: point(worldMatrix(p, id), a.anchor), offset: a.offset, mode: "frame" });
  }
  const center = id => {
    const v = p.nodes.find(n => n.id === id).mesh.vertices;
    return [0, 1, 2].map(k => v.reduce((sum, v) => sum + v[k], 0) / v.length);
  };
  for (const id of affected) {
    const n = p.nodes.find(n => n.id === id), eye = eyeIds.includes(id);
    const pivot = center(id);
    const maxX = Math.max(...n.mesh.vertices.map(v => Math.abs(v[0])));
    for (const name of ["blink", "smile", "surprise"]) {
      const changes = n.mesh.vertices.map((v, index) => {
        let position = [...v];
        if (eye) {
          if (name === "blink") position[1] = pivot[1] + (v[1] - pivot[1]) * 0.15;
          // Closed eyelids suppress the highlight instead of leaving a bright
          // strip on the compressed eye. Keep a nonzero target volume.
          if (name === "blink" && id.includes("highlight"))
            position = v.map((x, k) => n.attachment.anchor[k] + (x - n.attachment.anchor[k]) * 0.03);
          if (name === "smile") position[1] = pivot[1] + (v[1] - pivot[1]) * 0.85;
          if (name === "surprise") {
            position[0] = pivot[0] + (v[0] - pivot[0]) * 1.08;
            position[1] = pivot[1] + (v[1] - pivot[1]) * 1.15;
          }
        } else {
          if (name === "smile") position[1] += 0.025 * (Math.abs(v[0]) / maxX) ** 2;
          if (name === "surprise" && ["lower_bill", "mouth_cavity", "tongue"].includes(id))
            position[1] -= 0.025 * (1 - (Math.abs(v[0]) / maxX) ** 2);
        }
        return { index, position };
      });
      commands.push({ op: "morphTarget", id, name, changes });
    }
  }
  const authored = await ws.candidate({ commands, allowed: { nodes: affected }, file: resolve(out, "authored.json") });
  assert.ok(authored.ok, JSON.stringify(authored.error ?? authored.validation)); await ws.accept(authored);
  const neutral = await ws.call("getProject"), reports = [];
  for (const [name, values] of Object.entries({
    blink: { blink: 1 }, smile: { smile: 1 }, surprise: { surprise: 1 },
    combination: { blink: 0.5, smile: 0.5 },
  })) {
    const baseline = await ws.candidate({ project: neutral });
    const candidate = await ws.candidate({ project: neutral,
      commands: affected.map(id => ({ op: "morphWeights", id, values })),
      allowed: { nodes: affected }, file: resolve(out, `${name}.json`) });
    assert.ok(candidate.ok, `${name}: ${JSON.stringify(candidate.error ?? candidate.validation)}`);
    await ws.compare({ baseline, candidate, file: resolve(out, `${name}.html`), views: {
      front: { view: "front", size: 512 }, side: { view: "left", size: 512 },
      oblique: { view: "perspective", size: 512 },
    } });
    reports.push({ name, values, validation: candidate.validation });
  }
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  await ws.exportGLB({ file: resolve(out, "duck.glb") });
  const roundtrip = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(roundtrip.editable.scope.changed, []);
  assert.equal(roundtrip.generic.nodes.filter(n => n.morph).length, affected.length);
  await writeFile(resolve(out, "acceptance.json"), JSON.stringify({ expressions: reports, authoredTargets: affected.length * 3,
    editableRoundtrip: true, genericMorphNodes: affected.length,
    limitations: ["Inter-object penetration and continuous attachment contact require additional relation checks.",
      "Runtime playback and coordinated expression controls are verified separately from target authoring."] }, null, 2));
  return { outputs: out, expressions: reports.length, targets: affected.length * 3 };
}
