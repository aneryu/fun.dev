import test from "node:test";
import assert from "node:assert/strict";
import {
  createStore,
  emptyProject,
  validateProject,
  measure,
  inspectNode,
  getRecipe,
  recipeInput,
  recipeSelection,
  inspectRecipeStage,
  shapeGenerator,
} from "../site/workshop/document.js";
import { primitive } from "../site/workshop/mesh.js";
import { queryComponents, topologyToken } from "../site/workshop/components.js";
import { hollowBoxRecipe } from "../site/workshop/recipe.js";
import { toolboxAssemblyCommands, assetFor } from "../site/workshop/assembly.js";
import {
  commandsSchema,
  capabilities,
  validateSchema,
} from "../site/workshop/agent-contract.js";
import { describeChanges } from "../site/workshop/changes.js";
import { agentTools, toolInvocation } from "../site/workshop/agent-tools.js";
import { materialUsage, visitMaterials } from "../site/workshop/materials.js";

test("material budget can be reclaimed on empty projects, with atomic history and explicit errors", () => {
  const s = createStore(emptyProject());
  s.apply(
    Array.from({ length: 27 }, (_, i) => ({
      op: "material",
      id: `draft-${i}`,
      color: "#112233",
    })),
  );
  const full = s.snapshot(),
    revision = s.revision;
  assert.throws(
    () => s.apply([{ op: "material", id: "final", color: "#445566" }]),
    (e) =>
      e.code === "material_limit" && e.suggestion.includes("purgeMaterials"),
  );
  assert.equal(s.revision, revision);
  assert.deepEqual(s.snapshot(), full);
  const commands = [
    { op: "purgeMaterials" },
    { op: "material", id: "final", color: "#445566" },
  ];
  validateSchema(commands, commandsSchema);
  const result = s.apply(commands);
  assert.equal(result.removedMaterials.length, 31);
  assert.equal(result.results[0].removedMaterials.length, 31);
  assert.ok(result.materials.includes("draft-26"));
  assert.deepEqual(
    s.snapshot().materials.map((m) => m.id),
    ["yellow", "final"],
  );
  s.undo();
  assert.deepEqual(s.snapshot(), full);
  s.redo();
  s.apply([{ op: "removeMaterial", id: "final" }]);
  assert.throws(
    () => s.apply([{ op: "removeMaterial", id: "yellow" }]),
    /at least one/,
  );
  assert.equal(capabilities().limits.materials, 32);
});

test("unused means no evaluated or dormant material references, including disabled recipe steps", () => {
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "part", name: "blue", kind: "box", material: "orange" },
    {
      op: "recipeStep",
      id: "part",
      action: "append",
      step: { op: "paint", material: "blue", enabled: false, label: "blue" },
    },
    { op: "paint", id: "part", material: "cream" },
  ]);
  const usage = materialUsage(s.snapshot()).find((m) => m.id === "blue");
  assert.deepEqual(usage.users, []);
  assert.deepEqual(usage.retainedBy, ["part"]);
  assert.equal(usage.unused, false);
  assert.throws(
    () => s.apply([{ op: "removeMaterial", id: "blue" }]),
    (e) =>
      e.code === "material_in_use" &&
      e.issues[0].path.includes("steps.0.material"),
  );
  s.apply([{ op: "purgeMaterials" }]);
  assert.deepEqual(
    s.snapshot().materials.map((m) => m.id),
    ["orange", "cream", "blue"],
  );
  const before = s.snapshot(),
    topology = topologyToken(before.nodes[0].mesh);
  const command = { op: "removeMaterial", id: "blue", replacement: "orange" };
  validateSchema([command], commandsSchema);
  s.apply([command]);
  const after = s.snapshot();
  assert.equal(after.nodes[0].name, "blue");
  assert.equal(after.nodes[0].recipe.steps[0].label, "blue");
  assert.equal(after.nodes[0].recipe.steps[0].material, "orange");
  assert.equal(topologyToken(after.nodes[0].mesh), topology);
  const changes = describeChanges(before, after);
  assert.ok(changes.materials.includes("blue"));
  assert.ok(changes.affected.includes("part"));
  assert.ok(
    changes.fields.some((f) => f.path === "materials.blue" && f.after === null),
  );
  const definition = structuredClone(after.nodes[0].recipe);
  delete definition.paint;
  definition.steps[0].enabled = true;
  s.apply([{ op: "recipe", id: "part", definition }]);
  assert.ok(
    s.snapshot().nodes[0].mesh.faces.every((f) => f.material === "orange"),
  );
  assert.deepEqual(
    createStore(JSON.parse(JSON.stringify(s.snapshot()))).snapshot(),
    s.snapshot(),
  );
});

test("material replacement survives source mesh, face bindings, rules, linked copies and rebuilds", () => {
  const s = createStore(emptyProject()),
    mesh = primitive("box", {}, "blue");
  s.apply([
    { op: "create", id: "raw", kind: "mesh", mesh },
    {
      op: "recipeStep",
      id: "raw",
      action: "append",
      step: { op: "bevel", distance: 0.02, enabled: false },
    },
    { op: "paint", id: "raw", faces: ["f0"], material: "blue" },
    { op: "create", id: "ruled", kind: "box", material: "blue" },
    {
      op: "recipe",
      id: "ruled",
      definition: {
        parameters: { width: { value: 1 } },
        generator: {
          kind: "box",
          material: "blue",
          options: { size: [{ $param: "width" }, 1, 1] },
        },
        steps: [],
      },
    },
    {
      op: "recipePaint",
      id: "ruled",
      mode: "rules",
      rules: [
        { name: "blue", material: "blue", select: { normal: [0, 1, 0] } },
      ],
    },
    {
      op: "duplicate",
      id: "ruled",
      newId: "copy",
      linked: true,
      offset: [2, 0, 0],
    },
    { op: "create", id: "primitive", kind: "box", material: "blue" },
    { op: "create", id: "painted", kind: "box" },
    {
      op: "recipeStep",
      id: "painted",
      action: "append",
      step: { op: "bevel", distance: 0.02, enabled: false },
    },
    { op: "paint", id: "painted", material: "blue" },
  ]);
  const before = s.snapshot();
  assert.throws(
    () => s.apply([{ op: "removeMaterial", id: "blue", replacement: "blue" }]),
    /different/,
  );
  assert.throws(
    () =>
      s.apply([{ op: "removeMaterial", id: "blue", replacement: "missing" }]),
    /existing/,
  );
  assert.throws(() =>
    s.apply([
      { op: "removeMaterial", id: "blue", replacement: "ink" },
      { op: "set", id: "missing", name: "failure" },
    ]),
  );
  assert.deepEqual(s.snapshot(), before);
  s.apply([{ op: "removeMaterial", id: "blue", replacement: "ink" }]);
  visitMaterials(s.snapshot(), ({ material }) =>
    assert.notEqual(material, "blue"),
  );
  assert.equal(
    s.snapshot().nodes.find((n) => n.id === "raw").recipe.paint.faces[0]
      .material,
    "ink",
  );
  assert.equal(
    s.snapshot().nodes.find((n) => n.id === "ruled").recipe.paint.rules[0].name,
    "blue",
  );
  s.apply([{ op: "recipeParameters", id: "ruled", values: { width: 1.2 } }]);
  assert.ok(
    s
      .snapshot()
      .nodes.find((n) => n.id === "copy")
      .mesh.faces.every((f) => f.material === "ink"),
  );
  assert.equal(validateProject(s.snapshot()).ok, true);
  assert.deepEqual(
    createStore(JSON.parse(JSON.stringify(s.snapshot()))).snapshot(),
    s.snapshot(),
  );
  const invalid = s.snapshot();
  invalid.nodes
    .find((n) => n.id === "raw")
    .recipe.steps.push({ op: "paint", enabled: false, material: "missing" });
  assert.throws(
    () => createStore(invalid),
    (e) => e.path.endsWith("steps.1.material"),
  );
});

