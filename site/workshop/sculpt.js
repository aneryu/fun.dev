// Sculpting (docs/model-editor.md "Dense meshes and sculpting"): brushes that move a mesh's
// vertices along a stroke. The same code runs an agent's stroke (the sculpt command) and the
// page's pointer strokes, so what a person drew replays exactly as the command it commits.
//
// A stroke is data: the brush, points along it (on or near the surface, in the part's own
// metres unless the command's space is world), a radius, a strength, a falloff, the spacing of
// dabs along the points, invert, mirror axes and optional pressure per point. Dabs are laid
// every spacing × radius along the points; each moves the vertices within the radius by the
// brush's rule, weighted by the falloff of their distance to the dab's centre:
//
//   grab     the vertices under the first point follow the stroke (strength 1 by default)
//   smooth   towards the mean of their neighbours
//   inflate  along their own normals (invert: deflate)
//   clay     up to a plane a little above the surface under the dab (invert: scrape down)
//   flatten  onto the mean plane of the surface under the dab
//   crease   pinched towards the dab's centre and pressed in (invert: a raised ridge)
import { fail, number } from "./mesh.js";
import { falloffWeight, FALLOFF_SHAPES } from "./deform.js";

export const BRUSHES = ["grab", "smooth", "inflate", "clay", "flatten", "crease"];
// Per-dab movement as a share of the radius at strength 1 (inflate, clay, crease) and the
// share of the way to their target (smooth, flatten, clay, pinch).
const RATE = { inflate: 0.1, clay: 0.08, crease: 0.08, pinch: 0.4, smooth: 1, flatten: 0.5 };

export function normalizeStroke(command, path = "") {
  const at = (k) => (path ? `${path}.${k}` : k);
  const brush = command.brush;
  if (!BRUSHES.includes(brush)) fail(`brush is one of ${BRUSHES.join(", ")}`, at("brush"));
  const points = command.points;
  if (!Array.isArray(points) || !points.length || points.length > 4096) fail("points lists 1–4096 points of the stroke", at("points"));
  for (const [i, p] of points.entries())
    if (!Array.isArray(p) || p.length !== 3 || p.some((v) => !Number.isFinite(v) || Math.abs(v) > 10000))
      fail("A stroke point is [x, y, z]", at(`points.${i}`));
  if (brush === "grab" && points.length < 2) fail("A grab stroke needs at least two points: from and to", at("points"));
  const radius = number(command.radius, 0.0001, 10000, at("radius")),
    strength = number(command.strength ?? (brush === "grab" ? 1 : 0.5), 0, 1, at("strength")),
    spacing = number(command.spacing ?? 0.25, 0.02, 4, at("spacing")),
    falloff = command.falloff ?? "smooth";
  if (!FALLOFF_SHAPES.includes(falloff)) fail(`falloff is one of ${FALLOFF_SHAPES.join(", ")}`, at("falloff"));
  const symmetry = command.symmetry === undefined ? [] : Array.isArray(command.symmetry) ? command.symmetry : [command.symmetry];
  for (const axis of symmetry) if (!["x", "y", "z"].includes(axis)) fail('symmetry lists axes "x", "y" or "z"', at("symmetry"));
  if (new Set(symmetry).size !== symmetry.length) fail("symmetry lists each axis once", at("symmetry"));
  const pressure = command.pressure;
  if (pressure !== undefined && (!Array.isArray(pressure) || pressure.length !== points.length || pressure.some((v) => !(v >= 0 && v <= 1))))
    fail("pressure gives 0–1 per point", at("pressure"));
  if (command.invert !== undefined && typeof command.invert !== "boolean") fail("invert is true or false", at("invert"));
  return { brush, points, radius, strength, spacing, falloff, invert: !!command.invert, symmetry, pressure: pressure ?? null };
}

