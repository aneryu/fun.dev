// site/kernel/sdf-editor.js
// Common Layer for the SDF Low-Poly & Smooth Block Editor (Bath Duck Showcase).
// Features:
// - Adaptive per-island voxel resolution (tiny eyes/beak and large porcelain tub each get optimal grid density)
// - 3-pass Tangential Laplacian Relaxation + Exact SDF Newton Projection (eliminates Cartesian voxel stair-stepping)
// - Per-group incremental caching + versioned GPU stream caching (0 CPU/GPU upload work on idle/orbit frames)

import { BATH_DUCK_PRESET } from "../scenes/bath-duck.js";

export const SDF_PRIMITIVE_TYPES = [
  { id: "sphere", label: "球体", icon: "⚪", defaultSize: [0.14, 0.14, 0.14], defaultRound: 0.02 },
  { id: "ellipsoid", label: "椭球", icon: "🥚", defaultSize: [0.18, 0.14, 0.22], defaultRound: 0.02 },
  { id: "roundBox", label: "圆角盒", icon: "🧊", defaultSize: [0.14, 0.10, 0.14], defaultRound: 0.028 },
  { id: "cylinder", label: "圆柱", icon: "🛢️", defaultSize: [0.16, 0.12, 0.16], defaultRound: 0.0 },
  { id: "capsule", label: "胶囊", icon: "💊", defaultSize: [0.06, 0.16, 0.06], defaultRound: 0.02 },
  { id: "torus", label: "圆环", icon: "🍩", defaultSize: [0.24, 0.055, 0.24], defaultRound: 0.02 },
];

export const SDF_COLOR_SWATCHES = [
  { id: "yellow", label: "鸭黄", rgb: [1.0, 0.83, 0.16], hex: "#ffd43b" },
  { id: "orange", label: "橘嘴", rgb: [0.96, 0.44, 0.08], hex: "#f57014" },
  { id: "cream", label: "陶瓷白", rgb: [0.98, 0.96, 0.90], hex: "#faf5e6" },
  { id: "cyan", label: "碧水蓝", rgb: [0.12, 0.68, 0.88], hex: "#1fade0" },
  { id: "coral", label: "珊瑚粉", rgb: [0.96, 0.36, 0.32], hex: "#f55c52" },
  { id: "navy", label: "深海蓝", rgb: [0.15, 0.26, 0.48], hex: "#26427a" },
  { id: "ink", label: "曜石黑", rgb: [0.03, 0.03, 0.04], hex: "#08080a" },
];

export const EDITOR_ASSET_PRESETS = {
  "bath-duck": BATH_DUCK_PRESET,
};

export const SDF_EDITOR_PRESETS = EDITOR_ASSET_PRESETS;

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function evalBathWaterWaveScalar(px, pz) {
  const ux = px / 0.72 - 0.25;
  const uz = pz / 0.72 - 0.20;
  const r = Math.hypot(ux, uz);
  return Math.cos(r * 6.0) * Math.exp(-r * 2.5) * 0.035;
}

// Zero-allocation scalar SDF primitive evaluation matching STDLIB_WGSL & bath-duck.js 1:1
function evalBlockPrimitiveAt(b, px, py, pz) {
  const qx = (b.mirrorX ? (px < 0 ? -px : px) : px) - b.pos[0];
  const qy = py - b.pos[1];
  const qz = pz - b.pos[2];
  const sx = b.size[0] > 0.012 ? b.size[0] : 0.012;
  const sy = b.size[1] > 0.012 ? b.size[1] : 0.012;
  const sz = b.size[2] > 0.012 ? b.size[2] : 0.012;

  switch (b.prim) {
    case "sphere": {
      if (Math.abs(sx - sy) < 0.002 && Math.abs(sy - sz) < 0.002) {
        return Math.hypot(qx, qy, qz) - sx;
      }
      // Fall through to ellipsoid if scaled non-uniformly
    }
    // eslint-disable-next-line no-fallthrough
    case "ellipsoid": {
      const minR = Math.min(sx, sy, sz);
      const k0 = Math.hypot(qx / sx, qy / sy, qz / sz);
      if (k0 < 1e-6) return -minR;
      const k1 = Math.hypot(qx / (sx * sx), qy / (sy * sy), qz / (sz * sz));
      const iqScale = k0 / (k1 > 1e-6 ? k1 : 1e-6);
      const t = clamp(k0 / 0.5, 0.0, 1.0);
      const s = t * t * (3.0 - 2.0 * t);
      const effScale = minR + (iqScale - minR) * s;
      return (k0 - 1.0) * effScale;
    }
    case "roundBox": {
      const minDim = Math.min(sx, sy, sz) * 0.85;
      const r = clamp(b.round ?? 0.028, 0.002, minDim);
      const dx = (qx < 0 ? -qx : qx) - sx + r;
      const dy = (qy < 0 ? -qy : qy) - sy + r;
      const dz = (qz < 0 ? -qz : qz) - sz + r;
      const out = Math.hypot(dx > 0 ? dx : 0, dy > 0 ? dy : 0, dz > 0 ? dz : 0);
      const inside = Math.min(Math.max(dx, dy, dz), 0);
      return out + inside - r;
    }
    case "cylinder": {
      const minXZ = Math.min(sx, sz);
      const rad = Math.hypot(qx / sx, qz / sz) * minXZ;
      if (b.group === "water") {
        const waveH = evalBathWaterWaveScalar(px, pz);
        const waterPlane = py - (b.pos[1] + sy + waveH);
        const dx = rad - minXZ;
        const dy = Math.abs(qy) - (sy + 0.04);
        const waterCyl = Math.min(Math.max(dx, dy), 0) + Math.hypot(dx > 0 ? dx : 0, dy > 0 ? dy : 0);
        return Math.max(waterCyl, waterPlane) / 1.12;
      }
      const r = clamp(b.round ?? 0.0, 0.0, Math.min(minXZ, sy) * 0.45);
      const dx = rad - minXZ + r;
      const extBottom = b.id === "tubOuter" && qy < 0 ? sy + 0.04 : sy;
      const dy = (qy < 0 ? -qy : qy) - extBottom + r;
      return Math.min(Math.max(dx, dy), 0) + Math.hypot(dx > 0 ? dx : 0, dy > 0 ? dy : 0) - r;
    }
    case "capsule": {
      // Supports tapered tilted capsule (matches sdTaperedCapsule in bath-duck.js 1:1)
      const ax = 0.0, ay = -sy, az = sz;
      const bx = 0.0, by = sy, bz = -sz;
      const bax = bx - ax, bay = by - ay, baz = bz - az;
      const pax = qx - ax, pay = qy - ay, paz = qz - az;
      const l2 = Math.max(bax * bax + bay * bay + baz * baz, 1e-5);
      const h = clamp((pax * bax + pay * bay + paz * baz) / l2, 0.0, 1.0);
      const ra = sx;
      const rb = clamp(b.round ?? 0.04, 0.015, sx);
      const rMix = ra + (rb - ra) * h;
      return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - rMix;
    }
    case "torus": {
      const minXZ = Math.min(sx, sz);
      const dx = Math.hypot(qx / sx, qz / sz) * minXZ - minXZ;
      return Math.hypot(dx, qy) - sy;
    }
    default:
      return Math.hypot(qx, qy, qz) - sx;
  }
}

function opSmoothUnionScalar(d1, d2, k) {
  const h = clamp(0.5 + (0.5 * (d2 - d1)) / k, 0.0, 1.0);
  return d2 * (1.0 - h) + d1 * h - k * h * (1.0 - h);
}

