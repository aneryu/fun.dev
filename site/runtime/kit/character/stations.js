// Where each segment's cross-sections sit (docs/character-generator.md#body-shapes): a station
// along a segment gives a ring centre and frame; a body shape stores the radius at each station
// and angle. The fitting tool and the generator both use these, so a shape fitted at one ring
// layout serves every LOD.

import { add, cross, dot, lerp, normalize, perpendicular, rotate, scale, sub } from "./vec.js";

const Z = [0, 0, 1], Y = [0, 1, 0];

/** Radius samples per ring: centre segments store the left half (0…π), limbs the full turn. */
export const ANGLES = { half: 25, full: 32 };

/** The station grids every body shape is sampled on. */
export const GRID = {
  trunk: Array.from({ length: 64 }, (_, i) => i / 63),
  head: Array.from({ length: 40 }, (_, i) => i / 39),
  arm: Array.from({ length: 40 }, (_, i) => 0.08 + (0.92 * i) / 39),
  leg: Array.from({ length: 48 }, (_, i) => i / 47),
};

/** Landmark heights and lengths the stations hang on, from the skeleton and the shape's own landmarks. */
export function frameOf(skeleton, landmarks) {
  const at = (id) => skeleton.bones[skeleton.index.get(id)].position;
  const neck = at("neck"), head = at("head");
  const neckSeam = lerp(neck, head, 0.35);   // below the jaw, so the chin belongs to the head
  const trunkLow = landmarks.crotchY + 0.03, trunkHigh = neckSeam[1];
  const shoulder = at("l_upperarm"), elbow = at("l_forearm"), wrist = at("l_hand");
  const hip = at("l_thigh"), knee = at("l_calf"), ankle = at("l_foot");
  return {
    neckSeam, trunkLow, trunkHigh, crownY: landmarks.crownY, headCenterZ: landmarks.headCenterZ,
    arm: [shoulder, elbow, wrist], leg: [hip, knee, ankle], legTop: landmarks.legTop,
  };
}

/** Trunk: horizontal rings on the centre line, from just above the crotch to the neck seam. */
export function trunkStation(f, s) {
  return { center: [0, f.trunkLow + s * (f.trunkHigh - f.trunkLow), 0], t: Y, w: Z };
}
export const trunkStationAt = (f, y) => (y - f.trunkLow) / (f.trunkHigh - f.trunkLow);

/** Head: horizontal rings from the neck seam to the crown, centred between the neck and the skull. */
export function headStation(f, s) {
  const y = f.neckSeam[1] + s * (f.crownY - f.neckSeam[1]);
  const z = f.neckSeam[2] + (f.headCenterZ - f.neckSeam[2]) * Math.min(1, s / 0.3);
  return { center: [0, y, z], t: Y, w: Z };
}
export const headStationAt = (f, y) => (y - f.neckSeam[1]) / (f.crownY - f.neckSeam[1]);

/**
 * A limb station s in [0, 1] along the two-bone polyline [root, joint, end]: the point, and a
 * frame whose axis turns smoothly across the joint. `w` is the front, closest to model +Z.
 */
export function limbStation(points, s) {
  const [a, b, c] = points;
  const l1 = Math.hypot(...sub(b, a)), l2 = Math.hypot(...sub(c, b)), k = l1 / (l1 + l2);
  const d1 = normalize(sub(b, a)), d2 = normalize(sub(c, b));
  const center = s <= k ? lerp(a, b, s / k) : lerp(b, c, (s - k) / (1 - k));
  const blendT = Math.min(1, Math.max(0, (s - (k - 0.06)) / 0.12));
  const t = normalize(add(scale(d1, 1 - blendT), scale(d2, blendT)));
  return { center, t, w: perpendicular(Z, t), knee: k };
}

/** A ring's angle θ direction: w at 0, turning towards u = t × w. */
export function direction(station, theta) {
  const u = cross(station.t, station.w);
  return add(scale(station.w, Math.cos(theta)), scale(u, Math.sin(theta)));
}

/** Radius at (station s, angle θ) from a sampled map { stations, angles: "half" | "full", r }. */
export function sampleMap(map, s, theta) {
  const st = map.stations, n = map.r[0].length, half = map.angles === "half";
  let a = ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (half && a > Math.PI) a = 2 * Math.PI - a;   // the right half mirrors the left
  const span = half ? Math.PI : 2 * Math.PI, step = span / (half ? n - 1 : n);
  const fa = a / step, a0 = Math.floor(fa), ta = fa - a0;
  const col = (row, j) => (half ? row[Math.min(n - 1, j)] : row[j % n]);
  const at = (i) => { const row = map.r[i]; return col(row, a0) * (1 - ta) + col(row, a0 + 1) * ta; };
  if (s <= st[0]) return at(0);
  if (s >= st[st.length - 1]) return at(st.length - 1);
  let i = 0;
  while (s > st[i + 1]) i++;
  const t = (s - st[i]) / (st[i + 1] - st[i]);
  return at(i) * (1 - t) + at(i + 1) * t;
}

/** A station moved to its section's centroid: the map's offset along w and u at s. */
export function centred(map, station, s) {
  const o = map.offset;
  if (!o) return station;
  const st = map.stations;
  let i = 0;
  while (i < st.length - 2 && s > st[i + 1]) i++;
  const t = Math.min(1, Math.max(0, (s - st[i]) / (st[i + 1] - st[i])));
  const ow = o[i][0] * (1 - t) + o[i + 1][0] * t, ou = o[i][1] * (1 - t) + o[i + 1][1] * t;
  const u = cross(station.t, station.w);
  return { ...station, center: add(add(station.center, scale(station.w, ow)), scale(u, ou)) };
}

/** The angles a map row samples. */
export const mapAngles = (kind) => kind === "half"
  ? Array.from({ length: ANGLES.half }, (_, j) => (Math.PI * j) / (ANGLES.half - 1))
  : Array.from({ length: ANGLES.full }, (_, j) => (2 * Math.PI * j) / ANGLES.full);

/** The ankle seam's station on the leg: a little above the ankle joint. */
export function ankleStation(f) {
  const thigh = Math.hypot(...sub(f.leg[1], f.leg[0])), shank = Math.hypot(...sub(f.leg[2], f.leg[1]));
  return 1 - (0.07 * shank) / (thigh + shank);
}

// Foot rings: [turn from facing down (degrees), place from heel to toe, height as a share of the ankle seam's].
export const FOOT = [[-35, 0.2, 0.55], [-72, 0.42, 0.45], [-90, 0.66, 0.38], [-90, 0.84, 0.32]];

/** The left foot's ring stations, turning from the ankle (facing down) to the toes (facing forward). */
export function footStations(skeleton, landmarks, f) {
  const ankleSeam = limbStation(f.leg, ankleStation(f)).center;
  const ax = f.leg[2][0], heel = landmarks.heelZ, length = landmarks.toeZ - heel;
  return FOOT.map(([deg, along, high]) => {
    const phi = (deg * Math.PI) / 180;
    return { center: [ax + (landmarks.toeX - ax) * along, high * ankleSeam[1], heel + along * length],
      t: rotate([0, -1, 0], [1, 0, 0], phi), w: rotate(Z, [1, 0, 0], phi) };
  });
}

export { dot };
