import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { compareSourceValues } from "../../site/workshop/export-integrity.js";

export default async function(ws) {
  const out = resolve("test-results/duck-export-integrity"); await mkdir(out, { recursive: true });
  const { project } = JSON.parse(await readFile("test-results/duck-mirror-followers/authored.json", "utf8"));
  const initial = await ws.candidate({ project }); assert.ok(initial.ok); await ws.accept(initial);
  const report = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.equal(report.editable.integrity.exact, true, JSON.stringify(report.editable.integrity));
  const probes = {};
  for (const field of ["character", "relations", "designReferences", "viewPresets"]) {
    assert.ok(project[field]);
    const changed = structuredClone(project); delete changed[field];
    const result = compareSourceValues(project, changed);
    assert.equal(result.status, "failed");
    assert.ok(result.differences.some(d => d.path === `/${field}`));
    probes[field] = result;
  }
  for (const field of ["attachment", "morph", "skin", "joint"]) {
    const index = project.nodes.findIndex(n => n[field]); assert.ok(index >= 0, field);
    const changed = structuredClone(project); delete changed.nodes[index][field];
    const result = compareSourceValues(project, changed);
    assert.equal(result.status, "failed");
    assert.ok(result.differences.some(d => d.path === `/nodes/${index}/${field}`));
    probes[field] = result;
  }
  await writeFile(resolve(out, "loss-probes.json"), JSON.stringify(probes, null, 2));
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  return { outputs: out, exactStoredAndEvaluatedSource: true, detectedMetadataLosses: Object.keys(probes) };
}