function opSmoothSubtractScalar(d1, d2, k) {
  const h = clamp(0.5 - (0.5 * (d1 + d2)) / k, 0.0, 1.0);
  return d1 * (1.0 - h) + -d2 * h + k * h * (1.0 - h);
}

function computeBlockAABB(b, pad = 0.06) {
  const sx = Math.max(0.015, b.size[0]);
  const sy = Math.max(0.015, b.size[1]);
  const sz = Math.max(0.015, b.size[2]);
  let rx = sx, ry = sy, rz = sz;
  if (b.prim === "capsule") {
    ry = sy + sx;
    rz = sz + sx;
  } else if (b.prim === "torus") {
    rx = sx + sy;
    rz = sz + sy;
  } else if (b.group === "water") {
    ry = sy + 0.045;
  }
  const kPad = (b.k || 0.03) + pad;
  const minX = b.mirrorX ? -(Math.abs(b.pos[0]) + rx + kPad) : b.pos[0] - rx - kPad;
  const maxX = b.mirrorX ? Math.abs(b.pos[0]) + rx + kPad : b.pos[0] + rx + kPad;
  return [
    minX,
    b.pos[1] - ry - kPad,
    b.pos[2] - rz - kPad,
    maxX,
    b.pos[1] + ry + kPad,
    b.pos[2] + rz + kPad,
  ];
}

function evalGroupBlocksField(groupBlocks, px, py, pz) {
  let d = 1e6;
  let hasPositive = false;

  // Evaluate in sequential constructive order so (tubOuter - tubInner) + tubRim
  // preserves the full rolled torus lip just like bath-duck.js!
  for (let i = 0; i < groupBlocks.length; i++) {
    const b = groupBlocks[i];
    if (b.op === "smoothSubtract" && !hasPositive) continue;
    const dPrim = evalBlockPrimitiveAt(b, px, py, pz);
    if (!hasPositive) {
      d = dPrim;
      hasPositive = true;
    } else if (b.op === "smoothSubtract") {
      const k = Math.max(0.001, b.k ?? 0.03);
      d = opSmoothSubtractScalar(d, dPrim, k);
    } else {
      const k = Math.max(0.001, b.k ?? 0.03);
      if (k <= 0.004) {
        d = d < dPrim ? d : dPrim;
      } else {
        d = opSmoothUnionScalar(d, dPrim, k);
      }
    }
  }

  // Apply any leading subtract blocks if they were placed at index 0
  for (let i = 0; i < groupBlocks.length; i++) {
    const b = groupBlocks[i];
    if (b.op !== "smoothSubtract") break;
    const dPrim = evalBlockPrimitiveAt(b, px, py, pz);
    const k = Math.max(0.001, b.k ?? 0.03);
    d = opSmoothSubtractScalar(d, dPrim, k);
  }
  return d;
}

const _normOut = [0, 1, 0];
function evalGroupBlocksNormal(groupBlocks, px, py, pz, eps = 0.002) {
  const d0 = evalGroupBlocksField(groupBlocks, px + eps, py - eps, pz - eps);
  const d1 = evalGroupBlocksField(groupBlocks, px - eps, py - eps, pz + eps);
  const d2 = evalGroupBlocksField(groupBlocks, px - eps, py + eps, pz - eps);
  const d3 = evalGroupBlocksField(groupBlocks, px + eps, py + eps, pz + eps);
  const gx = d0 - d1 - d2 + d3;
  const gy = -d0 - d1 + d2 + d3;
  const gz = -d0 + d1 - d2 + d3;
  const len = Math.hypot(gx, gy, gz) || 1.0;
  _normOut[0] = gx / len;
  _normOut[1] = gy / len;
  _normOut[2] = gz / len;
  return _normOut;
}

const CUBE_EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

const CORNER_OFFSETS = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

const _sharedCornerVals = new Float32Array(8);

/**
 * Cylindrical-Grid Surface Nets `(r, y, theta)` for axisymmetric/basin groups (`tub`, `water`).
 */