test("scripted colored meshes retain reversible recipe steps through copy and reload", () => {
  const s = createStore(emptyProject()),
    mesh = primitive("box", { size: [0.4, 0.3, 0.2] });
  mesh.faces[0].material = "blue";
  s.apply([{ op: "create", id: "custom", kind: "mesh", mesh }]);
  const base = s.snapshot().nodes[0].mesh;
  s.apply([
    {
      op: "recipeStep",
      id: "custom",
      action: "append",
      step: {
        op: "inset",
        distance: 0.025,
        select: { kind: "faces", normal: [0, 1, 0], space: "local" },
      },
    },
  ]);
  assert.deepEqual(s.snapshot().nodes[0].recipe.generator.mesh, base);
  assert.equal(shapeGenerator(s.snapshot().nodes[0]), null);
  assert.equal(
    inspectNode(s.snapshot(), "custom").node.recipe.generator.mesh,
    undefined,
  );
  assert.equal(
    inspectNode(s.snapshot(), "custom").node.recipe.generator.vertices,
    base.vertices.length,
  );
  assert.deepEqual(recipeInput(s.snapshot(), "custom", 0).nodes[0].mesh, base);
  const before = s.snapshot();
  s.apply([
    {
      op: "recipeStep",
      id: "custom",
      action: "patch",
      index: 0,
      patch: { distance: 0.04 },
    },
  ]);
  assert.deepEqual(
    describeChanges(before, s.snapshot()).fields.find(
      (f) => f.path === "custom.recipe.steps.0.distance",
    ),
    { path: "custom.recipe.steps.0.distance", before: 0.025, after: 0.04 },
  );
  const changed = s.snapshot();
  s.undo();
  assert.deepEqual(s.snapshot(), before);
  s.redo();
  assert.deepEqual(s.snapshot(), changed);
  s.apply([
    { op: "duplicate", id: "custom", newId: "copy", offset: [2, 0, 0] },
  ]);
  const restored = createStore(JSON.parse(JSON.stringify(s.snapshot())));
  assert.deepEqual(restored.snapshot(), s.snapshot());
  restored.apply([
    {
      op: "recipeStep",
      id: "copy",
      action: "patch",
      index: 0,
      patch: { enabled: false },
    },
  ]);
  assert.deepEqual(
    restored.snapshot().nodes.find((n) => n.id === "copy").mesh,
    base,
  );
  assert.deepEqual(
    restored.snapshot().nodes.find((n) => n.id === "custom").mesh,
    changed.nodes[0].mesh,
  );
  const state = restored.snapshot();
  assert.throws(() =>
    restored.apply([
      {
        op: "recipeStep",
        id: "custom",
        action: "patch",
        index: 0,
        patch: { distance: 10 },
      },
    ]),
  );
  assert.deepEqual(restored.snapshot(), state);
  assert.equal(validateProject(state).ok, true);
});

test("compact MCP discovery retains complete on-demand schemas and strict execution validation", async () => {
  // Nested tool schemas and command schemas are discoverable on demand.
  assert.ok(JSON.stringify(agentTools).length < 25000);
  assert.ok(JSON.stringify(capabilities({ detail: "summary" })).length < 5000);
  for (const command of capabilities({ detail: "summary" }).commands) {
    const result = capabilities({ command });
    assert.equal(result.schema.properties.op.const, command);
  }
  assert.equal(
    toolInvocation("fun_editor_capabilities").args[0].detail,
    "summary",
  );
  assert.equal(
    agentTools.find(t => t.name === "fun_editor_capabilities").inputSchema.properties.tool.type,
    "string",
  );
  const { openWorkshop } = await import("../scripts/workshop-node.mjs");
  const { executeAgentCall } = await import("../site/workshop/agent-call.js");
  const { scriptApi } = await import("../scripts/editor-script.mjs");
  const session = await openWorkshop({ width: 64, height: 64 });
  try {
    const api = session.api;
    const { ws } = scriptApi(async (name, args) => {
      const r = await executeAgentCall(api, toolInvocation(name, args));
      return { isError: !r.ok, structuredContent: r.ok ? r.result : { error: r.error } };
    }, process.cwd());
    for (const tool of agentTools) {
      const full = await ws.call("capabilities", { tool: tool.name });
      assert.equal(full.tool, tool.name);
      assert.deepEqual(full.schema.required, tool.inputSchema.required);
      assert.deepEqual(Object.keys(full.schema.properties), Object.keys(tool.inputSchema.properties));
    }
    const full = await ws.call("capabilities", { tool: "workflow" });
    assert.equal(full.schema.properties.query.properties.poses.maxItems, 64);
    assert.equal(full.schema.properties.query.additionalProperties, false);
    assert.equal(full.schema.properties.allowed.additionalProperties, false);
    assert.deepEqual(full.schema.properties.render.properties.camera.required, ["position", "target"]);
    validateSchema({ action: "prepare", ifRevision: 0,
      commands: [{ op: "create", id: "x", kind: "box" }] }, full.schema);
    full.schema.properties.query.additionalProperties = true;
    assert.equal(api.capabilities({ tool: "workflow" }).schema.properties.query.additionalProperties, false);
    assert.deepEqual(api.capabilities(), capabilities());
    assert.deepEqual(await ws.call("capabilities", { command: "recipe" }), capabilities({ command: "recipe" }));
    assert.throws(() => api.capabilities({ tool: 42 }), e => e.code === "schema" && e.path === "tool");
    assert.throws(() => api.capabilities({ tool: "workflow", command: "recipe" }), /Choose a tool name or a command/);
    const unknown = await executeAgentCall(api, toolInvocation("fun_editor_capabilities", { tool: "missing" }));
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "schema");
    assert.equal(unknown.error.path, "tool");
    assert.match(unknown.error.message, /Unknown tool/);
  } finally { session.dispose(); }
  assert.throws(
    () =>
      toolInvocation("fun_editor_apply", {
        ifRevision: 0,
        commands: [{ op: "create", id: "x", kind: "box", unexpected: true }],
      }),
    /Unknown field/,
  );
  for (const [tool, args] of [
    ["workflow", { action: "prepare", ifRevision: 0, allowed: { unexpected: true } }],
    ["workflow", { action: "verifyRuntime", ifRevision: 0, query: { unexpected: true } }],
    ["workflow", { action: "prepare", ifRevision: 0, render: { camera: { position: [0, 1, 2] } } }],
    ["observe", { camera: { position: [0, 1, 2], target: [0, 0, 0], unexpected: true } }],
    ["recipeStage", { id: "x", index: 0, query: { unexpected: true } }],
  ]) assert.throws(() => toolInvocation(`fun_editor_${tool}`, args), e => e.code === "schema");
  const schema = capabilities({ command: "recipe" }).schema;
  validateSchema(
    {
      op: "recipe",
      id: "x",
      definition: {
        parameters: {},
        generator: { kind: "mesh", mesh: primitive("box") },
        steps: [],
      },
    },
    schema,
  );
});

test("primitive face paint follows dimensions and refuses reassignment after segmentation", () => {
  const s = createStore(emptyProject());
  s.apply([
    {
      op: "create",
      id: "knob",
      kind: "cylinder",
      options: { radius: 0.2, height: 0.15, segments: 8 },
    },
  ]);
  const top = queryComponents(s.snapshot(), {
    id: "knob",
    kind: "faces",
    normal: [0, 1, 0],
  }).items[0].ref;
  s.apply([{ op: "paint", id: "knob", faces: [top], material: "orange" }], {
    strictComponents: true,
  });
  assert.ok(s.snapshot().nodes[0].recipe);
  s.apply([{ op: "parameters", id: "knob", options: { height: 0.2 } }]);
  assert.equal(
    queryComponents(s.snapshot(), {
      id: "knob",
      kind: "faces",
      normal: [0, 1, 0],
    }).items[0].material,
    "orange",
  );
  const before = s.snapshot(),
    revision = s.revision;
  let failure;
  try {
    s.apply([{ op: "parameters", id: "knob", options: { segments: 12 } }]);
  } catch (e) {
    failure = e;
  }
  assert.equal(failure.code, "stale_component");
  assert.deepEqual(s.snapshot(), before);
  assert.equal(s.revision, revision);
  s.apply([
    {
      op: "recipePaint",
      id: "knob",
      mode: "rules",
      rules: [
        { material: "orange", select: { kind: "faces", normal: [0, 1, 0] } },
      ],
    },
    failure.recovery.retry,
  ]);
  const colored = queryComponents(s.snapshot(), {
    id: "knob",
    kind: "faces",
  }).items.filter((f) => f.material === "orange");
  assert.equal(colored.length, 1);
  assert.ok(colored[0].normal[1] > 0.99);
  assert.equal(s.snapshot().nodes[0].recipe.generator.options.segments, 12);
  s.undo();
  assert.deepEqual(s.snapshot(), before);
  s.apply([...failure.recovery.commands, failure.recovery.retry]);
  assert.ok(
    s.snapshot().nodes[0].mesh.faces.every((f) => f.material === "yellow"),
  );
});

test("legacy painted generators migrate without color loss and corrupted layouts are rejected", () => {
  const legacy = createStore(emptyProject());
  legacy.apply([
    { op: "create", id: "knob", kind: "cylinder", options: { segments: 8 } },
  ]);
  const project = legacy.snapshot();
  const face = queryComponents(project, {
    id: "knob",
    kind: "faces",
    normal: [0, 1, 0],
  }).items[0];
  project.nodes[0].mesh.faces.find((f) => f.id === face.id).material = "orange";
  const migrated = createStore(project).snapshot();
  assert.deepEqual(migrated.nodes[0].mesh, project.nodes[0].mesh);
  assert.ok(migrated.nodes[0].recipe);
  assert.deepEqual(createStore(migrated).snapshot(), migrated);
  project.nodes[0].generator.options.segments = 12;
  assert.throws(
    () => createStore(project),
    (e) => e.code === "stale_component" && e.node === "knob",
  );
});

