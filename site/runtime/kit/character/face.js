// Faces (docs/character-generator.md#faces): a blend of two of the body's fitted faces, plus
// face-feature sliders, as deltas on the head vertices of the body's mesh and on the eyeballs.
// `faces` is a data set's faces (by body).

const UNIT = 1e-4;   // face deltas are stored in 0.1 mm

/**
 * Face-feature sliders: [id, morph at −1, morph at +1]. A slider in [−1, 1] blends towards one
 * morph or the other; one without a morph at −1 runs in [0, 1].
 */
export const FEATURES = [
  ["nose_width", "nose_thin", "nose_wide"], ["nose_height", "nose_down", "nose_up"], ["nose_length", "nose_short", "nose_long"],
  ["nose_profile", "nose_profile_curved", "nose_profile_crooked"], ["nose_tip", "nose_tip_down", "nose_tip_up"],
  ["brow_height", "brow_down", "brow_up"], ["brow_depth", "brow_in", "brow_out"],
  ["cheekbone_height", "cheek_down", "cheek_up"], ["cheekbone_width", "cheek_in", "cheek_out"], ["cheek_width", "cheek_gaunt", "cheek_puffed"],
  ["eye_opening", "eyes_squinted", "eyes_wide"], ["lips", "lips_thin", "lips_fat"],
  ["jaw_width", "jaw_narrow", "jaw_wide"], ["jaw_shape", "jaw_round", "jaw_square"],
  ["chin_height", "chin_down", "chin_up"], ["chin_length", "chin_in", "chin_out"], ["chin_shape", "chin_pointed", "chin_square"],
  ["chin_cleft", null, "chin_bum"], ["neck", null, "neck_male"],
];
export const featureRange = ([, minus]) => (minus ? [-1, 1] : [0, 1]);

/** A body's faces (ids), or none for a body without fitted faces. */
export const facesFor = (body, faces = {}) => faces[body]?.faces ?? [];

/** The skin tint of a face blend: the body's texture times this matches the face's. */
export function faceTint(body, semantic, faces = {}) {
  const F = faces[body];
  if (!F) return [1, 1, 1];
  const a = F.tints[F.faces.indexOf(semantic.face)], b = F.tints[F.faces.indexOf(semantic.face2)], t = semantic.faceMix;
  return a.map((x, k) => x + (b[k] - x) * t);
}

/**
 * The face's deltas at one LOD: `vertex(i)` for a vertex of the shape's mesh (or null), and
 * `eyes`, the eyeball's offset.
 */
export function faceDeltas(body, lodIndex, semantic, faces = {}) {
  const F = faces[body];
  if (!F) return { vertex: () => null, eyes: [0, 0, 0] };
  const level = F.lods[Math.min(lodIndex, F.lods.length - 1)];
  // Weights per stored delta list: the two faces, then each slider's morph on its side.
  const terms = [];
  const a = F.faces.indexOf(semantic.face), b = F.faces.indexOf(semantic.face2), t = semantic.faceMix;
  terms.push([level.heads[a], F.eyes.heads[a], 1 - t], [level.heads[b], F.eyes.heads[b], t]);
  for (const [id, minus, plus] of FEATURES) {
    const x = semantic[id] ?? 0, morph = x < 0 ? minus : plus;
    if (x && morph && level.morphs[morph]) terms.push([level.morphs[morph], F.eyes.morphs[morph], Math.abs(x)]);
  }
  const at = new Map(level.v.map((v, k) => [v, k]));
  const sum = (pick) => [0, 1, 2].map((c) => terms.reduce((s, term) => s + pick(term, c) * term[2], 0) * UNIT);
  return {
    vertex: (i) => { const k = at.get(i); return k === undefined ? null : sum((term, c) => term[0][k * 3 + c]); },
    eyes: sum((term, c) => term[1][c]),
  };
}
