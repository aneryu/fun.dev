const DUCK_REST_ORIGIN = [0.0, -0.04, 0.05];

export const BATH_DUCK_BLOCKS = [
  {
    id: "duckBody",
    label: "圆润鸭身",
    prim: "ellipsoid",
    op: "smoothUnion",
    k: 0.08,
    group: "duck",
    mirrorX: false,
    pos: [0.0, -0.06, 0.05],
    size: [0.28, 0.21, 0.33],
    round: 0.02,
    color: [1.0, 0.83, 0.16],
    roughness: 0.36,
  },
  {
    id: "duckHead",
    label: "饱满鸭头",
    prim: "sphere",
    op: "smoothUnion",
    k: 0.08,
    group: "duck",
    mirrorX: false,
    pos: [0.0, 0.16, 0.18],
    size: [0.195, 0.195, 0.195],
    round: 0.02,
    color: [1.0, 0.83, 0.16],
    roughness: 0.36,
  },
  {
    id: "duckBeak",
    label: "橘红鸭嘴",
    prim: "ellipsoid",
    op: "smoothUnion",
    k: 0.025,
    group: "beak",
    mirrorX: false,
    pos: [0.0, 0.13, 0.36],
    size: [0.11, 0.052, 0.10],
    round: 0.02,
    color: [0.96, 0.44, 0.08],
    roughness: 0.32,
  },
  {
    id: "duckEyes",
    label: "高光黑眼",
    prim: "sphere",
    op: "smoothUnion",
    k: 0.005,
    group: "eye",
    mirrorX: true,
    pos: [0.095, 0.19, 0.33],
    size: [0.034, 0.034, 0.034],
    round: 0.01,
    color: [0.03, 0.03, 0.03],
    roughness: 0.03,
  },
  {
    id: "duckWings",
    label: "两侧小翅",
    prim: "ellipsoid",
    op: "smoothUnion",
    k: 0.05,
    group: "duck",
    mirrorX: true,
    pos: [0.25, -0.03, 0.03],
    size: [0.07, 0.12, 0.19],
    round: 0.02,
    color: [1.0, 0.83, 0.16],
    roughness: 0.36,
  },
  {
    id: "duckTail",
    label: "上翘小尾",
    prim: "capsule",
    op: "smoothUnion",
    k: 0.05,
    group: "duck",
    mirrorX: false,
    pos: [0.0, 0.055, -0.24],
    size: [0.11, 0.055, 0.05],
    round: 0.04,
    color: [1.0, 0.83, 0.16],
    roughness: 0.36,
  },
  {
    id: "waterPool",
    label: "碧蓝水面",
    prim: "cylinder",
    op: "smoothUnion",
    k: 0.02,
    group: "water",
    mirrorX: false,
    pos: [0.0, -0.33, 0.0],
    size: [0.75, 0.19, 0.75],
    round: 0.0,
    color: [0.10, 0.72, 0.90],
    roughness: 0.14,
  },
  {
    id: "tubOuter",
    label: "陶瓷浴盆外壁",
    prim: "cylinder",
    op: "smoothUnion",
    k: 0.03,
    group: "tub",
    mirrorX: false,
    pos: [0.0, -0.30, 0.0],
    size: [0.84, 0.23, 0.84],
    round: 0.0,
    color: [0.98, 0.96, 0.90],
    roughness: 0.16,
  },
  {
    id: "tubInner",
    label: "浴盆内腔(挖孔)",
    prim: "cylinder",
    op: "smoothSubtract",
    k: 0.03,
    group: "tub",
    mirrorX: false,
    pos: [0.0, -0.24, 0.0],
    size: [0.74, 0.24, 0.74],
    round: 0.0,
    color: [0.98, 0.96, 0.90],
    roughness: 0.16,
  },
  {
    id: "tubRim",
    label: "浴盆圆润卷边",
    prim: "torus",
    op: "smoothUnion",
    k: 0.04,
    group: "tub",
    mirrorX: false,
    pos: [0.0, -0.09, 0.0],
    size: [0.79, 0.065, 0.79],
    round: 0.02,
    color: [0.98, 0.96, 0.90],
    roughness: 0.16,
  },
];