test("primitive refinement retains assembly size drivers, linked copies and undo", () => {
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "asset", kind: "group" },
    {
      op: "create",
      id: "slat",
      parent: "asset",
      kind: "box",
      options: { size: [0.03, 0.3, 0.02] },
    },
    {
      op: "duplicate",
      id: "slat",
      newId: "copy",
      linked: true,
      offset: [0.08, 0, 0],
    },
    {
      op: "assembly",
      definition: {
        root: "asset",
        parameters: { height: { value: 0.3 } },
        bindings: [
          { id: "slat", options: { size: [0.03, { $param: "height" }, 0.02] } },
        ],
      },
    },
  ]);
  const before = s.snapshot();
  assert.equal(getRecipe(before, { id: "slat" }).implicit, true);
  const stage = inspectRecipeStage(before, {
    id: "slat",
    index: 0,
    query: { kind: "edges", boundary: { axis: "y", side: "max" } },
  });
  assert.equal(stage.components.total, 4);
  assert.deepEqual(s.snapshot(), before);
  s.apply([
    {
      op: "recipeStep",
      id: "slat",
      action: "append",
      step: { op: "bevel", distance: 0.003 },
    },
  ]);
  const refined = s.snapshot();
  assert.equal(
    refined.nodes.find((n) => n.id === "slat").recipe.steps.length,
    1,
  );
  assert.deepEqual(refined.assemblies, before.assemblies);
  assert.ok(refined.nodes.find((n) => n.id === "slat").mesh.faces.length > 6);
  assert.deepEqual(
    refined.nodes.find((n) => n.id === "copy").mesh,
    refined.nodes.find((n) => n.id === "slat").mesh,
  );
  s.undo();
  assert.deepEqual(s.snapshot(), before);
  s.redo();
  assert.deepEqual(s.snapshot(), refined);
  s.apply([
    { op: "assemblyParameters", root: "asset", values: { height: 0.5 } },
  ]);
  assert.ok(
    Math.abs(measure(s.snapshot(), "slat").bounds.size[1] - 0.5) < 1e-9,
  );
  assert.deepEqual(createStore(s.snapshot()).snapshot(), s.snapshot());
  const unchanged = s.snapshot();
  assert.throws(() =>
    s.apply([
      {
        op: "recipeStep",
        id: "slat",
        action: "patch",
        index: 0,
        patch: { distance: 0.1 },
      },
    ]),
  );
  assert.deepEqual(s.snapshot(), unchanged);
});

test("promoting a painted baked primitive preserves geometry and provides executable topology recovery", () => {
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "box", kind: "box", scale: [2, 1, 1] },
    { op: "paint", id: "box", faces: ["f0"], material: "ink" },
    { op: "pivot", id: "box", offset: [0.2, 0, 0] },
    { op: "applyScale", id: "box" },
  ]);
  const original = s.snapshot(),
    recipe = getRecipe(original, { id: "box" }).recipe;
  s.apply([{ op: "recipe", id: "box", definition: recipe }]);
  assert.deepEqual(s.snapshot().nodes[0].mesh, original.nodes[0].mesh);
  assert.deepEqual(s.snapshot().nodes[0].position, original.nodes[0].position);
  assert.ok(shapeGenerator(s.snapshot().nodes[0]));
  s.apply([{ op: "parameters", id: "box", options: { size: [1, 0.8, 1] } }]);
  assert.ok(Math.abs(measure(s.snapshot(), "box").bounds.size[1] - 0.8) < 1e-9);
  assert.equal(
    s.snapshot().nodes[0].mesh.faces.find((f) => f.id === "f0").material,
    "ink",
  );
  const fresh = createStore(original),
    step = {
      op: "recipeStep",
      id: "box",
      action: "append",
      step: { op: "bevel", distance: 0.02 },
    };
  let failure;
  try {
    fresh.apply([step]);
  } catch (e) {
    failure = e;
  }
  assert.equal(failure.code, "stale_component");
  assert.deepEqual(fresh.snapshot(), original);
  fresh.apply([...failure.recovery.commands, failure.recovery.retry]);
  assert.equal(fresh.snapshot().nodes[0].recipe.steps.length, 1);
  assert.equal(validateProject(fresh.snapshot()).ok, true);
});

test("base shape edits preserve steps and cannot overwrite parameter expressions", () => {
  const s = createStore(emptyProject());
  s.apply([
    {
      op: "create",
      id: "part",
      kind: "cylinder",
      options: { radius: 0.2, height: 0.5, segments: 8 },
    },
    {
      op: "recipeStep",
      id: "part",
      action: "append",
      step: {
        op: "paint",
        material: "ink",
        select: { kind: "faces", normal: [0, 1, 0] },
      },
    },
    { op: "parameters", id: "part", options: { height: 0.7 } },
  ]);
  assert.equal(s.snapshot().nodes[0].recipe.steps.length, 1);
  assert.ok(
    Math.abs(measure(s.snapshot(), "part").bounds.size[1] - 0.7) < 1e-9,
  );
  assert.ok(s.snapshot().nodes[0].mesh.faces.some((f) => f.material === "ink"));
  const definition = getRecipe(s.snapshot(), { id: "part" }).recipe;
  definition.parameters.height = { value: 0.8 };
  definition.generator.options.height = { $param: "height" };
  s.apply([{ op: "recipe", id: "part", definition }]);
  const before = s.snapshot();
  assert.equal(shapeGenerator(before.nodes[0]), null);
  assert.throws(
    () => s.apply([{ op: "parameters", id: "part", options: { height: 1 } }]),
    { code: "dependency" },
  );
  assert.deepEqual(s.snapshot(), before);
  s.apply([{ op: "recipeParameters", id: "part", values: { height: 1 } }]);
  assert.ok(Math.abs(measure(s.snapshot(), "part").bounds.size[1] - 1) < 1e-9);
});

test("capability reads cannot change subsequent command or query validation", () => {
  const first = capabilities();
  first.commands.oneOf.find(
    (c) => c.properties.op.const === "renameProject",
  ).properties.name.type = "number";
  first.query.properties.kind.enum.length = 0;
  validateSchema(
    [{ op: "renameProject", name: "Still a valid name" }],
    commandsSchema,
  );
  validateSchema({ id: "body", kind: "faces" }, capabilities().query);
  assert.equal(
    capabilities().commands.oneOf.find(
      (c) => c.properties.op.const === "renameProject",
    ).properties.name.type,
    "string",
  );
});

test("recipe stages expose guarded input references before bakes without changing the document", () => {
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "body", kind: "box", position: [2, 3, 0] },
    {
      op: "recipe",
      id: "body",
      definition: {
        parameters: {},
        generator: { kind: "box" },
        steps: [
          { op: "transform", translation: [0.1, 0, 0] },
          { op: "cut", axis: "y", offset: 0 },
        ],
      },
    },
    { op: "pivot", id: "body", offset: [0.2, 0, 0] },
  ]);
  const before = s.snapshot(),
    revision = s.revision;
  const stale = queryComponents(before, {
    id: "body",
    kind: "faces",
    normal: [0, 0, -1],
  }).items[0].ref;
  const insert = (ref) => ({
    op: "recipeStep",
    id: "body",
    action: "append",
    index: 0,
    step: { op: "paint", material: "ink", faces: [ref] },
  });
  assert.throws(
    () => s.apply([insert(stale)]),
    (e) => e.code === "stale_component" && e.suggestion.includes("recipeStage"),
  );
  const stage = inspectRecipeStage(before, {
    id: "body",
    index: 0,
    query: { kind: "faces", normal: [0, 0, -1], limit: 1 },
  });
  assert.equal(stage.input.node.mesh, undefined);
  assert.equal(stage.input.node.faces, 6);
  assert.equal(stage.components.total, 1);
  assert.deepEqual(stage.input.bounds.center, [0, 0, 0]);
  assert.deepEqual(measure(stage.project, "body").bounds.center, [2, 3, 0]);
  assert.deepEqual(s.snapshot(), before);
  assert.equal(s.revision, revision);
  s.apply([insert(stage.components.items[0].ref)]);
  assert.ok(
    s.snapshot().nodes[0].mesh.faces.filter((f) => f.material === "ink")
      .length >= 2,
  );
  assert.equal(validateProject(s.snapshot()).ok, true);
  assert.equal(
    inspectRecipeStage(s.snapshot(), { id: "body", index: 3 }).step,
    null,
  );
  assert.throws(
    () => inspectRecipeStage(s.snapshot(), { id: "body", index: 4 }),
    /stage/,
  );
});

