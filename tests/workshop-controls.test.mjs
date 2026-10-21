import test from "node:test";
import assert from "node:assert/strict";
import { shapeMesh } from "../site/workshop/deform.js";
import { createStore, emptyProject, evaluateProject } from "../site/workshop/document.js";
import { capabilities, validateSchema } from "../site/workshop/agent-contract.js";

test("compact handles preserve outside vertices and mirror displacements without duplicating central controls", () => {
  const mesh = { vertices: [[-1, 0, 0], [1, 0, 0], [0, 0, 0], [0, -2, 0]], faces: [] };
  shapeMesh(mesh, { op: "controlDeform", mirrorAxis: "x",
    handles: [{ center: [1, 0, 0], radius: .5, delta: [.2, 0, 0] },
      { center: [0, 0, 0], radius: .5, delta: [0, -.1, 0] }] });
  assert.deepEqual(mesh.vertices, [[-1.2, 0, 0], [1.2, 0, 0], [0, -.1, 0], [0, -2, 0]]);
});
test("control points persist as parameterized recipe steps without topology changes or accumulated motion", () => {
  const s = createStore(emptyProject());
  s.apply([{ op: "create", id: "head", kind: "box" }]);
  const base = s.snapshot().nodes[0].mesh;
  const definition = { parameters: { crown: { value: 0, min: 0, max: .2 } },
    generator: { kind: "mesh", mesh: base, material: "yellow" },
    steps: [{ op: "controlDeform", mirrorAxis: "x", handles: [
      { center: [.5, .5, .5], radius: .8, delta: [0, { $param: "crown", factor: -1 }, 0] },
    ] }] };
  validateSchema({ op: "recipe", id: "head", definition }, capabilities({ command: "recipe" }).schema);
  s.apply([{ op: "recipe", id: "head", definition }]);
  s.apply([{ op: "recipeParameters", id: "head", values: { crown: .1 } }]);
  const changed = s.snapshot();
  assert.deepEqual(changed.nodes[0].mesh.faces, base.faces);
  assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(changed))), changed);
  s.apply([{ op: "recipeParameters", id: "head", values: { crown: 0 } }]);
  assert.deepEqual(s.snapshot().nodes[0].mesh.vertices, base.vertices);
  s.undo(); assert.deepEqual(s.snapshot(), changed);
});
