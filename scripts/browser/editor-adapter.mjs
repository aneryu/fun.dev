import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  rename,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { emptyProject } from "../../site/workshop/document.js";
import { primitive } from "../../site/workshop/mesh.js";

export async function protectedSessionChecks() {
  const dir = await mkdtemp(join(tmpdir(), "fun-editor-protected-")),
    session = join(dir, "session.json"),
    record = {
      project: emptyProject("Protected session"),
      revision: 7,
      receipts: [null],
    },
    original = JSON.stringify(record, null, 2) + "\n";
  await writeFile(session, original);
  const child = spawn(
    process.execPath,
    ["scripts/editor-agent.mjs", "--mcp", "--session", session],
    { stdio: ["pipe", "pipe", "pipe"], timeout: 30000 },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (v) => (stdout += v));
  child.stderr.on("data", (v) => (stderr += v));
  const exited = once(child, "exit");
  const tool = (name, args = {}) => ({
    method: "tools/call",
    params: { name: "fun_editor_" + name, arguments: args },
  });
  child.stdin.end(
    [
      {
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "recovery-check", version: "1" },
        },
      },
      tool("inspect"),
      tool("apply", {
        commands: [{ op: "renameProject", name: "Overwrite" }],
        ifRevision: 7,
      }),
      tool("getSession"),
    ]
      .map((message, index) =>
        JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...message }),
      )
      .join("\n") + "\n",
  );
  try {
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    const replies = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).result);
    assert.equal(replies.length, 4, stdout);
    const inspected = replies[1].structuredContent;
    assert.equal(inspected.writable, false, JSON.stringify(replies[1]));
    assert.equal(inspected.recovery.code, "draft_recovery");
    assert.equal(inspected.sessionPersistence.state, "protected");
    assert.equal(replies[2].isError, true);
    assert.equal(replies[2].structuredContent.error.code, "recovery");
    assert.equal(replies[2].structuredContent.error.applied, false);
    const backup = replies[3].structuredContent;
    assert.equal(backup.recovery.code, "draft_recovery");
    assert.deepEqual(backup.project, record.project);
    assert.deepEqual(JSON.parse(backup.recoverySources.journal), record);
    assert.equal(
      await readFile(session, "utf8"),
      original,
      "Reads, rejected edits and shutdown must preserve original session bytes",
    );
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

