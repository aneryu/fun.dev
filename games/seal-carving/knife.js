// The carving knife (印刀): a flat steel blade ground on both faces to a fine edge, set in a
// handle wrapped tightly with pale cord, dyed cinnabar where it is gripped, a dark rivet above. Built from primitives
// with procedural detail. Its origin is the cutting corner of the edge (the corner that goes
// into the stone when the knife is rolled, as carvers hold it) and +Y runs up the handle.
// As in the video: a square-ish steel bar, narrow and thick, dark and matte, with a bright
// ground facet at the tip; a lumpy cloth-wrapped grip that swells above the blade.
const BLADE = { width: 0.1, thickness: 0.045, length: 0.55, bevel: 0.06 };
const HANDLE = { radius: 0.065, length: 0.72 };

export function createKnife({ THREE, track }) {
  const group = new THREE.Group();

  // Blade: a box with a ring of vertices where the bevels start; below it both faces close in
  // to an edge a hair thick (双面刃).
  const rings = Math.round(BLADE.length / BLADE.bevel);
  const bladeGeometry = track(new THREE.BoxGeometry(BLADE.width, BLADE.length, BLADE.thickness, 2, rings, 1));
  bladeGeometry.translate(-BLADE.width / 2, BLADE.length / 2, 0);
  const positions = bladeGeometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    if (positions.getY(i) < 1e-4) positions.setZ(i, positions.getZ(i) * 0.08);
    // A slightly skewed edge (斜口): the cutting corner at the origin meets the stone first.
    positions.setY(i, positions.getY(i) - positions.getX(i) * 0.3);
  }
  bladeGeometry.computeVertexNormals();
  const uniforms = { knifeDust: { value: 0 }, knifeBevel: { value: BLADE.bevel } };
  const steel = track(new THREE.MeshStandardMaterial({ color: 0x6d7176, metalness: 0.75, roughness: 0.45, envMapIntensity: 1.1 }));
  steel.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vKnifePosition;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvKnifePosition = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vKnifePosition;
