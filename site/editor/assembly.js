import { ModelError } from "./mesh.js";
import { normalizeParameters, recipeValue } from "./recipe.js";
import { worldMatrix, inverse, point, multiply, boundsOf } from "./spatial.js";

export function contains(nodes, root, id) {
  const seen = new Set();
  while (id && !seen.has(id)) {
    if (id === root) return true;
    seen.add(id);
    id = nodes.find((n) => n.id === id)?.parent;
  }
  return false;
}
export const assetFor = (project, id) =>
  project.assemblies
    ?.filter((a) => contains(project.nodes, a.root, id))
    .find(
      (a, _, matches) =>
        !matches.some(
          (b) => b !== a && contains(project.nodes, a.root, b.root),
        ),
    );
export const bindingFor = (project, id) =>
  project.assemblies?.flatMap((a) => a.bindings).find((b) => b.id === id);

export function normalizeAssembly(input, nodes) {
  const a = structuredClone(input),
    ids = new Set(nodes.map((n) => n.id));
  if (!a || !Array.isArray(a.bindings) || a.bindings.length > 128)
    throw new ModelError("Assembly needs up to 128 bindings");
  // Legacy single-assembly files acquire their common asset container.
  if (!a.root) {
    let root = nodes.find((n) => n.id === a.bindings[0]?.id)?.parent;
    while (root && !a.bindings.every((b) => contains(nodes, root, b.id)))
      root = nodes.find((n) => n.id === root)?.parent;
    a.root = root;
  }
  if (!ids.has(a.root) || nodes.find((n) => n.id === a.root).mesh)
    throw new ModelError(
      "Assembly needs an existing group root",
      "dependency",
      "assembly.root",
    );
  a.parameters = normalizeParameters(a.parameters);
  a.exposed ??= [];
  if (
    !Array.isArray(a.exposed) ||
    new Set(a.exposed).size !== a.exposed.length ||
    a.exposed.some((k) => !a.parameters[k] || a.parameters[k].expression)
  )
    throw new ModelError(
      "Exposed ports must name editable asset parameters",
      "dependency",
    );
  if (
    a.overrides &&
    (!a.source ||
      typeof a.overrides !== "object" ||
      Array.isArray(a.overrides) ||
      Object.entries(a.overrides).some(
        ([k, v]) =>
          !a.parameters[k] || a.parameters[k].expression || !Number.isFinite(v),
      ))
  )
    throw new ModelError(
      "Overrides need a linked source and editable numeric parameters",
      "dependency",
    );
  const bound = new Map();
  for (const b of a.bindings) {
    if (
      !ids.has(b.id) ||
      bound.has(b.id) ||
      b.id === a.root ||
      !contains(nodes, a.root, b.id)
    )
      throw new ModelError(
        "Assembly bindings must name unique descendants of its root",
        "dependency",
        "assembly.bindings",
      );
    if (
      Object.keys(b).some(
        (k) =>
          ![
            "id",
            "position",
            "rotation",
            "options",
            "recipeValues",
            "assetValues",
          ].includes(k),
      )
    )
      throw new ModelError("Unknown assembly binding field");
    for (const key of ["position", "rotation"])
      if (b[key] && (!Array.isArray(b[key]) || b[key].length !== 3))
        throw new ModelError("Binding needs a three-component vector");
    const dependencies = new Set();
    const ancestors = (id) => {
      while (id) {
        dependencies.add(id);
        id = nodes.find((n) => n.id === id)?.parent;
      }
    };
    const scan = (v, depth = 0) => {
      if (depth > 24) throw new ModelError("Assembly expression nesting limit");
      if (!v || typeof v !== "object") return;
      if (v.$anchor) {
        const anchor = v.$anchor;
        if (
          !contains(nodes, a.root, anchor.node) ||
          !["min", "max", "center", "origin"].includes(anchor.point) ||
          !["x", "y", "z"].includes(anchor.axis)
        )
          throw new ModelError(
            "Anchor must reference a node inside this asset",
            "dependency",
          );
        ancestors(anchor.node);
        if (anchor.point !== "origin")
          nodes
            .filter((n) => contains(nodes, anchor.node, n.id))
            .forEach((n) => dependencies.add(n.id));
      }
      Object.values(v).forEach((x) => scan(x, depth + 1));
    };
    scan(b);
    ancestors(nodes.find((n) => n.id === b.id)?.parent);
    bound.set(b.id, { binding: b, dependencies });
  }
  const sorted = [],
    visiting = new Set(),
    done = new Set();
  function visit(id) {
    if (done.has(id) || !bound.has(id)) return;
    if (visiting.has(id))
      throw new ModelError(
        "Assembly anchor dependency cycle: " + id,
        "dependency",
      );
    visiting.add(id);
    for (const dep of bound.get(id).dependencies) visit(dep);
    visiting.delete(id);
    done.add(id);
    sorted.push(bound.get(id).binding);
  }
  bound.forEach((_, id) => visit(id));
  a.bindings = sorted;
  return a;
}
export function normalizeAssemblies(input, nodes) {
  if (!Array.isArray(input) || input.length > 64)
    throw new ModelError("Expected up to 64 assemblies");
  const items = input.map((a) => normalizeAssembly(a, nodes)),
    result = [],
    visiting = new Set(),
    done = new Set();
  for (const a of items) {
    if (items.some((b) => b !== a && b.root === a.root))
      throw new ModelError("Asset roots must be unique", "dependency");
    for (const b of a.bindings) {
      const owner = assetFor({ nodes, assemblies: items }, b.id);
      if (
        owner !== a &&
        (owner?.root !== b.id ||
          assetFor(
            { nodes, assemblies: items },
            nodes.find((n) => n.id === b.id).parent,
          ) !== a ||
          b.options ||
          b.recipeValues)
      )
        throw new ModelError(
          "Parent assets may drive child roots and exposed ports only",
          "dependency",
        );
      if (
        b.assetValues &&
        (owner === a ||
          !owner ||
          Object.keys(b.assetValues).some((k) => !owner.exposed.includes(k)))
      )
        throw new ModelError(
          "Asset binding needs explicitly exposed child parameter ports",
          "dependency",
        );
    }
  }
  function visit(a) {
    if (done.has(a.root)) return;
    if (visiting.has(a.root))
      throw new ModelError("Linked asset parameter cycle", "dependency");
    visiting.add(a.root);
    if (a.source) {
      const source = items.find((b) => b.root === a.source);
      if (!source)
        throw new ModelError("Unknown asset parameter source", "dependency");
      visit(source);
    }
    visiting.delete(a.root);
    done.add(a.root);
    result.push(a);
  }
  items.forEach(visit);
  return result;
}
export function rebuildAssemblies(project, run, synchronize) {
  project.assemblies = normalizeAssemblies(
    project.assemblies ?? [],
    project.nodes,
  );
  const jobs = new Map(),
    bindings = new Map(),
    incoming = new Map();
  for (const a of project.assemblies)
    for (const b of a.bindings) {
      if (bindings.has(b.id))
        throw new ModelError(
          "Multiple asset writers for " + b.id,
          "dependency",
        );
      bindings.set(b.id, { a, b });
      if (b.assetValues) incoming.set(b.id, b);
    }
  const ancestors = (id) => {
    const result = [];
    while (id) {
      result.push(id);
      id = project.nodes.find((n) => n.id === id)?.parent;
    }
    return result;
  };
  for (const a of project.assemblies) {
    const dependencies = [];
    if (a.source) dependencies.push("params:" + a.source);
    if (incoming.has(a.root)) dependencies.push("binding:" + a.root);
    jobs.set("params:" + a.root, {
      dependencies,
      run() {
        const parameters = structuredClone(
          a.source
            ? project.assemblies.find((b) => b.root === a.source).parameters
            : a.parameters,
        );
        for (const [k, v] of Object.entries({
          ...a.overrides,
          ...incoming.get(a.root)?.values,
        })) {
          if (!parameters[k] || parameters[k].expression)
            throw new ModelError(
              "Unknown or derived parameter: " + k,
              "dependency",
            );
          parameters[k].value = v;
        }
        a.parameters = normalizeParameters(parameters);
      },
    });
    for (const b of a.bindings) {
      const dependencies = new Set(["params:" + a.root]);
      const transformSources = (id, targetPath, seen = new Set()) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        for (const ancestor of ancestors(id)) {
          if (targetPath.includes(ancestor)) continue;
          if (bindings.has(ancestor)) dependencies.add("binding:" + ancestor);
          const symmetry = project.nodes.find(
            (n) => n.id === ancestor,
          )?.symmetry;
          if (symmetry) {
            transformSources(symmetry.source, targetPath, seen);
            transformSources(symmetry.reference, targetPath, seen);
          }
        }
      };
      const geometrySources = (id, seen = new Set()) => {
        if (seen.has(id)) return;
        seen.add(id);
        const n = project.nodes.find((v) => v.id === id);
        if (!n) return;
        const writer = bindings.get(id)?.b;
        if (writer?.options || writer?.recipeValues)
          dependencies.add("binding:" + id);
        if (n.instanceOf) geometrySources(n.instanceOf, seen);
        if (n.symmetry) {
          geometrySources(n.symmetry.source, seen);
          // Mirror geometry also reads the source/plane transforms.
          for (const source of [n.symmetry.source, n.symmetry.reference])
            for (const ancestor of ancestors(source))
              if (bindings.has(ancestor))
                dependencies.add("binding:" + ancestor);
        }
      };
      const scan = (v) => {
        if (!v || typeof v !== "object") return;
        if (v.$anchor) {
          const anchor = v.$anchor;
          const targetPath = ancestors(
            project.nodes.find((n) => n.id === b.id).parent,
          );
          const sourcePath = ancestors(anchor.node);
          transformSources(anchor.node, targetPath);
          // Shared ancestors cancel in the bound node's parent frame.
          for (const id of [
            ...targetPath.filter((id) => !sourcePath.includes(id)),
            ...sourcePath.filter((id) => !targetPath.includes(id)),
          ])
            if (bindings.has(id)) dependencies.add("binding:" + id);
          if (anchor.point !== "origin") {
            for (const n of project.nodes)
              if (n.mesh && contains(project.nodes, anchor.node, n.id))
                geometrySources(n.id);
            for (const [id, entry] of bindings)
              if (
                contains(project.nodes, anchor.node, id) &&
                (id !== anchor.node || entry.b.options || entry.b.recipeValues)
              )
                dependencies.add("binding:" + id);
          }
        }
        Object.values(v).forEach(scan);
      };
      scan(b);
      jobs.set("binding:" + b.id, {
        dependencies,
        run() {
          const node = project.nodes.find((n) => n.id === b.id);
          const context = {
            anchor: (anchor) => {
              const frame = inverse(worldMatrix(project, node.parent));
              let value;
              if (anchor.point === "origin")
                value = point(
                  multiply(frame, worldMatrix(project, anchor.node)),
                  [0, 0, 0],
                );
              else {
                const points = project.nodes
                  .filter(
                    (n) => n.mesh && contains(project.nodes, anchor.node, n.id),
                  )
                  .flatMap((n) => {
                    const m = multiply(frame, worldMatrix(project, n.id));
                    return n.mesh.vertices.map((v) => point(m, v));
                  });
                if (!points.length)
                  throw new ModelError("Anchor has no bounds: " + anchor.node);
                value = boundsOf(points)[anchor.point];
              }
              return value[["x", "y", "z"].indexOf(anchor.axis)];
            },
          };
          const value = (v) => recipeValue(v, a.parameters, context);
          if (b.assetValues)
            incoming.set(b.id, { values: value(b.assetValues) });
          if (b.recipeValues)
            run(project, {
              op: "recipeParameters",
              id: b.id,
              values: value(b.recipeValues),
            });
          if (b.options)
            run(project, {
              op: "parameters",
              id: b.id,
              options: value(b.options),
            });
          if (b.position || b.rotation)
            run(project, {
              op: "set",
              id: b.id,
              ...(b.position ? { position: value(b.position) } : {}),
              ...(b.rotation ? { rotation: value(b.rotation) } : {}),
            });
          synchronize(project);
        },
      });
    }
  }
  const visiting = new Set(),
    done = new Set();
  function visit(key) {
    if (done.has(key)) return;
    if (visiting.has(key))
      throw new ModelError("Assembly dependency cycle: " + key, "dependency");
    visiting.add(key);
    const job = jobs.get(key);
    if (!job)
      throw new ModelError("Unknown assembly dependency: " + key, "dependency");
    for (const dep of job.dependencies) visit(dep);
    job.run();
    visiting.delete(key);
    done.add(key);
  }
  jobs.forEach((_, key) => visit(key));
}