test("duplicated recipes remap guarded face, vertex and nested ring references without weakening tokens", () => {
  for (const variant of ["paint", "transform", "loopCut", "bevel"]) {
    const s = createStore(emptyProject());
    s.apply([
      { op: "create", id: "asset", kind: "group" },
      { op: "create", id: "body", parent: "asset", kind: "box" },
      {
        op: "recipe",
        id: "body",
        definition: { parameters: {}, generator: { kind: "box" }, steps: [] },
      },
    ]);
    const kind =
      variant === "paint"
        ? "faces"
        : variant === "transform"
          ? "vertices"
          : "edges";
    const ref = inspectRecipeStage(s.snapshot(), {
      id: "body",
      index: 0,
      query: { kind },
    }).components.items[0].ref;
    const step =
      variant === "paint"
        ? { op: variant, faces: [ref], material: "ink" }
        : variant === "transform"
          ? { op: variant, vertices: [ref], translation: [0.01, 0, 0] }
          : variant === "loopCut"
            ? { op: variant, edge: ref, ratio: 0.5 }
            : {
                op: variant,
                select: { kind: "edges", loopFrom: ref },
                distance: 0.01,
              };
    s.apply([{ op: "recipeStep", id: "body", action: "append", step }]);
    const original = s.snapshot();
    s.apply([{ op: "duplicate", id: "asset", newId: "copy" }]);
    const clone = s.snapshot().nodes.find((n) => n.id === "copy-1"),
      savedRef =
        variant === "paint"
          ? clone.recipe.steps[0].faces[0]
          : variant === "transform"
            ? clone.recipe.steps[0].vertices[0]
            : variant === "loopCut"
              ? clone.recipe.steps[0].edge
              : clone.recipe.steps[0].select.loopFrom;
    assert.deepEqual(savedRef, { ...ref, node: "copy-1" });
    assert.deepEqual(
      s.snapshot().nodes.find((n) => n.id === "body"),
      original.nodes.find((n) => n.id === "body"),
    );
    assert.equal(validateProject(s.snapshot()).ok, true);
    assert.deepEqual(createStore(s.snapshot()).snapshot(), s.snapshot());
  }
});

test("whole-recipe transforms affect geometry before subsequent cuts and preserve object placement", () => {
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "box", kind: "box", position: [4, 0, 0] },
    {
      op: "recipe",
      id: "box",
      definition: {
        parameters: { width: { value: 1 } },
        generator: {
          kind: "box",
          options: { size: [{ $param: "width" }, 1, 1] },
        },
        steps: [
          { op: "transform", scale: [2, 1, 1], translation: [0, 1, 0] },
          { op: "cut", axis: "y", offset: 1 },
        ],
      },
    },
  ]);
  assert.deepEqual(measure(s.snapshot(), "box").bounds.size, [2, 1, 1]);
  assert.deepEqual(measure(s.snapshot(), "box").bounds.center, [4, 1, 0]);
  assert.equal(s.snapshot().nodes[0].mesh.faces.length, 10);
  assert.deepEqual(s.snapshot().nodes[0].position, [4, 0, 0]);
  s.apply([{ op: "recipeParameters", id: "box", values: { width: 2 } }]);
  assert.deepEqual(measure(s.snapshot(), "box").bounds.size, [4, 1, 1]);
  assert.deepEqual(createStore(s.snapshot()).snapshot(), s.snapshot());
  assert.equal(validateProject(s.snapshot()).ok, true);
});

test("mirror origins wait for source transforms and inconsistent cached exports are blocked within scope", async () => {
  const { assertExportable } = await import("../site/workshop/export-scope.js");
  for (const reversed of [false, true]) {
    const bindings = [
      {
        id: "marker",
        position: [
          { $anchor: { node: "mirror", point: "origin", axis: "x" } },
          1,
          0,
        ],
      },
      { id: "source", position: [{ $param: "spacing" }, 0, 0] },
    ];
    const s = createStore(emptyProject());
    s.apply([
      { op: "create", id: "rig", kind: "group" },
      {
        op: "create",
        id: "source",
        kind: "box",
        parent: "rig",
        position: [1, 0, 0],
      },
      {
        op: "symmetry",
        id: "source",
        newId: "mirror",
        axis: "x",
        space: "parent",
        linked: true,
      },
      {
        op: "create",
        id: "marker",
        kind: "box",
        parent: "rig",
        options: { size: [0.1, 0.1, 0.1] },
      },
      {
        op: "assembly",
        definition: {
          root: "rig",
          parameters: { spacing: { value: 1 } },
          bindings: reversed ? bindings.reverse() : bindings,
        },
      },
      { op: "assemblyParameters", root: "rig", values: { spacing: 2 } },
    ]);
    const p = s.snapshot();
    assert.equal(p.nodes.find((n) => n.id === "marker").position[0], -2);
    assert.equal(assertExportable(p).ok, true);
    assert.deepEqual(createStore(p).snapshot(), p);
    const stale = structuredClone(p);
    stale.nodes.find((n) => n.id === "marker").position[0] = -1;
    assert.throws(
      () => assertExportable(stale),
      (e) =>
        e.code === "export_validation" &&
        e.issues.some((i) => i.code === "evaluation-mismatch"),
    );
    assert.equal(assertExportable(stale, { ids: ["source"] }).ok, true);
    const cycle = structuredClone(p.assemblies[0]);
    cycle.bindings.find((b) => b.id === "source").position[0] = {
      $anchor: { node: "marker", point: "origin", axis: "x" },
    };
    assert.throws(
      () => s.apply([{ op: "assembly", definition: cycle }]),
      /cycle/,
    );
    assert.deepEqual(s.snapshot(), p);
  }
});

test("recipe reads and patches preserve expressions and failures retain evaluated step context", () => {
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "body", kind: "box" },
    { op: "recipe", id: "body", definition: hollowBoxRecipe() },
  ]);
  const step = getRecipe(s.snapshot(), { id: "body", index: 1 });
  assert.equal(step.evaluated.distance, -0.31);
  assert.equal(step.step.distance.$param, "cavityDepth");
  assert.ok(
    JSON.stringify(getRecipe(s.snapshot(), { id: "body" })).length < 4000,
  );
  const command = {
    op: "recipeStep",
    id: "body",
    action: "patch",
    index: 2,
    patch: { label: "Rim", distance: 0.004 },
  };
  validateSchema([command], commandsSchema);
  s.apply([command]);
  validateSchema(
    [
      {
        ...command,
        patch: {
          select: { kind: "edges", boundary: { axis: "y", side: "min" } },
        },
      },
    ],
    commandsSchema,
  );
  assert.deepEqual(
    s.snapshot().nodes[0].recipe.steps[2].select,
    hollowBoxRecipe().steps[2].select,
  );
  const before = s.snapshot();
  assert.throws(
    () => s.apply([{ ...command, patch: { ratio: 0.5 } }]),
    /Unknown field/,
  );
  assert.throws(
    () => s.apply([{ ...command, patch: { distance: 10 } }]),
    (e) =>
      e.commandIndex === 0 &&
      e.recipeStepIndex === 2 &&
      e.recipeOperation === "bevel" &&
      e.path === "nodes.body.recipe.steps.2" &&
      e.recipeArguments.distance === 10 &&
      e.recipeParameters.width === 0.72,
  );
  assert.deepEqual(s.snapshot(), before);
});

test("step selections use input geometry, boundary rules follow resize and fixed selections expire safely", () => {
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "body", kind: "box" },
    { op: "recipe", id: "body", definition: hollowBoxRecipe() },
  ]);
  const step = {
    op: "bevel",
    distance: 0.004,
    select: {
      kind: "edges",
      space: "local",
      boundary: { axis: "y", side: "min" },
    },
  };
  const p = s.snapshot(),
    before = recipeSelection(p, "body", 3, step);
  assert.equal(before.count, 4);
  assert.deepEqual(s.snapshot(), p);
  s.apply([
    { op: "recipeStep", id: "body", action: "append", step },
    { op: "recipeParameters", id: "body", values: { width: 1, height: 0.5 } },
  ]);
  assert.equal(recipeSelection(s.snapshot(), "body", 3, step).count, 4);
  assert.equal(validateProject(s.snapshot()).ok, true);
  const priorInput = recipeInput(s.snapshot(), "body", 3);
  s.apply([
    {
      op: "recipeStep",
      id: "body",
      action: "update",
      index: 3,
      step: {
        op: "bevel",
        distance: 0.004,
        edges: before.selection.edges,
        topology: topologyToken(priorInput.nodes[0].mesh),
      },
    },
  ]);
  const fixed = s.snapshot();
  assert.throws(
    () =>
      s.apply([{ op: "recipeParameters", id: "body", values: { width: 1.1 } }]),
    (e) => e.code === "stale_component" && e.recipeStepIndex === 3,
  );
  assert.deepEqual(s.snapshot(), fixed);
});

