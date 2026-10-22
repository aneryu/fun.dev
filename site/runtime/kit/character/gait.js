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

/**
 * Where a clip's feet are down: per foot (l_foot, r_foot), per frame, 1 while it is within 3 cm of
 * its lowest and not moving forward (the stance, from landing to push-off), else 0.
 */
export function clipContacts(skeleton, tracks) {
  const feet = trackPositions(skeleton, tracks, ["l_foot", "r_foot"]), n = tracks.times.length, dt = tracks.duration / n;
  return Object.fromEntries(Object.entries(feet).map(([id, ps]) => {
    const low = Math.min(...ps.map((p) => p[1]));
    return [id, Float32Array.from(ps, (p, f) => (p[1] < low + 0.03 && (ps[(f + 1) % n][2] - p[2]) / dt < 0.3 ? 1 : 0))];
  }));
}

/**
 * Where a clip's feet pass each other: the phases (from its left foot's contact, as the gait keeps
 * them) at which the left ankle comes level with the right, front to back, twice a cycle.
 */
export function clipPassing(skeleton, tracks) {
  const feet = trackPositions(skeleton, tracks, ["l_foot", "r_foot"]), n = tracks.times.length, { contact } = clipGait(skeleton, tracks), out = [];
  const gap = (f) => feet.l_foot[f % n][2] - feet.r_foot[f % n][2];
  for (let f = 0; f < n; f++) {
    const a = gap(f), b = gap(f + 1);
    if (a === 0 || a * b < 0) out.push((((f + a / (a - b || 1)) / n - contact) % 1 + 1) % 1);
  }
  return out.length ? out : [0];
}

/**
 * Gait over locomotion clips: `update(dt, speed)` gives the blended pose, the clips' weights and
 * where the feet are down (`contacts`: per foot, 0 to 1, blended as the clips are; standing, 1).
 */
