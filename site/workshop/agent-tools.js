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
const quality = {
  antialias: { enum: ["native", "ssaa2", "ssaa4"] },
  shadows: bool,
  lighting: { enum: ["studio"] },
  exposure: { type: "number", minimum: 0.1, maximum: 4 },
};
const render = {
  views: {
    type: "array",
    items: {
      enum: ["current", "front", "back", "left", "right", "top", "perspective"],
    },
    minItems: 1,
    maxItems: 6,
  },
  // The same as views (an alias); the engine checks the names.
  names: {
    type: "array",
    items: str,
    minItems: 1,
    maxItems: 6,
  },
  size: { type: "integer", minimum: 64, maximum: 2048 },
  ...quality,
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
    "List blueprints and parameter schemas. Build with op:blueprint; edit live values with assemblyParameters, rebuild structural ones.",
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
    "Find faces, edges or vertices by geometry; page on with offset=nextOffset, topology and ifRevision.",
    querySchema,
    true,
  ],
  [
    "preview",
    "Dry run: proposed nodes/bounds, materials, results and validation without touching the draft; views render the proposal; detail:'full' adds the full mesh.",
    object(
      {
        commands: { ...commandsSchema, $defs: undefined },
        ifRevision: revision,
        views: render.names,
        size: render.size,
        detail: { enum: ["summary", "full"] },
        ...quality,
      },
      ["commands", "ifRevision"],
    ),
    true,
  ],
  [
    "apply",
    "Apply commands atomically. Components need query refs or a topology token; operationId makes a retry safe.",
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
    "Render reproducible views, selection/wire overlays or object-ID colours; along walks a path: a frame every few metres.",
    object({ ...render, along: object({ path: str, every: num, start: num, end: num, height: num, look: { oneOf: [{ enum: ["ahead", "back", "left", "right"] }, vector] }, limit: { type: "integer" } }, ["path"]) }),
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
    "Read a recipe or a primitive's implicit recipe; index reads one step. recipeStep append promotes primitives, patch edits fields (null removes). Stage 0 queries the original shape.",
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
    "Inspect input before a recipe step (index=step count for append): query references and coordinates before bakes; optional views show placed geometry and query matches. Never changes the draft.",
    object(
      {
        id: str,
        index: { type: "integer", minimum: 0, maximum: 32 },
        query: recipeStageQuerySchema,
        ...quality,
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
    "Put a reference image (data URL; the CLI takes path) behind the model in one orthographic view: center [horizontal, vertical] metres on its axes, width in metres. Kept with the draft, never exported; observe({references:true}) shows it.",
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
    "Open a GLB: a project file (.funmodel.glb) restores its project; any other GLB becomes editable parts (hierarchy, names, PBR materials, polygons; skins, animations, textures reported, not imported). mode replace (default) or add under parent. data is base64; the adapter takes path.",
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
    "Search the public CC0 model library: models matching every word of query (id, name, tags, description; Chinese too), best first, with size in metres, newest version, thumbnail and page addresses, kits' fitting agreements.",
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
    "One library model: text in both languages, kit, every approved version with stats (size, bounds, triangles), whether it has a workshop project, and each file's address, SHA-256 and size (model.glb, source.funmodel.glb, thumbnail.png, model.fun3d).",
    object({ id: str }, ["id"]),
    true,
  ],
  [
    "openLibraryModel",
    "Open a library model to edit or derive from: its workshop project when the version has one, else its model.glb as parts. mode replace (default) or add under parent; version defaults to the newest; recorded in sources.",
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
    "Place a library reference (model: id or id@vNNN); id names the part. Keeps bounds, not geometry. Other fields follow create.",
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
    "Resolve models and rerun seeded rules, replacing previous results. Select id, ids, or all by default.",
    object({ id: str, ids: { type: "array", items: str, minItems: 1 }, label: str, ifRevision: revision }, ["ifRevision"]),
    false,
  ],
  [
    "map",
    "Top-down zones, paths, markers and tiles; overlays.nav adds navigation. Returns image, scale and bounds.",
    object({ size: render.size, ids, shading: render.shading, helpers: bool, visibility: render.visibility, overlays: object({ data: bool, tiles: bool, nav: bool }) }),
    true,
  ],
  [
    "audit",
    "Audit overlap, floating/buried/outside parts, unconverted models, stale rules, unreachable markers and tile budgets; suggests fixes.",
    object({ ground: num, budget: object({ triangles: num }) }),
    true,
  ],
  [
    "exportTile",
    "Export one .fun3d tile with geometry, references, scene data and editable source. Honors --artifacts.",
    object({ name: str }),
    true,
  ],
  [
    "exportWorld",
    "Export world.json, tiles and far files, world.fun3d scene data, source and placed models. far configures LOD; honors --artifacts.",
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
    "Export .funmodel.glb: GLB with editable FUNDEV_workshop source. Honors --artifacts.",
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
      args: [commands, { ifRevision, views, size, ...rest }],
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
