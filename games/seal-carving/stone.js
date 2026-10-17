// The seal stone: a polished square column whose sides carry a shallow 薄意 relief, and whose
// top is the inked face that gets carved. Everything is generated here; no image files.
//
// Stone looks are procedural (3D noise in the stone's own space, so the grain runs through
// the corners). Reliefs are drawn as height fields on a canvas, blurred, and turned into
// normal and occlusion maps once, when the stone is built.
import { hash } from "./carve.js";
import { FACE } from "./seals.js";

export const HEIGHT = 2.1;
const MASK = 1024; // groove mask resolution
const LAYER = 512; // draft and powder layers

export const stones = {
  "shoushan-red": {
    name: { zh: "红寿山", en: "Red Shoushan" },
    base: 0x5e170c, light: 0xa8401c, vein: 0x2e0905, crack: 0xe9c3a3, groove: 0xece6de, relief: "lines",
    roughness: 0.2, clearcoat: 0.9, cloud: 0.7, veins: 0.35, fibres: 0.3, cracks: 0.08, glow: 0.16,
    // How it cuts: the spring stretch that breaks a flake, a flake's mean length (face units),
    // and the chance that the next flake hides a hard grain. Shoushan is soft and even.
    carve: { stretch: 0.006, chip: 0.0068, hardSpots: 0.03 },
  },
  // 青田: yellow-green and waxy, a little harder.
  qingtian: {
    name: { zh: "青田", en: "Qingtian" },
    base: 0x7c8a4e, light: 0xc9cf8a, vein: 0x4e5a2c, crack: 0xf0ecc8, groove: 0xf2f0dc, relief: "clouds",
    roughness: 0.28, clearcoat: 0.7, cloud: 0.8, veins: 0.25, fibres: 0.25, cracks: 0.1, glow: 0.28,
    carve: { stretch: 0.0072, chip: 0.006, hardSpots: 0.05 },
  },
  // 鸡血石: pale grey ground with streaks of blood red; brittle.
  "chicken-blood": {
    name: { zh: "鸡血石", en: "Chicken-blood stone" },
    base: 0xa9a299, light: 0xdcd6cc, vein: 0xa0121b, crack: 0xf4efe6, groove: 0xf4f0ea, relief: "lines",
    roughness: 0.22, clearcoat: 0.85, cloud: 0.5, veins: 1.0, fibres: 0.15, cracks: 0.05, glow: 0.1,
    carve: { stretch: 0.0058, chip: 0.0078, hardSpots: 0.06 },
  },
  // 芙蓉石: milky white with a blush of pink; soft.
  furong: {
    name: { zh: "芙蓉石", en: "Furong stone" },
    base: 0xd9c3b9, light: 0xf6ece6, vein: 0xc48a86, crack: 0xffffff, groove: 0xfaf6f2, relief: "clouds",
    roughness: 0.3, clearcoat: 0.6, cloud: 0.9, veins: 0.3, fibres: 0.2, cracks: 0.05, glow: 0.3,
    carve: { stretch: 0.0052, chip: 0.0072, hardSpots: 0.02 },
  },
  // 田黄: warm gold, the most prized; dense and even.
  tianhuang: {
    name: { zh: "田黄", en: "Tianhuang" },
    base: 0xa86a1c, light: 0xe3b25a, vein: 0x6a3c0c, crack: 0xf6dfae, groove: 0xf6ead4, relief: "lines",
    roughness: 0.22, clearcoat: 0.9, cloud: 0.75, veins: 0.2, fibres: 0.45, cracks: 0.1, glow: 0.3,
    carve: { stretch: 0.0064, chip: 0.0064, hardSpots: 0.02 },
  },
  // 墨玉: near black with a faint green depth; the hardest here.
  "black-jade": {
    name: { zh: "墨玉", en: "Black jade" },
    base: 0x1b1d1a, light: 0x3d463c, vein: 0x0a0b0a, crack: 0x8a9488, groove: 0xd9dcd6, relief: "clouds",
    roughness: 0.18, clearcoat: 1.0, cloud: 0.6, veins: 0.3, fibres: 0.1, cracks: 0.15, glow: 0.05,
    carve: { stretch: 0.0082, chip: 0.0056, hardSpots: 0.08 },
  },
};

