# Model library API

Status: public since 2026-10-19. fun.dev's model library ([models](models.md)) is a set of
static, read-only files that any site, tool or agent may read: an index to search, one file per
model, and the models' files themselves. Everything is **CC0-1.0**: use, change and ship it
without asking or crediting. There is no key, account or query server; the files are rewritten
whenever a model is approved, so the library is live within a minute.

```
https://cdn.fun.dev/library/index.en.json      every listed model, English
https://cdn.fun.dev/library/index.zh.json      every listed model, Chinese
https://cdn.fun.dev/library/<id>.json          one model: both languages, every version, its files
https://cdn.fun.dev/blobs/<sha256>.<ext>       a file, by the SHA-256 of its bytes
https://fun.dev/models/<id>                    the model's page (3D view, downloads)
```

- Every response allows `GET`/`HEAD` from every origin (`Access-Control-Allow-Origin: *`), so a
  page on any site can load models directly.
- `index.*.json` and `<id>.json` are cached for 60 s. Blobs never change: a new version is a
  new file at a new address, so an address you copy keeps working and can be cached forever.
- `games.fun.dev` is an older name for the same files; use `cdn.fun.dev`.

## The index

```json
{
  "licence": "CC0-1.0",
  "fields": ["id", "name", "description", "type", "kit", "tags", "size", "version", "thumbnail"],
  "kits": { "building_3m": "3 m grid, 2.8 m storeys. Walls 3 × 2.8 × 0.2 m …" },
  "models": [
    ["floor_lamp_01", "Wood-stem retro floor lamp", "A tapered warm-wood stem …", "prop", "",
     "furniture lighting floor-lamp wood retro home", [0.42, 1.55, 0.42], "v002", "e0b804a3…"]
  ]
}
```

One array per listed model, its values in the order of `fields` (read them by name: fields may
be added). `kit` is empty or the id of a kit in `kits`, whose text is the fitting agreement its
pieces share (grid, heights, origins). `tags` are separated by spaces. `size` is the bounding
box in metres `[x, y, z]`. `version` is the newest approved version; `thumbnail` the SHA-256 of
its `thumbnail.png`. About 1,200 models make 350 KB: download it once and search it locally.

`type` is one of `prop` (a single object), `piece` (a modular building piece), `vehicle`
(`wheel_*` nodes are its wheels), `character` (a humanoid rig by role: clips by role play on it);
`creature`, `animation`, `scene` and `world` are reserved.

## A model

```json
{
  "licence": "CC0-1.0",
  "id": "floor_lamp_01",
  "name": { "zh": "木杆复古落地灯", "en": "Wood-stem retro floor lamp" },
  "description": { "zh": "…", "en": "…" },
  "type": "prop", "kit": null, "kitDescription": null, "tags": ["furniture", "lighting"],
  "listed": true,
  "versions": [{
    "version": "v002",
    "files": {
      "model.glb":     { "sha256": "74d91fd9…", "size": 122252 },
      "source.blend":  { "sha256": "ce5598f1…", "size": 767660 },
      "thumbnail.png": { "sha256": "e0b804a3…", "size": 16325 }
    },
    "stats": { "size": [0.42, 1.55, 0.42], "min": [-0.21, 0, -0.21], "max": [0.21, 1.55, 0.21],
               "triangles": 2328, "bytes": 122252 },
    "derived": { "sha256": "63c25b8f…", "size": 2300, "converter": "sha256:31216386…",
                 "profile": "fundev-library@1" }
  }]
}
```

Versions are newest first. A file's address is `https://cdn.fun.dev/blobs/<sha256>.<extension of
its name>`, so `model.glb` above is `https://cdn.fun.dev/blobs/74d91fd9….glb`. Files a version
may have:

| File | What |
| --- | --- |
| `model.glb` | always: the model (glTF 2.0 binary, no Draco/KTX2/meshopt needed) |
| `thumbnail.png` | the library's picture |
| `source.funmodel.glb` | the editable [workshop](model-editor.md) project (also an ordinary GLB) |
| `source.blend` | the Blender source, when it was made in Blender |

`derived`, when present, is the [.fun3d](model-format.md) file the library converted from
`model.glb` (`blobs/<sha256>.fun3d`), with the converter and profile that made it.

Models that were unlisted keep their file (`"listed": false`) so anything that pinned them still
resolves; they leave the index. Ids use `[a-z0-9_]` and never change; a version, once approved,
never changes either.

## Model conventions

Metres; glTF +Y up; the model faces +Z; the origin is the centre of the bounding box's floor;
real-world size. Nodes named `collider…` are simplified collision shapes, meant to be hidden.
Movable parts sit under groups at their pivots (`wheel_front_l`, `door_hinge`); materials named
`mat_light_*`, `mat_lamp`, `mat_window` glow at night in fun.dev games; `mat_sign_face` and
`mat_plate` are blank faces for text. See [models](models.md#contents).

## Examples

```sh
# Find chairs, then download the newest version of the first one
curl -s https://cdn.fun.dev/library/index.en.json | grep -i -o '\["[a-z0-9_]*chair[a-z0-9_]*"' | head
curl -s https://cdn.fun.dev/library/desk_chair_01.json
```

```js
// In a browser or Node 22+, with three.js
const library = "https://cdn.fun.dev";
const index = await (await fetch(`${library}/library/index.en.json`)).json();
const at = Object.fromEntries(index.fields.map((field, i) => [field, i]));
const chair = index.models.find((m) => m[at.tags].split(" ").includes("chair"));
const model = await (await fetch(`${library}/library/${chair[at.id]}.json`)).json();
const glb = model.versions[0].files["model.glb"];
const gltf = await new GLTFLoader().loadAsync(`${library}/blobs/${glb.sha256}.glb`);
scene.add(gltf.scene);
```

## In the workshop

The [workshop](model-editor.md) reads the library itself, in the page and in the Node tool
(`npx -y fundev-workshop`), so agents search, open and derive without handling files:

| Method (MCP tool `fun_editor_<method>`) | What |
| --- | --- |
| `librarySearch({ query?, type?, kit?, tags?, limit?, offset?, locale? })` | listed models matching every word of `query` (id and name first, then tags, then descriptions), with size, version, thumbnail and page addresses, and the agreement of each kit in the results; Chinese queries search the Chinese index |
| `libraryModel({ id })` | text in both languages, kit, and every version with its stats, `editable` (has a workshop project), each file's `url`, `sha256` and `size`, and the derived `.fun3d` |
| `openLibraryModel({ id, version?, mode?, parent?, name? }, { ifRevision })` | opens the version (default newest): its workshop project when it has one, else `model.glb` as editable parts; `mode: "add"` adds its parts to the current project (under `parent`) to assemble scenes; undoable |

In model scripts: `ws.librarySearch({ query })`, `ws.libraryModel(id)`,
`ws.openLibraryModel(id, { mode, version })`.

A project remembers what it was made from in `sources`, kept in project files and through edits
and undo: `[{ "kind": "library", "id", "version", "file", "sha256" }]`, one entry per model
opened or added (an added project brings its own sources). Readers drop kinds they do not know,
so later kinds (other libraries, files from elsewhere) can be added without breaking older tools.
Uploading a derived model to the library is internal for now ([models](models.md)); anyone may
publish theirs elsewhere under any licence.

The Node tool reads `https://cdn.fun.dev` (`FUNDEV_LIBRARY_ORIGIN` overrides it); the page reads
the library of the site it is served from.

## Later

Deferred for future consideration, not rejected: a query API with server-side search and paging
(once the library reaches several thousand models), outside uploads with review, sources
written into exported GLBs (`asset.extras`), and the model's family and parameters on its page
when it was derived from a blueprint.
