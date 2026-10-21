import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

export default async function(ws) {
  const input = JSON.parse(await readFile("test-results/duck-relations-verified/authored.json", "utf8"));
  const out = resolve("test-results/duck-parameter-scope"); await mkdir(out, { recursive: true });
  const initial = await ws.candidate({ project: input.project }); assert.ok(initial.ok); await ws.accept(initial);
  const baseline = await ws.candidate();
  const allowed = { parameters: { upper_bill: ["extraThickness"] } };
  const protectedVertices = { upper_bill: [0, 6, 12, 26, 32, 38, 52, 58, 64] };
  const candidate = await ws.candidate({
    commands: [{ op: "recipeParameters", id: "upper_bill", values: { extraThickness: .025 } }],
    allowed, protectedVertices, protectedIds: ["head", "body", "lower_bill", "foot_left", "foot_right"],
    file: resolve(out, "authored.json"),
  });
  assert.ok(candidate.ok, JSON.stringify(candidate.scope));
  assert.deepEqual(candidate.scope.parameterChanges, [{ node: "upper_bill", parameter: "extraThickness", before: .02, after: .025 }]);
  await ws.compare({ baseline, candidate, file: resolve(out, "comparison.html"), views: {
    front: { view: "front", size: 512, ids: ["upper_bill", "lower_bill"] },
    side: { view: "left", size: 512, ids: ["upper_bill", "lower_bill"] },
    oblique: { view: "perspective", size: 512, ids: ["upper_bill", "lower_bill"] },
  } });
  const denied = await ws.candidate({
    commands: [{ op: "recipeParameters", id: "upper_bill", values: { extraThickness: .025 } },
      { op: "set", id: "upper_bill", name: "Unapproved metadata" }],
    allowed, protectedVertices, file: resolve(out, "denied.json"),
  });
  assert.equal(denied.ok, false);
  assert.ok(denied.scope.scopeIssues.some(i => i.code === "scope-parameter-output"));
  await ws.accept(candidate);
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  const roundtrip = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(roundtrip.editable.scope.changed, []);
  await writeFile(resolve(out, "acceptance.json"), JSON.stringify({
    allowed, protectedVertices, actualChanges: candidate.scope.parameterChanges,
    scopePassed: candidate.scope.ok, relationChecksPassed: candidate.relations.ok,
    unauthorizedMetadataRejected: true, editableRoundtrip: true,
  }, null, 2));
  return { outputs: out, parameterOnly: true, protectedVertices: 9 };
}
