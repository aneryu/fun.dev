import test from "node:test";
import assert from "node:assert/strict";
import { openWorkshop } from "../scripts/workshop-node.mjs";
import { emptyProject, createStore } from "../site/workshop/document.js";
import { queryComponents } from "../site/workshop/components.js";
import { executeAgentCall } from "../site/workshop/agent-call.js";
import { toolInvocation } from "../site/workshop/agent-tools.js";
import { scriptApi, runScript } from "../scripts/editor-script.mjs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentConnection } from "../site/workshop/agent-connection.js";
import { compareSourceValues } from "../site/workshop/export-integrity.js";
import { packMesh, DenseMesh } from "../site/workshop/dense.js";

test("source integrity detects metadata-only losses, numeric edits and bounded coverage", () => {
  const before = { nodes: [{ id: "eye", attachment: { target: "head", weights: [.2, .3, .5] } }],
    character: { clips: [{ name: "walk", keys: [0, 1] }], values: { blink: .4 } },
    relations: [{ id: "eye-contact", max: .01 }], references: { "version/1~": "a".repeat(200) } };
  assert.equal(compareSourceValues(before, structuredClone(before)).exact, true);
  const after = structuredClone(before);
  delete after.character;
  after.nodes[0].attachment.weights[0] += 1e-12;
  after.relations[0].max = .02;
  after.references["version/1~"] = "b".repeat(200);
  const report = compareSourceValues(before, after);
  assert.equal(report.status, "failed");
  assert.equal(report.complete, true);
  assert.equal(report.totalDifferences, 4);
  assert.ok(report.differences.some(d => d.path === "/character" && d.after.type === "missing"));
  assert.ok(report.differences.some(d => d.path === "/references/version~11~0" && d.before.truncated));
  const bounded = compareSourceValues(before, structuredClone(before), { maxValues: 2 });
  assert.equal(bounded.status, "incomplete");
  assert.equal(bounded.exact, false);
  const truncated = compareSourceValues(before, after, { maxDifferences: 1 });
  assert.equal(truncated.totalDifferences, 4);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.complete, true);
  assert.equal(compareSourceValues(new Float32Array([1, 2]), new Float32Array([1, 2])).exact, true);
  assert.equal(compareSourceValues(new Float32Array([1, 2]), new Float32Array([1, 3])).exact, false);
  assert.equal(compareSourceValues(Uint8Array.of(1, 2).buffer, Uint8Array.of(1, 3).buffer).exact, false);
});

test("assembly and character value grants preserve definitions and require explicit driven-node scope", async () => {
  const s = createStore(emptyProject());
  s.apply([{ op: "create", id: "head", kind: "box" }, { op: "group", ids: ["head"], newId: "rig" },
    { op: "create", id: "jaw", kind: "box" },
    { op: "assembly", definition: { root: "rig", parameters: { width: { value: 1 }, depth: { value: 1 } },
      bindings: [{ id: "head", options: { size: [{ $param: "width" }, 1, { $param: "depth" }] } }] } },
    { op: "characterControl", id: "open", bindings: [{ node: "jaw", channel: "rotation", delta: [20, 0, 0] }] },
    { op: "characterControl", id: "tilt", bindings: [{ node: "jaw", channel: "rotation", delta: [0, 10, 0] }] }]);
  const session = await openWorkshop({ record: { project: s.snapshot(), revision: 0 }, width: 64, height: 64 });
  try {
    const allowed = { assemblyParameters: { rig: ["width"] }, characterValues: ["open"], followers: ["head", "jaw"] };
    const commands = [{ op: "assemblyParameters", root: "rig", values: { width: 1.2 } },
      { op: "characterValues", values: { open: .5 } }];
    assert.ok(toolInvocation("fun_editor_workflow", { action: "prepare", ifRevision: 0, allowed, commands }));
    const prepare = args => session.api.workflow({ action: "prepare", views: [], allowed, ...args });
    assert.equal((await prepare({})).ok, true);
    const good = await prepare({ commands });
    assert.equal(good.ok, true, JSON.stringify(good.scope));
    assert.deepEqual(good.scope.parameterChanges, [
      { root: "rig", parameter: "width", before: 1, after: 1.2 }, { control: "open", before: 0, after: .5 },
    ]);
    const missingFollowers = await prepare({ commands, allowed: { ...allowed, followers: [] } });
    assert.equal(missingFollowers.ok, false);
    assert.ok(missingFollowers.scope.scopeIssues.some(i => i.code === "scope-node"));
    for (const command of [
      { op: "assemblyParameters", root: "rig", values: { depth: 1.1 } },
      { op: "characterValues", values: { tilt: .5 } },
      { op: "characterControl", id: "open", bindings: [{ node: "jaw", channel: "rotation", delta: [30, 0, 0] }] },
      { op: "set", id: "jaw", name: "unapproved" },
    ]) {
      const bad = await prepare({ commands: [...commands, command] });
      assert.equal(bad.ok, false);
      assert.ok(bad.scope.scopeIssues.some(i => ["scope-parameter-definition", "scope-parameter-output"].includes(i.code)));
    }
    assert.equal((await prepare({ commands, protectedIds: ["jaw"] })).ok, false);
    assert.equal((await prepare({ commands: [{ op: "set", id: "jaw", name: "unapproved" }] })).ok, false);
    assert.deepEqual(session.api.getProject(), s.snapshot());
  } finally { session.dispose(); }
});