function bakeCylindricalGroupIsland(groupName, groupBlocks, voxelSize, shadingMode = "smooth") {
  if (!groupBlocks || groupBlocks.length === 0) return null;

  let minY = Infinity, maxY = -Infinity, maxR = 0.2;
  for (const b of groupBlocks) {
    if (b.op === "smoothSubtract") continue;
    const aabb = computeBlockAABB(b, 0.03);
    if (aabb[1] < minY) minY = aabb[1];
    if (aabb[4] > maxY) maxY = aabb[4];
    const br = Math.max(Math.abs(aabb[0]), Math.abs(aabb[3]), Math.abs(aabb[2]), Math.abs(aabb[5]));
    if (br > maxR) maxR = br;
  }
  if (!Number.isFinite(minY)) return null;

  const densityFactor = 0.040 / clamp(voxelSize, 0.024, 0.072);
  const modeScale = shadingMode === "lowpoly" ? 0.42 : 1.0;
  const nTheta = clamp(Math.round(64 * densityFactor * modeScale), 16, 80);
  const nr = clamp(Math.round((groupName === "tub" ? 28 : 18) * densityFactor * (shadingMode === "lowpoly" ? 0.65 : 1.0)), 10, 40);
  const ny = clamp(Math.round((groupName === "tub" ? 26 : 12) * densityFactor * (shadingMode === "lowpoly" ? 0.65 : 1.0)), 8, 36);

  const rMin = groupName === "tub" ? 0.56 : 0.001;
  const rMax = maxR + 0.04;
  const dr = (rMax - rMin) / nr;
  const padY = 0.03;
  const oy = minY - padY;
  const dy = (maxY + padY - oy) / ny;
  const dTheta = (Math.PI * 2.0) / nTheta;
  const minStep = Math.min(dr, dy);
  const eps = Math.max(0.001, minStep * 0.15);

  const sr = nr + 1;
  const sy = ny + 1;
  const sry = sr * sy;
  const nry = nr * ny;

  const sdfGrid = new Float32Array(sr * sy * nTheta);
  for (let it = 0; it < nTheta; it++) {
    const theta = it * dTheta;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const tBase = it * sry;
    for (let iy = 0; iy < sy; iy++) {
      const py = oy + iy * dy;
      const ytBase = tBase + iy * sr;
      for (let ir = 0; ir < sr; ir++) {
        const r = rMin + ir * dr;
        sdfGrid[ytBase + ir] = evalGroupBlocksField(groupBlocks, r * cosT, py, r * sinT);
      }
    }
  }

  const cellToVertex = new Int32Array(nr * ny * nTheta).fill(-1);
  const vertCoords = [];

  for (let it = 0; it < nTheta; it++) {
    const itNext = (it + 1) % nTheta;
    const tBase0 = it * sry;
    const tBase1 = itNext * sry;

    for (let iy = 0; iy < ny; iy++) {
      for (let ir = 0; ir < nr; ir++) {
        const rc0 = iy * sr + ir;
        const c000 = sdfGrid[tBase0 + rc0];
        const c100 = sdfGrid[tBase0 + rc0 + 1];
        const c010 = sdfGrid[tBase0 + rc0 + sr];
        const c110 = sdfGrid[tBase0 + rc0 + sr + 1];
        const c001 = sdfGrid[tBase1 + rc0];
        const c101 = sdfGrid[tBase1 + rc0 + 1];
        const c011 = sdfGrid[tBase1 + rc0 + sr];
        const c111 = sdfGrid[tBase1 + rc0 + sr + 1];

        let mask = 0;
        if (c000 < 0) mask |= 1;
        if (c100 < 0) mask |= 2;
        if (c010 < 0) mask |= 4;
        if (c110 < 0) mask |= 8;
        if (c001 < 0) mask |= 16;
        if (c101 < 0) mask |= 32;
        if (c011 < 0) mask |= 64;
        if (c111 < 0) mask |= 128;
        if (mask === 0 || mask === 255) continue;

        _sharedCornerVals[0] = c000;
        _sharedCornerVals[1] = c100;
        _sharedCornerVals[2] = c010;
        _sharedCornerVals[3] = c110;
        _sharedCornerVals[4] = c001;
        _sharedCornerVals[5] = c101;
        _sharedCornerVals[6] = c011;
        _sharedCornerVals[7] = c111;

        let sumR = 0, sumY = 0, sumT = 0, count = 0;
        for (let e = 0; e < 12; e++) {
          const edge = CUBE_EDGES[e];
          const v0 = _sharedCornerVals[edge[0]];
          const v1 = _sharedCornerVals[edge[1]];
          if ((v0 < 0.0) !== (v1 < 0.0)) {
            const t = clamp(v0 / (v0 - v1), 0.0, 1.0);
            const o0 = CORNER_OFFSETS[edge[0]];
            const o1 = CORNER_OFFSETS[edge[1]];
            sumR += ir + o0[0] + t * (o1[0] - o0[0]);
            sumY += iy + o0[1] + t * (o1[1] - o0[1]);
            sumT += o0[2] + t * (o1[2] - o0[2]);
            count++;
          }
        }

        const rCell = rMin + (sumR / count) * dr;
        const yCell = oy + (sumY / count) * dy;
        const thetaCell = (it + sumT / count) * dTheta;
        let vx = rCell * Math.cos(thetaCell);
        let vy = yCell;
        let vz = rCell * Math.sin(thetaCell);

        const dVal = evalGroupBlocksField(groupBlocks, vx, vy, vz);
        const n = evalGroupBlocksNormal(groupBlocks, vx, vy, vz, eps);
        const step = clamp(dVal, -0.45 * minStep, 0.45 * minStep);
        vx -= n[0] * step;
        vy -= n[1] * step;
        vz -= n[2] * step;

        cellToVertex[ir + nr * iy + nry * it] = vertCoords.length / 3;
        vertCoords.push(vx, vy, vz);
      }
    }
  }

  const indicesList = [];
  const emitQuad = (v0, v1, v2, v3, flip) => {
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) return;
    if (!flip) {
      indicesList.push(v0, v1, v2, v0, v2, v3);
    } else {
      indicesList.push(v0, v2, v1, v0, v3, v2);
    }
  };

  for (let it = 0; it < nTheta; it++) {
    const itPrev = (it - 1 + nTheta) % nTheta;
    const itNext = (it + 1) % nTheta;
    const tBase = it * sry;

    for (let iy = 1; iy < ny; iy++) {
      for (let ir = 1; ir < nr; ir++) {
        const cBase = tBase + iy * sr + ir;
        const d0 = sdfGrid[cBase];

        const dr1 = sdfGrid[cBase + 1];
        if ((d0 < 0.0) !== (dr1 < 0.0)) {
          emitQuad(
            cellToVertex[ir + nr * (iy - 1) + nry * itPrev],
            cellToVertex[ir + nr * iy + nry * itPrev],
            cellToVertex[ir + nr * iy + nry * it],
            cellToVertex[ir + nr * (iy - 1) + nry * it],
            d0 >= 0.0
          );
        }

        const dy1 = sdfGrid[cBase + sr];
        if ((d0 < 0.0) !== (dy1 < 0.0)) {
          emitQuad(
            cellToVertex[ir - 1 + nr * iy + nry * itPrev],
            cellToVertex[ir - 1 + nr * iy + nry * it],
            cellToVertex[ir + nr * iy + nry * it],
            cellToVertex[ir + nr * iy + nry * itPrev],
            d0 >= 0.0
          );
        }

        const dt1 = sdfGrid[itNext * sry + iy * sr + ir];
        if ((d0 < 0.0) !== (dt1 < 0.0)) {
          emitQuad(
            cellToVertex[ir - 1 + nr * (iy - 1) + nry * it],
            cellToVertex[ir + nr * (iy - 1) + nry * it],
            cellToVertex[ir + nr * iy + nry * it],
            cellToVertex[ir - 1 + nr * iy + nry * it],
            d0 >= 0.0
          );
        }
      }
    }
  }

  return finalizeIslandMesh(groupName, groupBlocks, new Float32Array(vertCoords), indicesList, eps, shadingMode);
}

/**
 * Extracts a single blendGroup island using Adaptive-Resolution Surface Nets
 * + 3-Pass Tangential Laplacian Relaxation & Exact SDF Projection.
 */