// Value noise and fBm in TSL, compiled as shader functions (one copy per material).
function noiseNodes(THREE) {
  const { Fn, vec3, mix, floor, fract } = THREE.TSL;
  const stoneHash = Fn(([x]) => {
    const p = fract(x.mul(0.3183099).add(0.1)).mul(17.0).toVar();
    return fract(p.x.mul(p.y).mul(p.z).mul(p.x.add(p.y).add(p.z)));
  }).setLayout({ name: "stoneHash", type: "float", inputs: [{ name: "x", type: "vec3" }] });
  const stoneNoise = Fn(([x]) => {
    const i = floor(x).toVar();
    const f = fract(x).toVar();
    f.assign(f.mul(f).mul(f.mul(-2.0).add(3.0)));
    const h = (dx, dy, dz) => stoneHash(i.add(vec3(dx, dy, dz)));
    return mix(mix(mix(h(0, 0, 0), h(1, 0, 0), f.x), mix(h(0, 1, 0), h(1, 1, 0), f.x), f.y),
      mix(mix(h(0, 0, 1), h(1, 0, 1), f.x), mix(h(0, 1, 1), h(1, 1, 1), f.x), f.y), f.z);
  }).setLayout({ name: "stoneNoise", type: "float", inputs: [{ name: "x", type: "vec3" }] });
  const stoneFbm = Fn(([x]) => {
    const p = vec3(x).toVar();
    const v = THREE.TSL.float(0).toVar();
    for (const a of [0.5, 0.25, 0.125, 0.0625]) {
      v.addAssign(stoneNoise(p).mul(a));
      p.assign(p.mul(2.03).add(17.1));
    }
    return v;
  }).setLayout({ name: "stoneFbm", type: "float", inputs: [{ name: "x", type: "vec3" }] });
  return { stoneHash, stoneNoise, stoneFbm };
}

// Box blur of a Float32Array height field, in place, `passes` times (≈ Gaussian).
function blur(field, width, height, radius, passes = 3) {
  const temp = new Float32Array(field.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      const row = y * width;
      for (let x = -radius; x <= radius; x++) sum += field[row + Math.min(width - 1, Math.max(0, x))];
      for (let x = 0; x < width; x++) {
        temp[row + x] = sum / (2 * radius + 1);
        sum += field[row + Math.min(width - 1, x + radius + 1)] - field[row + Math.max(0, x - radius)];
      }
    }
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let y = -radius; y <= radius; y++) sum += temp[Math.min(height - 1, Math.max(0, y)) * width + x];
      for (let y = 0; y < height; y++) {
        field[y * width + x] = sum / (2 * radius + 1);
        sum += temp[Math.min(height - 1, y + radius + 1) * width + x] - temp[Math.max(0, y - radius) * width + x];
      }
    }
  }
}

