// Shared postprocessing on one THREE.RenderPipeline: ambient occlusion, bloom and a light colour
// grade, scaled to the device tier (context.graphics.tier). The scene pass keeps the renderer's
// antialiasing; tone mapping and the output colour space follow the renderer's settings.
//
//   const { createPost } = await context.runtime("kit/post.js");
//   const post = await createPost(context, { bloom: { strength: 0.5 }, ao: true, grade: { saturation: 1.1 } });
//   post.bloom.strength.value = 0.8; // node uniforms can change at any time
//
// Ambient occlusion runs on "high" tier devices only, unless ao.everywhere is set; bloom runs
// at half resolution on "low" tier devices.
export async function createPost(context, { scene = context.scene, camera = context.camera, ao = false, bloom = false, grade = null, samples } = {}) {
  const { THREE, renderer, graphics, signal, track } = context;
  const { pass, mrt, normalView, builtinAOContext, screenUV, saturation, uniform, vec3, vec4 } = THREE.TSL;
  const high = graphics.tier === "high";
  const aoOptions = ao === true ? {} : ao || null;
  const bloomOptions = bloom === true ? {} : bloom || null;
  const useAO = !!aoOptions && (high || aoOptions.everywhere === true);
  const [aoModule, bloomModule] = await Promise.all([
    useAO ? context.runtime("addons/GTAONode.js") : null,
    bloomOptions ? context.runtime("addons/BloomNode.js") : null,
  ]);
  signal.throwIfAborted();

  const pipeline = track(new THREE.RenderPipeline(renderer));
  const scenePass = pass(scene, camera, samples === undefined ? {} : { samples });
  const parts = { pipeline, ao: null, bloom: null, grade: null };
  const nodes = [scenePass];
  if (useAO) {
    // A depth and normal pre-pass feeds GTAO; its result darkens only the indirect light.
    // AO needs depth/normals, not an additional multisampled colour buffer.
    // Keeping this single-sampled avoids duplicating the scene pass's MSAA
    // allocation (particularly expensive on native Retina surfaces).
    const prePass = pass(scene, camera, { samples: 0 });
    // The normal pass must not execute physical refraction: its framebuffer has
    // no opaque colour to refract (and starts at 1×1 before the first resize).
    prePass.overrideMaterial = track(new THREE.MeshNormalNodeMaterial());
    prePass.transparent = false;
    prePass.setMRT(mrt({ output: normalView }));
    const aoPass = aoModule.ao(prePass.getTextureNode("depth"), prePass.getTextureNode(), camera);
    aoPass.resolutionScale = aoOptions.resolution ?? 0.5;
    if (aoOptions.radius !== undefined) aoPass.radius.value = aoOptions.radius;
    if (aoOptions.intensity !== undefined) aoPass.scale.value = aoOptions.intensity;
    scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
    nodes.push(prePass, aoPass);
    parts.ao = aoPass;
  }
  let color = scenePass.getTextureNode("output");
  if (bloomOptions) {
    const bloomPass = bloomModule.bloom(color, bloomOptions.strength ?? 0.4, bloomOptions.radius ?? 0.3, bloomOptions.threshold ?? 0.85);
    if (!high) bloomPass.resolutionScale = 0.5;
    color = color.add(bloomPass);
    nodes.push(bloomPass);
    parts.bloom = bloomPass;
  }
  if (grade) {
    // Saturation and contrast around mid grey, in linear light before tone mapping; a tint multiplies.
    const amount = { saturation: uniform(grade.saturation ?? 1), contrast: uniform(grade.contrast ?? 1), tint: uniform(new THREE.Color(grade.tint ?? 0xffffff)) };
    const graded = saturation(color.rgb, amount.saturation).sub(0.18).mul(amount.contrast).add(0.18).max(vec3(0)).mul(amount.tint);
    color = vec4(graded, color.a);
    parts.grade = amount;
  }
  pipeline.outputNode = color;
  for (const node of nodes) if (typeof node.dispose === "function") track(node);
  context.setRenderPipeline(pipeline);
  return { ...parts, dispose() { context.setRenderPipeline(null); } };
}
