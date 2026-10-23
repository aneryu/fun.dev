// Authoring semantics are separate from the exported GLB payload inventory.
// This is a declaration of the writer's transfer policy, not a readback check.
import { materialUsage } from './materials.js';
import { TEXTURE_SLOTS, textureBytes } from './textures.js';
export function runtimeTransfer(project, sourceIds) {
  const nodes = project.nodes.filter(n => sourceIds.has(n.id));
  const feature = (name, ids, treatment, effect) => ({ name, ids, treatment, effect });
  return {
    version: 2,
    destination: "glb-runtime",
    units: "metres",
    editableSourceEmbedded: false,
    readbackChecked: false,
    status: "not_checked",
    outputVersion: { format: "glTF", version: "2.0" },
    coverage: { declarations: true, geometryReadback: false, materialsReadback: false, resourceReadback: false, gpu: false },
    resources: materialUsage({ ...project, nodes }).filter(m => m.referenceCount)
      .map(m => ({ source: m.id, outputName: m.id, treatment: "runtime" })),
    features: [
      feature("recipes", nodes.filter(n => n.recipe).map(n => n.id), "baked",
        "Current parameter values become geometry; parameter definitions and modeling steps are not editable in the runtime file."),
      feature("surfaceAttachments", nodes.filter(n => n.attachment).map(n => n.id), "baked",
        "Current poses and sampled clip transforms/deformation targets are exported; live surface bindings and rebinding data are not retained."),
      feature("symmetryAndInstances", nodes.filter(n => n.symmetry || n.instanceOf).map(n => n.id), "baked",
        "Evaluated geometry is exported; authoring copy/mirror dependencies are not retained."),
      feature("morphs", nodes.filter(n => n.morph).map(n => n.id), "runtime",
        "Named targets and current weights are exported on render vertices; original polygon/vertex identities and editing history are not retained."),
      feature("skins", nodes.filter(n => n.skin).map(n => n.id), "runtime",
        "Joint hierarchy, inverse binds and render-vertex weights are exported; source polygon correspondence is not an editable runtime contract."),
      feature("characterControls", (project.character?.controls ?? []).map(c => c.id), "baked",
        "Control results are evaluated into the current pose and sampled clips; control definitions and expression dependencies are not retained."),
      feature("clips", (project.character?.clips ?? []).map(c => c.name), "sampled",
        "Transform and morph tracks are sampled at declared clip fps and key times. See animation summaries for step tolerance and deformation targets; unsampled times are not collision-certified."),
      feature("assemblies", (project.assemblies ?? []).map(a => a.root), "baked",
        "Evaluated nodes are exported; assembly parameters and constraints are not editable in the runtime file."),
      feature("designRelations", (project.relations ?? []).map(r => r.id), "omitted",
        "Contact, containment and thickness policies stay in the editable project and are not enforced by the runtime."),
      feature("viewPresets", (project.viewPresets ?? []).map(v => v.id), "omitted",
        "Inspection cameras, framing and studio settings stay in the editable project."),
      feature("designReferences", (project.designReferences?.records ?? []).map(r => r.id), "omitted",
        "Reference images, versions, adoption decisions and approval evidence stay in the editable project."),
    ],
    scope: "Node features list exported source nodes; document-level features list source definitions and may include controls outside a partial export.",
    statistics: "Triangulation changes face counts; flat normals, material boundaries and attribute seams can split render vertices. Count differences alone do not establish geometry loss.",
    editableAlternative: ".funmodel.glb retains the editable project; use isolated source roundtrip verification to check it.",
    subsequentConversion: ".fun3d conversion/compression and runtime playback are separate checks and are not verified by this GLB transfer declaration.",
  };
}

// Actual material objects and retained encoded resources, after decompression
// and load. This does not certify pixels or animation/geometry correspondence.
export function materialReadback(project, model) {
  const materials = new Map();
  model.root.traverse(o => {
    for (const m of [o.material ?? []].flat()) {
      const id = m.userData?.fun3d?.id;
      if (id) { const list = materials.get(id) ?? []; list.push(m); materials.set(id, list); }
    }
  });
  const checks = [];
  const check = (source, field, pass, reason) => checks.push({ source, field, status: pass ? 'pass' : 'fail', ...(reason ? { reason } : {}) });
  const close = (a, b) => Math.abs(a - b) < 1e-4;
  for (const source of materialUsage(project).filter(m => m.users.length)) {
    const desc = [...model.materials.values()].find(d => d.id === source.id || d.name === source.id);
    const actual = desc && materials.get(desc.id);
    check(source.id, 'binding', !!actual?.length);
    for (const id of source.users) {
      const node = model.node(id), mesh = node?.userData?.mesh ?? node;
      check(source.id, `node.${id}.binding`, !!desc && [mesh?.material ?? []].flat().some(m => m.userData?.fun3d?.id === desc.id),
        !node ? 'Source node not present; merged exports require an explicit source-to-output mapping' : undefined);
    }
    for (const m of new Set(actual ?? [])) {
      check(source.id, 'color', m.color.getHexString().toLowerCase() === source.color.slice(1).toLowerCase());
      for (const [key, fallback] of [['roughness', .85], ['metalness', 0], ['opacity', 1], ['transmission', 0]])
        check(source.id, key, close(m[key] ?? 0, source[key] ?? fallback));
      if (source.alphaTest !== undefined) check(source.id, 'alphaTest', close(m.alphaTest, source.alphaTest));
      if (source.transparent) check(source.id, 'transparent', m.transparent === true);
      check(source.id, 'emissive', m.emissive?.getHexString().toLowerCase() === (source.emissive ?? '#000000').slice(1).toLowerCase());
      if (source.emissive) check(source.id, 'emissiveIntensity', close(m.emissiveIntensity, source.emissiveIntensity ?? 1));
      if (source.transmission) check(source.id, 'ior', close(m.ior, source.ior ?? 1.5));
      if (source.normalTexture) check(source.id, 'normalScale', m.normalScale.toArray().every(n => close(n, source.normalScale ?? 1)));
      if (source.occlusionTexture) check(source.id, 'occlusionStrength', close(m.aoMapIntensity, source.occlusionStrength ?? 1));
      for (const [key, [slot, colorSpace]] of Object.entries(TEXTURE_SLOTS)) {
        if (!source[key]) continue;
        const texture = m[slot], encoded = texture?.userData?.fun3dSource?.bytes;
        const expected = textureBytes(source[key].uri);
        check(source.id, `${key}.bytes`, !!encoded && encoded.length === expected.length && encoded.every((v, i) => v === expected[i]), !encoded ? 'Load with keepSources:true' : undefined);
        check(source.id, `${key}.colorSpace`, texture?.colorSpace === (colorSpace === 'srgb' ? 'srgb' : ''));
        check(source.id, `${key}.uv`, texture?.channel === 0);
        const t = source[key].transform ?? { offset: [0, 0], scale: [1, 1], rotation: 0 };
        check(source.id, `${key}.transform`, !!texture && [...texture.offset.toArray(), ...texture.repeat.toArray(), texture.rotation].every((v, i) => close(v, [...t.offset, ...t.scale, t.rotation][i])));
      }
    }
  }
  return { version: 1, status: checks.some(c => c.status === 'fail') ? 'fail' : checks.length ? 'pass' : 'not_checked',
    coverage: { materialObjects: true, nodeBindings: true, encodedResources: true, pixels: false, geometry: false, animation: false }, checks };
}
