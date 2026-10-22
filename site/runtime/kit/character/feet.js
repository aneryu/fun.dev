// Planted feet for generated characters (docs/character-generator.md#gait). A foot the animation
// puts down is locked where it lands; as the character moves, the ground moves under it (the
// caller says how far: forward travel and turn per step, in the character's own frame), and a
// two-bone IK bends hip and knee so the ankle stays on its spot. It lets go when the animation
// lifts the foot or the leg would have to reach too far. Locks blend in and out over BLEND seconds.
// A pose from createGait says where its feet are down (`contacts`, from the clips' stances); a
// pose without them is judged by the feet's height.
//
//   const feet = createFootLock(skeleton);
//   feet.apply(pose, { forward: speed * dt, turn: yawRate * dt, dt });   // pose from gait.update, changed in place

const BLEND = 0.08;         // seconds to blend a lock in or out (a run's stance lasts about 0.2 s), eased
const DOWN = 0.025;         // a foot is down within this of its rest height (metres)
const LIFT = 0.04;          // and lifts once the animation raises it this much
const REACH = 0.15;         // a lock lets go when the animated foot is this far from it
const STEP_TWIST = 0.45;    // radians the body turns over a planted foot, standing, before it steps round
const SQUARE = 0.2;         // and, once it stops turning, before a foot steps to square up
const LEAD = 2.6;           // radians at most a step round leads the body by, toward where it will face
const PIVOT_ON = 0.65;       // of the way from amid the feet to the foot turned toward, where a turn on the spot goes round
const ROOM = 0.07;
const STRIDE = 0.3;   // metres from its hip, across the ground, a step round may go          // metres a step round keeps from the other foot (ankle to ankle)
const STEP_OFF = 0.08;      // metres a planted foot may be from where the pose stands it before it steps there
const PIVOT = 0.8;          // radians a standing foot may be turned from the body before it pivots with it
const HOLD = 0.2;           // seconds to take on (or give up) holding the feet's turn, starting to stand (or to walk)
const STEP_TIME = 0.3;      // seconds a step round takes
const STEP_LIFT = 0.07;     // metres it lifts the foot
const SOFT_IK = 0.02;       // of a two-bone chain's reach, where its IK starts easing toward full reach
const TOE_BEND = 1.05;      // radians, the most toes bend up (60°)
const TOE_ONSET = 20;       // per second: how fast toes take on a bend (a spring's rate)
const TOE_RELEASE = 10;     // and let go of one
const CLEAR = 0.002;        // metres a lifted foot is kept above the ground
const SOFT = 0.006;         // metres of a lift's soft start

const LEGS = ["l", "r"].map((s) => ({ hip: `${s}_thigh`, knee: `${s}_calf`, ankle: `${s}_foot`, roll: `${s}_thigh_roll` }));

