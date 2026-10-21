import { ModelError, vector } from "./mesh.js";
import { connectivityToken } from "./components.js";
import { isDense } from "./dense.js";

export function normalizeRelations(input = [], nodes) {
  if (!Array.isArray(input) || input.length > 128) throw new ModelError("At most 128 design relations", "relation");
  const seen = new Set();
  return input.map(r => {
    const fail = message => { throw new ModelError(message, "relation", `relations.${r?.id ?? "unknown"}`); };
    if (!r || ![1,2,3,4].includes(r.version) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(r.id) || seen.has(r.id))
      fail("Relations require unique ids and version 1, 2, 3 or 4");
    seen.add(r.id);
    if (r.description !== undefined && (typeof r.description !== "string" || r.description.length > 500))
      fail("Relation description must be at most 500 characters");
    if (!["distance", "signedGap", "thickness", "inside", "insideVolume", "surfaceIntersection"].includes(r.kind)) fail("Unknown relation kind");
    if (!["surfaceIntersection","insideVolume"].includes(r.kind) && r.version !== 1) fail("Sampled relation kinds require version 1");
    const source = nodes.find(n => n.id === r.source), target = nodes.find(n => n.id === r.target);
    if (!source?.mesh || !target?.mesh || isDense(source.mesh) || isDense(target.mesh))
      fail("Relations need polygon source and target meshes");
    if (r.connectivity !== connectivityToken(source.mesh))
      fail(`Relation source topology changed; explicitly rebind its ${r.kind==="surfaceIntersection"?"face exceptions":"vertex samples"}`);
    if (r.kind === "surfaceIntersection") {
      if (![2,4].includes(r.version) || source.id === target.id) fail("Surface intersection needs version 2 or 4 and two distinct meshes");
      if (r.targetConnectivity !== connectivityToken(target.mesh)) fail("Relation target topology changed; explicitly rebind its face exceptions");
      if (!Number.isFinite(r.tolerance) || r.tolerance < 1e-9 || r.tolerance > 1) fail("Provide a numerical tolerance of 1e-9–1 metres");
      if (!["allow","forbid"].includes(r.touching)) fail("Declare whether boundary touching is allowed or forbidden");
      if (!Array.isArray(r.allowed) || r.allowed.length > 64) fail("At most 64 explicit allowed face-pair regions");
      const allowed=r.allowed.map(rule=>{
        for (const [field,node] of [["sourceFaces",source],["targetFaces",target]])
          if (!Array.isArray(rule[field]) || !rule[field].length || rule[field].length>256 ||
              new Set(rule[field]).size!==rule[field].length ||
              rule[field].some(id=>!node.mesh.faces.some(f=>f.id===id))) fail(`Invalid ${field} exception; use stable face ids`);
        if(typeof rule.reason!=="string" || !rule.reason.trim() || rule.reason.length>500) fail("Allowed intersections need a design reason");
        let bounds;
        if(rule.bounds!==undefined) {
          if(r.version!==4) fail("Bounded intersection exceptions require relation version 4");
          const valid=v=>Array.isArray(v) && v.length===3 && Array.from(v).every(Number.isFinite);
          if(!rule.bounds || !valid(rule.bounds.min) || !valid(rule.bounds.max) ||
              rule.bounds.min.some((v,k)=>v>rule.bounds.max[k]))
            fail("Exception bounds need finite min/max vectors in source-local metres, with min <= max");
          bounds={min:[...rule.bounds.min],max:[...rule.bounds.max]};
        }
        return {sourceFaces:[...rule.sourceFaces],targetFaces:[...rule.targetFaces],reason:rule.reason,...(bounds?{bounds}:{})};
      });
      return {version:r.version,id:r.id,kind:r.kind,source:r.source,target:r.target,connectivity:r.connectivity,
        targetConnectivity:r.targetConnectivity,tolerance:r.tolerance,touching:r.touching,allowed,
        ...(r.description!==undefined?{description:r.description}:{})};
    }
    if (!Array.isArray(r.vertices) || !r.vertices.length || r.vertices.length > 256 ||
        new Set(r.vertices).size !== r.vertices.length ||
        r.vertices.some(i => !Number.isInteger(i) || i < 0 || i >= source.mesh.vertices.length))
      fail("Choose 1–256 unique source vertex indices");
    if (![r.min, r.max].every(Number.isFinite) || r.max < r.min ||
        (r.kind !== "signedGap" && r.min < 0)) fail("Provide an explicit allowed min/max interval in metres");
    let volume;
    if(r.kind==="insideVolume") {
      if(source.id===target.id) fail("Inspection containment requires distinct source and target nodes");
      if(r.version!==3 || r.targetConnectivity!==connectivityToken(target.mesh))
        fail("Inspection volume needs version 3 and unchanged target topology; explicitly rebind its faces and caps");
      const v=r.volume;
      if(!v || !Array.isArray(v.faces) || !v.faces.length || v.faces.length>4096 ||
          new Set(v.faces).size!==v.faces.length || v.faces.some(id=>!target.mesh.faces.some(f=>f.id===id)) ||
          !Array.isArray(v.caps) || !v.caps.length || v.caps.length>1024 ||
          v.caps.some(t=>!Array.isArray(t) || t.length!==3 || new Set(t).size!==3 ||
            t.some(i=>!Number.isInteger(i) || i<0 || i>=target.mesh.vertices.length)))
        fail("Volume needs existing target face ids and explicit closure triangles using target vertex indices");
      volume={faces:[...v.faces],caps:v.caps.map(t=>[...t])};
    }
    let direction;
    if (r.kind === "thickness") {
      direction = vector(r.direction);
      const length = Math.hypot(...direction);
      if (length < 1e-10) fail("Thickness needs a nonzero world-space ray direction");
      direction = direction.map(v => v / length);
    }
    return { version: volume?3:1, id: r.id, kind: r.kind, source: r.source, target: r.target,
      connectivity: r.connectivity, vertices: [...r.vertices], min: r.min, max: r.max,
      ...(r.description !== undefined ? { description: r.description } : {}),
      ...(direction ? { direction } : {}),...(volume?{volume,targetConnectivity:r.targetConnectivity}:{}) };
  });
}
export function relationCommand(project, command) {
  if (command.op === "removeRelation") {
    project.relations = (project.relations ?? []).filter(r => r.id !== command.id);
  } else {
    const r = structuredClone(command.definition);
    const source = project.nodes.find(n => n.id === r.source);
    if (!source?.mesh) throw new ModelError("Unknown relation source mesh", "relation", `relations.${r.id}`);
    const target=project.nodes.find(n=>n.id===r.target);
    const definition = { ...r, version: r.kind==="surfaceIntersection"?(r.allowed?.some(rule=>rule.bounds!==undefined)?4:2):r.kind==="insideVolume"?3:1, connectivity: connectivityToken(source.mesh),
      ...(r.kind==="insideVolume"?{targetConnectivity:target?.mesh?connectivityToken(target.mesh):null}:{}),
      ...(r.kind==="surfaceIntersection"?{targetConnectivity:target?.mesh?connectivityToken(target.mesh):null,
        allowed:r.allowed??[],touching:r.touching??"forbid"}:{}) };
    project.relations = normalizeRelations([...(project.relations ?? []).filter(x => x.id !== r.id), definition], project.nodes);
  }
}