test("linked geometry anchors evaluate after their source regardless of binding order", () => {
  const bindings = [
    {
      id: "marker",
      position: [{ $anchor: { node: "copy", point: "max", axis: "x" } }, 0, 0],
    },
    { id: "copy", position: [2, 0, 0] },
    { id: "source", options: { size: [{ $param: "width" }, 1, 1] } },
  ];
  for (const order of [bindings, [...bindings].reverse()]) {
    const s = createStore(emptyProject());
    s.apply([
      { op: "create", id: "module", kind: "group" },
      { op: "create", id: "source", parent: "module", kind: "box" },
      {
        op: "duplicate",
        id: "source",
        newId: "copy",
        linked: true,
        offset: [2, 0, 0],
      },
      {
        op: "create",
        id: "marker",
        parent: "module",
        kind: "box",
        options: { size: [0.1, 0.1, 0.1] },
      },
      {
        op: "assembly",
        definition: {
          root: "module",
          parameters: { width: { value: 1 } },
          bindings: order,
        },
      },
      { op: "assemblyParameters", root: "module", values: { width: 2 } },
    ]);
    const p = s.snapshot();
    assert.equal(p.nodes.find((n) => n.id === "marker").position[0], 3);
    assert.deepEqual(createStore(JSON.parse(JSON.stringify(p))).snapshot(), p);
    assert.equal(validateProject(p).ok, true);
    const stale = structuredClone(p);
    stale.nodes.find((n) => n.id === "marker").position[0] = 2.5;
    assert.ok(
      validateProject(stale).errors.some(
        (e) => e.code === "evaluation-mismatch" && e.node === "marker",
      ),
    );
    const cycle = structuredClone(p.assemblies[0]);
    cycle.bindings.find((b) => b.id === "source").options.size[0] = {
      $anchor: { node: "marker", point: "origin", axis: "x" },
    };
    assert.throws(
      () => s.apply([{ op: "assembly", definition: cycle }]),
      /cycle/,
    );
    assert.deepEqual(s.snapshot(), p);
  }
});

test("incompatible or empty component selections never broaden an edit", () => {
  const s = createStore(emptyProject());
  s.apply([{ op: "create", id: "box", kind: "box" }]);
  const before = s.snapshot();
  for (const c of [
    {
      op: "bevel",
      distance: 0.05,
      select: { kind: "faces", normal: [0, 1, 0], space: "local" },
    },
    { op: "bevel", distance: 0.05, edges: [] },
    { op: "paint", material: "cream", select: { kind: "edges" } },
    { op: "paint", material: "cream", faces: [] },
  ]) {
    assert.throws(
      () => s.apply([{ ...c, id: "box" }]),
      (e) => e.code === "selection",
    );
    assert.deepEqual(s.snapshot(), before);
  }
  assert.throws(() =>
    validateSchema(
      [{ op: "bevel", id: "box", distance: 0.05, select: { kind: "faces" } }],
      commandsSchema,
    ),
  );
  const local = s.apply([
    {
      op: "bevel",
      id: "box",
      distance: 0.02,
      select: { kind: "edges", at: { axis: "y", value: 0.5 }, space: "local" },
    },
  ]);
  assert.deepEqual(local.results[0].selection, {
    scope: "components",
    kind: "edges",
    count: 4,
  });
});

test("detaching a child port retains effective dimensions unless inheritance is explicitly requested", () => {
  const s = createStore(emptyProject());
  s.apply([
    ...toolboxAssemblyCommands(hollowBoxRecipe()),
    { op: "duplicate", id: "toolbox", newId: "second", assetMode: "linked" },
    { op: "group", ids: ["toolbox", "second"], newId: "rack" },
    {
      op: "assembly",
      definition: {
        root: "rack",
        parameters: { width: { value: 1 } },
        bindings: [
          { id: "second", assetValues: { width: { $param: "width" } } },
        ],
      },
    },
  ]);
  const before = s.snapshot(),
    size = measure(before, "second-1").bounds.size;
  const result = s.apply([
    { op: "detachBinding", id: "second", fields: ["assetValues"] },
  ]);
  assert.deepEqual(result.results[0].parameterChanges, []);
  assert.deepEqual(measure(s.snapshot(), "second-1").bounds.size, size);
  assert.equal(
    s.snapshot().assemblies.find((a) => a.root === "second").overrides.width,
    1,
  );
  s.apply([
    { op: "assemblyParameters", root: "toolbox", values: { width: 0.8 } },
  ]);
  assert.deepEqual(measure(s.snapshot(), "second-1").bounds.size, size);
  s.undo();
  s.undo();
  const inherited = s.preview([
    {
      op: "detachBinding",
      id: "second",
      fields: ["assetValues"],
      mode: "inherit",
    },
  ]);
  assert.ok(
    inherited.results[0].parameterChanges.some(
      (p) =>
        p.root === "second" &&
        p.parameter === "width" &&
        p.before === 1 &&
        p.after === 0.72,
    ),
  );
  assert.deepEqual(s.snapshot(), before);
  s.apply([{ op: "assembly", root: "rack", definition: null }]);
  assert.deepEqual(measure(s.snapshot(), "second-1").bounds.size, size);
  assert.deepEqual(createStore(s.snapshot()).snapshot(), s.snapshot());
});

test("inspection stays compact and topology-bound pagination covers a dense mesh without gaps", () => {
  const s = createStore(emptyProject());
  s.apply([
    {
      op: "create",
      id: "sphere",
      kind: "sphere",
      options: { segments: 64, rings: 32 },
    },
  ]);
  const p = s.snapshot(),
    summary = inspectNode(p, "sphere"),
    full = inspectNode(p, "sphere", { detail: "full" });
  assert.ok(JSON.stringify(summary).length < 5000);
  assert.equal(summary.node.mesh, undefined);
  assert.equal(full.node.mesh.faces.length, 2048);
  const ids = [];
  let page = queryComponents(p, { id: "sphere", kind: "faces", limit: 257 });
  const token = page.topology;
  for (;;) {
    ids.push(...page.items.map((f) => f.id));
    if (page.nextOffset === null) break;
    page = queryComponents(p, {
      id: "sphere",
      kind: "faces",
      limit: 257,
      offset: page.nextOffset,
      topology: token,
    });
  }
  assert.equal(ids.length, 2048);
  assert.equal(new Set(ids).size, 2048);
  assert.throws(
    () => queryComponents(p, { id: "sphere", offset: 257 }),
    /topology/i,
  );
  s.apply([{ op: "parameters", id: "sphere", options: { segments: 32 } }]);
  assert.throws(
    () =>
      queryComponents(s.snapshot(), {
        id: "sphere",
        offset: 257,
        topology: token,
      }),
    (e) => e.code === "stale_component",
  );
});

test("recipe step edits retain dimensions, permit ordered refinement and identify failed steps atomically", () => {
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "box", kind: "box" },
    {
      op: "recipe",
      id: "box",
      definition: {
        parameters: { width: { value: 1 } },
        generator: {
          kind: "box",
          options: { size: [{ $param: "width" }, 1, 1] },
        },
        steps: [],
      },
    },
  ]);
  const apply = (commands) => {
    validateSchema(commands, commandsSchema);
    return s.apply(commands);
  };
  apply([
    {
      op: "recipeStep",
      id: "box",
      action: "append",
      step: { op: "bevel", distance: 0.02, label: "Edge finish" },
    },
    { op: "recipeParameters", id: "box", values: { width: 1.5 } },
    {
      op: "recipeStep",
      id: "box",
      action: "update",
      index: 0,
      step: { op: "bevel", distance: 0.03 },
    },
  ]);
  assert.equal(s.snapshot().nodes[0].mesh.faces.length, 26);
  assert.equal(measure(s.snapshot(), "box").bounds.size[0], 1.5);
  apply([
    {
      op: "recipeStep",
      id: "box",
      action: "update",
      index: 0,
      step: { op: "bevel", distance: 0.03, enabled: false },
    },
  ]);
  assert.equal(s.snapshot().nodes[0].mesh.faces.length, 6);
  apply([
    {
      op: "recipeStep",
      id: "box",
      action: "append",
      step: { op: "mirror", axis: "x" },
    },
    { op: "recipeStep", id: "box", action: "move", index: 1, to: 0 },
  ]);
  const before = s.snapshot(),
    revision = s.revision;
  assert.throws(
    () =>
      apply([
        { op: "recipeParameters", id: "box", values: { width: 1.8 } },
        {
          op: "recipeStep",
          id: "box",
          action: "update",
          index: 1,
          step: { op: "bevel", distance: 10 },
        },
      ]),
    (e) =>
      e.commandIndex === 1 &&
      e.operation === "recipeStep" &&
      e.recipeStepIndex === 1 &&
      e.recipeOperation === "bevel",
  );
  assert.deepEqual(s.snapshot(), before);
  assert.equal(s.revision, revision);
  apply([
    { op: "recipeStep", id: "box", action: "remove", index: 0 },
    {
      op: "recipeStep",
      id: "box",
      action: "update",
      index: 0,
      step: { op: "bevel", distance: 0.03, enabled: true },
    },
  ]);
  assert.deepEqual(
    createStore(JSON.parse(JSON.stringify(s.snapshot()))).snapshot(),
    s.snapshot(),
  );
  assert.equal(validateProject(s.snapshot()).ok, true);
});