// Copy the dependency graph together with geometry; external copies stay independent.
export function copyAssemblies(project, map, mode = "independent") {
  const remap = (value) => {
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          ["id", "root", "node"].includes(k) ? (map.get(v) ?? v) : remap(v),
        ]),
      );
    return value;
  };
  const copies = (project.assemblies ?? [])
    .filter((a) => map.has(a.root))
    .map((a) => {
      const copy = remap(a);
      delete copy.source;
      delete copy.overrides;
      if (mode === "linked") copy.source = a.root;
      else if (a.source && map.has(a.source)) {
        copy.source = map.get(a.source);
        if (a.overrides) copy.overrides = structuredClone(a.overrides);
      }
      return copy;
    });
  if (mode !== "static") project.assemblies.push(...copies);
}
export function toolboxAssemblyCommands(recipe) {
  const p = (name) => ({ $param: name }),
    op = (name, a, b) => ({ $expr: name, args: [a, b] });
  const parameters = {
    width: { value: 0.72, min: 0.2, max: 3 },
    height: { value: 0.4, min: 0.15, max: 2 },
    depth: { value: 0.46, min: 0.2, max: 2 },
    wall: { value: 0.035, min: 0.005, max: 0.07 },
    floor: { value: 0.09, min: 0.01, max: 0.12 },
    bevel: { value: 0.006, min: 0.001, max: 0.02 },
    openAngle: { value: -32, min: -110, max: 0 },
    cavityDepth: {
      value: 0.31,
      expression: op("sub", p("height"), p("floor")),
    },
  };
  const commands = [
    { op: "create", id: "toolbox", kind: "group", name: "Toolbox" },
    {
      op: "create",
      id: "body",
      kind: "box",
      parent: "toolbox",
      material: "orange",
    },
    { op: "recipe", id: "body", definition: recipe },
    { op: "create", id: "hinge", kind: "group", parent: "toolbox" },
    {
      op: "create",
      id: "lid",
      kind: "box",
      parent: "hinge",
      material: "ink",
      options: { bevel: 0.012 },
    },
    {
      op: "create",
      id: "handle",
      kind: "box",
      parent: "lid",
      material: "cream",
      position: [0, 0.1275, 0],
      options: { size: [0.24, 0.04, 0.055], bevel: 0.008 },
    },
    {
      op: "create",
      id: "handle-post",
      kind: "box",
      parent: "lid",
      material: "cream",
      position: [-0.095, 0.0675, 0],
      options: { size: [0.05, 0.08, 0.055], bevel: 0.006 },
    },
    {
      op: "duplicate",
      id: "handle-post",
      newId: "handle-post-right",
      linked: true,
      offset: [0.19, 0, 0],
    },
    {
      op: "create",
      id: "foot-0",
      kind: "box",
      parent: "toolbox",
      material: "ink",
      options: { size: [0.12, 0.07, 0.12], bevel: 0.01 },
    },
    ...[1, 2, 3].map((i) => ({
      op: "duplicate",
      id: "foot-0",
      newId: "foot-" + i,
      linked: true,
    })),
  ];
  commands.push({
    op: "assembly",
    definition: {
      name: "Toolbox dimensions",
      root: "toolbox",
      exposed: Object.keys(parameters).filter((k) => !parameters[k].expression),
      parameters,
      bindings: [
        {
          id: "body",
          recipeValues: Object.fromEntries(
            ["width", "height", "depth", "wall", "bevel", "cavityDepth"].map(
              (k) => [k, p(k)],
            ),
          ),
          position: [0, op("add", op("div", p("height"), 2), 0.07), 0],
        },
        {
          id: "hinge",
          position: [
            0,
            op(
              "add",
              { $anchor: { node: "body", point: "max", axis: "y" } },
              0.0275,
            ),
            op("div", p("depth"), -2),
          ],
          rotation: [p("openAngle"), 0, 0],
        },
        {
          id: "lid",
          options: {
            size: [
              op("add", p("width"), 0.02),
              0.055,
              op("add", p("depth"), 0.02),
            ],
          },
          position: [0, 0, op("div", p("depth"), 2)],
        },
        ...[-1, 1].flatMap((x, i) =>
          [-1, 1].map((z, j) => ({
            id: `foot-${i * 2 + j}`,
            position: [
              op("mul", op("sub", op("div", p("width"), 2), 0.08), x),
              0.035,
              op("mul", op("sub", op("div", p("depth"), 2), 0.08), z),
            ],
          })),
        ),
      ],
    },
  });
  return commands;
}
