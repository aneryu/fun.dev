# Procedural character generator

Status: specification (M0) decided 2026-10-21; M1 (the static body and the lab page) implemented
2026-10-21; bodies became fitted base shapes, then the reference bodies themselves simplified per
LOD; a minimal M5 dressed them in fitted garments and hair with colour variants, blended faces and
eye colours; M4 plays clips by role on any character, with gait and planted feet. On 2026-10-22 the
data split from the code (see [Data](#data)): the repository carries the generator, CC0 people
fitted from MakeHuman (bodies, faces, garments, hair) and CC0 clips; data fitted from reference
assets that are not ours stays outside it, for local development only. The lofted body (segments, seam rings, radius maps) below stays in the code for
shapes without a mesh. This is workshop stage 4's "low-poly characters" and replaces stage 5
(MakeHuman parametric humans) in the [roadmap](platform-roadmap.md). A character is a seed and
parameters at the source and `.fun3d` data at runtime, like every other derived model.

```
seed ─▶ base shape (joints, radius maps) ─▶ skeleton ─▶ segments lofted along bones, joined at seam rings ─▶ garments, hair, face layers
   ─▶ mesh, skin weights, corrective morphs ─▶ three.js objects | .fun3d | GLB
```

The look is toon shading with outlines on mid-low-poly meshes (4 000–8 000 triangles at LOD0).
Bodies are not free parameters: a character starts from one of a few **base shapes** fitted to
reference bodies, and identity comes from the face, hair, garments and colours. Garments are
checked against those few shapes, not against a continuous space of bodies.

## Where the code lives

| Part | Path | Notes |
| --- | --- | --- |
| Generator core | `site/runtime/kit/character/` | DOM-free, no Three.js objects inside; typed arrays out, so it runs in the web player, `fun`, workers and Node tests |
| Data | `site/runtime/kit/character/data/` | the repository's data set (CC0): people from MakeHuman (`scripts/character-makehuman.mjs`, `scripts/lib/`); see [Data](#data) |
| Clips | `site/runtime/kit/character/clips/` | CC0 role clips (`scripts/character-clips.mjs`); `motion.js`, `gait.js`, `feet.js` play them (see [Animation](#animation)) |
| Three.js | `site/runtime/kit/character/three.js` | the skinned mesh, clips as AnimationClips, a walker (see [In a game](#in-a-game)) |
| Workshop page | `site/workshop/character.html` | the character workshop (see [Lab](#lab)); `globalThis.characterLab` for page checks |
| Toon material and outline | `site/runtime/kit/materials.js` | TSL node materials (planned) |
| Workshop blueprint | `site/workshop/blueprints.js` (`character`) | the agent and `npm run derive` entry point; needs skinned meshes in the workshop document (stage 4) |
| Tests | `tests/character-*.test.mjs`, `tests/helpers/character-data.mjs` | `node --test`, on the repository's data and a small test set made from it |

Plain ESM JavaScript like the rest of the repository; no new dependencies are planned.

## Data

**Everything a character is made from is a data set** passed to the generator:
`{ id, shapes, garments, faces, textures, textureRoot, sources }` (`generateCharacter({ data })`,
`parametersFor(data)`); the parameters, their options and the seed's draws all follow the set.
The default is the repository's (`DEFAULT_DATA`, id `cc0`): people fitted from MakeHuman's CC0
assets by `scripts/character-makehuman.mjs` — two bodies (`m`, `f`), nine faces each with the
feature morphs, and garments, hair and eyebrows, with their textures in
`kit/character/data/textures` (WebP, 256–1024 px).

- **Licences file by file.** MakeHuman's assets are CC0 (the base mesh, targets, rig, weights,
  textures and clothes, per its LICENSE), but some files in packs listed as CC0 say otherwise
  (AGPL3, CC BY) or nothing. The script takes an asset only when its own file says CC0 or carries
  MakeHuman's statement of its 2020 CC0 release, and stops on anything else; `data.sources` lists
  every asset with its author and licence (a test checks they are all CC0). Their code (AGPL) is
  not used: the formats are read here.
- **The sources stay outside the repository** (`~/cc0-sources/makehuman`: makehuman's
  `makehuman/data` and the asset packs, about 0.9 GB); the script writes the fitted set.
- **Packing.** The module keeps its arrays as base64 of typed arrays (positions in 0.1 mm,
  UVs in 16 bits, weights as bone indices and bytes summing to 255) and decodes each when first
  read; a garment's topology is stored once, its positions, hidden body faces and tucked skin per
  body. 5.5 MB (2.3 MB gzipped), and 4.9 MB of textures loaded as worn.

Data fitted from assets we do not own (meshes, textures, morphs, clips) is a **reference set**:
the fitting tools write it outside the repository, and it is used only to develop and compare —
the dev server serves it at `/local/` (`FUNDEV_LOCAL_ASSETS`, never built or published), where the
workshop page offers it as "Reference (local)" with its textures and clips. Nothing from a
reference set is committed, and generated output that contains it is not published. What stays in
the repository from that work is ours: the skeleton (structure, ids and frames), the tools' methods
in the code, and the generator itself. Shippable bodies, faces and garments come next from CC0
bases (more bodies and builds, faces with their morphs) and from garments made by the generator
(shells cut from the body, as specified below).

## Determinism and versions

- A character is identified by `(generator version, seed, parameters, lod)`. Equal inputs give
  equal arrays on one JavaScript engine; the golden test pins them on Node's V8. ECMAScript does
  not require `Math.sin`, `Math.cos` or `**` to round alike everywhere, so other engines may
  differ in the last bits; derived files are cached data, so this matters only when two hosts
  regenerate the same character. A change that alters any output for the same inputs bumps
  the generator version; models record it in `extra.blueprint`, as derived models already do.
- Seeds are unsigned 32-bit integers or strings. Each subsystem draws from its own stream,
  `kit/random.js`'s `createRandom(hashString("<major>|<seed>|<stream>"))`. The streams are `population`, `body`,
  `face`, `skin`, `clothes`, `hair` and `personality`. Changing the hair generator therefore
  never changes the body for the same seed.
- Everything is computed in float64 and written as float32 at the end.

## Coordinates and units

Metres, +Y up, the character faces +Z, and its left is +X. This is the repository's convention
for models facing +Z. The model origin is on the floor, midway between the feet. The skeleton
root `hips` is the only bone with translation tracks, and root motion is extracted from it
(`root: { node: "hips", motion: "extract" }`, [format 4.6](model-format.md#46-animations)).

## Skeleton

The skeleton has five spine bones, a pelvis bone beside the spine, roll bones, three-joint
fingers and a facial rig. Joint positions come from the body shape; the frames below are ours. Bone ids are our own. The rig
declares VRM humanoid roles ([format 4.5](model-format.md#45-skeletons-and-rigs)):

```jsonc
"rig": { "name": "fundev-character", "version": 1, "rest": "A", "height": 1.7, "roles": { … } }
```

It is not `fundev-humanoid@1`, so packs authored on that rig play through rest-pose
compensated retargeting by role.

### Bones

| Id | Parent | Role |
| --- | --- | --- |
| `hips` | — | `hips` |
| `pelvis` | `hips` | — |
| `spine_root` | `hips` | — |
| `spine0` | `spine_root` | `spine` |
| `spine1` | `spine0` | — |
| `spine2` | `spine1` | `chest` |
| `spine3` | `spine2` | `upperChest` |
| `neck` | `spine3` | `neck` |
| `neck_roll` | `neck` | — |
| `head` | `neck` | `head` |
| `l_clavicle` | `spine3` | `leftShoulder` |
| `l_upperarm` | `l_clavicle` | `leftUpperArm` |
| `l_upperarm_roll` | `l_upperarm` | — |
| `l_forearm` | `l_upperarm` | `leftLowerArm` |
| `l_forearm_roll` | `l_forearm` | — |
| `l_hand` | `l_forearm` | `leftHand` |
| `l_finger<f><j>` | `l_hand` or the previous joint | `leftThumbMetacarpal` … `leftLittleDistal` |
| `l_thigh` | `pelvis` | `leftUpperLeg` |
| `l_thigh_roll` | `pelvis` | — |
| `l_calf` | `l_thigh` | `leftLowerLeg` |
| `l_foot` | `l_calf` | `leftFoot` |
| `l_toe` | `l_foot` | `leftToes` |
| `r_…` | mirrors `l_…` | `right…` |

Fingers are `f` 0–4 (thumb to little) and `j` 0–2. VRM's thumb roles are metacarpal,
proximal and distal; the other fingers' are proximal, intermediate and distal.

Facial bones hang under `face_root` (parent `head`). There are 21 of
them and none has a role: `brow_centre`; `l_`/`r_` `brow_out`, `lid_upper`, `eye`,
`cheekbone`, `lip_corner`; `upperlip_root` → `upperlip` → `l_lip_top`, `r_lip_top`; `jaw` →
`lowerlip_root` → `lowerlip` → `l_lip_bot`, `r_lip_bot`; `lowerlip_root` → `tongue`. VRM's
`jaw`, `leftEye` and `rightEye` roles map to `jaw`, `l_eye` and `r_eye`.

That is 84 bones. The format allows 256 joints and the library will allow 128, which leaves 44
for spring-bone chains (hair, skirts, coat tails).

Hips, spine and arm motion depends on the bones without a role in between (`spine_root`,
`spine1`). Plain role retargeting leaves those at rest, which stiffens the spine. M4 extends
`kit/animation.js` so a bone without a role between two role bones of one chain takes an
interpolated share of their rotation. That needs a format note in 4.5.

### Rest pose

`rig.rest` is `"A"`: the fitted reference bodies' bind pose, with the upper arms about 57° below
horizontal, the palms towards the thighs and the feet slightly turned out. Joint positions are
the shape's own (`shape.joints`), so there is no rest-pose correction between the shape and
animation authored on the reference skeleton.

### Bone axes

- Local +Y points along the bone to its child. A leaf bone's +Y continues its parent's
  direction; for the toes and fingertips it points forward along the digit.
- Local +X is the primary flexion axis, and positive rotation about +X is anatomical flexion:
  the elbow bends forward, the knee backward, the fingers into the palm. Hinge joints (elbows,
  knees, finger joints 1–2) rotate about X only. Their joint limits are ranges on X.
- Local +Z completes a right-handed frame and is the abduction axis.
- Right-side frames mirror the left: `X_r = −M·X_l`, `Y_r = M·Y_l`, `Z_r = M·Z_l`, where `M`
  reflects x. For a mirrored motion the X rotation is equal on both sides, and the Y (twist)
  and Z (abduction) rotations change sign. Procedural code multiplies those by `side` (+1 left,
  −1 right). No frame can keep +Y towards the child and also keep all three rotations equal
  under a mirror.

### Sockets

The format's `sockets` are attachment frames in node space. The generator adds `head_top`,
`eyes`, `l_ear` and `r_ear` on `head`; `l_wrist` and `r_wrist` on the hands; `back` on
`spine2`; and `waist` on `spine_root`.

## Geometry

### Segments and seam rings

The body is five kinds of segment, each built by its own generator:

| Segment | Bones it spans | Seam rings |
| --- | --- | --- |
| `head` | `neck` (upper part), `head`, face | `neck` |
| `torso` | `spine_root` … `spine3`, `neck` (lower part), clavicles, arms | `neck`, `waist`, `l_wrist`, `r_wrist` |
| `legs` | `pelvis`, thighs, calves | `waist`, `l_ankle`, `r_ankle` |
| `hand` ×2 | hand, fingers | `l_wrist` or `r_wrist` |
| `foot` ×2 | foot, toes | `l_ankle` or `r_ankle` |

A seam ring is computed once, by one function of the skeleton and parameters. Both segments
use its vertices, so the assembled mesh is watertight with shared normals across the seam. A
segment generator may use any internal topology for a given LOD and options, as long as it
ends exactly on its seam rings. One hand generator can make mitten, three-finger and
five-finger hands this way, and a head generator can add horns without touching the torso.

Seam ring vertex counts per LOD (all multiples of 4, so that rings have vertices on the
mirror plane and front to back):

| Ring | LOD0 | LOD1 |
| --- | ---: | ---: |
| `neck` | 16 | 8 |
| `waist` | 24 | 12 |
| `l_wrist`, `r_wrist` | 12 | 8 |
| `l_ankle`, `r_ankle` | 16 | 8 |

Rings go counter-clockwise about their bone's +Y and start at the direction closest to model
+Z. On the mirror plane that is the front midline. Left ring index `i` matches right ring
index `(n − i) mod n`.

### Rings and radius maps

Inside a segment the surface is lofted through rings. A ring sits at a **station** of its segment
(`stations.js`): the trunk and head stations are heights on the centre line, the limb stations a
share of the way along the two-bone line (shoulder to wrist, hip to ankle) with a frame that turns
smoothly across the elbow or knee, and the feet have four fixed rings turning from facing down
to facing forward. A body shape stores, per segment, the radius at every station of a fixed grid
and every angle (25 for the left half of centre segments, 32 around limbs); a ring at any
station and LOD samples it bilinearly. Branch points (shoulders, crotch, thumb) are ports: a
port takes a fixed arc of a parent ring's vertices as the first ring of the branch, and each
vertex of the arm's port moves to where the arm's surface, followed in from its first ring,
enters the torso.

The **extremities** (the head, the hands, the feet) are not lofted: they are pieces of the
reference body cut 1.5 cm beyond their seam ring (the neck seam sits below the jaw, so the chin
belongs to the head), cleaned (interior shells dropped), simplified for each LOD with the cut
locked, and stitched to the seam ring by angle. The head is the left half, cut on the centre
line, so the mirror makes it exactly symmetric. Their skin weights are the reference's, mapped
onto our bones (helper bones fall to their nearest mapped parent). Eyeballs are small spheres
about the eye bones. The fitted maps are smooth already, so the surface is not smoothed
afterwards (Taubin smoothing stays in `mesh.js`, off for every LOD).

For each segment kind, LOD, hand style and garment set the topology is fixed: vertex count,
index buffer and UV layout. This is what makes blending between shapes (interpolation of the
same vertices) and shared UV atlases possible.

### Budget

| LOD | Triangles, body + garments + hair | Use |
| --- | ---: | --- |
| 0 | 4 000–8 000 | near: full animation layers, outlines, corrective morphs |
| 1 | about 1 500 | middle distance: baked animation, simple foot IK |
| 2 | 300–500 | crowds: shared topology, instanced (after the MVP; needs skinned instancing in the format) |

The body alone measures about 5 300 triangles at LOD0, 2 000 at LOD1 and 1 000 at LOD2, and
generates in about 35, 10 and 5 ms in Node. LOD2 is over the crowd budget: the head's centre
line and the cuts stay locked while simplifying, which limits how far the pieces go down.
Against the reference the mean distance is under 1 mm on the head and hands and 2–4 mm on the
trunk, arms and legs (the fitting tool's `error.mjs` measures it per region). LOD2 has one ring per limb segment, so no vertex
there is weighted more than about 0.5 to an upper arm or thigh: it is for distant crowds only.
The hands are the reference's five-finger hands at every LOD.

### Vertex data

- `position` and `normal`. Normals are area-weighted over the shared-vertex mesh, so they are
  continuous across seams and mirror exactly. M2 replaces the face's with those of a fitted
  ellipsoid, which keeps toon shadows on the face clean.
- `uv0`: an atlas per segment kind, fixed per topology.
- `JOINTS_0` and `WEIGHTS_0`: at most four influences. Weights come from the ring's position
  along its chain and blend across joints; the format stores uint8 weights summing to 255.
- The outline normal (smoothed, used for the inverted hull) and the outline width, as extra
  attributes.
- Morph targets: correctives the generator derives by relofting at key poses (arm raised,
  elbow and knee at 90°, squat). Each one is the difference from the skinned result, driven
  by the joint angle.
- Loft coordinates (segment, ring, angle) are kept during generation for garments, masks and
  pattern placement, and are not exported.

## Body shapes

**Shapes carry their own mesh** (`shape.mesh[lod]`: the left half and the centre line, with
weights by our bone ids and UVs per face corner), simplified per LOD from a source body; the
generator mirrors it (keeping UVs, not flipping them) and adds eyeballs unless the shape says
`eyes: false`. A shape also gives its rest pose (`rest`, "T" or "A", which the rig declares).

The repository's **bodies** (`scripts/character-makehuman.mjs`): MakeHuman's base mesh under its
macro targets (each ethnic group's young adult of the gender, a third each), its body only
(the helper geometry left out), in metres with the feet on the floor; clipped to the left half
and simplified to 3 500, 1 200 and 400 triangles, the head keeping 40 % of each (it is simplified
apart, with the border to the rest locked), each level raised until it does not fold. Its weights
are MakeHuman's, mapped onto our bones (helpers to their nearest mapped ancestor), and every
vertex remembers which base vertices it comes from, so targets carry over exactly. **Proportions**
follow the median Chinese adult of GB/T 10000-2023 (Human dimensions of Chinese adults, 18–70,
P50): its stature (1.687 m for men, 1.572 m for women, also the bodies'), tibiale height for the
knee, forearm length, and chest, waist, hip and thigh circumferences. What the standard lacks
(standing cervicale, hip and ankle heights; calf and neck circumferences) keeps the proportions to
stature of the 2012 US Army survey (ANSUR II, NATICK/TR-15/007; public domain): cervicale,
trochanterion and lateral malleolus heights for the neck, hip and ankle joints. Shoulder width
and the upper arm stay MakeHuman's. The script weights MakeHuman's height, muscle, weight and
measurement targets (−1 to 1) so each proportion over the stature meets the goal's, at the
goal's stature: Gauss–Newton with a small damping on finite differences. Only the weights are kept (`shape.proportions`). Joints come
from the rig's joint helpers, the eyeballs' centre and radius from the eye helpers, the face's
minor joints by its head's proportions. The rest pose is MakeHuman's A-pose.

The **reference set**'s bodies (local, see [Data](#data)) are made by the fitting tool: it trims the
reference's parts where they overlap (the upper body under the head at the neck, the lower body
under the upper body at the waist) by cutting along the upper part's own edge and stitching the
two edges; legs that run up inside separate briefs are united with them first (a boolean union);
then it cuts the left half on the centre line, simplifies it with the mirror line locked, and
maps the skin weights onto our bones. UVs are per face corner: each face takes the reference
part (head, upper, lower, feet) and UV chart of the nearest reference triangle facing the same
way, and each corner reads the nearest triangle of that chart, so a chart's shared corners agree
and only real UV seams split. The generator mirrors it (keeping UVs, not flipping them) and
adds eyeballs.

**Textures** of the reference parts (diffuse, normal and specular maps) stay outside the
repository with the rest of the reference set; the textured view reads
`/local/tex/<body>/<island>_diff.png` and `_normal.png` (DirectX-style normals, so the green
channel is flipped). Against the
reference the mean distance is under 1 mm everywhere but the feet (whose sandal soles were
left out) at about 7 200 triangles at LOD0, 2 500 at LOD1 and 800–1 200 at LOD2. A body from a
mesh has no seam rings, so its garments are reference meshes too (below), not ring offsets.


The parameter layer is a choice of base shape (`params.body`), drawn from the seed when it is
not given. There are two shapes today, `m` and `f`; slim and heavy builds follow as more
shapes, and a character may then blend between neighbouring builds of one shape (same vertices,
interpolated) with a small height change. Stylisation (head size, limb thickness) is a project
setting, not a per-character parameter.

A shape is `{ joints, tips, landmarks, maps }`:

- `joints`: rest positions of the left side and centre line by bone id; `tips`: the crown, the
  toe tip and the fingertips, for leaf bones.
- `landmarks`: the crotch height, the crown, the head's centre depth, heel and toe, and the
  first leg station below the crotch.
- `maps`: radius per station and angle for the trunk, head, arm and leg, and four foot rings.

Shapes are produced by a fitting tool outside this repository from reference bodies in their
bind pose: joints from the reference skeleton, radii from rays cast out of each station's centre.
Each segment is fitted against the reference triangles that belong to it (by their skin
weights), so the trunk's rays do not run into the arms; rays are cast on both sides and
averaged, so a shape is exactly symmetric; radii far from their ring's median and cavities (a
mouth) are filled from their neighbours. The tool writes `shapes.js`; regenerate it rather than
editing it.

## Garments, hair, face

**Today's garments are reference components fitted to each body** (`garments.js`, written by
the fitting tool's `garments.mjs`). The references share the bodies' skeleton and bind pose, so a
component fits its body as it is. Each garment has a slot (`top`, `bottom`, `shoes`, `hair`) and
an id. The tool maps its skin weights onto our bones. LOD0 keeps the component as it is; LOD1 and
LOD2 are simplified with the hems locked and without pieces under 20 triangles (belt loops,
buttons). UVs are per face corner, from the component's own charts, as for the bodies. For each
body LOD the tool also stores the faces of the left half the garment `hides`: rays along the
face's normal from its centre and corners, on both sides of the body, all meet the garment
between 3 cm under the skin and 6 cm outside. The generator drops the hidden faces before it
mirrors the body, then appends each worn garment whole (not mirrored) as an island named by its
id. A dressed body is open where garments cover it; the body alone stays closed. Two fixes keep
skin from showing through cloth, since the body may be fuller than the one a garment was made
over: the tool lifts the garment's outside to 4 mm over the skin where it lies closer (or up to
2 cm under it), and stores per body LOD the skin vertices (`tucks`) that have the garment within
3 cm under them or 4 mm over them, which the generator pushes 4 mm under it. Small pieces
(belt loops, buttons) are left out at every LOD.

**The repository's garments** are MakeHuman's clothes (.mhclo): each vertex bound to three base
mesh vertices with an offset that scales with the body, so one garment fits both bodies (and the
faces' small changes). Fitted once in topology (simplified per slot: outfits to 2 000 triangles,
tops and bottoms 1 000, shoes 500, hair 2 000, eyebrows 150) and once per body in position; weights
come through the binding. A garment hides the body faces it deletes and those it covers, and the
same lift and tucks as above keep skin from showing. Slots: `outfit` (a whole outfit, which takes
the top and bottom slots: wearing it empties them; given explicitly, a top or bottom wins over a
drawn outfit), `top`, `bottom`, `shoes`, `hair`, `brows`. Colours are four tints over a garment's
texture (`tints`). Textures name islands through `characterTextures` (kit/character/three.js).

**Colours** are the reference's texture variants of each garment (up to 16, letters a–p, less
the engine's checkerboard placeholders). `params.topColour` and so on pick one; a seed draws it
per slot and garment, so changing one garment keeps the others' colours. The lab reads
`/local/tex/<body>/<id>_<letter>_diff.png`, with the garment's `<id>_normal.png`.

The parameters choose a garment per slot (`params.top` and so on, or `"none"`); a seed dresses
its character from its body's garments, and a garment not fitted to the body is an error. Today
there are a tee, jeans or trousers, sneakers and one hairstyle per body (about 8 900 and 9 700
triangles dressed at LOD0). Hair is alpha-tested cards drawn from both sides; the reference
cards come two-sided, so one side is kept. Hairstyles that rely on a shader trick of the
reference (a scalp cap mapped past u = 1) are not used. Garment UVs may repeat past 1, so their
islands keep their own textures (`/local/tex/<body>/<id>_diff.png` in the lab).

### Faces

In the repository's set, a body's **nine faces** are MakeHuman's ethnic and age mixes (each group
young, the three pairs, each group older), their head only: each face's pose less the body's,
less how far its neck moved, faded in above the neck; each has the skin of its main group at its
age. The **feature sliders** are MakeHuman's head targets (both sides' where it has one per side:
cheeks, eyes). The reference set's faces are described next.

**A face is a blend of two of the body's faces plus feature sliders** (`faces.js`, written by
the fitting tool's `faces.mjs`). The reference's generic heads (21 per body) and its face-feature
morphs share one topology. The tool locates every head vertex of each body LOD on the body's own
base head (triangle and barycentric coordinates) and stores, per face and per morph, how that
point moves; deltas fade out from 1 to 5 cm above the neck's edge, so the stitch to the upper
body stays closed, and are zero across the centre line, so the face stays mirrored. The eyeballs
move with the mean of the head's vertices within 2.2 cm of the eye bone.

- `params.face`, `params.face2` (ids `00`–`20`) and `params.faceMix` in [0, 1] blend two faces.
- 19 feature sliders (`nose_width`, `jaw_shape`, `chin_cleft`, …) run in [−1, 1] between two
  opposite morphs, or in [0, 1] for one-sided ones (`chin_cleft`, `neck`). Asymmetric morphs (a
  broken nose) are left out. A seed draws the faces uniformly, the mix in [0, 1] and the
  sliders near the middle (a triangular spread over ±0.6).
- **Skin**: each face has its own texture (`head_<id>_diff.png`; the lab uses the dominant
  face's) and a tint, the face's skin colour over the body texture's in linear light. The body's
  skin islands are multiplied by the blend of the two faces' tints.
- **Eyes**: the eyeballs are spheres with their pole forward, mapped to a cell of an 8 × 4 eye
  texture (`eyes_diff.png`); `params.eyes` picks one of the first row's eight natural colours.

### Generated garments, hair and faces (design)

These are specified in detail in their milestones. The decisions so far:

- **Garments** are defined against the body's rings. A garment lists the rings it covers, an
  offset curve and its cuts (hem, cuff, neckline shape). Garments stack in layers: L0 tight,
  L1 tops, L2 outerwear. Each layer adds its offset over the one below, and the body rings a
  garment covers are hidden by an index mask. Loose parts (skirts, coat tails, hoods) have
  their own generators and spring bones. Capsule colliders for the spring bones come from the
  body rings' radii. Rigid items attach to sockets. Shoes and gloves are parameter sets of the
  foot and hand segments. A garment is a pattern, a list of trim pieces (buttons, zips,
  pockets, placed by ring and angle) and a procedural UV pattern (stripes, plaid, colour
  blocks, stitch lines). There is no cloth simulation.
- **Hair** is a scalp shell offset from the head rings and cut along a hairline curve, plus
  lofted locks. Each lock is a guide curve, a cross-section and a taper. A hairstyle is a
  recipe of locks. UVs run along the strand for the toon highlight band. Long locks carry
  spring bones.
- **Face**: nose, brow ridge, cheekbones and chin are geometry from parameters. Eyes, brows
  and mouth are drawn into a face texture layer and deformed by the facial bones. Brows,
  beards and makeup are separate overlay layers.
- **Material**: a toon ramp with a shadow colour per material, colours from a palette and
  procedural UV patterns. The inverted-hull outline uses per-vertex width, and LOD2 crowds get
  a screen-space outline. All of it is TSL, so it runs on WebGPU and falls back to WebGL2.

## Animation

**Clips play on every generated character as they are** (`kit/character/motion.js`), because
the skeletons keep the reference's joint positions. A clip stores, per bone id and frame, the
bone's world rotation change from the rest pose, and the hips' offset from rest:

```
{ name, fps, frames, loop, rotations: { <bone id>: [x, y, z, w per frame] }, root: [x, y, z per frame] }
```

`clipTracks(skeleton, clip)` turns that into local rotations for one skeleton: a bone's world
rotation is the change times its rest world rotation, and its local rotation follows from its
parent's; a bone the clip leaves out turns with its parent. The fitting tool's
`export_anim.py` samples the reference's clips at 30 fps (the root's heading at the first frame
comes off, and the mover's motion is left out, so clips play in place), and `anim.mjs` renames
the bones. The reference's clips have no tracks for the helper bones its engine drives at run
time; the thigh roll bones, which hang from the pelvis and carry much of the upper thigh's skin,
would stay behind as the leg swings, so the tool drives them as the engine does: the thigh's
swing and half its twist about the thigh's axis (the heading taken off first). Today there are idle, walk, run and sprint for each body; like the textures they stay
outside the repository, and the lab reads them from `/local/anim/<body>/<clip>.json` (listed in
`/local/anim/index.json`) into its Pose menu. The lab's **Crowd** view shows 23 more characters
from the following seeds at the current LOD, each playing the pose or clip at its own phase.

**Clips by role** come from any humanoid skeleton. A role clip keys the world rotation changes by
role (VRM 1.0 names) and carries the source's rest position of each role and, optionally, its
standing pose (each role's change from rest when it stands):

```
{ name, fps, frames, loop, rest: { <role>: [x, y, z] }, stand: { <role>: [x, y, z, w] }, rotations: { <role>: [x, y, z, w per frame] }, hips: [x, y, z per frame] }
```

`retargetClip(roleClip, skeleton, rig)` maps it onto the bones the rig gives the roles and makes
up for a different rest pose. A limb role's change is taken after the turn from the source's rest
direction (towards the role's child) to the target's, so a T-pose source's limbs point where its
own do on our A-pose skeleton. The trunk, neck, head and shoulders are not aligned that way: their
rest directions differ by joint placement and the spine's curve, not by pose (aligned, the
MakeHuman pelvis tipped 20° and the body leant over). Theirs is the change from the source's
standing pose, put on the target's rest, which already stands. The hips' offsets scale by hip
height. Roll bones a clip leaves out
are driven as above (`clipTracks` does it for any clip). `scripts/character-clips.mjs` bakes 7
clips of the Quaternius Universal Animation Library (CC0, `sources/quaternius/ual`) to
`kit/character/clips/<id>.json` (walk_formal, talk, dance, crouch, jump, punch, interact), its standing pose being its idle's mean change by role (the trunk's and shoulders'
without the trunk's turn about the vertical; the idle stands a little turned); the lab offers
them as "CC0: <id>". They go as the kit's own motions replace them (the idle, walk, jog and sprint
already have, below, and the hit, death and sitting, by the actions). The source's formal walk is slow (72 steps a minute) with the knees bent
through stance, so the script plays it at a natural cadence (115) and remaps its knee flexion to
the typical walking knee's (Perry & Burnfield's Gait Analysis), the hips keeping the lower ankle
where it was; its hips' sway is made from the legs (they drop on the side of the swinging leg and
turn with the leg ahead), as the source's barely sways.

### Locomotion

The idle, walk, run and sprint are made, not stored: `kit/character/locomotion.js` builds role
clips from key poses (`clips/motions.json`, 18 KB) that the local tools take from reference
motion within a rule the tests check (`KEY_RULE`):

- at most five key poses per motion and body;
- only the 18 main joints (hips, three of the spine, neck, head, and each side's shoulder, upper
  arm, forearm, thigh, shin and foot), each as its rotation from standing in degrees, in steps of
  5°, and the hips' offset in whole centimetres; a standing pose of the same joints in the same
  steps; the rest positions of those joints and of the hands, toes and middle fingers' roots;
- everything else is the kit's own: the timing between poses (a periodic Catmull-Rom spline), the
  right step (the left step's mirror), the idle's breath, the fingers at rest, the hands, and the
  gaits made from these (below).

Walk, run and sprint keep four poses of the left step an eighth of a cycle apart from the heel
strike, each the mean of the left step and the mirrored right step over the reference's cycles,
the head's mean nod and turn taken off (a level gaze); a motion also keeps its cycle's length and
the hips' rise and fall (`bob`, whole centimetres), as the spline through poses an eighth of a
cycle apart rounds a run's off. The idle keeps five poses through its loop. Three gaits are made
from those at another stride and pace: a stroll (half the walk's stride at three quarters of its
pace, so slow walking does not blend walking with standing), a brisk walk (1.3 times the walk's
speed) and a jog (1.6 times, the run shortened), so walking turns into running over a narrow band
of speeds as people's does; a shorter stride narrows only the thighs' and upper arms' swing, the
shins and forearms keeping their bend and the feet their turn, the hips sinking so the lower ankle
stays as high. Against the reference, measured on its own skeleton, the made gaits keep the knee's
range, the thighs' and arms' swing, the trunk's lean, the elbows, the hips' rise and fall and sway
within about a tenth.

```js
const model = await (await fetch(new URL("./character/clips/motions.json", kitUrl))).json();
const clips = locomotionClips(model, character.semantic.body, { style: locomotionStyle(character.seed) });
const walker = createWalker(THREE, object, character, clips);   // its idle among them
```

A style scales the arms' swing, the hips' bounce and sway, the trunk's lean and the pace
(`STYLE`; `locomotionStyle(seed)` gives each character its own, within ±15 %, the pace ±6 %); the
lab's sliders multiply it. The gait's poses now say where the feet are down (`contacts`, from each
clip's stances: a foot within 3 cm of its lowest and not moving forward, blended as the clips are),
and the planted feet follow that rather than the feet's height: from 0.6 to 5 m/s a planted foot
moves under about 1 cm while down.

### Smoothness

Nothing in the gait may jump between frames (the lab's motion is checked frame by frame for
"jolts": a bone's turn changing by more than a few degrees from one sixtieth of a second to the
next):

- the idle gives way to moving, and back, over 0.3 s whatever the speed on the way, and the clips
  always play at their own pace; the speed the clips are chosen and blended by changes at most
  4 m/s² (so no gait gives way to another within a frame or two however quickly the walker's own
  speed changes), holding while the idle comes in on a stop;
- the walker stops quickly (a walk at 10 m/s², a run braking at 3.5 m/s², then its last step: see Transitions);
- a clip is raised as a whole by how far its soles go under (the 10th percentile of each frame's
  lowest), so a stance foot lands on the ground; a foot's lift then starts softly (its rate grows
  from none, the foot left up to 6 mm under at most: a near straight knee turns a lot for a little
  height), toes bend by as much as it takes and follow it as a spring would (quickly on, more
  slowly off), and a planted foot's lock eases in and out over 0.08 s and lets go by a run (fully
  held to 2 m/s, none from 3.5 m/s: a run's short stance would jolt its knees in and out of it).

Through the lab's demo the motions jolt less than the reference's own clips through the same walker.

### Transitions

By default the walker joins its motions continuously: its speed eases between them, stopping
quickly, (the gait
blending stroll, walk, jog, run and sprint in step), it leans forward as it speeds up and back as it
slows (0.05 rad per m/s², eased; `pitchPose`, the head kept level), and given a `facing` aside
while standing it turns toward it at up to 3.5 rad/s, easing in and out, in a few long steps as the
reference does (90° in two, 180° in three, in under a second): it turns about a point between its
feet and the foot on the side it turns to (that foot opens nearly on the spot, the other steps round
it, the body going round with them, so it ends a little aside, as the reference's 30 cm for a turn
about). Each step lifts the foot on an arc (7 cm, by a squared sine; across by a smootherstep from
15 % to 85 % of the step, so neither end jolts the knee and the foot does not drag) over 0.3 s and
plants it where, and turned as, the standing pose will put it once the body has turned up to 150°
further on, so the feet lead the turn and finish with it; as far as keeps it 7 cm from the other
foot and within 30 cm of its hip. A foot steps while it would be left turned more than 11° from
where the body will stand, the feet taking turns, the one on the side turned toward first. A
planted foot keeps its turn on the ground, pivoting with the body only past 46°. Standing, a foot
8 cm from where the standing pose puts it steps there.

A stop is immediate but ends its stride: a walk stops quickly (10 m/s²), a run brakes at 3.5 m/s²
(4 m/s to a stand in about 1.2 s and 1.6 m, in three or four strides, the reference's 1.3 s), its
stride and cadence falling through jog and walk rather than a run's legs stepping short; the arms
go from a run's to a walk's over 0.4 s (between the two the legs pass in a stride, too quickly for
the arms' bend). Under 1 m/s the gait slows to the next phase where the feet pass each other (from
its own rate, within 0.6 s) and the body goes on as far as that step takes it (`travel`, which the
walker's speed follows), then the idle comes in; a start begins at that passing phase too, so no
foot is dragged or left behind. Near full reach the legs' IK eases toward straight (the last 2 % of their reach)
rather than meeting it, so a stretched stance knee does not jitter. Side by side with the reference
this read more naturally than the key-pose clips below, which stay for games that want them.


Key-pose starts, stops and turns (`TRANSITIONS`: a turn on the spot of 90° and of 180°, a walk's and a
run's start, stop and turn about) come from key poses under the same rule: each keeps the
reference clip's first and last frame and three more between, picked greedily to lower the joints'
squared distance from a spline through the kept ones (at least 0.15 s apart, counted four times
over the window where the turn or travel happens), at times in twentieths of a second, with the
transition's length, turn (steps of 5°), travel (whole centimetres) and window. `transitionClip`
makes one (a clamped spline; `side: "right"` mirrors it, turning the other way), settled half a
second after its window. Given them (`transitions`), `createWalker` plays them instead where they
belong: from standing, a
start toward the asked speed (a run's above 2.5 m/s), or a turn on the spot toward a `facing` 45°
or more aside (180 beyond 137°); walking or running, a stop when asked to, or a turn about toward a
facing behind. A turn turns the object over its window (eased); a start or stop lets the gait step
at the speed it eases to and carries only the body above the hips (its lean and settling: five
poses cannot hold a start's several steps), and ends once the speed is there. Each blends in over
0.2 s and back to the gait over 0.3 s. The lab's "Gait demo" loops a game's asks through them, and
"Beside the reference" shows each beside the reference clip it is made from.

### Actions

Idle, scenarios and reactions (`actionNames(model, body)`, `actionClip(model, body, name, { side,
root })`) come from key poses under the same rule, in `motions.json`'s `actions`: per action and
body at most five key poses at times (twentieths of a second), the main joints only, and for a
one-shot that moves, where its root is at each key (centimetres sideways and forward, its turn in
steps of 5°). Loops: hanging out, impatient, standing guard, cheering, leaning on a wall, sitting
on steps or a low wall, lying dead; once: waving, pointing, shrugging, beckoning, picking up,
taking a hit, startled, knocked down. A loop keeps one period of the reference's (its shortest
repeat, or for a long one without, the 2 to 4 seconds whose ends are nearest alike) and its
spline wraps round; it breathes as the idle does. Splines are Catmull-Rom with each key's slope
over its neighbours' time apart, so the motion's speed carries through unevenly spaced keys; a
joint's rotation near a half turn keeps, key to key, the form nearer the last (an arm raised
overhead from hanging turns some 150°: the other form would swing it back down through standing).
A one-shot's root carries its body (or, `root: false`, it plays in place for a game to move it).

What is ours: the timing between keys, the breath, the hands' shapes (`HAND_SHAPES`: relaxed, open,
point, fist; an action's on the hand it raises while it is up, or both hands), and the fit to the
surroundings: `actionFit(character, clip, { seat, back })` measures where the action sits (the
lowest point of the pelvis and upper thighs) and how far behind the heels its back goes, and gives
the clip moved to a seat of another height or a wall at another distance, the body moving and the
feet staying (`shiftBody`; sitting, planted on the ground; in a clip that sits down or gets up, by
as much as the body is down). The lab's "Action" clips show it on a plain block or wall with
sliders, beside the reference.

Through the same post-passes as any clip (feet, ground, hands), the actions jolt at most 4–14° from
one thirtieth of a second to the next (the reference's own, up to 90°). On the way: roll bones keep
the half of their twist nearest the last frame's (past a half turn the shorter half flipped), the
ground's lifts use two-bone IK relative to the leg's length (a straight leg lifted a hair no longer
eases its knee in and out), and two-bone IK leans its bend forward by a hair, so a straight knee
keeps bending forward.

### Steering

`createWalker` eases its own speed toward the asked one (`accel` 2.5 m/s² up, `decel` 4 down), so
a character starts and stops rather than jumping between gaits; `walker.state` gives the speed,
lean and look it has reached. It leans into turns as a body must, by the angle whose tangent is
speed × turn rate over g (limited to 0.35 rad), pivoting on the ground under the hips
(`bankPose`), and its head and chest look into the turn (a third of a second ahead, up to 0.6 rad)
or `look` radians aside, shared out over the upper chest, neck and head (`lookPose`). Both change
the pose before the feet are planted, so planted feet stay where they are.

### Ground and clearance

A clip made on another body meets this one's ground and limbs differently, so the kit mends each
frame (an audit of all clips on both bodies, skinning the mesh, found standing clips 3–5 cm into
the floor, toes 7 cm in at push-off, a body lying 5–8 cm under and hands 3–4 cm in the thighs):

- `retargetClip` takes the feet, like the trunk, from the source's standing pose (aligned by rest
  direction, flat feet pointed down where the toe joints sit differently), and keeps the source's
  ground: of the feet, toes, knees, hands, hips, chest and head, the one nearest the ground in the
  source is put as near it in the target, scaled.
- `characterTracks` (and the walker each frame) then raises a body lying under the ground
  (`raiseBody`, on about 400 points of its skin and garments), bends toes up whose soles go under
  and lifts a foot still under by two-bone IK, the foot keeping its turn (`groundFeet`, on the
  lowest points of each foot and toe), and turns an arm out from the shoulder until its hand is
  clear of the thighs and pelvis (`clearArms`, capsules as thick as the skin at rest).

After it, every clip's lowest point stays within about 1 cm of the ground on both bodies (a body
lying down within 1.6 cm) and no hand goes more than 1 cm into the body.

With local reference data, the lab also offers the reference clips by role on the repository's
bodies, a twin beside the character playing the reference motion its own is made from ("Beside
the reference"), ("Reference: <name>", and a gait over them), from `/local/anim/roles/` (written by the local
tools, never in the repository).

The library rule changed with this (see [models](models.md#characters)): a character is any
humanoid rig by role in a declared T- or A-pose, no longer the Mixamo skeleton.

### Gait

**Locomotion is blended by speed** (`kit/character/gait.js`). `clipGait(skeleton, tracks)`
measures a clip's ground speed (the stance foot's mean backward speed while it is down, by
forward kinematics) and the phase where the left foot is furthest forward. `createGait(skeleton,
clips)` sorts the clips by speed (a clip under 0.3 m/s is the idle) and, per update, blends the
two either side of the wanted speed at one phase, each shifted to its left foot's contact so
the feet stay in step; the cycle's length blends with them. Below the slowest clip it plays
slower, down to 30 % of its pace, and the idle, on its own clock, fades in under half that
clip's speed. Measured on the male body: the reference's walk 1.52, run 4.37 and sprint
5.98 m/s; the CC0 walk 0.63 and jog 4.15.

**Planted feet** (`kit/character/feet.js`): `createFootLock(skeleton).apply(pose, { forward,
turn, dt })` locks a foot where the animation puts it down (its ankle within 2.5 cm of its rest
height), moves the lock back under the character by the step's travel and turn, and bends hip and
knee with a two-bone IK (`twoBoneIK`, keeping the chain's bend) so the ankle stays on it; the foot
keeps its animated world rotation, the thigh's roll bone turns with the thigh. A lock lets go once
the animation lifts the foot 4 cm or it would have to reach 15 cm, and locks blend over 0.06 s.
Without it the stance foot slides a few centimetres per step whenever the speed is not a clip's
own (3 cm walking 15 % fast); with it, under a centimetre, in the lab's Gait mode on a turning
circle from 1.5 to 4.4 m/s.

The lab's **Gait** pose runs the character (and the crowd, at slightly different speeds) round a
circle at the Speed slider's pace, on a grid, with the camera following and **Feet IK** to switch
the planting. M4 is complete apart from IK for uneven ground (targets from a height query).

## Lab

The workshop's character page (`site/workshop/character.html`, linked from the workshop) builds
one character, or a crowd of 24 from the following seeds, live: the seed and a data set at the top,
then folding sections for the look (body, eyes, faces and their feature sliders), clothes (a
garment and its colour per slot), motion (test poses, the CC0 clips, the reference set's own clips,
gait at a speed with planted feet) and the view (textured, clay, UV islands and checker, skin
weights by bone, LOD, wireframe, skeleton, crowd); the recipe is shown as JSON. It speaks Chinese
and English like the rest of the site. For checking motion frame by frame, the page's
`characterLab.pause(true)` stops its clock and `characterLab.step(dt, n)` moves everything on n
steps of dt seconds.

### In a game

`kit/character/three.js` turns a character into three.js objects (THREE is passed in, so the kit
does not bundle it):

- `characterObject(THREE, character, { colours, data })`: a SkinnedMesh with its bones, one
  MeshStandardMaterial per island named after it, coloured by island (or `colours`), garments by
  slot, hair double-sided.
- `characterTextures(character, data)` and `applyTextures(THREE, object, character, data, load)`:
  each island's textures from the data set (the skin of the dominant face, a garment's texture and
  the tint of its colour), put on the materials through the game's loader.
- `clipToThree(THREE, character, clip)`: an AnimationClip for a role clip (retargeted) or a clip
  by bone, for an AnimationMixer.
- `createWalker(THREE, object, character, clips)`: the gait over locomotion clips with planted
  feet; `update(dt, { speed, turn })` poses the bones and moves the object along its heading.

## Library

Today the library accepts a `character` only on the Mixamo skeleton (`server/model-rules.js`).
That changes in M4: a character needs a rig with role mappings covering the required humanoid
roles. In a GLB these are `VRMC_vrm` `humanoid.humanBones`; in `.fun3d` they are `rig.roles`.
Mixamo-named skeletons get their mapping inferred. The remaining rules: at most 128 joints,
`rig.rest` declared as `T` or `A` and checked against the arm angle, at most four influences.
Role retargeting in `kit/animation.js` must land first, so that every character in the library
plays the library's animation packs.

## Validation

- Golden tests: fixed seeds at each LOD hash to fixed arrays.
- Invariants for every generated mesh:
  - seam vertices shared, with no open edges except garment hems;
  - no non-manifold edges;
  - normals continuous across seams;
  - weights normalised, with at most four influences;
  - left and right mirror within 1e-6 for symmetric parameters.
- Smoke runs: 1 000 random seeds generate without errors and without garment layers
  intersecting the body at rest. Today: closed when undressed, finite and with no empty island
  when dressed.

## Milestones

| | Contents | Needs |
| --- | --- | --- |
| M0 | This specification | — |
| M1 | Static body: skeleton, segments, seam rings, normals, UVs, weights at LOD0–2; a slider and seed page; invariant tests; fitted base shapes | M0 |
| M2 | Toon ramp material, inverted-hull outline, ellipsoid face normals, face texture layer | M1 |
| M3 | The fitting tool (outside the repository), more base shapes (builds) and blending between them | M1 |
| M4 | Role retargeting with in-between distribution, the library rule change, procedural gait, two-bone IK, rest angle measured | M1 |
| M5 | Garment patterns (tight layers first), scalp and locks, spring bones with generated colliders | M1; spring bones with M4 |
| M6 | Facial bones and expressions, corrective morphs | M4 |
| M7 | Importing reference animation and garment patterns through the fitting tool | M3, M4 |
| Later | Middle-distance and crowd tiers: skinned instancing in the format, PCA shape bases, bone textures | all |

**MVP: M0–M2 plus a minimal M5.** It is a toon character in a T-shirt, trousers and one
hairstyle that changes live with the seed and the sliders. It is static. The MVP tests the
largest risk first: whether characters generated this way look good.
