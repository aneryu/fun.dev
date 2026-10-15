// Jelly flesh: a damped wave equation on the face mesh, in the head's local frame.
//
// Each vertex has a displacement u from its rest position. Forces per unit mass:
//   anchor     -k_a(i) u_i                  pulls flesh back (stiff on bone, soft on cheeks)
//   coupling   k_e Σ_j (u_j - u_i)          spreads a hit across the face as a wave
//   damping    -c v_i
//   inertia    -mobility(i) a_rigid(i)       flesh lags behind the head's own motion
// Integrated with semi-implicit Euler in substeps short enough for the stiffest mode.

export function edgesFromTriangles(triangles, vertexCount) {
  const neighbours = Array.from({ length: vertexCount }, () => new Set());
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2];
    neighbours[a].add(b).add(c); neighbours[b].add(a).add(c); neighbours[c].add(a).add(b);
  }
  const start = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < vertexCount; i++) start[i + 1] = start[i] + neighbours[i].size;
  const list = new Uint32Array(start[vertexCount]);
  for (let i = 0; i < vertexCount; i++) list.set([...neighbours[i]], start[i]);
  return { start, list };
}

export function createSoftBody({ rest, triangles, stiffness, mobility }) {
  const count = rest.length / 3;
  const { start, list } = edgesFromTriangles(triangles, count);
  const u = new Float32Array(count * 3);
  const v = new Float32Array(count * 3);
  const lap = new Float32Array(count * 3);
  const params = { anchor: 600, coupling: 9000, damping: 4.5, maxDisplacement: 0.035, substep: 1 / 240 };
  let maxStiffness = 0, maxDegree = 0;
  for (let i = 0; i < count; i++) { maxStiffness = Math.max(maxStiffness, stiffness[i]); maxDegree = Math.max(maxDegree, start[i + 1] - start[i]); }
  let energy = 0;
  let restRef = rest;

  // a_rigid at a local point r, for linear acceleration a, angular velocity w and angular acceleration al (all local).
  function step(dt, rigid) {
    const { anchor, coupling, damping, maxDisplacement } = params;
    for (let i = 0; i < count; i++) {
      let lx = 0, ly = 0, lz = 0;
      const ix = i * 3;
      const ux = u[ix], uy = u[ix + 1], uz = u[ix + 2];
      for (let e = start[i]; e < start[i + 1]; e++) {
        const j = list[e] * 3;
        lx += u[j] - ux; ly += u[j + 1] - uy; lz += u[j + 2] - uz;
      }
      lap[ix] = lx; lap[ix + 1] = ly; lap[ix + 2] = lz;
    }
    const { a, w, al } = rigid;
    let total = 0;
    for (let i = 0; i < count; i++) {
      const ix = i * 3;
      const k = anchor * stiffness[i];
      const m = mobility[i];
      // Rigid acceleration of this point: a + al × r + w × (w × r).
      const rx = restRef[ix], ry = restRef[ix + 1], rz = restRef[ix + 2];
      const wr0 = w[1] * rz - w[2] * ry, wr1 = w[2] * rx - w[0] * rz, wr2 = w[0] * ry - w[1] * rx;
      const ax = a[0] + al[1] * rz - al[2] * ry + w[1] * wr2 - w[2] * wr1;
      const ay = a[1] + al[2] * rx - al[0] * rz + w[2] * wr0 - w[0] * wr2;
      const az = a[2] + al[0] * ry - al[1] * rx + w[0] * wr1 - w[1] * wr0;
      for (let c = 0; c < 3; c++) {
        const f = -k * u[ix + c] + coupling * m * lap[ix + c] - damping * v[ix + c] - m * (c === 0 ? ax : c === 1 ? ay : az);
        v[ix + c] += f * dt;
        u[ix + c] += v[ix + c] * dt;
      }
      const d2 = u[ix] * u[ix] + u[ix + 1] * u[ix + 1] + u[ix + 2] * u[ix + 2];
      const limit = maxDisplacement * (0.25 + m);
      if (d2 > limit * limit) {
        const s = limit / Math.sqrt(d2);
        u[ix] *= s; u[ix + 1] *= s; u[ix + 2] *= s;
        v[ix] *= 0.7; v[ix + 1] *= 0.7; v[ix + 2] *= 0.7;
      }
      total += v[ix] * v[ix] + v[ix + 1] * v[ix + 1] + v[ix + 2] * v[ix + 2] + k * d2;
    }
    energy = total / count;
  }

  return {
    count, u, v, params,
    get energy() { return energy; },
    setRest(next) { restRef = next; },
    // Adds velocity around a local point with a Gaussian falloff (radius in metres).
    impulse(point, velocity, radius, filter = null) {
      const inv = 1 / (2 * radius * radius);
      for (let i = 0; i < count; i++) {
        const ix = i * 3;
        const dx = restRef[ix] - point[0], dy = restRef[ix + 1] - point[1], dz = restRef[ix + 2] - point[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 9 * radius * radius) continue;
        const g = Math.exp(-d2 * inv) * mobility[i] * (filter ? filter(i) : 1);
        v[ix] += velocity[0] * g; v[ix + 1] += velocity[1] * g; v[ix + 2] += velocity[2] * g;
      }
      energy = Math.max(energy, 1);
    },
    advance(delta, rigid) {
      // Explicit integration is stable below 2/ω_max; keep a margin.
      const omega = Math.sqrt(params.anchor * maxStiffness + 2 * maxDegree * params.coupling);
      const steps = Math.min(32, Math.ceil(delta / Math.min(params.substep, 1.4 / omega)));
      const dt = delta / Math.max(1, steps);
      for (let s = 0; s < steps; s++) step(dt, rigid);
    },
    reset() { u.fill(0); v.fill(0); energy = 0; },
  };
}