test("recipe value grants reject definition/metadata edits and protected vertices take precedence", async () => {
  const s = createStore(emptyProject());
  s.apply([{ op: "create", id: "head", kind: "box" }, { op: "recipe", id: "head", definition: {
    parameters: { width: { value: 1, min: .5, max: 2 }, depth: { value: 1, min: .5, max: 2 } },
    generator: { kind: "box", material: "yellow", options: { size: [{ $param: "width" }, 1, { $param: "depth" }] } },
    steps: [],
  } }]);
  const session = await openWorkshop({ record: { project: s.snapshot(), revision: 0 }, width: 64, height: 64 });
  try {
    const options = { action: "prepare", views: [], allowed: { parameters: { head: ["width"] } } };
    const good = await session.api.workflow({ ...options,
      commands: [{ op: "recipeParameters", id: "head", values: { width: 1.2 } }] });
    assert.equal(good.ok, true);
    assert.deepEqual(good.scope.parameterChanges, [{ node: "head", parameter: "width", before: 1, after: 1.2 }]);
    for (const command of [
      { op: "recipeParameters", id: "head", values: { depth: 1.2 } },
      { op: "set", id: "head", name: "Unapproved name" },
      { op: "set", id: "head", rotation: [0, 5, 0] },
    ]) {
      const result = await session.api.workflow({ ...options, commands: [command] });
      assert.equal(result.ok, false);
      assert.ok(result.scope.scopeIssues.some(i => i.code === "scope-parameter-output"));
    }
    const protectedResult = await session.api.workflow({ ...options, protectedVertices: { head: [0] },
      commands: [{ op: "recipeParameters", id: "head", values: { width: 1.2 } }] });
    assert.equal(protectedResult.ok, false);
    assert.ok(protectedResult.scope.scopeIssues.some(i => i.code === "protected-vertices" && i.vertices.includes(0)));
    assert.deepEqual(session.api.getProject(), s.snapshot());
  } finally { session.dispose(); }
});

test("failed candidate preserves project, selection, history and editable state; diagnostics retain failing geometry", async () => {
  const session = await openWorkshop({ width: 300, height: 300 });
  const api = session.api;
  try {
    const baseline = api.getProject(), state = api.inspect();
    const s = createStore(emptyProject());
    s.apply([{ op: "create", id: "mouth_cavity", kind: "box", options: { size: [0.72, 0.4, 0.46] } },
      { op: "inset", id: "mouth_cavity", face: "f5", distance: 0.035 },
      { op: "extrude", id: "mouth_cavity", face: "f5", distance: -0.31 }]);
    const edge = queryComponents(s.snapshot(), { id: "mouth_cavity", kind: "edges", at: { axis: "y", value: -0.2 } })
      .items.find(e => e.endpoints.every(p => p[2] === -0.23));
    const result = await api.workflow({ action: "prepare", project: s.snapshot(), commands: [
      { op: "bevel", id: "mouth_cavity", edges: [edge.ref], distance: 0.3 },
    ] });
    assert.equal(result.ok, false);
    assert.equal(result.applied, false);
    assert.equal(result.partialCommit, false);
    assert.ok(result.diagnostics.some(i => i.code === "self-intersection" && i.faceGeometry.length && i.worldPoint));
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].candidateId, result.candidateId);
    assert.deepEqual(api.getProject(), baseline);
    assert.deepEqual(api.inspect().selection, state.selection);
    assert.equal(api.inspect().revision, state.revision);
    assert.throws(() => api.acceptCandidate({ candidateId: result.candidateId, ifRevision: state.revision, operationId: "bad" }));
    api.apply([{ op: "set", id: "body", name: "still editable" }]);
    api.undo();
    assert.deepEqual(api.getProject(), baseline);
  } finally { session.dispose(); }
});

