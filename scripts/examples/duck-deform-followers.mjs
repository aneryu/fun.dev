import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { worldMatrix, point } from "../../site/workshop/spatial.js";

export default async function(ws) {
  const out = resolve("test-results/duck-deform-followers"); await mkdir(out, { recursive: true });
  const { project } = JSON.parse(await readFile("test-results/duck-reference-history/authored.json", "utf8"));
  const initial = await ws.candidate({ project }); assert.ok(initial.ok); await ws.accept(initial);
  const crowns = project.nodes.filter(n => n.id.startsWith("crown_"));
  await ws.apply(crowns.map(n => {
    const base = n.mesh.vertices.reduce((a, b) => a[1] < b[1] ? a : b);
    return { op: "attachSurface", id: n.id, targetId: "head", mode: "deform", at: point(worldMatrix(project, n.id), base) };
  }));
  const baseline = await ws.candidate();
  const candidate = await ws.candidate({ commands: [{ op: "recipeParameters", id: "head",
    values: { headWidth: .06, foreheadWidth: .1, crownFlatten: .08 } }],
    allowed: { parameters: { head: ["headWidth", "foreheadWidth", "crownFlatten"] },
      followers: ["crown_1", "crown_2", "crown_3", "eye_left", "eye_right", "eye_highlight_left", "eye_highlight_right",
        "mouth_mount", "mouth_fixed_joint", "jaw_joint", "upper_bill", "lower_bill", "mouth_cavity", "tongue", "nostril_left", "nostril_right"] },
    protectedIds: ["body", "foot_left", "foot_right", "wing_left", "wing_right"] });
  assert.ok(candidate.ok, JSON.stringify(candidate.error ?? candidate.scope)); await ws.accept(candidate);
  await ws.compare({ baseline, candidate, file: resolve(out, "comparison.html"), views: {
    front: { view: "front", size: 512, ids: ["head_pose"] }, side: { view: "left", size: 512, ids: ["head_pose"] },
    oblique: { view: "perspective", size: 512, ids: ["head_pose"] },
  } });
  await ws.apply([{ op: "characterClip", name: "head_surface_motion", duration: 1, fps: 12, loop: true,
    tracks: [{ node: "head", channel: "scale", keys: [
      { time: 0, value: [1, 1, 1] }, { time: .5, value: [1.04, .98, 1] }, { time: 1, value: [1, 1, 1] },
    ] }] }]);
  const authored = await ws.candidate({ file: resolve(out, "authored.json") }); assert.ok(authored.ok);
  const posed = await ws.candidate({ commands: [{ op: "characterPose", name: "head_surface_motion", time: .5 }],
    file: resolve(out, "posed.json") });
  assert.ok(posed.ok, JSON.stringify(posed.error ?? posed.relations));
  await ws.compare({ baseline: authored, candidate: posed, file: resolve(out, "motion.html"), views: {
    front: { view: "front", size: 512, ids: ["head_pose"] },
    oblique: { view: "perspective", size: 512, ids: ["head_pose"] },
  } });
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  const roundtrip = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(roundtrip.editable.scope.changed, []);
  return { outputs: out, deformFollowers: crowns.length, editableRoundtrip: true };
}