export function createFootLock(skeleton) {
  const { bones } = skeleton, index = new Map(bones.map((b, i) => [b.id, i]));
  const offsets = bones.map((b) => (b.parentIndex < 0 ? null : rotate(inv(bones[b.parentIndex].rotation), sub(b.position, bones[b.parentIndex].position))));
  const legs = LEGS.filter((l) => [l.hip, l.knee, l.ankle].every((id) => index.has(id))).map((l) => ({
    ...l, rest: bones[index.get(l.ankle)].position[1], locked: null, weight: 0, twist: 0, step: null, hold: 0,
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

  let last = null;   // the foot that stepped round last
  return {
    get legs() { return legs.map(({ ankle, locked, weight }) => ({ ankle, locked, weight })); },
    /**
     * Where a pose stands, on the ground ([x, z], in the character's frame): amid its feet (ankles
     * and toes), or, turning (`side`: + to the left), toward the foot on the side it turns to: that
     * foot opens on the spot and the other steps round it, the body going round with them.
     */
    stance(pose, side = 0) {
      const { pos } = forward(pose), mid = (ids) => { const at = ids.filter((id) => index.has(id)).map((id) => pos[index.get(id)]); return [0, 2].map((k) => at.reduce((sum, p) => sum + p[k], 0) / at.length); };
      const feet = legs.map((leg) => mid([leg.ankle, leg.ankle.replace("foot", "toe")])), centre = [0, 1].map((k) => (feet[0][k] + feet[1][k]) / 2);
      if (!side) return centre;
      const own = feet[legs.findIndex((leg) => (leg.ankle[0] === "l") === side > 0)];
      return centre.map((v, k) => v + (own[k] - v) * PIVOT_ON);
    },
    /**
     * Plants the feet of `pose` (changed in place) after the ground moved by `forward` metres and
     * `turn` radians, by `strength` (0 to 1). Standing (`step`), a planted foot the body has turned
     * STEP_TWIST over steps round: lifted on an arc (STEP_LIFT) to where the pose puts it over
     * STEP_TIME and planted again, one foot at a time, the one turned most first; once the body
     * stops turning, a foot still turned a little steps to square up. Given the turn still `ahead`
     * (radians, toward a facing), a step goes toward where the body will face, by up to LEAD, and the
     * last ones are taken as the body ends its turn, not after it. The body turns about its origin,
     * or `about` ([x, z] in its frame: where it stands, so the feet keep their room as they go round).
     */
    apply(pose, { forward: travel = 0, turn = 0, dt = 1 / 60, strength = 1, step = false, ahead = null, about = null } = {}) {
      const { world, pos } = forward(pose);
      const centre = about ? [about[0], 0, about[1]] : [0, 0, 0], round = (p, t) => add(rotateY(sub(p, centre), t), centre);
      const stepping = legs.some((l) => l.step), turning = Math.abs(turn) > 1e-4;
      // How far a foot is turned from where the body will stand (now, without a facing).
      const still = (l) => Math.abs(l.twist + (ahead ?? 0));
      // Standing, a foot steps round when the body has turned over it, or will be turned over it once
      // it ends a turn nearly done, or is far from where the pose stands it (a stop's last stance):
      // stepping there rather than letting go and snapping.
      // (Where it stands is turned by the foot's twist: a foot put down ahead of a turn is where it should be.)
      const off = (l) => { if (!l.locked) return 0; const at = round(pos[index.get(l.ankle)], -l.twist); return Math.hypot(l.locked[0] - at[0], l.locked[2] - at[2]); };
      // (Toward a facing, only a twist the body turned over counts: a foot put down ahead is twisted back.)
      const over = (l) => (ahead == null ? Math.abs(l.twist) : l.twist * Math.sign(ahead));
      const due = (l) => over(l) > STEP_TWIST || (ahead == null ? !turning && still(l) > SQUARE : still(l) > SQUARE) || off(l) > STEP_OFF;
      // The one turned most first; even, the one on the side turned toward (it opens the turn).
      // Then the other one than stepped last (feet take turns).
      const order = (l) => still(l) + off(l) + (ahead && (l.ankle[0] === "l") === ahead > 0 ? 0.05 : 0) - (l === last ? 1 : 0);
      const next = !step || stepping ? null : [...legs].filter((l) => l.locked && !l.release && l.weight === 1 && due(l)).sort((a, b) => order(b) - order(a))[0];
      if (next) {
        last = next;
        // As far ahead as it may go, keeping its room from the other foot (fixed for the step: turned
        // back as the body turns on).
        // and within STRIDE of its hip (where the body is now: a foot put down for where the body
        // will be would stretch the leg till it comes).
        const other = legs.find((l) => l !== next).locked, at = pos[index.get(next.ankle)], hip = pos[index.get(next.hip)];
        const flat = (p, q) => Math.hypot(p[0] - q[0], p[2] - q[2]), fits = (lead) => (!other || flat(round(at, lead), other) >= ROOM) && flat(round(at, lead), hip) <= STRIDE;
        let lead = ahead == null ? 0 : Math.max(-LEAD, Math.min(LEAD, ahead));
        while (Math.abs(lead) > 0.05 && !fits(lead)) lead -= Math.sign(lead) * 0.05;
        next.step = { t: 0, from: [...next.locked], lead };
      }
      for (const leg of legs) {
        const h = index.get(leg.hip), k = index.get(leg.knee), a = index.get(leg.ankle);
        const ankle = pos[a];
        // Standing, a planted foot keeps its turn on the ground (up to PIVOT from the body's, past
        // which it pivots with it); walking, it turns with the body as the animation has it.
        leg.hold = Math.min(1, Math.max(0, leg.hold + (step ? dt : -dt) / HOLD));
        const pivot = (yaw) => Math.max(-PIVOT, Math.min(PIVOT, yaw)) * leg.hold * leg.hold * (3 - 2 * leg.hold);
        const foot = (yaw) => mul([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], world[a]);
        // The ground under a locked foot moves back as the character goes forward and turns.
        if (leg.locked) { leg.locked = round(sub(leg.locked, [0, 0, travel]), -turn); leg.twist += turn; }
        if (leg.step) {
          // A step round: from where the foot was to where the pose puts it, on an arc.
          leg.step.from = round(sub(leg.step.from, [0, 0, travel]), -turn);
          leg.step.lead -= turn;
          const { lead } = leg.step;
          leg.step.t += dt;
          // Smoothly at both ends (the knee would jolt at a step's start or end at full speed): up and
          // down by a squared sine, across by a smootherstep once the foot is off the ground and
          // done before it is down again (so it does not drag).
          const u = Math.min(1, leg.step.t / STEP_TIME), x = Math.min(1, Math.max(0, (u - 0.15) / 0.7)), e = x * x * x * (x * (x * 6 - 15) + 10), up = Math.sin(Math.PI * u) ** 2;
          // Where the pose stands the foot once the body has turned the lead on (fixed on the ground,
          // so turned back as the body turns toward it).
          const to = round(ankle, lead);
          const target = [leg.step.from[0] + (to[0] - leg.step.from[0]) * e, ankle[1] + STEP_LIFT * up, leg.step.from[2] + (to[2] - leg.step.from[2]) * e];
          const [turnHip, turnKnee] = twoBoneIK(pos[h], pos[k], ankle, target);
          const hipWorld = mul(turnHip, world[h]), kneeWorld = mul(mul(turnKnee, turnHip), world[k]), parentOf = (i) => world[bones[i].parentIndex];
          pose.rotations[leg.hip] = normalize(mul(inv(parentOf(h)), hipWorld));
          pose.rotations[leg.knee] = normalize(mul(inv(hipWorld), kneeWorld));
          // The foot turns from where it was on the ground to where it will stand.
          pose.rotations[leg.ankle] = normalize(mul(inv(kneeWorld), foot(pivot(-leg.twist) + (pivot(lead) - pivot(-leg.twist)) * e)));
          if (index.has(leg.roll)) { const r = index.get(leg.roll); pose.rotations[leg.roll] = normalize(mul(inv(parentOf(r)), mul(turnHip, world[r]))); }
          world[h] = hipWorld; world[k] = kneeWorld;
          if (u >= 1) { leg.locked = [target[0], ankle[1], target[2]]; leg.twist = -lead; leg.step = null; leg.weight = 1; leg.release = false; }
          continue;
        }
        const contact = pose.contacts?.[leg.ankle];
        const down = contact != null ? contact > 0.5 : ankle[1] < leg.rest + DOWN, lifted = contact != null ? contact < 0.5 : ankle[1] > leg.rest + LIFT;
        if (!leg.locked && down && leg.weight === 0) { leg.locked = [...ankle]; leg.twist = 0; }
        if (leg.locked && (lifted || (!step && distance(leg.locked, ankle) > REACH))) leg.release = true;
        leg.weight = Math.min(1, Math.max(0, leg.weight + (leg.locked && !leg.release ? dt : -dt) / BLEND));
        if (leg.release && leg.weight === 0) { leg.locked = null; leg.release = false; }
        if (!leg.locked || leg.weight === 0) continue;
        // Eased in and out (a lock's pull starting or ending at full rate jolts a near straight knee).
        const w = leg.weight * leg.weight * (3 - 2 * leg.weight) * strength, target = lerp(ankle, [leg.locked[0], ankle[1], leg.locked[2]], w);
        const [turnHip, turnKnee] = twoBoneIK(pos[h], pos[k], ankle, target);
        // New world rotations: the thigh (and its roll bone) turn by turnHip, the calf by both; the
        // foot keeps its animated world rotation, or standing, its turn on the ground.
        const hipWorld = mul(turnHip, world[h]), kneeWorld = mul(mul(turnKnee, turnHip), world[k]);
        const parentOf = (i) => world[bones[i].parentIndex];
        pose.rotations[leg.hip] = normalize(mul(inv(parentOf(h)), hipWorld));
        pose.rotations[leg.knee] = normalize(mul(inv(hipWorld), kneeWorld));
        pose.rotations[leg.ankle] = normalize(mul(inv(kneeWorld), foot(pivot(-leg.twist) * w)));
        if (index.has(leg.roll)) { const r = index.get(leg.roll); pose.rotations[leg.roll] = normalize(mul(inv(parentOf(r)), mul(turnHip, world[r]))); }
        world[h] = hipWorld; world[k] = kneeWorld;
      }
      return pose;
    },
  };
}

/**
 * A character's soles for groundFeet: per foot and toe bone, the few points of its skin lowest
 * (and, for the toes, furthest forward) at rest, in the bone's own frame.
 */
export function characterSoles(character) {
  const { skeleton, mesh } = character, { bones } = skeleton, out = {};
  for (const id of ["l_foot", "r_foot", "l_toe", "r_toe"]) {
    const t = bones.findIndex((b) => b.id === id);
    if (t < 0) continue;
    const own = [];
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      let best = 0;
      for (let k = 1; k < 4; k++) if (mesh.weights[v * 4 + k] > mesh.weights[v * 4 + best]) best = k;
      if (mesh.joints[v * 4 + best] === t) own.push([mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]]);
    }
    const pick = (key, n) => [...own].sort(key).slice(0, n);
    const points = id.endsWith("toe") ? [...new Set([...pick((a, b) => a[1] - b[1], 4), ...pick((a, b) => b[2] - a[2], 4)])] : pick((a, b) => a[1] - b[1], 8);
    out[id] = points.map((p) => rotate(inv(bones[t].rotation), sub(p, bones[t].position)));
  }
  return out;
}

/**
 * Keeps the feet on or above the ground (y = 0) in a pose (local rotations by bone id, the hips'
 * position; changed in place). A foot whose sole or toe joint goes under is lifted, hip and knee
 * bending by two-bone IK and the foot keeping its turn (a heel rising rolls the foot on its ball,
 * not into the ground); then a toe whose sole goes under is bent up about its joint until the
 * lowest point is on the ground, as toes bend when the heel lifts (up to TOE_BEND). Each by as much
 * as it takes, so neither starts or stops with a jump. Given a `memory` (an object kept from frame
 * to frame, `dt` seconds apart), the toes follow the bend it takes as a spring would, taking it on
 * at TOE_ONSET and letting go at TOE_RELEASE rather than at once (as they do when the foot leaves
 * the ground).
 */
export function groundFeet(skeleton, soles, pose, { memory = null, dt = 1 / 30 } = {}) {
  const { bones } = skeleton, index = new Map(bones.map((b, i) => [b.id, i]));
  const fk = () => {
    const world = [], pos = [];
    bones.forEach((b, i) => {
      const local = pose.rotations[b.id] ?? [0, 0, 0, 1];
      if (b.parentIndex < 0) { world[i] = local; pos[i] = pose.hips; return; }
      const parent = bones[b.parentIndex];
      world[i] = mul(world[b.parentIndex], local);
      pos[i] = add(pos[b.parentIndex], rotate(world[b.parentIndex], rotate(inv(parent.rotation), sub(b.position, parent.position))));
    });
    return { world, pos };
  };
  const lowestOf = (points, at, turn) => Math.min(...points.map((o) => add(at.pos, rotate(turn, rotate(at.world, o)))[1]));
  const none = [0, 0, 0, 1];
  // A foot under is lifted: hip and knee bend, the foot keeps its turn. How far is how far under
  // CLEAR (a hair above the ground, so the IK's rounding does not leave it under), so a lift comes
  // and goes smoothly.
  const lift = (withToes) => {
    const { world, pos } = fk();
    for (const leg of LEGS) {
      const a = index.get(leg.ankle), h = index.get(leg.hip), k = index.get(leg.knee), toe = index.get(leg.ankle.replace("foot", "toe"));
      if (a == null || h == null || k == null) continue;
      let low = soles[leg.ankle]?.length ? lowestOf(soles[leg.ankle], { pos: pos[a], world: world[a] }, none) : Infinity;
      if (toe != null) low = Math.min(low, withToes && soles[bones[toe].id]?.length ? lowestOf(soles[bones[toe].id], { pos: pos[toe], world: world[toe] }, none) : pos[toe][1]);
      if (!(low < CLEAR)) continue;
      // Softly: a lift's rate grows from none (a straight leg turns its knee a lot for a little height,
      // so a lift starting at full rate would jolt it), the foot left up to SOFT under at most.
      const under = CLEAR - low, up = under < 2 * SOFT ? (under * under) / (4 * SOFT) : under - SOFT;
      const [turnHip, turnKnee] = twoBoneIK(pos[h], pos[k], pos[a], add(pos[a], [0, up, 0]));
      const hipWorld = mul(turnHip, world[h]), kneeWorld = mul(mul(turnKnee, turnHip), world[k]), parentOf = (i) => world[bones[i].parentIndex];
      pose.rotations[leg.hip] = normalize(mul(inv(parentOf(h)), hipWorld));
      pose.rotations[leg.knee] = normalize(mul(inv(hipWorld), kneeWorld));
      pose.rotations[leg.ankle] = normalize(mul(inv(kneeWorld), world[a]));
      if (index.has(leg.roll)) { const r = index.get(leg.roll); pose.rotations[leg.roll] = normalize(mul(inv(parentOf(r)), mul(turnHip, world[r]))); }
    }
  };
  // First the sole and the toe joint.
  lift(false);
  // Then the toes, their joint now on or above the ground: bent up about it until their sole is on
  // the ground, by as much as that takes (up to TOE_BEND), so the bend too comes and goes smoothly.
  const { world, pos } = fk();
  for (const id of ["l_toe", "r_toe"]) {
    const t = index.get(id), points = soles[id];
    if (t == null || !points?.length) continue;
    const at = { pos: pos[t], world: world[t] };
    const about = (phi) => [Math.sin(phi / 2), 0, 0, Math.cos(phi / 2)];   // about the sideways axis; − lifts the toes
    // With a memory the bend follows what it takes as a spring would, quickly on and more slowly off.
    const last = memory?.[id] ?? 0, follow = (want) => (memory ? last + (want - last) * (1 - Math.exp(-(want > last ? TOE_ONSET : TOE_RELEASE) * dt)) : want);
    if (lowestOf(points, at, none) >= 0) {
      const bend = follow(0);
      if (memory) memory[id] = bend;
      if (bend > 1e-4) pose.rotations[id] = normalize(mul(inv(world[bones[t].parentIndex]), mul(about(-bend), world[t])));
      continue;
    }
    // The bend that brings the lowest point highest, up to TOE_BEND: its height rises then falls
    // with the bend, so a golden-section search finds it, and it is the ground's where that is
    // above the ground (a bisection below that peak).
    let a0 = -TOE_BEND, b0 = 0;
    for (let n = 0; n < 30; n++) { const m1 = b0 - (b0 - a0) * 0.618, m2 = a0 + (b0 - a0) * 0.618; if (lowestOf(points, at, about(m1)) > lowestOf(points, at, about(m2))) b0 = m2; else a0 = m1; }
    let bend = (a0 + b0) / 2;
    if (lowestOf(points, at, about(bend)) > 0) {
      let lo = bend, hi = 0;
      for (let n = 0; n < 24; n++) { const mid = (lo + hi) / 2; if (lowestOf(points, at, about(mid)) < 0) hi = mid; else lo = mid; }
      bend = lo;
    }
    bend = -follow(-bend);
    if (memory) memory[id] = -bend;
    pose.rotations[id] = normalize(mul(inv(world[bones[t].parentIndex]), mul(about(bend), world[t])));
  }
  // Last, toes their bend could not bring up (beyond TOE_BEND): the foot lifted the rest of the way.
  lift(true);
  return pose;
}

/**
 * Points over a character's body for raiseBody: up to `count` of its skin's and garments'
 * vertices (not the feet's), each in the frame of the bone that moves it most.
 */
export function bodyPoints(character, count = 400) {
  const { skeleton, mesh } = character, { bones } = skeleton, n = mesh.positions.length / 3, step = Math.max(1, Math.floor(n / count)), out = [];
  for (let v = 0; v < n; v += step) {
    let best = 0;
    for (let k = 1; k < 4; k++) if (mesh.weights[v * 4 + k] > mesh.weights[v * 4 + best]) best = k;
    const b = mesh.joints[v * 4 + best];
    if (/foot|toe/.test(bones[b].id)) continue;
    out.push({ bone: b, at: rotate(inv(bones[b].rotation), sub([mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]], bones[b].position)) });
  }
  return out;
}