test("hierarchy duplication returns complete source identities including linked parts", () => {
  const s = createStore(emptyProject());
  s.apply(toolboxAssemblyCommands(hollowBoxRecipe()));
  const before = s.snapshot();
  const result = s.apply([
    { op: "duplicate", id: "toolbox", newId: "copy", assetMode: "independent" },
  ]);
  const map = result.results[0].idMap;
  assert.equal(map.toolbox, "copy");
  assert.equal(Object.keys(map).length, before.nodes.length);
  for (const node of before.nodes) {
    const duplicate = s.snapshot().nodes.find((n) => n.id === map[node.id]);
    assert.ok(duplicate);
    assert.equal(duplicate.parent, node.parent ? map[node.parent] : null);
    if (node.instanceOf)
      assert.equal(duplicate.instanceOf, map[node.instanceOf]);
  }
});

function box() {
  const s = createStore(emptyProject());
  s.apply([
    {
      op: "create",
      id: "body",
      kind: "box",
      options: { size: [0.72, 0.4, 0.46] },
    },
    { op: "inset", id: "body", face: "f5", distance: 0.035 },
    { op: "extrude", id: "body", face: "f5", distance: -0.31 },
  ]);
  return s;
}

test("first-face paint keeps its base material across reflection, affine baking and reload", () => {
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "box", kind: "box", material: "orange" },
    {
      op: "recipe",
      id: "box",
      definition: {
        parameters: { width: { value: 1 } },
        generator: {
          kind: "box",
          options: { size: [{ $param: "width" }, 1, 1] },
        },
        steps: [],
      },
    },
    { op: "paint", id: "box", faces: ["f0"], material: "cream" },
    { op: "mirror", id: "box", axis: "x" },
    { op: "recipeParameters", id: "box", values: { width: 1.2 } },
  ]);
  const check = (p) => {
    assert.equal(p.nodes[0].recipe.generator.material, "orange");
    assert.deepEqual(
      p.nodes[0].mesh.faces.map((f) => f.material),
      ["cream", ...Array(5).fill("orange")],
    );
    assert.equal(validateProject(p).ok, true);
    assert.deepEqual(createStore(JSON.parse(JSON.stringify(p))).snapshot(), p);
  };
  check(s.snapshot());
  s.apply([
    {
      op: "transform",
      id: "box",
      matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  ]);
  check(s.snapshot());
  const legacy = s.snapshot();
  delete legacy.nodes[0].recipe.generator.material;
  check(createStore(legacy).snapshot());
});

test("semantic material rules execute beyond query pagination and report zero matches", () => {
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "ball", kind: "sphere", material: "orange" },
    {
      op: "recipe",
      id: "ball",
      definition: {
        parameters: {},
        generator: { kind: "sphere", options: { segments: 64, rings: 32 } },
        steps: [],
      },
    },
  ]);
  const result = s.apply([
    {
      op: "recipePaint",
      id: "ball",
      mode: "rules",
      rules: [
        { name: "all", select: { kind: "faces", limit: 1 }, material: "cream" },
        {
          name: "empty",
          select: { at: { axis: "y", value: 100 } },
          material: "blue",
        },
      ],
    },
  ]);
  const faces = s.snapshot().nodes[0].mesh.faces;
  assert.equal(faces.length, 2048);
  assert.ok(faces.every((f) => f.material === "cream"));
  assert.deepEqual(
    result.results[0].materialRules[0].rules.map((r) => r.matched),
    [2048, 0],
  );
  assert.equal(queryComponents(s.snapshot(), { id: "ball" }).truncated, true);
  assert.equal(
    createStore(s.snapshot())
      .snapshot()
      .nodes[0].mesh.faces.filter((f) => f.material === "cream").length,
    2048,
  );
});

test("linked asset overrides and field detach retain dimensions and attachment positions", () => {
  const s = createStore(emptyProject());
  s.apply(toolboxAssemblyCommands(hollowBoxRecipe()));
  const commands = [
    { op: "duplicate", id: "toolbox", newId: "second", assetMode: "linked" },
    {
      op: "assemblyParameters",
      root: "second",
      override: true,
      values: { openAngle: -90 },
    },
    { op: "assemblyParameters", root: "toolbox", values: { height: 0.6 } },
  ];
  validateSchema(commands, commandsSchema);
  s.apply(commands);
  let p = s.snapshot();
  assert.equal(p.nodes.find((n) => n.id === "second-2").rotation[0], -90);
  assert.equal(
    p.nodes.find((n) => n.id === "second-2").position[1],
    p.nodes.find((n) => n.id === "hinge").position[1],
  );
  assert.equal(
    p.assemblies.find((a) => a.root === "second").parameters.cavityDepth.value,
    0.51,
  );
  s.apply([
    {
      op: "assemblyParameters",
      root: "second",
      values: {},
      resetOverrides: ["openAngle"],
    },
  ]);
  assert.equal(
    s.snapshot().nodes.find((n) => n.id === "second-2").rotation[0],
    -32,
  );
  s.apply([
    { op: "detachBinding", id: "second-2", fields: ["rotation"] },
    { op: "set", id: "second-2", rotation: [-90, 0, 0] },
    { op: "assemblyParameters", root: "toolbox", values: { height: 0.7 } },
  ]);
  p = createStore(s.snapshot()).snapshot();
  assert.equal(p.nodes.find((n) => n.id === "second-2").rotation[0], -90);
  assert.equal(
    p.nodes.find((n) => n.id === "second-2").position[1],
    p.nodes.find((n) => n.id === "hinge").position[1],
  );
});

