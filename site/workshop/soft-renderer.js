// Software renderer (docs/model-editor.md "Without WebGL"). When a browser offers neither
// WebGPU nor WebGL (headless servers, cloud browsers without a GPU), the workshop draws its
// Three.js scene with this instead. It stands in for the renderer the viewport uses (render,
// setSize, setPixelRatio, init, dispose) and draws into a 2D canvas, so picking, orbiting,
// gizmos, observations and `canvas.toDataURL` stay the viewport's own code.
//
// It draws what the viewport puts in a scene, the way the GPU path does: metallic-roughness
// and physical (glass) materials under directional lights with shadow maps, the sky-over-ground
// ambient the GPU path builds as an environment (given here as `environment`), basic and
// shadow materials, lines, points and textured reference planes. Colours add up in linear
// light and the finished frame is tone mapped (ACES Filmic) and encoded to sRGB, as
// WebGPURenderer does through its frame buffer target.

const FRONT = 0,
  BACK = 1,
  DOUBLE = 2;
// Per clip-space vertex: position (4), world position (3), normal (3), uv (2), colour (3).
const STRIDE = 15;

function aces(v) {
  return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
}
const encode = (c) =>
  c <= 0.0031308 ? Math.max(0, c) * 12.92 : 1.055 * Math.pow(Math.min(c, 1), 1 / 2.4) - 0.055;

// Linear RGB (any range) to display bytes: ACES Filmic with the renderer's exposure, sRGB.
export function toneMap(r, g, b, exposure, out, offset) {
  const k = exposure / 0.6;
  r *= k;
  g *= k;
  b *= k;
  const x = aces(0.59719 * r + 0.35458 * g + 0.04823 * b),
    y = aces(0.076 * r + 0.90834 * g + 0.01566 * b),
    z = aces(0.0284 * r + 0.13383 * g + 0.83777 * b);
  out[offset] = Math.round(255 * encode(1.60475 * x - 0.53108 * y - 0.07367 * z));
  out[offset + 1] = Math.round(255 * encode(-0.10208 * x + 1.10813 * y - 0.00605 * z));
  out[offset + 2] = Math.round(255 * encode(-0.00327 * x - 0.07276 * y + 1.07602 * z));
}

