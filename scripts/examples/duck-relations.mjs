import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { worldMatrix, inverse, point } from "../../site/workshop/spatial.js";

export default async function(ws) {
  const input = JSON.parse(await readFile(process.env.DUCK_PROJECT ?? "test-results/duck-skin/authored.json", "utf8"));
  const out = resolve(process.env.DUCK_RELATION_OUTPUT ?? "test-results/duck-relations-verified"); await mkdir(out, { recursive: true });
  const initial = await ws.candidate({ project: input.project ?? input });
  assert.ok(initial.ok); await ws.accept(initial);
  const p = await ws.call("getProject"), definitions = [];
  for (const side of ["left", "right"]) {
    const eye = p.nodes.find(n => n.id === `eye_${side}`);
    const posterior = eye.mesh.vertices.map((v, i) => ({ z: v[2], i })).sort((a, b) => a.z - b.z).slice(0, 4).map(v => v.i);
    definitions.push({ id: `eye_contact_${side}`, kind: "signedGap", source: eye.id, target: "head",
      vertices: posterior, min: -.08, max: .015 });
  }
  definitions.push({ id: "mouth_corners", kind: "distance", source: "lower_bill", target: "upper_bill",
    vertices: [0, 10], min: 0, max: .04,
    description: "Lower bill first lip-section endpoints meet the upper underside; upper rear caps are embedded in the face, not mouth seams." });
  definitions.push({ id: "bill_wall", kind: "thickness", source: "upper_bill", target: "upper_bill",
    vertices: [55, 58, 61], direction: [0, -1, -.5], min: .015, max: .2,
    description: "Front lip section (row 4, columns 3/6/9 of the saved 9x13 boundary grid), oblique down/back rays enter the rounded lip; vertical rays exit its front silhouette. Excludes the solid crown." });
  await ws.apply(definitions.map(definition => ({ op: "relation", definition })));
  // Use the failed pose's measured normal/point to repair only the buried
  // Blink vertices. Do not widen tolerances or alter the neutral head/eyes.
  const beforeBlink = await ws.candidate({ commands: [{ op: "characterPose", name: "blink", time: .5 }],
    file: resolve(out, "blink-before.json") });
  const corrections = [];
  for (const relation of beforeBlink.relations.results.filter(r => r.id.startsWith("eye_contact_"))) {
    const failed = relation.samples.filter(s => s.status === "failed");
    if (!failed.length) continue;
    const node = p.nodes.find(n => n.id === relation.source);
    const target = node.morph.targets.find(t => t.name === "blink");
    const changes = node.morph.base.map((v, index) => ({
      index, position: v.map((x, k) => x + target.deltas[index][k]),
    }));
    const toLocal = inverse(worldMatrix(p, node.id)), zero = point(toLocal, [0, 0, 0]);
    for (const sample of failed) {
      const desired = Math.max(relation.threshold.min + .01, Math.min(relation.threshold.max - .005, sample.actual));
      const delta = point(toLocal, sample.target.normal.map(v => v * (desired - sample.actual))).map((v, k) => v - zero[k]);
      changes[sample.vertex].position = changes[sample.vertex].position.map((v, k) => v + delta[k]);
    }
    corrections.push({ op: "morphTarget", id: node.id, name: "blink", changes });
  }
  if (corrections.length) {
    const repair = await ws.candidate({ commands: corrections,
      allowed: { nodes: corrections.map(c => c.id), followers: ["eye_highlight_left", "eye_highlight_right"] } });
    assert.ok(repair.ok, JSON.stringify(repair.error ?? repair.relations)); await ws.accept(repair);
    const afterBlink = await ws.candidate({ commands: [{ op: "characterPose", name: "blink", time: .5 }],
      file: resolve(out, "blink-after.json") });
    assert.ok(afterBlink.ok, JSON.stringify(afterBlink.relations));
    await ws.compare({ baseline: beforeBlink, candidate: afterBlink, file: resolve(out, "blink-repair.html"),
      views: { front: { view: "front", size: 512, ids: ["head_pose"] },
        side: { view: "left", size: 512, ids: ["head_pose"] },
        oblique: { view: "perspective", size: 512, ids: ["head_pose"] } } });
  }
  const authored = await ws.call("getProject");
  await writeFile(resolve(out, "authored.json"), JSON.stringify({ project: authored }, null, 2));
  const report = await ws.relations();
  await writeFile(resolve(out, "relations.json"), JSON.stringify(report, null, 2));
  const diagnosis = await ws.diagnose({ views: ["front", "left", "perspective"], size: 512 });
  await writeFile(resolve(out, "diagnostics.json"), JSON.stringify(diagnosis, null, 2));
  for (const [i, shot] of diagnosis.observations.entries()) {
    const image = shot.dataUrl ?? shot.image;
    if (typeof image === "string" && image.startsWith("data:image/"))
      await writeFile(resolve(out, `diagnostic-${i}.png`), Buffer.from(image.split(",")[1], "base64"));
  }
  const poses = [];
  for (const clip of authored.character.clips) for (const fraction of [0, .25, .5, .75, 1]) {
    const candidate = await ws.candidate({ commands: [{ op: "characterPose", name: clip.name, time: clip.duration * fraction }] });
    poses.push({ clip: clip.name, time: clip.duration * fraction, ok: candidate.ok, relations: candidate.relations });
  }
  await writeFile(resolve(out, "poses.json"), JSON.stringify({ poses, continuousTimeChecked: false }, null, 2));
  assert.ok(report.ok, "Declared neutral relations failed; inspect relations.json");
  assert.ok(poses.every(p => p.ok), "Sampled clip relations failed; inspect poses.json");
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  await ws.exportGLB({ file: resolve(out, "duck.glb") });
  const roundtrip = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(roundtrip.editable.scope.changed, []);
  return { outputs: out, checks: report.results.map(r => ({ id: r.id, status: r.status })),
    coverage: report.coverage };
}
