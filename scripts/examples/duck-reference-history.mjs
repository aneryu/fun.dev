// Uses real model renders as explicitly labelled study references; it does not
// claim that the user approved those rendered shapes.
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
export default async function(ws) {
  const out = resolve("test-results/duck-reference-history"); await mkdir(out, { recursive: true });
  const { project } = JSON.parse(await readFile("test-results/duck-mouth-close/authored.json", "utf8"));
  const comparison = JSON.parse(await readFile("test-results/duck-mouth-close/comparison.html.json", "utf8"));
  const image = async label => `data:image/png;base64,${(await readFile(comparison.records.find(r => r.name === "front" && r.label === label).file)).toString("base64")}`;
  const initial = await ws.candidate({ project }); assert.ok(initial.ok); await ws.accept(initial);
  await ws.apply([
    { op: "referenceRecord", definition: { id: "duck-front-v1", kind: "image", text: "张嘴模型渲染；不是用户确认的参考图", origin: "render", image: await image("baseline") } },
    { op: "referenceRecord", definition: { id: "duck-front-v2", kind: "image", text: "闭嘴模型渲染；待评估的版本", origin: "render", image: await image("candidate"),
      supersedes: "duck-front-v1", reason: "记录同一相机下的另一种表情，不自动改变采用版本" } },
    { op: "referenceSelect", ids: ["duck-front-v1"] },
    { op: "referenceRecord", definition: { id: "head-direction", kind: "feature", status: "accepted",
      text: "目标方向：头部回正、扁梨型，额头加宽、头顶压平、脸颊保留、下巴变圆；这不表示当前模型已获认可。",
      references: [], evidence: "本任务用户原文列明了这些造型要求；记录的是要求，不是视觉验收。" } },
    { op: "referenceRecord", definition: { id: "closed-mouth-study", kind: "feature", status: "proposed",
      text: "当前闭嘴形态作为待评估方案保留。", references: ["duck-front-v2"] } },
    { op: "referenceRecord", definition: { id: "perspective-choice", kind: "decision",
      text: "表情与透视差异不按像素强行一致；固定相机比较轮廓，嘴角与厚度另用几何检查。",
      references: ["duck-front-v1", "duck-front-v2"] } },
  ]);
  const baseline = await ws.candidate({ file: resolve(out, "authored.json") });
  const candidate = await ws.candidate({ commands: [{ op: "characterPose", name: "mouth_close", time: .5 }] });
  assert.ok(candidate.ok);
  const report = await ws.compare({ baseline, candidate, file: resolve(out, "comparison.html"), views: {
    front: { view: "front", ids: ["head_pose"], size: 512 },
    side: { view: "left", ids: ["head_pose"], size: 512 },
    oblique: { view: "perspective", ids: ["head_pose"], size: 512 },
  } });
  assert.ok(report.records.every(r => r.designReferences.selected[0] === "duck-front-v1"));
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  const roundtrip = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(roundtrip.editable.scope.changed, []);
  assert.equal(roundtrip.editable.scope.fields.length, 0);
  return { outputs: out, preservedDirection: true, adoptedVersion: "duck-front-v1", editableRoundtrip: true };
}
