import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
export default async function(ws) {
  const out = resolve("test-results/duck-view-presets"); await mkdir(out, { recursive: true });
  const { project } = JSON.parse(await readFile("test-results/duck-deform-followers/authored.json", "utf8"));
  const initial = await ws.candidate({ project }); assert.ok(initial.ok); await ws.accept(initial);
  for (const view of ["front", "left", "back", "top", "perspective"])
    await ws.saveView(`character-${view}`, { view, size: 384, height: 384, ids: ["duck"] });
  for (const [id, ids, context] of [
    ["eyes", ["eye_left", "eye_right", "eye_highlight_left", "eye_highlight_right"], ["head"]],
    ["mouth", ["upper_bill", "lower_bill", "mouth_cavity", "tongue"], ["head", "nostril_left", "nostril_right"]],
    ["feet", ["foot_left", "foot_right"], ["leg_left", "leg_right"]],
  ]) {
    const definition = await ws.saveView(id, { view: "front", size: 512, height: 384, ids });
    await ws.apply([{ op: "viewPreset", id, definition: { ...definition, ids: [...ids, ...context] } }]);
  }
  const baseline = await ws.candidate({ file: resolve(out, "authored.json") });
  const candidate = await ws.candidate({ commands: [{ op: "recipeParameters", id: "head",
    values: { headWidth: .065, foreheadWidth: .11 } }] });
  assert.ok(candidate.ok, JSON.stringify(candidate.error ?? candidate.relations));
  const result = await ws.compare({ baseline, candidate, file: resolve(out, "comparison.html"),
    views: Object.fromEntries(["eyes", "mouth", "feet", "character-perspective"].map(preset => [preset, { preset }])) });
  for (const preset of ["eyes", "mouth", "feet"]) {
    const shots = result.records.filter(r => r.name === preset);
    assert.equal(shots.length, 2);
    assert.equal(shots[0].height, 384);
    assert.deepEqual(shots[0].camera, shots[1].camera);
    assert.deepEqual(shots[0].quality, shots[1].quality);
    assert.equal(shots[0].viewPreset.id, preset);
  }
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  const roundtrip = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(roundtrip.editable.scope.changed, []);
  assert.deepEqual(roundtrip.editable.scope.fields, []);
  return { outputs: out, presets: 8, fixedLocalFraming: true, editableRoundtrip: true };
}
