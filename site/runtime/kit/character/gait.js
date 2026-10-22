// Gait for generated characters (docs/character-generator.md#gait): locomotion clips (tracks from
// `clipTracks`) blended by speed. Each clip's ground speed is measured from its stance foot; the
// clips are lined up on the left foot's contact, and the two clips either side of the wanted speed
// play at one phase, so the feet stay in step through the blend. Idle keeps its own clock.
//
//   const gait = createGait(skeleton, [idle, walk, run, sprint]);      // tracks, any order
//   const pose = gait.update(dt, speed);     // { rotations: { boneId: [x, y, z, w] }, hips: [x, y, z], weights }

/**
 * World positions of `ids` at each frame of a clip's tracks: forward kinematics from the rest pose
 * (each bone's rest offset from its parent, turned with the parent).
 */
export function trackPositions(skeleton, tracks, ids) {
  const { bones } = skeleton, n = tracks.times.length, want = new Set(ids);
  const out = Object.fromEntries(ids.map((id) => [id, []]));
  const offsets = bones.map((b) => (b.parentIndex < 0 ? null : rotate(inv(bones[b.parentIndex].rotation), b.position.map((v, k) => v - bones[b.parentIndex].position[k]))));
  for (let f = 0; f < n; f++) {
    const world = [], pos = [];
    bones.forEach((b, i) => {
      const local = Array.from(tracks.rotations[b.id].subarray(f * 4, f * 4 + 4));
      if (b.parentIndex < 0) { world[i] = local; pos[i] = Array.from(tracks.hips.subarray(f * 3, f * 3 + 3)); }
      else { world[i] = mul(world[b.parentIndex], local); pos[i] = add(pos[b.parentIndex], rotate(world[b.parentIndex], offsets[i])); }
      if (want.has(b.id)) out[b.id].push(pos[i]);
    });
  }
  return out;
}

/**
 * A clip's gait: its ground speed (m/s, the stance foot's mean backward speed while it is down)
 * and the phase in [0, 1) where the left foot is furthest forward, about to take the weight.
 */
export function clipGait(skeleton, tracks) {
  const feet = trackPositions(skeleton, tracks, ["l_foot", "r_foot"]), n = tracks.times.length, dt = tracks.duration / n;
  const speeds = [], lowest = Object.fromEntries(Object.entries(feet).map(([id, ps]) => [id, Math.min(...ps.map((p) => p[1]))]));
  for (let f = 0; f < n; f++) {
    const g = (f + 1) % n;
    // The stance foot is the lower one, while it is down (within 3 cm of its lowest; in a run's
    // flight both feet are up).
    for (const id of ["l_foot", "r_foot"]) {
      const other = id === "l_foot" ? "r_foot" : "l_foot";
      if (feet[id][f][1] <= feet[other][f][1] && feet[id][f][1] < lowest[id] + 0.03) speeds.push(-(feet[id][g][2] - feet[id][f][2]) / dt);
    }
  }
  // The mean of its backward speed: the ground it covers over the time it is down.
  const speed = speeds.length ? Math.max(0, speeds.reduce((s, v) => s + v, 0) / speeds.length) : 0;
  let contact = 0;
  feet.l_foot.forEach((p, f) => { if (p[2] - feet.r_foot[f][2] > feet.l_foot[contact][2] - feet.r_foot[contact][2]) contact = f; });
  return { speed, contact: contact / n };
}

/** Gait over locomotion clips: `update(dt, speed)` gives the blended pose. */
export function createGait(skeleton, clips) {
  const entries = clips.map((tracks) => ({ tracks, ...clipGait(skeleton, tracks) })).sort((a, b) => a.speed - b.speed);
  const idle = entries[0].speed < 0.3 ? entries.shift() : null;
  if (!entries.length) throw new Error("a gait needs a moving clip");
  let phase = 0, idleTime = 0;
  return {
    clips: [...(idle ? [idle] : []), ...entries].map(({ tracks, speed, contact }) => ({ name: tracks.name, speed, contact })),
    /** The pose after `dt` seconds at `speed` m/s (and the clips' weights). */
    update(dt, speed) {
      idleTime = (idleTime + dt) % (idle?.tracks.duration ?? 1);
      // The moving clips either side of the speed (clamped to the fastest), and the idle below the slowest.
      let k = entries.findIndex((e) => e.speed >= speed);
      if (k < 0) k = entries.length - 1;
      const b = entries[k], a = k > 0 ? entries[k - 1] : null;
      const w = a ? Math.min(1, Math.max(0, (speed - a.speed) / (b.speed - a.speed))) : 1;
      const cycle = a ? a.tracks.duration + (b.tracks.duration - a.tracks.duration) * w : b.tracks.duration;
      // Below the slowest clip, it plays slower to keep its feet planted (down to 30 % of its pace),
      // and idle fades in only under half its speed.
      const rate = a ? 1 : Math.min(1, Math.max(0.3, speed / b.speed));
      const moving = idle && !a ? Math.min(1, Math.max(0, (speed - 0.1) / (0.5 * b.speed - 0.1))) : 1;
      if (moving > 0) phase = (phase + (dt / cycle) * rate) % 1;
      const at = (e) => sample(e.tracks, ((phase + e.contact) % 1) * e.tracks.duration);
      let pose = a ? blend(at(a), at(b), w) : at(b);
      if (idle && !a && moving < 1) pose = blend(sample(idle.tracks, idleTime), pose, smooth(moving));
      const weights = {};
      if (idle && !a) { weights[idle.tracks.name] = 1 - smooth(moving); weights[b.tracks.name] = smooth(moving); }
      else { if (a) weights[a.tracks.name] = 1 - w; weights[b.tracks.name] = w; }
      return { ...pose, weights };
    },
  };
}

/** A clip's pose at time t (looping), linear between frames. */
export function sample(tracks, t) {
  const n = tracks.times.length, x = ((t / tracks.duration) * n) % n, f = Math.floor(x), g = (f + 1) % n, u = x - f;
  const rotations = {};
  for (const [id, q] of Object.entries(tracks.rotations)) rotations[id] = nlerp(Array.from(q.subarray(f * 4, f * 4 + 4)), Array.from(q.subarray(g * 4, g * 4 + 4)), u);
  const h = tracks.hips, hips = [0, 1, 2].map((k) => h[f * 3 + k] + (h[g * 3 + k] - h[f * 3 + k]) * u);
  return { rotations, hips };
}

function blend(p, q, w) {
  const rotations = {};
  for (const id of Object.keys(p.rotations)) rotations[id] = q.rotations[id] ? nlerp(p.rotations[id], q.rotations[id], w) : p.rotations[id];
  return { rotations, hips: p.hips.map((v, k) => v + (q.hips[k] - v) * w) };
}

const smooth = (x) => x * x * (3 - 2 * x);
function nlerp(a, b, t) {
  const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const q = a.map((v, k) => v + (s * b[k] - v) * t), l = Math.hypot(...q) || 1;
  return q.map((v) => v / l);
}
function mul([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
const inv = ([x, y, z, w]) => [-x, -y, -z, w];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
function rotate([x, y, z, w], v) {
  const u = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]], t = [2 * u[0], 2 * u[1], 2 * u[2]];
  return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
}