function bakeGroupIsland(groupName, groupBlocks, voxelSize, shadingMode = "smooth") {
  if (!groupBlocks || groupBlocks.length === 0) return null;
  if (groupName === "tub" || groupName === "water") {
    return bakeCylindricalGroupIsland(groupName, groupBlocks, voxelSize, shadingMode);
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const b of groupBlocks) {
    if (b.op === "smoothSubtract") continue;
    const aabb = computeBlockAABB(b, 0.03);
    if (aabb[0] < minX) minX = aabb[0];
    if (aabb[1] < minY) minY = aabb[1];
    if (aabb[2] < minZ) minZ = aabb[2];
    if (aabb[3] > maxX) maxX = aabb[3];
    if (aabb[4] > maxY) maxY = aabb[4];
    if (aabb[5] > maxZ) maxZ = aabb[5];
  }
  if (!Number.isFinite(minX)) return null;

  // Adaptive per-island resolution: small features (eyes, beak) and large features (tub, water)
  // each get an optimal local voxel step proportional to their bounding span and user voxelSize slider.
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const spanZ = maxZ - minZ;
  const maxSpan = Math.max(spanX, spanY, spanZ, 0.08);

  const densityFactor = 0.040 / clamp(voxelSize, 0.024, 0.072);
  const baseTargetCells = groupName === "tub"
    ? 44
    : groupName === "duck"
    ? 36
    : groupName === "water"
    ? 34
    : 22;
  const modeScale = shadingMode === "lowpoly" ? 0.62 : 1.0;
  const targetCells = clamp(Math.round(baseTargetCells * densityFactor * modeScale), 12, 54);
  const effVoxel = maxSpan / targetCells;

  const pad = effVoxel * 1.6;
  const ox = minX - pad;
  const oy = minY - pad;
  const oz = minZ - pad;
  const nx = clamp(Math.ceil((maxX + pad - ox) / effVoxel), 6, 58);
  const ny = clamp(Math.ceil((maxY + pad - oy) / effVoxel), 6, 58);
  const nz = clamp(Math.ceil((maxZ + pad - oz) / effVoxel), 6, 58);

  const sx = nx + 1, sy = ny + 1, sz = nz + 1;
  const sxy = sx * sy;
  const nxy = nx * ny;

  const sdfGrid = new Float32Array(sx * sy * sz);
  for (let iz = 0; iz < sz; iz++) {
    const pz = oz + iz * effVoxel;
    const zBase = iz * sxy;
    for (let iy = 0; iy < sy; iy++) {
      const py = oy + iy * effVoxel;
      const yzBase = zBase + iy * sx;
      for (let ix = 0; ix < sx; ix++) {
        sdfGrid[yzBase + ix] = evalGroupBlocksField(groupBlocks, ox + ix * effVoxel, py, pz);
      }
    }
  }

  const cellToVertex = new Int32Array(nx * ny * nz).fill(-1);
  const vertCoords = [];
  const eps = Math.max(0.001, effVoxel * 0.18);

  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        let mask = 0;
        const baseCorner = ix + sx * iy + sxy * iz;
        const c000 = sdfGrid[baseCorner];
        const c100 = sdfGrid[baseCorner + 1];
        const c010 = sdfGrid[baseCorner + sx];
        const c110 = sdfGrid[baseCorner + sx + 1];
        const c001 = sdfGrid[baseCorner + sxy];
        const c101 = sdfGrid[baseCorner + sxy + 1];
        const c011 = sdfGrid[baseCorner + sxy + sx];
        const c111 = sdfGrid[baseCorner + sxy + sx + 1];

        if (c000 < 0) mask |= 1;
        if (c100 < 0) mask |= 2;
        if (c010 < 0) mask |= 4;
        if (c110 < 0) mask |= 8;
        if (c001 < 0) mask |= 16;
        if (c101 < 0) mask |= 32;
        if (c011 < 0) mask |= 64;
        if (c111 < 0) mask |= 128;
        if (mask === 0 || mask === 255) continue;

        _sharedCornerVals[0] = c000;
        _sharedCornerVals[1] = c100;
        _sharedCornerVals[2] = c010;
        _sharedCornerVals[3] = c110;
        _sharedCornerVals[4] = c001;
        _sharedCornerVals[5] = c101;
        _sharedCornerVals[6] = c011;
        _sharedCornerVals[7] = c111;

        let sumX = 0, sumY = 0, sumZ = 0, count = 0;
        for (let e = 0; e < 12; e++) {
          const edge = CUBE_EDGES[e];
          const v0 = _sharedCornerVals[edge[0]];
          const v1 = _sharedCornerVals[edge[1]];
          if ((v0 < 0.0) !== (v1 < 0.0)) {
            const t = clamp(v0 / (v0 - v1), 0.0, 1.0);
            const o0 = CORNER_OFFSETS[edge[0]];
            const o1 = CORNER_OFFSETS[edge[1]];
            sumX += ix + o0[0] + t * (o1[0] - o0[0]);
            sumY += iy + o0[1] + t * (o1[1] - o0[1]);
            sumZ += iz + o0[2] + t * (o1[2] - o0[2]);
            count++;
          }
        }
        let vx = ox + (sumX / count) * effVoxel;
        let vy = oy + (sumY / count) * effVoxel;
        let vz = oz + (sumZ / count) * effVoxel;

        const dVal = evalGroupBlocksField(groupBlocks, vx, vy, vz);
        const n = evalGroupBlocksNormal(groupBlocks, vx, vy, vz, eps);
        const step = clamp(dVal, -0.45 * effVoxel, 0.45 * effVoxel);
        vx -= n[0] * step;
        vy -= n[1] * step;
        vz -= n[2] * step;

        cellToVertex[ix + nx * iy + nxy * iz] = vertCoords.length / 3;
        vertCoords.push(vx, vy, vz);
      }
    }
  }

  const indicesList = [];
  const emitQuad = (v0, v1, v2, v3, flip) => {
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) return;
    if (!flip) {
      indicesList.push(v0, v1, v2, v0, v2, v3);
    } else {
      indicesList.push(v0, v2, v1, v0, v3, v2);
    }
  };

  for (let iz = 1; iz < nz; iz++) {
    for (let iy = 1; iy < ny; iy++) {
      for (let ix = 1; ix < nx; ix++) {
        const cBase = ix + sx * iy + sxy * iz;
        const d0 = sdfGrid[cBase];
        const dx1 = sdfGrid[cBase + 1];
        if ((d0 < 0.0) !== (dx1 < 0.0)) {
          emitQuad(
            cellToVertex[ix + nx * (iy - 1) + nxy * (iz - 1)],
            cellToVertex[ix + nx * iy + nxy * (iz - 1)],
            cellToVertex[ix + nx * iy + nxy * iz],
            cellToVertex[ix + nx * (iy - 1) + nxy * iz],
            d0 >= 0.0
          );
        }
        const dy1 = sdfGrid[cBase + sx];
        if ((d0 < 0.0) !== (dy1 < 0.0)) {
          emitQuad(
            cellToVertex[ix - 1 + nx * iy + nxy * (iz - 1)],
            cellToVertex[ix - 1 + nx * iy + nxy * iz],
            cellToVertex[ix + nx * iy + nxy * iz],
            cellToVertex[ix + nx * iy + nxy * (iz - 1)],
            d0 >= 0.0
          );
        }
        const dz1 = sdfGrid[cBase + sxy];
        if ((d0 < 0.0) !== (dz1 < 0.0)) {
          emitQuad(
            cellToVertex[ix - 1 + nx * (iy - 1) + nxy * iz],
            cellToVertex[ix + nx * (iy - 1) + nxy * iz],
            cellToVertex[ix + nx * iy + nxy * iz],
            cellToVertex[ix - 1 + nx * iy + nxy * iz],
            d0 >= 0.0
          );
        }
      }
    }
  }

  // 2-Pass Safe Tangential Relaxation + Exact Single-Step SDF Projection:
  // Smooths triangle valence along the tangent plane while keeping vertices locked to d=0.
  const vCount = vertCoords.length / 3;
  const posArr = new Float32Array(vertCoords);
  const sumPos = new Float32Array(vCount * 3);
  const deg = new Uint16Array(vCount);
  const triCount = Math.floor(indicesList.length / 3);

  for (let iter = 0; iter < 2; iter++) {
    sumPos.fill(0);
    deg.fill(0);
    for (let t = 0; t < triCount; t++) {
      const a = indicesList[t * 3];
      const b = indicesList[t * 3 + 1];
      const c = indicesList[t * 3 + 2];
      const ax = posArr[a * 3], ay = posArr[a * 3 + 1], az = posArr[a * 3 + 2];
      const bx = posArr[b * 3], by = posArr[b * 3 + 1], bz = posArr[b * 3 + 2];
      const cx = posArr[c * 3], cy = posArr[c * 3 + 1], cz = posArr[c * 3 + 2];

      sumPos[a * 3] += bx + cx; sumPos[a * 3 + 1] += by + cy; sumPos[a * 3 + 2] += bz + cz; deg[a] += 2;
      sumPos[b * 3] += ax + cx; sumPos[b * 3 + 1] += ay + cy; sumPos[b * 3 + 2] += az + cz; deg[b] += 2;
      sumPos[c * 3] += ax + bx; sumPos[c * 3 + 1] += ay + by; sumPos[c * 3 + 2] += az + bz; deg[c] += 2;
    }

    for (let v = 0; v < vCount; v++) {
      const cnt = deg[v];
      if (cnt === 0) continue;
      let px = posArr[v * 3];
      let py = posArr[v * 3 + 1];
      let pz = posArr[v * 3 + 2];
      const avgX = sumPos[v * 3] / cnt;
      const avgY = sumPos[v * 3 + 1] / cnt;
      const avgZ = sumPos[v * 3 + 2] / cnt;

      const n = evalGroupBlocksNormal(groupBlocks, px, py, pz, eps);
      const nx0 = n[0], ny0 = n[1], nz0 = n[2];
      const dx = avgX - px;
      const dy = avgY - py;
      const dz = avgZ - pz;
      const dotN = dx * nx0 + dy * ny0 + dz * nz0;
      px += (dx - nx0 * dotN) * 0.45;
      py += (dy - ny0 * dotN) * 0.45;
      pz += (dz - nz0 * dotN) * 0.45;

      const dVal = evalGroupBlocksField(groupBlocks, px, py, pz);
      const step = clamp(dVal, -0.35 * effVoxel, 0.35 * effVoxel);
      px -= nx0 * step;
      py -= ny0 * step;
      pz -= nz0 * step;

      posArr[v * 3] = px;
      posArr[v * 3 + 1] = py;
      posArr[v * 3 + 2] = pz;
    }
  }

  // Clamp the extended tub base cleanly at the ground plane y = -0.53 so the barrel is vertical all the way to the floor
  if (groupName === "tub") {
    for (let v = 0; v < vCount; v++) {
      if (posArr[v * 3 + 1] < -0.53) {
        posArr[v * 3 + 1] = -0.53;
      }
    }
  }

  return finalizeIslandMesh(groupName, groupBlocks, posArr, indicesList, eps, shadingMode);
}

