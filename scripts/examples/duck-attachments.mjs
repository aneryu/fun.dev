// DUCK_PROJECT=/path/to/duck.project.json node scripts/editor-agent.mjs --run scripts/examples/duck-attachments.mjs
// Uses an isolated CLI session, never a connected authoring draft.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { worldMatrix, point, inverse } from "../../site/workshop/spatial.js";

export default async function(ws) {
  const input = JSON.parse(await readFile(process.env.DUCK_PROJECT ?? "test-results/duck-workflow/candidate.json", "utf8"));
  const out = resolve("test-results/duck-attachments");
  await mkdir(out, { recursive: true });
  const start = await ws.candidate({ project: input.project ?? input });
  assert.equal(start.ok, true); await ws.accept(start);
  const mouth = ["upper_bill", "lower_bill", "mouth_cavity", "tongue", "nostril_right", "nostril_left"];
  await ws.apply([{ op: "group", ids: mouth, newId: "mouth_mount" },
    { op: "set", id: "mouth_mount", parent: "head_pose", keepWorld: true }]);
  const p = await ws.call("getProject");
  const commands = [];
  for (const [id, targetId] of [
    ["eye_right", "head"], ["eye_left", "head"],
    ["eye_highlight_right", "eye_right"], ["eye_highlight_left", "eye_left"],
    ["mouth_mount", "head"],
  ]) {
    const node = p.nodes.find(n => n.id === id);
    const center = node.mesh
      ? [0, 1, 2].map(k => node.mesh.vertices.reduce((s, v) => s + v[k], 0) / node.mesh.vertices.length)
      : [0, 0, 0];
    const hit = await ws.surface({ ids: [targetId], at: point(worldMatrix(p, id), center) });
    // Bind the authored location without changing its silhouette. A material
    // point is chosen explicitly; no automatic re-projection occurs afterwards.
    commands.push({ op: "attachSurface", id, targetId, at: hit.point,
      anchor: point(inverse(worldMatrix(p, id)), hit.point), mode: "position" });
  }
  await ws.apply(commands);
  const baseline = await ws.candidate();
  const shaped = await ws.call("getProject");
  const head = shaped.nodes.find(n => n.id === "head");
  const ys = head.mesh.vertices.map(v => v[1]), low = Math.min(...ys), high = Math.max(...ys);
  head.mesh.vertices = head.mesh.vertices.map(([x, y, z]) => {
    const forehead = Math.max(0, (y - low) / (high - low) - 0.45) / 0.55;
    return [x * (1.08 + 0.12 * forehead), y - 0.025 * forehead * forehead, z];
  });
  const followers = ["eye_right", "eye_left", "eye_highlight_right", "eye_highlight_left", "mouth_mount", ...mouth];
  const candidate = await ws.candidate({ project: shaped,
    allowed: { nodes: ["head"], followers }, protectedIds: ["body", "foot_left", "foot_right", "wing_left", "wing_right"],
    provenance: { study: "head-width-and-forehead", input: process.env.DUCK_PROJECT ?? "duck-workflow/candidate.json" },
    file: resolve(out, "candidate.json") });
  assert.equal(candidate.ok, true, JSON.stringify(candidate.scope));
  const comparison = await ws.compare({ baseline, candidate, file: resolve(out, "comparison.html"),
    views: Object.fromEntries(["front", "left", "back", "top", "perspective"].map(view => [view, { view, size: 512 }])) });
  await ws.accept(candidate);
  const current = await ws.call("getProject");
  const bindings = current.nodes.filter(n => n.attachment).map(n => {
    const a = n.attachment, target = current.nodes.find(t => t.id === a.target);
    const points = a.vertices.map(i => point(worldMatrix(current, target.id), target.mesh.vertices[i]));
    const expected = [0, 1, 2].map(k => points.reduce((s, v, i) => s + v[k] * a.weights[i], 0));
    const actual = point(worldMatrix(current, n.id), a.anchor);
    const error = Math.hypot(...actual.map((v, i) => v - expected[i]));
    assert.ok(error < 1e-8);
    return { id: n.id, target: a.target, anchorErrorMeters: error, binding: a };
  });
  const roundtrip = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.equal(roundtrip.editable.scope.changed.length, 0);
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  await ws.exportGLB({ file: resolve(out, "duck.glb") });
  await writeFile(resolve(out, "acceptance.json"), JSON.stringify({ bindings, comparison: comparison.file,
    validation: await ws.validate({ detail: "full" }), limitations: [
      "Material-point position following only in this duck study; orientation mode is tested separately.",
      "Rigid mouth assembly; this does not test beak opening, thickness or animation.",
      "Anchor equality does not prove continuous surface contact of a rigid part on a changing curved surface.",
    ] }, null, 2));
  return { comparison: comparison.file, bindings: bindings.length, editableRoundtrip: true };
}