export function createRasterizer(THREE) {
  const projScreen = new THREE.Matrix4(),
    mvp = new THREE.Matrix4(),
    normalMatrix = new THREE.Matrix3(),
    frustum = new THREE.Frustum(),
    shadowFrustum = new THREE.Frustum(),
    scratch = new THREE.Vector3(),
    cameraPosition = new THREE.Vector3(),
    cameraDirection = new THREE.Vector3(),
    color = new THREE.Color();
  const textureCache = new WeakMap();
  let buffers = null;

  function texels(texture) {
    let cached = textureCache.get(texture);
    if (cached && cached.version === texture.version) return cached;
    const image = texture.image;
    let data = null,
      width = image?.width ?? 0,
      height = image?.height ?? 0;
    if (image?.data) data = image.data;
    else if (image && typeof document !== "undefined") {
      width = image.naturalWidth || image.width;
      height = image.naturalHeight || image.height;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      data = context.getImageData(0, 0, width, height).data;
    }
    cached = { version: texture.version, width, height, data, srgb: texture.colorSpace === THREE.SRGBColorSpace };
    textureCache.set(texture, cached);
    return cached;
  }
  const decode = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  // Bilinear sample into out[0..3] (linear rgb, alpha); v = 0 at the image's bottom with flipY.
  function sample(texture, u, v, out) {
    const t = texels(texture);
    if (!t.data || !t.width) {
      out[0] = out[1] = out[2] = out[3] = 1;
      return;
    }
    if (texture.matrixAutoUpdate) texture.updateMatrix();
    const m = texture.matrix.elements;
    const tu = m[0] * u + m[3] * v + m[6],
      tv = m[1] * u + m[4] * v + m[7];
    const fu = tu - Math.floor(tu),
      fv = texture.flipY === false ? tv - Math.floor(tv) : 1 - (tv - Math.floor(tv));
    const x = fu * t.width - 0.5,
      y = fv * t.height - 0.5,
      x0 = Math.floor(x),
      y0 = Math.floor(y),
      ax = x - x0,
      ay = y - y0;
    const at = (xi, yi, k) => {
      const xx = Math.min(t.width - 1, Math.max(0, xi)),
        yy = Math.min(t.height - 1, Math.max(0, yi));
      return t.data[(yy * t.width + xx) * 4 + k] / 255;
    };
    for (let k = 0; k < 4; k++) {
      const value =
        (at(x0, y0, k) * (1 - ax) + at(x0 + 1, y0, k) * ax) * (1 - ay) +
        (at(x0, y0 + 1, k) * (1 - ax) + at(x0 + 1, y0 + 1, k) * ax) * ay;
      out[k] = k < 3 && t.srgb ? decode(value) : value;
    }
  }

  // Shading for one material: returns shade(fragment) writing linear rgb and alpha into out.
  function shaderFor(material, scene, lights, environment) {
    const base = material.color ?? color.setRGB(1, 1, 1);
    const albedo = [base.r, base.g, base.b];
    const opacity = material.transparent ? material.opacity ?? 1 : 1;
    const map = material.map ?? null;
    const vertexColors = !!material.vertexColors;
    const texel = [1, 1, 1, 1];
    if (material.isShadowMaterial)
      return (f, out) => {
        out[0] = albedo[0];
        out[1] = albedo[1];
        out[2] = albedo[2];
        out[3] = material.opacity * (1 - f.lit(f));
      };
    if (!(material.isMeshStandardMaterial || material.isMeshPhongMaterial || material.isMeshLambertMaterial))
      return (f, out) => {
        let r = albedo[0],
          g = albedo[1],
          b = albedo[2],
          a = opacity;
        if (vertexColors) {
          r *= f.color[0];
          g *= f.color[1];
          b *= f.color[2];
        }
        if (map) {
          sample(map, f.uv[0], f.uv[1], texel);
          r *= texel[0];
          g *= texel[1];
          b *= texel[2];
          a *= texel[3];
        }
        out[0] = r;
        out[1] = g;
        out[2] = b;
        out[3] = a;
      };
    const metal = material.metalness ?? 0,
      rough = Math.min(1, Math.max(0.045, material.roughness ?? 1)),
      alpha = rough * rough,
      a2 = alpha * alpha,
      transmission = material.transmission ?? 0,
      envScale = material.envMapIntensity ?? 1;
    const emissive = material.emissive
      ? [0, 1, 2].map((k) => [material.emissive.r, material.emissive.g, material.emissive.b][k] * (material.emissiveIntensity ?? 1))
      : [0, 0, 0];
    // three.js DFGApprox: the split-sum environment BRDF for this roughness.
    const r0 = rough * -1 + 1,
      r1 = rough * -0.0275 + 0.0425,
      r2 = rough * -0.572 + 1.04,
      r3 = rough * 0.022 - 0.04;
    const top = environment ? [environment.top.r, environment.top.g, environment.top.b] : null,
      bottom = environment ? [environment.bottom.r, environment.bottom.g, environment.bottom.b] : null,
      envRadiance = environment ? (environment.intensity * envScale) / Math.PI : 0;
    // Reflections blur with roughness: a sharp horizon for polished metal, a cosine ramp at 1.
    const blur = Math.max(0.02, alpha);
    return (f, out) => {
      let ar = albedo[0],
        ag = albedo[1],
        ab = albedo[2],
        a = opacity;
      if (vertexColors) {
        ar *= f.color[0];
        ag *= f.color[1];
        ab *= f.color[2];
      }
      if (map) {
        sample(map, f.uv[0], f.uv[1], texel);
        ar *= texel[0];
        ag *= texel[1];
        ab *= texel[2];
        a *= texel[3];
      }
      const dr = ar * (1 - metal),
        dg = ag * (1 - metal),
        db = ab * (1 - metal);
      const sr = 0.04 * (1 - metal) + ar * metal,
        sg = 0.04 * (1 - metal) + ag * metal,
        sb = 0.04 * (1 - metal) + ab * metal;
      const nx = f.normal[0],
        ny = f.normal[1],
        nz = f.normal[2],
        vx = f.view[0],
        vy = f.view[1],
        vz = f.view[2];
      const nv = Math.max(1e-4, nx * vx + ny * vy + nz * vz);
      let diffR = 0,
        diffG = 0,
        diffB = 0,
        specR = 0,
        specG = 0,
        specB = 0;
      for (const light of lights) {
        if (light.type === "directional") {
          const lx = light.direction[0],
            ly = light.direction[1],
            lz = light.direction[2];
          const nl = nx * lx + ny * ly + nz * lz;
          if (nl <= 0) continue;
          const shadow = light.shadow && f.receive ? light.shadow(f.world, f.normal) : 1;
          if (shadow <= 0) continue;
          const ir = light.color[0] * nl * shadow,
            ig = light.color[1] * nl * shadow,
            ib = light.color[2] * nl * shadow;
          diffR += (ir * dr) / Math.PI;
          diffG += (ig * dg) / Math.PI;
          diffB += (ib * db) / Math.PI;
          let hx = lx + vx,
            hy = ly + vy,
            hz = lz + vz;
          const hl = Math.hypot(hx, hy, hz) || 1;
          hx /= hl;
          hy /= hl;
          hz /= hl;
          const nh = Math.max(0, nx * hx + ny * hy + nz * hz),
            vh = Math.max(0, vx * hx + vy * hy + vz * hz);
          const dd = nh * nh * (a2 - 1) + 1,
            D = a2 / (Math.PI * dd * dd),
            V = 0.5 / (nl * Math.sqrt(a2 + (1 - a2) * nv * nv) + nv * Math.sqrt(a2 + (1 - a2) * nl * nl)),
            fw = Math.pow(1 - vh, 5),
            dv = D * V;
          specR += ir * (sr + (1 - sr) * fw) * dv;
          specG += ig * (sg + (1 - sg) * fw) * dv;
          specB += ib * (sb + (1 - sb) * fw) * dv;
        } else if (light.type === "ambient") {
          diffR += (light.color[0] * dr) / Math.PI;
          diffG += (light.color[1] * dg) / Math.PI;
          diffB += (light.color[2] * db) / Math.PI;
        } else if (light.type === "hemisphere") {
          const w = 0.5 * ny + 0.5;
          diffR += ((light.ground[0] + (light.sky[0] - light.ground[0]) * w) * dr) / Math.PI;
          diffG += ((light.ground[1] + (light.sky[1] - light.ground[1]) * w) * dg) / Math.PI;
          diffB += ((light.ground[2] + (light.sky[2] - light.ground[2]) * w) * db) / Math.PI;
        }
      }
      if (environment) {
        // Diffuse: the cosine-weighted share of sky above the surface.
        const w = 0.5 + 0.5 * ny;
        diffR += dr * envRadiance * (bottom[0] + (top[0] - bottom[0]) * w);
        diffG += dg * envRadiance * (bottom[1] + (top[1] - bottom[1]) * w);
        diffB += db * envRadiance * (bottom[2] + (top[2] - bottom[2]) * w);
        // Specular: the reflected direction, bent towards the normal as roughness grows.
        const d = 2 * nv;
        let ry = d * ny - vy;
        ry = ry + (ny - ry) * alpha;
        const s = Math.min(1, Math.max(0, 0.5 + (0.5 * ry) / blur));
        const a004 = Math.min(r0 * r0, Math.pow(2, -9.28 * nv)) * r0 + r1,
          fa = -1.04 * a004 + r2,
          fb = 1.04 * a004 + r3;
        specR += (sr * fa + fb) * envRadiance * (bottom[0] + (top[0] - bottom[0]) * s);
        specG += (sg * fa + fb) * envRadiance * (bottom[1] + (top[1] - bottom[1]) * s);
        specB += (sb * fa + fb) * envRadiance * (bottom[2] + (top[2] - bottom[2]) * s);
      }
      if (transmission > 0) {
        // Glass: the diffuse part gives way to light from behind, tinted by the base colour.
        const fresnel = 0.04 + 0.96 * Math.pow(1 - nv, 5);
        const t = transmission * (1 - fresnel);
        out[0] = specR + emissive[0] + diffR * (1 - transmission);
        out[1] = specG + emissive[1] + diffG * (1 - transmission);
        out[2] = specB + emissive[2] + diffB * (1 - transmission);
        out[3] = a;
        out[4] = t * ar;
        out[5] = t * ag;
        out[6] = t * ab;
        return;
      }
      out[0] = diffR + specR + emissive[0];
      out[1] = diffG + specG + emissive[1];
      out[2] = diffB + specB + emissive[2];
      out[3] = a;
    };
  }

  // Directional shadow map: depth from the light, back faces of one-sided materials as
  // three.js draws them, read back with a 3×3 percentage-closer filter.
  function shadowMap(light, casters) {
    const shadow = light.shadow,
      size = Math.min(2048, shadow.mapSize.x);
    shadow.updateMatrices(light);
    const camera = shadow.camera;
    if (camera.coordinateSystem !== THREE.WebGLCoordinateSystem) {
      camera.coordinateSystem = THREE.WebGLCoordinateSystem;
      camera.updateProjectionMatrix();
    }
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    shadowFrustum.setFromProjectionMatrix(vp);
    const depth = new Float32Array(size * size).fill(1);
    const target = { width: size, height: size, depth, color: null, ss: 1 };
    for (const object of casters) {
      if (object.frustumCulled && !shadowFrustum.intersectsObject(object)) continue;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const geometry = object.geometry;
      const vertices = transform(object, vp, false);
      for (const [start, end, material] of ranges(geometry, materials, object.material)) {
        if (!material || material.visible === false || material.isShadowMaterial) continue;
        const side = material.shadowSide ?? (material.side === DOUBLE ? DOUBLE : material.side === BACK ? FRONT : BACK);
        drawTriangles(object, geometry, vertices, start, end, { target, side, depthOnly: true, flip: object.matrixWorld.determinant() < 0 });
      }
    }
    const bias = shadow.bias ?? 0,
      normalBias = shadow.normalBias ?? 0;
    const e = vp.elements;
    return (p, n) => {
      const x = p[0] + n[0] * normalBias,
        y = p[1] + n[1] * normalBias,
        z = p[2] + n[2] * normalBias;
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      const u = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw) * 0.5 + 0.5,
        v = ((e[1] * x + e[5] * y + e[9] * z + e[13]) / cw) * 0.5 + 0.5,
        d = ((e[2] * x + e[6] * y + e[10] * z + e[14]) / cw) * 0.5 + 0.5 + bias;
      if (u < 0 || u > 1 || v < 0 || v > 1 || d > 1) return 1;
      const cx = Math.floor(u * size),
        cy = Math.floor((1 - v) * size);
      let lit = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const sx = Math.min(size - 1, Math.max(0, cx + dx)),
            sy = Math.min(size - 1, Math.max(0, cy + dy));
          if (d <= depth[sy * size + sx]) lit++;
        }
      return lit / 9;
    };
  }

  // Draw ranges of a geometry: [start, end, material] in index (or vertex) units.
  function ranges(geometry, materials, material) {
    const total = geometry.index ? geometry.index.count : geometry.attributes.position.count;
    const drawStart = Math.max(0, geometry.drawRange.start),
      drawEnd = Math.min(total, drawStart + (Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.count : total));
    if (Array.isArray(material)) {
      const list = geometry.groups.length ? geometry.groups : [{ start: 0, count: total, materialIndex: 0 }];
      return list
        .map((g) => [Math.max(g.start, drawStart), Math.min(g.start + g.count, drawEnd), materials[g.materialIndex]])
        .filter(([s, e]) => e > s);
    }
    return [[drawStart, drawEnd, material]];
  }

  const attribute = (attr, i, k) =>
    attr.isInterleavedBufferAttribute || attr.normalized
      ? [attr.getX(i), attr.getY(i), attr.getZ(i), attr.getW?.(i)][k]
      : attr.array[i * attr.itemSize + k];

  // Clip-space vertices with world positions, world normals, uvs and colours.
  function transform(object, viewProjection, withAttributes = true) {
    const geometry = object.geometry,
      position = geometry.attributes.position,
      normal = withAttributes ? geometry.attributes.normal : null,
      uv = withAttributes ? geometry.attributes.uv : null,
      colors = withAttributes ? geometry.attributes.color : null,
      count = position.count;
    const out = new Float64Array(count * STRIDE);
    mvp.multiplyMatrices(viewProjection, object.matrixWorld);
    const m = mvp.elements,
      w = object.matrixWorld.elements;
    if (normal) normalMatrix.getNormalMatrix(object.matrixWorld);
    const nm = normalMatrix.elements;
    for (let i = 0; i < count; i++) {
      const x = attribute(position, i, 0),
        y = attribute(position, i, 1),
        z = position.itemSize > 2 ? attribute(position, i, 2) : 0,
        o = i * STRIDE;
      out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      out[o + 3] = m[3] * x + m[7] * y + m[11] * z + m[15];
      out[o + 4] = w[0] * x + w[4] * y + w[8] * z + w[12];
      out[o + 5] = w[1] * x + w[5] * y + w[9] * z + w[13];
      out[o + 6] = w[2] * x + w[6] * y + w[10] * z + w[14];
      if (normal) {
        const a = attribute(normal, i, 0),
          b = attribute(normal, i, 1),
          c = attribute(normal, i, 2);
        let nx = nm[0] * a + nm[3] * b + nm[6] * c,
          ny = nm[1] * a + nm[4] * b + nm[7] * c,
          nz = nm[2] * a + nm[5] * b + nm[8] * c;
        const l = Math.hypot(nx, ny, nz) || 1;
        out[o + 7] = nx / l;
        out[o + 8] = ny / l;
        out[o + 9] = nz / l;
      }
      if (uv) {
        out[o + 10] = attribute(uv, i, 0);
        out[o + 11] = attribute(uv, i, 1);
      }
      if (colors) {
        out[o + 12] = attribute(colors, i, 0);
        out[o + 13] = attribute(colors, i, 1);
        out[o + 14] = attribute(colors, i, 2);
      } else out[o + 12] = out[o + 13] = out[o + 14] = 1;
    }
    out.hasNormals = !!normal;
    return out;
  }

  // Polygon (array of STRIDE-long vertex arrays) clipped against the near plane z = -w.
  function clipNear(polygon) {
    const result = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length];
      const da = a[2] + a[3],
        db = b[2] + b[3];
      if (da >= 0) result.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db),
          v = new Float64Array(STRIDE);
        for (let k = 0; k < STRIDE; k++) v[k] = a[k] + (b[k] - a[k]) * t;
        result.push(v);
      }
    }
    return result;
  }

  const fragment = {
    world: [0, 0, 0],
    normal: [0, 0, 1],
    view: [0, 0, 1],
    uv: [0, 0],
    color: [1, 1, 1],
    receive: false,
    lit: null,
  };
  const shaded = new Float64Array(7);

  // Rasterises triangles [start, end) of a mesh draw. state: { target, side, depthOnly, flip,
  // shade, blend, depthTest, depthWrite, bias, receive, perspective }.
  function drawTriangles(object, geometry, vertices, start, end, state) {
    const index = geometry.index;
    const read = (i) => (index ? index.getX(i) : i);
    const polygon = [null, null, null];
    for (let i = start; i + 2 < end; i += 3) {
      const ia = read(i),
        ib = read(i + 1),
        ic = read(i + 2);
      const a = vertices.subarray(ia * STRIDE, ia * STRIDE + STRIDE),
        b = vertices.subarray(ib * STRIDE, ib * STRIDE + STRIDE),
        c = vertices.subarray(ic * STRIDE, ic * STRIDE + STRIDE);
      // Entirely outside one side of the view volume.
      if (
        (a[0] > a[3] && b[0] > b[3] && c[0] > c[3]) ||
        (a[0] < -a[3] && b[0] < -b[3] && c[0] < -c[3]) ||
        (a[1] > a[3] && b[1] > b[3] && c[1] > c[3]) ||
        (a[1] < -a[3] && b[1] < -b[3] && c[1] < -c[3]) ||
        (a[2] < -a[3] && b[2] < -b[3] && c[2] < -c[3])
      )
        continue;
      polygon[0] = a;
      polygon[1] = b;
      polygon[2] = c;
      let face = null;
      if (!state.depthOnly && !vertices.hasNormals) {
        // Flat normal from world positions when the geometry carries none.
        const ux = b[4] - a[4],
          uy = b[5] - a[5],
          uz = b[6] - a[6],
          vx = c[4] - a[4],
          vy = c[5] - a[5],
          vz = c[6] - a[6];
        let nx = uy * vz - uz * vy,
          ny = uz * vx - ux * vz,
          nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        const s = state.flip ? -1 : 1;
        face = [(s * nx) / l, (s * ny) / l, (s * nz) / l];
      }
      const clipped = a[2] + a[3] < 0 || b[2] + b[3] < 0 || c[2] + c[3] < 0 ? clipNear(polygon) : polygon;
      for (let k = 1; k + 1 < clipped.length; k++) rasterTriangle(clipped[0], clipped[k], clipped[k + 1], state, face);
    }
  }

  function rasterTriangle(A, B, C, state, face) {
    const { target } = state,
      W = target.width,
      H = target.height;
    if (A[3] <= 1e-12 || B[3] <= 1e-12 || C[3] <= 1e-12) return;
    const aw = 1 / A[3],
      bw = 1 / B[3],
      cw = 1 / C[3];
    const ax = (A[0] * aw * 0.5 + 0.5) * W,
      ay = (0.5 - A[1] * aw * 0.5) * H,
      az = A[2] * aw * 0.5 + 0.5,
      bx = (B[0] * bw * 0.5 + 0.5) * W,
      by = (0.5 - B[1] * bw * 0.5) * H,
      bz = B[2] * bw * 0.5 + 0.5,
      cx = (C[0] * cw * 0.5 + 0.5) * W,
      cy = (0.5 - C[1] * cw * 0.5) * H,
      cz = C[2] * cw * 0.5 + 0.5;
    let area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-12) return;
    // Counter-clockwise in normalised device space is clockwise on screen (y down): front.
    let front = area < 0;
    if (state.flip) front = !front;
    if ((state.side === FRONT && !front) || (state.side === BACK && front)) return;
    // Orient the edge functions positive inside.
    let P = A,
      Q = B,
      R = C,
      px = ax,
      py = ay,
      pz = az,
      pw = aw,
      qx = bx,
      qy = by,
      qz = bz,
      qw = bw,
      rx = cx,
      ry = cy,
      rz = cz,
      rw = cw;
    if (area < 0) {
      Q = C;
      R = B;
      qx = cx;
      qy = cy;
      qz = cz;
      qw = cw;
      rx = bx;
      ry = by;
      rz = bz;
      rw = bw;
      area = -area;
    }
    const minX = Math.max(0, Math.ceil(Math.min(px, qx, rx) - 0.5)),
      maxX = Math.min(W - 1, Math.floor(Math.max(px, qx, rx) - 0.5)),
      minY = Math.max(0, Math.ceil(Math.min(py, qy, ry) - 0.5)),
      maxY = Math.min(H - 1, Math.floor(Math.max(py, qy, ry) - 0.5));
    if (minX > maxX || minY > maxY) return;
    // Edge functions E(x, y) = A x + B y + C for edges QR (weight of P), RP (Q) and PQ (R).
    const A0 = qy - ry,
      B0 = rx - qx,
      C0 = qx * ry - qy * rx,
      A1 = ry - py,
      B1 = px - rx,
      C1 = rx * py - ry * px,
      A2 = py - qy,
      B2 = qx - px,
      C2 = px * qy - py * qx;
    // Top-left rule: a pixel centre on a shared edge belongs to one triangle only.
    const own0 = A0 > 0 || (A0 === 0 && B0 > 0),
      own1 = A1 > 0 || (A1 === 0 && B1 > 0),
      own2 = A2 > 0 || (A2 === 0 && B2 > 0);
    const depthBuffer = target.depth,
      colorBuffer = target.color,
      depthTest = state.depthTest !== false,
      depthWrite = state.depthWrite !== false;
    let bias = state.bias ?? 0;
    if (state.slopeBias) {
      // Polygon offset: units plus the depth slope across a pixel.
      const dzdx = Math.abs(((qz - pz) * (ry - py) - (rz - pz) * (qy - py)) / area),
        dzdy = Math.abs(((rz - pz) * (qx - px) - (qz - pz) * (rx - px)) / area);
      bias += state.slopeBias * Math.max(dzdx, dzdy);
    }
    const invArea = 1 / area;
    const shade = state.shade,
      receive = state.receive,
      perspective = state.perspective;
    for (let y = minY; y <= maxY; y++) {
      const sy = y + 0.5;
      let e0 = A0 * (minX + 0.5) + B0 * sy + C0,
        e1 = A1 * (minX + 0.5) + B1 * sy + C1,
        e2 = A2 * (minX + 0.5) + B2 * sy + C2;
      for (let x = minX; x <= maxX; x++, e0 += A0, e1 += A1, e2 += A2) {
        if (e0 < 0 || e1 < 0 || e2 < 0) continue;
        if ((e0 === 0 && !own0) || (e1 === 0 && !own1) || (e2 === 0 && !own2)) continue;
        const l0 = e0 * invArea,
          l1 = e1 * invArea,
          l2 = e2 * invArea;
        const z = l0 * pz + l1 * qz + l2 * rz + bias;
        if (z < 0 || z > 1) continue;
        const pixel = y * W + x;
        if (depthTest && z > depthBuffer[pixel]) continue;
        if (state.depthOnly) {
          depthBuffer[pixel] = z;
          continue;
        }
        // Perspective-correct weights for the attributes.
        let w0 = l0 * pw,
          w1 = l1 * qw,
          w2 = l2 * rw;
        const sum = w0 + w1 + w2;
        w0 /= sum;
        w1 /= sum;
        w2 /= sum;
        const f = fragment;
        f.world[0] = w0 * P[4] + w1 * Q[4] + w2 * R[4];
        f.world[1] = w0 * P[5] + w1 * Q[5] + w2 * R[5];
        f.world[2] = w0 * P[6] + w1 * Q[6] + w2 * R[6];
        let nx, ny, nz;
        if (face) {
          nx = face[0];
          ny = face[1];
          nz = face[2];
        } else {
          nx = w0 * P[7] + w1 * Q[7] + w2 * R[7];
          ny = w0 * P[8] + w1 * Q[8] + w2 * R[8];
          nz = w0 * P[9] + w1 * Q[9] + w2 * R[9];
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l;
          ny /= l;
          nz /= l;
        }
        if (!front) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        f.normal[0] = nx;
        f.normal[1] = ny;
        f.normal[2] = nz;
        if (perspective) {
          let vx = state.eye[0] - f.world[0],
            vy = state.eye[1] - f.world[1],
            vz = state.eye[2] - f.world[2];
          const l = Math.hypot(vx, vy, vz) || 1;
          f.view[0] = vx / l;
          f.view[1] = vy / l;
          f.view[2] = vz / l;
        } else {
          f.view[0] = state.eye[0];
          f.view[1] = state.eye[1];
          f.view[2] = state.eye[2];
        }
        f.uv[0] = w0 * P[10] + w1 * Q[10] + w2 * R[10];
        f.uv[1] = w0 * P[11] + w1 * Q[11] + w2 * R[11];
        f.color[0] = w0 * P[12] + w1 * Q[12] + w2 * R[12];
        f.color[1] = w0 * P[13] + w1 * Q[13] + w2 * R[13];
        f.color[2] = w0 * P[14] + w1 * Q[14] + w2 * R[14];
        f.receive = receive;
        shaded[4] = shaded[5] = shaded[6] = -1;
        shade(f, shaded);
        write(colorBuffer, pixel, state, shaded);
        if (depthWrite) depthBuffer[pixel] = z;
      }
    }
  }

  function write(colorBuffer, pixel, state, s) {
    const o = pixel * 3,
      a = Math.min(1, Math.max(0, s[3]));
    if (s[4] >= 0) {
      // Transmission: what is behind shows through, tinted.
      colorBuffer[o] = colorBuffer[o] * s[4] + s[0];
      colorBuffer[o + 1] = colorBuffer[o + 1] * s[5] + s[1];
      colorBuffer[o + 2] = colorBuffer[o + 2] * s[6] + s[2];
      return;
    }
    if (state.additive) {
      colorBuffer[o] += s[0] * a;
      colorBuffer[o + 1] += s[1] * a;
      colorBuffer[o + 2] += s[2] * a;
    } else if (!state.blend || a >= 1) {
      colorBuffer[o] = s[0];
      colorBuffer[o + 1] = s[1];
      colorBuffer[o + 2] = s[2];
    } else {
      colorBuffer[o] = s[0] * a + colorBuffer[o] * (1 - a);
      colorBuffer[o + 1] = s[1] * a + colorBuffer[o + 1] * (1 - a);
      colorBuffer[o + 2] = s[2] * a + colorBuffer[o + 2] * (1 - a);
    }
  }

  // Lines and points come a little towards the eye so wires on a surface stay visible: a
  // thousandth of the distance in perspective (depth there is 1 − 2·near/distance, all of a
  // scene within a sliver below 1), a fixed step in orthographic views (depth is linear).
  const toward = (z, perspective) => (perspective ? z - (1 - z) * 1e-3 : z - 1e-5);

  // Lines one pixel wide per sample (thicker when supersampled), depth tested.
  function drawLines(object, geometry, vertices, start, end, state) {
    const index = geometry.index,
      read = (i) => (index ? index.getX(i) : i);
    const pairs = [];
    if (object.isLineSegments) for (let i = start; i + 1 < end; i += 2) pairs.push([read(i), read(i + 1)]);
    else {
      for (let i = start; i + 1 < end; i++) pairs.push([read(i), read(i + 1)]);
      if (object.isLineLoop && end - start > 2) pairs.push([read(end - 1), read(start)]);
    }
    const { target } = state,
      W = target.width,
      H = target.height,
      thick = target.ss;
    for (const [ia, ib] of pairs) {
      let a = vertices.subarray(ia * STRIDE, ia * STRIDE + STRIDE),
        b = vertices.subarray(ib * STRIDE, ib * STRIDE + STRIDE);
      const da = a[2] + a[3],
        db = b[2] + b[3];
      if (da < 0 && db < 0) continue;
      if (da < 0 || db < 0) {
        const t = da / (da - db),
          v = new Float64Array(STRIDE);
        for (let k = 0; k < STRIDE; k++) v[k] = a[k] + (b[k] - a[k]) * t;
        if (da < 0) a = v;
        else b = v;
      }
      if (a[3] <= 1e-12 || b[3] <= 1e-12) continue;
      const x0 = (a[0] / a[3] * 0.5 + 0.5) * W,
        y0 = (0.5 - (a[1] / a[3]) * 0.5) * H,
        z0 = (a[2] / a[3]) * 0.5 + 0.5,
        x1 = (b[0] / b[3] * 0.5 + 0.5) * W,
        y1 = (0.5 - (b[1] / b[3]) * 0.5) * H,
        z1 = (b[2] / b[3]) * 0.5 + 0.5;
      // Clip to the screen (Liang–Barsky): lines passing near the eye project very long.
      let t0 = 0,
        t1 = 1;
      const dx = x1 - x0,
        dy = y1 - y0,
        margin = thick + 1;
      for (const [p, q] of [
        [-dx, x0 + margin],
        [dx, W + margin - x0],
        [-dy, y0 + margin],
        [dy, H + margin - y0],
      ]) {
        if (p === 0) {
          if (q < 0) t0 = 2;
          continue;
        }
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
      if (t0 > t1) continue;
      const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * (t1 - t0));
      for (let s = 0; s <= steps; s++) {
        const t = t0 + (steps ? s / steps : 0) * (t1 - t0);
        const px = Math.floor(x0 + dx * t - (thick - 1) / 2),
          py = Math.floor(y0 + dy * t - (thick - 1) / 2),
          z = toward(z0 + (z1 - z0) * t, state.perspective);
        if (z < 0 || z > 1) continue;
        fragment.color[0] = a[12] + (b[12] - a[12]) * t;
        fragment.color[1] = a[13] + (b[13] - a[13]) * t;
        fragment.color[2] = a[14] + (b[14] - a[14]) * t;
        shaded[4] = -1;
        state.shade(fragment, shaded);
        for (let dy = 0; dy < thick; dy++)
          for (let dx = 0; dx < thick; dx++) {
            const x = px + dx,
              y = py + dy;
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const pixel = y * W + x;
            if (state.depthTest !== false && z > target.depth[pixel]) continue;
            write(target.color, pixel, state, shaded);
            if (state.depthWrite !== false) target.depth[pixel] = z;
          }
      }
    }
  }

  function drawPoints(object, geometry, vertices, start, end, material, state) {
    const { target } = state,
      W = target.width,
      H = target.height;
    const index = geometry.index,
      read = (i) => (index ? index.getX(i) : i);
    for (let i = start; i < end; i++) {
      const v = vertices.subarray(read(i) * STRIDE, read(i) * STRIDE + STRIDE);
      if (v[3] <= 1e-12 || v[2] < -v[3]) continue;
      const cx = (v[0] / v[3] * 0.5 + 0.5) * W,
        cy = (0.5 - (v[1] / v[3]) * 0.5) * H,
        z = toward((v[2] / v[3]) * 0.5 + 0.5, state.perspective);
      let size = (material.size ?? 1) * target.ss;
      if (material.sizeAttenuation && state.perspective) size *= (H / 2) / v[3];
      const half = size / 2;
      fragment.color[0] = v[12];
      fragment.color[1] = v[13];
      fragment.color[2] = v[14];
      shaded[4] = -1;
      state.shade(fragment, shaded);
      for (let y = Math.max(0, Math.round(cy - half)); y < Math.min(H, Math.round(cy + half)); y++)
        for (let x = Math.max(0, Math.round(cx - half)); x < Math.min(W, Math.round(cx + half)); x++) {
          const pixel = y * W + x;
          if (state.depthTest !== false && z > target.depth[pixel]) continue;
          write(target.color, pixel, state, shaded);
          if (state.depthWrite !== false) target.depth[pixel] = z;
        }
    }
  }

  /**
   * Draws scene from camera into a linear colour buffer of width × height (ss samples per
   * pixel side). Returns { width, height, color, ss } with color linear rgb per sample.
   */
  function draw(scene, camera, { width, height, ss = 1, environment = null, shadows = true }) {
    const W = Math.max(1, Math.round(width * ss)),
      H = Math.max(1, Math.round(height * ss));
    if (scene.matrixWorldAutoUpdate !== false) scene.updateMatrixWorld();
    if (camera.parent === null && camera.matrixWorldAutoUpdate !== false) camera.updateMatrixWorld();
    if (camera.coordinateSystem !== THREE.WebGLCoordinateSystem) {
      camera.coordinateSystem = THREE.WebGLCoordinateSystem;
      camera.updateProjectionMatrix();
    }
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    if (!buffers || buffers.width !== W || buffers.height !== H)
      buffers = { width: W, height: H, color: new Float32Array(W * H * 3), depth: new Float32Array(W * H) };
    const target = { ...buffers, ss };
    target.depth.fill(1);
    // Background (linear, tone mapped with the rest of the frame).
    const background = scene.background?.isColor ? scene.background : null;
    for (let i = 0; i < W * H; i++) {
      target.color[i * 3] = background?.r ?? 0;
      target.color[i * 3 + 1] = background?.g ?? 0;
      target.color[i * 3 + 2] = background?.b ?? 0;
    }
    const lights = [],
      items = [],
      casters = [];
    scene.traverseVisible((object) => {
      if (object.isLight) {
        if (object.isDirectionalLight) {
          const from = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld),
            to = new THREE.Vector3().setFromMatrixPosition(object.target.matrixWorld);
          const direction = from.sub(to).normalize();
          lights.push({ type: "directional", object, direction: direction.toArray(), color: [object.color.r * object.intensity, object.color.g * object.intensity, object.color.b * object.intensity] });
        } else if (object.isAmbientLight)
          lights.push({ type: "ambient", color: [object.color.r * object.intensity, object.color.g * object.intensity, object.color.b * object.intensity] });
        else if (object.isHemisphereLight)
          lights.push({
            type: "hemisphere",
            sky: [object.color.r * object.intensity, object.color.g * object.intensity, object.color.b * object.intensity],
            ground: [object.groundColor.r * object.intensity, object.groundColor.g * object.intensity, object.groundColor.b * object.intensity],
          });
        return;
      }
      if (object.isInstancedMesh && object.geometry?.attributes.position) {
        // Every instance draws as a mesh of its own: a proxy sharing geometry and material.
        const m = new THREE.Matrix4();
        for (let i = 0; i < object.count; i++) {
          object.getMatrixAt(i, m);
          collect({
            isMesh: true,
            geometry: object.geometry,
            material: object.material,
            matrixWorld: new THREE.Matrix4().multiplyMatrices(object.matrixWorld, m),
            castShadow: object.castShadow,
            receiveShadow: object.receiveShadow,
            renderOrder: object.renderOrder,
            layers: object.layers,
            frustumCulled: true,
          });
        }
        return;
      }
      collect(object);
    });
    function collect(object) {
      if (!(object.isMesh || object.isLine || object.isPoints) || !object.geometry?.attributes.position) return;
      if (object.isMesh && object.castShadow) casters.push(object);
      if (!object.layers.test(camera.layers)) return;
      if (object.frustumCulled && !frustum.intersectsObject(object)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      scratch.setFromMatrixPosition(object.matrixWorld).applyMatrix4(projScreen);
      for (const [start, end, material] of ranges(object.geometry, materials, object.material)) {
        if (!material || material.visible === false) continue;
        items.push({
          object,
          material,
          start,
          end,
          z: scratch.z,
          transparent: material.transparent || (material.transmission ?? 0) > 0,
        });
      }
    }
    if (shadows)
      for (const light of lights)
        if (light.object?.castShadow) light.shadow = shadowMap(light.object, casters);
    const env = environment
      ? {
          top: new THREE.Color(environment.top),
          bottom: new THREE.Color(environment.bottom),
          intensity: environment.intensity,
        }
      : null;
    const perspective = !camera.isOrthographicCamera;
    cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(cameraDirection);
    const eye = perspective ? cameraPosition.toArray() : cameraDirection.clone().negate().toArray();
    const order = (a, b) => (a.object.renderOrder ?? 0) - (b.object.renderOrder ?? 0);
    const opaque = items.filter((i) => !i.transparent).sort((a, b) => order(a, b) || a.z - b.z),
      transparent = items.filter((i) => i.transparent).sort((a, b) => order(a, b) || b.z - a.z);
    const transformed = new Map();
    for (const item of [...opaque, ...transparent]) {
      const { object, material } = item;
      let vertices = transformed.get(object);
      if (!vertices) transformed.set(object, (vertices = transform(object, projScreen)));
      const state = {
        target,
        side: material.side ?? FRONT,
        flip: object.matrixWorld.determinant() < 0,
        shade: shaderFor(material, scene, lights, material.isMeshStandardMaterial ? env : null),
        blend: item.transparent,
        additive: material.blending === THREE.AdditiveBlending,
        depthTest: material.depthTest,
        depthWrite: material.depthWrite,
        receive: object.receiveShadow,
        perspective,
        eye,
        // glPolygonOffset: units of the smallest resolvable step of a 24-bit depth buffer.
        bias: material.polygonOffset ? (material.polygonOffsetUnits ?? 0) * 6e-8 : 0,
        slopeBias: material.polygonOffset ? material.polygonOffsetFactor ?? 0 : 0,
      };
      if (material.isShadowMaterial) {
        const light = lights.find((l) => l.shadow);
        fragment.lit = light ? (f) => light.shadow(f.world, f.normal) : () => 1;
        state.receive = true;
      }
      if (object.isMesh) {
        if (material.wireframe) drawWireframe(object, object.geometry, vertices, item.start, item.end, state);
        else drawTriangles(object, object.geometry, vertices, item.start, item.end, state);
      } else if (object.isLine) drawLines(object, object.geometry, vertices, item.start, item.end, state);
      else drawPoints(object, object.geometry, vertices, item.start, item.end, material, state);
    }
    return { width: W, height: H, color: target.color, ss };
  }

  function drawWireframe(object, geometry, vertices, start, end, state) {
    const index = geometry.index,
      read = (i) => (index ? index.getX(i) : i),
      list = [];
    for (let i = start; i + 2 < end; i += 3) list.push(read(i), read(i + 1), read(i + 1), read(i + 2), read(i + 2), read(i));
    const lines = { isLineSegments: true };
    const proxy = { index: { getX: (i) => list[i] }, attributes: geometry.attributes };
    drawLines(lines, proxy, vertices, 0, list.length, state);
  }

  return { draw };
}