export const BATH_DUCK_PRESET = {
  id: "bath-duck",
  title: "澡盆小鸭",
  voxelSize: 0.040,
  ground: { y: -0.53, radius: 1.65 },
  bounds: { center: [0.0, -0.20, 0.0], radius: 1.02 },
  camera: {
    target: [0.0, -0.20, 0.0],
    distance: 3.25,
    angles: [0.25, 0.42],
    fov: 37,
  },
  initialCamera: { yaw: 0.25, pitch: 0.42, distance: 3.25, target: [0.0, -0.20, 0.0] },
  blocks: BATH_DUCK_BLOCKS,
};

function f3(n) {
  return Number(n).toFixed(3);
}

function buildBathDuckEvalWGSL(blocks) {
  const byId = Object.fromEntries(blocks.map((b) => [b.id, b]));
  const body = byId.duckBody;
  const head = byId.duckHead;
  const beak = byId.duckBeak;
  const eyes = byId.duckEyes;
  const wings = byId.duckWings;
  const tail = byId.duckTail;
  const water = byId.waterPool;
  const tubOuter = byId.tubOuter;
  const tubInner = byId.tubInner;
  const tubRim = byId.tubRim;

  const rel = (pos) => [
    pos[0] - DUCK_REST_ORIGIN[0],
    pos[1] - DUCK_REST_ORIGIN[1],
    pos[2] - DUCK_REST_ORIGIN[2],
  ];

  const bPos = rel(body.pos);
  const hPos = rel(head.pos);
  const kPos = rel(beak.pos);
  const ePos = rel(eyes.pos);
  const wPos = rel(wings.pos);
  const tPos = rel(tail.pos);
  const tailA = [tPos[0], tPos[1] - tail.size[1], tPos[2] + tail.size[2]];
  const tailB = [tPos[0], tPos[1] + tail.size[1], tPos[2] - tail.size[2]];
  const waterSurfaceY = water.pos[1] + water.size[1];

  return `struct BathEval {
  dDuck: f32,
  dBeak: f32,
  dEye: f32,
  dWater: f32,
  dTub: f32,
};

fn evalBath(p: vec3f) -> BathEval {
  let duckPos = state(256u).xyz;
  let fat = clamp(p_chubby(), 0.7, 1.5);
  var dDuck = length(p - duckPos) - 0.48 * fat;
  var dBeak = 10.0;
  var dEye = 10.0;

  if (dDuck < 0.15) {
    let yaw = state(256u).w;
    let duckRot = state(258u);
    let qDuck = rotX(duckRot.x) * rotZ(duckRot.y) * rotY(yaw) * (p - duckPos);

    let torso = sdEllipsoid(qDuck - vec3f(${f3(bPos[0])}, ${f3(bPos[1])}, ${f3(bPos[2])}), vec3f(${f3(body.size[0])} * fat, ${f3(body.size[1])}, ${f3(body.size[2])} * fat));
    let head = sdSphere(qDuck - vec3f(${f3(hPos[0])}, ${f3(hPos[1])}, ${f3(hPos[2])}), ${f3(head.size[0])} * fat);
    let tail = sdTaperedCapsule(qDuck, vec3f(${f3(tailA[0])}, ${f3(tailA[1])}, ${f3(tailA[2])} * fat), vec3f(${f3(tailB[0])}, ${f3(tailB[1])}, ${f3(tailB[2])} * fat), ${f3(tail.size[0])} * fat, ${f3(tail.round)});
    let qSym = opSymX(qDuck);
    let wing = sdEllipsoid(qSym - vec3f(${f3(wPos[0])} * fat, ${f3(wPos[1])}, ${f3(wPos[2])}), vec3f(${f3(wings.size[0])}, ${f3(wings.size[1])}, ${f3(wings.size[2])} * fat));
    dDuck = opSmoothUnion(opSmoothUnion(torso, head, ${f3(head.k)}), opSmoothUnion(tail, wing, ${f3(wings.k)}), ${f3(tail.k)});

    dBeak = sdEllipsoid(qDuck - vec3f(${f3(kPos[0])}, ${f3(kPos[1])}, ${f3(kPos[2])} * fat), vec3f(${f3(beak.size[0])}, ${f3(beak.size[1])}, ${f3(beak.size[2])}));
    dEye = sdSphere(qSym - vec3f(${f3(ePos[0])} * fat, ${f3(ePos[1])}, ${f3(ePos[2])} * fat), ${f3(eyes.size[0])});
  }

  // Ceramic bath basin generated from BATH_DUCK_BLOCKS (tubOuter - tubInner + tubRim)
  let outerCyl = sdCylinder(p - vec3f(${f3(tubOuter.pos[0])}, ${f3(tubOuter.pos[1])}, ${f3(tubOuter.pos[2])}), ${f3(tubOuter.size[1])}, ${f3(tubOuter.size[0])});
  let innerCut = sdCylinder(p - vec3f(${f3(tubInner.pos[0])}, ${f3(tubInner.pos[1])}, ${f3(tubInner.pos[2])}), ${f3(tubInner.size[1])}, ${f3(tubInner.size[0])});
  let rim = sdTorus(p - vec3f(${f3(tubRim.pos[0])}, ${f3(tubRim.pos[1])}, ${f3(tubRim.pos[2])}), vec2f(${f3(tubRim.size[0])}, ${f3(tubRim.size[1])}));
  let dTub = opSmoothUnion(opSmoothSubtraction(innerCut, outerCyl, ${f3(tubInner.k)}), rim, ${f3(tubRim.k)});

  // 3D Water volume inside the basin modulated by the 16x16 Compute wave heightfield
  let waveH = sampleWaterHeight(p.xz);
  let waterPlane = p.y - (${f3(waterSurfaceY)} + waveH);
  let waterCyl = sdCylinder(p - vec3f(${f3(water.pos[0])}, ${f3(water.pos[1] + 0.07)}, ${f3(water.pos[2])}), ${f3(water.size[1])}, ${f3(water.size[0])});
  let dWater = max(waterCyl, waterPlane) / 1.12;

  return BathEval(dDuck, dBeak, dEye, dWater, dTub);
}

fn sdf(p: vec3f) -> f32 {
  let bound = length(p - vec3f(0.0, -0.10, 0.0)) - 1.05;
  if (bound > 0.16) {
    return bound;
  }
  let ev = evalBath(p);
  let duckFull = opUnion(opSmoothUnion(ev.dDuck, ev.dBeak, ${f3(beak.k)}), ev.dEye);
  let tubAndWater = opUnion(ev.dTub, ev.dWater);
  return opUnion(duckFull, tubAndWater);
}

fn material(p: vec3f, n: vec3f) -> Material {
  let ev = evalBath(p);
  let duckFull = opUnion(opSmoothUnion(ev.dDuck, ev.dBeak, ${f3(beak.k)}), ev.dEye);

  if (ev.dWater <= duckFull + 0.003 && ev.dWater <= ev.dTub + 0.003) {
    return matJelly(vec3f(${f3(water.color[0])}, ${f3(water.color[1])}, ${f3(water.color[2])}), 0.88);
  }
  if (ev.dTub < duckFull) {
    return matRubber(vec3f(${f3(tubOuter.color[0])}, ${f3(tubOuter.color[1])}, ${f3(tubOuter.color[2])}), ${f3(tubOuter.roughness)});
  }
  let cId = i32(round(p_colorway()));
  var bodyCol = vec3f(${f3(body.color[0])}, ${f3(body.color[1])}, ${f3(body.color[2])});
  if (cId == 1) {
    bodyCol = vec3f(0.0, 0.82, 0.83);
  } else if (cId == 2) {
    bodyCol = vec3f(1.0, 0.62, 0.26);
  } else if (cId == 3) {
    bodyCol = vec3f(0.96, 0.96, 0.98);
  }
  let beakW = smoothstep(0.005, -0.005, ev.dBeak - ev.dDuck);
  var mat = mixMaterial(
    matRubber(bodyCol, ${f3(body.roughness)}),
    matRubber(vec3f(${f3(beak.color[0])}, ${f3(beak.color[1])}, ${f3(beak.color[2])}), ${f3(beak.roughness)}),
    beakW
  );
  let eyeW = smoothstep(0.004, -0.004, ev.dEye - min(ev.dDuck, ev.dBeak));
  return mixMaterial(mat, matRubber(vec3f(${f3(eyes.color[0])}, ${f3(eyes.color[1])}, ${f3(eyes.color[2])}), ${f3(eyes.roughness)}), eyeW);
}`;
}

