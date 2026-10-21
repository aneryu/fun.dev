import { Vector3, Triangle, Ray } from "/runtime/three.js";
import { triangulate } from "./mesh.js";
import { worldMatrix, point, determinant } from "./spatial.js";
import { connectivityToken } from "./components.js";
import { checkSurfaceRelation } from "./surface-relations.js";
import { relationVolume, volumeSourceCoverage } from "./relation-volume.js";

// Sampling is explicit. Passing this check never asserts whole-mesh collision,
// containment, continuous contact or a global minimum wall thickness.
export function checkRelations(project, { maxTests = 2000000 } = {}) {
  if (!Number.isInteger(maxTests) || maxTests < 1 || maxTests > 2000000) throw new Error("maxTests must be 1–2000000");
  const cache = new Map(), results = [];
  let tests = 0;
  for (const r of project.relations ?? []) {
    const source = project.nodes.find(n => n.id === r.source), target = project.nodes.find(n => n.id === r.target);
    if (!source?.mesh || !target?.mesh || connectivityToken(source.mesh) !== r.connectivity ||
        (["surfaceIntersection","insideVolume"].includes(r.kind) && connectivityToken(target.mesh)!==r.targetConnectivity)) {
      results.push({ id: r.id, kind:r.kind, status: "not_checked", reason: "missing-or-stale-geometry", samples: [], retryable: false });
      continue;
    }
    if (r.kind==="surfaceIntersection") {
      try { results.push(checkSurfaceRelation(project,r,()=>++tests<=maxTests)); }
      catch(error) { results.push({id:r.id,kind:r.kind,source:r.source,target:r.target,status:"not_checked",
        reason:"surface-triangulation-failed",message:error.message,samples:[],retryable:false}); }
      continue;
    }
    let targetMesh=target.mesh, volume;
    if(r.kind==="insideVolume") {
      volume={...relationVolume(target,r.volume,{maxPairs:maxTests-tests}),
        space:"target-local",target:r.target,worldMatrix:worldMatrix(project,r.target)};
      tests+=volume.testedPairs;
      if(volume.status!=="passed") {
        results.push({id:r.id,kind:r.kind,source:r.source,target:r.target,status:volume.status,
          reason:volume.reason,volume,samples:[],retryable:volume.status==="incomplete"});
        continue;
      }
      targetMesh=volume.mesh;
    }
    const cacheKey=volume?r:target.id;
    if (!cache.has(cacheKey)) {
      const transform = worldMatrix(project, target.id);
      const vertices = targetMesh.vertices.map(v => new Vector3(...point(transform, v)));
      cache.set(cacheKey, targetMesh.faces.flatMap(f => triangulate(targetMesh.vertices, f.vertices).map(indices => ({
        face: f.id, indices, triangle: new Triangle(...indices.map(i => vertices[i])),
        sign: determinant(transform) < 0 ? -1 : 1,
      }))));
    }
    const triangles = cache.get(cacheKey), samples = [], transform = worldMatrix(project, source.id);
    const containment=["inside","insideVolume"].includes(r.kind);
    if (containment) {
      const edges = new Map();
      for (const face of targetMesh.faces) face.vertices.forEach((a, i) => {
        const b = face.vertices[(i + 1) % face.vertices.length], key = a < b ? `${a}:${b}` : `${b}:${a}`;
        const edge = edges.get(key) ?? { count: 0, direction: 0 };
        edge.count++; edge.direction += a < b ? 1 : -1; edges.set(key, edge);
      });
      if ([...edges.values()].some(e => e.count !== 2 || e.direction !== 0)) {
        results.push({ id: r.id, kind: r.kind, source: r.source, target: r.target,
          status: "not_checked", reason: "target-not-closed-oriented-shell", samples: [], retryable: false });
        continue;
      }
    }
    let exhausted = false;
    const epsilon = Math.max(1e-8, Math.abs(r.max) * 1e-7);
    for (const index of r.vertices) {
      const origin = new Vector3(...point(transform, source.mesh.vertices[index]));
      const ray = r.kind === "thickness" ? new Ray(origin, new Vector3(...r.direction)) : null;
      let nearest = null;
      for (const t of triangles) {
        if (++tests > maxTests) { exhausted = true; break; }
        const hit = ray ? ray.intersectTriangle(t.triangle.a, t.triangle.b, t.triangle.c, false, new Vector3())
          : t.triangle.closestPointToPoint(origin, new Vector3());
        if (!hit) continue;
        const distance = hit.distanceTo(origin);
        if (ray && distance <= epsilon) continue;
        if (nearest && distance >= nearest.distance) continue;
        const normal = t.triangle.getNormal(new Vector3()).multiplyScalar(t.sign);
        nearest = { distance, signedGap: origin.clone().sub(hit).dot(normal),
          point: hit.toArray(), face: t.face, vertices: t.indices, normal: normal.toArray() };
      }
      if (exhausted) break;
      let actual = nearest ? r.kind === "signedGap" ? nearest.signedGap : nearest.distance : null, ambiguous = false;
      if (containment && nearest && nearest.distance > epsilon) {
        const parity = [];
        for (const direction of [[1, .371, .529], [.137, 1, .619], [.481, .237, 1]]) {
          const hits = [], probe = new Ray(origin, new Vector3(...direction).normalize());
          for (const t of triangles) {
            if (++tests > maxTests) { exhausted = true; break; }
            const hit = probe.intersectTriangle(t.triangle.a, t.triangle.b, t.triangle.c, false, new Vector3());
            if (hit && hit.distanceTo(origin) > epsilon) hits.push(hit.distanceTo(origin));
          }
          if (exhausted) break;
          hits.sort((a, b) => a - b);
          parity.push(hits.filter((d, i) => !i || d - hits[i - 1] > epsilon).length % 2);
        }
        if (exhausted) break;
        ambiguous = parity.some(p => p !== parity[0]);
        actual = ambiguous ? null : nearest.distance * (parity[0] ? 1 : -1);
      }
      samples.push({ vertex: index, point: origin.toArray(), actual, target: nearest,
        status: ambiguous ? "not_checked" : actual !== null && actual >= r.min - epsilon && actual <= r.max + epsilon ? "passed" : "failed",
        ...(ambiguous ? { reason: "ambiguous-ray-parity" } : {}),
        ...(nearest ? {} : { reason: "no-opposite-surface-hit" }) });
    }
    let boundary;
    if(volume) {
      try {
        boundary=checkSurfaceRelation({...project,nodes:project.nodes.map(n=>n.id===r.target?{...n,mesh:targetMesh}:n)},
          {...r,kind:"surfaceIntersection",tolerance:epsilon,touching:"forbid",allowed:[]},()=>++tests<=maxTests);
      } catch(error) {boundary={status:"not_checked",reason:"source-triangulation-failed",message:error.message,samples:[]};}
    }
    let status=exhausted || boundary?.status==="incomplete" ? "incomplete" :
      samples.some(s=>s.status==="failed") || boundary?.status==="failed" ? "failed" :
      samples.some(s=>s.status==="not_checked") || boundary?.status==="not_checked" ? "not_checked" : "passed";
    const componentCoverage=volume?volumeSourceCoverage(source.mesh,r.vertices):null;
    if(volume && status==="passed" && !componentCoverage.allComponentsSampled) status="not_checked";
    const fullyChecked=componentCoverage?.allComponentsSampled && samples.length===r.vertices.length &&
      samples.every(s=>["passed","failed"].includes(s.status)) && ["passed","failed"].includes(boundary?.status);
    results.push({ id: r.id, kind: r.kind, source: r.source, target: r.target,
      description: r.description,
      status,
      space: "world", units: "metres", threshold: { min: r.min, max: r.max }, samples,
      numericalTolerance: epsilon,
      ...(volume?{volume,boundary,coverage:{
        ...componentCoverage,
        wholeMeshContainmentChecked:fullyChecked,
        wholeMeshContained:fullyChecked && status==="passed",continuousAnimation:false,
      }}:{}),
      requestedSamples: r.vertices.length, completedSamples: samples.length,
      ...(exhausted ? { reason: "triangle-test-budget", retryable: true } :
        boundary && ["incomplete","not_checked"].includes(boundary.status)?{reason:boundary.reason,retryable:boundary.retryable??false}:
        volume && !componentCoverage.allComponentsSampled?{reason:"unsampled-source-components",retryable:false}:{}) });
  }
  const vertexResults=results.filter(r=>r.kind!=="surfaceIntersection");
  const pairResults=results.filter(r=>r.kind==="surfaceIntersection");
  return { results, tests: Math.min(tests, maxTests), maxTests,
    ok: results.every(r => r.status === "passed"),
    coverage: { declaredVertexSamples: vertexResults.length>0 && vertexResults.every(r => ["passed", "failed"].includes(r.status)),
      sampledContainment: results.some(r => ["inside","insideVolume"].includes(r.kind) && ["passed", "failed"].includes(r.status)),
      wholeSurfaceContact: false, containment: false,
      interObjectIntersection: false,
      declaredMeshPairIntersections: pairResults.length>0 && pairResults.every(r=>["passed","failed"].includes(r.status)),
      intersectionScope:"Only declared mesh pairs; not all scene objects, containment or continuous motion",
      globalMinimumThickness: false, continuousAnimation: false } };
}
