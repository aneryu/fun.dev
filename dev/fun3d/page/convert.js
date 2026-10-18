import { THREE, fun3d, importer, fromBase64, toBase64 } from "./common.js";

// GLB statistics straight from its JSON: what a loader would create.
function glbStats(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true))));
  let primitives = 0, vertices = 0, triangles = 0;
  const used = new Map();
  for (const node of json.nodes ?? []) if (node.mesh !== undefined) used.set(node.mesh, (used.get(node.mesh) ?? 0) + 1);
  for (const [mesh, count] of used) for (const p of json.meshes[mesh].primitives) {
    primitives += count;
    vertices += json.accessors[p.attributes.POSITION].count * count;
    triangles += (p.indices !== undefined ? json.accessors[p.indices].count : json.accessors[p.attributes.POSITION].count) / 3 * count;
  }
  return { primitives, vertices, triangles };
}

window.convert = async (base64, options = {}) => {
  const bytes = fromBase64(base64);
  const before = glbStats(bytes);
  const t0 = performance.now();
  const imported = await importer.importGLB(bytes, options);
  const t1 = performance.now();
  const file = await fun3d.write(imported.root, { kind: imported.kind, animations: imported.animations, physics: imported.physics, rig: imported.rig });
  const t2 = performance.now();
  const loaded = await fun3d.load(file);
  const t3 = performance.now();
  let draws = 0, vertices = 0, triangles = 0, meshes = 0;
  loaded.scene.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    meshes++;
    draws += o.geometry.groups.length || 1;
    vertices += o.geometry.getAttribute("position").count;
    triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.getAttribute("position").count) / 3;
  });
  const materials = (loaded.manifest.materials ?? []).map((m) => `${m.name ?? "?"}:${m.type}${m.role ? `(${m.role})` : ""}`);
  return {
    file: toBase64(file),
    report: {
      kind: imported.kind, role: imported.role, rig: imported.rig, bytes: bytes.length, fun3d: file.length,
      before, after: { meshes, draws, vertices, triangles },
      animations: loaded.animations.map((a) => `${a.name}:${a.tracks.length}`).slice(0, 6), animationCount: loaded.animations.length,
      materials, textures: (loaded.manifest.textures ?? []).map((t) => `${t.mime}:${t.name ?? ""}`),
      physics: loaded.manifest.physics && Object.fromEntries(Object.entries(loaded.manifest.physics).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v])),
      ms: { import: Math.round(t1 - t0), write: Math.round(t2 - t1), load: Math.round(t3 - t2) },
    },
  };
};
window.ready = true;
