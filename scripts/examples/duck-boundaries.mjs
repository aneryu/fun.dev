// Re-express the authored v8 beak as persistent boundary-section recipes.
// DUCK_PROJECT=/path/to/duck.project.json node scripts/editor-agent.mjs --run scripts/examples/duck-boundaries.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

export default async function(ws) {
  const input = JSON.parse(await readFile(process.env.DUCK_PROJECT ?? "test-results/duck-attachments/candidate.json", "utf8"));
  const out = resolve("test-results/duck-boundaries");
  await mkdir(out, { recursive: true });
  const initial = await ws.candidate({ project: input.project ?? input });
  assert.ok(initial.ok); await ws.accept(initial);
  const project = await ws.call("getProject");
  const commands = [];
  for (const id of ["upper_bill", "lower_bill"]) {
    const node = project.nodes.find(n => n.id === id), upper = id === "upper_bill";
    const rows = upper ? 9 : 8, samples = upper ? 13 : 11;
    assert.equal(node.mesh.vertices.length, rows * samples + 2, "This example requires the v8 study's section layout");
    const curves = Array.from({ length: rows }, (_, row) => Array.from({ length: samples }, (_, i) => {
      const p = node.mesh.vertices[upper ? i * rows + row : row * samples + i];
      const underside = upper ? row === 6 || row === 7 : row >= 5;
      const factor = underside ? -(Math.sin(Math.PI * i / (samples - 1)) ** 2) : 0;
      return [p[0], factor ? { $param: "extraThickness", factor, offset: p[1] } : p[1], p[2]];
    }));
    const warm = upper ? [6 * (samples - 1) * 2, 8 * (samples - 1) * 2] : [20, 60];
    commands.push({ op: "recipe", id, definition: {
      name: "Boundary-section bill", parameters: { extraThickness: { value: 0, min: 0, max: 0.04 } },
      generator: { kind: "boundarySurface", material: upper ? "beak" : "lower_beak",
        options: { curves, samples, spans: 1, closedSections: true, caps: true, flip: upper } },
      steps: [{ op: "paint", faces: Array.from({ length: warm[1] - warm[0] }, (_, i) => `f${warm[0] + i}`), material: "mouth_warm" }],
    } });
  }
  const rebuilt = await ws.candidate({ commands, allowed: { nodes: ["upper_bill", "lower_bill"] }, file: resolve(out, "rebuilt.json") });
  assert.ok(rebuilt.ok, JSON.stringify(rebuilt.error ?? rebuilt.validation));
  const views = {
    front: { view: "front", size: 512, ids: ["head", "mouth_mount"] },
    side: { view: "left", size: 512, ids: ["head", "mouth_mount"] },
    oblique: { view: "perspective", size: 512, ids: ["head", "mouth_mount"] },
  };
  await ws.compare({ baseline: initial, candidate: rebuilt, file: resolve(out, "reconstruction.html"), views });
  await ws.accept(rebuilt);
  const baseline = await ws.candidate();
  const thicker = await ws.candidate({ commands: ["upper_bill", "lower_bill"].map(id => ({
    op: "recipeParameters", id, values: { extraThickness: 0.02 },
  })), allowed: { nodes: ["upper_bill", "lower_bill"] }, file: resolve(out, "thicker.json") });
  assert.ok(thicker.ok, JSON.stringify(thicker.error ?? thicker.validation));
  await ws.compare({ baseline, candidate: thicker, file: resolve(out, "comparison.html"), views });
  await ws.accept(thicker);
  const roundtrip = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(roundtrip.editable.scope.changed, []);
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  await ws.exportGLB({ file: resolve(out, "duck.glb") });
  await writeFile(resolve(out, "acceptance.json"), JSON.stringify({
    validation: await ws.validate({ detail: "full" }), editableRoundtrip: true,
    parameter: { extraThickness: 0.02, units: "local metres", affected: "underside sections, tapering to zero at both corners" },
    limits: ["Not a minimum-wall-thickness proof", "Mouth opening is a separate expression control"],
  }, null, 2));
  return { comparison: resolve(out, "comparison.html"), editableRoundtrip: true };
}