export function createGait(skeleton, clips) {
  const entries = clips.map((tracks) => ({ tracks, ...clipGait(skeleton, tracks), down: clipContacts(skeleton, tracks), passing: clipPassing(skeleton, tracks) })).sort((a, b) => a.speed - b.speed);
  const idle = entries[0].speed < 0.3 ? entries.shift() : null;
  if (!entries.length) throw new Error("a gait needs a moving clip");
  let phase = 0, idleTime = 0, moving = 0, pace = 0, settled = false, plan = null;
  // The arms go from a walk's to a run's (straight to bent, their swing) over ARMS seconds, as the
  // speed passes between the two kinds of gait: the legs pass the gap in a stride, too quickly for
  // the arms' change. Without a run among the clips, they are the legs'.
  const arms = skeleton.bones.map((b) => b.id).filter((id) => /clavicle|arm|hand|finger/.test(id));
  const running = (e) => /jog|run|sprint/i.test(e.tracks.name ?? "");
  const kinds = [entries.filter((e) => !running(e)), entries.filter(running)];
  const split = kinds.every((k) => k.length) ? (kinds[0].at(-1).speed + kinds[1][0].speed) / 2 : null;
  let armRun = 0;
  const pair = (speed, among = entries) => {
    let k = among.findIndex((e) => e.speed >= speed);
    if (k < 0) k = among.length - 1;
    const b = among[k], a = k > 0 ? among[k - 1] : null;
    return { a, b, w: a ? Math.min(1, Math.max(0, (speed - a.speed) / (b.speed - a.speed))) : 1 };
  };
  return {
    clips: [...(idle ? [idle] : []), ...entries].map(({ tracks, speed, contact }) => ({ name: tracks.name, speed, contact })),
    /**
     * The pose after `dt` seconds at `speed` m/s (and the clips' weights). Given `stop` (a stop is
     * asked: by default, a speed of 0.15 m/s or less), the gait ends its step: it slows its last
     * steps to a halt at the next moment both feet are down (a run's, one), and says how fast the
     * body goes meanwhile (`travel`, m/s), so the feet planted do not slide.
     */
    update(dt, asked, { stop = asked <= 0.15 } = {}) {
      idleTime = (idleTime + dt) % (idle?.tracks.duration ?? 1);
      // The clips are chosen and blended by a speed that changes at most PACE m/s², so however
      // quickly the walker's own speed changes, no gait gives way to another within a frame or two;
      // stopping, the blend holds while the step ends and the idle comes in.
      // Standing, the next move starts from its own speed, as a foot passes the other (feet closest
      // together, as they stand), never mid-stride.
      if (moving === 0) { pace = asked; phase = entries[0].passing[0] ?? 0; settled = false; plan = null; }
      else if (!stop) pace += Math.max(-PACE * dt, Math.min(PACE * dt, asked - pace));
      const speed = pace;
      // The moving clips either side of the speed (clamped to the fastest), and the idle below the slowest.
      const { a, b, w } = pair(speed);
      if (split != null) armRun = moving === 0 ? +(speed > split) : Math.min(1, Math.max(0, armRun + (speed > split ? dt : -dt) / ARMS));
      const cycle = a ? a.tracks.duration + (b.tracks.duration - a.tracks.duration) * w : b.tracks.duration;
      // Moving or standing (above 0.15 m/s, or not): the idle comes and goes over STEP_IN seconds,
      // whatever the speed on the way, and the clips always play at their own pace (below the
      // slowest, its pace: the walker's speed is there only on the way in or out).
      // A stop ends the step: at the next phase where a foot passes the other (the feet closest
      // together, so the idle sets the passing foot down beside the other rather than dragging one
      // up), reached as the phase slows from its own rate to a halt (evenly, over twice the time it
      // would take; sooner, within SETTLE, by slowing later), the body slowing with it.
      let travel = null;
      if (!stop) { settled = false; plan = null; }
      if (stop && !settled && moving > 0) {
        if (!plan) {
          const passes = (w < 0.5 && a ? a : b).passing;
          const ahead = Math.min(...passes.map((p) => (((p - phase) % 1) + 1) % 1).map((d) => (d < 0.02 ? d + 0.5 : d)));
          const time = Math.min(2 * ahead * cycle, Math.max(SETTLE, 1.3 * ahead * cycle));
          // The rate from 1 / cycle as (1 - t / time)^n, which goes `ahead` in `time`.
          plan = { time, t: 0, rate: 1 / cycle, n: time / (ahead * cycle) - 1, speed: Math.min(pace, Math.max(asked, 0)) };
        }
        plan.t += dt;
        const rate = plan.rate * Math.max(0, 1 - plan.t / plan.time) ** plan.n;
        phase = (phase + rate * dt) % 1;
        // (Never faster than the body was going: a step hurried to its end does not push it on.)
        travel = plan.speed * Math.min(1, rate * cycle);
        if (plan.t >= plan.time) settled = true;
      }
      else if (moving > 0 && !(stop && settled)) phase = (phase + dt / cycle) % 1;
      const at = (e) => sample(e.tracks, ((phase + e.contact) % 1) * e.tracks.duration);
      const downAt = (e) => {
        const n = e.tracks.times.length, x = ((phase + e.contact) % 1) * n, f = Math.floor(x) % n, g = (f + 1) % n, u = x - Math.floor(x);
        return Object.fromEntries(Object.entries(e.down).map(([id, d]) => [id, d[f] + (d[g] - d[f]) * u]));
      };
      moving = idle ? Math.min(1, Math.max(0, moving + (!stop ? dt : settled ? -dt : 0) / STEP_IN)) : 1;
      let pose = a ? blend(at(a), at(b), w) : at(b);
      if (split != null) {
        const of = (among) => { const p = pair(speed, among); return p.a ? blend(at(p.a), at(p.b), p.w) : at(p.b); };
        const own = blend(of(kinds[0]), of(kinds[1]), smooth(armRun));
        for (const id of arms) if (own.rotations[id]) pose.rotations[id] = own.rotations[id];
      }
      let contacts = a ? mixed(downAt(a), downAt(b), w) : downAt(b);
      if (idle && moving < 1) {
        pose = blend(sample(idle.tracks, idleTime), pose, smooth(moving));
        contacts = mixed({ l_foot: 1, r_foot: 1 }, contacts, smooth(moving));
      }
      const weights = {};
      if (a) weights[a.tracks.name] = (1 - w) * smooth(moving);
      weights[b.tracks.name] = (a ? w : 1) * smooth(moving);
      if (idle) weights[idle.tracks.name] = (weights[idle.tracks.name] ?? 0) + 1 - smooth(moving);
      return { ...pose, weights, contacts, travel };
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
const STEP_IN = 0.3;   // seconds the idle takes to give way to moving, or back
const PACE = 4;        // m/s², the most the speed the clips are blended by changes
const ARMS = 0.4;      // seconds the arms take from a walk's to a run's, or back
const SETTLE = 0.6;    // seconds a stop's last step takes at most
const mixed = (p, q, w) => Object.fromEntries(Object.keys(p).map((id) => [id, p[id] + ((q[id] ?? p[id]) - p[id]) * w]));
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
