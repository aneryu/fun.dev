// The procedural character generator (docs/character-generator.md).
//
//   const character = generateCharacter({ seed: 7, lod: 0 });              // or { data, params: { body: … } }
//   character.mesh.positions, .normals, .uvs, .joints, .weights, .indices   // typed arrays
//   character.skeleton.bones                                               // world rest pose, parents first
//
// Everything a character is made from comes from a data set (`data`: { id, shapes, garments,
// faces }), by default the repository's CC0 one (data/index.js). Bodies are a few fitted base
// shapes, not free parameters; garments and hair are fitted to each body and go in the same mesh
// as islands of their own. Equal (version, data, seed, params, lod) give equal arrays.

import { createRandom, hashString } from "../random.js";
import { buildBody, EYE_COLOURS, LODS } from "./body.js";
import { CC0 } from "./data/index.js";
import { faceDeltas, facesFor, FEATURES, featureRange } from "./face.js";
import { buildSkeleton, rig } from "./skeleton.js";
import { sub } from "./vec.js";

export const GENERATOR = "fundev-character";
export const GENERATOR_VERSION = "4.2.0";
const MAJOR = GENERATOR_VERSION.split(".")[0];

/**
 * Garment slots, each worn over the body or "none". A garment may cover other slots (an outfit
 * takes the top and the bottom): wearing it empties them.
 */
export const SLOTS = ["outfit", "top", "bottom", "shoes", "hair", "brows"];

/** The repository's data set, used when none is given. */
export const DEFAULT_DATA = CC0;

/** A body's garments for a slot (ids), from a data set. */
export const garmentsFor = (body, slot, data = DEFAULT_DATA) => Object.entries(data.garments[body] ?? {}).filter(([, g]) => g.slot === slot).map(([id]) => id);

/**
 * A data set's parameters: which base body (builds between them, slim or heavy, come as more
 * shapes), the eyes, the face (when the set has faces), and a garment and its colour per slot.
 * Garments and faces are fitted per body, so their options depend on the body.
 */
export function parametersFor(data = DEFAULT_DATA) {
  const bodies = Object.keys(data.shapes), faces = [...new Set(bodies.flatMap((b) => facesFor(b, data.faces)))];
  return [
    { id: "body", options: bodies, label: "base body" },
    // Eyes when a body has eyeballs (a mannequin has none).
    ...(bodies.some((b) => data.shapes[b].eyes !== false) ? [{ id: "eyes", options: EYE_COLOURS, label: "eye colour" }] : []),
    // A face is a blend of two of the body's faces, then the feature sliders.
    ...(faces.length ? [
      { id: "face", options: faces, label: "face (per body)" },
      { id: "face2", options: faces, label: "second face (per body)" },
      { id: "faceMix", range: [0, 1], label: "face → second face" },
      ...FEATURES.map((f) => ({ id: f[0], range: featureRange(f), label: f[1] ? `${f[1]} ↔ ${f[2]}` : f[2] })),
    ] : []),
    ...SLOTS.map((slot) => ({ id: slot, options: ["none", ...new Set(bodies.flatMap((body) => garmentsFor(body, slot, data)))], label: `${slot} (per body)` })),
    // A garment's colour: one of its variants (letters), per garment.
    ...SLOTS.map((slot) => ({ id: `${slot}Colour`, options: [...new Set(Object.values(data.garments).flatMap((g) => Object.values(g).filter((x) => x.slot === slot).flatMap((x) => x.colours ?? [])))].sort(), label: `${slot} colour (per garment)` })),
  ];
}

/** The default data set's parameters. */
export const PARAMETERS = parametersFor();

/** A named stream for one subsystem, so a change in one never shifts another's draws. */
export const stream = (seed, name) => createRandom(hashString(`${MAJOR}|${seed}|${name}`));

/** The population layer's default recipe: a body drawn from the seed, dressed from its garments. */
export function sampleSemantic(seed, body = null, data = DEFAULT_DATA) {
  const r = stream(seed, "population");
  const bodies = Object.keys(data.shapes);
  const drawn = bodies[Math.floor(r.next() * bodies.length)];
  const out = { body: body ?? drawn };
  const looks = stream(seed, "looks");
  out.eyes = EYE_COLOURS[Math.floor(looks.next() * EYE_COLOURS.length)];
  const faces = facesFor(out.body, data.faces);
  if (faces.length) {
    out.face = faces[Math.floor(looks.next() * faces.length)];
    out.face2 = faces[Math.floor(looks.next() * faces.length)];
    out.faceMix = round3(looks.next());
    // Features stay near the middle: a triangular spread over ±0.6 (or 0–0.5 for one-sided ones).
    for (const f of FEATURES) {
      const [lo] = featureRange(f), x = looks.next(), y = looks.next();
      out[f[0]] = round3(lo < 0 ? (x + y - 1) * 0.6 : x * y * 0.5);
    }
  }
  const dress = stream(seed, "garments");
  for (const slot of SLOTS) {
    const ids = garmentsFor(out.body, slot, data);
    const pick = Math.floor(dress.next() * ids.length), wear = dress.next();
    // An outfit for about half the people; separates for the rest.
    out[slot] = ids.length && (slot !== "outfit" || wear < 0.5) ? ids[pick] : "none";
  }
  coverSlots(out, data, {});
  for (const slot of SLOTS) out[`${slot}Colour`] = colourOf(seed, out.body, slot, out[slot], data);
  return out;
}

/**
 * Empties the slots a worn garment covers. A covered slot given explicitly wins over a covering
 * garment drawn from the seed; both given explicitly is an error.
 */