/** Raises a pose's hips (changed in place) so no body point is under the ground, as a body lying down rests on it. */
export function raiseBody(skeleton, points, pose) {
  const { bones } = skeleton, world = [], pos = [];
  bones.forEach((b, i) => {
    const local = pose.rotations[b.id] ?? [0, 0, 0, 1];
    if (b.parentIndex < 0) { world[i] = local; pos[i] = pose.hips; return; }
    const parent = bones[b.parentIndex];
    world[i] = mul(world[b.parentIndex], local);
    pos[i] = add(pos[b.parentIndex], rotate(world[b.parentIndex], rotate(inv(parent.rotation), sub(b.position, parent.position))));
  });
  let low = 0;
  for (const p of points) low = Math.min(low, pos[p.bone][1] + rotate(world[p.bone], p.at)[1]);
  if (low < 0) pose.hips = [pose.hips[0], pose.hips[1] - low, pose.hips[2]];
  return pose;
}

/**
 * Two-bone IK: the turns (world quaternions) of the upper bone (about a) and then of the lower bone
 * (about the new b) that bring the end c to `target`, bending in the plane the chain bends in now.
 * Out of reach, the chain straightens towards the target; within SOFT_IK of its reach, softly.
 */
export function twoBoneIK(a, b, c, target) {
  const l1 = distance(a, b), l2 = distance(b, c), reach = l1 + l2;
  // Soft near full reach (a near straight chain turns its middle joint a lot for a little reach):
  // past SOFT_IK of the reach short, the distance eases toward the reach rather than meeting it.
  const toTarget = sub(target, a), wanted = Math.max(length(toTarget), Math.abs(l1 - l2) + 1e-6), soft = SOFT_IK * reach;
  const d = wanted > reach - soft ? reach - soft * Math.exp(-(wanted - (reach - soft)) / soft) : wanted;
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
