// Run locally, not against someone's connected draft:
// DUCK_STUDY_ROOT=/absolute/path/to/outputs node scripts/editor-agent.mjs --run scripts/examples/duck-workflow.mjs
// Inputs are read-only. All output goes to test-results/duck-workflow.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export default async function (ws) {
  const root = process.env.DUCK_STUDY_ROOT;
  if (!root) throw new Error("Set DUCK_STUDY_ROOT to the directory containing duck-study-v7 and duck-study-v8");
  const out = resolve("test-results/duck-workflow");
  await mkdir(out, { recursive: true });
  const save = async (name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2));
  const read = async version => JSON.parse(await readFile(resolve(root, `duck-study-${version}/duck.project.json`), "utf8"));
  const v7 = await read("v7"), v8 = await read("v8");
  const provenance = async version => ({
    parameterVersion: version,
    source: `duck-study-${version}/duck.mjs`,
    sourceHash: createHash("sha256").update(await readFile(resolve(root, `duck-study-${version}/duck.mjs`))).digest("hex"),
    parameters: JSON.parse(await readFile(resolve(root, `duck-study-${version}/parameters.json`), "utf8")),
  });
  const initial = await ws.candidate({ project: v7 });
  assert.equal(initial.ok, true);
  await ws.accept(initial, { operationId: "duck-baseline" });
  await ws.call("checkpoint", { name: "Duck v7 baseline", ifRevision: (await ws.inspect()).revision });
  const protectedIds = ["head", "body", "wing_right", "wing_left", "foot_right", "foot_left", "leg_left", "leg_right", "tail", "crown_1", "crown_2", "crown_3"];
  const baseline = await ws.candidate({ provenance: await provenance("v7") });
  const candidate = await ws.candidate({ project: v8, protectedIds, provenance: await provenance("v8"), file: resolve(out, "candidate.json") });
  assert.equal(candidate.ok, true);
  const current = await ws.call("getProject"), revision = (await ws.inspect()).revision;
  const bad = structuredClone(v8);
  bad.nodes.find(n => n.id === "mouth_cavity").mesh.vertices[14][2] += 0.5;
  const rejected = await ws.candidate({ project: bad, size: 512, file: resolve(out, "rejected.json") });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.diagnostics.some(i => i.code === "self-intersection"));
  assert.deepEqual(await ws.call("getProject"), current);
  assert.equal((await ws.inspect()).revision, revision);
  // Three candidates are retained; baseline, proposed v8, and rejected mouth remain available.
  const worldPoint = async (c, id, index) => {
    const result = await ws.call("workflow", { action: "inspect", candidateId: c.candidateId, ifRevision: revision, detail: "full" });
    const p = result.project;
    // Query uses the existing inspector's world matrix on the baseline. The duck's protected
    // head_pose is identical in both versions; no platform-specific duck parameters are added.
    const node = p.nodes.find(n => n.id === id), local = node.mesh.vertices[index];
    const info = await ws.inspect({ id });
    const m = info.worldMatrix;
    return [0, 1, 2].map(k => m[k] * local[0] + m[k + 4] * local[1] + m[k + 8] * local[2] + m[k + 12]);
  };
  const contacts = {};
  for (const [label, c] of [["v7", baseline], ["v8", candidate]]) {
    const path = [];
    // The outside mouth-corner rim, including every edge between these stations.
    // The inner lip is intentionally open and is not a declared upper-bill join.
    for (const i of [55, 66, 77, 0]) path.push(await worldPoint(c, "lower_bill", i));
    contacts[label] = await ws.surface({ ids: ["upper_bill"], path, spacing: 0.003, tolerance: 0.01 }, { candidateId: c.candidateId });
  }
  await save("corner-contact.json", contacts);
  assert.ok(contacts.v7.gaps > 0);
  assert.equal(contacts.v8.gaps, 0);
  // Real eye and tongue anchors: record the target surface and a normal-based translation.
  // The proposals are measurements; the accepted authored model is not silently adjusted.
  const fittings = [];
  for (const [id, target, index, offset] of [["eye_right", "head", 0, -0.002], ["tongue", "mouth_cavity", 12, -0.001]]) {
    const at = await worldPoint(candidate, id, index);
    const hit = await ws.surface({ ids: [target], at, offset }, { candidateId: candidate.candidateId });
    const after = await ws.surface({ ids: [target], at: hit.offsetPoint }, { candidateId: candidate.candidateId });
    assert.ok(after.distance <= Math.abs(offset) + 1e-8);
    fittings.push({ id, target, at, hit, translation: hit.offsetPoint.map((v, i) => v - at[i]), resample: after,
      applied: false });
  }
  await save("normal-fit.json", fittings);
  const views = {
    front: { view: "front", size: 512 },
    side: { view: "left", size: 512 },
    oblique: { view: "perspective", size: 512 },
    eye: { view: "front", ids: ["head", "eye_right", "eye_left"], size: 512,
      camera: { position: [0, 2.55, 6], target: [0, 2.55, 0.85], projection: "orthographic", height: 1.4 } },
    mouth: { view: "left", ids: ["head", "upper_bill", "lower_bill", "mouth_cavity", "tongue"], size: 512,
      camera: { position: [-5, 2.15, 1.1], target: [0, 2.15, 1.1], projection: "orthographic", height: 0.8 } },
    clay: { view: "perspective", size: 512, shading: "clay" },
    silhouette: { view: "front", size: 512, shading: "silhouette" },
  };
  const comparison = await ws.compare({ baseline, candidate, views,
    reference: resolve(root, "duck-reference-comparison-v1/02-mouth-neutral-turnaround.png"),
    file: resolve(out, "comparison.html") });
  const shot = comparison.records.find(r => r.name === "mouth" && r.label === "candidate");
  const pixel = await ws.surface({ observation: shot, pixel: [256, 256] }, { candidateId: candidate.candidateId });
  await save("pixel-hit.json", pixel);
  const accepted = await ws.accept(candidate, { operationId: "duck-v8" });
  await save("scope.json", accepted);
  const acceptedProject = await ws.call("getProject");
  for (const fitting of fittings) {
    await ws.fit({ id: fitting.id, at: fitting.at, targets: [fitting.target], offset: fitting.id === "eye_right" ? -0.002 : -0.001 });
    const moved = await ws.inspect({ id: fitting.id, detail: "full" });
    const anchorIndex = fitting.id === "eye_right" ? 0 : 12;
    const local = moved.node.mesh.vertices[anchorIndex], m = moved.worldMatrix;
    const at = [0, 1, 2].map(k => m[k] * local[0] + m[k + 4] * local[1] + m[k + 8] * local[2] + m[k + 12]);
    fitting.actualResample = await ws.surface({ ids: [fitting.target], at });
    assert.ok(fitting.actualResample.distance <= (fitting.id === "eye_right" ? 0.002 : 0.001) + 1e-8);
    fitting.applied = true;
    await ws.undo();
    fitting.restored = true;
    assert.deepEqual(await ws.call("getProject"), acceptedProject);
  }
  await save("normal-fit.json", fittings);
  await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  await ws.validate({ detail: "full", file: resolve(out, "validation.json") });
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  await ws.exportGLB({ file: resolve(out, "duck.glb") });
  await save("acceptance.json", { failedCandidatePreservedDraft: true, protectedScope: accepted.scope,
    contacts: Object.fromEntries(Object.entries(contacts).map(([name, r]) => [name, { samples: r.samples.length, maxDistance: r.maxDistance, gaps: r.gaps }])),
    comparison: comparison.file, fits: fittings, pixel });
  return { comparison: comparison.file, revision: (await ws.inspect()).revision, protectedScope: accepted.scope.ok };
}
