import test from "node:test";
import assert from "node:assert/strict";
import { boundarySurface } from "../site/workshop/boundary-surface.js";
import { createStore, emptyProject, evaluateProject } from "../site/workshop/document.js";
import { capabilities, validateSchema } from "../site/workshop/agent-contract.js";
const curves = [
  [[-1, 0, 0], [0, 0.2, 0], [1, 0, 0]],
  [[-1, 0, 1], [0, 0.4, 1], [1, 0, 1]],
];
test("boundary samples remain exact with predictable triangular topology", () => {
  const mesh = boundarySurface({ curves, spans: 3, bulge: 0.1 }, "yellow");
  assert.deepEqual(mesh.vertices.slice(0, 3), curves[0]);
  assert.deepEqual(mesh.vertices.slice(-3), curves[1]);
  assert.equal(mesh.vertices.length, 12);
  assert.equal(mesh.faces.length, 12);
  assert.deepEqual(boundarySurface({ curves, flip: true }, "yellow").faces[0].vertices, [4, 1, 0]);
});
test("explicit correspondence, shared corners and arc sampling", () => {
  const corners = [curves[0], [[-1, 0, 0], [0, 0, 1], [1, 0, 0]]];
  const mesh = boundarySurface({ curves: corners }, "yellow");
  assert.equal(mesh.vertices.length, 4);
  assert.equal(mesh.faces.length, 2);
  const arc = boundarySurface({ curves, samples: 9, sampling: "arc" }, "yellow");
  assert.equal(arc.vertices.length, 18);
  assert.throws(() => boundarySurface({ curves: [curves[0], curves[0]] }, "yellow"), /no surface/);
});
test("Hermite rows interpolate endpoints, reject malformed tangent constraints", () => {
  const tangent = Array.from({ length: 3 }, () => [0, 1, 1]);
  const mesh = boundarySurface({ curves, spans: 4, tangents: [tangent, tangent] }, "yellow");
  assert.deepEqual(mesh.vertices.slice(0, 3), curves[0]);
  assert.deepEqual(mesh.vertices.slice(-3), curves[1]);
  assert.throws(() => boundarySurface({ curves, tangents: [tangent] }, "yellow"), /one row/);
});
test("closed sections and end caps produce a closed shell", () => {
  const s = createStore(emptyProject());
  const box = [
    [[-1,-1,-1],[1,-1,-1]], [[-1,1,-1],[1,1,-1]],
    [[-1,1,1],[1,1,1]], [[-1,-1,1],[1,-1,1]],
  ];
  s.apply([{ op: "create", id: "shell", kind: "boundarySurface",
    options: { curves: box, closedSections: true, caps: true } }]);
  const mesh = s.snapshot().nodes[0].mesh;
  const edges = new Map();
  for (const face of mesh.faces) face.vertices.forEach((a, i) => {
    const b = face.vertices[(i+1)%3], key = [a,b].sort((a,b)=>a-b).join(":");
    edges.set(key, (edges.get(key) ?? 0) + 1);
  });
  assert.ok([...edges.values()].every(count => count === 2));
  assert.throws(() => boundarySurface({ curves, caps: true }, "yellow"), /closedSections/);
});
test("recipe parameters, shell thickness, undo and reload share normal evaluator", () => {
  const s = createStore(emptyProject());
  s.apply([{ op: "create", id: "bill", kind: "boundarySurface", options: { curves } }]);
  const definition = { parameters: { thickness: { value: 0.02, min: 0.005, max: 0.06 } },
    generator: { kind: "boundarySurface", options: { curves, spans: 2 }, material: "yellow" },
    steps: [{ op: "solidify", thickness: { $param: "thickness" } }] };
  validateSchema({ op: "recipe", id: "bill", definition }, capabilities({ command: "recipe" }).schema);
  s.apply([{ op: "recipe", id: "bill", definition }]);
  const before = s.snapshot();
  s.apply([{ op: "recipeParameters", id: "bill", values: { thickness: 0.03 } }]);
  assert.deepEqual(evaluateProject(JSON.parse(JSON.stringify(s.snapshot()))), s.snapshot());
  s.undo(); assert.deepEqual(s.snapshot(), before);
});