test("nested assets expose child ports, preserve ownership and reject dependency cycles atomically", () => {
  const s = createStore(emptyProject());
  s.apply(toolboxAssemblyCommands(hollowBoxRecipe()));
  const commands = [
    { op: "duplicate", id: "toolbox", newId: "second", assetMode: "linked" },
    { op: "group", ids: ["toolbox", "second"], newId: "rack" },
    {
      op: "assembly",
      definition: {
        root: "rack",
        parameters: { spacing: { value: 1.2 }, width: { value: 0.9 } },
        bindings: [
          {
            id: "toolbox",
            position: [0, 0, 0],
            assetValues: { width: { $param: "width" } },
          },
          { id: "second", position: [{ $param: "spacing" }, 0, 0] },
        ],
      },
    },
  ];
  validateSchema(commands, commandsSchema);
  s.apply(commands);
  let p = s.snapshot();
  assert.equal(assetFor(p, "second-1").root, "second");
  assert.equal(assetFor(p, "rack").root, "rack");
  assert.equal(p.nodes.find((n) => n.id === "second").position[0], 1.2);
  assert.ok(Math.abs(measure(p, "second-1").bounds.size[0] - 0.9) < 1e-9);
  assert.deepEqual(createStore(p).snapshot(), p);
  assert.throws(
    () =>
      s.apply([
        { op: "assemblyParameters", root: "toolbox", values: { width: 0.7 } },
      ]),
    /parent asset/,
  );
  const invalid = structuredClone(p.assemblies.find((a) => a.root === "rack"));
  invalid.bindings.push({ id: "body", position: [0, 0, 0] });
  assert.throws(
    () => s.apply([{ op: "assembly", definition: invalid }]),
    /child roots/,
  );
  const cycle = structuredClone(p.assemblies.find((a) => a.root === "rack"));
  cycle.bindings[0].assetValues.width = {
    $anchor: { node: "second", point: "max", axis: "x" },
  };
  assert.throws(
    () => s.apply([{ op: "assembly", definition: cycle }]),
    /cycle/,
  );
  assert.deepEqual(s.snapshot(), p);
  s.apply([
    {
      op: "duplicate",
      id: "rack",
      newId: "rack-copy",
      assetMode: "independent",
    },
  ]);
  p = s.snapshot();
  const rootCopy = p.assemblies.find((a) => a.root === "rack-copy");
  const childSource = rootCopy.bindings.find((b) => b.assetValues).id;
  assert.ok(p.assemblies.some((a) => a.source === childSource));
  assert.equal(validateProject(p).ok, true);
});
test("surface checks reject a bevel crossing a cavity and diagnose inward shells", () => {
  const s = box(),
    before = s.snapshot(),
    edge = queryComponents(before, {
      id: "body",
      kind: "edges",
      at: { axis: "y", value: -0.2 },
    }).items.find((e) => e.endpoints.every((p) => p[2] === -0.23));
  assert.throws(
    () =>
      s.apply([{ op: "bevel", id: "body", edges: [edge.ref], distance: 0.3 }]),
    (e) =>
      e.code === "geometry" &&
      e.commandIndex === 0 &&
      e.issues.some((i) => i.code === "self-intersection" && i.node === "body"),
  );
  assert.deepEqual(s.snapshot(), before);
  const inverted = emptyProject();
  const mesh = primitive("box", {}, "yellow");
  mesh.faces.forEach((f) => f.vertices.reverse());
  inverted.nodes.push({ id: "cube", name: "Inward", mesh });
  assert.ok(
    validateProject(inverted).warnings.some(
      (w) => w.code === "inward-shell" && Math.abs(w.signedVolume + 1) < 1e-8,
    ),
  );
});
test("stale component references fail instead of selecting a reused edge key", () => {
  const s = box(),
    before = s.snapshot(),
    ref = queryComponents(before, { id: "body", kind: "edges" }).items.find(
      (e) => e.id === "0:3",
    ).ref;
  s.apply([
    {
      op: "bevel",
      id: "body",
      select: {
        kind: "edges",
        space: "local",
        at: { axis: "y", value: 0.2 },
        crease: 1,
      },
      distance: 0.006,
    },
  ]);
  assert.notEqual(topologyToken(s.snapshot().nodes[0].mesh), ref.topology);
  const revision = s.revision;
  assert.throws(
    () =>
      s.apply(
        [
          {
            op: "transform",
            id: "body",
            edges: [ref],
            translation: [0, 0.001, 0],
          },
        ],
        { ifRevision: revision, strictComponents: true },
      ),
    (e) => e.code === "stale_component",
  );
  assert.throws(
    () =>
      s.apply(
        [
          {
            op: "transform",
            id: "body",
            edges: ["0:3"],
            translation: [0, 0.001, 0],
          },
        ],
        { strictComponents: true },
      ),
    (e) => e.code === "stale_component",
  );
  assert.equal(s.revision, revision);
});
test("preview and structured batch errors preserve document/history and reject conflicts first", () => {
  const s = box(),
    before = s.snapshot(),
    r = s.revision;
  const p = s.preview([{ op: "set", id: "body", name: "Preview only" }]);
  assert.equal(p.project.nodes[0].name, "Preview only");
  assert.deepEqual(s.snapshot(), before);
  assert.equal(s.revision, r);
  assert.throws(
    () =>
      s.apply([
        { op: "set", id: "body", name: "First" },
        { op: "bevel", id: "body", edges: ["0:3"], distance: 2 },
      ]),
    (e) =>
      e.commandIndex === 1 &&
      e.operation === "bevel" &&
      e.node === "body" &&
      !!e.path,
  );
  assert.deepEqual(s.snapshot(), before);
  assert.throws(
    () => s.apply([{ op: "not-valid" }], { ifRevision: r - 1 }),
    (e) => e.code === "conflict",
  );
  assert.throws(
    () =>
      validateSchema(
        [{ op: "material", id: "yellow", metallic: 1 }],
        commandsSchema,
      ),
    (e) => e.code === "schema",
  );
});
test("recipe width changes retain wall and bevel, survive serialization and preserve pivot bakes", () => {
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "body", kind: "box" },
    { op: "recipe", id: "body", definition: hollowBoxRecipe() },
    { op: "pivot", id: "body", offset: [0.1, 0, 0] },
    {
      op: "duplicate",
      id: "body",
      newId: "linked",
      offset: [1, 0, 0],
      linked: true,
    },
  ]);
  const restored = createStore(JSON.parse(JSON.stringify(s.snapshot()))),
    origin = measure(restored.snapshot(), "body").origin;
  const result = restored.apply([
    { op: "recipeParameters", id: "body", values: { width: 0.82 } },
  ]);
  assert.equal(
    restored.snapshot().nodes[0].recipe.parameters.wall.value,
    0.035,
  );
  assert.equal(
    restored.snapshot().nodes[0].recipe.parameters.bevel.value,
    0.006,
  );
  assert.deepEqual(measure(restored.snapshot(), "body").origin, origin);
  assert.ok(
    Math.abs(measure(restored.snapshot(), "body").bounds.size[0] - 0.82) < 1e-9,
  );
  assert.ok(result.changed.includes("linked"));
  assert.deepEqual(validateProject(restored.snapshot()).warnings, []);
  assert.throws(() =>
    restored.apply([
      { op: "recipeParameters", id: "body", values: { cavityDepth: 2 } },
    ]),
  );
});

test("face colors survive recipe rebuilds and whole-mesh paint supersedes overrides", () => {
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "body", kind: "box" },
    { op: "recipe", id: "body", definition: hollowBoxRecipe() },
  ]);
  const faces = queryComponents(s.snapshot(), {
    id: "body",
    kind: "faces",
    space: "local",
    normal: [0, 1, 0],
    at: { axis: "y", value: 0.2 },
  }).items;
  s.apply(
    [
      {
        op: "paint",
        id: "body",
        faces: faces.map((f) => f.ref),
        material: "cream",
      },
    ],
    { strictComponents: true },
  );
  s.apply([{ op: "recipeParameters", id: "body", values: { width: 0.92 } }]);
  const n = s.snapshot().nodes[0];
  assert.ok(n.recipe);
  assert.equal(n.recipe.paint.faces.length, 4);
  assert.ok(
    faces.every(
      (f) => n.mesh.faces.find((v) => v.id === f.id).material === "cream",
    ),
  );
  s.apply([
    { op: "paint", id: "body", material: "ink" },
    { op: "recipeParameters", id: "body", values: { width: 0.82 } },
  ]);
  assert.ok(
    s.snapshot().nodes[0].mesh.faces.every((f) => f.material === "ink"),
  );
});

test("assembly dimensions, derived parameters and anchors survive serialization and reject cycles atomically", async () => {
  const { toolboxAssemblyCommands } = await import(
    "../site/workshop/assembly.js"
  );
  const commands = toolboxAssemblyCommands(hollowBoxRecipe());
  validateSchema(commands, commandsSchema);
  const s = createStore(emptyProject());
  s.apply(commands);
  const restored = createStore(JSON.parse(JSON.stringify(s.snapshot())));
  restored.apply([
    {
      op: "assemblyParameters",
      values: { width: 0.92, height: 0.5, depth: 0.56 },
    },
  ]);
  const project = restored.snapshot(),
    byId = (id) => project.nodes.find((n) => n.id === id);
  assert.ok(Math.abs(measure(project, "body").bounds.size[0] - 0.92) < 1e-9);
  assert.ok(Math.abs(byId("lid").generator.options.size[0] - 0.94) < 1e-9);
  assert.ok(Math.abs(Math.abs(byId("foot-0").position[0]) - 0.38) < 1e-9);
  assert.ok(
    Math.abs(byId("body").recipe.parameters.cavityDepth.value - 0.41) < 1e-9,
  );
  assert.ok(
    Math.abs(
      byId("hinge").position[1] -
        (measure(project, "body").bounds.max[1] + 0.0275),
    ) < 1e-9,
  );
  assert.equal(validateProject(project).ok, true);
  const cyclic = structuredClone(project.assemblies[0]);
  cyclic.parameters.width.expression = { $param: "width" };
  assert.throws(
    () => restored.apply([{ op: "assembly", definition: cyclic }]),
    /cycle/,
  );
  assert.deepEqual(restored.snapshot(), project);
  const anchorCycle = structuredClone(project.assemblies[0]);
  anchorCycle.bindings.find((b) => b.id === "body").position = [
    0,
    { $anchor: { node: "hinge", point: "origin", axis: "y" } },
    0,
  ];
  assert.throws(
    () => restored.apply([{ op: "assembly", definition: anchorCycle }]),
    /cycle/,
  );
  assert.throws(
    () =>
      restored.apply([
        { op: "recipeParameters", id: "body", values: { width: 1 } },
      ]),
    (e) => e.code === "dependency",
  );
});