test("candidate reports and caller inputs cannot mutate retained validated state", async () => {
  const store = createStore(emptyProject());
  store.apply([{ op: "create", id: "body", kind: "box" }, { op: "create", id: "beak", kind: "box", position: [2, 0, 0] },
    { op: "convert", id: "body" },
    { op: "relation", definition: { id: "gap", kind: "distance", source: "beak", target: "body", vertices: [0], min: 0, max: 5 } }]);
  const input = store.snapshot(); input.nodes[0].mesh = packMesh(input.nodes[0].mesh);
  // Relations do not support dense targets; retain the dense-body case separately below.
  delete input.relations;
  const session = await openWorkshop({ record: { project: store.snapshot(), revision: 0 }, width: 64, height: 64 });
  const api = session.api;
  try {
    const baseline = api.getProject(), provenance = { reference: { version: "approved" } };
    const prepared = await api.workflow({ action: "prepare", detail: "full", views: [], protectedIds: ["body"], provenance,
      commands: [{ op: "set", id: "beak", name: "Approved edit" }] });
    assert.equal(prepared.ok, true);
    provenance.reference.version = "changed input";
    const tamper = report => {
      report.project.nodes.find(n => n.id === "body").name = "BYPASSED";
      report.scope.protectedIds.length = 0;
      report.scope.changed.push("body");
      report.relations.results[0].status = "failed";
      report.provenance.reference.version = "changed output";
    };
    tamper(prepared);
    const inspected = await api.workflow({ action: "inspect", candidateId: prepared.candidateId, detail: "full", views: [] });
    assert.deepEqual(inspected.scope.protectedIds, ["body"]);
    assert.equal(inspected.relations.results[0].status, "passed");
    assert.equal(inspected.provenance.reference.version, "approved");
    assert.equal(inspected.project.nodes.find(n => n.id === "body").name, baseline.nodes[0].name);
    tamper(inspected);
    const acceptArgs = { candidateId: prepared.candidateId, ifRevision: prepared.baseRevision, operationId: "isolated-report" };
    const accepted = api.acceptCandidate(acceptArgs), acceptedRevision = accepted.revision;
    accepted.revision = -123;
    accepted.scope.protectedIds.length = 0;
    const receipt = api.operationStatus({ operationId: acceptArgs.operationId });
    assert.equal(receipt.receipt.revision, acceptedRevision);
    assert.deepEqual(receipt.receipt.scope.protectedIds, ["body"]);
    assert.equal(api.acceptCandidate(acceptArgs).revision, acceptedRevision);
    assert.deepEqual((await api.workflow({ action: "inspect", candidateId: prepared.candidateId, views: [] })).scope.protectedIds, ["body"]);
    assert.deepEqual(api.getProject().nodes.find(n => n.id === "body"), baseline.nodes[0]);
    assert.equal(api.getProject().nodes.find(n => n.id === "beak").name, "Approved edit");
    api.undo(); assert.deepEqual(api.getProject(), baseline);

    const dense = await api.workflow({ action: "prepare", project: input, detail: "full", views: [] });
    assert.equal(dense.ok, true);
    const original = input.nodes[0].mesh.dense.positions[0];
    input.nodes[0].mesh.dense.positions[0] += 100;
    assert.ok(dense.project.nodes[0].mesh instanceof DenseMesh);
    dense.project.nodes[0].mesh.dense.positions[0] += 200;
    const denseAgain = await api.workflow({ action: "inspect", candidateId: dense.candidateId, detail: "full", views: [] });
    assert.equal(denseAgain.project.nodes[0].mesh.dense.positions[0], original);
    api.acceptCandidate({ candidateId: dense.candidateId, ifRevision: dense.baseRevision, operationId: "isolated-dense" });
    assert.equal(api.getProject().nodes[0].mesh.dense.positions[0], original);
  } finally { session.dispose(); }
});

