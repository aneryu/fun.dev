import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

export default async function(ws) {
  const out = resolve("test-results/duck-mirror-followers"); await mkdir(out, { recursive: true });
  const { project } = JSON.parse(await readFile("test-results/duck-view-presets/authored.json", "utf8"));
  const initial = await ws.candidate({ project }); assert.ok(initial.ok); await ws.accept(initial);
  const baseline = await ws.candidate();
  const candidate = await ws.candidate({ commands: [
    { op: "mirrorSurface", id: "eye_left", sourceId: "eye_right", axis: "x", tolerance: .00001 },
    { op: "recipeParameters", id: "head", values: { headWidth: .065, foreheadWidth: .11 } },
  ], protectedIds: ["body", "foot_left", "foot_right", "wing_left", "wing_right"] });
  assert.ok(candidate.ok, JSON.stringify(candidate.error ?? candidate.relations)); await ws.accept(candidate);
  await ws.compare({ baseline, candidate, file: resolve(out, "comparison.html"),
    views: Object.fromEntries(["eyes", "mouth", "character-left", "character-perspective"].map(preset => [preset, { preset }])) });
  const authored = await ws.candidate({ file: resolve(out, "authored.json") }); assert.ok(authored.ok);
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  const roundtrip = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(roundtrip.editable.scope.changed, []);
  assert.deepEqual(roundtrip.editable.scope.fields, []);
  return { outputs: out, mirroredFollower: "eye_left", source: "eye_right", editableRoundtrip: true };
}
