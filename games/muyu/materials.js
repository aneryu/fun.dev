// The fish's wood and the cushion's brocade: procedural TSL node materials (the models have no UVs).

// Teak: dense streaks in model space that stay horizontal on every side. Streak noise is
// stretched across the horizontal plane; the finest fibres fade out once they get thinner than
// a pixel, to avoid moiré on phones. Only the fish (shellMaterial) carries the baked occlusion of
// its vertex colors and the inner glow; the mallet and the relics share the plain wood.
export function createWood(THREE, track) {
  const { Fn, attribute, positionGeometry, varying, vec3, float, mix, smoothstep, fwidth, floor, fract, min, uniform, materialColor, materialEmissive } = THREE.TSL;
  const woodGlow = uniform(0);
  const woodGlowColor = uniform(new THREE.Color(0xffa63d));
  const woodHash = Fn(([x]) => {
    const p = fract(x.mul(0.3183099).add(0.1)).mul(17.0).toVar();
    return fract(p.x.mul(p.y).mul(p.z).mul(p.x.add(p.y).add(p.z)));
  }).setLayout({ name: "woodHash", type: "float", inputs: [{ name: "x", type: "vec3" }] });
  const woodNoise = Fn(([x]) => {
    const i = floor(x).toVar();
    const f = fract(x).toVar();
    f.assign(f.mul(f).mul(f.mul(-2.0).add(3.0)));
    const h = (dx, dy, dz) => woodHash(i.add(vec3(dx, dy, dz)));
    return mix(mix(mix(h(0, 0, 0), h(1, 0, 0), f.x), mix(h(0, 1, 0), h(1, 1, 0), f.x), f.y),
      mix(mix(h(0, 0, 1), h(1, 0, 1), f.x), mix(h(0, 1, 1), h(1, 1, 1), f.x), f.y), f.z);
  }).setLayout({ name: "woodNoise", type: "float", inputs: [{ name: "x", type: "vec3" }] });
  const wp = positionGeometry;
  const y = wp.y.add(woodNoise(wp.mul(vec3(3.0, 3.0, 1.5))).mul(0.025));
  const bands = smoothstep(0.2, 0.8, woodNoise(vec3(wp.x.mul(3.0), y.mul(60.0), wp.z.mul(3.0))));
  const fibres = mix(woodNoise(vec3(wp.x.mul(14.0), y.mul(220.0), wp.z.mul(14.0))), 0.5, smoothstep(0.4, 0.9, fwidth(y.mul(220.0))));
  const tone = woodNoise(wp.mul(3.0));
  const grain = mix(0.6, 1.15, bands.mul(0.45).add(fibres.mul(0.4)).add(tone.mul(0.15)));
  // Open surfaces stay unshaded; grooves (red: baked AO) darken, and the recessed slit (green:
  // depth below the convex hull) goes nearly black inside. Zen lights the carving from within:
  // the slit most, the grooves a little.
  const bake = attribute("color");
  const occlusion = varying(mix(0.35, 1.0, smoothstep(0.05, 0.6, bake.r)).mul(mix(0.12, 1.0, smoothstep(0.45, 0.75, bake.g))));
  const innerGlow = varying(min(1.0, float(1.0).sub(smoothstep(0.1, 0.7, bake.r)).mul(0.8).add(float(1.0).sub(smoothstep(0.4, 0.75, bake.g)))));
  const shellMaterial = track(new THREE.MeshPhysicalNodeMaterial({ color: 0x9c5626, metalness: 0, roughness: 0.55, clearcoat: 0.2, clearcoatRoughness: 0.4, envMapIntensity: 0.6 }));
  const malletMaterial = track(shellMaterial.clone());
  malletMaterial.colorNode = materialColor.mul(grain);
  shellMaterial.colorNode = materialColor.mul(grain).mul(occlusion);
  shellMaterial.emissiveNode = materialEmissive.add(woodGlowColor.mul(woodGlow).mul(innerGlow));
  return { shellMaterial, malletMaterial, woodGlow };
}

// Red brocade: a row of gold five-petal flowers in scalloped frames around the cushion's wall,
// small flowers between them along both edges, and a fine weave. Cylindrical coordinates about
// the cushion's own axis (box: its geometry's bounding box) stand in for the missing UVs.
export function createCushion(THREE, track, box) {
  const { positionGeometry, vec2, float, mix, smoothstep, fwidth, fract, abs, cos, sin, atan, length, max, uniform, materialColor, materialRoughness, materialMetalness } = THREE.TSL;
  const motifs = 20;
  // Treated as a torus: arc length around the tube's cross-section keeps motifs undistorted on the rounded wall.
  const radius = ((box.max.x - box.min.x) + (box.max.z - box.min.z)) / 4;
  const tube = (box.max.y - box.min.y) / 2;
  const cell = 2 * Math.PI * radius / motifs;
  const cushionUniforms = {
    cushionGold: uniform(new THREE.Color(0xc99a45)),
    cushionMotif: uniform(1), // 0: plain cloth, 1: the brocade's flowers
    cushionWeave: uniform(0.07), // how strongly the weave shows
  };
  // Coverage of a line or disc edge at distance d, antialiased over one pixel.
  const ink = (d, width) => float(1.0).sub(smoothstep(width, fwidth(d).add(width), d));
  // Gold coverage of a five-petal flower of radius size at q, with red petal and centre lines.
  const flower = (q, size) => {
    const r = length(q);
    const petal = abs(cos(atan(q.y, q.x).mul(2.5))).mul(0.45).add(0.55).mul(size);
    const lines = max(ink(abs(r.sub(petal.mul(0.62))), size * 0.05), ink(abs(r.sub(size * 0.22)), size * 0.04));
    return ink(r.sub(petal), 0.0).mul(float(1.0).sub(lines));
  };
  const cp = positionGeometry.sub(box.getCenter(new THREE.Vector3()));
  const around = atan(cp.z, cp.x).div(6.2831853).mul(motifs);
  // The camera sees the upper, outward-bulging side (tube angle about 0.6 rad), so the row is centred there.
  const tubeAngle = atan(cp.y, length(cp.xz).sub(radius - tube));
  const height = tubeAngle.sub(0.6).mul(tube / cell);
  const q = vec2(fract(around).sub(0.5), height);
  const frame = ink(abs(length(q).sub(0.37).sub(cos(atan(q.y, q.x).mul(5.0)).mul(0.035))), 0.018);
  const flowers = max(max(frame.mul(float(1.0).sub(ink(length(q).sub(0.3), 0.0))), flower(q, 0.27)),
    flower(vec2(fract(around.add(0.5)).sub(0.5), abs(height).sub(0.42)), 0.1));
  const weaveScale = 70.0;
  const weave = sin(around.mul(weaveScale * 6.2831853 / motifs * 4.0)).mul(sin(height.mul(weaveScale)))
    .mul(float(1.0).sub(smoothstep(0.3, 0.8, fwidth(height.mul(weaveScale)))));
  const gold = flowers.mul(cushionUniforms.cushionMotif);
  const { cushionWeave } = cushionUniforms;
  const cushionMaterial = track(new THREE.MeshStandardNodeMaterial({ color: 0x8a1a14, roughness: 0.9, envMapIntensity: 0.5 }));
  cushionMaterial.colorNode = mix(materialColor.mul(float(1.0).sub(cushionWeave).add(cushionWeave.mul(weave))), cushionUniforms.cushionGold, gold);
  cushionMaterial.roughnessNode = mix(materialRoughness, 0.45, gold);
  cushionMaterial.metalnessNode = mix(materialMetalness, 0.5, gold);
  return { cushionMaterial, cushionUniforms };
}
