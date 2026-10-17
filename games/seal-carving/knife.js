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
  const { Fn, vec2, vec3, float, mix, smoothstep, step, fract, floor, sin, dot, atan, clamp, normalize, uniform, positionGeometry, normalView, materialColor, materialMetalness, materialEmissive } = THREE.TSL;
  const knifeDust = uniform(0);
  const knifeHash = Fn(([n]) => fract(sin(n).mul(43758.5453))).setLayout({ name: "knifeHash", type: "float", inputs: [{ name: "n", type: "float" }] });
  const knifeNoise = Fn(([p]) => {
    const i = floor(p).toVar();
    const f = fract(p).toVar();
    f.assign(f.mul(f).mul(f.mul(-2.0).add(3.0)));
    const h = (dx, dy) => knifeHash(i.x.add(dx).add(i.y.add(dy).mul(57.0)));
    return mix(mix(h(0, 0), h(1, 0), f.x), mix(h(0, 1), h(1, 1), f.x), f.y);
  }).setLayout({ name: "knifeNoise", type: "float", inputs: [{ name: "p", type: "vec2" }] });
  const kp = positionGeometry;
  const facet = float(1.0).sub(smoothstep(BLADE.bevel * 0.92, BLADE.bevel, kp.y));
  // Stone powder clings to the lower blade, thickest at the edge, ragged at its top.
  const dustLine = knifeDust.mul(knifeNoise(vec2(kp.x.mul(90.0), 3.0)).mul(0.1).add(0.05));
  const dust = knifeDust.mul(float(1.0).sub(smoothstep(dustLine.mul(0.6), dustLine, kp.y))).mul(knifeNoise(kp.xy.mul(400.0)).mul(0.45).add(0.55));
  // The very edge is honed bright.
  const honed = float(1.0).sub(smoothstep(0.0, 0.004, kp.y));
  // Grinding marks: fine streaks across the blade, finer on the bevels.
  const scratch = knifeHash(floor(kp.y.mul(mix(700.0, 1600.0, facet)).add(kp.x.mul(30.0))));
  const steel = track(new THREE.MeshStandardNodeMaterial({ color: 0x6d7176, metalness: 0.75, roughness: 0.45, envMapIntensity: 1.1 }));
  steel.colorNode = mix(materialColor.mul(mix(1.0, 1.9, facet)), vec3(0.93, 0.9, 0.86), dust).add(honed.mul(0.35));
  steel.roughnessNode = mix(clamp(mix(0.5, 0.18, facet).add(scratch.sub(0.5).mul(0.22)), 0.08, 0.85), 0.95, dust);
  steel.metalnessNode = mix(materialMetalness, 0.0, dust);
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
  const gripGlow = uniform(0);
  const cordHash = Fn(([p]) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453))).setLayout({ name: "cordHash", type: "float", inputs: [{ name: "p", type: "vec2" }] });
  const cordNoise = Fn(([p]) => {
    const i = floor(p).toVar();
    const f = fract(p).toVar();
    f.assign(f.mul(f).mul(f.mul(-2.0).add(3.0)));
    return mix(mix(cordHash(i), cordHash(i.add(vec2(1, 0))), f.x), mix(cordHash(i.add(vec2(0, 1))), cordHash(i.add(vec2(1, 1))), f.x), f.y);
  }).setLayout({ name: "cordNoise", type: "float", inputs: [{ name: "p", type: "vec2" }] });
  const cp = positionGeometry;
  const around = atan(cp.z, cp.x.add(BLADE.width / 2)).div(6.2831853);
  // Wraps of cloth, uneven, with years of brown handling stains.
  const turns = cp.y.mul(55.0).add(around.mul(1.5)).add(cordNoise(vec2(around.mul(8.0), cp.y.mul(6.0))).mul(1.5));
  const ridge = fract(turns).sub(0.5).abs().mul(2.0);
  const stain = smoothstep(0.45, 0.8, cordNoise(vec2(around.mul(6.0), cp.y.mul(9.0))).mul(0.7).add(cordNoise(vec2(around.mul(25.0), cp.y.mul(40.0))).mul(0.3)));
  const fleck = step(0.9, cordHash(floor(vec2(around.mul(160.0), cp.y.mul(260.0)))));
  const wrapShade = float(1.0).sub(ridge.mul(ridge));
  const cloth = mix(materialColor.mul(wrapShade.mul(0.16).add(0.84)), vec3(0.5, 0.38, 0.27), stain.mul(0.6).add(fleck.mul(0.35)));
  // The dyed band ends along the wraps, a little ragged, as dyed thread would.
  const bandEdge = cordNoise(vec2(around.mul(12.0), 4.0)).mul(0.012);
  const gripLow = GRIP.y - GRIP.length / 2, gripHigh = GRIP.y + GRIP.length / 2;
  const gripBand = smoothstep(gripLow - 0.004, gripLow + 0.004, cp.y.add(bandEdge)).mul(float(1.0).sub(smoothstep(gripHigh - 0.004, gripHigh + 0.004, cp.y.sub(bandEdge))));
  const dyed = vec3(0.42, 0.07, 0.05).mul(wrapShade.mul(0.28).add(0.72)).mul(mix(1.0, 0.7, stain));
  const cord = track(new THREE.MeshStandardNodeMaterial({ color: 0xdcd4c4, roughness: 0.9 }));
  cord.colorNode = mix(cloth, dyed, gripBand);
  cord.emissiveNode = materialEmissive.add(vec3(0.55, 0.1, 0.06).mul(gripGlow).mul(gripBand));
  cord.normalNode = normalize(normalView.add(vec3(0.0, fract(cp.y.mul(55.0).add(atan(cp.z, cp.x).div(6.2831853).mul(1.5))).sub(0.5).mul(0.35), 0.0)));
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
    set gripGlow(value) { gripGlow.value = value * 0.5; },
    // 0..1: how opaque the knife is (it fades while cutting, so the groove shows).
    set fade(value) {
      group.traverse((object) => {
        if (!object.material || object.material.opacity === value) return;
        const transparent = value < 1;
        if (object.material.transparent !== transparent) { object.material.transparent = transparent; object.material.needsUpdate = true; }
        object.material.opacity = value;
        object.material.depthWrite = !transparent;
      });
    },
    // 0..1: how much stone powder clings to the blade.
    set dust(value) { knifeDust.value = value; },
    get dust() { return knifeDust.value; },
  };
}
