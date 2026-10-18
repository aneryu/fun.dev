// Blueprints: parametric model families (docs/model-editor.md "Blueprints and derivation").
// A blueprint builds an asset from parameters — a group of parts and an assembly whose
// parameters keep driving them afterwards. Live parameters (height, length…) stay bound in the
// assembly, so `assemblyParameters` re-derives the model; structural ones (counts, styles)
// shape the build and need `{op:"blueprint"}` again. The assembly records which blueprint and
// structural values made it. Blueprints are plain data and functions of parameters: an agent
// adds one by adding a module here, with the same library conventions as hand-built models.
import { ModelError } from "./mesh.js";

const p = (name) => ({ $param: name });
const op = (name, a, b) => ({ $expr: name, args: [a, b] });
const half = (name) => op("div", p(name), 2);
const neg = (name) => op("mul", p(name), -1);

// ── Street lamp: a pole with one or two arms carrying lantern heads ──────────────────────
const lampPost = {
  id: "lamp-post",
  version: 1,
  title: { zh: "路灯", en: "Street lamp" },
  description: { zh: "圆柱灯杆加横臂与灯头；高度和臂长可随时调，臂数在生成时定。", en: "A round pole with one or two arms and lantern heads; height and arm length stay adjustable, the number of arms is fixed when built." },
  params: {
    height: { value: 6, min: 2.5, max: 12, unit: "m", label: { zh: "高度", en: "Height" } },
    armLength: { value: 1.1, min: 0.3, max: 2.5, unit: "m", label: { zh: "臂长", en: "Arm length" } },
    arms: { value: 1, min: 1, max: 2, integer: true, structural: true, label: { zh: "臂数", en: "Arms" } },
  },
  materials: [
    { id: "mat_lamp_post", name: "Lamp post", color: "#4f5457", roughness: 0.55, metalness: 0.35 },
    { id: "mat_lamp_head", name: "Lamp head", color: "#2d3033", roughness: 0.6, metalness: 0.2 },
    { id: "mat_lamp", name: "Lamp", color: "#fff1c8", roughness: 0.4, emissive: "#fff1c8", emissiveIntensity: 1.5 },
  ],
  build({ arms }, { root, id }) {
    const commands = [
      { op: "create", id: root, kind: "group" },
      { op: "create", id: id("base"), kind: "cylinder", parent: root, material: "mat_lamp_post", position: [0, 0.04, 0], options: { radius: 0.17, height: 0.08, segments: 12 } },
      { op: "create", id: id("collar"), kind: "cylinder", parent: root, material: "mat_lamp_post", position: [0, 0.14, 0], options: { radius: 0.09, height: 0.12, segments: 12 } },
      // A tapered pole: a lathe from the collar to just under the arms.
      { op: "create", id: id("pole"), kind: "lathe", parent: root, material: "mat_lamp_post", position: [0, 0.1, 0], options: { profile: [[0, 0], [0.055, 0], [0.038, 5.7], [0, 5.7]], segments: 10 } },
    ];
    const bindings = [
      { id: id("pole"), options: { profile: [[0, 0], [0.055, 0], [0.038, op("sub", p("height"), 0.25)], [0, op("sub", p("height"), 0.25)]], segments: 10 } },
    ];
    // Arms reach forward (+Z); the second one back.
    for (let i = 0; i < arms; i++) {
      const sign = i ? -1 : 1, side = (name) => id(arms > 1 ? `${name}_${i ? "back" : "front"}` : name);
      const reach = (fraction, offset = 0) => op("add", op("mul", p("armLength"), fraction * sign), offset * sign);
      commands.push(
        { op: "create", id: side("arm"), kind: "box", parent: root, material: "mat_lamp_post", position: [0, 5.8, sign * 0.55], options: { size: [0.07, 0.07, 1.1], bevel: 0.01 } },
        { op: "create", id: side("head"), kind: "box", parent: root, material: "mat_lamp_head", position: [0, 5.76, sign * 1.15], options: { size: [0.26, 0.12, 0.5], bevel: 0.015 } },
        { op: "create", id: side("lamp"), kind: "box", parent: root, material: "mat_lamp", position: [0, 5.69, sign * 1.15], options: { size: [0.2, 0.02, 0.42] } },
      );
      // The head's top is the lamp's height; the arm meets the pole just below it.
      bindings.push(
        { id: side("arm"), options: { size: [0.07, 0.07, p("armLength")], bevel: 0.01 }, position: [0, op("sub", p("height"), 0.1), reach(0.5)] },
        { id: side("head"), position: [0, op("sub", p("height"), 0.06), reach(1, 0.08)] },
        { id: side("lamp"), position: [0, op("sub", p("height"), 0.13), reach(1, 0.08)] },
      );
    }
    return { commands, bindings };
  },
};