// Averages ss × ss samples per pixel in linear light, then tone maps and encodes to RGBA bytes.
export function resolve({ width, height, color, ss }, exposure = 1, out = null) {
  const w = Math.max(1, Math.round(width / ss)),
    h = Math.max(1, Math.round(height / ss));
  const pixels = out ?? new Uint8ClampedArray(w * h * 4);
  const n = ss * ss;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0,
        g = 0,
        b = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const i = ((y * ss + sy) * width + (x * ss + sx)) * 3;
          r += color[i];
          g += color[i + 1];
          b += color[i + 2];
        }
      const o = (y * w + x) * 4;
      toneMap(r / n, g / n, b / n, exposure, pixels, o);
      pixels[o + 3] = 255;
    }
  return { width: w, height: h, pixels };
}

/**
 * A renderer for the viewport that draws in software into canvas's 2D context.
 * `environment` ({ top, bottom, intensity }) is the sky-over-ground ambient the GPU path
 * builds as a PMREM environment. `render` draws one frame at the configured sample count;
 * `renderInteractive` draws a quick low-resolution frame and refines it once
 * the view rests, for orbiting and dragging.
 */
export function createSoftRenderer(canvas, THREE) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser offers no 2D canvas to draw the workshop in");
  const raster = createRasterizer(THREE);
  let pixelRatio = 1,
    width = canvas.clientWidth || canvas.width,
    height = canvas.clientHeight || canvas.height,
    refine = 0;
  const scratch = document.createElement("canvas");
  function present(scene, camera, scale, ss) {
    const w = Math.max(1, Math.round(canvas.width * scale)),
      h = Math.max(1, Math.round(canvas.height * scale));
    const frame = raster.draw(scene, camera, {
      width: w,
      height: h,
      ss,
      environment: renderer.environment,
      shadows: renderer.shadowMap.enabled,
    });
    const image = resolve(frame, renderer.toneMappingExposure);
    const data = new ImageData(image.pixels, image.width, image.height);
    if (image.width === canvas.width && image.height === canvas.height) context.putImageData(data, 0, 0);
    else {
      scratch.width = image.width;
      scratch.height = image.height;
      scratch.getContext("2d").putImageData(data, 0, 0);
      context.imageSmoothingEnabled = true;
      context.drawImage(scratch, 0, 0, canvas.width, canvas.height);
    }
  }
  const renderer = {
    isSoftRenderer: true,
    backend: { isWebGPUBackend: false, isSoftware: true },
    domElement: canvas,
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap },
    environment: null,
    supersampling: 2,
    onDeviceLost: null,
    onError: null,
    async init() {
      return renderer;
    },
    async dispose() {
      clearTimeout(refine);
    },
    // Pixels cost time here: the canvas keeps one sample per CSS pixel on dense screens.
    setPixelRatio(value) {
      pixelRatio = Math.min(1, value);
    },
    getPixelRatio: () => pixelRatio,
    setSize(w, h, updateStyle = true) {
      width = w;
      height = h;
      canvas.width = Math.max(1, Math.floor(w * pixelRatio));
      canvas.height = Math.max(1, Math.floor(h * pixelRatio));
      if (updateStyle) {
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
    },
    getSize: (target) => target.set(width, height),
    getDrawingBufferSize: (target) => target.set(canvas.width, canvas.height),
    // Explicit sampling: increasing output size must never silently remove AA.
    render(scene, camera) {
      clearTimeout(refine);
      present(scene, camera, 1, renderer.supersampling);
    },
    // Moving views: a quarter-megapixel frame now, the finished one when the view rests.
    renderInteractive(scene, camera) {
      clearTimeout(refine);
      const pixels = canvas.width * canvas.height,
        scale = Math.min(1, Math.sqrt(250000 / Math.max(1, pixels)));
      if (scale >= 1) {
        present(scene, camera, 1, renderer.supersampling);
        return;
      }
      present(scene, camera, scale, 1);
      refine = setTimeout(() => present(scene, camera, 1, renderer.supersampling), 250);
    },
  };
  return renderer;
}
