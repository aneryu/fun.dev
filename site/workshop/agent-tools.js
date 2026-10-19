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
  views: {
    type: "array",
    items: {
      enum: ["current", "front", "back", "left", "right", "top", "perspective"],
    },
    minItems: 1,
    maxItems: 6,
  },
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
  overlays: object({ wire: bool, selection: bool, data: bool }),
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
    "blueprints",
    "List the parametric blueprints (id, version, title, parameter schema). Build one with apply [{op:'blueprint', id, params?, root?}]; live parameters then follow assemblyParameters, structural ones need the blueprint again.",
    object(),
    true,
  ],
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
    "Evaluate without changing the draft. Returns compact proposed nodes/bounds, materials, results and validation; optional views render the proposal. detail:'full' also returns the complete project mesh.",
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
    object({ ids, mergeStatic: { oneOf: [ids, { const: "auto" }] }, origin, rootName: str, force: bool }),
    true,
  ],
  [
    "exportReport",
    "Report render vertices, shared buffers, mesh/material groups and bounds.",
    object({ ids, mergeStatic: { oneOf: [ids, { const: "auto" }] }, origin, rootName: str }),
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
    "Put a reference image (data URL; the CLI also accepts path) behind the model in one orthographic view. center is [horizontal, vertical] metres along the view's screen axes from the origin; width in metres. Kept with the draft, never exported. observe({references:true}) renders it.",
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
    "Open a GLB. A workshop project file (.funmodel.glb) restores its editable project; any other GLB becomes editable parts (hierarchy, names, flat PBR materials, polygons; skins, animations, textures reported, not imported). mode replace (default, undoable) or add under parent. data is base64; the local adapter also accepts path.",
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
    "librarySearch",
    "Search the public CC0 model library (fun.dev/models): listed models matching every word of query in id, name, tags or description, best first, with size in metres, newest version, thumbnail and page addresses, and each kit's fitting agreement. Chinese queries search Chinese text.",
    object({
      query: str,
      type: { enum: ["prop", "piece", "vehicle", "character", "creature", "animation", "scene", "world"] },
      kit: str,
      tags: { type: "array", items: str, maxItems: 8 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      offset: { type: "integer", minimum: 0 },
      locale: { enum: ["en", "zh"] },
    }),
    true,
  ],
  [
    "libraryModel",
    "One library model: text in both languages, kit, every approved version with stats (size, bounds, triangles), whether it has a workshop project (editable), and each file's address, SHA-256 and size (model.glb, source.funmodel.glb, thumbnail.png, model.fun3d …).",
    object({ id: str }, ["id"]),
    true,
  ],
  [
    "openLibraryModel",
    "Open a library model to edit or derive from: its workshop project when the version has one (editable) or its model.glb as parts. mode replace (default, undoable) or add under parent. version defaults to the newest. The project records it in sources (kind, id, version, file, sha256).",
    object(
      {
        id: str,
        version: { type: "string", pattern: "^v\\d{3}$" },
        mode: { enum: ["replace", "add"] },
        parent: str,
        name: str,
        ifRevision: revision,
      },
      ["id", "ifRevision"],
    ),
    false,
  ],
  [
    "place",
    "Place a library model by reference (docs/worlds.md): model is an id or id@vNNN, id names the part; parent, position, rotation, scale, tags, params, variants, tint as for create; the part keeps the library's bounds, never the geometry. Markers, zones, paths and rules: apply (create kind marker | zone | path; op rule | removeRule).",
    object(
      {
        model: str,
        id: str,
        version: { type: "string", pattern: "^v\\d{3}$" },
        parent: str,
        name: str,
        position: vector,
        rotation: vector,
        scale: vector,
        tags: { type: "array", items: str, maxItems: 16 },
        params: { type: "object" },
        variants: { type: "object", additionalProperties: str },
        tint: vector,
        label: str,
        ifRevision: revision,
      },
      ["model", "id", "ifRevision"],
    ),
    false,
  ],
  [
    "derive",
    "Run rules (one with id, some with ids, else all): resolves their models in the library, evaluates each from its seed and replaces what it derived before with placed parts carrying many copies.",
    object({ id: str, ids: { type: "array", items: str, minItems: 1 }, label: str, ifRevision: revision }, ["ifRevision"]),
    false,
  ],
  [
    "map",
    "A top-down map: every part with zones (blue), paths (orange) and markers (green) over it; returns the image, metres per pixel and the bounds.",
    object({ size: render.size, ids, shading: render.shading, helpers: bool, visibility: render.visibility }),
    true,
  ],
  [
    "audit",
    "What a picture cannot show: overlaps, floating or buried parts, parts outside the tile(s), unconverted placed models, stale or underived rules, triangle budgets (per tile in a world). Findings carry suggestions.",
    object({ ground: num, budget: object({ triangles: num }) }),
    true,
  ],
  [
    "exportTile",
    "The scene as one .fun3d tile: parts as geometry, placed models as references, markers, zones, paths and terrain as data, the project in the editing section. Written to --artifacts when set.",
    object({ name: str }),
    true,
  ],
  [
    "exportWorld",
    "A world: world.json, tiles cut by tile.size (+ far files), world.fun3d (markers, zones, paths, runtime rules), the source project, placed models' .fun3d (converted versions only). far: { minSize, step } | false. Under --artifacts when set.",
    object({ name: str, far: { oneOf: [object({ minSize: num, step: num }), bool] } }),
    true,
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
      openWorldHint: method.startsWith("library") || ["openLibraryModel", "place", "exportWorld"].includes(method),
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
    // preview calls them views; both names are accepted here.
    const { names, views, ...options } = args;
    return { method: "renderViews", args: [names ?? views, options] };
  }
  if (method === "loadProject")
    return { method, args: [project, { ifRevision }] };
  if (method === "checkpoint") return { method, args: [rest, { ifRevision }] };
  if (["restoreCheckpoint", "removeCheckpoint"].includes(method))
    return { method, args: [id, { ifRevision }] };
  if (method === "exportGLB" || method === "exportTile")
    return { method, args: [{ ...args, encoding: "base64" }] };
  if (method === "place" || method === "derive") {
    const { ifRevision: expected, label: title, ...options } = args;
    return { method, args: [options, { ifRevision: expected, label: title }] };
  }

  if (method === "openLibraryModel") {
    const { ifRevision: expected, ...options } = args;
    return { method, args: [options, { ifRevision: expected }] };
  }
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
