// The skeleton of a body shape (docs/character-generator.md#skeleton). Joint positions come from
// the shape's data; frames follow our conventions: +Y to the child, +Z the flexion direction,
// X = Y × Z. The right side mirrors the left: position M·p, X_r = −M·X_l, Y_r = M·Y_l, Z_r = M·Z_l.

import { add, cross, dot, mirror, normalize, perpendicular, quatFromBasis, scale, sub } from "./vec.js";

export const RIG_NAME = "fundev-character";
export const RIG_VERSION = 1;

const Z = [0, 0, 1], UP = [0, 1, 0], DOWN = [0, -1, 0];
const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Little"];
const JOINT_ROLES = { Thumb: ["Metacarpal", "Proximal", "Distal"], other: ["Proximal", "Intermediate", "Distal"] };

// [id, parent, role, flexion direction, where +Y points (a bone id, a tip "@name", or a direction)]
const CENTRE = [
  ["hips", null, "hips", Z, "spine0"], ["pelvis", "hips", null, Z, "@hipCentre"],
  ["spine_root", "hips", null, Z, "spine0"], ["spine0", "spine_root", "spine", Z, "spine1"], ["spine1", "spine0", null, Z, "spine2"],
  ["spine2", "spine1", "chest", Z, "spine3"], ["spine3", "spine2", "upperChest", Z, "neck"],
  ["neck", "spine3", "neck", Z, "head"], ["neck_roll", "neck", null, Z, "head"], ["head", "neck", "head", Z, "@crown"],
];
const LEG = [
  ["l_thigh", "pelvis", "leftUpperLeg", Z, "l_calf"], ["l_thigh_roll", "pelvis", null, Z, "l_calf"],
  ["l_calf", "l_thigh", "leftLowerLeg", scale(Z, -1), "l_foot"], ["l_foot", "l_calf", "leftFoot", UP, "l_toe"],
  ["l_toe", "l_foot", "leftToes", DOWN, "@toeTip"],
];
const ARM = [
  ["l_clavicle", "spine3", "leftShoulder", Z, "l_upperarm"], ["l_upperarm", "l_clavicle", "leftUpperArm", Z, "l_forearm"],
  ["l_upperarm_roll", "l_upperarm", null, Z, "l_forearm"], ["l_forearm", "l_upperarm", "leftLowerArm", Z, "l_hand"],
  ["l_forearm_roll", "l_forearm", null, Z, "l_hand"], ["l_hand", "l_forearm", "leftHand", "@palm", "l_finger20"],
  ...[0, 1, 2, 3, 4].flatMap((f) => [0, 1, 2].map((j) => [`l_finger${f}${j}`, j ? `l_finger${f}${j - 1}` : "l_hand",
    `left${FINGERS[f]}${JOINT_ROLES[f ? "other" : "Thumb"][j]}`, "@palm", j < 2 ? `l_finger${f}${j + 1}` : `@finger${f}Tip`])),
];
const FACE = [
  ["face_root", "head", null, Z, "@crown"], ["brow_centre", "face_root", null, Z, UP],
  ["upperlip_root", "face_root", null, Z, "upperlip"], ["upperlip", "upperlip_root", null, Z, "@upperlipKids"],
  ["jaw", "face_root", "jaw", DOWN, "lowerlip_root"], ["lowerlip_root", "jaw", null, Z, "lowerlip"],
  ["lowerlip", "lowerlip_root", null, Z, "@lowerlipKids"], ["tongue", "lowerlip_root", null, DOWN, Z],
  ["l_brow_out", "face_root", null, Z, UP], ["l_lid_upper", "face_root", null, Z, UP], ["l_eye", "face_root", "leftEye", DOWN, Z],
  ["l_cheekbone", "face_root", null, Z, UP], ["l_lip_corner", "face_root", null, Z, UP],
  ["l_lip_top", "upperlip", null, Z, UP], ["l_lip_bot", "lowerlip", null, Z, UP],
];
/** Bone ids a body shape lists joints for (left side and centre line). */
export const JOINT_IDS = [...CENTRE, ...LEG, ...ARM, ...FACE].map((b) => b[0]);

