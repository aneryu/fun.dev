import { STDLIB_WGSL, STDLIB_FUNCTION_NAMES } from "./stdlib.js";

const FORBIDDEN_PATTERNS = [
  { regex: /@\w+/, message: "Do not declare WGSL attributes (@compute, @group, @binding); the host generates entrypoints and bindings." },
  { regex: /\bvar\s*</, message: "Do not declare module-scope address-space variables (var<storage>, var<uniform>, var<workgroup>); use state(i) and simulate(i)." },
  { regex: /\bptr\s*</, message: "Pointers (ptr<...>) are not allowed in scene WGSL." },
  { regex: /\bloop\s*\{/, message: "Unbounded 'loop {}' is not allowed; use bounded 'for (var k = 0u; k < N; k++) { ... }'." },
  { regex: /\bwhile\s*\(/, message: "'while' loops are not allowed; use bounded 'for' loops." },
  { regex: /\b(?:override|enable|diagnostic|discard|dpdx|dpdy|fwidth)\b/, message: "Unsupported WGSL directive or derivative function in scene code." },
  { regex: /\b(?:_u|_stateIn|_stateOut|_pick|_lg|vsMain|fsMain|csPickMain|csSimMain)\b/, message: "Identifier uses a reserved host prefix." },
];

// Replaces comments with spaces while preserving every newline and character column.
export function stripCommentsPreservingLayout(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function findMatchingParen(str, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === "(") depth++;
    else if (str[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findOpeningBrace(str, fromIndex) {
  let i = fromIndex;
  while (i < str.length && /\s/.test(str[i])) i++;
  return str[i] === "{" ? i : -1;
}

function findMatchingBrace(str, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === "{") depth++;
    else if (str[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitForHeader(headerContent) {
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < headerContent.length; i++) {
    const ch = headerContent[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth === 0) {
      parts.push(headerContent.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(headerContent.slice(last));
  return parts;
}

// Recursively injects a 256-iteration trip-count guard into every 'for (...; cond; ...)'
// including nested loops and update expressions with nested parentheses, preserving line count 1:1.
export function injectLoopGuards(code, counter = { id: 0 }) {
  const stripped = stripCommentsPreservingLayout(code);
  const forRegex = /\bfor\s*\(/g;
  let result = "";
  let lastIndex = 0;
  let match;

  while ((match = forRegex.exec(stripped)) !== null) {
    const forStart = match.index;
    const openParen = stripped.indexOf("(", forStart);
    const closeParen = findMatchingParen(stripped, openParen);
    if (openParen === -1 || closeParen === -1) continue;

    const bodyOpen = findOpeningBrace(stripped, closeParen + 1);
    const bodyClose = bodyOpen !== -1 ? findMatchingBrace(stripped, bodyOpen) : -1;
    const rawHeader = code.slice(openParen + 1, closeParen);
    const strippedHeader = stripped.slice(openParen + 1, closeParen);
    const semiPositions = [];
    let pDepth = 0;
    for (let i = 0; i < strippedHeader.length; i++) {
      if (strippedHeader[i] === "(") pDepth++;
      else if (strippedHeader[i] === ")") pDepth--;
      else if (strippedHeader[i] === ";" && pDepth === 0) semiPositions.push(i);
    }

    if (bodyOpen !== -1 && bodyClose !== -1 && semiPositions.length === 2) {
      const initRaw = rawHeader.slice(0, semiPositions[0]);
      const condRaw = rawHeader.slice(semiPositions[0] + 1, semiPositions[1]).trim() || "true";
      const updateRaw = rawHeader.slice(semiPositions[1] + 1);
      const id = `_lg${counter.id++}`;

      const innerBodyRaw = code.slice(bodyOpen + 1, bodyClose);
      const guardedInnerBody = injectLoopGuards(innerBodyRaw, counter);

      result += code.slice(lastIndex, forStart);
      result += `{ var ${id}: u32 = 0u; for (${initRaw}; (${id} < 256u) && (${condRaw});${updateRaw})`;
      result += code.slice(closeParen + 1, bodyOpen + 1) + ` ${id}++;`;
      result += guardedInnerBody + "} }";

      lastIndex = bodyClose + 1;
      forRegex.lastIndex = lastIndex;
    }
  }

  result += code.slice(lastIndex);
  return result;
}

export function validateSceneSpec(scene) {
  const errors = [];
  if (!scene || typeof scene !== "object") {
    return { ok: false, hasSimulate: false, errors: [{ line: 1, column: 1, message: "Scene definition must be an object." }] };
  }
  const code = typeof scene.wgsl === "string" ? scene.wgsl.trim() : "";
  if (!code) {
    return { ok: false, hasSimulate: false, errors: [{ line: 1, column: 1, message: "Scene wgsl code is empty." }] };
  }

  const stripped = stripCommentsPreservingLayout(code);
  for (const rule of FORBIDDEN_PATTERNS) {
    const match = rule.regex.exec(stripped);
    if (match) {
      errors.push({
        line: lineNumberAt(stripped, match.index),
        column: 1,
        message: rule.message,
      });
    }
  }

  // Check for 'fn step(' shadowing built-in WGSL step(edge, x)
  const stepFnMatch = /\bfn\s+step\s*\(/.exec(stripped);
  if (stepFnMatch) {
    errors.push({
      line: lineNumberAt(stripped, stepFnMatch.index),
      column: 1,
      message: "Rename 'fn step(i: u32)' to 'fn simulate(i: u32) -> vec4f' so it does not shadow WGSL's built-in step(edge, x).",
    });
  }

  // Check for redeclared stdlib functions
  for (const fnMatch of stripped.matchAll(/\bfn\s+([a-zA-Z_]\w*)\s*\(/g)) {
    const fnName = fnMatch[1];
    if (STDLIB_FUNCTION_NAMES.has(fnName)) {
      errors.push({
        line: lineNumberAt(stripped, fnMatch.index),
        column: 1,
        message: `Function '${fnName}' is already provided by the built-in SDF standard library; do not redeclare it.`,
      });
    }
  }

  // Check that every 'for (...)' has a braced '{ ... }' body
  for (const forMatch of stripped.matchAll(/\bfor\s*\(/g)) {
    const openParen = stripped.indexOf("(", forMatch.index);
    const closeParen = findMatchingParen(stripped, openParen);
    if (closeParen === -1) {
      errors.push({
        line: lineNumberAt(stripped, forMatch.index),
        column: 1,
        message: "Unclosed '(' in for-loop header.",
      });
      continue;
    }
    const headerParts = splitForHeader(stripped.slice(openParen + 1, closeParen));
    if (headerParts.length !== 3) {
      errors.push({
        line: lineNumberAt(stripped, forMatch.index),
        column: 1,
        message: "for-loop header must have 3 clauses: for (init; condition; update) { ... }.",
      });
    }
    const bodyOpen = findOpeningBrace(stripped, closeParen + 1);
    if (bodyOpen === -1) {
      errors.push({
        line: lineNumberAt(stripped, forMatch.index),
        column: 1,
        message: "for-loop body must be enclosed in braces '{ ... }'.",
      });
    }
  }

  const hasSdf = /\bfn\s+sdf\s*\(/.test(stripped);
  const hasMaterial = /\bfn\s+material\s*\(/.test(stripped);
  const hasSimulate = /\bfn\s+simulate\s*\(/.test(stripped);

  if (!hasSdf) {
    errors.push({ line: 1, column: 1, message: "Missing required function: fn sdf(p: vec3f) -> f32" });
  }
  if (!hasMaterial) {
    errors.push({ line: 1, column: 1, message: "Missing required function: fn material(p: vec3f, n: vec3f) -> Material" });
  }

  if (scene.params && typeof scene.params === "object") {
    const rawKeys = Object.keys(scene.params);
    if (rawKeys.length > 16) {
      errors.push({
        line: 1,
        column: 1,
        message: `Scene defines ${rawKeys.length} parameters, exceeding the maximum of 16 uniform parameters.`,
      });
    }
    const seenSafe = new Set();
    for (const k of rawKeys) {
      const safe = k.replace(/[^a-zA-Z0-9_]/g, "_");
      if (!safe || /^[0-9]/.test(safe)) {
        errors.push({ line: 1, column: 1, message: `Invalid parameter name '${k}'.` });
      } else if (seenSafe.has(safe)) {
        errors.push({
          line: 1,
          column: 1,
          message: `Duplicate sanitized parameter accessor 'p_${safe}()' from parameter '${k}'.`,
        });
      }
      seenSafe.add(safe);
    }
  }

  return {
    ok: errors.length === 0,
    hasSimulate,
    errors,
  };
}

export function buildParameterAccessors(paramsSpec = {}) {
  const keys = Object.keys(paramsSpec).slice(0, 16);
  const lines = keys.map((key, idx) => {
    const safeName = key.replace(/[^a-zA-Z0-9_]/g, "_");
    const vecIdx = Math.floor(idx / 4);
    const comp = ["x", "y", "z", "w"][idx % 4];
    return `fn p_${safeName}() -> f32 { return _u.params[${vecIdx}u].${comp}; }`;
  });
  return { keys, wgsl: lines.join("\n") };
}

export function buildSceneShaders(scene) {
  const validation = validateSceneSpec(scene);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  const userCode = scene.wgsl.trim();
  const userLineCount = userCode.split("\n").length;
  const guardedUserCode = injectLoopGuards(userCode);
  const stateCount = Math.max(1, Math.min(1024, Number.isInteger(scene.stateCount) ? scene.stateCount : 16));
  const groundY = Number.isFinite(scene.ground?.y) ? Number(scene.ground.y) : -0.55;
  const groundRadius = Number.isFinite(scene.ground?.radius) ? Number(scene.ground.radius) : 1.85;
  const bCenter =
    Array.isArray(scene.bounds?.center) && scene.bounds.center.length === 3
      ? scene.bounds.center.map(Number)
      : [0, 0, 0];
  const bRadius = Number.isFinite(scene.bounds?.radius) ? Number(scene.bounds.radius) * 1.48 : 1.65;
  const { keys: paramKeys, wgsl: paramAccessors } = buildParameterAccessors(scene.params || {});

  const defaultSimulateFn = validation.hasSimulate
    ? ""
    : "fn simulate(i: u32) -> vec4f { return state(i); }";

  const hostBindingsWGSL = /* wgsl */ `
struct HostUniforms {
  camPos: vec4f,          // xyz = camera pos, w = time (seconds)
  camTarget: vec4f,       // xyz = target, w = dt (seconds)
  camRight: vec4f,        // xyz = right, w = aspect
  camUp: vec4f,           // xyz = up, w = tanHalfFov
  camForward: vec4f,      // xyz = forward, w = pixelAngle
  pointerRayOrigin: vec4f,// xyz = origin, w = pointerDown (0 or 1)
  pointerRayDir: vec4f,   // xyz = dir, w = flags (bit0 = pressed, bit1 = released, bit2 = spacePoke)
  simMeta: vec4f,         // x = stepScale, y = substepOrDebugMode, z = tickCount, w = stateCount
  params: array<vec4f, 4>,
};

struct PickState {
  hitPos: vec4f,          // xyz = grabbed 3D point on SDF, w = grab active (1 = surface grab, 0 = idle)
  targetPos: vec4f,       // xyz = current 3D dragged target point, w = grab distance along ray
  impulse: vec4f,         // xyz = smoothed drag / poke offset vector, w = hover hit (1 = cursor over SDF)
};

@group(0) @binding(0) var<uniform> _u: HostUniforms;
@group(0) @binding(1) var<storage, read> _stateIn: array<vec4f>;

const STATE_LIMIT: u32 = ${stateCount - 1}u;
const GROUND_Y: f32 = ${groundY.toFixed(4)};
const GROUND_RADIUS: f32 = ${groundRadius.toFixed(4)};
const BOUNDS_CENTER: vec3f = vec3f(${bCenter[0].toFixed(4)}, ${bCenter[1].toFixed(4)}, ${bCenter[2].toFixed(4)});
const BOUNDS_RADIUS: f32 = ${bRadius.toFixed(4)};

fn time() -> f32 { return _u.camPos.w; }
fn dt() -> f32 { return _u.camTarget.w; }
fn substepIndex() -> u32 { return u32(_u.simMeta.y); }
fn tickCount() -> u32 { return u32(_u.simMeta.z); }
fn pointerDown() -> f32 { return _u.pointerRayOrigin.w; }
fn pointerRayOrigin() -> vec3f { return _u.pointerRayOrigin.xyz; }
fn pointerRayDir() -> vec3f { return normalize(_u.pointerRayDir.xyz); }

fn state(i: u32) -> vec4f {
  return _stateIn[min(i, STATE_LIMIT)];
}

fn param(i: u32) -> f32 {
  let idx = min(i, 15u);
  return _u.params[idx / 4u][idx % 4u];
}

${paramAccessors}
${defaultSimulateFn}
`;

  // Compute Shader Module (contains both csPickMain and csSimMain)
  const computeWGSL = `${guardedUserCode}
${STDLIB_WGSL}
${hostBindingsWGSL}
@group(0) @binding(2) var<storage, read_write> _stateOut: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> _pick: PickState;

fn pickPos() -> vec3f { return _pick.hitPos.xyz; }
fn pickTarget() -> vec3f { return _pick.targetPos.xyz; }
fn pickDir() -> vec3f { return _pick.impulse.xyz; }
fn pickActive() -> f32 { return _pick.hitPos.w; }
fn pickJustPressed() -> bool { return (u32(_u.pointerRayDir.w) & 1u) != 0u; }
fn pickJustReleased() -> bool { return (u32(_u.pointerRayDir.w) & 2u) != 0u; }
fn spacePokeActive() -> bool { return (u32(_u.pointerRayDir.w) & 4u) != 0u; }

@compute @workgroup_size(1)
fn csPickMain() {
  let ro = _u.pointerRayOrigin.xyz;
  let rd = normalize(_u.pointerRayDir.xyz);
  let isDown = _u.pointerRayOrigin.w > 0.5;
  let flags = u32(_u.pointerRayDir.w);
  let justPressed = (flags & 1u) != 0u;
  let spacePoke = (flags & 4u) != 0u;
  let stepScale = clamp(_u.simMeta.x, 0.25, 1.0);
  let pixelAngle = max(0.0005, _u.camForward.w);
  let frameDt = clamp(_u.camTarget.w, 0.001, 0.05);
  let followAlpha = 1.0 - exp(-frameDt * 28.0);
  let releaseDecay = exp(-frameDt * 12.0);

  // Raymarch cursor ray against sdf(p) using cone threshold matching fsMain
  var t = 0.1;
  var hit = false;
  for (var k: u32 = 0u; k < 96u; k++) {
    let p = ro + rd * t;
    let d = sdf(p);
    let coneRadius = max(0.0015, t * pixelAngle);
    if (d < coneRadius * 0.65) {
      hit = true;
      break;
    }
    t += d * stepScale;
    if (t > 10.0) {
      break;
    }
  }

  let hitPoint = ro + rd * t;
  let camFwd = normalize(_u.camForward.xyz);

  // Also compute fallback view-plane intersection through scene target for empty-space attraction
  let denom = dot(rd, camFwd);
  var emptyPlanePos = vec3f(0.0);
  if (abs(denom) > 0.001) {
    let pt = dot(_u.camTarget.xyz - ro, camFwd) / denom;
    emptyPlanePos = ro + rd * clamp(pt, 0.2, 10.0);
  }

  if (spacePoke) {
    _pick.hitPos = vec4f(0.0, 0.18, 0.24, 1.0);
    _pick.targetPos = vec4f(0.0, -0.08, 0.04, 2.0);
    _pick.impulse = vec4f(0.0, -0.28, -0.18, 1.0);
    return;
  }

  if (justPressed) {
    if (hit) {
      // Initial press applies an inward normal poke impulse so tapping dents the surface
      let nHit = sdfNormal(hitPoint);
      let pokeVec = -nHit * 0.15;
      _pick.hitPos = vec4f(hitPoint, 1.0);
      _pick.targetPos = vec4f(hitPoint + pokeVec, t);
      _pick.impulse = vec4f(pokeVec, 1.0);
    } else {
      _pick.hitPos = vec4f(emptyPlanePos, 0.0);
      _pick.targetPos = vec4f(emptyPlanePos, length(emptyPlanePos - ro));
      _pick.impulse = vec4f(0.0, 0.0, 0.0, 0.0);
    }
  } else if (isDown && _pick.hitPos.w > 0.5) {
    // Intersect current pointer ray with view-parallel plane passing through initial hitPoint
    let grabOrigin = _pick.hitPos.xyz;
    var dragPos = grabOrigin;
    if (abs(denom) > 0.001) {
      let planeT = dot(grabOrigin - ro, camFwd) / denom;
      dragPos = ro + rd * clamp(planeT, 0.2, 10.0);
    }
    let rawOffset = dragPos - grabOrigin;
    let maxPull = 1.05;
    let clampedOffset = rawOffset / max(1.0, length(rawOffset) / maxPull);
    _pick.targetPos = vec4f(grabOrigin + clampedOffset, _pick.targetPos.w);
    _pick.impulse = vec4f(mix(_pick.impulse.xyz, clampedOffset, followAlpha), 1.0);
  } else {
    // Whenever pointer is not holding the surface, release surface grab state
    _pick.hitPos.w = 0.0;
    _pick.impulse = vec4f(_pick.impulse.xyz * releaseDecay, select(0.0, 1.0, hit));
    if (isDown) {
      _pick.targetPos = vec4f(emptyPlanePos, _pick.targetPos.w);
    } else if (hit) {
      // Track hover surface position so eyes/characters can subtly glance at the cursor
      _pick.targetPos = vec4f(mix(_pick.targetPos.xyz, hitPoint, followAlpha * 0.6), t);
    } else {
      _pick.targetPos = vec4f(mix(_pick.targetPos.xyz, emptyPlanePos, followAlpha * 0.35), _pick.targetPos.w);
    }
  }
}

@compute @workgroup_size(64)
fn csSimMain(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(_u.simMeta.w)) {
    return;
  }
  _stateOut[i] = simulate(i);
}
`;

  // Render Shader Module (vsMain + fsMain)
  const renderWGSL = `${guardedUserCode}
${STDLIB_WGSL}
${hostBindingsWGSL}
@group(0) @binding(2) var<storage, read> _pick: PickState;

fn pickPos() -> vec3f { return _pick.hitPos.xyz; }
fn pickTarget() -> vec3f { return _pick.targetPos.xyz; }
fn pickDir() -> vec3f { return _pick.impulse.xyz; }
fn pickActive() -> f32 { return _pick.hitPos.w; }
fn pickJustPressed() -> bool { return (u32(_u.pointerRayDir.w) & 1u) != 0u; }
fn pickJustReleased() -> bool { return (u32(_u.pointerRayDir.w) & 2u) != 0u; }
fn spacePokeActive() -> bool { return (u32(_u.pointerRayDir.w) & 4u) != 0u; }

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) vid: u32) -> VSOut {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  let p = positions[vid];
  var out: VSOut;
  out.pos = vec4f(p, 0.0, 1.0);
  out.uv = p;
  return out;
}

fn calcSoftShadow(ro: vec3f, rd: vec3f, mint: f32, maxt: f32, k: f32) -> f32 {
  var res = 1.0;
  var t = mint;
  var ph = 1e10;
  var prevStep = mint;
  for (var i: u32 = 0u; i < 32u; i++) {
    let h = sdf(ro + rd * t);
    if (h < 0.0008) {
      return 0.0;
    }
    if (i > 0u && h < ph + prevStep) {
      let y = clamp((h * h - ph * ph + prevStep * prevStep) / (2.0 * prevStep), 0.0, prevStep);
      let d = sqrt(max(0.0, h * h - (prevStep - y) * (prevStep - y)));
      res = min(res, k * d / max(0.001, t - prevStep + y));
    } else {
      res = min(res, k * h / t);
    }
    if (res < 0.002) {
      return 0.0;
    }
    ph = h;
    let stepLen = clamp(h * 0.45, 0.008, 0.065);
    prevStep = stepLen;
    t += stepLen;
    if (t > maxt) {
      break;
    }
  }
  let s = clamp(res, 0.0, 1.0);
  return s * s * (3.0 - 2.0 * s);
}

// Includes smooth ground horizon factor so vertical porcelain walls stay clean near the floor
fn calcAO(pos: vec3f, nor: vec3f) -> f32 {
  var occ = 0.0;
  var sca = 1.0;
  for (var i: u32 = 0u; i < 4u; i++) {
    let h = 0.02 + 0.11 * f32(i) / 3.0;
    let samplePos = pos + h * nor;
    let d = sdf(samplePos);
    occ += clamp(h - d, 0.0, h) * sca;
    sca *= 0.70;
  }
  let selfAO = clamp(1.0 - 2.35 * occ, 0.0, 1.0);
  let groundHorizon = mix(0.90, 1.0, smoothstep(0.0, 0.14, pos.y - GROUND_Y));
  return selfAO * groundHorizon;
}

// Khronos PBR Neutral tone mapper: preserves saturated brand yellows & oranges without hue shifts
fn pbrNeutralToneMapping(colorIn: vec3f) -> vec3f {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  let x = min(colorIn.r, min(colorIn.g, colorIn.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  var color = colorIn - vec3f(offset);
  let peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) {
    return clamp(color, vec3f(0.0), vec3f(1.0));
  }
  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / max(peak, 0.0001);
  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return clamp(mix(color, vec3f(newPeak), g), vec3f(0.0), vec3f(1.0));
}

// Procedural dual studio softbox reflection for glossy eyes, metals & tactile rubber
fn studioEnvReflection(reflDir: vec3f, roughness: f32, envF: vec3f, eyeCoat: vec3f) -> vec3f {
  let softness = mix(0.025, 0.48, roughness);
  let box1Dir = normalize(vec3f(0.48, 0.74, 0.46));
  let box2Dir = normalize(vec3f(-0.68, 0.42, 0.58));
  let box1 = smoothstep(0.88 - softness, 0.96 + softness * 0.2, dot(reflDir, box1Dir));
  let box2 = smoothstep(0.91 - softness, 0.97 + softness * 0.2, dot(reflDir, box2Dir)) * 0.55;
  let skyGrad = mix(vec3f(0.95, 0.76, 0.18), vec3f(1.0, 0.98, 0.92), clamp(reflDir.y * 0.5 + 0.5, 0.0, 1.0));
  let skyTerm = skyGrad * 0.20 * envF;
  let boxTerm = vec3f(1.0, 0.99, 0.95) * (box1 * 1.50 + box2 * 0.70) * (1.0 - roughness * 0.75) * max(envF, eyeCoat);
  return (skyTerm + boxTerm) * mix(0.85, 1.35, 1.0 - roughness);
}

fn evalBackdropAndGroundShadow(ro: vec3f, rd: vec3f, keyLight: vec3f) -> vec3f {
  let bgSrgb = vec3f(1.0, 212.0 / 255.0, 59.0 / 255.0);
  let inkSrgb = vec3f(33.0 / 255.0, 31.0 / 255.0, 23.0 / 255.0);

  var colSrgb = bgSrgb;
  if (rd.y < -0.001) {
    let tg = (GROUND_Y - ro.y) / rd.y;
    if (tg > 0.0 && tg < 8.0) {
      let gp = ro + rd * tg;
      let rDist = length(gp.xz);
      let radialFade = smoothstep(GROUND_RADIUS, 0.35, rDist);
      if (radialFade > 0.001) {
        let contactDist = clamp(sdf(gp + vec3f(0.0, 0.015, 0.0)) / 0.22, 0.0, 1.0);
        let contactAO = smoothstep(1.0, 0.0, contactDist) * 0.15;
        var castShadow = 0.0;
        let toCenter = BOUNDS_CENTER - gp;
        let proj = dot(toCenter, keyLight);
        let perpSq = dot(toCenter, toCenter) - proj * proj;
        let boundR = BOUNDS_RADIUS + 0.45;
        if (proj > -0.85 && perpSq < boundR * boundR) {
          let sh = calcSoftShadow(gp + vec3f(0.0, 0.012, 0.0), keyLight, 0.025, 2.2, 5.0);
          let boxFade = smoothstep(-0.85, -0.40, proj) * smoothstep(boundR * boundR, BOUNDS_RADIUS * BOUNDS_RADIUS, perpSq);
          castShadow = (1.0 - sh) * 0.18 * boxFade;
        }
        let shadowStrength = (castShadow + contactAO) * radialFade;
        colSrgb = mix(bgSrgb, inkSrgb, clamp(shadowStrength, 0.0, 0.28));
      }
    }
  }
  return colSrgb;
}

// Microfacet GGX + Schlick Fresnel helper functions
fn D_GGX(ndh: f32, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let denom = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / max(PI * denom * denom, 0.0001);
}

fn V_SmithGGXCorrelated(ndv: f32, ndl: f32, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let ggxV = ndl * sqrt(ndv * ndv * (1.0 - a2) + a2);
  let ggxL = ndv * sqrt(ndl * ndl * (1.0 - a2) + a2);
  return 0.5 / max(ggxV + ggxL, 0.0001);
}

fn F_Schlick(cosTheta: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn F_SchlickRoughness(cosTheta: f32, f0: vec3f, roughness: f32) -> vec3f {
  let maxGloss = max(vec3f(1.0 - roughness), f0);
  return f0 + (maxGloss - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn shadeSurfaceHit(p: vec3f, tHit: f32, rd: vec3f, keyLight: vec3f, fillLight: vec3f) -> vec3f {
  let bgLinear = vec3f(1.0, 0.665, 0.040);
  let inkLinear = vec3f(0.015, 0.013, 0.008);
  let normalEps = max(0.0009, tHit * _u.camForward.w * 0.55);
  let n = sdfNormalEps(p, normalEps);
  let v = -rd;
  let mat = material(p, n);

  let baseCol = pow(clamp(mat.color, vec3f(0.0), vec3f(1.0)), vec3f(2.2));
  let roughness = clamp(mat.roughness, 0.04, 1.0);
  let alpha = roughness * roughness;
  let metallic = clamp(mat.metallic, 0.0, 1.0);
  let ao = calcAO(p, n);
  let shadow = calcSoftShadow(p + n * 0.006, keyLight, 0.02, 3.8, 9.0);

  let ndv = max(dot(n, v), 0.001);
  let ndl = max(dot(n, keyLight), 0.0);
  let fillNdl = max(dot(n, fillLight), 0.0);
  let bounce = clamp(0.5 - 0.5 * n.y, 0.0, 1.0);

  // True GGX Microfacet Specular + Schlick Fresnel (F0 = 0.04 for dielectrics)
  let f0 = mix(vec3f(0.045), baseCol, metallic);
  let hVec = normalize(keyLight + v);
  let ndh = max(dot(n, hVec), 0.0);
  let vdh = max(dot(v, hVec), 0.0);

  let D = D_GGX(ndh, max(0.04, alpha));
  let V = V_SmithGGXCorrelated(ndv, max(ndl, 0.001), max(0.04, alpha));
  let F = F_Schlick(vdh, f0);
  let directSpec = (D * V * F) * ndl * (0.18 + 0.82 * shadow) * vec3f(1.15, 1.10, 1.02);

  // Fresnel-weighted studio softbox environment reflection (+ cornea clearcoat catchlight strictly for non-metallic, non-translucent eyes)
  let envF = F_SchlickRoughness(ndv, f0, roughness);
  let isCornea = smoothstep(0.08, 0.03, roughness) * (1.0 - metallic) * (1.0 - step(0.45, mat.subsurface));
  let eyeCoat = vec3f(isCornea * 0.68);
  let refl = studioEnvReflection(reflect(-v, n), roughness, envF, eyeCoat);

  // Energy-conserving diffuse
  let kD = (vec3f(1.0) - max(envF, eyeCoat * 0.25)) * (1.0 - metallic);
  let diffuseColor = baseCol * kD;

  // Subsurface scattering & volumetric refraction for translucent jelly/water materials
  let backVec = normalize(-keyLight + n * 0.42);
  let backLight = clamp(dot(v, backVec), 0.0, 1.0);
  let thicknessProbe = clamp(sdf(p - n * 0.12) / -0.12, 0.0, 1.0);
  let sss = pow(backLight, 2.0) * (1.0 - thicknessProbe * 0.45) * mat.subsurface * baseCol * 0.65;

  var color = diffuseColor * (
    vec3f(0.32, 0.31, 0.28) * ao +
    vec3f(1.06, 1.01, 0.95) * ndl * (0.20 + 0.80 * shadow) +
    vec3f(0.30, 0.42, 0.52) * fillNdl * ao +
    bgLinear * 0.30 * bounce * ao
  );

  // True volumetric refraction + Beer-Lambert absorption when matJelly is used (subsurface > 0.52 && roughness < 0.20)
  if (mat.subsurface > 0.52 && roughness < 0.20 && metallic < 0.1) {
    let ior = 1.34;
    let refrDir = normalize(refract(rd, n, 1.0 / ior));
    var opticalDepth = 0.04;
    var marchT = 0.03;
    for (var k: u32 = 0u; k < 6u; k++) {
      let dInside = sdf(p + refrDir * marchT);
      if (dInside > 0.0) {
        break;
      }
      let stepLen = clamp(-dInside, 0.025, 0.09);
      opticalDepth += stepLen;
      marchT += stepLen;
    }
    let exitPos = p + refrDir * marchT;
    let bgBehindSrgb = evalBackdropAndGroundShadow(exitPos, refrDir, keyLight);
    let bgBehindLin = pow(clamp(bgBehindSrgb, vec3f(0.0), vec3f(1.0)), vec3f(2.2));
    let sigma = (vec3f(1.02) - baseCol) * 4.2 + vec3f(0.25);
    let transmittance = exp(-sigma * opticalDepth);
    let refractedCol = bgBehindLin * transmittance * mix(vec3f(1.0), baseCol * 1.25, 0.55);
    let jellyWeight = clamp((mat.subsurface - 0.45) * 1.4, 0.0, 0.72) * (1.0 - dot(envF, vec3f(0.333)));
    color = mix(color, refractedCol, jellyWeight);
  }

  color += sss + directSpec + refl + mat.emission;

  // Subtle ink contour hint at grazing silhouette
  let edgeInk = smoothstep(0.12, 0.02, ndv);
  color = mix(color, inkLinear, edgeInk * 0.14);

  let mapped = pbrNeutralToneMapping(color);
  return pow(mapped, vec3f(1.0 / 2.2));
}

fn heatmapColor(x: f32) -> vec3f {
  let t = clamp(x, 0.0, 1.0);
  return clamp(vec3f(
    smoothstep(0.25, 0.75, t),
    sin(t * PI),
    1.0 - smoothstep(0.0, 0.65, t)
  ), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4f {
  let aspect = _u.camRight.w;
  let tanHalfFov = _u.camUp.w;
  let pixelAngle = _u.camForward.w;
  let ro = _u.camPos.xyz;
  let rd = normalize(
    _u.camForward.xyz +
    in.uv.x * aspect * tanHalfFov * _u.camRight.xyz +
    in.uv.y * tanHalfFov * _u.camUp.xyz
  );

  let stepScale = clamp(_u.simMeta.x, 0.25, 1.0);
  let debugMode = u32(_u.simMeta.y);
  let keyLight = normalize(vec3f(0.58, 0.76, 0.30));
  let fillLight = normalize(vec3f(-0.65, 0.35, -0.45));

  let oc = ro - BOUNDS_CENTER;
  let bDot = dot(oc, rd);
  let cDot = dot(oc, oc) - BOUNDS_RADIUS * BOUNDS_RADIUS;
  let disc = bDot * bDot - cDot;

  var t = 0.1;
  var tMax = 10.0;
  var hit = false;
  var stepsUsed: u32 = 0u;

  // Closest silhouette edge tracking for zero-derivative analytical anti-aliasing
  var edgeMinNorm = 1e5;
  var edgeT = 0.1;

  if (disc >= 0.0) {
    let sqrtDisc = sqrt(disc);
    t = max(0.1, -bDot - sqrtDisc);
    tMax = min(10.0, -bDot + sqrtDisc);
    if (t < tMax) {
      for (var i: u32 = 0u; i < 64u; i++) {
        stepsUsed = i + 1u;
        let p = ro + rd * t;
        let d = sdf(p);
        let coneRadius = max(0.001, t * pixelAngle);
        let normD = d / (coneRadius * 1.35);
        if (normD < edgeMinNorm && t < 6.0) {
          edgeMinNorm = normD;
          edgeT = t;
        }
        if (d < coneRadius * 0.55) {
          hit = true;
          break;
        }
        t += d * stepScale;
        if (t > tMax) {
          break;
        }
      }
    }
  }

  // Debug Mode 2: Step-cost heatmap
  if (debugMode == 2u) {
    let heat = heatmapColor(f32(stepsUsed) / 80.0);
    return vec4f(heat, 1.0);
  }

  // Debug Mode 1: Analytical surface normals
  if (debugMode == 1u) {
    if (!hit) {
      return vec4f(0.13, 0.12, 0.09, 1.0);
    }
    let n = sdfNormalEps(ro + rd * t, max(0.0009, t * pixelAngle * 0.55));
    return vec4f(n * 0.5 + 0.5, 1.0);
  }

  // Debug Mode 3: Cross-section cutaway SDF slice on y = 0 (shows negative interior & anti-aliased isolines)
  if (debugMode == 3u) {
    if (abs(rd.y) > 0.001) {
      let ts = -ro.y / rd.y;
      if (ts > 0.0 && ts < 8.0 && (!hit || ts < t + 0.35)) {
        let sp = ro + rd * ts;
        let sd = sdf(sp);
        let footprint = ts * pixelAngle * 42.0 / max(abs(rd.y), 0.06);
        let lineFade = 1.0 - smoothstep(0.6, 2.2, footprint);
        let wave = 0.5 + 0.5 * cos(sd * 42.0);
        let insideCol = vec3f(0.04, 0.42, 0.58);
        let outsideCol = vec3f(1.0, 0.83, 0.23);
        var sliceCol = mix(insideCol, outsideCol, smoothstep(-0.08, 0.08, sd));
        sliceCol = mix(sliceCol, vec3f(0.13, 0.12, 0.09), smoothstep(0.88, 0.99, wave) * 0.65 * lineFade);
        // Highlight exact zero-level surface boundary in crisp cream white
        let zeroBorder = 1.0 - smoothstep(0.002, 0.014, abs(sd));
        sliceCol = mix(sliceCol, vec3f(1.0, 0.97, 0.84), zeroBorder);
        return vec4f(sliceCol, 1.0);
      }
    }
    if (hit) {
      let n = sdfNormalEps(ro + rd * t, max(0.0009, t * pixelAngle * 0.55));
      return vec4f(vec3f(0.18 + 0.65 * max(dot(n, keyLight), 0.0)), 1.0);
    }
    return vec4f(1.0, 212.0 / 255.0, 59.0 / 255.0, 1.0);
  }

  // Interleaved Gradient Noise (IGN) 8-bit dithering to eliminate Mach banding on subtle yellow ground shadows
  let ign = fract(52.9829189 * fract(dot(in.pos.xy, vec2f(0.06711056, 0.00583715))));
  let dither = (ign - 0.5) / 255.0;

  if (hit) {
    let hitSrgb = shadeSurfaceHit(ro + rd * t, t, rd, keyLight, fillLight);
    return vec4f(clamp(hitSrgb + vec3f(dither), vec3f(0.0), vec3f(1.0)), 1.0);
  }

  // Only evaluate backdrop & ground soft shadow on background or silhouette edge pixels (saves ~30% fragment cost)
  let bgSrgb = evalBackdropAndGroundShadow(ro, rd, keyLight);

  // Analytical silhouette anti-aliasing: smooth transition from hit threshold (0.55/1.35 = 0.407) to 1.0
  if (edgeMinNorm < 1.0) {
    let edgeCoverage = 1.0 - smoothstep(0.407, 1.0, edgeMinNorm);
    let edgeSrgb = shadeSurfaceHit(ro + rd * edgeT, edgeT, rd, keyLight, fillLight);
    return vec4f(clamp(mix(bgSrgb, edgeSrgb, edgeCoverage) + vec3f(dither), vec3f(0.0), vec3f(1.0)), 1.0);
  }

  return vec4f(clamp(bgSrgb + vec3f(dither), vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

  return {
    ok: true,
    hasSimulate: validation.hasSimulate,
    stateCount,
    paramKeys,
    userLineCount,
    computeWGSL,
    renderWGSL,
  };
}

export function formatCompilationDiagnostics(messages, userLineCount, userCode = "") {
  const formatted = [];
  for (const msg of messages) {
    if (msg.type !== "error" && msg.type !== "warning") continue;
    if (msg.lineNum <= userLineCount) {
      formatted.push({
        type: msg.type,
        line: msg.lineNum,
        column: msg.linePos || 1,
        message: msg.message,
      });
    } else {
      // Check if this is a redeclaration error referencing a line in user code
      const redeclMatch = /redeclaration of '([^']+)'/.exec(msg.message);
      if (redeclMatch && userCode) {
        const stripped = stripCommentsPreservingLayout(userCode);
        const fnRegex = new RegExp(`\\b${redeclMatch[1]}\\b`);
        const m = fnRegex.exec(stripped);
        const line = m ? lineNumberAt(stripped, m.index) : 1;
        formatted.push({
          type: msg.type,
          line,
          column: 1,
          message: `'${redeclMatch[1]}' conflicts with a built-in SDF library or host symbol.`,
        });
      } else {
        formatted.push({
          type: msg.type,
          line: userLineCount,
          column: 1,
          message: `Scene signature error near entrypoint: ${msg.message} (Verify 'fn sdf(p: vec3f) -> f32', 'fn material(p: vec3f, n: vec3f) -> Material', and 'fn simulate(i: u32) -> vec4f').`,
        });
      }
    }
  }
  return formatted;
}

// Unified Mode B Skinned Mesh & Crowd WGSL Shader (shares GGX microfacet specular, Studio Softbox reflection & PBR Neutral tone-mapping with Mode A)
// Formal 16-float vertex layout (64 bytes):
//   @location(0) posAndMat:      xyz = worldPos,    w = materialId (0=standard, 1=vehicleBody, 2=vehicleWheel, 3=bipedCitizen, 4=glossyEye, 5=unlitGizmo, 6=shadowDisc, 7=roadbed)
//   @location(1) normalAndRough: xyz = worldNormal, w = roughness
//   @location(2) colorAndMetal:  xyz = baseColor,   w = metallic
//   @location(3) localAndScale:  xyz = restPos (normalized by parametric chassis scale), w = parametric cabin scale
export const MESH_RENDER_WGSL = /* wgsl */ `
const PI: f32 = 3.141592653589793;

struct HostUniforms {
  camPos: vec4f,
  camTarget: vec4f,
  camRight: vec4f,
  camUp: vec4f,
  camForward: vec4f,
  pointerRayOrigin: vec4f,
  pointerRayDir: vec4f,
  simMeta: vec4f,
  params: array<vec4f, 4>,
};

@group(0) @binding(0) var<uniform> _u: HostUniforms;
@group(0) @binding(1) var<uniform> _sdfBlocks: array<vec4f, 64>;

struct VertexIn {
  @location(0) posAndMat: vec4f,
  @location(1) normalAndRough: vec4f,
  @location(2) colorAndMetal: vec4f,
  @location(3) localAndScale: vec4f,
};

struct VertexOut {
  @builtin(position) clipPos: vec4f,
  @location(0) posAndMat: vec4f,
  @location(1) normalAndRough: vec4f,
  @location(2) colorAndMetal: vec4f,
  @location(3) localAndScale: vec4f,
};

fn pbrNeutralToneMapping(colorIn: vec3f) -> vec3f {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  let x = min(colorIn.r, min(colorIn.g, colorIn.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  var color = colorIn - vec3f(offset);
  let peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) {
    return clamp(color, vec3f(0.0), vec3f(1.0));
  }
  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / max(peak, 0.0001);
  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return clamp(mix(color, vec3f(newPeak), g), vec3f(0.0), vec3f(1.0));
}

fn D_GGX(ndh: f32, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let denom = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / max(PI * denom * denom, 0.0001);
}

fn V_SmithGGXCorrelated(ndv: f32, ndl: f32, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let ggxV = ndl * sqrt(ndv * ndv * (1.0 - a2) + a2);
  let ggxL = ndv * sqrt(ndl * ndl * (1.0 - a2) + a2);
  return 0.5 / max(ggxV + ggxL, 0.0001);
}

fn F_Schlick(cosTheta: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn F_SchlickRoughness(cosTheta: f32, f0: vec3f, roughness: f32) -> vec3f {
  let maxGloss = max(vec3f(1.0 - roughness), f0);
  return f0 + (maxGloss - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn studioEnvReflection(reflDir: vec3f, roughness: f32, envF: vec3f, eyeCoat: vec3f) -> vec3f {
  let softness = mix(0.025, 0.48, roughness);
  let box1Dir = normalize(vec3f(0.48, 0.74, 0.46));
  let box2Dir = normalize(vec3f(-0.68, 0.42, 0.58));
  let box1 = smoothstep(0.88 - softness, 0.96 + softness * 0.2, dot(reflDir, box1Dir));
  let box2 = smoothstep(0.91 - softness, 0.97 + softness * 0.2, dot(reflDir, box2Dir)) * 0.55;
  let skyGrad = mix(vec3f(0.95, 0.76, 0.18), vec3f(1.0, 0.98, 0.92), clamp(reflDir.y * 0.5 + 0.5, 0.0, 1.0));
  let skyTerm = skyGrad * 0.20 * envF;
  let boxTerm = vec3f(1.0, 0.99, 0.95) * (box1 * 1.50 + box2 * 0.70) * (1.0 - roughness * 0.75) * max(envF, eyeCoat);
  return (skyTerm + boxTerm) * mix(0.85, 1.35, 1.0 - roughness);
}

fn opSmoothUnionLive(d1: f32, d2: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (d2 - d1) / max(k, 0.0001), 0.0, 1.0);
  return mix(d2, d1, h) - k * h * (1.0 - h);
}

fn opSmoothSubLive(d1: f32, d2: f32, k: f32) -> f32 {
  let h = clamp(0.5 - 0.5 * (d1 + d2) / max(k, 0.0001), 0.0, 1.0);
  return mix(d1, -d2, h) + k * h * (1.0 - h);
}

fn sdEllipsoidLive(p: vec3f, r: vec3f) -> f32 {
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

fn evalBathWaterWaveLive(xz: vec2f) -> f32 {
  let uv = xz / 0.72 - vec2f(0.25, 0.20);
  let r = length(uv);
  return cos(r * 6.0) * exp(-r * 2.5) * 0.035;
}

fn evalLiveBlockPrim(p: vec3f, b0: vec4f, b1: vec4f, b3: vec4f) -> f32 {
  let flags = i32(round(b3.y));
  let groupId = i32(round(b3.z));
  let mirrorX = (flags & 1) != 0;
  let q = vec3f(select(p.x, abs(p.x), mirrorX) - b0.x, p.y - b0.y, p.z - b0.z);
  let s = max(b1.xyz, vec3f(0.012));
  let r = b1.w;
  let prim = i32(round(b0.w));

  if (prim == 0) {
    if (abs(s.x - s.y) < 0.002 && abs(s.y - s.z) < 0.002) {
      return length(q) - s.x;
    }
    return sdEllipsoidLive(q, s);
  }
  if (prim == 1) {
    return sdEllipsoidLive(q, s);
  }
  if (prim == 2) {
    let rBox = clamp(r, 0.002, min(s.x, min(s.y, s.z)) * 0.85);
    let d = abs(q) - s + vec3f(rBox);
    return length(max(d, vec3f(0.0))) + min(max(d.x, max(d.y, d.z)), 0.0) - rBox;
  }
  if (prim == 3) {
    let minXZ = min(s.x, s.z);
    let rad = length(vec2f(q.x / s.x, q.z / s.z)) * minXZ;
    if (groupId == 3) {
      let waveH = evalBathWaterWaveLive(p.xz);
      let waterPlane = p.y - (b0.y + s.y + waveH);
      let dCyl = abs(vec2f(rad, q.y)) - vec2f(minXZ, s.y + 0.04);
      let waterCyl = min(max(dCyl.x, dCyl.y), 0.0) + length(max(dCyl, vec2f(0.0)));
      return max(waterCyl, waterPlane) / 1.12;
    }
    let rCyl = clamp(r, 0.0, min(minXZ, s.y) * 0.45);
    let d = abs(vec2f(rad, q.y)) - vec2f(minXZ - rCyl, s.y - rCyl);
    return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0))) - rCyl;
  }
  if (prim == 4) {
    let a = vec3f(0.0, -s.y, s.z);
    let b = vec3f(0.0, s.y, -s.z);
    let ba = b - a;
    let pa = q - a;
    let h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.00001), 0.0, 1.0);
    let rb = clamp(r, 0.015, s.x);
    return length(pa - ba * h) - mix(s.x, rb, h);
  }
  let minXZ = min(s.x, s.z);
  let rad = length(vec2f(q.x / s.x, q.z / s.z)) * minXZ;
  return length(vec2f(rad - minXZ, q.y)) - s.y;
}

struct LiveBathEval {
  dDuck: f32,
  dBeak: f32,
  dEye: f32,
  dWater: f32,
  dTub: f32,
  dTotal: f32,
  beakK: f32,
  duckCol: vec3f,
  duckRough: f32,
  beakCol: vec3f,
  beakRough: f32,
  eyeCol: vec3f,
  eyeRough: f32,
  waterCol: vec3f,
  waterRough: f32,
  tubCol: vec3f,
  tubRough: f32,
};

fn evalLiveBath(p: vec3f) -> LiveBathEval {
  var ev: LiveBathEval;
  ev.dDuck = 10.0;
  ev.dBeak = 10.0;
  ev.dEye = 10.0;
  ev.dWater = 10.0;
  ev.dTub = 10.0;
  ev.beakK = 0.025;
  ev.duckCol = vec3f(1.0, 0.83, 0.16);
  ev.duckRough = 0.36;
  ev.beakCol = vec3f(0.96, 0.44, 0.08);
  ev.beakRough = 0.32;
  ev.eyeCol = vec3f(0.03, 0.03, 0.03);
  ev.eyeRough = 0.03;
  ev.waterCol = vec3f(0.10, 0.72, 0.90);
  ev.waterRough = 0.14;
  ev.tubCol = vec3f(0.98, 0.96, 0.90);
  ev.tubRough = 0.16;

  var bestDuckD = 1e6;
  var bestTubD = 1e6;
  let count = clamp(u32(round(_sdfBlocks[3].w)), 0u, 16u);

  for (var i: u32 = 0u; i < count; i++) {
    let base = i * 4u;
    let b0 = _sdfBlocks[base + 0u];
    let b1 = _sdfBlocks[base + 1u];
    let b2 = _sdfBlocks[base + 2u];
    let b3 = _sdfBlocks[base + 3u];
    let k = max(0.001, b3.x);
    let flags = i32(round(b3.y));
    let isSub = (flags & 2) != 0;
    let groupId = i32(round(b3.z));
    let dp = evalLiveBlockPrim(p, b0, b1, b3);

    if (groupId == 0) {
      if (isSub) {
        ev.dDuck = opSmoothSubLive(ev.dDuck, dp, k);
      } else {
        if (abs(dp) < bestDuckD) {
          bestDuckD = abs(dp);
          ev.duckCol = b2.xyz;
          ev.duckRough = b2.w;
        }
        ev.dDuck = select(opSmoothUnionLive(ev.dDuck, dp, k), dp, ev.dDuck > 5.0);
      }
    } else if (groupId == 1) {
      ev.beakK = k;
      if (isSub) {
        ev.dBeak = opSmoothSubLive(ev.dBeak, dp, k);
      } else {
        ev.beakCol = b2.xyz;
        ev.beakRough = b2.w;
        ev.dBeak = select(opSmoothUnionLive(ev.dBeak, dp, k), dp, ev.dBeak > 5.0);
      }
    } else if (groupId == 2) {
      if (isSub) {
        ev.dEye = opSmoothSubLive(ev.dEye, dp, k);
      } else {
        ev.eyeCol = b2.xyz;
        ev.eyeRough = b2.w;
        ev.dEye = select(min(ev.dEye, dp), dp, ev.dEye > 5.0);
      }
    } else if (groupId == 3) {
      if (isSub) {
        ev.dWater = opSmoothSubLive(ev.dWater, dp, k);
      } else {
        ev.waterCol = b2.xyz;
        ev.waterRough = b2.w;
        ev.dWater = select(opSmoothUnionLive(ev.dWater, dp, k), dp, ev.dWater > 5.0);
      }
    } else {
      if (isSub) {
        ev.dTub = opSmoothSubLive(ev.dTub, dp, k);
      } else {
        if (abs(dp) < bestTubD) {
          bestTubD = abs(dp);
          ev.tubCol = b2.xyz;
          ev.tubRough = b2.w;
        }
        ev.dTub = select(opSmoothUnionLive(ev.dTub, dp, k), dp, ev.dTub > 5.0);
      }
    }
  }

  let duckFull = min(opSmoothUnionLive(ev.dDuck, ev.dBeak, ev.beakK), ev.dEye);
  let tubAndWater = min(ev.dTub, ev.dWater);
  ev.dTotal = min(duckFull, tubAndWater);
  return ev;
}

fn evalLiveSDF(p: vec3f) -> f32 {
  let bound = length(p - vec3f(0.0, -0.10, 0.0)) - 1.35;
  if (bound > 0.20) {
    return bound;
  }
  return evalLiveBath(p).dTotal;
}

fn evalLiveNormal(p: vec3f, eps: f32) -> vec3f {
  let e = vec2f(1.0, -1.0) * 0.57735027;
  return normalize(
    e.xyy * evalLiveSDF(p + e.xyy * eps) +
    e.yyx * evalLiveSDF(p + e.yyx * eps) +
    e.yxy * evalLiveSDF(p + e.yxy * eps) +
    e.xxx * evalLiveSDF(p + e.xxx * eps)
  );
}

fn calcLiveSoftShadow(ro: vec3f, rd: vec3f, mint: f32, maxt: f32, k: f32) -> f32 {
  var res = 1.0;
  var t = mint;
  var ph = 1e10;
  var prevStep = mint;
  for (var i: u32 = 0u; i < 28u; i++) {
    let h = evalLiveSDF(ro + rd * t);
    if (h < 0.0008) {
      return 0.0;
    }
    if (i > 0u && h < ph + prevStep) {
      let y = clamp((h * h - ph * ph + prevStep * prevStep) / (2.0 * prevStep), 0.0, prevStep);
      let d = sqrt(max(0.0, h * h - (prevStep - y) * (prevStep - y)));
      res = min(res, k * d / max(0.001, t - prevStep + y));
    } else {
      res = min(res, k * h / t);
    }
    if (res < 0.002) {
      return 0.0;
    }
    ph = h;
    let stepLen = clamp(h * 0.45, 0.008, 0.065);
    prevStep = stepLen;
    t += stepLen;
    if (t > maxt) {
      break;
    }
  }
  let s = clamp(res, 0.0, 1.0);
  return s * s * (3.0 - 2.0 * s);
}

fn calcLiveAO(pos: vec3f, nor: vec3f) -> f32 {
  var occ = 0.0;
  var sca = 1.0;
  for (var i: u32 = 0u; i < 4u; i++) {
    let h = 0.02 + 0.11 * f32(i) / 3.0;
    let samplePos = pos + h * nor;
    let d = evalLiveSDF(samplePos);
    occ += clamp(h - d, 0.0, h) * sca;
    sca *= 0.70;
  }
  let selfAO = clamp(1.0 - 2.35 * occ, 0.0, 1.0);
  let groundHorizon = mix(0.90, 1.0, smoothstep(0.0, 0.14, pos.y - -0.53));
  return selfAO * groundHorizon;
}

fn evalLiveBackdropAndGroundShadow(ro: vec3f, rd: vec3f, keyLight: vec3f) -> vec3f {
  let bgSrgb = vec3f(1.0, 212.0 / 255.0, 59.0 / 255.0);
  let inkSrgb = vec3f(33.0 / 255.0, 31.0 / 255.0, 23.0 / 255.0);
  var colSrgb = bgSrgb;
  if (rd.y < -0.001) {
    let tg = (-0.53 - ro.y) / rd.y;
    if (tg > 0.0 && tg < 8.0) {
      let gp = ro + rd * tg;
      let rDist = length(gp.xz);
      let radialFade = smoothstep(1.65, 0.35, rDist);
      if (radialFade > 0.001) {
        let contactDist = clamp(evalLiveSDF(gp + vec3f(0.0, 0.015, 0.0)) / 0.22, 0.0, 1.0);
        let contactAO = smoothstep(1.0, 0.0, contactDist) * 0.15;
        var castShadow = 0.0;
        let toCenter = vec3f(0.0, -0.20, 0.0) - gp;
        let proj = dot(toCenter, keyLight);
        let perpSq = dot(toCenter, toCenter) - proj * proj;
        let boundR = 1.47;
        if (proj > -0.85 && perpSq < boundR * boundR) {
          let sh = calcLiveSoftShadow(gp + vec3f(0.0, 0.012, 0.0), keyLight, 0.025, 2.2, 5.0);
          let boxFade = smoothstep(-0.85, -0.40, proj) * smoothstep(boundR * boundR, 1.02 * 1.02, perpSq);
          castShadow = (1.0 - sh) * 0.18 * boxFade;
        }
        let shadowStrength = (castShadow + contactAO) * radialFade;
        colSrgb = mix(bgSrgb, inkSrgb, clamp(shadowStrength, 0.0, 0.28));
      }
    }
  }
  return colSrgb;
}

fn shadeLiveBathHit(p: vec3f, tHit: f32, rd: vec3f, keyLight: vec3f, fillLight: vec3f) -> vec3f {
  let bgLinear = vec3f(1.0, 0.665, 0.040);
  let inkLinear = vec3f(0.015, 0.013, 0.008);
  let normalEps = max(0.0009, tHit * max(_u.camForward.w, 0.0012) * 0.55);
  let n = evalLiveNormal(p, normalEps);
  let v = -rd;
  let ev = evalLiveBath(p);
  let duckFull = min(opSmoothUnionLive(ev.dDuck, ev.dBeak, ev.beakK), ev.dEye);

  var matColor = ev.duckCol;
  var matRough = ev.duckRough;
  var matSub = 0.38;

  if (ev.dWater <= duckFull + 0.003 && ev.dWater <= ev.dTub + 0.003) {
    matColor = ev.waterCol;
    matRough = ev.waterRough;
    matSub = 0.88;
  } else if (ev.dTub < duckFull) {
    matColor = ev.tubCol;
    matRough = ev.tubRough;
    matSub = 0.38;
  } else {
    let beakW = smoothstep(0.005, -0.005, ev.dBeak - ev.dDuck);
    matColor = mix(ev.duckCol, ev.beakCol, beakW);
    matRough = mix(ev.duckRough, ev.beakRough, beakW);
    let eyeW = smoothstep(0.004, -0.004, ev.dEye - min(ev.dDuck, ev.dBeak));
    matColor = mix(matColor, ev.eyeCol, eyeW);
    matRough = mix(matRough, ev.eyeRough, eyeW);
  }

  let baseCol = pow(clamp(matColor, vec3f(0.0), vec3f(1.0)), vec3f(2.2));
  let roughness = clamp(matRough, 0.04, 1.0);
  let alpha = roughness * roughness;
  let metallic = 0.0;
  let ao = calcLiveAO(p, n);
  let shadow = calcLiveSoftShadow(p + n * 0.006, keyLight, 0.02, 3.8, 9.0);

  let ndv = max(dot(n, v), 0.001);
  let ndl = max(dot(n, keyLight), 0.0);
  let fillNdl = max(dot(n, fillLight), 0.0);
  let bounce = clamp(0.5 - 0.5 * n.y, 0.0, 1.0);

  let f0 = vec3f(0.045);
  let hVec = normalize(keyLight + v);
  let ndh = max(dot(n, hVec), 0.0);
  let vdh = max(dot(v, hVec), 0.0);

  let D = D_GGX(ndh, max(0.04, alpha));
  let V = V_SmithGGXCorrelated(ndv, max(ndl, 0.001), max(0.04, alpha));
  let F = F_Schlick(vdh, f0);
  let directSpec = (D * V * F) * ndl * (0.18 + 0.82 * shadow) * vec3f(1.15, 1.10, 1.02);

  let envF = F_SchlickRoughness(ndv, f0, roughness);
  let isCornea = smoothstep(0.08, 0.03, roughness) * (1.0 - step(0.45, matSub));
  let eyeCoat = vec3f(isCornea * 0.68);
  let refl = studioEnvReflection(reflect(-v, n), roughness, envF, eyeCoat);

  let kD = vec3f(1.0) - max(envF, eyeCoat * 0.25);
  let diffuseColor = baseCol * kD;

  let backVec = normalize(-keyLight + n * 0.42);
  let backLight = clamp(dot(v, backVec), 0.0, 1.0);
  let thicknessProbe = clamp(evalLiveSDF(p - n * 0.12) / -0.12, 0.0, 1.0);
  let sss = pow(backLight, 2.0) * (1.0 - thicknessProbe * 0.45) * matSub * baseCol * 0.65;

  var color = diffuseColor * (
    vec3f(0.32, 0.31, 0.28) * ao +
    vec3f(1.06, 1.01, 0.95) * ndl * (0.20 + 0.80 * shadow) +
    vec3f(0.30, 0.42, 0.52) * fillNdl * ao +
    bgLinear * 0.30 * bounce * ao
  );

  if (matSub > 0.52 && roughness < 0.20) {
    let ior = 1.34;
    let refrDir = normalize(refract(rd, n, 1.0 / ior));
    var opticalDepth = 0.04;
    var marchT = 0.03;
    for (var k: u32 = 0u; k < 6u; k++) {
      let dInside = evalLiveSDF(p + refrDir * marchT);
      if (dInside > 0.0) {
        break;
      }
      let stepLen = clamp(-dInside, 0.025, 0.09);
      opticalDepth += stepLen;
      marchT += stepLen;
    }
    let exitPos = p + refrDir * marchT;
    let bgBehindSrgb = evalLiveBackdropAndGroundShadow(exitPos, refrDir, keyLight);
    let bgBehindLin = pow(clamp(bgBehindSrgb, vec3f(0.0), vec3f(1.0)), vec3f(2.2));
    let sigma = (vec3f(1.02) - baseCol) * 4.2 + vec3f(0.25);
    let transmittance = exp(-sigma * opticalDepth);
    let refractedCol = bgBehindLin * transmittance * mix(vec3f(1.0), baseCol * 1.25, 0.55);
    let jellyWeight = clamp((matSub - 0.45) * 1.4, 0.0, 0.72) * (1.0 - dot(envF, vec3f(0.333)));
    color = mix(color, refractedCol, jellyWeight);
  }

  color += sss + directSpec + refl;

  let edgeInk = smoothstep(0.12, 0.02, ndv);
  color = mix(color, inkLinear, edgeInk * 0.14);

  let mapped = pbrNeutralToneMapping(color);
  return pow(mapped, vec3f(1.0 / 2.2));
}

@vertex
fn vsMeshMain(in: VertexIn) -> VertexOut {
  var out: VertexOut;
  let rel = in.posAndMat.xyz - _u.camPos.xyz;
  let vx = dot(rel, _u.camRight.xyz);
  let vy = dot(rel, _u.camUp.xyz);
  let vz = dot(rel, _u.camForward.xyz);
  let aspect = max(_u.camRight.w, 0.1);
  let tanHalfFov = max(_u.camUp.w, 0.05);
  let zNear = 0.08;
  let zFar = 25.0;
  let cx = vx / (aspect * tanHalfFov);
  let cy = vy / tanHalfFov;
  let cz = (zFar / (zFar - zNear)) * vz - (zNear * zFar) / (zFar - zNear);
  out.clipPos = vec4f(cx, cy, cz, vz);
  out.posAndMat = in.posAndMat;
  out.normalAndRough = in.normalAndRough;
  out.colorAndMetal = in.colorAndMetal;
  out.localAndScale = in.localAndScale;
  return out;
}

@fragment
fn fsMeshMain(in: VertexOut) -> @location(0) vec4f {
  let matId = i32(round(in.posAndMat.w));
  let worldPos = in.posAndMat.xyz;
  let fwWorld = max(vec3f(1e-3), fwidth(worldPos));

  // MaterialId 14: Live SDF High-Precision Smooth Mode (100% per-pixel analytical SDF on rasterized hull)
  if (matId == 14) {
    let ro = _u.camPos.xyz;
    let rd = normalize(worldPos - ro);
    let pixelAngle = max(_u.camForward.w, 0.0012);
    let keyLight = normalize(vec3f(0.58, 0.76, 0.30));
    let fillLight = normalize(vec3f(-0.65, 0.35, -0.45));

    let oc = ro - vec3f(0.0, -0.15, 0.0);
    let bDot = dot(oc, rd);
    let cDot = dot(oc, oc) - 1.52 * 1.52;
    let disc = bDot * bDot - cDot;

    var t = 0.1;
    var tMax = 10.0;
    var hit = false;
    var edgeMinNorm = 1e5;
    var edgeT = 0.1;

    if (disc >= 0.0) {
      let sqrtDisc = sqrt(disc);
      t = max(0.1, -bDot - sqrtDisc);
      tMax = min(10.0, -bDot + sqrtDisc);
      if (rd.y < -0.001) {
        let tg = (-0.53 - ro.y) / rd.y;
        if (tg > 0.1) {
          tMax = min(tMax, tg);
        }
      }
      if (t < tMax) {
        for (var i: u32 = 0u; i < 64u; i++) {
          let p = ro + rd * t;
          let d = evalLiveSDF(p);
          let coneRadius = max(0.001, t * pixelAngle);
          let normD = d / (coneRadius * 1.35);
          if (normD < edgeMinNorm && t < 6.0 && p.y >= -0.5295) {
            edgeMinNorm = normD;
            edgeT = t;
          }
          if (d < coneRadius * 0.55) {
            hit = true;
            break;
          }
          t += d * 0.82;
          if (t > tMax) {
            break;
          }
        }
      }
    }

    let ign = fract(52.9829189 * fract(dot(in.clipPos.xy, vec2f(0.06711056, 0.00583715))));
    let dither = (ign - 0.5) / 255.0;

    if (hit) {
      let hitSrgb = shadeLiveBathHit(ro + rd * t, t, rd, keyLight, fillLight);
      return vec4f(clamp(hitSrgb + vec3f(dither), vec3f(0.0), vec3f(1.0)), 1.0);
    }

    let bgSrgb = evalLiveBackdropAndGroundShadow(ro, rd, keyLight);
    if (edgeMinNorm < 1.0) {
      let edgeCoverage = 1.0 - smoothstep(0.407, 1.0, edgeMinNorm);
      let edgeSrgb = shadeLiveBathHit(ro + rd * edgeT, edgeT, rd, keyLight, fillLight);
      return vec4f(clamp(mix(bgSrgb, edgeSrgb, edgeCoverage) + vec3f(dither), vec3f(0.0), vec3f(1.0)), 1.0);
    }
    return vec4f(clamp(bgSrgb + vec3f(dither), vec3f(0.0), vec3f(1.0)), 1.0);
  }

  // MaterialId 6: Per-pixel contact AO + directional soft cast shadow disc for lowpoly & crowd modes
  if (matId == 6) {
    let localXZ = in.normalAndRough.xz;
    let r = length(localXZ);
    let contactDist = clamp((r - 0.83) / 0.22, 0.0, 1.0);
    let contactAO = smoothstep(1.0, 0.0, contactDist) * 0.15;
    let shadowCenter = vec2f(-0.18, -0.095);
    let dCast = length((localXZ - shadowCenter) * vec2f(0.92, 1.04));
    let castSh = (1.0 - smoothstep(0.76, 1.18, dCast)) * 0.16;
    let radialFade = 1.0 - smoothstep(1.12, 1.42, r);
    let shadowAlpha = clamp((contactAO + castSh) * radialFade, 0.0, 0.26);
    let shadowInk = vec3f(33.0 / 255.0, 31.0 / 255.0, 23.0 / 255.0);
    return vec4f(mix(in.colorAndMetal.xyz, shadowInk, shadowAlpha), 1.0);
  }

  // MaterialId 5: Unlit 3D Gizmo octahedron marker
  if (matId == 5) {
    return vec4f(in.colorAndMetal.xyz, 1.0);
  }

  let debugMode = i32(round(_u.simMeta.y));
  let n = normalize(in.normalAndRough.xyz);
  if (debugMode == 1) {
    return vec4f(n * 0.5 + 0.5, 1.0);
  }
  if (debugMode >= 2) {
    return vec4f(in.colorAndMetal.xyz, 1.0);
  }

  let srgbColor = in.colorAndMetal.xyz;
  let roughness = clamp(in.normalAndRough.w, 0.04, 1.0);
  let metallic = clamp(in.colorAndMetal.w, 0.0, 1.0);
  let emissive = vec3f(0.0);

  // Unified GGX Microfacet Specular + Schlick Fresnel + Studio Softbox Reflection + PBR Neutral Tone Mapping (matches Mode A!)
  let bgLinear = vec3f(1.0, 0.665, 0.040);
  let inkLinear = vec3f(0.015, 0.013, 0.008);
  let baseCol = pow(clamp(srgbColor, vec3f(0.0), vec3f(1.0)), vec3f(2.2));
  let alpha = roughness * roughness;
  let v = normalize(_u.camPos.xyz - worldPos);
  let keyLight = normalize(vec3f(0.58, 0.76, 0.30));
  let fillLight = normalize(vec3f(-0.65, 0.35, -0.45));

  let hasBakedAO = in.localAndScale.w < -0.5;
  let ao = select(1.0, clamp(in.localAndScale.x, 0.0, 1.0), hasBakedAO);
  let shadow = select(1.0, clamp(in.localAndScale.y, 0.0, 1.0), hasBakedAO);
  let subsurface = select(0.18, clamp(in.localAndScale.z, 0.0, 1.0), hasBakedAO);

  let ndv = max(dot(n, v), 0.001);
  let ndl = max(dot(n, keyLight), 0.0);
  let fillNdl = max(dot(n, fillLight), 0.0);
  let bounce = clamp(0.5 - 0.5 * n.y, 0.0, 1.0);

  let f0 = mix(vec3f(0.045), baseCol, metallic);
  let hVec = normalize(keyLight + v);
  let ndh = max(dot(n, hVec), 0.0);
  let vdh = max(dot(v, hVec), 0.0);

  let D = D_GGX(ndh, max(0.04, alpha));
  let V = V_SmithGGXCorrelated(ndv, max(ndl, 0.001), max(0.04, alpha));
  let F = F_Schlick(vdh, f0);
  let directSpec = (D * V * F) * ndl * (0.18 + 0.82 * shadow) * vec3f(1.15, 1.10, 1.02);

  let envF = F_SchlickRoughness(ndv, f0, roughness);
  let isCornea = smoothstep(0.08, 0.03, roughness) * (1.0 - metallic) * (1.0 - step(0.45, subsurface));
  let eyeCoat = vec3f(isCornea * 0.68);
  let refl = studioEnvReflection(reflect(-v, n), roughness, envF, eyeCoat);

  let kD = (vec3f(1.0) - max(envF, eyeCoat * 0.25)) * (1.0 - metallic);
  let diffuseColor = baseCol * kD;

  let backVec = normalize(-keyLight + n * 0.42);
  let backLight = clamp(dot(v, backVec), 0.0, 1.0);
  let sss = pow(backLight, 2.0) * subsurface * baseCol * 0.45;

  var color = diffuseColor * (
    vec3f(0.32, 0.31, 0.28) * ao +
    vec3f(1.06, 1.01, 0.95) * ndl * (0.20 + 0.80 * shadow) +
    vec3f(0.30, 0.42, 0.52) * fillNdl * ao +
    bgLinear * 0.30 * bounce * ao
  );

  if (matId == 11 || (subsurface > 0.52 && roughness < 0.20)) {
    let opticalDepth = 0.22;
    let sigma = (vec3f(1.02) - baseCol) * 4.2 + vec3f(0.25);
    let transmittance = exp(-sigma * opticalDepth);
    let refractedCol = bgLinear * transmittance * mix(vec3f(1.0), baseCol * 1.25, 0.55) * (0.65 + 0.35 * shadow) * ao;
    let jellyWeight = clamp((subsurface - 0.45) * 1.4, 0.0, 0.72) * (1.0 - dot(envF, vec3f(0.333)));
    color = mix(color, refractedCol, jellyWeight);
  }

  color += sss + directSpec + refl + emissive;

  let edgeInk = smoothstep(0.12, 0.02, ndv);
  color = mix(color, inkLinear, edgeInk * 0.14);

  let mapped = pbrNeutralToneMapping(max(color, vec3f(0.0)));
  let srgbOut = pow(mapped, vec3f(1.0 / 2.2));
  return vec4f(clamp(srgbOut, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
