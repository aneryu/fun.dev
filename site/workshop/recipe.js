import { ModelError } from "./mesh.js";
import { modelDefinitions, validateSchema } from "./agent-contract.js";

// A copied mesh owns the same input topology under a new node identity.
// Keep topology guards, including ring seeds nested inside selectors.
export function remapRecipeReferences(recipe, from, to) {
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (
      value.node === from &&
      ["faces", "edges", "vertices"].includes(value.kind) &&
      typeof value.topology === "string"
    )
      value.node = to;
    Object.values(value).forEach(visit);
  };
  visit(recipe);
}

// Old recipes did not persist their base material. Prefer faces untouched by
// explicit overrides, then the most common cached material, and freeze it.
export function recipeMaterial(recipe, mesh) {
  if (recipe.generator.material) return recipe.generator.material;
  const painted = new Set(recipe.paint?.faces?.map((f) => f.id));
  const plain = mesh.faces.filter((f) => !painted.has(f.id));
  const counts = new Map();
  for (const f of plain.length ? plain : mesh.faces)
    counts.set(f.material, (counts.get(f.material) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

const allowed = new Set([
  "inset",
  "extrude",
  "bevel",
  "cut",
  "loopCut",
  "transform",
  "vertices",
  "paint",
  "mirror",
  "boolean",
  "array",
  "deleteComponents",
  "dissolve",
  "weld",
  "fill",
  "bridge",
  "connect",
  "solidify",
  "deform",
  "displace",
  "smooth",
  "subdivide",
  "triangulate",
  "sculpt",
]);
export function normalizeRecipe(input) {
  const r = structuredClone(input);
  if (
    !r ||
    !r.parameters ||
    !r.generator ||
    !Array.isArray(r.steps) ||
    r.steps.length > 32
  )
    throw new ModelError(
      "Recipe needs parameters, a generator and at most 32 steps",
      "invalid",
      "recipe",
    );
  if (
    ![
      "box",
      "sphere",
      "cylinder",
      "cone",
      "extrude",
      "lathe",
      "revolve",
      "sweep",
      "loft",
      "torus",
      "capsule",
      "mesh",
    ].includes(r.generator.kind)
  )
    throw new ModelError("Invalid recipe generator");
  validateSchema(
    r.generator,
    {
      ...modelDefinitions.recipe.properties.generator,
      $defs: modelDefinitions,
    },
    "recipe.generator",
  );
  r.parameters = normalizeParameters(r.parameters);
  if (r.paint) {
    if (
      r.paint.rules &&
      (!Array.isArray(r.paint.rules) ||
        r.paint.rules.length > 32 ||
        r.paint.rules.some(
          (rule) =>
            !rule.select ||
            typeof rule.material !== "string" ||
            rule.select.space === "world" ||
            (rule.select.kind && rule.select.kind !== "faces"),
        ))
    )
      throw new ModelError(
        "Material rules need local face selections and a material",
      );
    if (!Array.isArray(r.paint.faces) || r.paint.faces.length > 50000)
      throw new ModelError("Invalid recipe material overrides");
    for (const f of r.paint.faces)
      if (
        typeof f.id !== "string" ||
        typeof f.material !== "string" ||
        !Array.isArray(f.vertices) ||
        f.vertices.some((i) => !Number.isInteger(i))
      )
        throw new ModelError("Invalid recipe face binding");
  }
  for (const s of r.steps) {
    if (
      !s ||
      !allowed.has(s.op) ||
      s.id ||
      s.ids ||
      s.matrix ||
      (s.space !== undefined && s.space !== "local") ||
      (s.enabled !== undefined && typeof s.enabled !== "boolean") ||
      (s.label !== undefined &&
        (typeof s.label !== "string" || s.label.length > 80))
    )
      throw new ModelError(
        "Recipe steps edit this mesh in local meters only",
        "invalid",
        "recipe.steps",
      );
    const { space, ...step } = s;
    validateSchema(
      step,
      { ...modelDefinitions.recipeStep, $defs: modelDefinitions },
      "recipe.steps",
    );
  }
  return r;
}
export function editRecipeStep(input, command) {
  const recipe = normalizeRecipe(input),
    { action, index, to, step, patch } = command;
  const validIndex = (i, end = recipe.steps.length - 1) =>
    Number.isInteger(i) && i >= 0 && i <= end;
  if (!["append", "update", "patch", "remove", "move"].includes(action))
    throw new ModelError("Unknown recipe step action");
  if (action !== "append" && !validIndex(index))
    throw new ModelError("Recipe step index is out of range");
  if (["append", "update"].includes(action) && !step)
    throw new ModelError("Provide the complete recipe step");
  if (["remove", "move", "patch"].includes(action) && step !== undefined)
    throw new ModelError("This action does not accept a step");
  if (action !== "move" && to !== undefined)
    throw new ModelError("Only move accepts a destination index");
  if (action !== "patch" && patch !== undefined)
    throw new ModelError("Only patch accepts partial fields");
  if (action === "append") {
    const at = index ?? recipe.steps.length;
    if (!validIndex(at, recipe.steps.length))
      throw new ModelError("Recipe insertion index is out of range");
    recipe.steps.splice(at, 0, structuredClone(step));
  } else if (action === "update") recipe.steps[index] = structuredClone(step);
  else if (action === "patch") {
    if (
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      !Object.keys(patch).length
    )
      throw new ModelError("Provide fields to patch");
    const target = recipe.steps[index];
    for (const [key, value] of Object.entries(patch)) {
      if (
        ![
          "enabled",
          "label",
          "distance",
          "ratio",
          "axis",
          "offset",
          "translation",
          "rotation",
          "scale",
          "pivot",
          "select",
          "face",
          "faces",
          "edge",
          "edges",
          "vertices",
          "changes",
          "material",
          "topology",
          "kind",
          "amount",
          "angle",
          "direction",
          "from",
          "to",
          "power",
          "mode",
          "along",
          "noise",
          "expr",
          "seed",
          "iterations",
          "factor",
          "volume",
          "levels",
          "smooth",
          "falloff",
          "thickness",
          "brush",
          "points",
          "radius",
          "strength",
          "spacing",
          "invert",
          "symmetry",
          "pressure",
        ].includes(key)
      )
        throw new ModelError("Unsupported step field: " + key);
      if (value === null) delete target[key];
      else target[key] = structuredClone(value);
    }
  } else if (action === "remove") recipe.steps.splice(index, 1);
  else {
    if (!validIndex(to))
      throw new ModelError("Recipe destination index is out of range");
    recipe.steps.splice(to, 0, recipe.steps.splice(index, 1)[0]);
  }
  return normalizeRecipe(recipe);
}
export function normalizeParameters(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length > 64
  )
    throw new ModelError("Expected at most 64 parameters");
  const parameters = structuredClone(input),
    visiting = new Set(),
    done = new Set();
  const resolve = (key) => {
    if (!Object.hasOwn(parameters, key))
      throw new ModelError("Unknown parameter: " + key);
    if (visiting.has(key))
      throw new ModelError("Parameter dependency cycle: " + key, "dependency");
    if (done.has(key)) return parameters[key].value;
    const p = parameters[key];
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) ||
      !p ||
      typeof p !== "object"
    )
      throw new ModelError("Invalid parameter", "invalid", `parameters.${key}`);
    visiting.add(key);
    if (p.expression)
      p.value = recipeValue(p.expression, parameters, { parameter: resolve });
    if (
      !Number.isFinite(p.value) ||
      (p.min !== undefined && !Number.isFinite(p.min)) ||
      (p.max !== undefined && !Number.isFinite(p.max)) ||
      p.value < (p.min ?? -10000) ||
      p.value > (p.max ?? 10000)
    )
      throw new ModelError(
        "Invalid or out-of-range parameter",
        "invalid",
        `parameters.${key}`,
      );
    visiting.delete(key);
    done.add(key);
    return p.value;
  };
  Object.keys(parameters).forEach(resolve);
  return parameters;
}
export function recipeValue(value, parameters, context = {}, depth = 0) {
  if (depth > 24) throw new ModelError("Expression nesting limit exceeded");
  const next = (v) => recipeValue(v, parameters, context, depth + 1);
  if (Array.isArray(value)) return value.map(next);
  if (value && typeof value === "object") {
    let n;
    if ("$param" in value) {
      if (!Object.hasOwn(parameters, value.$param))
        throw new ModelError("Unknown parameter: " + value.$param);
      n =
        (context.parameter
          ? context.parameter(value.$param)
          : parameters[value.$param].value) *
          (value.factor ?? 1) +
        (value.offset ?? 0);
    } else if ("$var" in value) {
      // A formula variable (deform.js): evaluated per vertex when the step runs.
      return value;
    } else if ("$expr" in value) {
      // Formulas (displace expr) use more functions and per-vertex variables: their
      // parameters are substituted here and the tree is left for the step to evaluate.
      if (!Array.isArray(value.args) || !value.args.length)
        throw new ModelError("Expressions need operands");
      const args = value.args.map(next);
      if (
        !["add", "sub", "mul", "div"].includes(value.$expr) ||
        args.length !== 2 ||
        !args.every(Number.isFinite)
      )
        return { $expr: value.$expr, args };
      const [a, b] = args;
      switch (value.$expr) {
        case "add":
          n = a + b;
          break;
        case "sub":
          n = a - b;
          break;
        case "mul":
          n = a * b;
          break;
        case "div":
          n = a / b;
          break;
        default:
          throw new ModelError("Unknown expression operator");
      }
    } else if ("$anchor" in value) {
      if (!context.anchor)
        throw new ModelError("Anchors are available in assembly bindings only");
      n = context.anchor(value.$anchor);
    } else
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, next(v)]),
      );
    if (!Number.isFinite(n)) throw new ModelError("Invalid expression result");
    return n;
  }
  return value;
}
export const hollowBoxRecipe = () => ({
  name: "Hollow box",
  parameters: {
    width: { value: 0.72, min: 0.1, max: 10 },
    height: { value: 0.4, min: 0.1, max: 10 },
    depth: { value: 0.46, min: 0.1, max: 10 },
    wall: { value: 0.035, min: 0.001, max: 0.1 },
    cavityDepth: { value: 0.31, min: 0.001, max: 10 },
    bevel: { value: 0.006, min: 0.00001, max: 0.05 },
  },
  generator: {
    kind: "box",
    options: {
      size: [{ $param: "width" }, { $param: "height" }, { $param: "depth" }],
    },
  },
  steps: [
    {
      op: "inset",
      select: { kind: "faces", space: "local", normal: [0, 1, 0] },
      distance: { $param: "wall" },
    },
    {
      op: "extrude",
      select: {
        kind: "faces",
        space: "local",
        normal: [0, 1, 0],
        largest: true,
      },
      distance: { $param: "cavityDepth", factor: -1 },
    },
    {
      op: "bevel",
      select: {
        kind: "edges",
        space: "local",
        at: { axis: "y", value: { $param: "height", factor: 0.5 } },
        crease: 1,
      },
      distance: { $param: "bevel" },
    },
  ],
});