function buildInitialBathState() {
  const buf = new Array(260 * 4).fill(0);
  // Seed an initial gentle central ripple so the water is alive right from t=0
  for (let gy = 0; gy < 16; gy++) {
    for (let gx = 0; gx < 16; gx++) {
      const idx = (gy * 16 + gx) * 4;
      const u = (gx / 15) * 2 - 1;
      const v = (gy / 15) * 2 - 1;
      const r = Math.hypot(u - 0.25, v - 0.2);
      buf[idx + 0] = Number((Math.cos(r * 6.0) * Math.exp(-r * 2.5) * 0.035).toFixed(4));
    }
  }
  // Slot 256: duck pos (x, y, z) + yaw (w) matching BATH_DUCK_BLOCKS world coordinates
  buf[256 * 4 + 0] = DUCK_REST_ORIGIN[0];
  buf[256 * 4 + 1] = DUCK_REST_ORIGIN[1];
  buf[256 * 4 + 2] = DUCK_REST_ORIGIN[2];
  buf[256 * 4 + 3] = 0.0;
  // Slot 257: duck vel (vx, vy, vz)
  // Slot 258: duck pitch (x), roll (y), pitchVel (z), rollVel (w)
  return buf;
}

export const bathDuckScene = {
  id: BATH_DUCK_PRESET.id,
  apiVersion: 3,
  title: { zh: BATH_DUCK_PRESET.title, en: "Bath Duck" },
  description: {
    zh: "泡在陶瓷浴盆里的小鸭子，拖拽它拍起一圈圈水花，看它随着波浪晃晃悠悠。",
    en: "A tiny duck floating in a porcelain tub — drag it around to splash ripples across the water.",
  },
  // 0..255: 16x16 water grid (x = height, y = vel)
  // 256: duck pos (xyz) + yaw (w)
  // 257: duck vel (xyz) + squash (w)
  // 258: duck pitch (x), roll (y), pitchVel (z), rollVel (w)
  stateCount: 260,
  substeps: 2,
  stepScale: 0.82,
  ground: BATH_DUCK_PRESET.ground,
  bounds: BATH_DUCK_PRESET.bounds,
  camera: BATH_DUCK_PRESET.camera,
  blocks: BATH_DUCK_BLOCKS,
  params: {
    waveSpeed: { label: { zh: "波速张力", en: "Wave Speed" }, default: 1.15, min: 0.4, max: 2.0, step: 0.05 },
    buoyancy: { label: { zh: "浮力弹性", en: "Buoyancy" }, default: 1.1, min: 0.4, max: 2.0, step: 0.05 },
    chop: { label: { zh: "涟漪强度", en: "Ripple Amp" }, default: 1.0, min: 0.2, max: 1.8, step: 0.05 },
    colorway: { label: { zh: "小鸭配色", en: "Colorway" }, default: 0.0, min: 0.0, max: 3.0, step: 1.0 },
    chubby: { label: { zh: "体型胖瘦", en: "Chubby" }, default: 1.0, min: 0.7, max: 1.5, step: 0.05 },
  },
  initialState: buildInitialBathState(),
  wgsl: `fn gridCoordToWorld(gx: u32, gz: u32) -> vec2f {
  return (vec2f(f32(gx), f32(gz)) / 15.0 * 2.0 - 1.0) * 0.72;
}

fn readCellH(gx: i32, gz: i32) -> f32 {
  let cx = u32(clamp(gx, 0, 15));
  let cz = u32(clamp(gz, 0, 15));
  return state(cz * 16u + cx).x;
}

// Bilinearly samples the 16x16 Compute wave heightfield in O(1)
fn sampleWaterHeight(xz: vec2f) -> f32 {
  let uv = clamp((xz / 0.72) * 0.5 + 0.5, vec2f(0.0), vec2f(1.0)) * 15.0;
  let i0 = vec2i(floor(uv));
  let i1 = min(i0 + vec2i(1, 1), vec2i(15, 15));
  let f = fract(uv);
  let h00 = readCellH(i0.x, i0.y);
  let h10 = readCellH(i1.x, i0.y);
  let h01 = readCellH(i0.x, i1.y);
  let h11 = readCellH(i1.x, i1.y);
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y) * p_chop();
}

fn simulate(i: u32) -> vec4f {
  let h = clamp(dt(), 0.001, 0.025);
  let t = time();
  let duckPosSlot = state(256u);
  let duckVelSlot = state(257u);
  let duckRotSlot = state(258u);

  // Threads 0..255: 16x16 2D Wave Equation Solver
  if (i < 256u) {
    let gx = i32(i % 16u);
    let gz = i32(i / 16u);
    let cell = state(i);
    var u = cell.x;
    var v = cell.y;

    let uL = readCellH(gx - 1, gz);
    let uR = readCellH(gx + 1, gz);
    let uD = readCellH(gx, gz - 1);
    let uU = readCellH(gx, gz + 1);
    let laplacian = (uL + uR + uD + uU - 4.0 * u);

    let c2 = 28.0 * p_waveSpeed();
    var acc = c2 * laplacian - 1.8 * u;

    let worldXZ = gridCoordToWorld(u32(gx), u32(gz));
    let rBasin = length(worldXZ);

    // Gentle ambient droplet plops near the tub rim
    let plopPos = vec2f(cos(t * 1.7) * 0.42, sin(t * 2.3) * 0.42);
    let dPlop = length(worldXZ - plopPos);
    acc += exp(-dPlop * dPlop * 45.0) * sin(t * 9.5) * 1.1;

    // Interactive pointer or space-poke splashes!
    if (pickActive() > 0.5 || pointerDown() > 0.5) {
      let splashXZ = pickTarget().xz;
      let dSplash = length(worldXZ - splashXZ);
      let splashStrength = select(2.6, 4.2, pickJustPressed());
      acc -= exp(-dSplash * dSplash * 36.0) * splashStrength;
    }

    // Coupling from duck vertical bobbing velocity into water surface
    let dDuck = length(worldXZ - duckPosSlot.xz);
    acc += exp(-dDuck * dDuck * 28.0) * (duckVelSlot.y * 2.2);

    // Soft circular tub wall boundary damping
    let wallMask = smoothstep(0.74, 0.58, rBasin);
    v = (v + acc * h) * exp(-h * 1.45) * wallMask;
    u = clamp((u + v * h) * wallMask, -0.12, 0.12);
    return vec4f(u, v, 0.0, 0.0);
  }

  // Slots 256..258: Archimedes Buoyancy & Wave-Slope Torque on the Floating Duck
  let pos = duckPosSlot.xyz;
  let yaw = duckPosSlot.w;
  let vel = duckVelSlot.xyz;
  let pitch = duckRotSlot.x;
  let roll = duckRotSlot.y;
  let pitchVel = duckRotSlot.z;
  let rollVel = duckRotSlot.w;

  let hCenter = sampleWaterHeight(pos.xz);
  let hRight = sampleWaterHeight(pos.xz + vec2f(0.12, 0.0));
  let hLeft = sampleWaterHeight(pos.xz - vec2f(0.12, 0.0));
  let hFront = sampleWaterHeight(pos.xz + vec2f(0.0, 0.12));
  let hBack = sampleWaterHeight(pos.xz - vec2f(0.0, 0.12));

  let waveSlopeX = (hRight - hLeft) / 0.24;
  let waveSlopeZ = (hFront - hBack) / 0.24;

  // Target equilibrium floating height tracks wave crest
  let targetY = -0.05 + hCenter * 1.15;
  var force = vec3f(
    -waveSlopeX * 1.8 - pos.x * 4.5,
    (targetY - pos.y) * (38.0 * p_buoyancy()),
    -waveSlopeZ * 1.8 - pos.z * 4.5
  );

  if (pickActive() > 0.5) {
    force += pickDir() * 24.0;
  }

  var nextVel = (vel + force * h) * exp(-h * 4.2);
  let rawPos = pos + nextVel * h;
  let maxRadial = 0.36;
  var nextXZ = rawPos.xz;
  if (length(nextXZ) > maxRadial) {
    nextXZ = normalize(nextXZ) * maxRadial;
    nextVel.x *= -0.4;
    nextVel.z *= -0.4;
  }
  let nextY = clamp(rawPos.y, -0.24, 0.32);

  if (i == 256u) {
    let nextYaw = yaw + sin(t * 0.8) * 0.15 * h;
    return vec4f(nextXZ.x, nextY, nextXZ.y, nextYaw);
  }
  if (i == 257u) {
    return vec4f(nextVel, 0.0);
  }
  if (i == 258u) {
    let targetPitch = clamp(-waveSlopeZ * 1.35 + nextVel.z * 0.25, -0.38, 0.38);
    let targetRoll = clamp(waveSlopeX * 1.35 - nextVel.x * 0.25, -0.38, 0.38);
    let pVel = (pitchVel + (targetPitch - pitch) * 42.0 * h) * exp(-h * 5.0);
    let rVel = (rollVel + (targetRoll - roll) * 42.0 * h) * exp(-h * 5.0);
    return vec4f(pitch + pVel * h, roll + rVel * h, pVel, rVel);
  }
  return state(i);
}

${buildBathDuckEvalWGSL(BATH_DUCK_BLOCKS)}`,
};