function finalizeIslandMesh(groupName, groupBlocks, posArr, indicesList, eps, shadingMode) {
  const vCount = posArr.length / 3;
  const triCount = Math.floor(indicesList.length / 3);

  const assignColorAt = (px, py, pz) => {
    let bestBlock = groupBlocks[0];
    let bestD = Infinity;
    for (let i = 0; i < groupBlocks.length; i++) {
      const b = groupBlocks[i];
      if (b.op === "smoothSubtract") continue;
      const d = Math.abs(evalBlockPrimitiveAt(b, px, py, pz));
      if (d < bestD) {
        bestD = d;
        bestBlock = b;
      }
    }
    return bestBlock;
  };

  // Helper to enrich water surface color & subtle ripple normal like the original Bath Duck
  const shadeVertexColorAndNormal = (owner, px, py, pz, nx, ny, nz) => {
    let r = owner.color[0];
    let g = owner.color[1];
    let b = owner.color[2];
    let rough = owner.roughness ?? 0.32;

    if (groupName === "water" && ny > 0.5) {
      const rad = Math.hypot(px, pz);
      // Gentle concentric water ripple normal + pool depth/contact AO matching bath-duck.js
      const ripple = Math.sin(rad * 20.0 - 0.6) * Math.exp(-rad * 1.8) * 0.035;
      if (rad > 0.01) {
        nx += (px / rad) * ripple;
        nz += (pz / rad) * ripple;
        const nLen = Math.hypot(nx, ny, nz) || 1.0;
        nx /= nLen; ny /= nLen; nz /= nLen;
      }
      const wallAO = 1.0 - clamp((rad - 0.58) / 0.18, 0.0, 1.0) * 0.18;
      const duckAO = 1.0 - clamp((0.36 - rad) / 0.16, 0.0, 1.0) * 0.16;
      const waveLight = 1.0 + Math.cos(rad * 20.0 - 0.6) * 0.035;
      const ao = wallAO * duckAO * waveLight;
      r = clamp(r * ao, 0.03, 1.0);
      g = clamp(g * ao, 0.03, 1.0);
      b = clamp(b * ao, 0.03, 1.0);
      rough = 0.08;
    } else if (groupName === "tub") {
      const rad = Math.hypot(px, pz);
      let ao = 1.0;
      if (rad < 0.75 && py < -0.12) {
        ao *= 0.88 + 0.12 * clamp((py + 0.28) / 0.16, 0.0, 1.0);
      }
      r *= ao;
      g *= ao;
      b *= ao;
    }
    return { r, g, b, rough, nx, ny, nz };
  };

  if (shadingMode === "lowpoly") {
    const outVerts = triCount * 3;
    const positions = new Float32Array(outVerts * 3);
    const normals = new Float32Array(outVerts * 3);
    const colors = new Float32Array(outVerts * 4);
    const blockIds = new Array(outVerts);
    const indices = new Uint32Array(outVerts);

    for (let t = 0; t < triCount; t++) {
      const i0 = indicesList[t * 3 + 0];
      const i1 = indicesList[t * 3 + 1];
      const i2 = indicesList[t * 3 + 2];

      const p0x = posArr[i0 * 3], p0y = posArr[i0 * 3 + 1], p0z = posArr[i0 * 3 + 2];
      const p1x = posArr[i1 * 3], p1y = posArr[i1 * 3 + 1], p1z = posArr[i1 * 3 + 2];
      const p2x = posArr[i2 * 3], p2y = posArr[i2 * 3 + 1], p2z = posArr[i2 * 3 + 2];

      const e1x = p1x - p0x, e1y = p1y - p0y, e1z = p1z - p0z;
      const e2x = p2x - p0x, e2y = p2y - p0y, e2z = p2z - p0z;
      let fnx = e1y * e2z - e1z * e2y;
      let fny = e1z * e2x - e1x * e2z;
      let fnz = e1x * e2y - e1y * e2x;
      const flen = Math.hypot(fnx, fny, fnz) || 1.0;
      fnx /= flen; fny /= flen; fnz /= flen;

      const cx = (p0x + p1x + p2x) / 3;
      const cy = (p0y + p1y + p2y) / 3;
      const cz = (p0z + p1z + p2z) / 3;
      const owner = assignColorAt(cx, cy, cz);
      const sh = shadeVertexColorAndNormal(owner, cx, cy, cz, fnx, fny, fnz);
      const baseV = t * 3;

      positions[baseV * 3 + 0] = p0x; positions[baseV * 3 + 1] = p0y; positions[baseV * 3 + 2] = p0z;
      positions[(baseV + 1) * 3 + 0] = p1x; positions[(baseV + 1) * 3 + 1] = p1y; positions[(baseV + 1) * 3 + 2] = p1z;
      positions[(baseV + 2) * 3 + 0] = p2x; positions[(baseV + 2) * 3 + 1] = p2y; positions[(baseV + 2) * 3 + 2] = p2z;

      for (let k = 0; k < 3; k++) {
        const vIdx = baseV + k;
        normals[vIdx * 3 + 0] = sh.nx;
        normals[vIdx * 3 + 1] = sh.ny;
        normals[vIdx * 3 + 2] = sh.nz;
        colors[vIdx * 4 + 0] = sh.r;
        colors[vIdx * 4 + 1] = sh.g;
        colors[vIdx * 4 + 2] = sh.b;
        colors[vIdx * 4 + 3] = sh.rough;
        blockIds[vIdx] = owner.id;
        indices[vIdx] = vIdx;
      }
    }

    return {
      groupName,
      vertexCount: outVerts,
      uniqueVertexCount: vCount,
      triangleCount: triCount,
      positions,
      normals,
      colors,
      blockIds,
      indices,
    };
  }

  const normals = new Float32Array(vCount * 3);
  const colors = new Float32Array(vCount * 4);
  const blockIds = new Array(vCount);
  const indices = new Uint32Array(indicesList);

  for (let v = 0; v < vCount; v++) {
    const px = posArr[v * 3], py = posArr[v * 3 + 1], pz = posArr[v * 3 + 2];
    const n = evalGroupBlocksNormal(groupBlocks, px, py, pz, eps);
    const owner = assignColorAt(px, py, pz);
    const sh = shadeVertexColorAndNormal(owner, px, py, pz, n[0], n[1], n[2]);
    normals[v * 3 + 0] = sh.nx;
    normals[v * 3 + 1] = sh.ny;
    normals[v * 3 + 2] = sh.nz;
    colors[v * 4 + 0] = sh.r;
    colors[v * 4 + 1] = sh.g;
    colors[v * 4 + 2] = sh.b;
    colors[v * 4 + 3] = sh.rough;
    blockIds[v] = owner.id;
  }

  return {
    groupName,
    vertexCount: vCount,
    uniqueVertexCount: vCount,
    triangleCount: Math.floor(indices.length / 3),
    positions: posArr,
    normals,
    colors,
    blockIds,
    indices,
  };
}