/** A bone frame: +Y towards `to`, +Z the flexion direction made perpendicular, X = Y × Z. */
function frame(from, to, flex) {
  let y = normalize(sub(to, from));
  if (!Number.isFinite(y[0]) || Math.hypot(...sub(to, from)) < 1e-6) y = UP;
  // When the bone lies along its flexion direction, the next of up and +x stands in.
  const usable = [flex, UP, [1, 0, 0]].find((f) => Math.abs(dot(normalize(f), y)) < 0.95);
  const z = perpendicular(usable, y);
  return { x: cross(y, z), y, z };
}

/**
 * The 84 bones in parent-first order with world rest positions and frames, from a body shape's
 * `joints` (left side and centre line, by bone id) and `tips` (end points of leaf bones).
 */
export function buildSkeleton(shape) {
  const J = shape.joints, tips = shape.tips;
  const at = (id) => { const p = J[id]; if (!p) throw new Error(`body shape has no joint ${id}`); return p; };
  const special = {
    "@hipCentre": () => scale(add(at("l_thigh"), mirror(at("l_thigh"))), 0.5),
    "@upperlipKids": () => scale(add(at("l_lip_top"), mirror(at("l_lip_top"))), 0.5),
    "@lowerlipKids": () => scale(add(at("l_lip_bot"), mirror(at("l_lip_bot"))), 0.5),
  };
  // The palm normal, from the hand's direction and its knuckle line (index to little).
  const handDir = normalize(sub(at("l_finger20"), at("l_hand")));
  const across = perpendicular(sub(at("l_finger10"), at("l_finger40")), handDir);
  const palm = normalize(cross(handDir, across));
  const target = (to) => {
    if (to.startsWith("@")) { const p = special[to] ? special[to]() : tips[to.slice(1)]; if (!p) throw new Error(`no tip ${to}`); return p; }
    return at(to);
  };
  const make = ([id, parent, role, flex, to]) => {
    const position = at(id);
    const goal = Array.isArray(to) ? add(position, scale(to, 0.02)) : target(to);
    return { id, parent, role, position, axes: frame(position, goal, flex === "@palm" ? palm : flex) };
  };
  const mirrored = (b) => ({
    id: b.id.replace(/^l_/, "r_"), parent: b.parent?.replace(/^l_/, "r_") ?? null,
    role: b.role?.replace(/^left/, "right") ?? null, position: mirror(b.position),
    axes: { x: scale(mirror(b.axes.x), -1), y: mirror(b.axes.y), z: mirror(b.axes.z) },
  });
  const sided = (list) => { const left = list.map(make); return [...left, ...left.map(mirrored)]; };
  const centre = CENTRE.map(make);
  const face = FACE.map(make);
  const faceLeft = face.filter((b) => b.id.startsWith("l_"));
  const ordered = [centre[0], centre[1], ...sided(LEG), ...centre.slice(2, 7), ...sided(ARM), ...centre.slice(7),
    ...face.filter((b) => !b.id.startsWith("l_")), ...faceLeft, ...faceLeft.map(mirrored)];
  const bones = ordered.map((b) => ({ ...b, rotation: quatFromBasis(b.axes.x, b.axes.y, b.axes.z) }));
  const index = new Map(bones.map((b, i) => [b.id, i]));
  for (const b of bones) b.parentIndex = b.parent === null ? -1 : index.get(b.parent);
  const fingers = [0, 1, 2, 3, 4].map((f) => {
    const joints = [0, 1, 2].map((j) => at(`l_finger${f}${j}`));
    const tip = tips[`finger${f}Tip`];
    const lengths = [Math.hypot(...sub(joints[1], joints[0])), Math.hypot(...sub(joints[2], joints[1])), Math.hypot(...sub(tip, joints[2]))];
    return { joints, tip, dir: normalize(sub(tip, joints[0])), lengths };
  });
  return { bones, index, fingers, palm, across, handDir };
}

/** The rig declaration for .fun3d `rig` (format 4.5). */
export function rig(skeleton, height, rest = "A") {
  const roles = {};
  for (const b of skeleton.bones) if (b.role) roles[b.role] = b.id;
  return { name: RIG_NAME, version: RIG_VERSION, rest, height, roles };
}