// ── Railing: posts at even spacing with one to three rails along X ───────────────────────
const railing = {
  id: "railing",
  version: 1,
  title: { zh: "栏杆", en: "Railing" },
  description: { zh: "沿 X 方向的立柱与横杆；长度和高度可随时调，立柱数和横杆数在生成时定。", en: "Posts at even spacing with horizontal rails along X; length and height stay adjustable, post and rail counts are fixed when built." },
  params: {
    length: { value: 3, min: 0.5, max: 12, unit: "m", label: { zh: "长度", en: "Length" } },
    height: { value: 1, min: 0.4, max: 1.6, unit: "m", label: { zh: "高度", en: "Height" } },
    posts: { value: 4, min: 2, max: 13, integer: true, structural: true, label: { zh: "立柱数", en: "Posts" } },
    rails: { value: 2, min: 1, max: 3, integer: true, structural: true, label: { zh: "横杆数", en: "Rails" } },
  },
  materials: [{ id: "mat_railing", name: "Railing", color: "#5a5f63", roughness: 0.5, metalness: 0.4 }],
  build({ posts, rails }, { root, id }) {
    const commands = [
      { op: "create", id: root, kind: "group" },
      // One mesh of posts: a box repeated by a recipe array whose spacing follows the length.
      { op: "create", id: id("posts"), kind: "box", parent: root, material: "mat_railing", position: [-1.5, 0.5, 0], options: { size: [0.06, 1, 0.06] } },
      { op: "recipe", id: id("posts"), definition: {
        parameters: { h: { value: 1, min: 0.1, max: 3 }, step: { value: 1, min: 0.05, max: 12 } },
        generator: { kind: "box", options: { size: [0.06, p("h"), 0.06] } },
        steps: [{ op: "array", count: posts, offset: [p("step"), 0, 0] }],
      } },
    ];
    const bindings = [
      { id: id("posts"), recipeValues: { h: p("height"), step: op("div", p("length"), posts - 1) }, position: [op("mul", p("length"), -0.5), half("height"), 0] },
    ];
    for (let i = 0; i < rails; i++) {
      // The top rail just below the posts' top, the others evenly down to a third of the height.
      const fraction = rails === 1 ? 0.95 : 0.95 - (i * (0.95 - 0.35)) / (rails - 1);
      commands.push({ op: "create", id: id(`rail_${i + 1}`), kind: "box", parent: root, material: "mat_railing", position: [0, fraction, 0], options: { size: [3, 0.04, 0.03] } });
      bindings.push({ id: id(`rail_${i + 1}`), options: { size: [op("add", p("length"), 0.06), 0.04, 0.03] }, position: [0, op("mul", p("height"), fraction), 0] });
    }
    return { commands, bindings };
  },
};