const PRIM_TYPE_TO_ID = {
  sphere: 0,
  ellipsoid: 1,
  roundBox: 2,
  cylinder: 3,
  capsule: 4,
  torus: 5,
};

const GROUP_NAME_TO_ID = {
  duck: 0,
  beak: 1,
  eye: 2,
  water: 3,
  tub: 4,
};

function evalSceneSolidField(blocks, excludeWater, px, py, pz) {
  let d = 1e6;
  let hasPos = false;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (excludeWater && b.group === "water") continue;
    if (b.op === "smoothSubtract" && !hasPos) continue;
    const dp = evalBlockPrimitiveAt(b, px, py, pz);
    if (!hasPos) {
      d = dp;
      hasPos = true;
    } else if (b.op === "smoothSubtract") {
      d = opSmoothSubtractScalar(d, dp, Math.max(0.001, b.k ?? 0.03));
    } else {
      const k = Math.max(0.001, b.k ?? 0.03);
      d = k <= 0.004 ? (d < dp ? d : dp) : opSmoothUnionScalar(d, dp, k);
    }
  }
  return d;
}

function evalSceneAO(blocks, px, py, pz, nx, ny, nz) {
  let occ = 0.0;
  let sca = 1.0;
  for (let i = 0; i < 4; i++) {
    const h = 0.02 + (0.11 * i) / 3.0;
    const sx = px + h * nx;
    const sy = py + h * ny;
    const sz = pz + h * nz;
    const d = evalSceneSolidField(blocks, false, sx, sy, sz);
    occ += Math.max(0.0, Math.min(h, h - d)) * sca;
    sca *= 0.7;
  }
  const selfAO = clamp(1.0 - 2.35 * occ, 0.0, 1.0);
  const groundHorizon = 0.90 + 0.10 * clamp((py - -0.53) / 0.14, 0.0, 1.0);
  return selfAO * groundHorizon;
}

function evalSceneSoftShadow(blocks, excludeWater, px, py, pz, nx, ny, nz) {
  const kx = 0.579, ky = 0.758, kz = 0.300;
  const rox = px + nx * 0.008;
  const roy = py + ny * 0.008;
  const roz = pz + nz * 0.008;
  let res = 1.0;
  let t = 0.024;
  for (let i = 0; i < 10; i++) {
    const h = evalSceneSolidField(blocks, excludeWater, rox + kx * t, roy + ky * t, roz + kz * t);
    if (h < 0.001) return 0.0;
    res = Math.min(res, (7.5 * h) / t);
    t += clamp(h * 0.55, 0.018, 0.09);
    if (t > 1.25) break;
  }
  const s = clamp(res, 0.0, 1.0);
  return s * s * (3.0 - 2.0 * s);
}

/**
 * Stateful SDF-to-Mesh Editor Engine with group-level incremental caching
 * AND versioned static render stream caching (0 CPU vertex loops on idle frames).
 */
export class SDFEditorEngine {
  constructor() {
    this.assetId = "bath-duck";
    this.blocks = [];
    this.voxelSize = 0.040;
    this.shadingMode = "smooth"; // "smooth" | "lowpoly"
    this.crowdMode = false; // false = single editable model, true = 36 instances
    this.showGizmo = false; // only visible while actively dragging/manipulating a block
    this.selectedBlockId = null;
    this._groupCache = new Map();
    this._combinedMesh = null;
    this._cachedStream = null;
    this._streamVersion = 0;
    this.loadPreset("bath-duck");
  }

  loadPreset(assetId = "bath-duck") {
    const preset = EDITOR_ASSET_PRESETS[assetId] || EDITOR_ASSET_PRESETS["bath-duck"];
    this.assetId = "bath-duck";
    this.voxelSize = preset.voxelSize;
    this.blocks = preset.blocks.map((b) => ({
      ...b,
      pos: [...b.pos],
      size: [...b.size],
      color: [...b.color],
    }));
    this.selectedBlockId = this.blocks[0]?.id || null;
    this.invalidateAll();
  }

  invalidateAll() {
    this._groupCache.clear();
    this._combinedMesh = null;
    this._cachedStream = null;
    this._streamVersion++;
  }

  invalidateGroup(groupName) {
    if (groupName) {
      this._groupCache.delete(groupName);
    } else {
      this._groupCache.clear();
    }
    this._combinedMesh = null;
    this._cachedStream = null;
    this._streamVersion++;
  }

  getSelectedBlock() {
    return this.blocks.find((b) => b.id === this.selectedBlockId) || this.blocks[0] || null;
  }

  addBlock(primType = "roundBox", label = null) {
    const typeDef = SDF_PRIMITIVE_TYPES.find((t) => t.id === primType) || SDF_PRIMITIVE_TYPES[0];
    const id = `block_${Date.now().toString(36).slice(-4)}_${this.blocks.length + 1}`;
    const newBlock = {
      id,
      label: label ?? `新${typeDef.label} #${this.blocks.length + 1}`,
      prim: typeDef.id,
      op: "smoothUnion",
      k: 0.04,
      group: "duck",
      mirrorX: false,
      pos: [0.0, 0.34, 0.14],
      size: [...typeDef.defaultSize],
      round: typeDef.defaultRound,
      color: [0.96, 0.36, 0.32],
      roughness: 0.30,
    };
    this.blocks.push(newBlock);
    this.selectedBlockId = id;
    this.invalidateGroup(newBlock.group);
    return newBlock;
  }

  removeBlock(blockId) {
    if (this.blocks.length <= 1) return false;
    const idx = this.blocks.findIndex((b) => b.id === blockId);
    if (idx < 0) return false;
    const removed = this.blocks[idx];
    this.blocks.splice(idx, 1);
    if (this.selectedBlockId === blockId) {
      this.selectedBlockId = this.blocks[Math.max(0, idx - 1)]?.id || null;
    }
    this.invalidateGroup(removed.group);
    return true;
  }

  packBlocksUniformData() {
    const buf = new Float32Array(64 * 4);
    const count = Math.min(16, this.blocks.length);
    for (let i = 0; i < count; i++) {
      const b = this.blocks[i];
      const base = i * 16;
      const primId = PRIM_TYPE_TO_ID[b.prim] ?? 0;
      const groupId = GROUP_NAME_TO_ID[b.group] ?? 0;
      const flags = (b.mirrorX ? 1 : 0) | (b.op === "smoothSubtract" ? 2 : 0);

      buf[base + 0] = b.pos[0];
      buf[base + 1] = b.pos[1];
      buf[base + 2] = b.pos[2];
      buf[base + 3] = primId;

      buf[base + 4] = Math.max(0.012, b.size[0]);
      buf[base + 5] = Math.max(0.012, b.size[1]);
      buf[base + 6] = Math.max(0.012, b.size[2]);
      buf[base + 7] = b.round ?? 0.0;

      buf[base + 8] = b.color[0];
      buf[base + 9] = b.color[1];
      buf[base + 10] = b.color[2];
      buf[base + 11] = b.roughness ?? 0.32;

      buf[base + 12] = Math.max(0.001, b.k ?? 0.03);
      buf[base + 13] = flags;
      buf[base + 14] = groupId;
      buf[base + 15] = count;
    }
    if (count > 0) {
      buf[15] = count;
    }
    return buf;
  }

