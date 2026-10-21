import { evaluateProject, evaluateTransaction, validateProject, ModelError, statistics } from "./document.js";
import { errorInfo } from "./agent-contract.js";
import { surfaceDiagnostics } from "./diagnostics.js";
import { surfaceQuery, scopeReport } from "./inspection.js";
import { DenseMesh, isDense, isolate } from "./dense.js";
import { exportAsset } from "./viewport.js";
import { projectFile } from "./project-file.js";
import { importModel } from "./import-glb.js";
import { worldMatrix, point, nodeInfo } from "./spatial.js";
import { checkRelations } from "./relation-checks.js";
import { designReferenceSummary } from "./design-references.js";
import { resolveViewPreset } from "./view-presets.js";
import { compareSourceValues } from "./export-integrity.js";
import { volumeOverlayProject } from "./relation-volume.js";

// A small bounded inspection cache, separate from history and durable checkpoints.
// A candidate is accepted with store.replace only after validation and revision checks.
export async function candidateWorkflow({ args, store, draft, viewport, candidates }) {
  return inspectionCopy(await runCandidateWorkflow({ args, store, draft, viewport, candidates }));
}

// Public reports and caller-owned inputs must never alias the validated candidate.
// DenseMesh needs its own array copy while retaining its JSON encoding and readers.
function inspectionCopy(value) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof DenseMesh) return isolate(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return structuredClone(value);
  if (Array.isArray(value)) return value.map(inspectionCopy);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inspectionCopy(item)]));
}