// ── Building block: a massing box with window rows, a door and a parapet or flat roof ─────
const buildingBlock = {
  id: "building-block",
  version: 1,
  title: { zh: "楼体", en: "Building block" },
  description: { zh: "带窗格、门和女儿墙的楼体体块；宽深和层高可随时调，层数、开间数和屋顶样式在生成时定。", en: "A massing block with window rows, a door and a parapet; width, depth and storey height stay adjustable, storeys, bays and the roof style are fixed when built." },
  params: {
    width: { value: 12, min: 4, max: 40, unit: "m", label: { zh: "宽", en: "Width" } },
    depth: { value: 9, min: 4, max: 40, unit: "m", label: { zh: "深", en: "Depth" } },
    floorHeight: { value: 3.2, min: 2.6, max: 4.5, unit: "m", label: { zh: "层高", en: "Storey height" } },
    floors: { value: 5, min: 1, max: 30, integer: true, structural: true, label: { zh: "层数", en: "Storeys" } },
    bays: { value: 4, min: 1, max: 12, integer: true, structural: true, label: { zh: "开间", en: "Bays" } },
    roof: { value: "parapet", options: ["parapet", "flat"], structural: true, label: { zh: "屋顶", en: "Roof" } },
  },
  materials: [
    { id: "mat_wall", name: "Wall", color: "#d9cfbd", roughness: 0.9 },
    { id: "mat_window", name: "Window", color: "#4a6b8a", roughness: 0.25 },
    { id: "mat_roof", name: "Roof", color: "#8a847a", roughness: 0.95 },
    { id: "mat_door", name: "Door", color: "#4a3b2e", roughness: 0.7 },
  ],
  build({ floors, bays, roof }, { root, id }) {
    const height = op("mul", p("floorHeight"), floors), bay = op("div", p("width"), bays);
    const commands = [
      { op: "create", id: root, kind: "group" },
      { op: "create", id: id("body"), kind: "box", parent: root, material: "mat_wall", position: [0, 8, 0], options: { size: [12, 16, 9] } },
      { op: "create", id: id("roof"), kind: "box", parent: root, material: "mat_roof", position: [0, 16.08, 0], options: { size: [12.3, 0.16, 9.3] } },
      { op: "create", id: id("door"), kind: "box", parent: root, material: "mat_door", position: [0, 1.1, 4.52], options: { size: [1.3, 2.2, 0.08] } },
    ];
    const bindings = [
      { id: id("body"), options: { size: [p("width"), height, p("depth")] }, position: [0, op("div", height, 2), 0] },
      { id: id("roof"), options: { size: [op("add", p("width"), 0.3), 0.16, op("add", p("depth"), 0.3)] }, position: [0, op("add", height, 0.08), 0] },
      { id: id("door"), position: [0, 1.1, op("add", half("depth"), 0.04)] },
    ];
    // Window panes on the front and back faces: one mesh each, repeated per bay and storey.
    for (const [name, sign] of [["windows_front", 1], ["windows_back", -1]]) {
      commands.push(
        { op: "create", id: id(name), kind: "box", parent: root, material: "mat_window", position: [0, 1.9, sign * 4.54], options: { size: [1.4, 1.3, 0.06] } },
        { op: "recipe", id: id(name), definition: {
          parameters: { w: { value: 1.4, min: 0.2, max: 6 }, bay: { value: 3, min: 0.3, max: 40 }, storey: { value: 3.2, min: 1, max: 5 } },
          generator: { kind: "box", options: { size: [p("w"), 1.3, 0.06] } },
          steps: [{ op: "array", count: bays, offset: [p("bay"), 0, 0] }, { op: "array", count: floors, offset: [0, p("storey"), 0] }],
        } },
      );
      // Panes stand a centimetre proud of the wall, so the two surfaces never coincide.
      bindings.push({ id: id(name), recipeValues: { w: op("mul", bay, 0.5), bay, storey: p("floorHeight") }, position: [op("add", op("mul", p("width"), -0.5), op("div", bay, 2)), op("mul", p("floorHeight"), 0.58), op("mul", op("add", half("depth"), 0.04), sign)] });
    }
    if (roof === "parapet") {
      for (const [name, sizeX, sizeZ, x, z] of [["parapet_front", "w", 0.2, 0, 1], ["parapet_back", "w", 0.2, 0, -1], ["parapet_left", 0.2, "d", 1, 0], ["parapet_right", 0.2, "d", -1, 0]]) {
        commands.push({ op: "create", id: id(name), kind: "box", parent: root, material: "mat_wall", position: [x * 5.9, 16.4, z * 4.4], options: { size: [sizeX === "w" ? 12 : 0.2, 0.5, sizeZ === "d" ? 8.6 : 0.2] } });
        bindings.push({ id: id(name), options: { size: [sizeX === "w" ? p("width") : 0.2, 0.5, sizeZ === "d" ? op("sub", p("depth"), 0.4) : 0.2] },
          position: [x ? op("mul", op("sub", half("width"), 0.1), x) : 0, op("add", height, 0.41), z ? op("mul", op("sub", half("depth"), 0.1), z) : 0] });
      }
    }
    return { commands, bindings };
  },
};

