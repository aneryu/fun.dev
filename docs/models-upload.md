# Uploading models

For whoever delivers models to the fun.dev [model library](models.md), such as the Blender
pipeline. Uploads wait for review; nothing is public until it is approved.

## Where

Sign in to https://console.fun.dev (Cloudflare Access sends a one-time code to the owner's
email) and open **上传**. Choose one or more zips, or a folder. The page runs the server's checks
in the browser, lists every version with ✓ or ✗ and the reasons, and uploads the versions that
pass. Files the server already has are skipped, so uploading again is safe. Uploaded versions
appear under **审核** as 待审.

## What to upload

Single props (`type: "prop"`) and modular pieces (`type: "piece"`) only, not scenes, demos or
assemblies; characters, creatures, animations and scenes follow later. One model is one GLB
made to the production spec: metres, glTF +Y up, front +Z, root at the centre of the bounding
box's floor, no external files.

## Layout

Each version is a folder `<id>/<version>/`, at any depth inside the zip or folder (a top folder
is fine; several zips are merged):

```
<id>/<version>/meta.json
<id>/<version>/model.glb
<id>/<version>/preview.png
<id>/<version>/source.blend   optional, published with the model
<id>/<version>/...            optional, kept for review only (qa.json, readme.md, more previews)
```

- `<id>`: `<name>_<NN>`, lowercase letters, digits and `_`, at most 64 characters, e.g.
  `desk_chair_01`.
- `<version>`: `v` and three digits, e.g. `v002`. A revision is a new version of the same id.
- File names: lowercase letters, digits, `.`, `_` and `-`, at most 64 characters; no subfolders.

### meta.json

```json
{
  "name": { "zh": "书椅", "en": "Desk chair" },
  "type": "prop",
  "kit": "reading_room",
  "tags": ["furniture", "chair", "indoor"]
}
```

- `name` (required): short Chinese and English names, at most 100 characters each.
- `type` (required): `prop` or `piece`. It cannot change once a version is approved.
- `kit` (optional): models that belong together share one, in the id's format.
- `tags` (optional): up to 20 lowercase words.
- Other fields (for example `spec`, `source`) are kept but not published.

`name`, `type`, `kit` and `tags` belong to the model, so the latest upload replaces them for
every version; the reviewer may edit them too.

### Files

| File | Rules |
| --- | --- |
| `model.glb` | glTF 2.0 binary, at most 10 MB; embedded buffers and images only; POSITION accessors with min and max; no Draco, KTX2 or meshopt compression |
| `preview.png` | a PNG, square (900 × 900 is fine), shown in lists |
| others | at most 50 MB each |

The page also warns when a model does not stand on y = 0 or is off centre on x or z; that does
not block the upload, but review will notice.

## After review

An approved version cannot change; upload fixes as a new version. A rejected version shows the
reviewer's note in the console; fix it and upload the same version again, which puts it back to
待审.