async function runCandidateWorkflow({ args, store, draft, viewport, candidates }) {
  const { action = "prepare", candidateId, commands, project: input, protectedIds = [], detail,
    views, size = 256, render = {}, query = {} } = args;
  const stamp = { revision: store.revision, draftId: draft.id };
  let candidate = candidateId && candidates.get(candidateId);
  if (candidateId && !candidate) throw new ModelError("Candidate expired; prepare it again", "not_found");
  if (action === "prepare") {
    const baseline = store.snapshot();
    let project = baseline, error = null, results = [];
    try {
      if (input) project = evaluateProject(input);
      if (commands?.length) ({ project, results } = evaluateTransaction(project, commands, { strictComponents: true }));
    } catch (e) {
      error = errorInfo(e);
      project = e.candidateProject ?? project;
    }
    const validation = validateProject(project);
    const relations = checkRelations(project);
    const scope = scopeReport(baseline, project, protectedIds, args.allowed, args.protectedVertices);
    candidate = inspectionCopy({ id: crypto.randomUUID(), baseRevision: store.revision, project, error, validation, scope, relations,
      results, ok: !error && validation.ok && scope.ok && relations.ok,
      provenance: args.provenance ?? null, createdAt: new Date().toISOString() });
    candidates.set(candidate.id, candidate);
    while (candidates.size > 3) candidates.delete(candidates.keys().next().value);
  }
  const project = candidate?.project ?? store.snapshot();
  const identity = { ...stamp, candidateId: candidate?.id ?? null, baseRevision: candidate?.baseRevision ?? store.revision,
    modelRevision: candidate?.baseRevision ?? store.revision,
    stale: !!candidate && candidate.baseRevision !== store.revision,
    designReferences: designReferenceSummary(project),
    provenance: candidate?.provenance ?? null };
  if (action === "surface") {
    if (query.observation && ((query.observation.candidateId ?? null) !== identity.candidateId ||
        (query.observation.draftId && query.observation.draftId !== identity.draftId) ||
        query.observation.revision !== identity.modelRevision))
      throw new ModelError("Observation belongs to a different revision or candidate", "conflict");
    const targets = query.ids ?? query.observation?.observation?.visibleIds;
    if (targets && !targets.length) return { ...identity, hit: false, reason: "no-visible-targets", space: "world" };
    return { ...identity, ...surfaceQuery(project, { ...query, ...(targets?.length ? { ids: targets } : {}) }) };
  }
  if (action === "relations") return { ...identity, ...checkRelations(project, query) };
  if (action === "verifyRuntime") {
    if(typeof query.data!=="string"||!query.data.length||query.data.length>Math.ceil(32*1024*1024/3)*4||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(query.data))
      throw new ModelError("query.data must be base64 fun3d bytes, at most 32 MiB decoded", "schema", "query.data");
    const {inspectRuntimeRelations}=await import("./runtime-inspection.js");
    const bytes=Uint8Array.from(atob(query.data),c=>c.charCodeAt(0));
    const report=await inspectRuntimeRelations(project,bytes,{...query,detail});
    return {...identity,...report,currentUnchanged:store.revision===stamp.revision,
      stale:identity.stale||store.revision!==stamp.revision};
  }
  if (action === "verifyExport") {
    const { buffer, report } = await exportAsset(project, {});
    const editable = importModel(await projectFile(project));
    const evaluatedEditable = evaluateProject(editable.project);
    const storedIntegrity = compareSourceValues(project, editable.project);
    const evaluatedIntegrity = compareSourceValues(project, evaluatedEditable);
    const generic = importModel(new Uint8Array(buffer));
    const describe = p => ({ stats: statistics(p), nodes: p.nodes.map(n => ({
      id: n.id, parent: n.parent, position: n.position, rotation: n.rotation, scale: n.scale,
      bounds: nodeInfo(p, n.id, { components: false }).bounds,
      vertices: n.mesh?.vertices.length ?? 0, faces: n.mesh?.faces.length ?? 0,
      morph: n.morph ? { targets: n.morph.targets.map(t => t.name), weights: n.morph.weights } : null,
    })), materials: p.materials });
    return { ...identity, currentUnchanged: store.revision===stamp.revision,
      stale: identity.stale||store.revision!==stamp.revision, report,
      editable: { ...describe(editable.project), scope: scopeReport(project, evaluatedEditable),
        integrity: { exact: storedIntegrity.exact && evaluatedIntegrity.exact,
          stored: storedIntegrity, evaluated: evaluatedIntegrity } },
      generic: { ...describe(generic.project), scope: scopeReport(project, evaluateProject(generic.project)), warnings: generic.warnings, processing: generic.processing },
      interpretation: { countsAloneProveDamage: false,
        editableEquality: "Use editable.integrity.exact, not an empty activity/scope summary. Stored and re-evaluated source values are checked independently.",
        importProcessing: ["position welding", "coplanar triangle polygonization", "degenerate triangle removal"],
        exportProcessing: ["triangulation", "position and normal tuple indexing"],
        exactCauseOfCountDifference: "generic.processing records welding losses and polygonization triangle deltas per mesh." } };
  }
  if (!["prepare", "inspect", "diagnose"].includes(action)) throw new ModelError("Unknown workflow action", "schema");
  const validation = candidate?.validation ?? validateProject(project);
  const relations = candidate?.relations ?? checkRelations(project);
  const relationIssues = relations.results.flatMap(r => [...r.samples,...(r.boundary?.samples??[])]
    .filter(s => s.status === "failed").map(s => {
      const surface=Array.isArray(s.vertices);
      const targetMesh=r.volume?.mesh??project.nodes.find(n=>n.id===r.target)?.mesh;
      return {code:"relation",relation:r.id,node:r.source,target:r.target,
        ...(surface?{vertices:s.vertices,face:s.face,targetFace:s.target.face,point:s.point,space:"world",contactKind:s.kind,
          contactGeometry:s.contactGeometry,
          ...(s.rejectedBounds?{rejectedBounds:s.rejectedBounds,sourceLocalContact:s.sourceLocalContact}:{}),
          targetGeometry:{face:s.target.face,space:"world",virtual:!!r.volume,points:s.target.vertices.map(i=>
            point(worldMatrix(project,r.target),targetMesh.vertices[i]))}}:
          {vertices:[s.vertex],point:project.nodes.find(n=>n.id===r.source)?.mesh.vertices[s.vertex]}),
        actual:s.actual,units:surface?"count":r.units,positionUnits:"metres",
        threshold:surface?(r.boundary?.threshold??r.threshold):r.threshold,
        message:surface?"Unapproved surface intersection":`${r.kind} outside declared interval`};
    }));
  const issues = [...validation.errors, ...validation.warnings, ...(candidate?.error?.issues ?? []), ...relationIssues];
  const nodes = [...new Set(issues.flatMap(i => [i.node, i.target]).filter(Boolean))];
  const surfaces = action === "diagnose" ? project.nodes.filter(n => n.mesh && (!query.ids || query.ids.includes(n.id))).map(n => ({
    node: n.id, space: "local", ...(isDense(n.mesh) ? { checked: false, reason: "dense-mesh" } :
      { checked: true, ...surfaceDiagnostics(n.mesh, { maxIssues: 1000, maxOverlaps: 1000 }),
        worldMatrix: worldMatrix(project, n.id) }),
  })) : undefined;
  const diagnostics = issues.map(issue => {
    const n = project.nodes.find(n => n.id === issue.node);
    const space = issue.space ?? "local";
    const frameId = space === "target-local" ? issue.target : space === "local" ? n?.id : null;
    const worldPoint = issue.point && (space === "world" ? issue.point :
      frameId && project.nodes.some(node => node.id === frameId) ? point(worldMatrix(project, frameId), issue.point) : null);
    return { ...issue, space, candidateId: identity.candidateId,
      ...(worldPoint ? { worldPoint } : {}),
      ...(n?.mesh && !isDense(n.mesh) ? { faceGeometry: n.mesh.faces.filter(f => (issue.faces ?? [issue.face]).includes(f.id)).map(f => ({
        ...f, space:"local", points: f.vertices.map(i => n.mesh.vertices[i]),
        edges: f.vertices.map((a, i) => [a, f.vertices[(i + 1) % f.vertices.length]]),
      })) } : {}) };
  });
  let observations = [], renderError;
  const savedView = render.preset ? resolveViewPreset(project, render.preset) : null;
  const requested = savedView ? [savedView.view] : views ?? (action !== "inspect" && candidate && !candidate.ok && nodes.length ? ["perspective"] : []);
  if (requested.length) {
    const id = nodes[0], faces = [...new Set(issues.filter(i => i.node === id).flatMap(i => i.faces ?? [i.face]).filter(Boolean))];
    const vertices = [...new Set(issues.filter(i => i.node === id).flatMap(i => i.vertices ?? []))];
    try {
      const display=query.showVolumes?volumeOverlayProject(project,relations.results):{project,ids:[]};
      const baseIds=render.ids??savedView?.render?.ids??(nodes.length&&action!=="inspect"?nodes:null);
      observations = viewport.renderProject(display.project, requested, args.size ?? savedView?.size ?? size, {
        visibility: "all", helpers: false, ...(savedView?.render ?? {}), ...(nodes.length && action !== "inspect" ? { ids: nodes,
          selection: { id, ids: [id], mode: faces.length ? "face" : "vertex", faces, edges: [], vertices },
          overlays: { selection: true, wire: true } } : {}), ...render,
        ...(display.ids.length&&baseIds?{ids:[...baseIds,...display.ids]}:{}),
      }).map(shot => ({ ...shot, ...identity, revision: identity.modelRevision, preview: !!candidate,
        ...(savedView ? { viewPreset: savedView.metadata } : {}) }));
    } catch (e) { renderError = errorInfo(e); }
  }
  return { ...identity, ok: candidate?.ok ?? (validation.ok && relations.ok), applied: false, partialCommit: false,
    candidateComplete: !candidate?.error, error: candidate?.error, validation, diagnostics, surfaces, relations,
    scope: candidate?.scope, results: candidate?.results, observations, renderError,
    ...(detail === "full" ? { project } : {}) };
}