test("scope protects ancestors and material users; acceptance is one undo step and retry safe", async () => {
  const session = await openWorkshop({ width: 300, height: 300 }), api = session.api;
  try {
    const baseline = api.getProject();
    const blocked = await api.workflow({ action: "prepare", protectedIds: ["wing-left"],
      commands: [{ op: "transform", id: "body", translation: [1, 0, 0] }] });
    assert.equal(blocked.scope.ok, false);
    assert.ok(blocked.scope.violations.includes("wing-left"));
    const material = baseline.nodes.find(n => n.id === "body").mesh.faces[0].material;
    const paint = await api.workflow({ action: "prepare", protectedIds: ["body"],
      commands: [{ op: "material", id: material, color: "#112233" }] });
    assert.equal(paint.ok, false);
    assert.ok(paint.scope.violations.includes("body"));
    const candidate = await api.workflow({ action: "prepare", protectedIds: ["body"],
      commands: [{ op: "set", id: "beak", name: "new beak" }] });
    assert.equal(candidate.ok, true);
    const args = { candidateId: candidate.candidateId, ifRevision: candidate.baseRevision, operationId: "accept-once" };
    assert.ok(toolInvocation("fun_editor_operationStatus", { operationId: args.operationId }));
    assert.equal(api.operationStatus({ operationId: args.operationId }).status, "unknown");
    const first = api.acceptCandidate(args), retry = api.acceptCandidate(args);
    assert.equal(first.revision, retry.revision);
    assert.equal(retry.replayed, true);
    const receipt = api.operationStatus({ operationId: args.operationId });
    assert.equal(receipt.status, "recorded");
    assert.equal(receipt.receipt.revision, first.revision);
    assert.equal(receipt.draftId, api.inspect().draftId);
    receipt.receipt.revision = -1;
    assert.equal(api.operationStatus({ operationId: args.operationId }).receipt.revision, first.revision);
    api.undo(); assert.deepEqual(api.getProject(), baseline);
    assert.throws(() => api.acceptCandidate({ ...args, operationId: "stale" }), /changed/);
  } finally { session.dispose(); }
});

test("closed allow-list rejects implicit descendants and project fields; vertex regions report exact violations", async () => {
  const session = await openWorkshop({ width: 128, height: 128 }), api = session.api;
  try {
    const p = api.getProject();
    const moved = await api.workflow({ action: "prepare", allowed: { nodes: ["body"] },
      commands: [{ op: "transform", id: "body", translation: [0.1, 0, 0] }] });
    assert.equal(moved.ok, false);
    assert.ok(moved.scope.scopeIssues.some(i => i.code === "scope-node" && i.node !== "body"));
    const renamed = structuredClone(p); renamed.name = "not authorized";
    const field = await api.workflow({ action: "prepare", project: renamed, allowed: { nodes: [] } });
    assert.ok(field.scope.scopeIssues.some(i => i.path === "name"));
    // Use an independent mesh so the region check is not obscured by recipe evaluation.
    const s = createStore(emptyProject());
    s.apply([{ op: "create", id: "box", kind: "box" }, { op: "convert", id: "box" }]);
    api.loadProject(s.snapshot());
    const changed = api.getProject();
    changed.nodes[0].mesh.vertices[0][0] -= 0.02;
    const outside = await api.workflow({ action: "prepare", project: changed, allowed: { vertices: { box: [1] } } });
    assert.ok(outside.scope.scopeIssues.some(i => i.vertices?.includes(0)));
    const inside = await api.workflow({ action: "prepare", project: changed, allowed: { vertices: { box: [0] } } });
    assert.equal(inside.scope.ok, true);
  } finally { session.dispose(); }
});

