// Planted feet for generated characters (docs/character-generator.md#gait). A foot the animation
// puts down is locked where it lands; as the character moves, the ground moves under it (the
// caller says how far: forward travel and turn per step, in the character's own frame), and a
// two-bone IK bends hip and knee so the ankle stays on its spot. It lets go when the animation
// lifts the foot or the leg would have to reach too far. Locks blend in and out over BLEND seconds.
//
//   const feet = createFootLock(skeleton);
//   feet.apply(pose, { forward: speed * dt, turn: yawRate * dt, dt });   // pose from gait.update, changed in place

const BLEND = 0.06;         // seconds to blend a lock in or out (a run's stance lasts about 0.2 s)
const DOWN = 0.025;         // a foot is down within this of its rest height (metres)
const LIFT = 0.04;          // and lifts once the animation raises it this much
const REACH = 0.15;         // a lock lets go when the animated foot is this far from it

const LEGS = ["l", "r"].map((s) => ({ hip: `${s}_thigh`, knee: `${s}_calf`, ankle: `${s}_foot`, roll: `${s}_thigh_roll` }));

export function createFootLock(skeleton) {
  const { bones } = skeleton, index = new Map(bones.map((b, i) => [b.id, i]));
  const offsets = bones.map((b) => (b.parentIndex < 0 ? null : rotate(inv(bones[b.parentIndex].rotation), sub(b.position, bones[b.parentIndex].position))));
  const legs = LEGS.filter((l) => [l.hip, l.knee, l.ankle].every((id) => index.has(id))).map((l) => ({
    ...l, rest: bones[index.get(l.ankle)].position[1], locked: null, weight: 0,
  }));

  /** World rotations and positions of every bone for a pose (in the character's frame). */
  function forward(pose) {
    const world = [], pos = [];
    bones.forEach((b, i) => {
      const local = pose.rotations[b.id] ?? [0, 0, 0, 1];
      if (b.parentIndex < 0) { world[i] = local; pos[i] = pose.hips; }
      else { world[i] = mul(world[b.parentIndex], local); pos[i] = add(pos[b.parentIndex], rotate(world[b.parentIndex], offsets[i])); }
    });
    return { world, pos };
  }

  return {
    get legs() { return legs.map(({ ankle, locked, weight }) => ({ ankle, locked, weight })); },
    /** Plants the feet of `pose` (changed in place) after the ground moved by `forward` metres and `turn` radians. */
    apply(pose, { forward: travel = 0, turn = 0, dt = 1 / 60 } = {}) {
      const { world, pos } = forward(pose);
      for (const leg of legs) {
        const h = index.get(leg.hip), k = index.get(leg.knee), a = index.get(leg.ankle);
        const ankle = pos[a];
        // The ground under a locked foot moves back as the character goes forward and turns.
        if (leg.locked) leg.locked = rotateY(sub(leg.locked, [0, 0, travel]), -turn);
        const down = ankle[1] < leg.rest + DOWN, lifted = ankle[1] > leg.rest + LIFT;
        if (!leg.locked && down && leg.weight === 0) leg.locked = [...ankle];
        if (leg.locked && (lifted || distance(leg.locked, ankle) > REACH)) leg.release = true;
        leg.weight = Math.min(1, Math.max(0, leg.weight + (leg.locked && !leg.release ? dt : -dt) / BLEND));
        if (leg.release && leg.weight === 0) { leg.locked = null; leg.release = false; }
        if (!leg.locked || leg.weight === 0) continue;
        const target = lerp(ankle, [leg.locked[0], ankle[1], leg.locked[2]], leg.weight);
        const [turnHip, turnKnee] = twoBoneIK(pos[h], pos[k], ankle, target);
        // New world rotations: the thigh (and its roll bone) turn by turnHip, the calf by both; the
        // foot keeps its animated world rotation.
        const hipWorld = mul(turnHip, world[h]), kneeWorld = mul(mul(turnKnee, turnHip), world[k]);
        const parentOf = (i) => world[bones[i].parentIndex];
        pose.rotations[leg.hip] = normalize(mul(inv(parentOf(h)), hipWorld));
        pose.rotations[leg.knee] = normalize(mul(inv(hipWorld), kneeWorld));
        pose.rotations[leg.ankle] = normalize(mul(inv(kneeWorld), world[a]));
        if (index.has(leg.roll)) { const r = index.get(leg.roll); pose.rotations[leg.roll] = normalize(mul(inv(parentOf(r)), mul(turnHip, world[r]))); }
        world[h] = hipWorld; world[k] = kneeWorld;
      }
      return pose;
    },
  };
}

/**
 * Two-bone IK: the turns (world quaternions) of the upper bone (about a) and then of the lower bone
 * (about the new b) that bring the end c to `target`, bending in the plane the chain bends in now.
 * Out of reach, the chain straightens towards the target.
 */
export function twoBoneIK(a, b, c, target) {
  const l1 = distance(a, b), l2 = distance(b, c);
  const toTarget = sub(target, a), d = Math.min(Math.max(length(toTarget), Math.abs(l1 - l2) + 1e-6), l1 + l2 - 1e-6);
  const dir = unit(toTarget);
  // The bend: the knee's side of the chain's own line (a to c), turned with the chain towards the target.
  const line = unit(sub(c, a));
  let side = sub(sub(b, a), scale(line, dot(sub(b, a), line)));
  side = length(side) < 1e-9 ? perpendicular(dir) : rotate(fromTo(line, dir), unit(side));
  side = unit(sub(side, scale(dir, dot(side, dir))));
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const knee = add(a, add(scale(dir, l1 * cosA), scale(side, l1 * Math.sqrt(1 - cosA * cosA))));
  const turnUpper = fromTo(unit(sub(b, a)), unit(sub(knee, a)));
  const lowerNow = rotate(turnUpper, sub(c, b));
  const end = add(a, scale(dir, d));
  const turnLower = fromTo(unit(lowerNow), unit(sub(end, knee)));
  return [turnUpper, turnLower];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const distance = (a, b) => length(sub(a, b));
const unit = (a) => scale(a, 1 / (length(a) || 1));
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const perpendicular = (a) => unit(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
const rotateY = ([x, y, z], t) => [x * Math.cos(t) + z * Math.sin(t), y, -x * Math.sin(t) + z * Math.cos(t)];
function fromTo(a, b) {
  const d = dot(a, b);
  if (d < -0.999999) return [...perpendicular(a), 0];
  return normalize([...cross(a, b), 1 + d]);
}
function mul([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
const inv = ([x, y, z, w]) => [-x, -y, -z, w];
function normalize(q) { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); }
function rotate([x, y, z, w], v) {
  const u = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]], t = [2 * u[0], 2 * u[1], 2 * u[2]];
  return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
}