function coverSlots(out, data, given) {
  for (const slot of SLOTS) {
    const covers = data.garments[out.body]?.[out[slot]]?.covers ?? [];
    for (const other of covers) {
      if (out[other] === "none") continue;
      if (given[other] !== undefined && given[other] !== "none") {
        if (given[slot] !== undefined) throw new Error(`${slot} ${out[slot]} covers ${other}; it cannot be worn with ${out[other]}`);
        out[slot] = "none";
        break;
      }
      out[other] = "none";
    }
  }
}

/** A worn garment's colour drawn from the seed, by slot and garment (so one garment's change keeps another's colour). */
function colourOf(seed, body, slot, id, data) {
  const colours = data.garments[body]?.[id]?.colours ?? [];
  return colours.length ? colours[Math.floor(stream(seed, `colour|${slot}|${id}`).next() * colours.length)] : "none";
}

const round3 = (x) => Math.round(x * 1000) / 1000;

/** Parameters: those given override the seed's (a body given is dressed from its own garments). */
export function resolveParameters(seed, params = {}, data = DEFAULT_DATA) {
  const parameters = data === DEFAULT_DATA ? PARAMETERS : parametersFor(data);
  for (const p of parameters) {
    const x = params[p.id];
    if (x === undefined) continue;
    if (p.options && !p.options.includes(x)) throw new Error(`${p.id} must be one of ${p.options.join(", ")}`);
    if (p.range && !(typeof x === "number" && x >= p.range[0] && x <= p.range[1])) throw new Error(`${p.id} must be a number in [${p.range.join(", ")}]`);
  }
  const out = { ...sampleSemantic(seed, params.body ?? null, data) };
  for (const p of parameters) {
    if (params[p.id] === undefined || p.id === "body" || SLOTS.includes(p.id) || p.id.endsWith("Colour")) continue;
    if ((p.id === "face" || p.id === "face2") && !facesFor(out.body, data.faces).includes(params[p.id])) throw new Error(`${p.id} ${params[p.id]} is not a face of body ${out.body}`);
    out[p.id] = params[p.id];
  }
  for (const slot of SLOTS) {
    const id = params[slot];
    if (id === undefined) continue;
    if (id !== "none" && !data.garments[out.body]?.[id]) throw new Error(`${slot} ${id} is not fitted to body ${out.body} (${["none", ...garmentsFor(out.body, slot, data)].join(", ")})`);
    out[slot] = id;
  }
  coverSlots(out, data, params);
  for (const slot of SLOTS) {
    const id = out[slot], colour = params[`${slot}Colour`];
    if (colour === undefined) { out[`${slot}Colour`] = colourOf(seed, out.body, slot, id, data); continue; }
    const colours = data.garments[out.body]?.[id]?.colours ?? [];
    if (!colours.includes(colour)) throw new Error(`${slot}Colour ${colour} is not a colour of ${id} (${colours.join(", ") || "none"})`);
    out[`${slot}Colour`] = colour;
  }
  return out;
}

export function generateCharacter({ seed = 1, params = {}, lod = 0, data = DEFAULT_DATA } = {}) {
  if (!Number.isInteger(lod) || lod < 0 || lod >= LODS.length) throw new Error(`lod must be 0–${LODS.length - 1}`);
  const semantic = resolveParameters(seed, params, data);
  const shape = data.shapes[semantic.body];
  const skeleton = buildSkeleton(shape);
  const worn = SLOTS.map((slot) => semantic[slot]).filter((id) => id !== "none").map((id) => ({ id, ...data.garments[semantic.body][id] }));
  const face = semantic.face === undefined ? null : faceDeltas(semantic.body, lod, semantic, data.faces);
  const mesh = buildBody(shape, skeleton, lod, { worn, eyes: semantic.eyes, face });
  const stature = shape.tips.crown[1];
  const bones = skeleton.bones.map(({ id, parent, parentIndex, role, position, rotation, axes }) =>
    ({ id, parent, parentIndex, role, position, rotation, axes }));
  return {
    generator: GENERATOR, version: GENERATOR_VERSION, data: data.id, seed, lod, semantic, stature,
    skeleton: { bones }, rig: rig(skeleton, stature, shape.rest ?? "A"), sockets: sockets(skeleton, shape), mesh,
  };
}

/** Attachment frames in bone space (format 4.1 `sockets`), keyed by bone id. */
function sockets(skeleton, shape) {
  const bone = (id) => skeleton.bones[skeleton.index.get(id)];
  const at = (boneId, world) => {
    const b = bone(boneId), d = sub(world, b.position), { x, y, z } = b.axes;
    return { bone: boneId, position: [d[0] * x[0] + d[1] * x[1] + d[2] * x[2], d[0] * y[0] + d[1] * y[1] + d[2] * y[2], d[0] * z[0] + d[1] * z[1] + d[2] * z[2]] };
  };
  const eye = shape.joints.l_eye, wrist = bone("l_hand").position, crown = shape.tips.crown;
  const headZ = shape.landmarks.headCenterZ;
  return {
    head_top: at("head", crown),
    eyes: at("head", [0, eye[1], eye[2] + 0.01]),
    l_ear: at("head", [eye[0] * 2.3, eye[1] - 0.03, headZ - 0.02]), r_ear: at("head", [-eye[0] * 2.3, eye[1] - 0.03, headZ - 0.02]),
    l_wrist: at("l_hand", wrist), r_wrist: at("r_hand", [-wrist[0], wrist[1], wrist[2]]),
    back: at("spine2", [0, bone("spine2").position[1], bone("spine2").position[2] - 0.12]),
    waist: at("spine_root", [0, bone("spine1").position[1], 0.1]),
  };
}

export { faceTint, FEATURES } from "./face.js";
export { LODS };