  bakeCombinedMesh() {
    if (this._combinedMesh) return this._combinedMesh;

    const groups = new Map();
    for (const b of this.blocks) {
      const g = b.group || "duck";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(b);
    }

    // Order islands front/inner-first to maximize GPU Early-Z rejection
    const orderedKeys = ["duck", "beak", "eye", "water", "tub"];
    for (const k of groups.keys()) {
      if (!orderedKeys.includes(k)) orderedKeys.push(k);
    }

    const islands = [];
    let totalVerts = 0;
    let totalUniqueVerts = 0;
    let totalIndices = 0;

    for (const gName of orderedKeys) {
      const gBlocks = groups.get(gName);
      if (!gBlocks) continue;
      let island = this._groupCache.get(gName);
      if (!island) {
        island = bakeGroupIsland(gName, gBlocks, this.voxelSize, this.shadingMode);
        if (island) this._groupCache.set(gName, island);
      }
      if (island && island.vertexCount > 0) {
        islands.push(island);
        totalVerts += island.vertexCount;
        totalUniqueVerts += island.uniqueVertexCount;
        totalIndices += island.indices.length;
      }
    }

    const positions = new Float32Array(totalVerts * 3);
    const normals = new Float32Array(totalVerts * 3);
    const colors = new Float32Array(totalVerts * 4);
    const aoShadowSub = new Float32Array(totalVerts * 3);
    const groupTags = new Array(totalVerts);
    const blockIds = new Array(totalVerts);
    const indices = new Uint32Array(totalIndices);

    let vOffset = 0;
    let iOffset = 0;
    let minY = Infinity;

    for (const isl of islands) {
      positions.set(isl.positions, vOffset * 3);
      normals.set(isl.normals, vOffset * 3);
      colors.set(isl.colors, vOffset * 4);
      const isWater = isl.groupName === "water";
      const subVal = isWater ? 0.88 : isl.groupName === "tub" ? 0.08 : 0.38;

      for (let v = 0; v < isl.vertexCount; v++) {
        const gv = vOffset + v;
        blockIds[gv] = isl.blockIds[v];
        groupTags[gv] = isl.groupName;
        const px = isl.positions[v * 3];
        const py = isl.positions[v * 3 + 1];
        const pz = isl.positions[v * 3 + 2];
        const nx = isl.normals[v * 3];
        const ny = isl.normals[v * 3 + 1];
        const nz = isl.normals[v * 3 + 2];
        if (py < minY) minY = py;

        const ao = evalSceneAO(this.blocks, px, py, pz, nx, ny, nz);
        const sh = evalSceneSoftShadow(this.blocks, isWater, px, py, pz, nx, ny, nz);
        aoShadowSub[gv * 3 + 0] = ao;
        aoShadowSub[gv * 3 + 1] = sh;
        aoShadowSub[gv * 3 + 2] = subVal;
      }
      for (let i = 0; i < isl.indices.length; i++) {
        indices[iOffset + i] = isl.indices[i] + vOffset;
      }
      vOffset += isl.vertexCount;
      iOffset += isl.indices.length;
    }

    if (!Number.isFinite(minY)) minY = -0.53;

    this._combinedMesh = {
      vertexCount: totalVerts,
      uniqueVertexCount: totalUniqueVerts,
      triangleCount: Math.floor(totalIndices / 3),
      positions,
      normals,
      colors,
      aoShadowSub,
      groupTags,
      blockIds,
      indices,
      minY,
      islandCount: islands.length,
    };
    return this._combinedMesh;
  }

