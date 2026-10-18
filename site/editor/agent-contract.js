import { ModelError } from "./mesh.js";

const string = { type: "string" },
  number = { type: "number" },
  boolean = { type: "boolean" },
  object = { type: "object" };
const list = (items) => ({ type: "array", items }),
  vector = { type: "array", items: number, minItems: 3, maxItems: 3 };
const ref = {
  type: "object",
  properties: {
    node: string,
    kind: { enum: ["faces", "edges", "vertices"] },
    id: { oneOf: [string, { type: "integer" }] },
    topology: string,
  },
  required: ["node", "kind", "id", "topology"],
  additionalProperties: false,
};
const component = { oneOf: [string, { type: "integer" }, ref] };
export const querySchema = {
  type: "object",
  properties: {
    id: string,
    kind: { enum: ["faces", "edges", "vertices"] },
    space: { enum: ["local", "world"] },
    normal: vector,
    normalTolerance: { type: "number", minimum: 0, maximum: 2 },
    at: {
      type: "object",
      properties: {
        axis: { enum: ["x", "y", "z"] },
        value: number,
        tolerance: { type: "number", minimum: 0 },
      },
      required: ["axis", "value"],
      additionalProperties: false,
    },
    boundary: {
      type: "object",
      properties: {
        axis: { enum: ["x", "y", "z"] },
        side: { enum: ["min", "max"] },
        tolerance: { type: "number", minimum: 0 },
      },
      required: ["axis", "side"],
      additionalProperties: false,
    },
    crease: { type: "number", minimum: 0, maximum: 180 },
    minLength: number,
    maxLength: number,
    largest: boolean,
    adjacentTo: list(string),
    loopFrom: ref,
    limit: { type: "integer", minimum: 1, maximum: 50000 },
    offset: { type: "integer", minimum: 0, maximum: 200000 },
    topology: string,
    ifRevision: { type: "integer", minimum: 0 },
  },
  required: ["id"],
  additionalProperties: false,
};
const selectionSchema = {
  ...querySchema,
  required: [],
  properties: { ...querySchema.properties },
};
delete selectionSchema.properties.id;
delete selectionSchema.properties.offset;
delete selectionSchema.properties.topology;
delete selectionSchema.properties.ifRevision;
// Stage queries run before affine bakes, in recipe coordinates only.
export const recipeStageQuerySchema = structuredClone(querySchema);
recipeStageQuerySchema.required = [];
delete recipeStageQuerySchema.properties.id;
delete recipeStageQuerySchema.properties.ifRevision;
recipeStageQuerySchema.properties.space = { const: "local" };
const props = {
  replacement: string,
  id: string,
  root: string,
  assetMode: { enum: ["independent", "linked", "static"] },
  override: boolean,
  resetOverrides: list(string),
  fields: {
    type: "array",
    minItems: 1,
    items: {
      enum: ["position", "rotation", "options", "recipeValues", "assetValues"],
    },
  },
  rules: {
    type: "array",
    maxItems: 32,
    items: {
      type: "object",
      properties: { name: string, material: string, select: selectionSchema },
      required: ["material", "select"],
      additionalProperties: false,
    },
  },
  newId: string,
  idMap: { type: "object", additionalProperties: string },
  replace: { type: "array", items: string, minItems: 2, maxItems: 2 },
  name: string,
  kind: {
    enum: [
      "box",
      "sphere",
      "cylinder",
      "cone",
      "lathe",
      "extrude",
      "revolve",
      "sweep",
      "mesh",
      "group",
    ],
  },
  parent: { oneOf: [string, { type: "null" }] },
  position: vector,
  rotation: vector,
  scale: vector,
  translation: vector,
  pivot: vector,
  offset: { oneOf: [number, vector] },
  material: string,
  options: {
    type: "object",
    properties: {
      size: vector,
      bevel: number,
      radius: number,
      height: number,
      segments: { type: "integer" },
      bevelSegments: { type: "integer", minimum: 1, maximum: 16 },
      rings: { type: "integer" },
      points: list({ type: "array", items: number, minItems: 2, maxItems: 2 }),
      profile: list({ type: "array", items: number, minItems: 2, maxItems: 2 }),
      depth: number,
      // Extrusions and revolved sections: holes and rounded corners.
      holes: {
        type: "array",
        maxItems: 32,
        items: list({ type: "array", items: number, minItems: 2, maxItems: 2 }),
      },
      round: number,
      roundSegments: { type: "integer" },
      angle: number,
      // Sweeps: a closed profile along a 3D path.
      path: list(vector),
      closed: boolean,
      caps: boolean,
      smooth: boolean,
      pathSegments: { type: "integer" },
      scale: {
        oneOf: [number, { type: "array", items: number, minItems: 2, maxItems: 2 }],
      },
    },
    additionalProperties: false,
  },
  mesh: {
    type: "object",
    required: ["vertices", "faces"],
    additionalProperties: false,
    properties: {
      vertices: { type: "array", minItems: 3, maxItems: 30000, items: vector },
      faces: {
        type: "array",
        minItems: 1,
        maxItems: 50000,
        items: {
          type: "object",
          required: ["id", "vertices", "material"],
          additionalProperties: false,
          properties: {
            id: string,
            material: string,
            vertices: {
              type: "array",
              minItems: 3,
              maxItems: 64,
              items: { type: "integer", minimum: 0 },
            },
          },
        },
      },
    },
  },
  ids: list(string),
  operation: { enum: ["union", "difference", "intersection"] },
  count: { type: "integer", minimum: 2, maximum: 256 },
  merge: boolean,
  newIds: { type: "array", items: string, minItems: 1, maxItems: 255 },
  with: { type: "array", items: string, minItems: 1, maxItems: 64 },
  keep: boolean,
  loose: boolean,
  thickness: { type: "number", minimum: 0 },
  angle: { type: "number", minimum: 0, maximum: 30 },
  faces: list(component),
  face: component,
  edges: list(component),
  edge: component,
  vertices: list(component),
  topology: string,
  select: selectionSchema,
  space: { enum: ["local", "world", "parent"] },
  matrix: { type: "array", items: number, minItems: 16, maxItems: 16 },
  size: vector,
  axis: { enum: ["x", "y", "z"] },
  mode: { enum: ["min", "center", "max", "clear", "rules", "keep", "inherit"] },
  reference: string,
  keepWorld: boolean,
  linked: boolean,
  distance: number,
  ratio: { type: "number", minimum: 0.01, maximum: 0.99 },
  changes: list({
    type: "object",
    properties: { index: { type: "integer", minimum: 0 }, position: vector },
    required: ["index", "position"],
    additionalProperties: false,
  }),
  color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
  roughness: { type: "number", minimum: 0, maximum: 1 },
  // Optional PBR fields; null removes them from an existing material.
  metalness: { oneOf: [{ type: "number", minimum: 0, maximum: 1 }, { type: "null" }] },
  emissive: {
    oneOf: [
      { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
      { type: "null" },
    ],
  },
  emissiveIntensity: {
    oneOf: [{ type: "number", minimum: 0, maximum: 1000 }, { type: "null" }],
  },
  opacity: { oneOf: [{ type: "number", minimum: 0, maximum: 1 }, { type: "null" }] },
  transmission: {
    oneOf: [{ type: "number", minimum: 0, maximum: 1 }, { type: "null" }],
  },
  ior: { oneOf: [{ type: "number", minimum: 1, maximum: 3 }, { type: "null" }] },
  doubleSided: { oneOf: [boolean, { type: "null" }] },
  definition: object,
  values: object,
  action: { enum: ["append", "update", "patch", "remove", "move"] },
  index: { type: "integer", minimum: 0, maximum: 31 },
  to: { type: "integer", minimum: 0, maximum: 31 },
  step: { $ref: "#/$defs/recipeStep" },
  patch: { $ref: "#/$defs/recipeStepPatch" },
};
// An inline tool solid in the part's local coordinates (recipe steps use only this form).
props.shape = {
  type: "object",
  properties: {
    kind: {
      enum: [
        "box",
        "sphere",
        "cylinder",
        "cone",
        "lathe",
        "extrude",
        "revolve",
        "sweep",
      ],
    },
    options: props.options,
    position: vector,
    rotation: vector,
    scale: vector,
    material: string,
  },
  additionalProperties: false,
};
const specs = {
  create: [
    "id kind",
    "name parent position rotation scale material options mesh",
  ],
  material: [
    "id",
    "name color roughness metalness emissive emissiveIntensity opacity transmission ior doubleSided",
  ],
  removeMaterial: ["id", "replacement"],
  purgeMaterials: ["", ""],
  renameProject: ["name", ""],
  set: ["id", "name parent position rotation scale keepWorld"],
  transform: [
    "",
    "id ids vertices faces edges topology select translation rotation scale pivot space matrix",
  ],
  dimensions: ["id size", ""],
  applyScale: ["id", ""],
  ground: ["", "id ids"],
  align: ["axis mode", "id ids reference"],
  group: ["ids newId", "name"],
  pivot: ["id offset", ""],
  parameters: ["id options", ""],
  convert: ["id", ""],
  rename: ["id newId", ""],
  duplicate: ["id newId", "name offset linked assetMode idMap replace"],
  symmetry: ["id newId axis", "name offset space linked idMap replace"],
  unlink: ["id", ""],
  vertices: ["id changes", "topology"],
  extrude: ["id distance", "faces face select topology space"],
  inset: ["id distance", "faces face select topology space"],
  bevel: ["id distance", "edges select topology space"],
  cut: ["id axis offset", "space"],
  loopCut: ["id edge ratio", "topology"],
  paint: ["id material", "faces select topology"],
  mirror: ["id axis", ""],
  delete: ["id", ""],
  recipe: ["id definition", "values"],
  recipeParameters: ["id values", ""],
  recipeStep: ["id action", "index to step patch"],
  assembly: ["definition", "root"],
  assemblyParameters: ["values", "root override resetOverrides"],
  detachBinding: ["id", "fields mode"],
  recipePaint: ["id mode", "rules"],
  boolean: ["id operation", "with shape keep"],
  array: ["id count", "offset rotation pivot linked merge newIds"],
  deleteComponents: ["id", "faces edges vertices select topology"],
  dissolve: ["id", "edges vertices select topology angle"],
  weld: ["id", "distance vertices select topology space"],
  fill: ["id", "edges select topology material"],
  bridge: ["id", "faces edges select topology"],
  connect: ["id vertices", "topology"],
  solidify: ["id thickness", "offset space"],
  separate: ["id newId", "faces select topology loose"],
  join: ["id with", ""],
};
export const commandSchema = {
  oneOf: Object.entries(specs).map(([op, [required, optional]]) => ({
    type: "object",
    properties: {
      op: { const: op },
      ...Object.fromEntries(
        (required + " " + optional)
          .split(" ")
          .filter(Boolean)
          .map((k) => [k, props[k]]),
      ),
    },
    required: ["op", ...required.split(" ").filter(Boolean)],
    additionalProperties: false,
  })),
};
// Advertise the same selection kinds that the execution boundary accepts.
for (const c of commandSchema.oneOf) {
  const kind = {
    bevel: "edges",
    inset: "faces",
    extrude: "faces",
    paint: "faces",
  }[c.properties.op.const];
  if (kind && c.properties.select)
    c.properties.select = {
      ...selectionSchema,
      properties: { ...selectionSchema.properties, kind: { const: kind } },
    };
  if (c.properties.op.const === "detachBinding")
    c.properties.mode = { enum: ["keep", "inherit"] };
}
const obj = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const expression = { $ref: "#/$defs/expression" },
  expressionVector = {
    type: "array",
    items: expression,
    minItems: 3,
    maxItems: 3,
  },
  numericMap = { type: "object", additionalProperties: expression };
const optionsSchema = structuredClone(props.options);
function expressions(schema) {
  if (schema.type === "number" || schema.type === "integer") return expression;
  const result = { ...schema };
  if (schema.items) result.items = expressions(schema.items);
  if (schema.properties)
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, expressions(v)]),
    );
  return result;
}
const steps = commandSchema.oneOf
  .filter((c) =>
    [
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
    ].includes(c.properties.op.const),
  )
  .map((c) => {
    const step = expressions(structuredClone(c));
    for (const key of [
      "id",
      "ids",
      "matrix",
      "space",
      "with",
      "keep",
      "linked",
      "newIds",
    ])
      delete step.properties[key];
    step.required = step.required.filter((k) => k !== "id");
    step.properties.enabled = boolean;
    step.properties.label = { type: "string", maxLength: 80 };
    return step;
  });
