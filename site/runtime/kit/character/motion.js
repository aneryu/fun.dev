// Clips for generated characters (docs/character-generator.md#animation). A clip stores, per
// bone id and frame, the bone's world rotation change from the rest pose, and the hips' offset
// from rest. A skeleton whose joints sit where the clip's source's did plays it as it is, whatever
// its bones' own axes: each bone's world rotation is the change times its rest world rotation, and
// its local rotation follows from its parent's.
//
//   const tracks = clipTracks(character.skeleton, clip);              // a clip by bone id
//   const tracks = clipTracks(character.skeleton, retargetClip(roleClip, character.skeleton, character.rig));   // by role
//   tracks.times, tracks.rotations[boneId] (local [x, y, z, w] per frame), tracks.hips ([x, y, z] per frame)

// Roll bones, which a clip may leave out (an engine drives them at run time): each follows a
// driver's rotation relative to a base bone, about the axis from the driver to its child (from
// the base to the driver when there is no child). "swing": all of the relative swing and half its
// twist (the top of a limb, whose skin must not wring with its twist); "twist": half the twist.
const ROLLS = { neck_roll: ["neck", "head", null, "twist"] };
for (const s of ["l", "r"]) {
  ROLLS[`${s}_thigh_roll`] = ["pelvis", `${s}_thigh`, `${s}_calf`, "swing"];
  ROLLS[`${s}_upperarm_roll`] = [`${s}_clavicle`, `${s}_upperarm`, `${s}_forearm`, "swing"];
  ROLLS[`${s}_forearm_roll`] = [`${s}_forearm`, `${s}_hand`, `${s}_finger20`, "twist"];
}

/** Local rotation and hips position tracks of a clip for one skeleton (bones parents first). */
export function clipTracks(skeleton, clip) {
  const { bones } = skeleton, n = clip.frames;
  const index = new Map(bones.map((b, i) => [b.id, i]));
  const times = Float32Array.from({ length: n }, (_, f) => f / clip.fps);
  const rotations = {};
  for (const b of bones) rotations[b.id] = new Float32Array(n * 4);
  const hips = new Float32Array(n * 3);
  const world = bones.map(() => [0, 0, 0, 1]);
  const rolls = Object.entries(ROLLS).filter(([id, [base, driver]]) => !clip.rotations[id] && index.has(id) && index.has(base) && index.has(driver));
  const delta = (i) => mul(world[i], inv(bones[i].rotation)), halves = {};
  for (let f = 0; f < n; f++) {
    bones.forEach((b, i) => {
      // A bone the clip leaves out turns with its parent.
      const d = clip.rotations[b.id] ? clip.rotations[b.id].slice(f * 4, f * 4 + 4) : b.parentIndex >= 0 ? delta(b.parentIndex) : [0, 0, 0, 1];
      world[i] = normalize(mul(d, b.rotation));
    });
    for (const [id, [base, driver, child, mode]] of rolls) {
      const bi = index.get(base), di = index.get(driver), ci = child && index.has(child) ? index.get(child) : null;
      const [from, to] = ci === null ? [bi, di] : [di, ci];
      const axis = unit(bones[to].position.map((v, k) => v - bones[from].position[k]));
      const [swing, twist] = splitTwist(mul(inv(delta(bi)), delta(di)), axis);
      // Half the twist, the half nearest the last frame's (past a half turn the shorter half
      // would flip to the other side).
      const half = halfway(twist, halves[id]);
      halves[id] = half;
      world[index.get(id)] = normalize(mul(mul(delta(bi), mode === "swing" ? mul(swing, half) : half), bones[index.get(id)].rotation));
    }
    bones.forEach((b, i) => rotations[b.id].set(normalize(b.parentIndex >= 0 ? mul(inv(world[b.parentIndex]), world[i]) : world[i]), f * 4));
    const root = bones[0].position;
    hips.set([root[0] + clip.root[f * 3], root[1] + clip.root[f * 3 + 1], root[2] + clip.root[f * 3 + 2]], f * 3);
  }
  return { name: clip.name, loop: clip.loop, duration: n / clip.fps, times, rotations, hips };
}