  /**
   * Packs the 16-float vertex stream (`vData`, `iData`, `indexCount`, `gizmoIndexCount`, `blocksUniformData`, `version`)
   * compatible with both WebGPU `MESH_RENDER_WGSL` and WebGL2 `WebGL2FallbackRenderer`.
   */
  packRenderStream(_timeSec = 0) {
    if (this._cachedStream) {
      return this._cachedStream;
    }

    const blocksUniformData = this.packBlocksUniformData();
    const mesh = this.bakeCombinedMesh();
    const V = mesh.vertexCount;
    const I = mesh.indices.length;
    if (V === 0 || I === 0) {
      this._cachedStream = {
        vData: new Float32Array(0),
        iData: new Uint32Array(0),
        indexCount: 0,
        gizmoIndexCount: 0,
        blocksUniformData,
        version: ++this._streamVersion,
      };
      return this._cachedStream;
    }

    // 1. Massive Instanced Crowd Mode (36 instances in a 6x6 plaza, packed once per edit)
    if (this.crowdMode) {
      const cols = 6;
      const rows = 6;
      const count = cols * rows;
      const spacing = 0.86;
      const instScale = 0.42;
      const shadowSegs = 16;
      const shadowV = shadowSegs + 1;
      const shadowI = shadowSegs * 3;

      const totalV = count * (V + shadowV);
      const totalI = count * (I + shadowI);
      const vData = new Float32Array(totalV * 16);
      const iData = new Uint32Array(totalI);

      let vCur = 0;
      let iCur = 0;

      for (let idx = 0; idx < count; idx++) {
        const rIdx = Math.floor(idx / cols);
        const cIdx = idx % cols;
        const ox = (cIdx - (cols - 1) * 0.5) * spacing;
        const oz = (rIdx - (rows - 1) * 0.5) * spacing;
        const yaw = ((idx % 3) - 1) * 0.25;
        const cosY = Math.cos(yaw);
        const sinY = Math.sin(yaw);

        for (let v = 0; v < V; v++) {
          const lx = mesh.positions[v * 3 + 0];
          const ly = mesh.positions[v * 3 + 1];
          const lz = mesh.positions[v * 3 + 2];
          const bx = lx * instScale;
          const by = ly * instScale;
          const bz = lz * instScale;

          const px = cosY * bx + sinY * bz + ox;
          const py = by;
          const pz = -sinY * bx + cosY * bz + oz;

          const nx0 = mesh.normals[v * 3 + 0];
          const ny0 = mesh.normals[v * 3 + 1];
          const nz0 = mesh.normals[v * 3 + 2];

          const gTag = mesh.groupTags[v];
          const matId = gTag === "water" ? 11.0 : 0.0;

          const off = (vCur + v) * 16;
          vData[off + 0] = px;
          vData[off + 1] = py;
          vData[off + 2] = pz;
          vData[off + 3] = matId;
          vData[off + 4] = cosY * nx0 + sinY * nz0;
          vData[off + 5] = ny0;
          vData[off + 6] = -sinY * nx0 + cosY * nz0;
          vData[off + 7] = mesh.colors[v * 4 + 3];
          vData[off + 8] = mesh.colors[v * 4 + 0];
          vData[off + 9] = mesh.colors[v * 4 + 1];
          vData[off + 10] = mesh.colors[v * 4 + 2];
          vData[off + 12] = mesh.aoShadowSub[v * 3 + 0];
          vData[off + 13] = mesh.aoShadowSub[v * 3 + 1];
          vData[off + 14] = mesh.aoShadowSub[v * 3 + 2];
          vData[off + 15] = -1.0;
        }

        for (let k = 0; k < I; k++) {
          iData[iCur + k] = mesh.indices[k] + vCur;
        }
        vCur += V;
        iCur += I;

        const sY = -0.53 * instScale - 0.002;
        const sLocalMax = 1.45;
        const sRad = sLocalMax * instScale;
        const cOff = vCur * 16;
        vData[cOff + 0] = ox;
        vData[cOff + 1] = sY;
        vData[cOff + 2] = oz;
        vData[cOff + 3] = 6.0;
        vData[cOff + 4] = 0.0;
        vData[cOff + 5] = 1.0;
        vData[cOff + 6] = 0.0;
        vData[cOff + 7] = 1.0;
        vData[cOff + 8] = 1.0;
        vData[cOff + 9] = 212 / 255;
        vData[cOff + 10] = 59 / 255;
        vData[cOff + 15] = 1.0;

        for (let s = 0; s < shadowSegs; s++) {
          const ang = (s / shadowSegs) * Math.PI * 2;
          const ux = Math.cos(ang);
          const uz = Math.sin(ang);
          const pOff = (vCur + 1 + s) * 16;
          vData[pOff + 0] = ox + ux * sRad;
          vData[pOff + 1] = sY;
          vData[pOff + 2] = oz + uz * sRad;
          vData[pOff + 3] = 6.0;
          vData[pOff + 4] = ux * sLocalMax;
          vData[pOff + 5] = 1.0;
          vData[pOff + 6] = uz * sLocalMax;
          vData[pOff + 7] = 1.0;
          vData[pOff + 8] = 1.0;
          vData[pOff + 9] = 212 / 255;
          vData[pOff + 10] = 59 / 255;
          vData[pOff + 15] = 1.0;

          const nextS = (s + 1) % shadowSegs;
          iData[iCur++] = vCur;
          iData[iCur++] = vCur + 1 + nextS;
          iData[iCur++] = vCur + 1 + s;
        }
        vCur += shadowV;
      }

      this._cachedStream = {
        vData,
        iData,
        indexCount: totalI,
        gizmoIndexCount: 0,
        blocksUniformData,
        instanceCount: count,
        totalTriangles: count * mesh.triangleCount,
        version: ++this._streamVersion,
      };
      return this._cachedStream;
    }

    // 2. Single Model Editing Mode
    // In "smooth" mode (`✨ 丝滑高精`), `matId = 14.0` triggers per-pixel analytical live SDF evaluation
    // on the conservative SurfaceNets hull + ground shadow disc, matching `bath-duck.js` 1:1!
    // In "lowpoly" mode (`💎 晶面低模`), `matId = 0.0` renders crisp faceted low-poly triangles with baked SDF AO & shadows!
    const isSmoothLive = this.shadingMode === "smooth";
    const hullPuff = isSmoothLive ? 0.024 : 0.0;
    const shadowSegs = 32;
    const shadowV = shadowSegs + 1;
    const shadowI = shadowSegs * 3;
    const sel = this.showGizmo ? this.getSelectedBlock() : null;
    const gizmoV = sel ? 6 : 0;
    const gizmoI = sel ? 24 : 0;

    const totalV = V + shadowV + gizmoV;
    const totalI = I + shadowI + gizmoI;
    const vData = new Float32Array(totalV * 16);
    const iData = new Uint32Array(totalI);

    for (let v = 0; v < V; v++) {
      const off = v * 16;
      const nx = mesh.normals[v * 3 + 0];
      const ny = mesh.normals[v * 3 + 1];
      const nz = mesh.normals[v * 3 + 2];
      const px = mesh.positions[v * 3 + 0] + nx * hullPuff;
      const py = mesh.positions[v * 3 + 1] + ny * hullPuff;
      const pz = mesh.positions[v * 3 + 2] + nz * hullPuff;

      vData[off + 0] = px;
      vData[off + 1] = py;
      vData[off + 2] = pz;
      vData[off + 3] = isSmoothLive ? 14.0 : 0.0;
      vData[off + 4] = nx;
      vData[off + 5] = ny;
      vData[off + 6] = nz;
      vData[off + 7] = mesh.colors[v * 4 + 3];
      vData[off + 8] = mesh.colors[v * 4 + 0];
      vData[off + 9] = mesh.colors[v * 4 + 1];
      vData[off + 10] = mesh.colors[v * 4 + 2];
      vData[off + 12] = mesh.aoShadowSub[v * 3 + 0];
      vData[off + 13] = mesh.aoShadowSub[v * 3 + 1];
      vData[off + 14] = mesh.aoShadowSub[v * 3 + 2];
      vData[off + 15] = -1.0;
    }

    iData.set(mesh.indices, 0);

    let vCur = V;
    let iCur = I;
    const sY = isSmoothLive ? -0.53 : -0.532;
    const sRad = isSmoothLive ? 1.72 : 1.45;
    const sMatId = isSmoothLive ? 14.0 : 6.0;
    const cOff = vCur * 16;
    vData[cOff + 0] = 0.0;
    vData[cOff + 1] = sY;
    vData[cOff + 2] = 0.0;
    vData[cOff + 3] = sMatId;
    vData[cOff + 4] = 0.0;
    vData[cOff + 5] = 1.0;
    vData[cOff + 6] = 0.0;
    vData[cOff + 7] = 1.0;
    vData[cOff + 8] = 1.0;
    vData[cOff + 9] = 212 / 255;
    vData[cOff + 10] = 59 / 255;
    vData[cOff + 15] = 1.0;

    for (let s = 0; s < shadowSegs; s++) {
      const ang = (s / shadowSegs) * Math.PI * 2;
      const ux = Math.cos(ang);
      const uz = Math.sin(ang);
      const pOff = (vCur + 1 + s) * 16;
      vData[pOff + 0] = ux * sRad;
      vData[pOff + 1] = sY;
      vData[pOff + 2] = uz * sRad;
      vData[pOff + 3] = sMatId;
      vData[pOff + 4] = ux * sRad;
      vData[pOff + 5] = 1.0;
      vData[pOff + 6] = uz * sRad;
      vData[pOff + 7] = 1.0;
      vData[pOff + 8] = 1.0;
      vData[pOff + 9] = 212 / 255;
      vData[pOff + 10] = 59 / 255;
      vData[pOff + 15] = 1.0;

      const nextS = (s + 1) % shadowSegs;
      iData[iCur++] = vCur;
      iData[iCur++] = vCur + 1 + nextS;
      iData[iCur++] = vCur + 1 + s;
    }
    vCur += shadowV;

    if (sel) {
      const gx = sel.pos[0];
      const gy = sel.pos[1];
      const gz = sel.pos[2];
      const rad = 0.032;
      const pts = [
        [gx + rad, gy, gz, 0.98, 0.26, 0.28],
        [gx - rad, gy, gz, 0.98, 0.26, 0.28],
        [gx, gy + rad, gz, 0.18, 0.82, 0.38],
        [gx, gy - rad, gz, 0.18, 0.82, 0.38],
        [gx, gy, gz + rad, 0.16, 0.56, 0.96],
        [gx, gy, gz - rad, 0.16, 0.56, 0.96],
      ];
      for (let k = 0; k < 6; k++) {
        const gOff = (vCur + k) * 16;
        vData[gOff + 0] = pts[k][0];
        vData[gOff + 1] = pts[k][1];
        vData[gOff + 2] = pts[k][2];
        vData[gOff + 3] = 5.0;
        vData[gOff + 5] = 1.0;
        vData[gOff + 7] = 0.2;
        vData[gOff + 8] = pts[k][3];
        vData[gOff + 9] = pts[k][4];
        vData[gOff + 10] = pts[k][5];
        vData[gOff + 15] = 1.0;
      }
      const faces = [
        [0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0],
        [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5],
      ];
      for (const f of faces) {
        iData[iCur++] = vCur + f[0];
        iData[iCur++] = vCur + f[1];
        iData[iCur++] = vCur + f[2];
      }
    }

    this._cachedStream = {
      vData,
      iData,
      indexCount: totalI,
      gizmoIndexCount: gizmoI,
      blocksUniformData,
      instanceCount: 1,
      totalTriangles: mesh.triangleCount,
      version: ++this._streamVersion,
    };
    return this._cachedStream;
  }

  toJSONSpec() {
    return {
      format: "fun-sdf-lowpoly-v1",
      asset: this.assetId,
      voxelSize: this.voxelSize,
      shadingMode: this.shadingMode,
      blocks: this.blocks,
    };
  }
}
