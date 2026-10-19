// Sculpting (docs/model-editor.md "Dense meshes and sculpting"): brushes that move a mesh's
// vertices along a stroke. The same code runs an agent's stroke (the sculpt command) and the
// page's pointer strokes, so what a person drew replays exactly as the command it commits.
//
// A stroke is data: the brush, points along it (on or near the surface, in the part's own
// metres unless the command's space is world), a radius, a strength, a falloff, the spacing of
// dabs along the points, invert, mirror axes and optional pressure per point. Dabs are laid
// every spacing × radius along the points, each on the closest point of the surface (unless
// onSurface is false; a grab's first point only); each moves the vertices within the radius by the
// brush's rule, weighted by the falloff of their distance to the dab's centre (mirror images of
// a dab that overlap share it: see dabAll):
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
  if (command.onSurface !== undefined && typeof command.onSurface !== "boolean") fail("onSurface is true or false", at("onSurface"));
  return { brush, points, radius, strength, spacing, falloff, invert: !!command.invert, symmetry, pressure: pressure ?? null, onSurface: command.onSurface !== false };
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
      this.reach = undefined; // faces may have grown since it was measured
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
  // How far a point of a face can lie from the face's vertices: at most half its perimeter.
  // Faces far larger than the mean (a cap among small facets) are listed apart, so one of them
  // does not widen every search: reach is the largest of the others.
  faceReach() {
    if (this.reach === undefined) {
      const { positions: p, offsets, indices } = this,
        F = offsets.length - 1,
        half = new Float64Array(F);
      let sum = 0;
      for (let f = 0; f < F; f++) {
        const a = offsets[f],
          b = offsets[f + 1];
        let perimeter = 0;
        for (let k = a; k < b; k++) {
          const i = 3 * indices[k],
            j = 3 * indices[k + 1 < b ? k + 1 : a],
            dx = p[i] - p[j],
            dy = p[i + 1] - p[j + 1],
            dz = p[i + 2] - p[j + 2];
          perimeter += Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        half[f] = perimeter / 2;
        sum += half[f];
      }
      const limit = (4 * sum) / Math.max(1, F);
      let reach = 0;
      this.bigFaces = [];
      for (let f = 0; f < F; f++)
        if (half[f] > limit) this.bigFaces.push(f);
        else if (half[f] > reach) reach = half[f];
      this.reach = reach;
    }
    return this.reach;
  }
  // Calls visit(i, distance²) for the vertices within reach of c: through the grid, or every
  // vertex when the reach spans too many of its cells.
  within(c, reach, visit) {
    const p = this.positions;
    if (reach <= this.grid.cell * 8) return this.grid.near(p, c, reach, visit, this.seen, this.nextStamp());
    const r2 = reach * reach;
    for (let i = 0; i < this.V; i++) {
      const dx = p[3 * i] - c[0],
        dy = p[3 * i + 1] - c[1],
        dz = p[3 * i + 2] - c[2],
        d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= r2) visit(i, d2);
    }
  }
  // The closest point of the surface to c (current positions): on the faces of the vertices
  // that could hold it, those within the nearest vertex's distance and a face's reach.
  closest(c) {
    const p = this.positions;
    let best = -1,
      bestD2 = Infinity;
    const nearest = (i, d2) => {
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    };
    for (let reach = this.grid.cell; best < 0 && reach <= this.grid.cell * 8; reach *= 2) this.within(c, reach + this.slack, nearest);
    if (best < 0) this.within(c, Infinity, nearest);
    if (best < 0) return [...c];
    let out = [p[3 * best], p[3 * best + 1], p[3 * best + 2]],
      outD2 = bestD2;
    const reach = this.faceReach(),
      faces = [...this.bigFaces],
      stamp = this.nextStamp();
    for (const f of faces) this.faceSeen[f] = stamp;
    this.within(c, Math.sqrt(bestD2) + reach + 2 * this.slack, (i) => {
      for (let k = this.vertexFaceStarts[i]; k < this.vertexFaceStarts[i + 1]; k++) {
        const f = this.vertexFaces[k];
        if (this.faceSeen[f] !== stamp) {
          this.faceSeen[f] = stamp;
          faces.push(f);
        }
      }
    });
    const { offsets, indices } = this,
      at = (i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
    for (const f of faces) {
      const a = at(indices[offsets[f]]);
      for (let k = offsets[f] + 1; k + 1 < offsets[f + 1]; k++) {
        const q = closestOnTriangle(c, a, at(indices[k]), at(indices[k + 1])),
          d2 = (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2 + (q[2] - c[2]) ** 2;
        if (d2 < outD2) {
          outD2 = d2;
          out = q;
        }
      }
    }
    return out;
  }
  // A brush's move of vertex i (its falloff weight w): made at once, or, while the mirror
  // images of a dab are evaluated (dabAll), added to the moves they share.
  push(i, w, dx, dy, dz) {
    const s = this.share;
    if (!s) return this.move(i, dx, dy, dz);
    if (s.mark[i] !== s.stamp) {
      s.mark[i] = s.stamp;
      s.touched.push(i);
      s.d[3 * i] = dx;
      s.d[3 * i + 1] = dy;
      s.d[3 * i + 2] = dz;
      s.sum[i] = s.max[i] = w;
    } else {
      s.d[3 * i] += dx;
      s.d[3 * i + 1] += dy;
      s.d[3 * i + 2] += dz;
      s.sum[i] += w;
      if (w > s.max[i]) s.max[i] = w;
    }
  }
  // A dab at each mirror image of a centre, all evaluated on the same positions. Where the
  // images overlap, a vertex moves by its strongest image's weight, shared among the images in
  // proportion to their weights: on the mirror plane a stroke is as strong as without
  // symmetry, and a symmetric mesh stays symmetric.
  dabAll(brush, centres, options) {
    if (centres.length === 1) return this.dab(brush, centres[0], options);
    const V = this.V,
      s = (this.shared ??= { mark: new Uint32Array(V), stamp: 0, d: new Float64Array(3 * V), sum: new Float64Array(V), max: new Float64Array(V), touched: [] });
    if (++s.stamp === 0xffffffff) {
      s.mark.fill(0);
      s.stamp = 1;
    }
    s.touched.length = 0;
    this.share = s;
    let count = 0;
    try {
      for (const c of centres) count += this.dab(brush, c, options);
    } finally {
      this.share = null;
    }
    this.maxStep = 0;
    for (const i of s.touched) {
      const f = s.max[i] / s.sum[i];
      this.move(i, s.d[3 * i] * f, s.d[3 * i + 1] * f, s.d[3 * i + 2] * f);
    }
    this.slack += this.maxStep;
    return count;
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
        this.push(i, weights[k], (targets[3 * k] - p[3 * i]) * f, (targets[3 * k + 1] - p[3 * i + 1]) * f, (targets[3 * k + 2] - p[3 * i + 2]) * f);
      }
    } else if (brush === "inflate") {
      const normals = new Float64Array(3 * ids.length),
        v = [0, 0, 0];
      for (let k = 0; k < ids.length; k++) normals.set(this.vertexNormal(ids[k], stamp, v), 3 * k);
      const amount = sign * strength * radius * RATE.inflate;
      for (let k = 0; k < ids.length; k++)
        this.push(ids[k], weights[k], normals[3 * k] * amount * weights[k], normals[3 * k + 1] * amount * weights[k], normals[3 * k + 2] * amount * weights[k]);
    } else {
      const surface = this.area(ids, weights, stamp);
      if (!surface) return 0;
      const { center, normal: n } = surface;
      if (brush === "flatten") {
        for (let k = 0; k < ids.length; k++) {
          const i = ids[k],
            h = (p[3 * i] - center[0]) * n[0] + (p[3 * i + 1] - center[1]) * n[1] + (p[3 * i + 2] - center[2]) * n[2],
            f = -h * weights[k] * strength * RATE.flatten;
          this.push(i, weights[k], n[0] * f, n[1] * f, n[2] * f);
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
          this.push(i, weights[k], n[0] * f, n[1] * f, n[2] * f);
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
          this.push(
            i,
            w,
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

// Grabbed regions of a stroke's mirror images, their weights scaled so that a vertex in
// several moves by its strongest weight in all (a grab on the mirror plane follows the pointer).
function shareOverlaps(grabs) {
  if (grabs.length === 1) return grabs;
  const sum = new Map(),
    max = new Map();
  for (const { ids, weights } of grabs)
    ids.forEach((i, k) => {
      sum.set(i, (sum.get(i) ?? 0) + weights[k]);
      max.set(i, Math.max(max.get(i) ?? 0, weights[k]));
    });
  return grabs.map(({ ids, weights }) => ({ ids, weights: weights.map((w, k) => (w * max.get(ids[k])) / sum.get(ids[k])) }));
}

// The closest point to p on the triangle abc (Ericson, Real-Time Collision Detection, 5.1.5).
function closestOnTriangle(p, a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
    dot = (u, x, y, z) => u[0] * x + u[1] * y + u[2] * z,
    along = (o, u, t) => [o[0] + u[0] * t, o[1] + u[1] * t, o[2] + u[2] * t];
  const d1 = dot(ab, p[0] - a[0], p[1] - a[1], p[2] - a[2]),
    d2 = dot(ac, p[0] - a[0], p[1] - a[1], p[2] - a[2]);
  if (d1 <= 0 && d2 <= 0) return a;
  const d3 = dot(ab, p[0] - b[0], p[1] - b[1], p[2] - b[2]),
    d4 = dot(ac, p[0] - b[0], p[1] - b[1], p[2] - b[2]);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return along(a, ab, d1 / (d1 - d3));
  const d5 = dot(ab, p[0] - c[0], p[1] - c[1], p[2] - c[2]),
    d6 = dot(ac, p[0] - c[0], p[1] - c[1], p[2] - c[2]);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return along(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return along(b, [c[0] - b[0], c[1] - b[1], c[2] - b[2]], (d4 - d3) / (d4 - d3 + (d5 - d6)));
  const denom = va + vb + vc;
  if (!(denom > 0)) return a; // a degenerate triangle
  const v = vb / denom,
    w = vc / denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
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

// A stroke fed point by point (the page's pointer) or all at once (the command): add(point,
// pressure) lays the dabs the point completes, so both give the same positions.
export class StrokeRunner {
  constructor(sculptor, stroke) {
    this.sculptor = sculptor;
    this.stroke = stroke;
    this.options = { radius: stroke.radius, strength: stroke.strength, falloff: stroke.falloff, invert: stroke.invert };
    this.sampler = new DabSampler(stroke.spacing * stroke.radius);
    this.last = null;
    this.grabs = null;
    this.dabs = 0;
  }
  add(point, pressure = 1) {
    const { sculptor, stroke, options } = this;
    if (stroke.brush === "grab") {
      if (!this.last) {
        // One grabbed region per mirror image; each follows the stroke's mirrored offsets.
        // Where regions overlap, they share the strongest weight (as dabAll does).
        this.grabs = shareOverlaps(
          this.centres(point).map((from) => {
            sculptor.grabStart(from, options);
            return sculptor.grabbed;
          }),
        );
      } else {
        const delta = [0, 1, 2].map((k) => point[k] - this.last[k]),
          deltas = mirrors(delta, stroke.symmetry);
        this.grabs.forEach((grab, m) => {
          sculptor.grabbed = grab;
          sculptor.grabMove(deltas[m], stroke.strength * pressure);
        });
        this.dabs++;
      }
      this.last = [...point];
      return;
    }
    for (const dab of this.sampler.add(point, pressure)) {
      const centres = this.centres(dab.at);
      sculptor.dabAll(stroke.brush, centres, { ...options, strength: stroke.strength * dab.pressure });
      this.dabs += centres.length;
    }
  }
  // A dab's (or a grab's start's) mirror images, each on the closest point of the surface.
  centres(point) {
    const images = mirrors(point, this.stroke.symmetry);
    return this.stroke.onSurface !== false ? images.map((c) => this.sculptor.closest(c)) : images;
  }
  result() {
    let vertices = 0;
    for (let i = 0; i < this.sculptor.V; i++) vertices += this.sculptor.moved[i];
    return { dabs: this.dabs, vertices };
  }
}

// Runs a whole stroke on a working Sculptor; returns { dabs, vertices } (vertices moved).
export function runStroke(sculptor, stroke) {
  const runner = new StrokeRunner(sculptor, stroke);
  stroke.points.forEach((point, n) => runner.add(point, stroke.pressure ? stroke.pressure[n] : 1));
  return runner.result();
}