uniform float knifeDust, knifeBevel;
float knifeHash(float n) { return fract(sin(n) * 43758.5453); }
float knifeNoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = knifeHash(i.x + i.y * 57.0), b = knifeHash(i.x + 1.0 + i.y * 57.0), c = knifeHash(i.x + (i.y + 1.0) * 57.0), d = knifeHash(i.x + 1.0 + (i.y + 1.0) * 57.0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
float y = vKnifePosition.y;
float facet = 1.0 - smoothstep(knifeBevel * 0.92, knifeBevel, y);
// Stone powder clings to the lower blade, thickest at the edge, ragged at its top.
float dustLine = knifeDust * (0.05 + 0.1 * knifeNoise(vec2(vKnifePosition.x * 90.0, 3.0)));
float dust = knifeDust * (1.0 - smoothstep(dustLine * 0.6, dustLine, y)) * (0.55 + 0.45 * knifeNoise(vKnifePosition.xy * 400.0));
// The very edge is honed bright.
float edge = 1.0 - smoothstep(0.0, 0.004, y);
diffuseColor.rgb = mix(diffuseColor.rgb * mix(1.0, 1.9, facet), vec3(0.93, 0.9, 0.86), dust);
diffuseColor.rgb += edge * 0.35;`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
// Grinding marks: fine streaks across the blade, finer on the bevels.
float scratch = knifeHash(floor(vKnifePosition.y * mix(700.0, 1600.0, facet) + vKnifePosition.x * 30.0));
roughnessFactor = clamp(mix(0.5, 0.18, facet) + (scratch - 0.5) * 0.22, 0.08, 0.85);
roughnessFactor = mix(roughnessFactor, 0.95, dust);`)
      .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.0, dust);`);
  };
  steel.customProgramCacheKey = () => "seal-knife-steel";
  const blade = new THREE.Mesh(bladeGeometry, steel);
  blade.castShadow = true;
  group.add(blade);

  // Handle: a turned profile that swells where the wrapping is thickest, just above the blade,
  // then a lumpy run of cloth to a rounded end; small random bumps make it hand-wrapped.
  const base = BLADE.length * 0.8; // the blade shows well below the grip
  const profile = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24, y = base + t * HANDLE.length;
    const swell = Math.exp(-(((t - 0.1) / 0.09) ** 2)) * 0.35 + Math.exp(-(((t - 0.45) / 0.2) ** 2)) * 0.08;
    const end = t > 0.94 ? Math.sqrt(Math.max(0, 1 - ((t - 0.94) / 0.06) ** 2)) : 1;
    const neck = t < 0.03 ? 0.7 + t / 0.03 * 0.3 : 1;
    profile.push(new THREE.Vector2(HANDLE.radius * (1 + swell) * end * neck + 0.0005, y));
  }
  const handleGeometry = track(new THREE.LatheGeometry(profile, 28));
  const hp = handleGeometry.attributes.position;
  for (let i = 0; i < hp.count; i++) {
    const x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i);
    const angle = Math.atan2(z, x);
    const lump = 1 + 0.07 * Math.sin(angle * 3 + y * 23) * Math.sin(y * 41 + angle) + 0.04 * Math.sin(angle * 7 - y * 67);
    hp.setXYZ(i, x * lump - BLADE.width / 2, y, z * lump * 0.9);
  }
  handleGeometry.computeVertexNormals();
  // The grip: the same cloth, its wraps on the swell dyed cinnabar where the fingers hold the
  // knife. Pressing it drives the knife into the stone; it glows faintly while pressed.
  const GRIP = { y: base + 0.1, length: 0.16 };
  const gripUniforms = { gripRange: { value: new THREE.Vector2(GRIP.y - GRIP.length / 2, GRIP.y + GRIP.length / 2) }, gripGlow: { value: 0 } };
  const cord = track(new THREE.MeshStandardMaterial({ color: 0xdcd4c4, roughness: 0.9 }));
  cord.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, gripUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCordPosition;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCordPosition = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vCordPosition;
uniform vec2 gripRange;
uniform float gripGlow;
float gripBand;
float cordHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float cordNoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cordHash(i), cordHash(i + vec2(1, 0)), f.x), mix(cordHash(i + vec2(0, 1)), cordHash(i + vec2(1, 1)), f.x), f.y); }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
float around = atan(vCordPosition.z, vCordPosition.x + ${(BLADE.width / 2).toFixed(4)}) / 6.2831853;
// Wraps of cloth, uneven, with years of brown handling stains.
float turns = vCordPosition.y * 55.0 + around * 1.5 + cordNoise(vec2(around * 8.0, vCordPosition.y * 6.0)) * 1.5;
float ridge = abs(fract(turns) - 0.5) * 2.0;
float stain = smoothstep(0.45, 0.8, cordNoise(vec2(around * 6.0, vCordPosition.y * 9.0)) * 0.7 + cordNoise(vec2(around * 25.0, vCordPosition.y * 40.0)) * 0.3);
float fleck = step(0.9, cordHash(floor(vec2(around * 160.0, vCordPosition.y * 260.0))));
diffuseColor.rgb *= (0.84 + 0.16 * (1.0 - ridge * ridge));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.5, 0.38, 0.27), stain * 0.6 + fleck * 0.35);
// The dyed band ends along the wraps, a little ragged, as dyed thread would.
float edge = cordNoise(vec2(around * 12.0, 4.0)) * 0.012;
gripBand = smoothstep(gripRange.x - 0.004, gripRange.x + 0.004, vCordPosition.y + edge) * (1.0 - smoothstep(gripRange.y - 0.004, gripRange.y + 0.004, vCordPosition.y - edge));
vec3 dyed = vec3(0.42, 0.07, 0.05) * (0.72 + 0.28 * (1.0 - ridge * ridge)) * mix(1.0, 0.7, stain);
diffuseColor.rgb = mix(diffuseColor.rgb, dyed, gripBand);`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(0.55, 0.1, 0.06) * gripGlow * gripBand;`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
normal = normalize(normal + vec3(0.0, (fract(vCordPosition.y * 55.0 + atan(vCordPosition.z, vCordPosition.x) / 6.2831853 * 1.5) - 0.5) * 0.35, 0.0));`);
  };
  cord.customProgramCacheKey = () => "seal-knife-cord";
  const handle = new THREE.Mesh(handleGeometry, cord);
  handle.castShadow = true;
  group.add(handle);

  // The dark rivet (or knot) just above the grip, as in the video.
  const rivet = new THREE.Mesh(track(new THREE.SphereGeometry(HANDLE.radius * 0.24, 12, 8)), track(new THREE.MeshStandardMaterial({ color: 0x2a2420, roughness: 0.5, metalness: 0.3 })));
  rivet.position.set(-BLADE.width / 2, GRIP.y + GRIP.length / 2 + 0.06, HANDLE.radius * 1.15);
  rivet.scale.set(1, 1, 0.5);
  group.add(rivet);

  return {
    group,
    // The grip band's centre and radius in the knife's own space, for hit testing.
    grip: { center: new THREE.Vector3(-BLADE.width / 2, GRIP.y, 0), radius: HANDLE.radius * 1.35, length: GRIP.length },
    // The top of the handle, in the knife's own space: the handle is where the knife is dragged.
    top: new THREE.Vector3(-BLADE.width / 2, base + HANDLE.length, 0),
    // 0..1: how lit the grip is (pressed).
    set gripGlow(value) { gripUniforms.gripGlow.value = value * 0.5; },
    // 0..1: how much stone powder clings to the blade.
    set dust(value) { uniforms.knifeDust.value = value; },
    get dust() { return uniforms.knifeDust.value; },
  };
}