export async function editorAdapterChecks() {
  const dir = await mkdtemp(join(tmpdir(), "fun-editor-adapter-")),
    session = join(dir, "session.json");
  const child = spawn(
    process.execPath,
    [
      "scripts/editor-agent.mjs",
      "--mcp",
      "--session",
      session,
      "--artifacts",
      dir,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout }),
    pending = new Map();
  let serial = 0,
    stderr = "";
  child.stderr.on("data", (v) => (stderr += v));
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++serial,
        timer = setTimeout(
          () => reject(new Error(`Adapter timed out: ${stderr}`)),
          20000,
        );
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  const tool = async (name, args = {}) =>
    (await call("tools/call", { name: "fun_editor_" + name, arguments: args }))
      .result;
  try {
    const initialized = await call("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "editor-check", version: "1" },
    });
    assert.ok(initialized.result.capabilities.tools);
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    const list = await call("tools/list", {});
    assert.ok(
      list.result.tools.some(
        (t) =>
          t.name === "fun_editor_preview" && t.inputSchema.properties.commands,
      ),
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(list.result)) < 25000,
      "Discovery should stay compact",
    );
    const capabilities = await tool("capabilities");
    assert.ok(Buffer.byteLength(JSON.stringify(capabilities)) < 10000);
    assert.ok(capabilities.structuredContent.commands.includes("recipeStep"));
    assert.equal(
      (await tool("capabilities", { command: "create" })).structuredContent
        .schema.properties.op.const,
      "create",
    );
    const inspected = await tool("inspect");
    assert.ok(
      inspected.structuredContent?.revision !== undefined,
      `MCP startup failed: ${JSON.stringify(inspected)}; ${stderr}`,
    );
    const r = inspected.structuredContent.revision;
    const bad = await tool("apply", {
      commands: [{ op: "material", id: "yellow", metallic: 1 }],
      ifRevision: r,
    });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.error.code, "schema");
    assert.equal(bad.structuredContent.error.applied, false);
    assert.equal(bad.structuredContent.error.revision, r);
    assert.deepEqual(
      JSON.parse(bad.content[0].text),
      bad.structuredContent.error,
    );
    const applied = await tool("apply", {
      commands: [{ op: "renameProject", name: "Adapter round trip" }],
      ifRevision: r,
      operationId: "adapter-edit",
    });
    assert.equal(applied.structuredContent.revision, r + 1);
    assert.equal(
      (
        await tool("apply", {
          commands: [{ op: "renameProject", name: "Adapter round trip" }],
          ifRevision: r,
          operationId: "adapter-edit",
        })
      ).structuredContent.replayed,
      true,
    );
    const cp = await tool("checkpoint", { name: "saved", ifRevision: r + 1 });
    assert.ok(cp.structuredContent.id);
    const shot = await tool("observe", {
      names: ["front"],
      size: 64,
      ids: ["head"],
      shading: "ids",
    });
    assert.equal(
      shot.content.find((c) => c.type === "image").mimeType,
      "image/png",
    );
    assert.deepEqual(
      shot.structuredContent.observations[0].observation.visibleIds.sort(),
      ["beak", "eye-left", "eye-right", "head"].sort(),
    );
    const glb = await tool("exportGLB", {
      ids: ["head"],
      origin: "ground-center",
    });
    assert.equal(glb.structuredContent.report.origin.mode, "ground-center");
    assert.ok(Math.abs(glb.structuredContent.report.bounds.min[1]) < 1e-6);
    assert.ok(
      (await readFile(glb.structuredContent.artifact.path))
        .subarray(0, 4)
        .equals(Buffer.from("glTF")),
    );
    const replayCamera = await tool("observe", {
      names: ["current"],
      size: 64,
      camera: inspected.structuredContent.camera,
    });
    assert.ok(!replayCamera.isError);
    assert.equal(applied.structuredContent.persistence.state, "saved");
    const undone = await tool("undo", { ifRevision: r + 1 });
    assert.equal(undone.structuredContent.revision, r + 2);
    const redone = await tool("redo", { ifRevision: r + 2 });
    assert.equal(redone.structuredContent.revision, r + 3);
    const presets = await tool("presets");
    assert.ok(
      presets.structuredContent.toolbox.some((c) => c.op === "assembly"),
    );
    const saved = JSON.parse(await readFile(session, "utf8"));
    assert.equal(saved.project.name, "Adapter round trip");
    assert.equal(saved.checkpoints.length, 1);
    assert.ok(saved.receipts.length);
    // The browser can commit successfully while the optional session file fails.
    await rename(session, session + ".backup");
    await mkdir(session);
    let failed;
    const mutation = {
      commands: [{ op: "renameProject", name: "Recovered session" }],
      ifRevision: r + 3,
      operationId: "disk-recovery",
    };
    try {
      failed = await tool("apply", mutation);
    } finally {
      await rm(session, { recursive: true });
      await rename(session + ".backup", session);
    }
    const failure = failed.structuredContent.error;
    assert.equal(failure.code, "session_storage");
    assert.equal(failure.applied, true);
    assert.equal(failure.revision, r + 4);
    assert.equal(failure.persistence.draft.state, "saved");
    assert.equal(failure.persistence.session.state, "failed");
    const retry = await tool("apply", mutation);
    assert.equal(retry.structuredContent.replayed, true);
    assert.equal(retry.structuredContent.sessionPersistence.state, "saved");
    assert.equal(
      JSON.parse(await readFile(session, "utf8")).project.name,
      "Recovered session",
    );
    const existing = (await tool("getProject")).structuredContent;
    const composed = await tool("apply", {
      ifRevision: r + 4,
      commands: [
        ...existing.nodes
          .filter((n) => n.parent === null)
          .map((n) => ({ op: "delete", id: n.id })),
        ...presets.structuredContent.toolbox,
        {
          op: "duplicate",
          id: "toolbox",
          newId: "second",
          assetMode: "linked",
        },
        {
          op: "assemblyParameters",
          root: "second",
          override: true,
          values: { openAngle: -90 },
        },
        { op: "detachBinding", id: "second-2", fields: ["rotation"] },
        { op: "group", ids: ["toolbox", "second"], newId: "rack" },
        {
          op: "assembly",
          definition: {
            root: "rack",
            parameters: { width: { value: 0.9 } },
            bindings: [
              { id: "toolbox", assetValues: { width: { $param: "width" } } },
              { id: "second", position: [1.2, 0, 0] },
            ],
          },
        },
      ],
    });
    assert.ok(!composed.isError, JSON.stringify(composed));
    const composedFile = JSON.parse(await readFile(session, "utf8"));
    assert.equal(composedFile.project.assemblies.length, 3);
    assert.equal(
      composedFile.project.assemblies.find((a) => a.root === "second")
        .parameters.width.value,
      0.9,
    );
    assert.equal(
      composedFile.project.nodes.find((n) => n.id === "second-2").rotation[0],
      -90,
    );
    const compactSetup = await tool("apply", {
      ifRevision: composed.structuredContent.revision,
      operationId: "mapped-recipe",
      commands: [
        {
          op: "create",
          id: "sphere",
          kind: "sphere",
          options: { segments: 64, rings: 32 },
        },
        {
          op: "recipe",
          id: "sphere",
          definition: {
            parameters: {},
            generator: { kind: "sphere", options: { segments: 64, rings: 32 } },
            steps: [],
          },
        },
        { op: "create", id: "refine", kind: "box" },
        {
          op: "recipe",
          id: "refine",
          definition: {
            parameters: { width: { value: 1 } },
            generator: {
              kind: "box",
              options: { size: [{ $param: "width" }, 1, 1] },
            },
            steps: [],
          },
        },
        {
          op: "recipeStep",
          id: "refine",
          action: "append",
          step: { op: "bevel", distance: 0.02 },
        },
        { op: "recipeParameters", id: "refine", values: { width: 1.5 } },
        { op: "duplicate", id: "refine", newId: "refined-copy" },
      ],
    });
    assert.ok(!compactSetup.isError, JSON.stringify(compactSetup));
    assert.deepEqual(compactSetup.structuredContent.results.at(-1).idMap, {
      refine: "refined-copy",
    });
    const compact = await tool("inspect", { id: "sphere" });
    assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 12000);
    assert.equal(compact.structuredContent.node.mesh, undefined);
    assert.equal(compact.structuredContent.node.faces, 2048);
    const stagePage = await tool("recipeStage", {
      id: "sphere",
      index: 0,
      query: { kind: "faces", limit: 7 },
      ifRevision: compactSetup.structuredContent.revision,
    });
    assert.ok(!stagePage.isError, JSON.stringify(stagePage));
    assert.equal(stagePage.structuredContent.step, null);
    assert.equal(stagePage.structuredContent.input.node.mesh, undefined);
    assert.equal(stagePage.structuredContent.components.items.length, 7);
    assert.ok(Buffer.byteLength(JSON.stringify(stagePage)) < 12000);
    const stageNext = await tool("recipeStage", {
      id: "sphere",
      index: 0,
      query: {
        kind: "faces",
        limit: 7,
        offset: 7,
        topology: stagePage.structuredContent.components.topology,
      },
      ifRevision: compactSetup.structuredContent.revision,
    });
    assert.equal(stageNext.structuredContent.components.offset, 7);
    assert.ok(
      stageNext.structuredContent.components.items.every(
        (f) =>
          !stagePage.structuredContent.components.items.some(
            (p) => p.id === f.id,
          ),
      ),
    );
    const denseRecipe = await tool("getRecipe", { id: "sphere" });
    assert.ok(Buffer.byteLength(JSON.stringify(denseRecipe)) < 4000);
    assert.equal(
      denseRecipe.structuredContent.recipe.generator.options.segments,
      64,
    );
    const proposed = {
      commands: [{ op: "set", id: "sphere", name: "Preview name" }],
      ifRevision: compactSetup.structuredContent.revision,
    };
    const compactPreview = await tool("preview", proposed);
    assert.ok(!compactPreview.isError, JSON.stringify(compactPreview));
    assert.equal(compactPreview.structuredContent.project, undefined);
    assert.equal(
      compactPreview.structuredContent.nodes.find((n) => n.node.id === "sphere")
        .node.faces,
      2048,
    );
    assert.ok(
      compactPreview.structuredContent.nodes.every(
        (n) => n.node.mesh === undefined,
      ),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(compactPreview)) < 80000);
    const fullPreview = await tool("preview", { ...proposed, detail: "full" });
    assert.equal(
      fullPreview.structuredContent.project.nodes.find((n) => n.id === "sphere")
        .name,
      "Preview name",
    );
    assert.equal(
      (await tool("inspect", { id: "sphere" })).structuredContent.node.name,
      "sphere",
    );
    const firstPage = (
      await tool("query", { id: "sphere", kind: "faces", limit: 10 })
    ).structuredContent;
    const nextPage = (
      await tool("query", {
        id: "sphere",
        kind: "faces",
        limit: 10,
        offset: firstPage.nextOffset,
        topology: firstPage.topology,
        ifRevision: firstPage.revision,
      })
    ).structuredContent;
    assert.equal(nextPage.offset, 10);
    assert.ok(
      nextPage.items.every((f) => !firstPage.items.some((v) => v.id === f.id)),
    );
    const rejectedSelection = await tool("apply", {
      ifRevision: compactSetup.structuredContent.revision,
      commands: [
        {
          op: "bevel",
          id: "sphere",
          distance: 0.01,
          select: { kind: "faces", normal: [0, 1, 0] },
        },
      ],
    });
    assert.equal(rejectedSelection.isError, true);
    assert.equal(
      (await tool("inspect")).structuredContent.revision,
      compactSetup.structuredContent.revision,
    );
    const receipt = JSON.parse(await readFile(session, "utf8")).receipts.find(
      ([id]) => id === "mapped-recipe",
    )[1];
    assert.deepEqual(receipt.result.results[0].idMap, {
      refine: "refined-copy",
    });
    const recipe = await tool("getRecipe", {
      id: "refine",
      index: 0,
      ifRevision: compactSetup.structuredContent.revision,
    });
    assert.deepEqual(recipe.structuredContent.step, {
      op: "bevel",
      distance: 0.02,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(recipe)) < 4000);
    const patched = await tool("apply", {
      ifRevision: recipe.structuredContent.revision,
      commands: [
        {
          op: "recipeStep",
          id: "refine",
          action: "patch",
          index: 0,
          patch: { distance: 0.03 },
        },
      ],
    });
    assert.ok(!patched.isError, JSON.stringify(patched));
    const failedRecipe = await tool("apply", {
      ifRevision: patched.structuredContent.revision,
      commands: [
        { op: "recipeParameters", id: "refine", values: { width: 0.01 } },
      ],
    });
    const detail = failedRecipe.structuredContent.error;
    assert.equal(failedRecipe.isError, true);
    assert.equal(detail.recipeStepIndex, 0);
    assert.equal(detail.recipeOperation, "bevel");
    assert.equal(detail.commandIndex, 0);
    assert.equal(detail.path, "nodes.refine.recipe.steps.0");
    assert.equal(detail.recipeArguments.distance, 0.03);
    assert.equal(detail.recipeParameters.width, 0.01);
    assert.equal(detail.applied, false);
    assert.equal(detail.revision, patched.structuredContent.revision);
    const transformed = await tool("apply", {
      ifRevision: patched.structuredContent.revision,
      commands: [
        {
          op: "recipeStep",
          id: "refine",
          action: "append",
          step: { op: "transform", scale: [2, 1, 1], translation: [0, 1, 0] },
        },
        { op: "set", id: "refine", position: [8, 0, 0] },
      ],
    });
    assert.ok(!transformed.isError, JSON.stringify(transformed));
    const final = (await tool("inspect", { id: "refine" })).structuredContent;
    assert.deepEqual(final.bounds.size, [3, 1, 1]);
    assert.deepEqual(final.bounds.center, [8, 1, 0]);
    const beforeObserve = (await tool("inspect")).structuredContent;
    const focused = await tool("observe", {
      ids: ["refine"],
      names: ["perspective"],
      size: 128,
      focus: true,
      helpers: false,
    });
    const target = focused.structuredContent.observations[0].camera.target;
    assert.ok(
      target.every((v, i) => Math.abs(v - final.bounds.center[i]) < 1e-6),
    );
    const afterObserve = (await tool("inspect")).structuredContent;
    assert.deepEqual(afterObserve.camera, beforeObserve.camera);
    assert.deepEqual(afterObserve.selection, beforeObserve.selection);
    const stage = await tool("recipeStage", {
      id: "refine",
      index: 0,
      query: { kind: "faces", normal: [0, 0, -1] },
      views: ["front"],
      size: 128,
      ifRevision: afterObserve.revision,
    });
    assert.ok(!stage.isError, JSON.stringify(stage));
    assert.equal(stage.structuredContent.coordinateSpace, "recipe");
    assert.equal(stage.structuredContent.input.node.faces, 6);
    assert.equal(stage.structuredContent.components.total, 1);
    assert.equal(stage.structuredContent.observations[0].camera.target[0], 8);
    assert.equal(
      stage.content.find((c) => c.type === "image").mimeType,
      "image/png",
    );
    const unchanged = (await tool("inspect")).structuredContent;
    assert.equal(unchanged.revision, afterObserve.revision);
    assert.deepEqual(unchanged.camera, afterObserve.camera);
    assert.deepEqual(unchanged.selection, afterObserve.selection);
    const inputPaint = await tool("apply", {
      ifRevision: unchanged.revision,
      commands: [
        {
          op: "recipeStep",
          id: "refine",
          action: "append",
          index: 0,
          step: {
            op: "paint",
            material: "ink",
            faces: [stage.structuredContent.components.items[0].ref],
          },
        },
      ],
    });
    assert.ok(!inputPaint.isError, JSON.stringify(inputPaint));
    const stageCopy = await tool("apply", {
      ifRevision: inputPaint.structuredContent.revision,
      commands: [{ op: "duplicate", id: "refine", newId: "stage-copy" }],
    });
    assert.ok(!stageCopy.isError, JSON.stringify(stageCopy));
    const copiedStep = await tool("getRecipe", { id: "stage-copy", index: 0 });
    assert.equal(copiedStep.structuredContent.step.faces[0].node, "stage-copy");
    assert.equal(
      copiedStep.structuredContent.step.faces[0].topology,
      stage.structuredContent.components.items[0].ref.topology,
    );
    const finalExport = await tool("exportGLB", { ids: ["refine"] });
    assert.ok(!finalExport.isError, JSON.stringify(finalExport));
    const primitiveState = (await tool("inspect")).structuredContent;
    const primitiveCreated = await tool("apply", {
      ifRevision: primitiveState.revision,
      commands: [
        {
          op: "create",
          id: "primitive",
          kind: "box",
          options: { size: [0.2, 0.5, 0.1] },
        },
      ],
    });
    assert.equal(
      (await tool("getRecipe", { id: "primitive" })).structuredContent.implicit,
      true,
    );
    const primitiveStage = await tool("recipeStage", {
      id: "primitive",
      index: 0,
      query: { kind: "faces", normal: [0, 1, 0] },
    });
    assert.equal(primitiveStage.structuredContent.components.total, 1);
    const promoted = await tool("apply", {
      ifRevision: primitiveCreated.structuredContent.revision,
      commands: [
        {
          op: "recipeStep",
          id: "primitive",
          action: "append",
          step: { op: "bevel", distance: 0.003 },
        },
        {
          op: "parameters",
          id: "primitive",
          options: { size: [0.2, 0.7, 0.1] },
        },
      ],
    });
    assert.ok(!promoted.isError, JSON.stringify(promoted));
    const promotedRecipe = (await tool("getRecipe", { id: "primitive" }))
      .structuredContent.recipe;
    assert.equal(promotedRecipe.steps.length, 1);
    assert.equal(promotedRecipe.generator.options.size[1], 0.7);
    const paintState = (await tool("inspect")).structuredContent;
    const knobCreated = await tool("apply", {
      ifRevision: paintState.revision,
      commands: [
        {
          op: "create",
          id: "painted-knob",
          kind: "cylinder",
          options: { segments: 8 },
        },
      ],
    });
    const cap = (
      await tool("query", {
        id: "painted-knob",
        kind: "faces",
        normal: [0, 1, 0],
      })
    ).structuredContent;
    const painted = await tool("apply", {
      ifRevision: knobCreated.structuredContent.revision,
      commands: [
        {
          op: "paint",
          id: "painted-knob",
          faces: cap.items.map((f) => f.ref),
          material: "orange",
        },
      ],
    });
    const segmentation = await tool("apply", {
      ifRevision: painted.structuredContent.revision,
      commands: [
        { op: "parameters", id: "painted-knob", options: { segments: 12 } },
      ],
    });
    assert.equal(segmentation.structuredContent.error.code, "stale_component");
    assert.equal(segmentation.structuredContent.error.applied, false);
    assert.equal(
      segmentation.structuredContent.error.revision,
      painted.structuredContent.revision,
    );
    const repair = segmentation.structuredContent.error.recovery;
    const cleared = await tool("apply", {
      ifRevision: painted.structuredContent.revision,
      commands: [...repair.commands, repair.retry],
    });
    assert.ok(!cleared.isError, JSON.stringify(cleared));
    const repairedCap = (
      await tool("query", {
        id: "painted-knob",
        kind: "faces",
        normal: [0, 1, 0],
      })
    ).structuredContent;
    assert.equal(repairedCap.items[0].material, "yellow");
    const scripted = await tool("apply", {
      ifRevision: cleared.structuredContent.revision,
      commands: [
        {
          op: "create",
          id: "scripted",
          kind: "mesh",
          mesh: primitive("box", { size: [0.2, 0.3, 0.1] }),
          position: [4, 0, 0],
        },
        {
          op: "recipeStep",
          id: "scripted",
          action: "append",
          step: { op: "bevel", distance: 0.003 },
        },
        {
          op: "duplicate",
          id: "scripted",
          newId: "scripted-copy",
          offset: [2, 0, 0],
        },
      ],
    });
    assert.ok(!scripted.isError, JSON.stringify(scripted));
    const refinedScript = await tool("apply", {
      ifRevision: scripted.structuredContent.revision,
      commands: [
        {
          op: "recipeStep",
          id: "scripted-copy",
          action: "patch",
          index: 0,
          patch: { distance: 0.005 },
        },
      ],
    });
    assert.ok(!refinedScript.isError, JSON.stringify(refinedScript));
    const change = (await tool("activity")).structuredContent.at(-1);
    assert.ok(
      change.fields.some(
        (f) =>
          f.path === "scripted-copy.recipe.steps.0.distance" &&
          f.before === 0.003 &&
          f.after === 0.005,
      ),
    );
    assert.equal(
      (await tool("getRecipe", { id: "scripted" })).structuredContent.recipe
        .steps[0].distance,
      0.003,
    );
    const scriptedExport = await tool("exportGLB", {
      ids: ["scripted-copy"],
      origin: "ground-center",
    });
    assert.ok(!scriptedExport.isError, JSON.stringify(scriptedExport));
    assert.equal(scriptedExport.structuredContent.report.validation.ok, true);
    const paletteState = (await tool("inspect")).structuredContent;
    const materialDraft = await tool("apply", {
      ifRevision: paletteState.revision,
      commands: [
        { op: "material", id: "dormant-color", color: "#884422" },
        {
          op: "recipeStep",
          id: "scripted-copy",
          action: "append",
          step: { op: "paint", enabled: false, material: "dormant-color" },
        },
        { op: "purgeMaterials" },
      ],
    });
    assert.ok(!materialDraft.isError, JSON.stringify(materialDraft));
    const palette = (await tool("inspect")).structuredContent;
    const dormant = palette.materials.find((m) => m.id === "dormant-color");
    assert.deepEqual(dormant.users, []);
    assert.deepEqual(dormant.retainedBy, ["scripted-copy"]);
    const rejectedRemoval = await tool("apply", {
      ifRevision: palette.revision,
      commands: [{ op: "removeMaterial", id: "dormant-color" }],
    });
    assert.equal(
      rejectedRemoval.structuredContent.error.code,
      "material_in_use",
    );
    const replacement = palette.materials.find(
      (m) => m.id !== "dormant-color",
    ).id;
    const replaced = await tool("apply", {
      ifRevision: palette.revision,
      commands: [{ op: "removeMaterial", id: "dormant-color", replacement }],
    });
    assert.ok(!replaced.isError, JSON.stringify(replaced));
    assert.deepEqual(replaced.structuredContent.removedMaterials, [
      "dormant-color",
    ]);
    const savedPalette = JSON.parse(await readFile(session, "utf8")).project;
    assert.ok(!savedPalette.materials.some((m) => m.id === "dormant-color"));
    assert.equal(
      savedPalette.nodes
        .find((n) => n.id === "scripted-copy")
        .recipe.steps.at(-1).material,
      replacement,
    );
    // A project file lands in the artifacts directory and opens again from its path.
    const projectFile = await tool("exportProject");
    assert.match(projectFile.structuredContent.artifact.path, /\.funmodel\.glb$/);
    const reopened = await tool("importGLB", {
      path: projectFile.structuredContent.artifact.path,
      ifRevision: replaced.structuredContent.revision,
    });
    assert.ok(!reopened.isError, JSON.stringify(reopened));
    assert.equal(reopened.structuredContent.container, true);
    assert.equal(
      reopened.structuredContent.revision,
      replaced.structuredContent.revision + 1,
    );
    assert.equal(reopened.structuredContent.persistence.state, "saved");
  } finally {
    const exit = once(child, "exit");
    child.stdin.end();
    await exit;
    await rm(dir, { recursive: true, force: true });
  }
  await protectedSessionChecks();
}