/**
 * A clip by roles onto a skeleton: its world rotation changes, from the clip's source skeleton
 * (`rest`: each role's rest position there), onto the bones the rig maps the roles to, as a clip
 * for `clipTracks`. Rest poses may differ (a T-pose source on an A-pose target): each limb role's
 * change is taken after the turn from the source's rest direction (to the role's child) to the
 * target's, so limbs point where the source's do. The trunk, neck, head, shoulders and feet stand
 * as the target's rest does: theirs is the change from the source's standing pose (`stand`, by
 * role; its rest when the clip has none), as their rest directions differ by build and joint
 * placement (a foot's toe joint sits higher or lower: aligned, flat feet would point down).
 * The hips' offsets scale by hip height, then each frame keeps the source's ground: of the feet,
 * toes, knees, hands, hips, chest and head, the one nearest the ground in the source (by its
 * height less its own resting height, at most RESTING) is put as near it in the target, scaled
 * (legs and feet differ in length and joint placement; a body lying down rests on its trunk).
 */
export function retargetClip(roleClip, skeleton, rig) {
  const at = (id) => skeleton.bones.find((b) => b.id === id);
  const rotations = {};
  for (const role of Object.keys(roleClip.rotations)) {
    if (!rig.roles[role] || !roleClip.rest[role]) continue;
    const a = STANDING.has(role) ? inv(roleClip.stand?.[role] ?? [0, 0, 0, 1]) : inv(alignment(role)), src = roleClip.rotations[role], out = new Float32Array(src.length);
    for (let f = 0; f < roleClip.frames; f++) out.set(normalize(mul(src.slice(f * 4, f * 4 + 4), a)), f * 4);
    rotations[rig.roles[role]] = out;
  }
  function alignment(role) {
    // The rest direction to the role's child, in both skeletons; a role without one (a fingertip)
    // keeps its parent's turn.
    let r = role, child = CHILD[r];
    while (r && !(child && roleClip.rest[child] && rig.roles[child])) { r = PARENT.get(r); child = r && CHILD[r]; }
    if (!r) return [0, 0, 0, 1];
    const src = roleClip.rest[child].map((v, k) => v - roleClip.rest[r][k]);
    const tgt = at(rig.roles[child]).position.map((v, k) => v - at(rig.roles[r]).position[k]);
    return fromTo(unit(src), unit(tgt));
  }
  const scale = at(rig.roles.hips).position[1] / roleClip.rest.hips[1];
  const root = Float32Array.from(roleClip.hips, (v) => v * scale);
  // The ground: the key roles' heights in both skeletons, each from its chain's world changes.
  const keys = GROUND.filter((r) => roleClip.rest[r] && rig.roles[r] && chainOf(r).every((c) => roleClip.rest[c] && rig.roles[c]));
  if (keys.length) {
    const srcChange = (r, f) => (roleClip.rotations[r] ? roleClip.rotations[r].slice(f * 4, f * 4 + 4) : null);
    const tgtChange = (r, f) => (rotations[rig.roles[r]] ? rotations[rig.roles[r]].slice(f * 4, f * 4 + 4) : null);
    const height = (r, f, restOf, change, hips) => {
      const chain = chainOf(r);
      let p = hips, d = [0, 0, 0, 1];
      for (let k = 1; k < chain.length; k++) {
        d = change(chain[k - 1], f) ?? d;
        p = add(p, rotate(d, sub(restOf(chain[k]), restOf(chain[k - 1]))));
      }
      return p[1];
    };
    const srcRest = (r) => roleClip.rest[r], tgtRest = (r) => at(rig.roles[r]).position;
    const resting = (y, s) => Math.min(y, RESTING * s);
    for (let f = 0; f < roleClip.frames; f++) {
      const sh = add(roleClip.rest.hips, roleClip.hips.slice(f * 3, f * 3 + 3)), th = add(tgtRest("hips"), [...root.slice(f * 3, f * 3 + 3)]);
      let best = null;
      for (const r of keys) {
        const clearance = height(r, f, srcRest, srcChange, sh) - resting(srcRest(r)[1], 1);
        if (!best || clearance < best.clearance) best = { r, clearance };
      }
      const want = best.clearance * scale + resting(tgtRest(best.r)[1], scale);
      root[f * 3 + 1] += want - height(best.r, f, tgtRest, tgtChange, th);
    }
  }
  return { name: roleClip.name, fps: roleClip.fps, frames: roleClip.frames, loop: roleClip.loop, rotations, root };
}

