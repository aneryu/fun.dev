// Persistent local-space vertex pairing. Opposite-side topology stays intact.
// Works on polygon and dense meshes (dense.js); a dense part gets new positions only when a
// destination or seam vertex actually moves, so edits elsewhere keep sharing its arrays.
import { fail } from './mesh.js';
import { isDense, denseData, denseConnectivity, withPositions } from './dense.js';

// The faces' corner lists as a short key. Records made before 2026-10-20 stored the whole JSON
// of the corner lists; they still compare, and are upgraded to the key when they match.
const legacy = mesh => JSON.stringify(mesh.faces.map(f => f.vertices));
function hash(text) {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = (Math.imul(b, 33) ^ c) | 0; }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}
const topologyKey = mesh => (isDense(mesh) ? denseConnectivity(mesh) : `h-${hash(legacy(mesh))}`);
const vertexTotal = mesh => (isDense(mesh) ? denseData(mesh).positions.length / 3 : mesh.vertices.length);
const usedCache = new WeakMap();
function usedVertices(mesh) {
  if (!isDense(mesh)) return new Set(mesh.faces.flatMap(f => f.vertices));
  const d = denseData(mesh);
  let used = usedCache.get(d.indices);
  if (!used) { used = new Set(d.indices); usedCache.set(d.indices, used); }
  return used;
}
function sameTopology(s, mesh) {
  if (typeof s.topology !== 'string') return false;
  if (!s.topology.startsWith('[')) return s.topology === topologyKey(mesh);
  if (s.topology !== legacy(mesh)) return false;
  s.topology = topologyKey(mesh);
  return true;
}
const position = (mesh, i) => {
  if (!isDense(mesh)) return mesh.vertices[i];
  const p = denseData(mesh).positions;
  return [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
};

export function vertexSymmetry(node, options) {
  if (!node.mesh || node.instanceOf || node.symmetry) fail('Select an independent mesh');
  const axis = options.axis ?? 'z', offset = options.offset ?? 0, side = options.side ?? 1;
  if (!['x','y','z'].includes(axis) || !Number.isFinite(offset) || ![1,-1].includes(side)) fail('Invalid vertex symmetry plane');
  const k = 'xyz'.indexOf(axis), used = [...usedVertices(node.mesh)];
  const at = i => position(node.mesh, i);
  const pairs = [], seam = [], claimed = new Set(), buckets = new Map();
  const cell = p => p.map(v => Math.floor(v / 1e-6));
  for (const i of used) { const key = cell(at(i)).join(','); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(i); }
  // Build once when enabled; subsequent edits use stable vertex identities.
  for (const i of used) {
    const a = at(i), distance = (a[k] - offset) * side;
    if (Math.abs(distance) <= 1e-6) { seam.push(i); continue; }
    if (distance < 0) continue;
    const target = a.map((v,j) => j === k ? 2*offset-v : v);
    const matches = [], c = cell(target);
    for (let x=-1;x<=1;x++) for (let y=-1;y<=1;y++) for (let z=-1;z<=1;z++)
      for (const j of buckets.get([c[0]+x,c[1]+y,c[2]+z].join(',')) ?? [])
        if (j !== i && at(j).every((v,k) => Math.abs(v-target[k]) <= 1e-6)) matches.push(j);
    if (matches.length !== 1 || claimed.has(matches[0])) fail('Vertex symmetry requires uniquely paired symmetric vertices; align the mesh first');
    claimed.add(matches[0]); pairs.push([i,matches[0]]);
  }
  if (pairs.length*2+seam.length !== used.length) fail('Vertex symmetry has unmatched vertices');
  return {axis,offset,side,pairs,seam,count:vertexTotal(node.mesh),topology:topologyKey(node.mesh)};
}

export function synchronizeVertices(node) {
  const s=node.vertexSymmetry;
  if (!s) return;
  if (!node.mesh || node.instanceOf || node.symmetry || s.count !== vertexTotal(node.mesh) || !sameTopology(s, node.mesh)) fail('Disable vertex symmetry before changing topology');
  if (!['x','y','z'].includes(s.axis) || !Number.isFinite(s.offset) || ![1,-1].includes(s.side) || !Array.isArray(s.pairs) || !Array.isArray(s.seam)) fail('Invalid vertex symmetry');
  const k='xyz'.indexOf(s.axis), seen=new Set(), V=vertexTotal(node.mesh);
  const check=i=>{if(!Number.isInteger(i)||i<0||i>=V||seen.has(i))fail('Invalid vertex symmetry pairing');seen.add(i);};
  if (isDense(node.mesh)) {
    const p = denseData(node.mesh).positions;
    let out = null;
    const put = (i, value) => { if (p[i] !== value) { out ??= p.slice(); out[i] = value; } };
    for (const pair of s.pairs) {
      if(!Array.isArray(pair)||pair.length!==2)fail('Invalid vertex symmetry pairing');
      const [a,b]=pair;check(a);check(b);
      if((p[3*a+k]-s.offset)*s.side < -1e-6)fail('Source vertex crossed the symmetry plane');
      for (let j = 0; j < 3; j++) put(3*b+j, j===k ? 2*s.offset-p[3*a+j] : p[3*a+j]);
    }
    for(const i of s.seam){check(i);put(3*i+k, s.offset);}
    const used=usedVertices(node.mesh);if(seen.size!==used.size||[...used].some(i=>!seen.has(i)))fail('Incomplete vertex symmetry pairing');
    if (out) node.mesh = withPositions(node.mesh, out);
    return;
  }
  const vertices=node.mesh.vertices;
  for(const pair of s.pairs){if(!Array.isArray(pair)||pair.length!==2)fail('Invalid vertex symmetry pairing');const [a,b]=pair;check(a);check(b);if((vertices[a][k]-s.offset)*s.side < -1e-6)fail('Source vertex crossed the symmetry plane');vertices[b]=vertices[a].map((v,j)=>j===k?2*s.offset-v:v);}
  for(const i of s.seam){check(i);vertices[i][k]=s.offset;}
  const used=usedVertices(node.mesh);if(seen.size!==used.size||[...used].some(i=>!seen.has(i)))fail('Incomplete vertex symmetry pairing');
}
