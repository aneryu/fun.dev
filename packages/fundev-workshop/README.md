# fundev-workshop

The [fun.dev workshop](https://fun.dev/editor/) for AI agents. A script, or an agent over
MCP, builds a 3D model with typed commands (boxes, cylinders, tori, lathes, extrusions with
arcs and holes, sweeps, booleans, bevels, arrays, blueprints), looks at it from any view, and
exports a glTF binary (GLB) plus an editable workshop project. It runs in Node: no browser,
GPU or WebGL; pictures draw in software. The engine is the web workshop's own.

Node 22 or newer.

## A model from a script

```sh
npx -y fundev-workshop --guide            # the one-page quick reference
npx -y fundev-workshop --run model.mjs    # one JSON line: validation, statistics, files
```

```js
// model.mjs
export default async function (ws) {
  await ws.load({ name: "crate_01", materials: [
    { id: "mat_wood", color: "#c89969", roughness: 0.8 },
    { id: "mat_steel", color: "#8c9399", roughness: 0.35, metalness: 0.55 },
  ] });
  await ws.apply([
    { op: "create", id: "crate_01", kind: "group" },
    { op: "create", id: "body", kind: "box", parent: "crate_01", material: "mat_wood",
      position: [0, 0.25, 0], options: { size: [0.5, 0.5, 0.5], bevel: 0.01 } },
    { op: "create", id: "band", kind: "box", parent: "crate_01", material: "mat_steel",
      position: [0, 0.25, 0], options: { size: [0.52, 0.04, 0.52] } },
  ]);
  await ws.observe(["perspective", "front"], { file: "preview.png", size: 768 });
  await ws.exportGLB({ file: "model.glb", origin: "ground-center",
    rootName: "crate_01_ROOT", mergeStatic: "auto" });
  await ws.exportProject({ file: "source.funmodel.glb" });
}
```

## MCP

```json
{
  "mcpServers": {
    "fundev-workshop": {
      "command": "npx",
      "args": ["-y", "fundev-workshop", "--mcp", "--session", "model.json", "--artifacts", "out"]
    }
  }
}
```

The server advertises typed `fun_editor_*` tools: inspect and query, apply and preview,
observe, validate, undo and checkpoints, import and export. `--session` keeps the project
between runs; `--artifacts` writes pictures, GLBs and project files and returns their paths.

## More

- `--help` lists every option. Without `--mcp` or `--run` it reads one JSON request per line
  (`{"method":"inspect","arguments":{}}`) and answers one JSON line each.
- `--browser` drives the published web workshop in a headless browser instead (`--gpu` to
  draw on the GPU); it needs `npm i playwright && npx playwright install chromium`.
- The full reference is the [workshop guide](https://fun.dev/editor/guide).

## Licence

No licence is granted yet (`UNLICENSED`). The bundled Three.js (MIT) and manifold-3d
(Apache-2.0) keep their own licences: see `THIRD_PARTY_LICENSES.md`.