// Dab centres every `step` along a polyline, with pressure interpolated; the first point is
// always a dab. Incremental: add(point) yields the dabs a new point completes, so a pointer
// stroke lays exactly the dabs the committed command will.
export class DabSampler {
  constructor(step) {
    this.step = step;
    this.last = null;
    this.carry = 0;
  }
  add(point, pressure = 1) {
    const out = [];
    if (!this.last) {
      out.push({ at: [...point], pressure });
      this.last = { at: [...point], pressure };
      this.carry = 0;
      return out;
    }
    const a = this.last.at,
      d = [point[0] - a[0], point[1] - a[1], point[2] - a[2]],
      length = Math.hypot(...d);
    let travelled = this.step - this.carry;
    while (travelled <= length + 1e-12) {
      const t = length > 0 ? travelled / length : 0;
      out.push({
        at: [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t],
        pressure: this.last.pressure + (pressure - this.last.pressure) * t,
      });
      travelled += this.step;
    }
    this.carry = length - (travelled - this.step);
    this.last = { at: [...point], pressure };
    return out;
  }
}

// A uniform grid of vertices (CSR over hashed cells), for the vertices within a radius.
class VertexGrid {
  constructor(positions, cell) {
    const V = positions.length / 3;
    this.cell = cell;
    let size = 1;
    while (size < 2 * V) size <<= 1;
    this.mask = size - 1;
    const keys = new Uint32Array(V),
      counts = new Uint32Array(size + 1);
    for (let i = 0; i < V; i++) {
      const k = this.key(Math.floor(positions[3 * i] / cell), Math.floor(positions[3 * i + 1] / cell), Math.floor(positions[3 * i + 2] / cell));
      keys[i] = k;
      counts[k + 1]++;
    }
    for (let k = 0; k < size; k++) counts[k + 1] += counts[k];
    const fill = counts.slice(0, size),
      items = new Uint32Array(V);
    for (let i = 0; i < V; i++) items[fill[keys[i]]++] = i;
    this.starts = counts;
    this.items = items;
  }
  key(x, y, z) {
    return ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0) & this.mask;
  }
  // Calls visit(i, distance²) for the vertices within `radius` of c (current positions).
  near(positions, c, radius, visit, seen, stamp) {
    const r2 = radius * radius,
      cell = this.cell,
      x0 = Math.floor((c[0] - radius) / cell),
      x1 = Math.floor((c[0] + radius) / cell),
      y0 = Math.floor((c[1] - radius) / cell),
      y1 = Math.floor((c[1] + radius) / cell),
      z0 = Math.floor((c[2] - radius) / cell),
      z1 = Math.floor((c[2] + radius) / cell);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) {
          const k = this.key(x, y, z);
          for (let n = this.starts[k]; n < this.starts[k + 1]; n++) {
            const i = this.items[n];
            if (seen[i] === stamp) continue;
            seen[i] = stamp;
            const dx = positions[3 * i] - c[0],
              dy = positions[3 * i + 1] - c[1],
              dz = positions[3 * i + 2] - c[2],
              d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= r2) visit(i, d2);
          }
        }
  }
}

