import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

export default async function(ws) {
  const out = resolve("test-results/duck-control-scope"); await mkdir(out, { recursive: true });
  const { project } = JSON.parse(await readFile("test-results/duck-mirror-followers/authored.json", "utf8"));
  const initial = await ws.candidate({ project }); assert.ok(initial.ok); await ws.accept(initial);
  const allowed = { characterValues: ["mouthOpen"], followers:
    ["jaw_joint", "lower_bill", "mouth_cavity", "tongue"] };
  const commands = [{ op: "characterValues", values: { mouthOpen: .5 } }];
  const rejected = await ws.candidate({ commands: [...commands,
    { op: "set", id: "tongue", name: "Unapproved tongue edit" }], allowed,
    file: resolve(out, "rejected.json") });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.scope.scopeIssues.some(i => i.code === "scope-parameter-output" && i.node === "tongue"));
  const baseline = await ws.candidate();
  const candidate = await ws.candidate({ commands, allowed,
    protectedIds: ["head", "body", "foot_left", "foot_right", "eye_left", "eye_right"],
    file: resolve(out, "accepted.json") });
  assert.ok(candidate.ok, JSON.stringify(candidate.scope ?? candidate.error));
  await ws.compare({ baseline, candidate, file: resolve(out, "comparison.html"),
    views: Object.fromEntries(["mouth", "character-left", "character-perspective"].map(preset => [preset, { preset }])) });
  await ws.accept(candidate);
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  const roundtrip = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(roundtrip.editable.scope.changed, []);
  assert.deepEqual(roundtrip.editable.scope.fields, []);
  return { outputs: out, granted: ["mouthOpen"], protectedHead: true,
    rejectedFollowerMetadataEdit: true, editableRoundtrip: true };
}
