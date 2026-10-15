// The slappable head: baked-light skin, optional photo face, morph expressions,
// swelling, handprint marks and jelly flesh (softbody.js).
import { createSoftBody } from "./softbody.js";

const kinds = { float32: Float32Array, uint16: Uint16Array, int16: Int16Array, uint32: Uint32Array };

export async function loadPack(asset, name, signal) {
  const [meta, bin] = await Promise.all([
    fetch(asset(`assets/${name}.json`), { signal }).then((r) => { if (!r.ok) throw new Error(`${name}.json unavailable`); return r.json(); }),
    fetch(asset(`assets/${name}.bin`), { signal }).then((r) => { if (!r.ok) throw new Error(`${name}.bin unavailable`); return r.arrayBuffer(); }),
  ]);
  const arrays = {};
  for (const [key, { offset, length, type }] of Object.entries(meta.arrays)) arrays[key] = new kinds[type](bin, offset, length);
  return { meta, arrays };
}

const vertexShader = /* glsl */ `
  uniform mat4 headMatrix;
  attribute float headWeight;
  attribute vec3 restNormal;
  #ifdef PHOTO
    attribute vec2 photoUv;
    attribute float photoWeight;
    varying vec2 vPhotoUv;
    varying float vPhotoWeight;
  #endif
  #ifdef MARKS
    attribute float cavity;
    varying float vCavity;
  #endif
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vRestNormal;
  varying vec3 vWorld;
  void main() {
    #ifdef MARKS
      vCavity = cavity;
    #endif
    vec3 moved = (headMatrix * vec4(position, 1.0)).xyz;
    vec3 local = mix(position, moved, headWeight);
    vNormal = normalize(mix(normal, mat3(headMatrix) * normal, headWeight));
    vRestNormal = restNormal;
    vUv = uv;
    #ifdef PHOTO
      vPhotoUv = photoUv;
      vPhotoWeight = photoWeight;
    #endif
    vec4 world = modelMatrix * vec4(local, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 lightDir;
  uniform float shade;
  uniform float gloss;
  uniform vec3 gain;
  uniform float opacity;
  uniform int debugView;
  #ifdef PHOTO
    uniform sampler2D photo;
    uniform float photoMix;
    varying vec2 vPhotoUv;
    varying float vPhotoWeight;
  #endif
  #ifdef MARKS
    uniform sampler2D marks;
    uniform float marksAmount;
    varying float vCavity;
  #endif
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vRestNormal;
  varying vec3 vWorld;
  void main() {
    vec4 texel = texture2D(map, vUv);
    #ifdef ALPHA
      if (texel.a < 0.02) discard;
      texel.rgb = mix(vec3(0.07, 0.05, 0.04), texel.rgb, 0.25);
    #endif
    vec3 colour = texel.rgb * gain;
    #ifdef PHOTO
      float w = photoMix * vPhotoWeight;
      if (w > 0.0) colour = mix(colour, texture2D(photo, vPhotoUv).rgb, w);
    #endif
    #ifdef MARKS
      float mark = texture2D(marks, vUv).r * marksAmount;
      colour = mix(colour, colour * vec3(1.08, 0.38, 0.36) + vec3(0.08, 0.0, 0.0), clamp(mark, 0.0, 0.85));
      // The mouth's inside: hidden geometry, or the skin texture's saturated mouth red.
      // Linear values: the mouth red has almost no green (g/r ≈ 0.02); lips ≈ 0.3, skin ≈ 0.5.
      float ratio = max(texel.g, texel.b) / max(texel.r, 0.001);
      float mouth = max(vCavity, (1.0 - smoothstep(0.06, 0.16, ratio)) * step(0.01, texel.r));
      #ifdef PHOTO
        // Where the photo shows, its own lips and mouth stand in for the skin texture's.
        mouth = max(vCavity, mouth * (1.0 - photoMix * vPhotoWeight));
      #endif
      colour = mix(colour, vec3(0.09, 0.035, 0.035), mouth * 0.85);
    #endif
    vec3 n = normalize(vNormal);
    // Lighting is baked; only the change from the rest pose adds light or shadow.
    float delta = dot(n, lightDir) - dot(normalize(vRestNormal), lightDir);
    colour *= clamp(1.0 + shade * delta, 0.55, 1.3);
    vec3 view = normalize(cameraPosition - vWorld);
    float spec = pow(max(dot(n, normalize(lightDir + view)), 0.0), 48.0);
    colour += gloss * spec * smoothstep(0.08, 0.25, dot(texel.rgb, vec3(0.333)));
    #ifdef ALPHA
      gl_FragColor = vec4(colour, texel.a * opacity * 0.9);
    #else
      gl_FragColor = vec4(colour, opacity);
    #endif
    #ifdef MARKS
      if (debugView == 1) gl_FragColor = vec4(vCavity, mouth, 0.0, 1.0);
      if (debugView == 2) gl_FragColor = vec4(vec3(vPhotoWeight), 1.0);
      if (debugView == 3) gl_FragColor = vec4(texel.rgb, 1.0);
    #endif
    #include <colorspace_fragment>
  }
`;