// The sculpting state of one mesh: its positions (changed in place: a working copy), its
// faces, and what the brushes need from them.
export class Sculptor {
  constructor({ positions, offsets, indices }, { radius }) {
    this.positions = positions;
    this.offsets = offsets;
    this.indices = indices;
    const V = positions.length / 3,
      F = offsets.length - 1;
    this.V = V;
    // Faces around each vertex (CSR) and neighbours along face edges (CSR).
    const counts = new Uint32Array(V + 1);
    for (let k = 0; k < indices.length; k++) counts[indices[k] + 1]++;
    for (let v = 0; v < V; v++) counts[v + 1] += counts[v];
    const faces = new Uint32Array(indices.length),
      fill = counts.slice(0, V);
    for (let f = 0; f < F; f++) for (let k = offsets[f]; k < offsets[f + 1]; k++) faces[fill[indices[k]]++] = f;
    this.vertexFaceStarts = counts;
    this.vertexFaces = faces;
    this.seen = new Uint32Array(V);
    this.faceSeen = new Uint32Array(F);
    this.faceNormal = new Float64Array(3 * F);
    this.stamp = 0;
    this.grid = new VertexGrid(positions, radius);
    this.radius = radius;
    this.slack = 0; // how far vertices may have moved since the grid was built
    this.neighbourStarts = null;
    this.moved = new Uint8Array(V);
  }
  nextStamp() {
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.faceSeen.fill(0);
      this.stamp = 1;
    }
    return this.stamp;
  }
  neighbours() {
    if (this.neighbourStarts) return;
    const { V, offsets, indices } = this,
      lists = Array.from({ length: V }, () => []);
    for (let f = 0; f + 1 < offsets.length; f++) {
      const a = offsets[f],
        b = offsets[f + 1];
      for (let k = a; k < b; k++) {
        const i = indices[k],
          j = indices[k + 1 < b ? k + 1 : a];
        if (!lists[i].includes(j)) lists[i].push(j);
        if (!lists[j].includes(i)) lists[j].push(i);
      }
    }
    const starts = new Uint32Array(V + 1);
    for (let v = 0; v < V; v++) starts[v + 1] = starts[v] + lists[v].length;
    const all = new Uint32Array(starts[V]);
    for (let v = 0; v < V; v++) all.set(lists[v], starts[v]);
    this.neighbourStarts = starts;
    this.neighbourList = all;
  }
  // The vertices within the radius of c with their falloff weights.
  gather(c, radius, falloff) {
    if (this.slack > radius * 0.5 || radius > this.grid.cell * 2 || radius < this.grid.cell * 0.25) {
      this.grid = new VertexGrid(this.positions, radius);
      this.slack = 0;
    }
    const stamp = this.nextStamp(),
      ids = [],
      weights = [];
    this.grid.near(
      this.positions,
      c,
      radius + this.slack,
      (i, d2) => {
        const d = Math.sqrt(d2);
        if (d > radius) return;
        const w = falloffWeight(falloff, d / radius);
        if (w > 0) {
          ids.push(i);
          weights.push(w);
        }
      },
      this.seen,
      stamp,
    );
    return { ids, weights };
  }
  // Unit normal of face f from the current positions (Newell), cached for this dab.
  normalOf(f, stamp) {
    const n = this.faceNormal;
    if (this.faceSeen[f] === stamp) return f;
    const p = this.positions,
      a = this.offsets[f],
      b = this.offsets[f + 1],
      idx = this.indices;
    let x = 0,
      y = 0,
      z = 0;
    for (let k = a; k < b; k++) {
      const i = idx[k],
        j = idx[k + 1 < b ? k + 1 : a];
      x += (p[3 * i + 1] - p[3 * j + 1]) * (p[3 * i + 2] + p[3 * j + 2]);
      y += (p[3 * i + 2] - p[3 * j + 2]) * (p[3 * i] + p[3 * j]);
      z += (p[3 * i] - p[3 * j]) * (p[3 * i + 1] + p[3 * j + 1]);
    }
    // Area-weighted: keep the length (twice the area).
    n[3 * f] = x;
    n[3 * f + 1] = y;
    n[3 * f + 2] = z;
    this.faceSeen[f] = stamp;
    return f;
  }
  vertexNormal(i, stamp, out) {
    let x = 0,
      y = 0,
      z = 0;
    for (let k = this.vertexFaceStarts[i]; k < this.vertexFaceStarts[i + 1]; k++) {
      const f = this.normalOf(this.vertexFaces[k], stamp);
      x += this.faceNormal[3 * f];
      y += this.faceNormal[3 * f + 1];
      z += this.faceNormal[3 * f + 2];
    }
    const l = Math.hypot(x, y, z) || 1;
    out[0] = x / l;
    out[1] = y / l;
    out[2] = z / l;
    return out;
  }
  // The weighted mean position and normal of the surface under a dab.
  area(ids, weights, stamp) {
    const c = [0, 0, 0],
      n = [0, 0, 0],
      v = [0, 0, 0];
    let total = 0;
    for (let k = 0; k < ids.length; k++) {
      const i = ids[k],
        w = weights[k],
        p = this.positions;
      c[0] += p[3 * i] * w;
      c[1] += p[3 * i + 1] * w;
      c[2] += p[3 * i + 2] * w;
      this.vertexNormal(i, stamp, v);
      n[0] += v[0] * w;
      n[1] += v[1] * w;
      n[2] += v[2] * w;
      total += w;
    }
    if (!total) return null;
    const l = Math.hypot(...n) || 1;
    return { center: c.map((x) => x / total), normal: n.map((x) => x / l) };
  }
  move(i, dx, dy, dz) {
    const p = this.positions,
      m = Math.hypot(dx, dy, dz);
    p[3 * i] += dx;
    p[3 * i + 1] += dy;
    p[3 * i + 2] += dz;
    this.moved[i] = 1;
    if (m > this.maxStep) this.maxStep = m;
  }
  // One dab of a brush at c (not grab: see grabStart and grabMove).
  dab(brush, c, { radius, strength, falloff, invert }) {
    const { ids, weights } = this.gather(c, radius, falloff);
    if (!ids.length) return 0;
    const stamp = this.stamp,
      p = this.positions,
      sign = invert ? -1 : 1;
    this.maxStep = 0;
    if (brush === "smooth") {
      this.neighbours();
      const targets = new Float64Array(3 * ids.length);
      for (let k = 0; k < ids.length; k++) {
        const i = ids[k];
        let x = 0,
          y = 0,
          z = 0,
          n = 0;
        for (let m = this.neighbourStarts[i]; m < this.neighbourStarts[i + 1]; m++) {
          const j = this.neighbourList[m];
          x += p[3 * j];
          y += p[3 * j + 1];
          z += p[3 * j + 2];
          n++;
        }
        if (!n) {
          targets.set([p[3 * i], p[3 * i + 1], p[3 * i + 2]], 3 * k);
          continue;
        }
        targets[3 * k] = x / n;
        targets[3 * k + 1] = y / n;
        targets[3 * k + 2] = z / n;
      }
      for (let k = 0; k < ids.length; k++) {
        const i = ids[k],
          f = weights[k] * strength * RATE.smooth;
        this.move(i, (targets[3 * k] - p[3 * i]) * f, (targets[3 * k + 1] - p[3 * i + 1]) * f, (targets[3 * k + 2] - p[3 * i + 2]) * f);
      }
    } else if (brush === "inflate") {
      const normals = new Float64Array(3 * ids.length),
        v = [0, 0, 0];
      for (let k = 0; k < ids.length; k++) normals.set(this.vertexNormal(ids[k], stamp, v), 3 * k);
      const amount = sign * strength * radius * RATE.inflate;
      for (let k = 0; k < ids.length; k++)
        this.move(ids[k], normals[3 * k] * amount * weights[k], normals[3 * k + 1] * amount * weights[k], normals[3 * k + 2] * amount * weights[k]);
    } else {
      const surface = this.area(ids, weights, stamp);
      if (!surface) return 0;
      const { center, normal: n } = surface;
      if (brush === "flatten") {
        for (let k = 0; k < ids.length; k++) {
          const i = ids[k],
            h = (p[3 * i] - center[0]) * n[0] + (p[3 * i + 1] - center[1]) * n[1] + (p[3 * i + 2] - center[2]) * n[2],
            f = -h * weights[k] * strength * RATE.flatten;
          this.move(i, n[0] * f, n[1] * f, n[2] * f);
        }
      } else if (brush === "clay") {
        // A plane offset from the surface's mean by the dab's depth; what lies short of it
        // moves part of the way there.
        const depth = sign * strength * radius * RATE.clay;
        for (let k = 0; k < ids.length; k++) {
          const i = ids[k],
            h = (p[3 * i] - center[0]) * n[0] + (p[3 * i + 1] - center[1]) * n[1] + (p[3 * i + 2] - center[2]) * n[2],
            gap = sign > 0 ? Math.max(0, depth - h) : Math.min(0, depth - h),
            f = gap * weights[k] * 0.5;
          this.move(i, n[0] * f, n[1] * f, n[2] * f);
        }
      } else {
        // crease: pinch towards the centre along the surface, press in along the normal.
        const press = -sign * strength * radius * RATE.crease;
        for (let k = 0; k < ids.length; k++) {
          const i = ids[k],
            w = weights[k],
            dx = c[0] - p[3 * i],
            dy = c[1] - p[3 * i + 1],
            dz = c[2] - p[3 * i + 2],
            along = dx * n[0] + dy * n[1] + dz * n[2],
            pinch = strength * RATE.pinch * w * (1 - w * 0.5);
          this.move(
            i,
            (dx - along * n[0]) * pinch + n[0] * press * w,
            (dy - along * n[1]) * pinch + n[1] * press * w,
            (dz - along * n[2]) * pinch + n[2] * press * w,
          );
        }
      }
    }
    this.slack += this.maxStep;
    return ids.length;
  }
  // grab: the vertices within the radius of `from` (weights from where they are now) follow
  // each later move by its offset.
  grabStart(from, { radius, falloff }) {
    this.grabbed = this.gather(from, radius, falloff);
  }
  grabMove(delta, strength) {
    const { ids, weights } = this.grabbed;
    this.maxStep = 0;
    for (let k = 0; k < ids.length; k++) {
      const w = weights[k] * strength;
      this.move(ids[k], delta[0] * w, delta[1] * w, delta[2] * w);
    }
    this.slack += this.maxStep;
    return ids.length;
  }
}

