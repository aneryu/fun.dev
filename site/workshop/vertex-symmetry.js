// Persistent local-space vertex pairing. Opposite-side topology stays intact.
import { fail } from './mesh.js';
const topology = mesh => JSON.stringify(mesh.faces.map(f => f.vertices));
export function vertexSymmetry(node, options) {
  if (!node.mesh || node.instanceOf || node.symmetry) fail('Select an independent mesh');
  const axis = options.axis ?? 'z', offset = options.offset ?? 0, side = options.side ?? 1;
  if (!['x','y','z'].includes(axis) || !Number.isFinite(offset) || ![1,-1].includes(side)) fail('Invalid vertex symmetry plane');
  const k = 'xyz'.indexOf(axis), vertices = node.mesh.vertices, used = [...new Set(node.mesh.faces.flatMap(f => f.vertices))];
  const pairs = [], seam = [], claimed = new Set(), buckets = new Map();
  const cell = p => p.map(v => Math.floor(v / 1e-6));
  for (const i of used) { const key = cell(vertices[i]).join(','); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(i); }
  // Build once when enabled; subsequent edits use stable vertex identities.
  for (const i of used) {
    const a = vertices[i], distance = (a[k] - offset) * side;
    if (Math.abs(distance) <= 1e-6) { seam.push(i); continue; }
    if (distance < 0) continue;
    const target = a.map((v,j) => j === k ? 2*offset-v : v);
    const matches = [], c = cell(target);
    for (let x=-1;x<=1;x++) for (let y=-1;y<=1;y++) for (let z=-1;z<=1;z++)
      for (const j of buckets.get([c[0]+x,c[1]+y,c[2]+z].join(',')) ?? [])
        if (j !== i && vertices[j].every((v,k) => Math.abs(v-target[k]) <= 1e-6)) matches.push(j);
    if (matches.length !== 1 || claimed.has(matches[0])) fail('Vertex symmetry requires uniquely paired symmetric vertices; align the mesh first');
    claimed.add(matches[0]); pairs.push([i,matches[0]]);
  }
  if (pairs.length*2+seam.length !== used.length) fail('Vertex symmetry has unmatched vertices');
  return {axis,offset,side,pairs,seam,count:vertices.length,topology:topology(node.mesh)};
}
export function synchronizeVertices(node) {
  const s=node.vertexSymmetry;
  if (!s) return;
  if (!node.mesh || node.instanceOf || node.symmetry || s.count !== node.mesh.vertices.length || s.topology !== topology(node.mesh)) fail('Disable vertex symmetry before changing topology');
  if (!['x','y','z'].includes(s.axis) || !Number.isFinite(s.offset) || ![1,-1].includes(s.side) || !Array.isArray(s.pairs) || !Array.isArray(s.seam)) fail('Invalid vertex symmetry');
  const k='xyz'.indexOf(s.axis), vertices=node.mesh.vertices, seen=new Set();
  const check=i=>{if(!Number.isInteger(i)||!vertices[i]||seen.has(i))fail('Invalid vertex symmetry pairing');seen.add(i);};
  for(const pair of s.pairs){if(!Array.isArray(pair)||pair.length!==2)fail('Invalid vertex symmetry pairing');const [a,b]=pair;check(a);check(b);if((vertices[a][k]-s.offset)*s.side < -1e-6)fail('Source vertex crossed the symmetry plane');vertices[b]=vertices[a].map((v,j)=>j===k?2*s.offset-v:v);}
  for(const i of s.seam){check(i);vertices[i][k]=s.offset;}
  const used=new Set(node.mesh.faces.flatMap(f=>f.vertices));if(seen.size!==used.size||[...used].some(i=>!seen.has(i)))fail('Incomplete vertex symmetry pairing');
}
