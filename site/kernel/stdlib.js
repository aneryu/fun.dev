// WGSL SDF Standard Library & Host Shading Primitives.
// Appended AFTER user scene WGSL so user line numbers map 1:1 from line 1.
// Zero dpdx/dpdy/fwidth calls to satisfy WGSL derivative uniformity in raymarching loops.

export const STDLIB_WGSL = /* wgsl */ `
const PI: f32 = 3.141592653589793;
const TAU: f32 = 6.283185307179586;

struct Material {
  color: vec3f,
  roughness: f32,
  metallic: f32,
  subsurface: f32,
  emission: vec3f,
};

fn matRubber(color: vec3f, roughness: f32) -> Material {
  return Material(color, clamp(roughness, 0.05, 1.0), 0.0, 0.38, vec3f(0.0));
}

fn matClay(color: vec3f) -> Material {
  return Material(color, 0.65, 0.0, 0.18, vec3f(0.0));
}

fn matJelly(color: vec3f, subsurface: f32) -> Material {
  return Material(color, 0.14, 0.0, clamp(subsurface, 0.0, 1.0), vec3f(0.0));
}

fn matMetal(color: vec3f, roughness: f32) -> Material {
  return Material(color, clamp(roughness, 0.04, 1.0), 0.88, 0.0, vec3f(0.0));
}

fn matEmit(color: vec3f, strength: f32) -> Material {
  return Material(color, 0.4, 0.0, 0.0, color * max(strength, 0.0));
}

fn mixMaterial(a: Material, b: Material, t: f32) -> Material {
  let k = clamp(t, 0.0, 1.0);
  return Material(
    mix(a.color, b.color, k),
    mix(a.roughness, b.roughness, k),
    mix(a.metallic, b.metallic, k),
    mix(a.subsurface, b.subsurface, k),
    mix(a.emission, b.emission, k)
  );
}

// --- Signed Distance Primitives ---

fn sdSphere(p: vec3f, r: f32) -> f32 {
  return length(p) - r;
}

fn sdEllipsoid(p: vec3f, r: vec3f) -> f32 {
  let rSafe = max(r, vec3f(0.0001));
  let minR = min(rSafe.x, min(rSafe.y, rSafe.z));
  let k0 = length(p / rSafe);
  if (k0 < 0.000001) {
    return -minR;
  }
  let k1 = length(p / (rSafe * rSafe));
  let iqScale = k0 / max(k1, 0.000001);
  let t = clamp(k0 / 0.5, 0.0, 1.0);
  let s = t * t * (3.0 - 2.0 * t);
  let effScale = mix(minR, iqScale, s);
  return (k0 - 1.0) * effScale;
}

fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn sdRoundBox(p: vec3f, b: vec3f, r: f32) -> f32 {
  let q = abs(p) - b + vec3f(r);
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

fn sdSuperellipseBox(p: vec3f, b: vec3f, nPower: f32, r: f32) -> f32 {
  let nSafe = max(b - vec3f(r), vec3f(0.0001));
  let e = clamp(nPower, 1.2, 6.0);
  let q = abs(p) - nSafe;
  let a = max(q, vec3f(0.0));
  let outDist = pow(pow(a.x, e) + pow(a.y, e) + pow(a.z, e), 1.0 / e);
  let inside = min(max(q.x, max(q.y, q.z)), 0.0);
  return outDist + inside - r;
}

fn sdCapsule(p: vec3f, a: vec3f, b: vec3f, r: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.00001), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

fn sdTaperedCapsule(p: vec3f, a: vec3f, b: vec3f, ra: f32, rb: f32) -> f32 {
  let ba = b - a;
  let l2 = max(dot(ba, ba), 0.00001);
  let pa = p - a;
  let h = clamp(dot(pa, ba) / l2, 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}

fn sdCylinder(p: vec3f, h: f32, r: f32) -> f32 {
  let d = abs(vec2f(length(p.xz), p.y)) - vec2f(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0)));
}

fn sdTorus(p: vec3f, t: vec2f) -> f32 {
  let q = vec2f(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

fn sdOctahedron(p: vec3f, s: f32) -> f32 {
  let q = abs(p);
  return (q.x + q.y + q.z - s) * 0.57735027;
}

fn sdPlane(p: vec3f, h: f32) -> f32 {
  return p.y - h;
}

// --- Boolean & Smooth Operators ---

fn opUnion(d1: f32, d2: f32) -> f32 {
  return min(d1, d2);
}

fn opSubtraction(d1: f32, d2: f32) -> f32 {
  return max(-d1, d2);
}

fn opIntersection(d1: f32, d2: f32) -> f32 {
  return max(d1, d2);
}

fn opSmoothUnion(d1: f32, d2: f32, k: f32) -> f32 {
  let ks = max(k, 0.0001);
  let h = clamp(0.5 + 0.5 * (d2 - d1) / ks, 0.0, 1.0);
  return mix(d2, d1, h) - ks * h * (1.0 - h);
}

fn opSmoothSubtraction(d1: f32, d2: f32, k: f32) -> f32 {
  let ks = max(k, 0.0001);
  let h = clamp(0.5 - 0.5 * (d2 + d1) / ks, 0.0, 1.0);
  return mix(d2, -d1, h) + ks * h * (1.0 - h);
}

fn opSmoothIntersection(d1: f32, d2: f32, k: f32) -> f32 {
  let ks = max(k, 0.000001);
  let h = clamp(0.5 - 0.5 * (d2 - d1) / ks, 0.0, 1.0);
  return mix(d2, d1, h) + ks * h * (1.0 - h);
}

// Argument-order-normalized smooth boolean helpers matching JS opSmoothSubtractJS(base, cutter, k)
fn opSmoothSubtract(base: f32, cutter: f32, k: f32) -> f32 {
  return opSmoothSubtraction(cutter, base, k);
}

fn opSmoothIntersect(d1: f32, d2: f32, k: f32) -> f32 {
  return opSmoothIntersection(d1, d2, k);
}

// Returns smooth blend factor in [0, 1] (0 = d1 dominates, 1 = d2 dominates) for material mixing.
fn opBlendWeight(d1: f32, d2: f32, k: f32) -> f32 {
  let ks = max(k, 0.0001);
  return clamp(0.5 + 0.5 * (d1 - d2) / ks, 0.0, 1.0);
}

// --- Domain & Space Operators ---

fn opSymX(p: vec3f) -> vec3f {
  return vec3f(abs(p.x), p.y, p.z);
}

fn opSymXZ(p: vec3f) -> vec3f {
  return vec3f(abs(p.x), p.y, abs(p.z));
}

fn opRepLim(p: vec3f, s: f32, lima: vec3f, limb: vec3f) -> vec3f {
  return p - s * clamp(round(p / s), lima, limb);
}

fn opRepPolar(p: vec3f, repetitions: f32) -> vec3f {
  let angle = TAU / max(repetitions, 1.0);
  let a = atan2(p.z, p.x) + angle * 0.5;
  let r = length(p.xz);
  let c = floor(a / angle);
  let aMod = a - c * angle - angle * 0.5;
  return vec3f(cos(aMod) * r, p.y, sin(aMod) * r);
}

fn opTwistY(p: vec3f, k: f32) -> vec3f {
  let c = cos(k * p.y);
  let s = sin(k * p.y);
  return vec3f(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}

fn opBendY(p: vec3f, k: f32) -> vec3f {
  let c = cos(k * p.x);
  let s = sin(k * p.x);
  return vec3f(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}

// Volume-preserving squash & stretch around Y=0: scales Y by sy and XZ by 1/sqrt(sy).
// Divide the resulting SDF distance by stretchLipschitz(sy) so raymarching never oversteps.
fn opVolumeStretchY(p: vec3f, sy: f32) -> vec3f {
  let s = clamp(sy, 0.35, 2.5);
  let xzScale = sqrt(s);
  return vec3f(p.x * xzScale, p.y / s, p.z * xzScale);
}

fn stretchLipschitz(sy: f32) -> f32 {
  let s = clamp(sy, 0.35, 2.5);
  return max(sqrt(s), 1.0 / s);
}

// Regularized Kelvinlet elastic grab / poke domain warp.
// Automatically expands effective radius eps when |disp| is large so space never folds (Jacobian > 0).
fn opKelvinletGrab(p: vec3f, grabOrigin: vec3f, disp: vec3f, eps: f32) -> vec3f {
  let dispLen = length(disp);
  if (dispLen < 0.0001) {
    return p;
  }
  let safeEps = max(max(eps, 0.06), dispLen * 1.38);
  let rVec = p - grabOrigin;
  let r2 = dot(rVec, rVec);
  let e2 = safeEps * safeEps;
  let rEps2 = r2 + e2;
  let rEps = sqrt(rEps2);
  let rEps3 = rEps * rEps2;
  let iso = (0.5 * safeEps / rEps) + (0.25 * safeEps * e2 / rEps3);
  let aniso = (0.25 * safeEps / rEps3) * dot(rVec, disp);
  return p - (disp * iso + rVec * aniso);
}

fn kelvinletLipschitz(disp: vec3f, eps: f32) -> f32 {
  let dispLen = length(disp);
  let safeEps = max(max(eps, 0.06), dispLen * 1.38);
  return 1.0 + 0.65 * dispLen / safeEps;
}

fn rotX(a: f32) -> mat3x3f {
  let c = cos(a);
  let s = sin(a);
  return mat3x3f(
    vec3f(1.0, 0.0, 0.0),
    vec3f(0.0, c, -s),
    vec3f(0.0, s, c)
  );
}

fn rotY(a: f32) -> mat3x3f {
  let c = cos(a);
  let s = sin(a);
  return mat3x3f(
    vec3f(c, 0.0, s),
    vec3f(0.0, 1.0, 0.0),
    vec3f(-s, 0.0, c)
  );
}

fn rotZ(a: f32) -> mat3x3f {
  let c = cos(a);
  let s = sin(a);
  return mat3x3f(
    vec3f(c, -s, 0.0),
    vec3f(s, c, 0.0),
    vec3f(0.0, 0.0, 1.0)
  );
}

fn rotateVecX(p: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}

fn rotateVecY(p: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

fn rotateVecZ(p: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}

// Clamps an IK target so it never exceeds total limb reach (prevents lower-limb stretching).
fn clampIKGoal(root: vec3f, goal: vec3f, len1: f32, len2: f32) -> vec3f {
  let toGoal = goal - root;
  let d = length(toGoal);
  let maxReach = (len1 + len2) * 0.992;
  let minReach = abs(len1 - len2) + 0.002;
  if (d < 0.0001) {
    return root + vec3f(0.0, -minReach, 0.0);
  }
  return root + (toGoal / d) * clamp(d, minReach, maxReach);
}

// Analytical 2-bone Inverse Kinematics solver:
// root = hip/shoulder 3D pos, goal = foot/hand 3D pos, poleDir = bend plane hint vector.
fn solveTwoBoneIK(root: vec3f, goal: vec3f, poleDir: vec3f, len1: f32, len2: f32) -> vec3f {
  let toGoal = goal - root;
  let rawLen = max(length(toGoal), 0.0001);
  let dist = clamp(rawLen, abs(len1 - len2) + 0.001, (len1 + len2) - 0.001);
  let dir = toGoal / rawLen;
  let cosAngle = clamp((len1 * len1 + dist * dist - len2 * len2) / (2.0 * len1 * dist), -1.0, 1.0);
  let sinAngle = sqrt(max(0.0, 1.0 - cosAngle * cosAngle));
  var ortho = poleDir - dir * dot(poleDir, dir);
  if (dot(ortho, ortho) < 0.00001) {
    let fallbackAxis = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(dir.y) > 0.85);
    ortho = fallbackAxis - dir * dot(fallbackAxis, dir);
  }
  let bendDir = normalize(ortho);
  return root + (dir * cosAngle + bendDir * sinAngle) * len1;
}

// --- Deterministic Hash & Procedural Noise ---

fn hash11(p: f32) -> f32 {
  var q = fract(p * 0.1031);
  q *= q + 33.33;
  q *= q + q;
  return fract(q);
}

fn hash31(p: vec3f) -> f32 {
  var q = fract(p * 0.1031);
  q += dot(q, q.zyx + 31.32);
  return fract((q.x + q.y) * q.z);
}

fn hash33(p: vec3f) -> vec3f {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}

fn noise3(x: vec3f) -> f32 {
  let i = floor(x);
  let f = fract(x);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(hash31(i + vec3f(0.0, 0.0, 0.0)), hash31(i + vec3f(1.0, 0.0, 0.0)), u.x),
      mix(hash31(i + vec3f(0.0, 1.0, 0.0)), hash31(i + vec3f(1.0, 1.0, 0.0)), u.x),
      u.y
    ),
    mix(
      mix(hash31(i + vec3f(0.0, 0.0, 1.0)), hash31(i + vec3f(1.0, 0.0, 1.0)), u.x),
      mix(hash31(i + vec3f(0.0, 1.0, 1.0)), hash31(i + vec3f(1.0, 1.0, 1.0)), u.x),
      u.y
    ),
    u.z
  );
}

// --- Analytical Tetrahedron Normal (4 SDF evaluations, usable in Compute & Fragment) ---

fn sdfNormalEps(p: vec3f, epsVal: f32) -> vec3f {
  let h = max(epsVal, 0.0005);
  let e = vec2f(h, -h);
  return normalize(
    e.xyy * sdf(p + e.xyy) +
    e.yyx * sdf(p + e.yyx) +
    e.yxy * sdf(p + e.yxy) +
    e.xxx * sdf(p + e.xxx)
  );
}

fn sdfNormal(p: vec3f) -> vec3f {
  return sdfNormalEps(p, 0.0012);
}
`;

export const STDLIB_FUNCTION_NAMES = new Set([
  "matRubber",
  "matClay",
  "matJelly",
  "matMetal",
  "matEmit",
  "mixMaterial",
  "sdSphere",
  "sdEllipsoid",
  "sdBox",
  "sdRoundBox",
  "sdCapsule",
  "sdTaperedCapsule",
  "sdCylinder",
  "sdTorus",
  "sdOctahedron",
  "sdPlane",
  "opUnion",
  "opSubtraction",
  "opIntersection",
  "opSmoothUnion",
  "opSmoothSubtraction",
  "opSmoothIntersection",
  "opBlendWeight",
  "opSymX",
  "opSymXZ",
  "opRepLim",
  "opRepPolar",
  "opTwistY",
  "opBendY",
  "opVolumeStretchY",
  "stretchLipschitz",
  "opKelvinletGrab",
  "kelvinletLipschitz",
  "rotX",
  "rotY",
  "rotZ",
  "clampIKGoal",
  "solveTwoBoneIK",
  "hash11",
  "hash31",
  "hash33",
  "noise3",
  "sdfNormal",
  "sdfNormalEps",
]);