function skinMaterial(THREE, { map, photo = false, marks = null, alpha = false, gloss = 0.06 }) {
  const defines = {};
  if (photo) defines.PHOTO = "";
  if (marks) defines.MARKS = "";
  if (alpha) defines.ALPHA = "";
  return new THREE.ShaderMaterial({
    defines,
    uniforms: {
      map: { value: map }, headMatrix: { value: new THREE.Matrix4() }, lightDir: { value: new THREE.Vector3(0.35, 0.45, 1).normalize() },
      shade: { value: 1.1 }, gloss: { value: gloss }, debugView: { value: 0 }, gain: { value: new THREE.Vector3(1, 1, 1) }, opacity: { value: 1 },
      photo: { value: null }, photoMix: { value: 0 }, marks: { value: marks }, marksAmount: { value: 0 },
    },
    vertexShader, fragmentShader,
    side: alpha ? THREE.DoubleSide : THREE.FrontSide,
    transparent: alpha,
    depthWrite: !alpha,
  });
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function texture(THREE, loader, url, signal) {
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    loader.load(url, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; resolve(tex); }, undefined, () => reject(new Error(`Texture unavailable: ${url}`)));
  });
}

export async function createHead(context, onProgress = () => {}) {
  const { THREE, asset, signal, track } = context;
  const loader = new THREE.TextureLoader();
  let loaded = 0;
  const step = (value) => { loaded++; onProgress(loaded / 5); return value; };
  const [pack, baked, eyeMap, browMap, lashMap] = await Promise.all([
    loadPack(asset, "head", signal).then(step),
    texture(THREE, loader, asset("assets/head.jpg"), signal).then(step),
    texture(THREE, loader, asset("assets/eye.jpg"), signal).then(step),
    texture(THREE, loader, asset("assets/brows.png"), signal).then(step),
    texture(THREE, loader, asset("assets/lashes.png"), signal).then(step),
  ]);
  for (const tex of [baked, eyeMap, browMap, lashMap]) track(tex);
  baked.anisotropy = 4;
  const { meta, arrays } = pack;
  const count = meta.vertices;
  const base = arrays.position;
  const source = arrays.renderSource;
  const renderCount = source.length;

  // Regions: how stiff (bone) or mobile (flesh) each vertex is, and how much it turns with the head.
  const eyes = meta.eyes.map((e) => new THREE.Vector3(...e));
  const eyeMid = eyes[0].clone().add(eyes[1]).multiplyScalar(0.5);
  const stiffness = new Float32Array(count);
  const mobility = new Float32Array(count);
  const headWeight = new Float32Array(count);
  const lips = arrays.group_lips, ears = arrays.group_ears;
  const cheeks = [new THREE.Vector3(0.042, eyeMid.y - 0.05, eyeMid.z - 0.012), new THREE.Vector3(-0.042, eyeMid.y - 0.05, eyeMid.z - 0.012)];
  const jowl = new THREE.Vector3(0, eyeMid.y - 0.1, eyeMid.z - 0.02);
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    p.fromArray(base, i * 3);
    const front = smoothstep(eyeMid.z - 0.09, eyeMid.z - 0.03, p.z);
    const cheek = Math.max(...cheeks.map((c) => Math.exp(-p.distanceToSquared(c) / (2 * 0.028 ** 2))));
    const chin = Math.exp(-p.distanceToSquared(jowl) / (2 * 0.035 ** 2));
    const lip = lips[i];
    const ear = ears[i];
    const skull = smoothstep(eyeMid.y + 0.015, eyeMid.y + 0.05, p.y) * (1 - 0.6 * front);
    const nose = Math.exp(-((p.x / 0.012) ** 2) - (((p.y - (eyeMid.y - 0.03)) / 0.03) ** 2)) * front;
    const eyeZone = Math.max(...eyes.map((e) => Math.exp(-p.distanceToSquared(e) / (2 * 0.016 ** 2))));
    let flesh = Math.max(cheek * 1.0, chin * 0.85, lip * 0.8, ear * 0.9, front * 0.3);
    flesh *= 1 - 0.6 * eyeZone;
    flesh *= 1 - 0.75 * skull;
    flesh *= 1 - 0.55 * nose;
    const neck = smoothstep(-0.05, 0.03, p.y);
    headWeight[i] = neck;
    flesh *= 0.25 + 0.75 * neck;
    mobility[i] = Math.min(1, flesh);
    stiffness[i] = 0.35 + 2.2 * (1 - flesh);
  }

  const rest = new Float32Array(base);
  const physTriangles = new Uint32Array(arrays.index.length);
  for (let t = 0; t < arrays.index.length; t++) physTriangles[t] = source[arrays.index[t]];
  const body = createSoftBody({ rest, triangles: physTriangles, stiffness, mobility });

  // Render mesh: render vertices copy their physics vertex.
  const geometry = track(new THREE.BufferGeometry());
  const positions = new Float32Array(renderCount * 3);
  const normals = new Float32Array(renderCount * 3);
  const renderHeadWeight = new Float32Array(renderCount);
  const photoUv = new Float32Array(renderCount * 2);
  const photoWeight = new Float32Array(renderCount);
  for (let r = 0; r < renderCount; r++) {
    renderHeadWeight[r] = headWeight[source[r]];
    photoWeight[r] = arrays.photoWeight[source[r]];
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("uv", new THREE.BufferAttribute(arrays.renderUv, 2));
  geometry.setAttribute("headWeight", new THREE.BufferAttribute(renderHeadWeight, 1));
  geometry.setAttribute("photoUv", new THREE.BufferAttribute(photoUv, 2).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("photoWeight", new THREE.BufferAttribute(photoWeight, 1));
  const renderCavity = new Float32Array(renderCount);
  for (let r = 0; r < renderCount; r++) renderCavity[r] = arrays.cavity[source[r]];
  geometry.setAttribute("cavity", new THREE.BufferAttribute(renderCavity, 1));
  geometry.setIndex(new THREE.BufferAttribute(arrays.index, 1));

  // Handprints are painted into a texture in the head's bake UV space.
  const marksCanvas = new OffscreenCanvas(512, 512);
  const marksContext = marksCanvas.getContext("2d");
  const marks = track(new THREE.CanvasTexture(marksCanvas));
  marks.flipY = false;
  const material = track(skinMaterial(THREE, { map: baked, photo: true, marks }));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  // Physics vertex normals (shared by render vertices); rest normals stay fixed for shading deltas.
  const physNormals = new Float32Array(count * 3);
  const current = new Float32Array(count * 3);
  function computeNormals(pos, out) {
    out.fill(0);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (let t = 0; t < physTriangles.length; t += 3) {
      const i = physTriangles[t] * 3, j = physTriangles[t + 1] * 3, k = physTriangles[t + 2] * 3;
      a.fromArray(pos, i); b.fromArray(pos, j); c.fromArray(pos, k);
      n.subVectors(c, b).cross(a.sub(b));
      for (const idx of [i, j, k]) { out[idx] += n.x; out[idx + 1] += n.y; out[idx + 2] += n.z; }
    }
    for (let i = 0; i < out.length; i += 3) {
      const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
      out[i] /= l; out[i + 1] /= l; out[i + 2] /= l;
    }
  }
  const restPhysNormals = new Float32Array(count * 3);
  computeNormals(base, restPhysNormals);
  const restNormal = new Float32Array(renderCount * 3);
  for (let r = 0; r < renderCount; r++) restNormal.set(restPhysNormals.subarray(source[r] * 3, source[r] * 3 + 3), r * 3);
  geometry.setAttribute("restNormal", new THREE.BufferAttribute(restNormal, 3));

  // Accessories (eyebrows, eyelashes, eyes) follow their nearest skin vertices.
  const group = new THREE.Group();
  group.add(mesh);
  const accessories = {};
  for (const [name, map, alpha] of [["brows", browMap, true], ["lashes", lashMap, true], ["eyes", eyeMap, false]]) {
    const info = meta.accessories[name];
    const prefix = name + "_";
    const g = track(new THREE.BufferGeometry());
    const accSource = arrays[prefix + "renderSource"];
    const pos = new Float32Array(accSource.length * 3);
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("uv", new THREE.BufferAttribute(arrays[prefix + "renderUv"], 2));
    const accRest = new Float32Array(accSource.length * 3);
    const accBase = arrays[prefix + "position"];
    const accNormals = new Float32Array(info.vertices * 3);
    computeNormals(accBase, accNormals);
    const rn = new Float32Array(accSource.length * 3);
    for (let r = 0; r < accSource.length; r++) { accRest.set(accBase.subarray(accSource[r] * 3, accSource[r] * 3 + 3), r * 3); rn.set(accNormals.subarray(accSource[r] * 3, accSource[r] * 3 + 3), r * 3); }
    g.setAttribute("normal", new THREE.BufferAttribute(rn.slice(), 3));
    g.setAttribute("restNormal", new THREE.BufferAttribute(rn, 3));
    g.setAttribute("headWeight", new THREE.BufferAttribute(new Float32Array(accSource.length).fill(1), 1));
    let mat;
    if (name === "eyes") {
      const pw = new Float32Array(accSource.length);
      for (let r = 0; r < accSource.length; r++) pw[r] = arrays.eyes_photoWeight[accSource[r]];
      g.setAttribute("photoUv", new THREE.BufferAttribute(new Float32Array(accSource.length * 2), 2));
      g.setAttribute("photoWeight", new THREE.BufferAttribute(pw, 1));
      mat = track(skinMaterial(THREE, { map, photo: true, gloss: 0.5 }));
      mat.uniforms.gain.value.set(1.2, 1.18, 1.16);
    } else mat = track(skinMaterial(THREE, { map, alpha, gloss: 0 }));
    g.setIndex(new THREE.BufferAttribute(arrays[prefix + "index"], 1));
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    m.renderOrder = alpha ? 2 : 0;
    group.add(m);
    // Eyes move rigidly with the flesh around each socket; brows and lashes per vertex.
    let sockets = null;
    if (name === "eyes") {
      sockets = eyes.map((eye) => {
        const near = [];
        for (let i = 0; i < count; i++) if (p.fromArray(base, i * 3).distanceTo(eye) < 0.026) near.push(i);
        return near;
      });
    }
    accessories[name] = { mesh: m, geometry: g, material: mat, source: accSource, rest: accRest, bindIndex: arrays[prefix + "bindIndex"], bindWeight: arrays[prefix + "bindWeight"], sockets, eyeOf: null };
    if (name === "eyes") {
      accessories.eyes.eyeOf = new Uint8Array(accSource.length);
      // eyes[0] is the character's left (+x).
      for (let r = 0; r < accSource.length; r++) accessories.eyes.eyeOf[r] = accRest[r * 3] > 0 ? 0 : 1;
    }
  }

  const morphNames = meta.morphs;
  const morphWeights = Object.fromEntries(morphNames.map((name) => [name, 0]));
  const swell = new Float32Array(count);
  let restDirty = true;

  function rebuildRest() {
    rest.set(base);
    for (const name of morphNames) {
      const w = morphWeights[name];
      if (Math.abs(w) < 1e-4) continue;
      const d = arrays["morph_" + name];
      for (let i = 0; i < rest.length; i++) rest[i] += d[i] * w;
    }
    for (let i = 0; i < count; i++) {
      const s = swell[i];
      if (s <= 0) continue;
      rest[i * 3] += restPhysNormals[i * 3] * s; rest[i * 3 + 1] += restPhysNormals[i * 3 + 1] * s; rest[i * 3 + 2] += restPhysNormals[i * 3 + 2] * s;
    }
    restDirty = false;
  }

  function sync() {
    if (restDirty) rebuildRest();
    const u = body.u;
    for (let i = 0; i < current.length; i++) current[i] = rest[i] + u[i];
    computeNormals(current, physNormals);
    for (let r = 0; r < renderCount; r++) {
      const s = source[r] * 3;
      positions[r * 3] = current[s]; positions[r * 3 + 1] = current[s + 1]; positions[r * 3 + 2] = current[s + 2];
      normals[r * 3] = physNormals[s]; normals[r * 3 + 1] = physNormals[s + 1]; normals[r * 3 + 2] = physNormals[s + 2];
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;
    for (const acc of Object.values(accessories)) {
      const pos = acc.geometry.attributes.position.array;
      if (acc.sockets) {
        const offsets = acc.sockets.map((near) => {
          const o = [0, 0, 0];
          for (const i of near) { o[0] += current[i * 3] - base[i * 3]; o[1] += current[i * 3 + 1] - base[i * 3 + 1]; o[2] += current[i * 3 + 2] - base[i * 3 + 2]; }
          // Eyes follow flesh and swelling but not eyelid expressions.
          return o.map((v) => v / Math.max(1, near.length));
        });
        for (let r = 0; r < acc.source.length; r++) {
          const o = offsets[acc.eyeOf[r]];
          pos[r * 3] = acc.rest[r * 3] + o[0] * 0.6; pos[r * 3 + 1] = acc.rest[r * 3 + 1] + o[1] * 0.6; pos[r * 3 + 2] = acc.rest[r * 3 + 2] + o[2] * 0.6;
        }
      } else {
        for (let r = 0; r < acc.source.length; r++) {
          const v = acc.source[r];
          let ox = 0, oy = 0, oz = 0;
          for (let k = 0; k < 3; k++) {
            const i = acc.bindIndex[v * 3 + k] * 3, w = acc.bindWeight[v * 3 + k];
            ox += (current[i] - base[i]) * w; oy += (current[i + 1] - base[i + 1]) * w; oz += (current[i + 2] - base[i + 2]) * w;
          }
          pos[r * 3] = acc.rest[r * 3] + ox; pos[r * 3 + 1] = acc.rest[r * 3 + 1] + oy; pos[r * 3 + 2] = acc.rest[r * 3 + 2] + oz;
        }
      }
      acc.geometry.attributes.position.needsUpdate = true;
    }
  }

  const materials = [material, ...Object.values(accessories).map((a) => a.material)];
  sync();

  return {
    object: group, mesh, body, meta, arrays, base, rest, mobility, headWeight, eyes, eyeMid, marksContext, marks, materials, morphWeights, swell,
    restNormals: restPhysNormals, current,
    setMorph(name, value) {
      if (Math.abs(morphWeights[name] - value) > 1e-4) { morphWeights[name] = value; restDirty = true; }
    },
    swellAt(point, amount, radius) {
      const inv = 1 / (2 * radius * radius);
      for (let i = 0; i < count; i++) {
        const d2 = (base[i * 3] - point[0]) ** 2 + (base[i * 3 + 1] - point[1]) ** 2 + (base[i * 3 + 2] - point[2]) ** 2;
        if (d2 > 9 * radius * radius) continue;
        swell[i] = Math.min(0.012, swell[i] + amount * Math.exp(-d2 * inv) * mobility[i]);
      }
      restDirty = true;
    },
    heal(fraction) {
      let any = false;
      for (let i = 0; i < count; i++) if (swell[i] > 0) { swell[i] = Math.max(0, swell[i] - fraction * 0.012); any = true; }
      if (any) restDirty = true;
      return any;
    },
    clearSwelling() { swell.fill(0); restDirty = true; },
    setHeadMatrix(matrix) { for (const m of materials) m.uniforms.headMatrix.value.copy(matrix); },
    setMarksAmount(value) { material.uniforms.marksAmount.value = value; },
    setView(value) { material.uniforms.debugView.value = value; },
    setPhoto(photo) {
      // photo: { texture, landmarks (468 × [x, y] in 0..1 of the texture), gain: [r, g, b] } or null
      const on = !!photo;
      for (const m of [material, accessories.eyes.material]) {
        m.uniforms.photo.value = photo?.texture ?? null;
        m.uniforms.photoMix.value = on ? 1 : 0;
      }
      material.uniforms.gain.value.set(...(photo?.gain ?? [1, 1, 1]));
      accessories.brows.mesh.visible = !on;
      accessories.lashes.mesh.visible = !on;
      if (!on) return;
      const L = photo.landmarks, tris = arrays.faceTriangles;
      const uvFor = (tri, bary, i, out, o) => {
        const t = tri[i];
        if (t < 0) { out[o] = 0; out[o + 1] = 0; return; }
        const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
        const u = bary[i * 2], v = bary[i * 2 + 1], w = 1 - u - v;
        out[o] = L[a * 2] * u + L[b * 2] * v + L[c * 2] * w;
        out[o + 1] = L[a * 2 + 1] * u + L[b * 2 + 1] * v + L[c * 2 + 1] * w;
      };
      for (let r = 0; r < renderCount; r++) uvFor(arrays.photoTri, arrays.photoBary, source[r], photoUv, r * 2);
      geometry.attributes.photoUv.needsUpdate = true;
      const eyesAcc = accessories.eyes;
      const eyeUv = eyesAcc.geometry.attributes.photoUv;
      for (let r = 0; r < eyesAcc.source.length; r++) uvFor(arrays.eyes_photoTri, arrays.eyes_photoBary, eyesAcc.source[r], eyeUv.array, r * 2);
      eyeUv.needsUpdate = true;
    },
    sync,
    dispose() { group.removeFromParent(); },
  };
}