// The roles that may meet the ground, and how high a joint rests above it at most (its flesh).
const GROUND = ["leftFoot", "rightFoot", "leftToes", "rightToes", "leftLowerLeg", "rightLowerLeg", "leftHand", "rightHand", "hips", "upperChest", "head"];
const RESTING = 0.12;
// A role's chain from the hips (VRM roles).
function chainOf(role) {
  const side = role.match(/^(left|right)/)?.[1];
  if (role === "hips") return ["hips"];
  if (/(UpperLeg|LowerLeg|Foot|Toes)$/.test(role)) return ["hips", ...["UpperLeg", "LowerLeg", "Foot", "Toes"].map((r) => side + r).slice(0, ["UpperLeg", "LowerLeg", "Foot", "Toes"].indexOf(role.slice(side.length)) + 1)];
  const trunk = ["hips", "spine", "chest", "upperChest"];
  if (role === "upperChest") return trunk;
  if (role === "head") return [...trunk, "neck", "head"];
  if (/(Shoulder|UpperArm|LowerArm|Hand)$/.test(role)) return [...trunk, ...["Shoulder", "UpperArm", "LowerArm", "Hand"].map((r) => side + r).slice(0, ["Shoulder", "UpperArm", "LowerArm", "Hand"].indexOf(role.slice(side.length)) + 1)];
  return [role];
}

// Roles taken from the source's standing pose rather than aligned by rest direction (see retargetClip).
const STANDING = new Set(["hips", "spine", "chest", "upperChest", "neck", "head", "leftShoulder", "rightShoulder", "leftFoot", "rightFoot", "leftToes", "rightToes"]);

// Each role's child, for its rest direction (VRM humanoid roles).
const CHILD = { hips: "spine", spine: "chest", chest: "upperChest", upperChest: "neck", neck: "head" };
for (const s of ["left", "right"]) {
  Object.assign(CHILD, { [`${s}Shoulder`]: `${s}UpperArm`, [`${s}UpperArm`]: `${s}LowerArm`, [`${s}LowerArm`]: `${s}Hand`, [`${s}Hand`]: `${s}MiddleProximal`,
    [`${s}UpperLeg`]: `${s}LowerLeg`, [`${s}LowerLeg`]: `${s}Foot`, [`${s}Foot`]: `${s}Toes`,
    [`${s}ThumbMetacarpal`]: `${s}ThumbProximal`, [`${s}ThumbProximal`]: `${s}ThumbDistal` });
  for (const f of ["Index", "Middle", "Ring", "Little"]) Object.assign(CHILD, { [`${s}${f}Proximal`]: `${s}${f}Intermediate`, [`${s}${f}Intermediate`]: `${s}${f}Distal` });
}
const PARENT = new Map(Object.entries(CHILD).map(([p, c]) => [c, p]));
for (const s of ["left", "right"]) PARENT.set(`${s}Toes`, `${s}Foot`).set(`${s}ThumbDistal`, `${s}ThumbProximal`);

/** The shortest rotation taking unit vector a to unit vector b. */
function fromTo(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) { const p = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; return normalize([...cross(a, p), 0]); }
  return normalize([...cross(a, b), 1 + d]);
}

/** A rotation as [swing, twist about `axis`], q = swing · twist. */
function splitTwist(q, axis) {
  const p = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
  const t = [axis[0] * p, axis[1] * p, axis[2] * p, q[3]], len = Math.hypot(...t);
  if (len < 1e-9) return [q, [0, 0, 0, 1]];
  const twist = t.map((v) => v / len);
  return [mul(q, inv(twist)), twist];
}

/** The rotation halfway from none to q (of the two, the one nearer `near`, if given). */
function halfway(q, near = null) {
  const s = q[3] < 0 ? -1 : 1, h = normalize([q[0] * s, q[1] * s, q[2] * s, q[3] * s + 1]);
  if (!near) return h;
  // The other half: a half turn further about the same axis.
  const n = Math.hypot(h[0], h[1], h[2]), axis = n > 1e-9 ? [h[0] / n, h[1] / n, h[2] / n] : [0, 0, 1], other = normalize(mul(h, [axis[0], axis[1], axis[2], 0]));
  const dot = (a, b) => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return dot(other, near) > dot(h, near) ? other : h;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };

// Quaternions [x, y, z, w].
function mul([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
const inv = ([x, y, z, w]) => [-x, -y, -z, w];
function normalize(q) { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); }
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function rotate([x, y, z, w], v) {
  const u = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]], t = [2 * u[0], 2 * u[1], 2 * u[2]];
  return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
}
