import {
  commandsSchema,
  modelDefinitions,
  querySchema,
  recipeStageQuerySchema,
  validateSchema,
} from "./agent-contract.js";
import { ModelError } from "./mesh.js";
const str = { type: "string" },
  num = { type: "number" },
  bool = { type: "boolean" },
  revision = { type: "integer", minimum: 0 };
const vector = { type: "array", items: num, minItems: 3, maxItems: 3 };
const object = (properties = {}, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const ids = { type: "array", items: str, minItems: 1 };
const origin = { enum: ["world", "asset-root", "ground-center"] };
const render = {
  names: {
    type: "array",
    items: {
      enum: ["current", "front", "back", "left", "right", "top", "perspective"],
    },
    minItems: 1,
    maxItems: 6,
  },
  size: { type: "integer", minimum: 64, maximum: 2048 },
  ids,
  visibility: { enum: ["session", "all"] },
  shading: { enum: ["material", "clay", "silhouette", "ids"] },
  helpers: bool,
  overlays: object({ wire: bool, selection: bool }),
  focus: bool,
  projection: { enum: ["perspective", "orthographic"] },
  references: bool,
  camera: object(
    {
      position: vector,
      target: vector,
      up: vector,
      projection: { enum: ["perspective", "orthographic"] },
      near: num,
      far: num,
      fov: num,
      height: num,
      zoom: num,
      aspect: num,
      left: num,
      right: num,
      top: num,
      bottom: num,
      projectionMatrix: {
        type: "array",
        items: num,
        minItems: 16,
        maxItems: 16,
      },
      worldMatrix: { type: "array", items: num, minItems: 16, maxItems: 16 },
    },
    ["position", "target"],
  ),
};
const definitions = [
  [
    "presets",
    "Get ready-to-use hollow-box recipe and toolbox assembly commands. Toolbox commands require an empty project with the default palette.",
    object(),
    true,
  ],
  [
    "undo",
    "Undo one change; revision is monotonic and unsaved parameter input is protected.",
    object({ ifRevision: revision }, ["ifRevision"]),
    false,
  ],
  [
    "redo",
    "Redo one change with revision protection.",
    object({ ifRevision: revision }, ["ifRevision"]),
    false,
  ],
  [
    "flush",
    "Wait for pending IndexedDB writes; failure reports applied but unsaved changes.",
    object(),
    true,
  ],
  [
    "capabilities",
    "Discover units, limits and command names. Request command for its complete schema, or detail:full for the full contract.",
    object({ command: str, detail: { enum: ["summary", "full"] } }),
    true,
  ],
  [
    "inspect",
    "Inspect compact document/node metadata and parameters. Use detail:'full' only for complete geometry; query pages return component references.",
    object({ id: str, detail: { enum: ["summary", "full"] } }),
    true,
  ],
  [
    "select",
    "Select objects or current component references for observation overlays.",
    object(
      {
        ids,
        mode: { enum: ["object", "face", "edge", "vertex"] },
        faces: { type: "array" },
        edges: { type: "array" },
        vertices: { type: "array" },
        topology: str,
      },
      ["ids"],
    ),
    true,
  ],
  [
    "query",
    "Find faces, edges or vertices by geometry. For another page pass offset=nextOffset, topology and ifRevision=revision from the first page.",
    querySchema,
    true,
  ],
  [
    "preview",
    "Evaluate without changing the draft. Returns compact proposed nodes/bounds, materials, results and validation; optional views render the proposal. detail:'full' additionally returns the complete project mesh.",
    object(
      {
        commands: { ...commandsSchema, $defs: undefined },
        ifRevision: revision,
        views: render.names,
        size: render.size,
        detail: { enum: ["summary", "full"] },
      },
      ["commands", "ifRevision"],
    ),
    true,
  ],
  [
    "apply",
    "Atomically apply commands. Components need query refs or an explicit topology token. Use operationId for retries within this session.",
    object(
      {
        commands: { ...commandsSchema, $defs: undefined },
        ifRevision: revision,
        operationId: str,
        label: str,
        includeComponents: bool,
      },
      ["commands", "ifRevision"],
    ),
    false,
  ],
  [
    "observe",
    "Render reproducible views, selection/wire overlays or color-coded object IDs.",
    object(render),
    true,
  ],
  [
    "validate",
    "Check connectivity, self-intersections, shell orientation and asset budgets.",
    object({ triangles: num, vertices: num, drawCalls: num }),
    true,
  ],
  [
    "exportGLB",
    "Export all or selected roots; reuse geometry and optionally merge static leaves by parent and material, preserving asset motion. Returns the asset and merge-group report.",
    object({ ids, mergeStatic: ids, origin, rootName: str, force: bool }),
    true,
  ],
  [
    "exportReport",
    "Report render vertices, shared buffers, mesh/material groups and bounds.",
    object({ ids, mergeStatic: ids, origin, rootName: str }),
    true,
  ],
  [
    "getSession",
    "Read project, checkpoints, receipts and original recovery sources for backup. Large; prefer inspect for normal modeling.",
    object(),
    true,
  ],
  [
    "getProject",
    "Return the editable project JSON including parameter recipes.",
    object(),
    true,
  ],
  [
    "getRecipe",
    "Read a recipe or a primitive's implicit recipe. index reads one step. recipeStep append promotes primitives; patch edits fields (null removes). Stage 0 queries the original shape.",
    object(
      {
        id: str,
        index: { type: "integer", minimum: 0, maximum: 31 },
        ifRevision: revision,
      },
      ["id"],
    ),
    true,
  ],
  [
    "recipeStage",
    "Inspect input before a recipe step (index=step count for append). Query references/coordinates are before bakes; optional views show placed geometry and query matches. Never changes the draft.",
    object(
      {
        id: str,
        index: { type: "integer", minimum: 0, maximum: 32 },
        query: recipeStageQuerySchema,
        views: render.names,
        size: render.size,
        ifRevision: revision,
      },
      ["id", "index"],
    ),
    true,
  ],
  [
    "loadProject",
    "Replace the document with supplied editable JSON. Undoable.",
    object({ project: { type: "object" }, ifRevision: revision }, [
      "project",
      "ifRevision",
    ]),
    false,
  ],
  [
    "checkpoint",
    "Save a named persistent checkpoint; at most five per draft.",
    object({ name: str, ifRevision: revision }, ["name", "ifRevision"]),
    false,
  ],
  ["checkpoints", "List persistent checkpoints.", object(), true],
  [
    "restoreCheckpoint",
    "Restore a checkpoint as one undoable change.",
    object({ id: str, ifRevision: revision }, ["id", "ifRevision"]),
    false,
  ],
  [
    "removeCheckpoint",
    "Remove one saved checkpoint.",
    object({ id: str, ifRevision: revision }, ["id", "ifRevision"]),
    false,
  ],
  ["activity", "Read recent changes and structured failures.", object(), true],
  [
    "setReference",
    "Put a reference image (data URL; the CLI also accepts path) behind the model in one orthographic view. center is [horizontal, vertical] metres along that view's screen axes from the world origin; width in metres. Kept with the draft, never exported. observe({references:true}) renders it.",
    object(
      {
        view: { enum: ["front", "back", "left", "right", "top"] },
        image: str,
        path: str,
        width: num,
        center: { type: "array", items: num, minItems: 2, maxItems: 2 },
        opacity: num,
      },
      ["view", "width"],
    ),
    false,
  ],
  [
    "importGLB",
    "Open a GLB. A workshop project file (.funmodel.glb) restores its editable project; any other GLB becomes editable parts (hierarchy, names, flat PBR materials, polygons; skins, animations and textures are reported, not imported). mode replace (default, undoable) or add under parent. data is base64; the local CLI/MCP adapter also accepts path.",
    object(
      {
        data: str,
        path: str,
        mode: { enum: ["replace", "add"] },
        parent: str,
        name: str,
        ifRevision: revision,
      },
      ["ifRevision"],
    ),
    false,
  ],
  [
    "clearReference",
    "Remove the reference image of one view, or all without view.",
    object({ view: { enum: ["front", "back", "left", "right", "top"] } }),
    false,
  ],
  ["references", "List reference images (without image data).", object(), true],
  [
    "exportProject",
    "Return the project file: a GLB of the model carrying the editable project in its FUNDEV_workshop extension (.funmodel.glb). The adapter writes it to --artifacts when set.",
    object(),
    true,
  ],
];
const validationTools = definitions.map(
  ([method, description, inputSchema, readOnlyHint]) => ({
    name: `fun_editor_${method}`,
    description,
    inputSchema: ["apply", "preview"].includes(method)
      ? { ...inputSchema, $defs: modelDefinitions }
      : inputSchema,
    annotations: {
      readOnlyHint,
      destructiveHint: method === "removeCheckpoint",
      openWorldHint: false,
    },
  }),
);
// Discovery stays small; authoritative validation below always uses full schemas.
export const agentTools = validationTools.map((tool) => {
  if (!["fun_editor_apply", "fun_editor_preview"].includes(tool.name))
    return tool;
  const inputSchema = structuredClone(tool.inputSchema);
  delete inputSchema.$defs;
  inputSchema.properties.commands = {
    type: "array",
    minItems: 1,
    maxItems: 256,
    description:
      "Use capabilities({command:op}) for the full validated command schema.",
    items: {
      type: "object",
      required: ["op"],
      properties: {
        op: {
          enum: commandsSchema.items.oneOf.map((c) => c.properties.op.const),
        },
      },
      additionalProperties: true,
    },
  };
  return { ...tool, inputSchema };
});
export function toolInvocation(name, args = {}) {
  const tool = validationTools.find((t) => t.name === name);
  if (!tool) throw new Error("Unknown editor tool");
  validateSchema(args, tool.inputSchema);
  const method = name.slice("fun_editor_".length),
    {
      commands,
      ifRevision,
      operationId,
      label,
      views,
      size,
      project,
      id,
      ...rest
    } = args;
  if (method === "capabilities")
    return { method, args: [{ detail: "summary", ...args }] };
  if (method === "select") {
    const { ids, ...options } = args;
    return { method, args: [ids, options] };
  }
  if (method === "apply")
    return {
      method,
      args: [
        commands,
        {
          ifRevision,
          operationId,
          label,
          includeComponents: rest.includeComponents,
        },
      ],
    };
  if (method === "preview")
    return {
      method,
      args: [commands, { ifRevision, views, size, detail: rest.detail }],
    };
  if (method === "observe") {
    const { names, ...options } = args;
    return { method: "renderViews", args: [names, options] };
  }
  if (method === "loadProject")
    return { method, args: [project, { ifRevision }] };
  if (method === "checkpoint") return { method, args: [rest, { ifRevision }] };
  if (["restoreCheckpoint", "removeCheckpoint"].includes(method))
    return { method, args: [id, { ifRevision }] };
  if (method === "exportGLB")
    return { method, args: [{ ...args, encoding: "base64" }] };
  if (method === "importGLB") {
    const { ifRevision: expected, path, ...options } = args;
    if (path !== undefined || options.data === undefined)
      throw new ModelError(
        "importGLB needs data (base64); only the local adapter reads path",
        "schema",
        "data",
      );
    return { method, args: [options, { ifRevision: expected }] };
  }
  return { method, args: [args] };
}