export const BLUEPRINTS = [lampPost, railing, buildingBlock];

/** The blueprints' ids, titles and parameter schemas, for agents and the UI. */
export function listBlueprints() {
  return BLUEPRINTS.map(({ id, version, title, description, params }) => ({ id, version, title, description, params: structuredClone(params) }));
}

/** Parameter values checked against a blueprint's schema: numbers in range, integers whole, options listed. */
export function blueprintValues(blueprint, params = {}) {
  const values = {};
  for (const [key, spec] of Object.entries(blueprint.params)) {
    const raw = params[key] ?? spec.value;
    if (spec.options) {
      if (!spec.options.includes(raw)) throw new ModelError(`${key} must be one of ${spec.options.join(", ")}`, "invalid", `params.${key}`);
      values[key] = raw;
      continue;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < spec.min || raw > spec.max) throw new ModelError(`${key} must be a number from ${spec.min} to ${spec.max}`, "invalid", `params.${key}`);
    if (spec.integer && !Number.isInteger(raw)) throw new ModelError(`${key} must be a whole number`, "invalid", `params.${key}`);
    values[key] = raw;
  }
  for (const key of Object.keys(params)) if (!blueprint.params[key]) throw new ModelError(`Unknown blueprint parameter: ${key}`, "invalid", `params.${key}`);
  return values;
}

/**
 * The commands a `{op:"blueprint", id, params?, root?, name?}` command stands for: materials
 * the project lacks, the parts under `root` (default: the blueprint id), and the assembly that
 * keeps the live parameters driving them, stamped with the blueprint and its structural values.
 */
export function blueprintCommands(command, project) {
  const blueprint = BLUEPRINTS.find((b) => b.id === command.id);
  if (!blueprint) throw new ModelError(`Unknown blueprint: ${command.id}`, "invalid", "id");
  const values = blueprintValues(blueprint, command.params ?? {});
  const root = command.root ?? blueprint.id.replace(/-/g, "_");
  if (typeof root !== "string" || !/^[\p{L}\p{N}_.-]{1,64}$/u.test(root)) throw new ModelError("Blueprint root must be a valid node ID", "invalid", "root");
  const id = (part) => `${root}_${part}`;
  const existing = new Set((project?.materials ?? []).map((m) => m.id));
  const materials = blueprint.materials.filter((m) => !existing.has(m.id)).map((m) => ({ op: "material", ...m }));
  const live = Object.fromEntries(Object.entries(blueprint.params).filter(([, spec]) => !spec.structural).map(([key, spec]) => [key, { value: values[key], min: spec.min, max: spec.max }]));
  const structural = Object.fromEntries(Object.entries(blueprint.params).filter(([, spec]) => spec.structural).map(([key]) => [key, values[key]]));
  const { commands, bindings } = blueprint.build(values, { root, id, values });
  if (command.name) commands[0] = { ...commands[0], name: command.name };
  const assembly = {
    op: "assembly",
    definition: {
      name: blueprint.title.en, root, exposed: Object.keys(live), parameters: live, bindings,
      blueprint: { id: blueprint.id, version: blueprint.version, params: structural },
    },
  };
  return [...materials, ...commands, assembly];
}
