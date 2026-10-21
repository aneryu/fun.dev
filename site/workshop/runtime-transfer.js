// Authoring semantics are separate from the exported GLB payload inventory.
// This is a declaration of the writer's transfer policy, not a readback check.
export function runtimeTransfer(project, sourceIds) {
  const nodes = project.nodes.filter(n => sourceIds.has(n.id));
  const feature = (name, ids, treatment, effect) => ({ name, ids, treatment, effect });
  return {
    version: 1,
    destination: "glb-runtime",
    units: "metres",
    editableSourceEmbedded: false,
    readbackChecked: false,
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