test("export validation follows selected roots and blocks invalid full exports", async () => {
  const { exportScope, assertExportable } = await import(
    "../site/workshop/export-scope.js"
  );
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "asset", kind: "group" },
    { op: "create", id: "bad", parent: "asset", kind: "box" },
    { op: "create", id: "lid", parent: "asset", kind: "box" },
  ]);
  const p = s.snapshot();
  delete p.nodes[1].generator;
  p.nodes[1].mesh.faces.push({
    ...structuredClone(p.nodes[1].mesh.faces[0]),
    id: "overlap",
  });
  assert.throws(
    () => assertExportable(p),
    (e) => e.code === "export_validation" && e.issues.length > 0,
  );
  assert.equal(assertExportable(p, { force: true }).ok, false);
  assert.equal(assertExportable(p, { ids: ["lid"] }).ok, true);
  assert.deepEqual(
    exportScope(p, { ids: ["lid"] }).nodes.map((n) => n.id),
    ["asset", "lid"],
  );
});

test("linked geometry updates return compact summaries with opt-in component details", () => {
  const s = createStore(emptyProject());
  s.apply([
    {
      op: "create",
      id: "lamp",
      kind: "sphere",
      options: { segments: 16, rings: 8 },
    },
    ...Array.from({ length: 23 }, (_, i) => ({
      op: "duplicate",
      id: "lamp",
      newId: `lamp-${i}`,
      linked: true,
    })),
  ]);
  const result = s.apply([
    { op: "parameters", id: "lamp", options: { radius: 0.23 } },
  ]);
  assert.equal(result.changed.length, 24);
  assert.ok(JSON.stringify(result).length < 12000);
  assert.ok(!result.results[0].geometry[0].faces);
  const detail = s.apply(
    [{ op: "parameters", id: "lamp", options: { radius: 0.24 } }],
    { includeComponents: true },
  );
  assert.ok(detail.results[0].geometry[0].faces.length > 0);
});

test("asset anchors remain rigid under parent translation, rotation and nonuniform scale", async () => {
  const { toolboxAssemblyCommands } = await import(
    "../site/workshop/assembly.js"
  );
  const s = createStore(emptyProject());
  s.apply(toolboxAssemblyCommands(hollowBoxRecipe()));
  const before = s.snapshot();
  s.apply([
    {
      op: "set",
      id: "toolbox",
      rotation: [23, 17, 45],
      position: [1, 2, -3],
      scale: [1.2, 0.8, 1.5],
    },
  ]);
  for (const n of s.snapshot().nodes.filter((n) => n.id !== "toolbox")) {
    const old = before.nodes.find((v) => v.id === n.id);
    for (const field of ["position", "rotation", "scale"])
      n[field].forEach((v, i) =>
        assert.ok(Math.abs(v - old[field][i]) < 1e-9, n.id + "." + field),
      );
    assert.deepEqual(n.mesh, old.mesh);
  }
});

test("legacy and current JSON imports evaluate recipe and assembly parameters before reading or exporting", async () => {
  const { toolboxAssemblyCommands } = await import(
    "../site/workshop/assembly.js"
  );
  const { exportScope } = await import("../site/workshop/export-scope.js");
  const s = createStore(emptyProject());
  s.apply(toolboxAssemblyCommands(hollowBoxRecipe()));
  const json = s.snapshot();
  json.assembly = json.assemblies[0];
  delete json.assemblies;
  delete json.assembly.root;
  json.assembly.parameters.width.value = 1.2;
  s.replace(json);
  assert.equal(s.snapshot().assemblies[0].root, "toolbox");
  assert.ok(
    Math.abs(measure(s.snapshot(), "body").bounds.size[0] - 1.2) < 1e-9,
  );
  assert.ok(
    Math.abs(measure(exportScope(json), "body").bounds.size[0] - 1.2) < 1e-9,
  );
  const previous = s.snapshot().nodes;
  s.apply([{ op: "renameProject", name: "Only a name" }]);
  assert.deepEqual(s.snapshot().nodes, previous);
  const standalone = createStore(emptyProject());
  standalone.apply([
    { op: "create", id: "box", kind: "box" },
    { op: "recipe", id: "box", definition: hollowBoxRecipe() },
  ]);
  const raw = standalone.snapshot();
  raw.nodes[0].recipe.parameters.width.value = 1.1;
  standalone.replace(raw);
  const oldGlobal = {
    ...standalone.snapshot(),
    assemblies: undefined,
    assembly: {
      parameters: {},
      bindings: [{ id: "box", position: [0, 0.2, 0] }],
    },
  };
  const migrated = createStore(oldGlobal).snapshot();
  assert.equal(
    migrated.nodes.find((n) => n.id === "box").parent,
    migrated.assemblies[0].root,
  );
  assert.ok(
    Math.abs(measure(standalone.snapshot(), "box").bounds.size[0] - 1.1) < 1e-9,
  );
});

test("asset copies own their parameter scopes, preserve internal instances, link explicitly and delete cleanly", async () => {
  const { toolboxAssemblyCommands } = await import(
    "../site/workshop/assembly.js"
  );
  const s = createStore(emptyProject());
  s.apply(toolboxAssemblyCommands(hollowBoxRecipe()));
  s.apply([
    { op: "duplicate", id: "toolbox", newId: "copy", assetMode: "independent" },
  ]);
  s.apply([{ op: "assemblyParameters", root: "copy", values: { width: 1.2 } }]);
  let p = s.snapshot();
  assert.equal(
    p.assemblies.find((a) => a.root === "toolbox").parameters.width.value,
    0.72,
  );
  assert.equal(
    p.assemblies.find((a) => a.root === "copy").parameters.width.value,
    1.2,
  );
  assert.equal(p.nodes.find((n) => n.id === "copy-8").instanceOf, "copy-7");
  assert.throws(
    () => s.apply([{ op: "assemblyParameters", values: { width: 1 } }]),
    /root/,
  );
  s.apply([
    { op: "duplicate", id: "toolbox", newId: "linked", assetMode: "linked" },
    { op: "duplicate", id: "toolbox", newId: "static", assetMode: "static" },
  ]);
  s.apply([
    { op: "assemblyParameters", root: "toolbox", values: { width: 0.9 } },
  ]);
  p = s.snapshot();
  assert.equal(
    p.assemblies.find((a) => a.root === "linked").parameters.width.value,
    0.9,
  );
  assert.ok(Math.abs(measure(p, "linked-1").bounds.size[0] - 0.9) < 1e-9);
  assert.ok(
    p.nodes
      .filter((n) => n.id.startsWith("static"))
      .every((n) => !n.recipe && !n.generator && !n.instanceOf),
  );
  assert.throws(
    () =>
      s.apply([
        { op: "assemblyParameters", root: "linked", values: { width: 1 } },
      ]),
    /source/,
  );
  s.apply([{ op: "delete", id: "toolbox" }]);
  assert.equal(
    s.snapshot().assemblies.find((a) => a.root === "linked").source,
    undefined,
  );
  assert.equal(validateProject(s.snapshot()).ok, true);
  s.undo();
  assert.ok(s.snapshot().nodes.some((n) => n.id === "toolbox"));
  s.apply([
    { op: "detachBinding", id: "body" },
    { op: "set", id: "body", position: [0, 0.32, 0] },
  ]);
  assert.equal(
    s.snapshot().nodes.find((n) => n.id === "body").position[1],
    0.32,
  );
});

test("failed painted segmentation has executable recovery and directional colors survive further rebuilds", () => {
  const s = createStore(emptyProject());
  s.apply([
    { op: "create", id: "knob", kind: "cylinder" },
    {
      op: "recipe",
      id: "knob",
      definition: {
        parameters: { segments: { value: 8 } },
        generator: {
          kind: "cylinder",
          options: { segments: { $param: "segments" } },
        },
        steps: [],
      },
    },
  ]);
  s.apply([
    {
      op: "paint",
      id: "knob",
      select: { kind: "faces", space: "local", normal: [0, 1, 0] },
      material: "cream",
    },
  ]);
  const before = s.snapshot();
  assert.throws(
    () =>
      s.apply([
        { op: "recipeParameters", id: "knob", values: { segments: 12 } },
      ]),
    (e) => e.recovery.commands[0].op === "recipePaint" && e.issues.length === 1,
  );
  assert.deepEqual(s.snapshot(), before);
  const commands = [
    {
      op: "recipePaint",
      id: "knob",
      mode: "rules",
      rules: [
        { name: "cap", select: { normal: [0, 1, 0] }, material: "cream" },
      ],
    },
    { op: "recipeParameters", id: "knob", values: { segments: 12 } },
  ];
  validateSchema(commands, commandsSchema);
  s.apply(commands);
  s.apply([{ op: "recipeParameters", id: "knob", values: { segments: 16 } }]);
  assert.equal(
    queryComponents(s.snapshot(), {
      id: "knob",
      normal: [0, 1, 0],
      space: "local",
    }).items[0].material,
    "cream",
  );
});