export const modelDefinitions = {
  recipeStep: { oneOf: steps },
  recipeStepPatch: obj(
    Object.fromEntries(
      Object.entries(
        Object.assign({}, ...steps.map((s) => s.properties), {
          select: expressions(selectionSchema),
        }),
      )
        .filter(([k]) => k !== "op")
        .map(([k, v]) => [k, { oneOf: [v, { type: "null" }] }]),
    ),
  ),
  expression: {
    oneOf: [
      number,
      obj({ $param: string, factor: number, offset: number }, ["$param"]),
      obj(
        {
          $expr: { enum: ["add", "sub", "mul", "div"] },
          args: { type: "array", items: expression, minItems: 2, maxItems: 2 },
        },
        ["$expr", "args"],
      ),
      obj(
        {
          $anchor: obj(
            {
              node: string,
              point: { enum: ["min", "max", "center", "origin"] },
              axis: { enum: ["x", "y", "z"] },
            },
            ["node", "point", "axis"],
          ),
        },
        ["$anchor"],
      ),
    ],
  },
  parameters: {
    type: "object",
    additionalProperties: obj(
      { value: number, min: number, max: number, expression },
      ["value"],
    ),
  },
  recipe: obj(
    {
      name: string,
      parameters: { $ref: "#/$defs/parameters" },
      generator: {
        oneOf: [
          obj(
            {
              kind: {
                enum: [
                  "box",
                  "sphere",
                  "cylinder",
                  "cone",
                  "lathe",
                  "extrude",
                  "revolve",
                  "sweep",
                ],
              },
              options: expressions(optionsSchema),
              material: string,
            },
            ["kind"],
          ),
          obj({ kind: { const: "mesh" }, mesh: props.mesh, material: string }, [
            "kind",
            "mesh",
          ]),
        ],
      },
      steps: {
        type: "array",
        maxItems: 32,
        items: { $ref: "#/$defs/recipeStep" },
      },
      basis: props.matrix,
      paint: obj(
        {
          all: string,
          layout: string,
          rules: props.rules,
          faces: list(
            obj(
              {
                id: string,
                vertices: list({ type: "integer" }),
                material: string,
              },
              ["id", "vertices", "material"],
            ),
          ),
        },
        ["faces"],
      ),
    },
    ["parameters", "generator", "steps"],
  ),
  assembly: obj(
    {
      name: string,
      root: string,
      source: string,
      exposed: list(string),
      overrides: { type: "object", additionalProperties: number },
      parameters: { $ref: "#/$defs/parameters" },
      bindings: {
        type: "array",
        maxItems: 512,
        items: obj(
          {
            id: string,
            position: expressionVector,
            rotation: expressionVector,
            options: expressions(optionsSchema),
            recipeValues: numericMap,
            assetValues: numericMap,
          },
          ["id"],
        ),
      },
    },
    ["parameters", "bindings"],
  ),
};
for (const c of commandSchema.oneOf) {
  if (c.properties.op.const === "recipe")
    c.properties.definition = { $ref: "#/$defs/recipe" };
  if (c.properties.op.const === "assembly")
    c.properties.definition = {
      oneOf: [{ type: "null" }, { $ref: "#/$defs/assembly" }],
    };
}
commandSchema.$defs = modelDefinitions;
export const commandsSchema = {
  $defs: modelDefinitions,
  type: "array",
  minItems: 1,
  maxItems: 256,
  items: { oneOf: commandSchema.oneOf },
};
export function validateSchema(
  value,
  schema,
  path = "arguments",
  root = schema,
) {
  if (schema.$defs)
    root = { ...root, $defs: { ...root.$defs, ...schema.$defs } };
  if (schema.$ref) {
    const target = root.$defs?.[schema.$ref.replace("#/$defs/", "")];
    if (!target)
      throw new ModelError("Unknown schema reference", "schema", path);
    return validateSchema(value, target, path, root);
  }
  const bad = (message) => {
    throw new ModelError(message, "schema", path);
  };
  if (schema.oneOf) {
    const failures = [];
    for (const child of schema.oneOf)
      try {
        validateSchema(value, child, path, root);
        return;
      } catch (e) {
        failures.push(e);
      }
    const matching = schema.oneOf.find(
      (c) => c.properties?.op?.const === value?.op,
    );
    if (matching) return validateSchema(value, matching, path, root);
    throw failures[0];
  }
  if (schema.const !== undefined && value !== schema.const)
    bad("Unknown operation or constant");
  if (schema.enum && !schema.enum.includes(value))
    bad("Expected one of " + schema.enum.join(", "));
  if (schema.type) {
    const valid =
      schema.type === "array"
        ? Array.isArray(value)
        : schema.type === "null"
          ? value === null
          : schema.type === "object"
            ? value !== null &&
              typeof value === "object" &&
              !Array.isArray(value)
            : schema.type === "integer"
              ? Number.isInteger(value)
              : typeof value === schema.type;
    if (!valid) bad("Expected " + schema.type);
  }
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity))
  )
    bad("Number outside allowed range");
  if (
    typeof value === "string" &&
    schema.pattern &&
    !new RegExp(schema.pattern).test(value)
  )
    bad("Invalid string format");
  if (Array.isArray(value)) {
    if (
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      bad("Unexpected number of items");
    if (schema.items)
      value.forEach((v, i) =>
        validateSchema(v, schema.items, `${path}.${i}`, root),
      );
  } else if (value && typeof value === "object") {
    for (const key of schema.required ?? [])
      if (value[key] === undefined) bad("Missing " + key);
    for (const [key, v] of Object.entries(value)) {
      if (schema.properties?.[key])
        validateSchema(v, schema.properties[key], `${path}.${key}`, root);
      else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      )
        validateSchema(v, schema.additionalProperties, `${path}.${key}`, root);
      else if (schema.additionalProperties === false)
        bad("Unknown field " + key);
    }
  }
}
export const errorInfo = (error) => ({
  name: error.name ?? "Error",
  code: error.code ?? "invalid",
  message: error.message,
  path: error.path ?? "",
  commandIndex: error.commandIndex,
  operation: error.operation,
  recipeStepIndex: error.recipeStepIndex,
  recipeOperation: error.recipeOperation,
  recipeArguments: error.recipeArguments,
  recipeParameters: error.recipeParameters,
  node: error.node,
  components: error.components,
  issues: error.issues ?? [],
  suggestion: error.suggestion,
  persistence: error.persistence,
  applied: error.applied,
  revision: error.revision,
  recovery: error.recovery,
  validation: error.validation,
});
export function capabilities({ detail = "full", command } = {}) {
  const result = {
    apiVersion: 3,
    units: "meters",
    up: "Y",
    front: "+Z",
    rotation: "XYZ degrees",
    commands: commandSchema,
    query: querySchema,
    limits: {
      commands: 256,
      nodes: 512,
      materials: 32,
      documentBytes: 8 * 1024 * 1024,
      vertices: 30000,
      triangles: 50000,
      checkpoints: 5,
    },
    persistence:
      "apply is synchronous; inspect persistence or await flush(). MCP waits for durable saves before acknowledging mutations.",
    componentReferences:
      "Use query/inspect refs; raw components require command.topology. Geometry edits invalidate references.",
    features: [
      "atomicBatch",
      "materialLifecycle",
      "dryRun",
      "compactPreview",
      "structuredErrors",
      "semanticQuery",
      "recipe",
      "recipeStepEditing",
      "primitiveRecipePromotion",
      "meshRecipePromotion",
      "exportOrigins",
      "recipeFieldReads",
      "recipeStageInspection",
      "recipeStepPatch",
      "compactInspection",
      "componentPagination",
      "duplicateIdMap",
      "assemblyParameters",
      "instanceParameterOverrides",
      "nestedAssetPorts",
      "fieldBindingDetach",
      "durableDrafts",
      "persistentCheckpoints",
      "operationLog",
      "observationOverlays",
      "objectIdImages",
      "geometryReuse",
      "selectiveExport",
      "staticMerge",
    ],
    unsupported: [
      "booleans",
      "GLB ingestion",
      "UV textures",
      "rigging",
      "animation",
      "inter-object collision validation",
    ],
  };
  if (command !== undefined) {
    const schema = commandSchema.oneOf.find(
      (c) => c.properties.op.const === command,
    );
    if (!schema) throw new ModelError("Unknown command: " + command);
    const defs = {};
    function dependencies(value) {
      if (!value || typeof value !== "object") return;
      if (value.$ref) {
        const name = value.$ref.replace("#/$defs/", "");
        if (!defs[name]) {
          defs[name] = modelDefinitions[name];
          dependencies(defs[name]);
        }
      }
      Object.values(value).forEach(dependencies);
    }
    dependencies(schema);
    return structuredClone({
      command,
      units: result.units,
      schema: {
        ...schema,
        ...(Object.keys(defs).length ? { $defs: defs } : {}),
      },
    });
  }
  if (!["full", "summary"].includes(detail))
    throw new ModelError("Unknown capability detail");
  if (detail === "summary") {
    result.commands = commandSchema.oneOf.map((c) => c.properties.op.const);
    delete result.query;
    result.discovery =
      "Use capabilities({command:op}) for one command schema; detail:full returns the complete contract.";
  }
  return structuredClone(result);
}