test("retained candidate images keep their model revision after live edits", async () => {
  const session = await openWorkshop({ width: 128, height: 128 }), api = session.api;
  try {
    const candidate = await api.workflow({ action: "prepare" });
    api.apply([{ op: "set", id: "body", name: "Later edit" }]);
    const inspected = await api.workflow({ action: "inspect", candidateId: candidate.candidateId, views: ["front"], size: 64 });
    assert.equal(inspected.stale, true);
    assert.equal(inspected.revision, api.inspect().revision);
    assert.equal(inspected.observations[0].revision, candidate.baseRevision);
    await api.workflow({ action: "surface", candidateId: candidate.candidateId,
      query: { observation: inspected.observations[0], pixel: [32, 32] } });
    await assert.rejects(api.workflow({ action: "surface", candidateId: candidate.candidateId,
      query: { observation: { ...inspected.observations[0], draftId: "another-document" }, pixel: [32, 32] } }), /different revision/);
  } finally { session.dispose(); }
});

test("fit translates a contact anchor in world space through a rotated parent", async () => {
  const session = await openWorkshop({ width: 300, height: 300 }), api = session.api;
  const dir = await mkdtemp(join(tmpdir(), "workshop-fit-"));
  const { ws } = scriptApi(async (name, args) => {
    const r = await executeAgentCall(api, toolInvocation(name, args));
    return { isError: !r.ok, structuredContent: r.ok ? r.result : { error: r.error } };
  }, dir);
  try {
    await ws.replace({ name: "Empty candidate" });
    await ws.replace({ commands: [
      { op: "create", id: "target", kind: "box" },
      { op: "create", id: "parent", kind: "group", rotation: [0, 0, 90] },
      { op: "create", id: "eye", parent: "parent", kind: "sphere", position: [0, -2, 0], options: { radius: 0.1 } },
    ] });
    await ws.fit({ id: "eye", at: [2, 0, 0], targets: ["target"], offset: -0.02 });
    const n = await ws.inspect({ id: "eye" });
    assert.ok(Math.abs(n.worldMatrix[12] - 0.48) < 1e-8);
    assert.ok(Math.abs(n.worldMatrix[13]) < 1e-8);
    await assert.rejects(ws.apply([{ op: "delete", id: "missing" }]), e => e.info.partialCommit === true && !!e.info.diagnosticsFile);
  } finally { session.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("connection reports unknown acknowledgement without replaying a write", async () => {
  const previous = { fetch: globalThis.fetch, location: globalThis.location, sessionStorage: globalThis.sessionStorage };
  let writes = 0, done;
  const event = new Promise(resolve => { done = resolve; });
  globalThis.location = { origin: "https://example.test", pathname: "/workshop/" };
  globalThis.sessionStorage = { setItem() {}, removeItem() {} };
  globalThis.fetch = async url => {
    if (url.endsWith("/result")) throw new Error("lost acknowledgement");
    return { ok: true, json: async () => url.endsWith("/poll") ?
      { id: "one", call: { method: "apply", args: [[], {}] } } : {} };
  };
  const connection = createAgentConnection({ api: {
    inspect: () => ({ name: "model", revision: writes, draftId: "draft", writable: true }),
    apply: () => ({ revision: ++writes }), flush: async () => ({ state: "saved" }),
  }, onChange: e => { if (e.state === "error") done(e); } });
  try {
    await connection.connect("http://127.0.0.1:1234/#" + "a".repeat(64));
    const result = await event;
    assert.equal(result.reason, "result_unknown");
    assert.equal(result.draftId, "draft");
    assert.equal(result.revision, 1);
    assert.equal(writes, 1);
    assert.equal(connection.connected, false);
  } finally { Object.assign(globalThis, previous); }
});

test("surface hits, normal offsets, interior segment gaps and observation provenance", async () => {
  const session = await openWorkshop({ width: 300, height: 300 }), api = session.api;
  try {
    const s = createStore(emptyProject());
    s.apply([{ op: "create", kind: "box", id: "left", position: [-1, 0, 0] },
      { op: "create", kind: "box", id: "right", position: [1, 0, 0] }]);
    api.loadProject(s.snapshot());
    const query = q => api.workflow({ action: "surface", query: q });
    const hit = await query({ ids: ["left"], at: [-1, 1, 0], offset: -0.1 });
    assert.deepEqual(hit.normal, [0, 1, 0]);
    assert.ok(Math.abs(hit.offsetPoint[1] - 0.4) < 1e-8);
    const contact = await query({ ids: ["left", "right"], path: [[-1, 0.5, 0], [1, 0.5, 0]], spacing: 0.1, tolerance: 0.01 });
    assert.equal(contact.samples[0].distance, 0);
    assert.equal(contact.samples.at(-1).distance, 0);
    assert.ok(contact.gaps > 0, "endpoints alone would miss the interior gap");
    assert.equal(contact.coverage.continuousProof, false);
    const observation = { ...api.renderViews(["front"], { size: 128, ids: ["left"] })[0], candidateId: null };
    const pixel = await query({ observation, pixel: [64, 64] });
    assert.equal(pixel.node, "left");
    assert.equal((await query({ observation, pixel: [-1, 0] })).reason, "pixel-outside-image");
    api.apply([{ op: "set", id: "left", name: "changed" }]);
    await assert.rejects(query({ observation, pixel: [64, 64] }), /different revision/);
  } finally { session.dispose(); }
});

test("script failure artifacts, validation coverage, fixed comparison and isolated roundtrip", async () => {
  const session = await openWorkshop({ width: 300, height: 300 }), api = session.api;
  const dir = await mkdtemp(join(tmpdir(), "workshop-workflow-"));
  const comparisonCalls = [];
  const invoke = async (name, args) => {
    if (name === "fun_editor_workflow" && args.action === "inspect" && args.views?.includes("current")) {
      comparisonCalls.push(structuredClone(args));
      // The first current-view observation may have a different height from
      // the next viewport default. Render that actual size and require reuse.
      if (comparisonCalls.length === 1) args = { ...args, render: { ...args.render, height: 96 } };
    }
    const response = await executeAgentCall(api, toolInvocation(name, args));
    return { isError: !response.ok, structuredContent: response.ok ? response.result : { error: response.error } };
  };
  const { ws } = scriptApi(invoke, dir);
  try {
    const original = api.getProject(), state = api.inspect();
    const report = await ws.verifyExport();
    assert.equal(report.editable.scope.changed.length, 0);
    assert.equal(report.editable.integrity.exact, true, JSON.stringify(report.editable.integrity));
    assert.equal(report.editable.integrity.stored.status, "passed");
    assert.equal(report.editable.integrity.evaluated.status, "passed");
    assert.deepEqual(api.getProject(), original);
    assert.deepEqual(api.inspect().camera, state.camera);
    assert.deepEqual(api.inspect().selection, state.selection);
    assert.equal((await ws.validate()).checks.minimumWallThickness, false);
    await assert.rejects(ws.replace({ commands: [{ op: "delete", id: "missing" }] }), /Unknown/);
    assert.deepEqual(api.getProject(), original);
    const baseline = await ws.candidate();
    const candidate = await ws.candidate({ commands: [{ op: "transform", id: "beak", translation: [0, 0, 0.05] }] });
    const result = await ws.compare({ baseline, candidate, views: { mouth: { view: "current", ids: ["beak"], size: 128 } } });
    assert.equal(comparisonCalls[1].render.height, 96);
    assert.deepEqual(result.records.map(r => [r.width, r.height]), [[128, 96], [128, 96]]);
    assert.deepEqual(result.records[0].camera, result.records[1].camera);
    assert.deepEqual(result.records[0].quality, result.records[1].quality);
    assert.match(await readFile(result.file, "utf8"), /真实模型渲染/);
    assert.deepEqual(api.inspect().camera, state.camera);
    assert.deepEqual(api.getProject(), original);
    const script = join(dir, "throws.mjs");
    await writeFile(script, 'export default async ws => { await ws.apply([{op:"set",id:"beak",name:"committed"}]); throw new Error("script stopped"); }');
    await assert.rejects(runScript(script, invoke), e => e.info.partialCommit === true && e.info.message === "script stopped");
  } finally { session.dispose(); await rm(dir, { recursive: true, force: true }); }
});
