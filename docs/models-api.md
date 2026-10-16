# Model upload API

For the Blender pipeline that delivers models to the fun.dev [model library](models.md).
Uploads wait for review; nothing is public until it is approved.

Base address: `https://api.fun.dev/api/models`. Every request carries the upload token:

```
Authorization: Bearer <MODELS_TOKEN>
```

## What to upload

Single props and modular pieces only, not scenes, demos or assemblies. One model is one GLB
made to the production spec: metres, glTF +Y up, front +Z, root at the centre of the bounding
box's floor, no external files.

- `<id>`: `<name>_<NN>`, lowercase letters, digits and `_`, e.g. `desk_chair_01`.
- `<version>`: `v` and three digits, e.g. `v002`. A revision is a new version of the same id.

## Endpoints

### `PUT /api/models/<id>/<version>`: metadata

JSON body. `name` is required, everything else is optional; fields not listed here are kept
as they are.

```json
{
  "name": { "zh": "书椅", "en": "Desk chair" },
  "kit": "reading_room",
  "tags": ["furniture", "chair", "indoor"]
}
```

`name`, `kit` and `tags` belong to the model, so the latest upload replaces them for every
version; the reviewer may edit them too.

### `PUT /api/models/<id>/<version>/<file>`: a file

The body is the file itself. File names use lowercase letters, digits, `.`, `_` and `-`.

| File | Required | Notes |
| --- | --- | --- |
| `model.glb` | yes | glTF 2.0 binary, no external references, at most 10 MB |
| `preview.png` | yes | square, shown in lists (900 × 900 is fine) |
| `source.blend` | no | published for download with the model |
| anything else | no | e.g. more previews, `qa.json`, `README.md`; kept for review |

Uploading a file again replaces it while the version is not approved.

### `GET /api/models/<id>/<version>`: status

```json
{
  "status": "rejected",
  "note": "Seat floats 2 cm above the floor.",
  "files": { "model.glb": { "sha256": "…", "size": 34964 } },
  "stats": { "size": [0.48, 0.85, 0.5], "triangles": 396, "bytes": 34964 }
}
```

`status` is `incomplete` (metadata, `model.glb` or `preview.png` missing), `pending`,
`approved` or `rejected`. `stats.size` is width, height and depth in metres as read from the
GLB. A rejected version can be fixed and uploaded again under the same version; it goes back
to `pending`.

## Errors

Errors are JSON, `{ "error": "<code>", "detail": "…" }`:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_id`, `invalid_version`, `invalid_file_name`, `invalid_metadata` | the address or body is malformed |
| 401 | `unauthorized` | missing or wrong token |
| 409 | `approved` | the version is approved and cannot change |
| 413 | `too_large` | the file is over its limit |
| 422 | `invalid_glb` | not a valid GLB, or it references external files |

## Example

```sh
API=https://api.fun.dev/api/models/desk_chair_01/v002
AUTH="Authorization: Bearer $MODELS_TOKEN"
curl -fsS -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  --data '{"name":{"zh":"书椅","en":"Desk chair"},"kit":"reading_room","tags":["furniture","chair"]}' "$API"
curl -fsS -T desk_chair_01_v002.glb -H "$AUTH" "$API/model.glb"
curl -fsS -T desk_chair_01_v002_preview.png -H "$AUTH" "$API/preview.png"
curl -fsS -T desk_chair_01_v002.blend -H "$AUTH" "$API/source.blend"
curl -fsS -H "$AUTH" "$API"
```

## Moving the models from Google Drive

Upload the existing models through this API: the newest version of each single prop and
modular piece. Rename files in the older `<NN>_<name>_v<NNN>` form (e.g. `03_sofa_v002`) to
`<name>_<NN>`, and set `kit` for models that belong together.
