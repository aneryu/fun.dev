// Steering a gait's pose (docs/character-generator.md#steering): leaning into a turn and looking
// about. Both change a pose from createGait (local rotations by bone id, the hips' position) in
// place, before the feet are planted, so the planted feet stay where they are.
//
//   bankPose(skeleton, pose, angle);                 // lean about the forward axis, pivoting on the ground
//   lookPose(skeleton, rig, pose, yaw);              // turn the head and chest about the vertical
//   pitchPose(skeleton, rig, pose, angle);           // lean the trunk forward (or back), the head level

const G = 9.81;

/** The lean of a body going round at `speed` m/s turning at `turn` rad/s (radians, + to its left, at +x). */
export const bankAngle = (speed, turn, limit = 0.35) => Math.max(-limit, Math.min(limit, Math.atan((speed * turn) / G)));

/**
 * Leans the whole body by `angle` (radians, + to its left) about its forward axis, pivoting on the
 * ground under the hips, as a body leans into a turn.
 */
export function bankPose(skeleton, pose, angle) {
  if (!angle) return pose;
  const root = skeleton.bones[0].id, r = [0, 0, -Math.sin(angle / 2), Math.cos(angle / 2)];   // +x side down is − about z
  pose.rotations[root] = normalize(mul(r, pose.rotations[root] ?? [0, 0, 0, 1]));
  const [x, y, z] = pose.hips, turned = rotate(r, [0, y, 0]);
  pose.hips = [x + turned[0], turned[1], z + turned[2]];
  return pose;
}

// The share of a look each role takes, from the chest up (the arms turn with the chest).
const LOOK = [["upperChest", 0.25], ["neck", 0.3], ["head", 0.45]];

/** Turns the head and chest of a pose by `yaw` radians about the vertical (+ to the left), shared out from the chest up. */
export function lookPose(skeleton, rig, pose, yaw) {
  if (!yaw) return pose;
  const { bones } = skeleton, index = new Map(bones.map((b, i) => [b.id, i]));
  // World rotations of the pose, before the look.
  const world = [];
  bones.forEach((b, i) => { const l = pose.rotations[b.id] ?? [0, 0, 0, 1]; world[i] = b.parentIndex < 0 ? l : mul(world[b.parentIndex], l); });
  for (const [role, share] of LOOK) {
    const id = rig.roles[role], i = index.get(id);
    if (i == null || bones[i].parentIndex < 0) continue;
    // Turns about one axis commute, so each bone's own share turns it in its parent's original frame.
    const parent = world[bones[i].parentIndex], turn = [0, Math.sin((yaw * share) / 2), 0, Math.cos((yaw * share) / 2)];
    pose.rotations[id] = normalize(mul(mul(mul(inv(parent), turn), parent), pose.rotations[id] ?? [0, 0, 0, 1]));
  }
  return pose;
}

// The share of a lean forward each role of the trunk takes, from the hips up.
const PITCH = [["spine", 0.3], ["chest", 0.3], ["upperChest", 0.25], ["neck", 0.15]];

/** Leans a pose's trunk forward by `angle` radians (− back) about the sideways axis, shared out from the spine up, the head kept level. */
export function pitchPose(skeleton, rig, pose, angle) {
  if (!angle) return pose;
  const { bones } = skeleton, index = new Map(bones.map((b, i) => [b.id, i]));
  const world = [];
  bones.forEach((b, i) => { const l = pose.rotations[b.id] ?? [0, 0, 0, 1]; world[i] = b.parentIndex < 0 ? l : mul(world[b.parentIndex], l); });
  for (const [role, share] of [...PITCH, ["head", -1]]) {
    const id = rig.roles[role], i = index.get(id);
    if (i == null || bones[i].parentIndex < 0) continue;
    const parent = world[bones[i].parentIndex], turn = [Math.sin((angle * share) / 2), 0, 0, Math.cos((angle * share) / 2)];
    pose.rotations[id] = normalize(mul(mul(mul(inv(parent), turn), parent), pose.rotations[id] ?? [0, 0, 0, 1]));
  }
  return pose;
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
