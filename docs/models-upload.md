# Uploading models

For whoever delivers models to the fun.dev [model library](models.md), such as the Blender
pipeline. Uploads wait for review; nothing is listed until it is approved.

## Where

Sign in to https://console.fun.dev (Cloudflare Access sends a one-time code to the owner's
email) and open **上传**. Choose one or more zips, or a folder. The page renders each model's
thumbnail when the browser can (if not, review adds it; the upload is not held up), runs the
server's checks in the browser, lists every version with ✓ or ✗ and the reasons, and uploads the
versions that pass. Files the server already has are skipped, so
uploading again is safe. Uploaded versions appear under **审核** as 待审.

## What to upload

Single props (`type: "prop"`), modular pieces (`type: "piece"`) and humanoid characters
(`type: "character"`), not scenes, demos or assemblies; creatures, animations and scenes follow
later. One model is one GLB made to the production spec: metres, glTF +Y up, front +Z, root at
the centre of the bounding box's floor, no external files.

A character is rigged to the Mixamo skeleton in a T-pose and may carry a one-frame
`pose_display` animation for the library's pictures; the exact rules are in
[models](models.md#characters). The upload check lists anything that does not fit.

## Layout

Each version is a folder `<id>/<version>/`, at any depth inside the zip or folder (a top folder
is fine; several zips are merged):

```
<id>/<version>/meta.json
<id>/<version>/model.glb
<id>/<version>/source.blend   optional, published with the model
<id>/<version>/...            optional, kept for review only (qa.json, readme.md, preview.png)
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
  "description": {
    "zh": "四条木腿、绿色坐垫和靠背的书桌椅，适合书房、办公室、教室。",
    "en": "A desk chair with four wooden legs and a green seat and back; fits studies, offices and classrooms."
  },
  "kit": null,
  "tags": ["chair", "study"]
}
```

- `name` (required): short Chinese and English names as people say them, at most 100
  characters each, without numbers or production terms.
- `type` (required): `prop`, `piece` or `character`. It cannot change once a version is approved.
- `description` (required): one or two sentences in Chinese and English, at most 300
  characters each: what it is, how it looks, where it fits. Game makers choose models by it.
- `kit` (optional): only for models built to one set of dimensions so they fit together (a
  modular sofa, wall and floor modules), in the id's format. Merely related models share no kit.
- `tags` (optional): up to 20 lowercase words that add something. Ones every model would have
  (`low-poly`, `static`, `modular`) or that repeat the type or kit are dropped on upload.
- Other fields (for example `spec`, `source`) are kept but not published.

`name`, `type`, `description`, `kit` and `tags` belong to the model, so the latest upload
replaces them for every version; the reviewer may edit them too.

### Writing names and descriptions

Write for someone choosing a model for a game, not for the modeller. Production terms (低多边形,
静态, 视觉模型, 无品牌, low-poly, static, visual model) are flagged on upload and in review.

| | Write | Not |
| --- | --- | --- |
| name | 小轿车 / Sedan | 无品牌低多边形城市轿车 / City sedan low poly |
| name | 卷帘门 / Roller shutter | 闭合卷帘门模块 / Closed roller shutter module |
| name | 双人床 / Double bed | 双人床 / Bed double |
| description | 展开的熨衣板，绿色板面、金属交叉腿，适合洗衣房和卧室。 | 展开状态的低多边形熨衣板。静态视觉模型，不含折叠动画。 |
| description | A green delivery van, for streets and loading bays. | Static low-poly delivery van without interior. |

### Files

| File | Rules |
| --- | --- |
| `model.glb` | glTF 2.0 binary, at most 10 MB; embedded buffers and images only; POSITION accessors with min and max; no Draco, KTX2 or meshopt compression |
| `thumbnail.png` | not uploaded by makers: rendered from `model.glb` by the upload page or in review |
| `preview.png` | optional PNG, kept privately for review |
| others | at most 50 MB each |

The page also warns when a model does not stand on y = 0, is off centre on x or z, or uses
production terms; that does not block the upload, but such a version is reviewed on its own
rather than in bulk.

## After review

An approved version's model and source cannot change; upload fixes as a new version. A rejected version shows the
reviewer's note in the console; fix it and upload the same version again, which puts it back to
待审.
