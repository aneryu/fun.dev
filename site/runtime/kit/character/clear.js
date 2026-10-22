// Arms clear of the body (docs/character-generator.md#clearance): a pose's hands kept out of the
// thighs and hips, which a clip made on a slimmer body would put them through. The body is
// capsules round the thighs and the pelvis, as thick as its skin at rest; a hand inside them turns
// its arm out from the shoulder, about the forward axis, by as much as it is in.
//
//   const body = armClearance(character);   // once per character
//   clearArms(character.skeleton, body, pose);   // a pose from createGait or a clip's frame

const SIDES = [
  { side: "l", out: 1, arm: "l_upperarm", hand: "l_hand" },
  { side: "r", out: -1, arm: "r_upperarm", hand: "r_hand" },
];

/** A character's capsules (thighs, pelvis) and hand points, from its mesh at rest. */
export function armClearance(character) {
  const { skeleton, mesh } = character, { bones } = skeleton, index = new Map(bones.map((b, i) => [b.id, i]));
  const n = mesh.positions.length / 3, at = (v) => [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]];
  const dominant = (v) => { let best = 0; for (let k = 1; k < 4; k++) if (mesh.weights[v * 4 + k] > mesh.weights[v * 4 + best]) best = k; return bones[mesh.joints[v * 4 + best]].id; };
  const owner = Array.from({ length: n }, (_, v) => dominant(v));
  const capsule = (a, b, match) => {
    if (!index.has(a) || !index.has(b)) return null;
    const pa = bones[index.get(a)].position, pb = bones[index.get(b)].position, d = [];
    for (let v = 0; v < n; v++) if (match(owner[v])) d.push(segmentDistance(at(v), pa, pb));
    d.sort((x, y) => x - y);
    return d.length ? { a, b, radius: d[Math.floor(d.length * 0.6)] } : null;
  };
  const capsules = [
    capsule("l_thigh", "l_calf", (id) => id === "l_thigh" || id === "l_thigh_roll"),
    capsule("r_thigh", "r_calf", (id) => id === "r_thigh" || id === "r_thigh_roll"),
    capsule("pelvis", "spine1", (id) => id === "pelvis" || id === "spine0"),
  ].filter(Boolean);
  const hands = {};
  for (const { hand } of SIDES) {
    if (!index.has(hand)) continue;
    const h = index.get(hand), points = [];
    for (let v = 0; v < n; v += 3) if (/hand|finger/.test(owner[v]) && owner[v].startsWith(hand[0])) points.push(rotate(inv(bones[h].rotation), sub(at(v), bones[h].position)));
    hands[hand] = points.filter((_, k) => k % Math.max(1, Math.floor(points.length / 24)) === 0);
  }
  return { capsules, hands };
}

/** Turns a pose's arms (changed in place) out until their hands are clear of the thighs and pelvis. */
export function clearArms(skeleton, body, pose) {
  const { bones } = skeleton, index = new Map(bones.map((b, i) => [b.id, i]));
  for (const { out, arm, hand } of SIDES) {
    const a = index.get(arm), h = index.get(hand), points = body.hands[hand];
    if (a == null || h == null || !points?.length) continue;
    for (let round = 0; round < 2; round++) {
      const { world, pos } = forward(skeleton, pose);
      let depth = 0;
      for (const o of points) {
        const p = add(pos[h], rotate(world[h], o));
        for (const c of body.capsules) depth = Math.max(depth, c.radius - segmentDistance(p, pos[index.get(c.a)], pos[index.get(c.b)]));
      }
      if (depth <= 0.002) break;
      const reach = Math.hypot(...sub(pos[h], pos[a])) || 0.5, angle = out * (depth + 0.005) / reach;
      const turn = [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)], parent = world[bones[a].parentIndex];
      pose.rotations[arm] = normalize(mul(inv(parent), mul(turn, world[a])));
      // The upper arm's roll bone turns with it.
      const roll = index.get(`${arm}_roll`);
      if (roll != null) pose.rotations[bones[roll].id] = normalize(mul(inv(world[bones[roll].parentIndex]), mul(turn, world[roll])));
    }
  }
  return pose;
}

function forward(skeleton, pose) {
  const { bones } = skeleton, world = [], pos = [];
  bones.forEach((b, i) => {
    const local = pose.rotations[b.id] ?? [0, 0, 0, 1];
    if (b.parentIndex < 0) { world[i] = local; pos[i] = pose.hips; return; }
    const parent = bones[b.parentIndex];
    world[i] = mul(world[b.parentIndex], local);
    pos[i] = add(pos[b.parentIndex], rotate(world[b.parentIndex], rotate(inv(parent.rotation), sub(b.position, parent.position))));
  });
  return { world, pos };
}
function segmentDistance(p, a, b) {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return Math.hypot(...sub(p, add(a, ab.map((v) => v * t))));
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function mul([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
const inv = ([x, y, z, w]) => [-x, -y, -z, w];
function normalize(q) { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); }
function rotate([x, y, z, w], v) {
  const u = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]], t = [2 * u[0], 2 * u[1], 2 * u[2]];
  return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
}
