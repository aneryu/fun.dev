// Zero-Dependency WebGL2 Fallback Renderer (GLSL ES 3.00)
// Shares the exact 16-float vertex layout (`posAndMat`, `normalAndRough`, `colorAndMetal`, `localAndScale`)
// and live SDF block uniform evaluation (`u_sdfBlocks`) with WebGPU's `MESH_RENDER_WGSL`.

function mat4Perspective(fovRad, aspect, near, far) {
  const f = 1.0 / Math.tan(fovRad * 0.5);
  const nf = 1.0 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function mat4LookAt(eye, target, up) {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  const zLen = Math.hypot(zx, zy, zz) || 1;
  zx /= zLen; zy /= zLen; zz /= zLen;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  const xLen = Math.hypot(xx, xy, xz) || 1;
  xx /= xLen; xy /= xLen; xz /= xLen;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4 + 0];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    out[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

const VS_GLSL_300 = `#version 300 es
precision highp float;

layout(location = 0) in vec4 a_posAndMat;
layout(location = 1) in vec4 a_normalAndRough;
layout(location = 2) in vec4 a_colorAndMetal;
layout(location = 3) in vec4 a_localAndScale;

uniform mat4 u_viewProj;

out vec4 v_posAndMat;
out vec4 v_normalAndRough;
out vec4 v_colorAndMetal;
out vec4 v_localAndScale;

void main() {
  v_posAndMat = a_posAndMat;
  v_normalAndRough = a_normalAndRough;
  v_colorAndMetal = a_colorAndMetal;
  v_localAndScale = a_localAndScale;
  gl_Position = u_viewProj * vec4(a_posAndMat.xyz, 1.0);
}
`;

const FS_GLSL_300 = `#version 300 es
precision highp float;

in vec4 v_posAndMat;
in vec4 v_normalAndRough;
in vec4 v_colorAndMetal;
in vec4 v_localAndScale;

uniform vec3 u_camPos;
uniform vec3 u_sunDir;
uniform vec3 u_skyZenith;
uniform vec3 u_skyHorizon;
uniform float u_debugMode;
uniform vec4 u_sdfBlocks[64];

out vec4 outColor;

float opSmoothUnionLive(float d1, float d2, float k) {
  float h = clamp(0.5 + 0.5 * (d2 - d1) / max(k, 0.0001), 0.0, 1.0);
  return mix(d2, d1, h) - k * h * (1.0 - h);
}

float opSmoothSubLive(float d1, float d2, float k) {
  float h = clamp(0.5 - 0.5 * (d1 + d2) / max(k, 0.0001), 0.0, 1.0);
  return mix(d1, -d2, h) + k * h * (1.0 - h);
}

float sdEllipsoidLive(vec3 p, vec3 r) {
  vec3 rSafe = max(r, vec3(0.0001));
  float minR = min(rSafe.x, min(rSafe.y, rSafe.z));
  float k0 = length(p / rSafe);
  if (k0 < 0.000001) return -minR;
  float k1 = length(p / (rSafe * rSafe));
  float iqScale = k0 / max(k1, 0.000001);
  float t = clamp(k0 / 0.5, 0.0, 1.0);
  float s = t * t * (3.0 - 2.0 * t);
  return (k0 - 1.0) * mix(minR, iqScale, s);
}

float evalBathWaterWaveLive(vec2 xz) {
  vec2 uv = xz / 0.72 - vec2(0.25, 0.20);
  float r = length(uv);
  return cos(r * 6.0) * exp(-r * 2.5) * 0.035;
}

float evalLiveBlockPrim(vec3 p, vec4 b0, vec4 b1, vec4 b3) {
  int flags = int(round(b3.y));
  int groupId = int(round(b3.z));
  bool mirrorX = (flags & 1) != 0;
  vec3 q = vec3((mirrorX ? abs(p.x) : p.x) - b0.x, p.y - b0.y, p.z - b0.z);
  vec3 s = max(b1.xyz, vec3(0.012));
  float r = b1.w;
  int prim = int(round(b0.w));

  if (prim == 0) {
    if (abs(s.x - s.y) < 0.002 && abs(s.y - s.z) < 0.002) return length(q) - s.x;
    return sdEllipsoidLive(q, s);
  }
  if (prim == 1) return sdEllipsoidLive(q, s);
  if (prim == 2) {
    float rBox = clamp(r, 0.002, min(s.x, min(s.y, s.z)) * 0.85);
    vec3 d = abs(q) - s + vec3(rBox);
    return length(max(d, vec3(0.0))) + min(max(d.x, max(d.y, d.z)), 0.0) - rBox;
  }
  if (prim == 3) {
    float minXZ = min(s.x, s.z);
    float rad = length(vec2(q.x / s.x, q.z / s.z)) * minXZ;
    if (groupId == 3) {
      float waveH = evalBathWaterWaveLive(p.xz);
      float waterPlane = p.y - (b0.y + s.y + waveH);
      vec2 dCyl = abs(vec2(rad, q.y)) - vec2(minXZ, s.y + 0.04);
      float waterCyl = min(max(dCyl.x, dCyl.y), 0.0) + length(max(dCyl, vec2(0.0)));
      return max(waterCyl, waterPlane) / 1.12;
    }
    float rCyl = clamp(r, 0.0, min(minXZ, s.y) * 0.45);
    vec2 d = abs(vec2(rad, q.y)) - vec2(minXZ - rCyl, s.y - rCyl);
    return min(max(d.x, d.y), 0.0) + length(max(d, vec2(0.0))) - rCyl;
  }
  if (prim == 4) {
    vec3 a = vec3(0.0, -s.y, s.z);
    vec3 b = vec3(0.0, s.y, -s.z);
    vec3 ba = b - a;
    vec3 pa = q - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.00001), 0.0, 1.0);
    float rb = clamp(r, 0.015, s.x);
    return length(pa - ba * h) - mix(s.x, rb, h);
  }
  float minXZ = min(s.x, s.z);
  float rad = length(vec2(q.x / s.x, q.z / s.z)) * minXZ;
  return length(vec2(rad - minXZ, q.y)) - s.y;
}

float evalLiveSDF(vec3 p) {
  float bound = length(p - vec3(0.0, -0.10, 0.0)) - 1.35;
  if (bound > 0.20) return bound;
  float dDuck = 10.0, dBeak = 10.0, dEye = 10.0, dWater = 10.0, dTub = 10.0;
  float beakK = 0.025;
  int count = clamp(int(round(u_sdfBlocks[3].w)), 0, 16);
  for (int i = 0; i < 16; i++) {
    if (i >= count) break;
    int base = i * 4;
    vec4 b0 = u_sdfBlocks[base];
    vec4 b1 = u_sdfBlocks[base + 1];
    vec4 b3 = u_sdfBlocks[base + 3];
    float k = max(0.001, b3.x);
    int flags = int(round(b3.y));
    bool isSub = (flags & 2) != 0;
    int groupId = int(round(b3.z));
    float dp = evalLiveBlockPrim(p, b0, b1, b3);
    if (groupId == 0) {
      dDuck = isSub ? opSmoothSubLive(dDuck, dp, k) : (dDuck > 5.0 ? dp : opSmoothUnionLive(dDuck, dp, k));
    } else if (groupId == 1) {
      beakK = k;
      dBeak = isSub ? opSmoothSubLive(dBeak, dp, k) : (dBeak > 5.0 ? dp : opSmoothUnionLive(dBeak, dp, k));
    } else if (groupId == 2) {
      dEye = isSub ? opSmoothSubLive(dEye, dp, k) : (dEye > 5.0 ? dp : min(dEye, dp));
    } else if (groupId == 3) {
      dWater = isSub ? opSmoothSubLive(dWater, dp, k) : (dWater > 5.0 ? dp : opSmoothUnionLive(dWater, dp, k));
    } else {
      dTub = isSub ? opSmoothSubLive(dTub, dp, k) : (dTub > 5.0 ? dp : opSmoothUnionLive(dTub, dp, k));
    }
  }
  return min(min(opSmoothUnionLive(dDuck, dBeak, beakK), dEye), min(dTub, dWater));
}

vec3 evalLiveNormal(vec3 p, float eps) {
  vec2 e = vec2(1.0, -1.0) * 0.57735027;
  return normalize(
    e.xyy * evalLiveSDF(p + e.xyy * eps) +
    e.yyx * evalLiveSDF(p + e.yyx * eps) +
    e.yxy * evalLiveSDF(p + e.yxy * eps) +
    e.xxx * evalLiveSDF(p + e.xxx * eps)
  );
}

float calcLiveSoftShadow(vec3 ro, vec3 rd, float mint, float maxt, float k) {
  float res = 1.0;
  float t = mint;
  for (int i = 0; i < 24; i++) {
    float h = evalLiveSDF(ro + rd * t);
    if (h < 0.0008) return 0.0;
    res = min(res, k * h / t);
    if (res < 0.002) return 0.0;
    t += clamp(h * 0.45, 0.008, 0.065);
    if (t > maxt) break;
  }
  float s = clamp(res, 0.0, 1.0);
  return s * s * (3.0 - 2.0 * s);
}

float calcLiveAO(vec3 pos, vec3 nor) {
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 4; i++) {
    float h = 0.02 + 0.11 * float(i) / 3.0;
    vec3 samplePos = pos + h * nor;
    float d = evalLiveSDF(samplePos);
    occ += clamp(h - d, 0.0, h) * sca;
    sca *= 0.70;
  }
  float selfAO = clamp(1.0 - 2.35 * occ, 0.0, 1.0);
  float groundHorizon = mix(0.90, 1.0, smoothstep(0.0, 0.14, pos.y - -0.53));
  return selfAO * groundHorizon;
}

vec3 evalLiveBackdrop(vec3 ro, vec3 rd, vec3 keyLight) {
  vec3 bgSrgb = vec3(1.0, 212.0 / 255.0, 59.0 / 255.0);
  vec3 inkSrgb = vec3(33.0 / 255.0, 31.0 / 255.0, 23.0 / 255.0);
  vec3 colSrgb = bgSrgb;
  if (rd.y < -0.001) {
    float tg = (-0.53 - ro.y) / rd.y;
    if (tg > 0.0 && tg < 8.0) {
      vec3 gp = ro + rd * tg;
      float radialFade = smoothstep(1.65, 0.35, length(gp.xz));
      if (radialFade > 0.001) {
        float contactDist = clamp(evalLiveSDF(gp + vec3(0.0, 0.015, 0.0)) / 0.22, 0.0, 1.0);
        float contactAO = smoothstep(1.0, 0.0, contactDist) * 0.15;
        float sh = calcLiveSoftShadow(gp + vec3(0.0, 0.012, 0.0), keyLight, 0.025, 2.2, 5.0);
        float shadowStrength = ((1.0 - sh) * 0.18 + contactAO) * radialFade;
        colSrgb = mix(bgSrgb, inkSrgb, clamp(shadowStrength, 0.0, 0.28));
      }
    }
  }
  return colSrgb;
}

vec3 pbrToneMapGL(vec3 colorIn) {
  vec3 c = max(colorIn, vec3(0.0));
  float startCompression = 0.76;
  float desaturation = 0.15;
  float xMin = min(c.r, min(c.g, c.b));
  float offset = xMin < 0.08 ? xMin - 6.25 * xMin * xMin : 0.04;
  vec3 mapped = c - vec3(offset);
  float peak = max(mapped.r, max(mapped.g, mapped.b));
  if (peak >= startCompression) {
    float d = 1.0 - startCompression;
    float newPeak = 1.0 - d * d / (peak + d - startCompression);
    mapped *= newPeak / max(peak, 0.0001);
    float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    mapped = mix(mapped, vec3(newPeak), g);
  }
  return pow(clamp(mapped, vec3(0.0), vec3(1.0)), vec3(1.0 / 2.2));
}

void main() {
  int matId = int(round(v_posAndMat.w));
  vec3 worldPos = v_posAndMat.xyz;

  if (matId == 14) {
    vec3 ro = u_camPos;
    vec3 rd = normalize(worldPos - ro);
    vec3 keyLight = normalize(vec3(0.58, 0.76, 0.30));
    vec3 fillLight = normalize(vec3(-0.65, 0.35, -0.45));
    vec3 oc = ro - vec3(0.0, -0.15, 0.0);
    float bDot = dot(oc, rd);
    float cDot = dot(oc, oc) - 1.52 * 1.52;
    float disc = bDot * bDot - cDot;
    float t = 0.1;
    bool hit = false;
    if (disc >= 0.0) {
      float sqrtDisc = sqrt(disc);
      t = max(0.1, -bDot - sqrtDisc);
      float tMax = min(10.0, -bDot + sqrtDisc);
      if (rd.y < -0.001) {
        float tg = (-0.53 - ro.y) / rd.y;
        if (tg > 0.1) tMax = min(tMax, tg);
      }
      for (int i = 0; i < 64; i++) {
        float d = evalLiveSDF(ro + rd * t);
        if (d < 0.0018) { hit = true; break; }
        t += d * 0.82;
        if (t > tMax) break;
      }
    }
    if (!hit) {
      outColor = vec4(evalLiveBackdrop(ro, rd, keyLight), 1.0);
      return;
    }
    vec3 p = ro + rd * t;
    vec3 nL = evalLiveNormal(p, 0.0014);
    float dDuck = 10.0, dBeak = 10.0, dEye = 10.0, dWater = 10.0, dTub = 10.0, beakK = 0.025;
    vec3 duckCol = vec3(1.0, 0.83, 0.16), beakCol = vec3(0.96, 0.44, 0.08), eyeCol = vec3(0.03), waterCol = vec3(0.10, 0.72, 0.90), tubCol = vec3(0.98, 0.96, 0.90);
    float duckRough = 0.36, beakRough = 0.32, eyeRough = 0.03, waterRough = 0.14, tubRough = 0.16;
    float bestDuckD = 1e6, bestTubD = 1e6;
    int count = clamp(int(round(u_sdfBlocks[3].w)), 0, 16);
    for (int i = 0; i < 16; i++) {
      if (i >= count) break;
      int base = i * 4;
      vec4 b0 = u_sdfBlocks[base], b1 = u_sdfBlocks[base + 1], b2 = u_sdfBlocks[base + 2], b3 = u_sdfBlocks[base + 3];
      float k = max(0.001, b3.x);
      bool isSub = (int(round(b3.y)) & 2) != 0;
      int groupId = int(round(b3.z));
      float dp = evalLiveBlockPrim(p, b0, b1, b3);
      if (groupId == 0) {
        if (!isSub && abs(dp) < bestDuckD) { bestDuckD = abs(dp); duckCol = b2.xyz; duckRough = b2.w; }
        dDuck = isSub ? opSmoothSubLive(dDuck, dp, k) : (dDuck > 5.0 ? dp : opSmoothUnionLive(dDuck, dp, k));
      } else if (groupId == 1) {
        beakK = k; beakCol = b2.xyz; beakRough = b2.w;
        dBeak = isSub ? opSmoothSubLive(dBeak, dp, k) : (dBeak > 5.0 ? dp : opSmoothUnionLive(dBeak, dp, k));
      } else if (groupId == 2) {
        eyeCol = b2.xyz; eyeRough = b2.w;
        dEye = isSub ? opSmoothSubLive(dEye, dp, k) : (dEye > 5.0 ? dp : min(dEye, dp));
      } else if (groupId == 3) {
        waterCol = b2.xyz; waterRough = b2.w;
        dWater = isSub ? opSmoothSubLive(dWater, dp, k) : (dWater > 5.0 ? dp : opSmoothUnionLive(dWater, dp, k));
      } else {
        if (!isSub && abs(dp) < bestTubD) { bestTubD = abs(dp); tubCol = b2.xyz; tubRough = b2.w; }
        dTub = isSub ? opSmoothSubLive(dTub, dp, k) : (dTub > 5.0 ? dp : opSmoothUnionLive(dTub, dp, k));
      }
    }
    float duckFull = min(opSmoothUnionLive(dDuck, dBeak, beakK), dEye);
    vec3 matColor = duckCol; float matRough = duckRough; float matSub = 0.38;
    if (dWater <= duckFull + 0.003 && dWater <= dTub + 0.003) {
      matColor = waterCol; matRough = waterRough; matSub = 0.88;
    } else if (dTub < duckFull) {
      matColor = tubCol; matRough = tubRough; matSub = 0.38;
    } else {
      float beakW = smoothstep(0.005, -0.005, dBeak - dDuck);
      matColor = mix(duckCol, beakCol, beakW); matRough = mix(duckRough, beakRough, beakW);
      float eyeW = smoothstep(0.004, -0.004, dEye - min(dDuck, dBeak));
      matColor = mix(matColor, eyeCol, eyeW); matRough = mix(matRough, eyeRough, eyeW);
    }
    vec3 v = -rd;
    vec3 baseCol = pow(clamp(matColor, vec3(0.0), vec3(1.0)), vec3(2.2));
    float roughness = clamp(matRough, 0.04, 1.0);
    float alpha = max(0.04, roughness * roughness);
    float ao = calcLiveAO(p, nL);
    float shadow = calcLiveSoftShadow(p + nL * 0.006, keyLight, 0.02, 3.8, 9.0);
    float ndv = max(dot(nL, v), 0.001);
    float ndl = max(dot(nL, keyLight), 0.0);
    float fillNdl = max(dot(nL, fillLight), 0.0);
    float bounce = clamp(0.5 - 0.5 * nL.y, 0.0, 1.0);
    vec3 f0 = vec3(0.045);
    vec3 hVec = normalize(keyLight + v);
    float ndh = max(dot(nL, hVec), 0.0);
    float vdh = max(dot(v, hVec), 0.0);
    float a2 = alpha * alpha;
    float denom = ndh * ndh * (a2 - 1.0) + 1.0;
    float D = a2 / max(3.14159265 * denom * denom, 0.0001);
    float V = 0.5 / max(ndl * sqrt(ndv * ndv * (1.0 - a2) + a2) + ndv * sqrt(ndl * ndl * (1.0 - a2) + a2), 0.0001);
    vec3 F = f0 + (vec3(1.0) - f0) * pow(clamp(1.0 - vdh, 0.0, 1.0), 5.0);
    vec3 directSpec = (D * V * F) * ndl * (0.18 + 0.82 * shadow) * vec3(1.15, 1.10, 1.02);
    vec3 envF = f0 + (max(vec3(1.0 - roughness), f0) - f0) * pow(clamp(1.0 - ndv, 0.0, 1.0), 5.0);
    float isCornea = smoothstep(0.08, 0.03, roughness) * (1.0 - step(0.45, matSub));
    vec3 eyeCoat = vec3(isCornea * 0.68);
    vec3 reflDir = reflect(-v, nL);
    float softness = mix(0.025, 0.48, roughness);
    float box1 = smoothstep(0.88 - softness, 0.96 + softness * 0.2, dot(reflDir, normalize(vec3(0.48, 0.74, 0.46))));
    float box2 = smoothstep(0.91 - softness, 0.97 + softness * 0.2, dot(reflDir, normalize(vec3(-0.68, 0.42, 0.58)))) * 0.55;
    vec3 skyGrad = mix(vec3(0.95, 0.76, 0.18), vec3(1.0, 0.98, 0.92), clamp(reflDir.y * 0.5 + 0.5, 0.0, 1.0));
    vec3 refl = (skyGrad * 0.20 * envF + vec3(1.0, 0.99, 0.95) * (box1 * 1.50 + box2 * 0.70) * (1.0 - roughness * 0.75) * max(envF, eyeCoat)) * mix(0.85, 1.35, 1.0 - roughness);
    vec3 kD = vec3(1.0) - max(envF, eyeCoat * 0.25);
    vec3 bgLinear = vec3(1.0, 0.665, 0.040);
    vec3 color = (baseCol * kD) * (vec3(0.32, 0.31, 0.28) * ao + vec3(1.06, 1.01, 0.95) * ndl * (0.20 + 0.80 * shadow) + vec3(0.30, 0.42, 0.52) * fillNdl * ao + bgLinear * 0.30 * bounce * ao);
    if (matSub > 0.52 && roughness < 0.20) {
      vec3 refrDir = normalize(refract(rd, nL, 1.0 / 1.34));
      float opticalDepth = 0.04, marchT = 0.03;
      for (int k = 0; k < 6; k++) {
        float dIn = evalLiveSDF(p + refrDir * marchT);
        if (dIn > 0.0) break;
        float stepL = clamp(-dIn, 0.025, 0.09);
        opticalDepth += stepL; marchT += stepL;
      }
      vec3 bgBehindLin = pow(clamp(evalLiveBackdrop(p + refrDir * marchT, refrDir, keyLight), vec3(0.0), vec3(1.0)), vec3(2.2));
      vec3 transmittance = exp(-((vec3(1.02) - baseCol) * 4.2 + vec3(0.25)) * opticalDepth);
      vec3 refractedCol = bgBehindLin * transmittance * mix(vec3(1.0), baseCol * 1.25, 0.55);
      float jellyWeight = clamp((matSub - 0.45) * 1.4, 0.0, 0.72) * (1.0 - dot(envF, vec3(0.333)));
      color = mix(color, refractedCol, jellyWeight);
    }
    float backLight = clamp(dot(v, normalize(-keyLight + nL * 0.42)), 0.0, 1.0);
    color += pow(backLight, 2.0) * matSub * baseCol * 0.45 + directSpec + refl;
    color = mix(color, vec3(0.015, 0.013, 0.008), smoothstep(0.12, 0.02, ndv) * 0.14);
    outColor = vec4(pbrToneMapGL(color), 1.0);
    return;
  }

  // MatId 6: Per-pixel contact AO + directional soft cast shadow disc
  if (matId == 6) {
    vec2 localXZ = v_normalAndRough.xz;
    float r = length(localXZ);
    float contactDist = clamp((r - 0.83) / 0.22, 0.0, 1.0);
    float contactAO = smoothstep(1.0, 0.0, contactDist) * 0.15;
    vec2 shadowCenter = vec2(-0.18, -0.095);
    float dCast = length((localXZ - shadowCenter) * vec2(0.92, 1.04));
    float castSh = (1.0 - smoothstep(0.76, 1.18, dCast)) * 0.16;
    float radialFade = 1.0 - smoothstep(1.12, 1.42, r);
    float shadowAlpha = clamp((contactAO + castSh) * radialFade, 0.0, 0.26);
    vec3 shadowInk = vec3(33.0 / 255.0, 31.0 / 255.0, 23.0 / 255.0);
    outColor = vec4(mix(v_colorAndMetal.xyz, shadowInk, shadowAlpha), 1.0);
    return;
  }

  // MatId 5: Unlit 3D Gizmo
  if (matId == 5) {
    outColor = vec4(v_colorAndMetal.xyz, 1.0);
    return;
  }

  vec3 n = normalize(v_normalAndRough.xyz);
  if (int(round(u_debugMode)) == 1) {
    outColor = vec4(n * 0.5 + 0.5, 1.0);
    return;
  }

  vec3 srgbColor = v_colorAndMetal.xyz;
  float roughness = clamp(v_normalAndRough.w, 0.05, 1.0);
  vec3 emissive = vec3(0.0);

  vec3 v = normalize(u_camPos - worldPos);
  vec3 keyLight = normalize(vec3(0.58, 0.76, 0.30));
  vec3 fillLight = normalize(vec3(-0.65, 0.35, -0.45));
  vec3 bgLinear = vec3(1.0, 0.665, 0.040);
  vec3 baseCol = pow(clamp(srgbColor, vec3(0.0), vec3(1.0)), vec3(2.2));
  float metallic = clamp(v_colorAndMetal.w, 0.0, 1.0);
  float alpha = max(0.04, roughness * roughness);

  float hasBakedAO = v_localAndScale.w < -0.5 ? 1.0 : 0.0;
  float ao = mix(1.0, clamp(v_localAndScale.x, 0.0, 1.0), hasBakedAO);
  float shadow = mix(1.0, clamp(v_localAndScale.y, 0.0, 1.0), hasBakedAO);
  float subsurface = mix(0.0, clamp(v_localAndScale.z, 0.0, 1.0), hasBakedAO);

  // Water refraction & volumetric depth absorption for matId == 11
  if (matId == 11) {
    vec3 refrDir = refract(-v, n, 1.0 / 1.333);
    float waterDepth = clamp((0.26 - abs(worldPos.y + 0.14)) / max(abs(refrDir.y), 0.18), 0.05, 0.72);
    vec3 transmittance = exp(-vec3(0.32, 0.06, 0.02) * waterDepth * 3.8);
    float caustic = pow(clamp(0.5 + 0.5 * sin(worldPos.x * 16.0 + worldPos.z * 16.0), 0.0, 1.0), 3.0) * 0.18;
    float foamRing = smoothstep(0.54, 0.65, length(worldPos.xz));
    vec3 poolInterior = mix(vec3(0.86, 0.94, 0.96), vec3(0.96, 0.98, 1.0), foamRing) + vec3(0.18, 0.28, 0.24) * caustic;
    baseCol = mix(baseCol, poolInterior * transmittance, 0.72);
  }

  float ndv = max(dot(n, v), 0.001);
  float ndl = max(dot(n, keyLight), 0.0);
  float fillNdl = max(dot(n, fillLight), 0.0);
  float bounce = clamp(0.5 - 0.5 * n.y, 0.0, 1.0);

  vec3 f0 = mix(vec3(0.045), baseCol, metallic);
  vec3 hVec = normalize(keyLight + v);
  float ndh = max(dot(n, hVec), 0.0);
  float vdh = max(dot(v, hVec), 0.0);

  float a2 = alpha * alpha;
  float denom = ndh * ndh * (a2 - 1.0) + 1.0;
  float D = a2 / max(3.14159265 * denom * denom, 0.0001);
  float ggxV = ndl * sqrt(ndv * ndv * (1.0 - a2) + a2);
  float ggxL = ndv * sqrt(ndl * ndl * (1.0 - a2) + a2);
  float V = 0.5 / max(ggxV + ggxL, 0.0001);
  vec3 F = f0 + (vec3(1.0) - f0) * pow(clamp(1.0 - vdh, 0.0, 1.0), 5.0);
  vec3 directSpec = (D * V * F) * ndl * shadow * vec3(1.15, 1.10, 1.02);

  vec3 maxGloss = max(vec3(1.0 - roughness), f0);
  vec3 envF = f0 + (maxGloss - f0) * pow(clamp(1.0 - ndv, 0.0, 1.0), 5.0);
  float isCornea = smoothstep(0.08, 0.03, roughness) * (1.0 - metallic);
  vec3 eyeCoat = vec3(isCornea * 0.68);
  vec3 reflDir = reflect(-v, n);
  float softness = mix(0.025, 0.48, roughness);
  float box1 = smoothstep(0.88 - softness, 0.96 + softness * 0.2, dot(reflDir, normalize(vec3(0.48, 0.74, 0.46))));
  float box2 = smoothstep(0.91 - softness, 0.97 + softness * 0.2, dot(reflDir, normalize(vec3(-0.68, 0.42, 0.58)))) * 0.55;
  vec3 skyGrad = mix(vec3(0.95, 0.76, 0.18), vec3(1.0, 0.98, 0.92), clamp(reflDir.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 refl = (skyGrad * 0.20 * envF + vec3(1.0, 0.99, 0.95) * (box1 * 1.50 + box2 * 0.70) * (1.0 - roughness * 0.75) * max(envF, eyeCoat)) * mix(0.42, 1.0, ao);

  float wrapNdl = clamp((dot(n, keyLight) + 0.40) / 1.40, 0.0, 1.0);
  vec3 sssGlow = baseCol * vec3(1.15, 0.78, 0.48) * subsurface * wrapNdl * (0.35 + 0.65 * shadow) * 0.42;

  vec3 kD = (vec3(1.0) - max(envF, eyeCoat * 0.25)) * (1.0 - metallic);
  vec3 color = (baseCol * kD) * (
    vec3(0.28, 0.27, 0.24) * ao +
    vec3(1.08, 1.02, 0.95) * ndl * shadow +
    vec3(0.26, 0.38, 0.48) * fillNdl * ao +
    bgLinear * 0.30 * bounce * ao
  ) + sssGlow + directSpec + refl + emissive;

  float edgeInk = smoothstep(0.12, 0.02, ndv);
  color = mix(color, color * 0.42, edgeInk * 0.30);

  // Khronos PBR Neutral tone mapping + gamma encode
  vec3 colorIn = max(color, vec3(0.0));
  float startCompression = 0.76;
  float desaturation = 0.15;
  float xMin = min(colorIn.r, min(colorIn.g, colorIn.b));
  float offset = xMin < 0.08 ? xMin - 6.25 * xMin * xMin : 0.04;
  vec3 mapped = colorIn - vec3(offset);
  float peak = max(mapped.r, max(mapped.g, mapped.b));
  if (peak >= startCompression) {
    float d = 1.0 - startCompression;
    float newPeak = 1.0 - d * d / (peak + d - startCompression);
    mapped *= newPeak / max(peak, 0.0001);
    float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    mapped = mix(mapped, vec3(newPeak), g);
  }
  vec3 srgbOut = pow(clamp(mapped, vec3(0.0), vec3(1.0)), vec3(1.0 / 2.2));
  outColor = vec4(clamp(srgbOut, 0.0, 1.0), 1.0);
}
`;

export class WebGL2FallbackRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.program = null;
    this.vao = null;
    this.vbo = null;
    this.ibo = null;
    this.uniforms = {};
    this._vboCapacity = 0;
    this._uploadedIData = null;
    this._uploadedIndexCount = 0;
    this._uploadedStreamVersion = null;
  }

  init() {
    const gl = this.canvas.getContext("webgl2", {
      antialias: true,
      depth: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    if (!gl) return false;
    this.gl = gl;

    const vs = this._compileShader(gl.VERTEX_SHADER, VS_GLSL_300);
    const fs = this._compileShader(gl.FRAGMENT_SHADER, FS_GLSL_300);
    if (!vs || !fs) return false;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("[WebGL2 link error]", gl.getProgramInfoLog(prog));
      return false;
    }
    this.program = prog;

    this.uniforms = {
      viewProj: gl.getUniformLocation(prog, "u_viewProj"),
      camPos: gl.getUniformLocation(prog, "u_camPos"),
      sunDir: gl.getUniformLocation(prog, "u_sunDir"),
      skyZenith: gl.getUniformLocation(prog, "u_skyZenith"),
      skyHorizon: gl.getUniformLocation(prog, "u_skyHorizon"),
      debugMode: gl.getUniformLocation(prog, "u_debugMode"),
      sdfBlocks: gl.getUniformLocation(prog, "u_sdfBlocks"),
    };

    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.ibo = gl.createBuffer();

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = 16 * 4;
    for (let loc = 0; loc < 4; loc++) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, loc * 16);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bindVertexArray(null);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    return true;
  }

  _compileShader(type, source) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error("[WebGL2 shader error]", gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  render(vData, iData, indexCount, cameraOpts = {}) {
    const gl = this.gl;
    if (!gl || !this.program || indexCount <= 0) return;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const bg = cameraOpts.clearColor || [1.0, 212 / 255, 59 / 255];
    gl.clearColor(bg[0], bg[1], bg[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = Math.max(0.2, this.canvas.width / Math.max(1, this.canvas.height));
    const fovRad = ((cameraOpts.fov ?? 38) * Math.PI) / 180.0;
    const eye = cameraOpts.eye || cameraOpts.camPos || [0, 1.2, 2.8];
    const proj = mat4Perspective(fovRad, aspect, 0.05, 40.0);
    const view = mat4LookAt(eye, cameraOpts.target || [0, 0.1, 0], [0, 1, 0]);
    const viewProj = mat4Multiply(proj, view);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.viewProj, false, viewProj);
    const sun = cameraOpts.sunDir || [0.58, 0.78, 0.42];
    const zen = cameraOpts.skyZenith || [0.24, 0.56, 0.88];
    const hor = cameraOpts.skyHorizon || [0.76, 0.88, 0.96];
    gl.uniform3f(this.uniforms.camPos, eye[0], eye[1], eye[2]);
    gl.uniform3f(this.uniforms.sunDir, sun[0], sun[1], sun[2]);
    gl.uniform3f(this.uniforms.skyZenith, zen[0], zen[1], zen[2]);
    gl.uniform3f(this.uniforms.skyHorizon, hor[0], hor[1], hor[2]);
    gl.uniform1f(this.uniforms.debugMode, cameraOpts.debugMode ?? 0);
    if (cameraOpts.blocksUniformData && this.uniforms.sdfBlocks) {
      gl.uniform4fv(this.uniforms.sdfBlocks, cameraOpts.blocksUniformData);
    }

    gl.bindVertexArray(this.vao);
    const streamVer = cameraOpts.streamVersion;
    const isSameStream =
      streamVer !== undefined &&
      streamVer !== null &&
      this._uploadedStreamVersion === streamVer &&
      this._uploadedIndexCount === indexCount;

    if (!isSameStream) {
      if (this._vboCapacity !== vData.byteLength) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, vData, gl.DYNAMIC_DRAW);
        this._vboCapacity = vData.byteLength;
      } else if (cameraOpts.dirtyVertices !== false) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vData);
      }
      if (this._uploadedIData !== iData || this._uploadedIndexCount !== indexCount || streamVer !== undefined) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, iData.subarray(0, indexCount), gl.DYNAMIC_DRAW);
        this._uploadedIData = iData;
        this._uploadedIndexCount = indexCount;
      }
      this._uploadedStreamVersion = streamVer ?? null;
    }

    const gizmoIndexCount = cameraOpts.gizmoIndexCount || 0;
    const mainIndexCount = indexCount - gizmoIndexCount;
    if (mainIndexCount > 0) {
      gl.drawElements(gl.TRIANGLES, mainIndexCount, gl.UNSIGNED_INT, 0);
    }
    if (gizmoIndexCount > 0) {
      gl.disable(gl.DEPTH_TEST);
      gl.drawElements(gl.TRIANGLES, gizmoIndexCount, gl.UNSIGNED_INT, mainIndexCount * 4);
      gl.enable(gl.DEPTH_TEST);
    }
    gl.bindVertexArray(null);
  }
}