// Mirror images of a point for the stroke's symmetry axes (the point itself first).
export function mirrors(point, axes) {
  let out = [point];
  for (const axis of axes) {
    const k = "xyz".indexOf(axis);
    out = out.flatMap((p) => [p, p.map((v, j) => (j === k ? -v : v))]);
  }
  return out;
}

// Runs a whole stroke on a working Sculptor; returns { dabs, vertices } (vertices moved).
export function runStroke(sculptor, stroke) {
  const { brush, points, radius, strength, spacing, falloff, invert, symmetry, pressure } = stroke;
  const options = { radius, strength, falloff, invert };
  let dabs = 0;
  if (brush === "grab") {
    // One grabbed region per mirror image; each follows the stroke's mirrored offsets.
    const starts = mirrors(points[0], symmetry),
      grabs = starts.map((from) => {
        sculptor.grabStart(from, options);
        return sculptor.grabbed;
      });
    for (let n = 1; n < points.length; n++) {
      const delta = [0, 1, 2].map((k) => points[n][k] - points[n - 1][k]),
        deltas = mirrors(delta, symmetry),
        s = strength * (pressure ? pressure[n] : 1);
      grabs.forEach((grab, m) => {
        sculptor.grabbed = grab;
        sculptor.grabMove(deltas[m], s);
      });
      dabs++;
    }
  } else {
    const sampler = new DabSampler(spacing * radius);
    points.forEach((point, n) => {
      for (const dab of sampler.add(point, pressure ? pressure[n] : 1))
        for (const centre of mirrors(dab.at, symmetry)) {
          sculptor.dab(brush, centre, { ...options, strength: strength * dab.pressure });
          dabs++;
        }
    });
  }
  let vertices = 0;
  for (let i = 0; i < sculptor.V; i++) vertices += sculptor.moved[i];
  return { dabs, vertices };
}