// 祥云: clusters of round lobes with a curling spiral in each, trailing a ribbon tail.
// Drawn as heights: lobes are raised, the spiral lines are cut back into them.
function drawClouds(g, width, height, seed) {
  const random = (() => { let i = 0; return () => hash(seed, i++); })();
  // Carving marks in the recessed field: short parallel scratches.
  g.strokeStyle = "rgba(90,90,90,0.5)";
  g.lineWidth = 1;
  for (let i = 0; i < 260; i++) {
    const x = random() * width, y = random() * height, a = -0.4 + random() * 0.3, l = 4 + random() * 10;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  const clouds = [];
  for (let attempt = 0; attempt < 200 && clouds.length < 16; attempt++) {
    const r = width * (0.07 + 0.09 * random());
    const x = width * (0.04 + 0.92 * random()), y = height * (0.04 + 0.8 * random());
    if (clouds.some((c) => Math.hypot(c.x - x, c.y - y) < (c.r + r) * 0.95)) continue;
    clouds.push({ x, y, r, flip: random() < 0.5 ? -1 : 1 });
  }
  // Larger clouds sit in front: draw small ones first.
  clouds.sort((a, b) => a.r - b.r);
  for (const cloud of clouds) {
    const { x, y, r, flip } = cloud;
    const lobes = [[0, 0, 1], [flip * 0.95, 0.25, 0.72], [-flip * 0.88, 0.32, 0.64], [flip * 0.25, -0.78, 0.58], [-flip * 0.5, -0.55, 0.45]];
    // The tail: a tapering ribbon sweeping away from the cluster, with a groove along it.
    const tx = x - flip * r * 0.4, ty = y + r * 0.7;
    const tail = new Path2D();
    tail.moveTo(tx, ty - r * 0.25);
    tail.bezierCurveTo(tx - flip * r * 1.2, ty - r * 0.1, tx - flip * r * 1.8, ty + r * 0.6, tx - flip * r * 2.8, ty + r * 0.25);
    tail.bezierCurveTo(tx - flip * r * 1.8, ty + r * 0.85, tx - flip * r * 1.0, ty + r * 0.45, tx, ty + r * 0.3);
    g.fillStyle = "rgb(40,40,40)";
    g.lineWidth = r * 0.12;
    g.strokeStyle = "rgb(40,40,40)";
    g.stroke(tail);
    g.fillStyle = "rgb(200,200,200)";
    g.fill(tail);
    g.strokeStyle = "rgb(120,120,120)";
    g.lineWidth = Math.max(1.5, r * 0.04);
    g.beginPath();
    g.moveTo(tx - flip * r * 0.2, ty + r * 0.05);
    g.bezierCurveTo(tx - flip * r * 1.1, ty + r * 0.15, tx - flip * r * 1.7, ty + r * 0.55, tx - flip * r * 2.4, ty + r * 0.35);
    g.stroke();
    for (const [dx, dy, s] of lobes) {
      const cx = x + dx * r, cy = y + dy * r, lr = r * s * 0.62;
      // A dark rim first, so every lobe stands out from what is behind it.
      g.fillStyle = "rgb(30,30,30)";
      g.beginPath(); g.arc(cx, cy, lr * 1.12, 0, Math.PI * 2); g.fill();
      const gradient = g.createRadialGradient(cx - lr * 0.3, cy - lr * 0.3, lr * 0.1, cx, cy, lr);
      gradient.addColorStop(0, "rgb(235,235,235)");
      gradient.addColorStop(1, "rgb(175,175,175)");
      g.fillStyle = gradient;
      g.beginPath(); g.arc(cx, cy, lr, 0, Math.PI * 2); g.fill();
      // The curl: an Archimedean spiral cut into the lobe.
      g.strokeStyle = "rgb(60,60,60)";
      g.lineWidth = Math.max(1.5, lr * 0.14);
      g.lineCap = "round";
      g.beginPath();
      const turns = 1.6 + random() * 0.6, start = random() * Math.PI * 2;
      for (let i = 0; i <= 70; i++) {
        const t = i / 70, angle = start + flip * t * turns * Math.PI * 2, radius = lr * (0.1 + 0.74 * t);
        const px = cx + Math.cos(angle) * radius, py = cy + Math.sin(angle) * radius;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
    }
  }
}

// 薄意 as in the video: a shallow picture cut in fine incised lines that flow in bundles, like
// water or wind over hills, with a few hatched patches. Lines are cut into the polished field.
function drawLines(g, width, height, seed) {
  const random = (() => { let i = 0; return () => hash(seed, i++); })();
  g.lineCap = "round";
  const bundles = 7;
  for (let b = 0; b < bundles; b++) {
    const x0 = width * (-0.1 + 1.0 * random()), y0 = height * (0.08 + 0.75 * random());
    const span = width * (0.5 + 0.6 * random()), rise = height * (random() - 0.5) * 0.25, bow = height * (0.04 + 0.1 * random());
    const lines = 3 + Math.floor(random() * 5);
    for (let l = 0; l < lines; l++) {
      const offset = l * (4 + random() * 3), fade = 1 - l / (lines + 1);
      g.strokeStyle = `rgb(${Math.round(40 + 30 * (1 - fade))},${Math.round(40 + 30 * (1 - fade))},${Math.round(40 + 30 * (1 - fade))})`;
      g.lineWidth = 1.2 + random() * 1.2;
      g.beginPath();
      g.moveTo(x0 + offset * 0.5, y0 + offset);
      g.bezierCurveTo(x0 + span * 0.3, y0 + offset - bow, x0 + span * 0.65, y0 + rise + offset + bow, x0 + span, y0 + rise + offset * 0.6);
      g.stroke();
    }
  }
  // Hatched patches (tree or grass texture).
  for (let p = 0; p < 4; p++) {
    const cx = width * random(), cy = height * (0.1 + 0.7 * random()), r = width * (0.05 + 0.06 * random());
    g.strokeStyle = "rgb(60,60,60)";
    g.lineWidth = 1;
    for (let i = 0; i < 14; i++) {
      const a = random() * Math.PI * 2, d = r * Math.sqrt(random());
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + 3 + random() * 4, y - 2 - random() * 5); g.stroke();
    }
  }
}

// Builds a relief's normal map (RGB) and occlusion (in the alpha channel) as one DataTexture.
function reliefTexture(THREE, kind, seed, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "rgb(100,100,100)";
  g.fillRect(0, 0, width, height);
  if (kind === "clouds") drawClouds(g, width, height, seed);
  if (kind === "lines") { g.fillStyle = "rgb(150,150,150)"; g.fillRect(0, 0, width, height); drawLines(g, width, height, seed); }
  const pixels = g.getImageData(0, 0, width, height).data;
  const field = new Float32Array(width * height);
  for (let i = 0; i < field.length; i++) field[i] = pixels[i * 4] / 255;
  const sharp = field.slice();
  blur(field, width, height, 2, 2);
  // Carved edges stay crisp: mostly the lightly blurred field, a touch of the raw one.
  for (let i = 0; i < field.length; i++) field[i] = field[i] * 0.85 + sharp[i] * 0.15;
  const wide = field.slice();
  blur(wide, width, height, 9, 3);
  const data = new Uint8Array(width * height * 4);
  const strength = 12;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    const left = field[y * width + Math.max(0, x - 1)], right = field[y * width + Math.min(width - 1, x + 1)];
    const up = field[Math.max(0, y - 1) * width + x], down = field[Math.min(height - 1, y + 1) * width + x];
    // The rows above (smaller y) are higher up the side, at larger v.
    let nx = (left - right) * strength, ny = (down - up) * strength, nz = 1;
    const length = Math.hypot(nx, ny, nz);
    nx /= length; ny /= length; nz /= length;
    // Occlusion: recesses (below their surroundings) darken, like the grime in a real carving.
    const cavity = Math.max(0, wide[i] - field[i]);
    const occlusion = Math.max(0, 1 - cavity * 6 - (0.45 - Math.min(0.45, field[i])) * 1.2);
    // Rows are written bottom-up: texture v runs up the side.
    data.set([(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255, occlusion * 255], ((height - 1 - y) * width + x) * 4);
  }
  const texture = new THREE.DataTexture(data, width, height);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

export function createStone({ THREE, track, look, seed, anisotropy = 4 }) {
  const group = new THREE.Group();
  const color = (hex) => new THREE.Color(hex);

  // Sides. The box's four side faces are each 1 × HEIGHT; two carry reliefs.
  const { vec2, vec3, float, mix, smoothstep, step, fwidth, floor, abs, exp, min, distance, select, normalize, uniform, uv, texture, positionGeometry, normalView, transformNormalToView, materialColor, materialEmissive } = THREE.TSL;
  const { stoneHash, stoneNoise, stoneFbm } = noiseNodes(THREE);
  const uniforms = {
    stoneBase: uniform(color(look.base)), stoneLight: uniform(color(look.light)), stoneVein: uniform(color(look.vein)),
    stoneMix: uniform(new THREE.Vector3(look.cloud, look.veins, look.fibres)),
    stoneCrack: uniform(color(look.crack)), stoneCracks: uniform(look.cracks), stoneGlow: uniform(look.glow),
    stoneSeed: uniform((seed % 97) * 3.17),
  };
  const sp = positionGeometry.add(uniforms.stoneSeed);
  // Translucent clouds drift through the body; thin dark veins cross it; fine fibres (萝卜纹) run along it.
  const cloudField = stoneFbm(sp.mul(vec3(1.4, 0.9, 1.4)));
  const cloud = smoothstep(0.35, 0.8, cloudField);
  const warp = stoneFbm(sp.mul(2.2).add(3.0));
  const vein = float(1.0).sub(smoothstep(0.0, 0.035, abs(stoneFbm(sp.mul(vec3(1.6, 0.7, 1.6)).add(warp.mul(0.8))).sub(0.5))));
  const fibre = mix(stoneNoise(vec3(sp.x.mul(9.0), sp.y.mul(70.0).add(warp.mul(6.0)), sp.z.mul(9.0))), 0.5, smoothstep(0.4, 0.9, fwidth(sp.y.mul(70.0))));
  const { stoneMix } = uniforms;
  let stone = mix(uniforms.stoneBase, uniforms.stoneLight, cloud.mul(stoneMix.x));
  stone = stone.mul(fibre.sub(0.5).mul(stoneMix.z).mul(2.0).mul(0.16).add(0.92));
  stone = mix(stone, uniforms.stoneVein, vein.mul(stoneMix.y).mul(0.7));
  // 格纹: pale healed cracks, thin and broken, like the white seams of real Shoushan.
  const crackField = stoneFbm(sp.mul(vec3(2.4, 1.2, 2.4)).add(40.0));
  const crack = float(1.0).sub(smoothstep(0.0, 0.012, abs(crackField.sub(0.52)))).mul(smoothstep(0.45, 0.7, stoneNoise(sp.mul(3.0).add(9.0))));
  stone = mix(stone, uniforms.stoneCrack, crack.mul(uniforms.stoneCracks));
  // Sand specks (砂丁): rare tiny bright points.
  const speck = step(0.996, stoneHash(floor(sp.mul(160.0))));
  stone = mix(stone, uniforms.stoneCrack, speck.mul(0.3).mul(float(1.0).sub(smoothstep(0.3, 1.0, fwidth(sp.y.mul(160.0))))));
  // The stone's 冻: light seems to come from inside the clearer patches.
  const stoneGlow = uniforms.stoneLight.mul(uniforms.stoneGlow).mul(smoothstep(0.4, 0.85, cloudField));
  function sideMaterial(relief) {
    const material = track(new THREE.MeshPhysicalNodeMaterial({ color: 0xffffff, roughness: look.roughness, clearcoat: look.clearcoat, clearcoatRoughness: 0.25, envMapIntensity: 0.7 }));
    material.colorNode = materialColor.mul(stone);
    if (relief) {
      material.normalMap = relief;
      // The relief's occlusion rides in the normal map's alpha.
      material.colorNode = material.colorNode.mul(mix(0.22, 1.0, texture(relief).a));
    }
    material.emissiveNode = materialEmissive.add(stoneGlow);
    return material;
  }
  const reliefA = look.relief ? track(reliefTexture(THREE, look.relief, seed, 320, 672)) : null;
  const reliefB = look.relief ? track(reliefTexture(THREE, look.relief, seed + 1, 320, 672)) : null;
  for (const texture of [reliefA, reliefB]) if (texture) texture.anisotropy = anisotropy;
  const plain = sideMaterial(null);
  const bottom = track(new THREE.MeshStandardMaterial({ color: look.base, roughness: 0.8 }));
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z. The top is covered by the face plane.
  const sides = [sideMaterial(reliefB), plain, plain, bottom, sideMaterial(reliefA), plain];
  const body = new THREE.Mesh(track(new THREE.BoxGeometry(1, HEIGHT, 1)), sides);
  body.position.y = -HEIGHT / 2;
  body.castShadow = body.receiveShadow = true;
  group.add(body);

  // The face: groove mask (R), draft and highlight (R, G of the layer), powder (alpha).
  const maskCanvas = new OffscreenCanvas(MASK, MASK);
  const mask = maskCanvas.getContext("2d");
  const draftCanvas = new OffscreenCanvas(LAYER, LAYER);
  const draft = draftCanvas.getContext("2d");
  const dustCanvas = new OffscreenCanvas(LAYER, LAYER);
  const dust = dustCanvas.getContext("2d");
  const canvasTexture = (canvas) => {
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.anisotropy = anisotropy;
    texture.colorSpace = THREE.NoColorSpace;
    return texture;
  };
  const maskTexture = canvasTexture(maskCanvas);
  const draftTexture = canvasTexture(draftCanvas);
  const dustTexture = canvasTexture(dustCanvas);
  const faceUniforms = {
    carveTexel: uniform(1 / MASK),
    inkColor: uniform(color(0x1a1817)), grooveColor: uniform(color(look.groove)), bevelColor: uniform(color(look.light).lerp(color(look.groove), 0.82)),
    draftColor: uniform(color(0xe8503c)), highlightColor: uniform(color(0xffd43b)),
    bevelWidth: uniform(FACE.bevel),
    highlightPulse: uniform(1),
    // The knife's tip on the face (uv) and how fresh the cut there is: newly opened stone is
    // bright and clean; older groove is dulled by its powder.
    fresh: uniform(new THREE.Vector3(0.5, 0.5, 0)),
  };
  const faceUv = uv();
  const faceCut = (offset) => texture(maskTexture, faceUv.add(vec2(...offset).mul(faceUniforms.carveTexel))).r;
  // A soft U-shaped profile: the cut mask averaged over a small disc.
  const faceDepth = ([x, y]) => faceCut([x, y]).mul(2.0).add(faceCut([x + 2, y])).add(faceCut([x - 2, y])).add(faceCut([x, y + 2])).add(faceCut([x, y - 2])).div(6.0);
  const faceEdge = min(min(faceUv.x, faceUv.x.oneMinus()), min(faceUv.y, faceUv.y.oneMinus()));
  const cut = faceCut([0, 0]);
  const depth = faceDepth([0, 0]);
  const layer = texture(draftTexture, faceUv);
  const powder = texture(dustTexture, faceUv).a;
  const faceSeed = uniforms.stoneSeed;
  // Ink: nearly black, with faint brush streaks that catch the light differently.
  const streak = stoneNoise(vec3(faceUv.x.mul(3.0), faceUv.y.mul(24.0), faceSeed));
  // Fine sanding scratches running across the face, as in the video, over a grey-black ink.
  const scratches = smoothstep(0.55, 0.95, stoneNoise(vec3(faceUv.x.mul(3.0).add(stoneNoise(vec3(faceUv.mul(4.0), 1.0)).mul(0.6)), faceUv.y.mul(420.0), faceSeed.add(3.0))))
    .mul(float(1.0).sub(smoothstep(0.3, 1.0, fwidth(faceUv.y.mul(420.0)))));
  const ink = faceUniforms.inkColor.mul(streak.mul(0.14).add(0.92)).add(vec3(0.03).mul(scratches).mul(step(0.6, stoneNoise(vec3(faceUv.mul(12.0), faceSeed.add(7.0))))));
  // Inside a groove the stone powder is pale; it is darker toward the walls.
  const grain = stoneNoise(vec3(faceUv.mul(700.0), faceSeed));
  const freshness = faceUniforms.fresh.z.mul(exp(distance(faceUv, faceUniforms.fresh.xy).div(0.035).negate()));
  const groove = faceUniforms.grooveColor.mul(smoothstep(0.3, 0.95, depth).mul(0.4).add(0.48).add(grain.mul(0.12)))
    .add(vec3(0.25).mul(step(0.985, grain))) // glints of cut crystal
    .mul(freshness.mul(0.25).add(0.9));
  const inBevel = faceEdge.lessThan(faceUniforms.bevelWidth);
  const cutColor = select(inBevel, faceUniforms.bevelColor.mul(grain.mul(0.15).add(0.78)), groove);
  const onInk = cut.oneMinus();
  let faceColor = mix(ink, cutColor, cut);
  faceColor = mix(faceColor, faceUniforms.draftColor, layer.r.mul(onInk).mul(0.85));
  faceColor = mix(faceColor, faceUniforms.highlightColor, layer.g.mul(onInk).mul(faceUniforms.highlightPulse));
  faceColor = mix(faceColor, faceUniforms.grooveColor.mul(grain.mul(0.25).add(0.85)), min(1.0, powder.mul(1.1)));
  // Grooves go down: the gradient tilts the normal toward the walls' open side.
  const faceT = normalize(transformNormalToView(vec3(1.0, 0.0, 0.0)));
  const faceB = normalize(transformNormalToView(vec3(0.0, 1.0, 0.0)));
  const dx = faceDepth([1.5, 0]).sub(faceDepth([-1.5, 0]));
  const dy = faceDepth([0, 1.5]).sub(faceDepth([0, -1.5]));
  const bent = normalView.add(faceT.mul(dx).add(faceB.mul(dy)).mul(1.6));
  // The chamfer leans outward, toward the nearest edge.
  const outward = select(faceEdge.equal(faceUv.x), vec2(-1.0, 0.0), select(faceEdge.equal(faceUv.x.oneMinus()), vec2(1.0, 0.0),
    select(faceEdge.equal(faceUv.y), vec2(0.0, -1.0), vec2(0.0, 1.0))));
  const chamfer = normalView.add(faceT.mul(outward.x).add(faceB.mul(outward.y)).mul(0.9));
  const faceMaterial = track(new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.4, envMapIntensity: 0.8 }));
  faceMaterial.colorNode = materialColor.mul(faceColor);
  faceMaterial.roughnessNode = mix(0.34, 0.92, cut.max(powder));
  faceMaterial.normalNode = normalize(select(inBevel.and(cut.greaterThan(0.5)), chamfer, bent));
  const face = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1)), faceMaterial);
  face.rotation.x = -Math.PI / 2;
  face.position.y = 0.0005;
  face.receiveShadow = true;
  group.add(face);

  return {
    group, face, body,
    mask, maskSize: MASK, draft, dust, layerSize: LAYER,
    uniforms: faceUniforms,
    refresh({ mask: maskChanged, draft: draftChanged, dust: dustChanged }) {
      if (maskChanged) maskTexture.needsUpdate = true;
      if (draftChanged) draftTexture.needsUpdate = true;
      if (dustChanged) dustTexture.needsUpdate = true;
    },
  };
}
