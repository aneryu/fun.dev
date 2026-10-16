# Slap (扇耳光)

Swipe across a face to slap it. The point is the venting, so the face has to
take it: jelly flesh that goes duang-duang, a head that snaps away on a neck
spring, handprints, swelling and a face that gets sorrier. Players can swap in
a photo of anyone they like; it never leaves their device.

Design decided on 2026-10-15. Items under [Later](#later) are deferred, not
rejected.

## Experience

- **Default face first.** The game opens on a realistic, smug middle-aged man
  (MakeHuman, CC0) who is slappable immediately. “📷 换成 TA 的脸” swaps in a
  photo; it is a second step, not a gate.
- **Input.** A fast stroke that crosses the face is a slap; direction and speed
  become the impulse (`strength = (speed − 250 px/s) / 2500`, 0.12–1). Turning
  around inside the face slaps again, so back-and-forth strokes are 左右开弓.
  A tap on the face is a poke. Keyboard: ←/→ slap, F swaps the face.
- **The hand.** A realistic right hand, mirrored for the left, swings in from
  the side the stroke started (70 ms), meets the cheek with its palm on the
  cheek's normal, holds a hit-stop (≤45 ms) and follows through towards the
  camera so it never passes through the head.
- **Duang.** See [Physics](#physics). Default is exaggerated jelly on a
  realistic face; the “Q 弹程度” setting scales it (0.5–2).
- **Escalation.** Damage rises 0.03–0.075 per slap. Handprints are painted at
  the hit (UV space), the cheek swells, shock and wince flash on each hit and
  sadness grows from 45% damage; dazed stars and birds from 70%, tears from
  82%. At 100% the climax: the head turns a full circle, “满级！”. After 2.5 s
  without slaps everything heals at 5%/s. No blood, no gore.
- **Counting.** A combo (gap < 0.9 s) shows ×N with phrases at 5/10/20/35/50;
  today/total counts are saved through `context.progress` and power the share
  text. There are no goals, levels or unlocks.
- **Video.** The manifest sets `recording`: the player's menu records a 9:16
  clip with the slap sounds and a fun.dev watermark for Douyin and friends. The
  frame centres the face (`recordingFocus`); the T-shirt and the yellow simply
  continue where the frame reaches past the screen. With a photo in use, the
  photo's face crop sits in a small frame at the top left (`recordingBadge`). The
  clip stays on the device until the player shares or saves it.
- **Sound.** Synthesized per slap (crack, body thump, room tail) in four tiers,
  with a soft rubbery “duang” on hard hits; no recorded files and no human voice.
- **Look.** fun.dev's Duck palette (DESIGN.md): a Duck Yellow ground, ink text,
  Beak Deep accents, ink buttons with cream text. Today/total counts sit top right
  on the yellow (the bottom is the dark T-shirt); dazed stars are Beak Deep glyphs
  because yellow emoji stars vanish on the ground.
- **Accessibility.** Canvas label with counts; `announce` for combo phrases,
  the climax and face changes; haptics per hit; reduced motion turns off the
  hit-stop, camera shake and climax spin, and softens the jelly.

## Photos

- Picked with `context.pickImage()` (the host owns the file input; the game stays
  canvas-only). MediaPipe Face Landmarker runs on the device and is loaded only
  on the first swap (~17 MB: WASM 13.5 MB, model 3.7 MB, JS 0.5 MB).
- The largest face wins. If none is found, the player drags five points (eyes,
  nose tip, mouth corners) on the photo; an affine fit of the reference face's
  landmarks to those points stands in for detection.
- A 512² crop around the face and its landmarks are kept in
  `context.deviceStorage` (this device only: never in progress, transfer or
  export). Settings: “用 TA 的脸” toggles it, “删除照片” deletes it.
- Sharing is text only (“我今天在 fun.dev 扇了 TA N 下”); the game never makes an
  image with someone's face.

### Mapping

The head keeps MakeHuman's topology; the photo is a second texture. Offline,
the default face is rendered frontally and MediaPipe finds its 468 landmarks;
a synthetic ring outside the face outline (pushed out 10%, up to 40% towards the
hair, barely down to the neck) extends them. Every head and eye vertex on the
front of the face is located in a Delaunay triangle of those points (triangle +
barycentric weights). At runtime a photo's landmarks, extended the same way,
reuse the weights, so each vertex gets a photo UV. The photo fades out over 10%
of the face width at the ring; ears always keep the default skin.

In photo mode the smug rest pose is undone (a `neutral` morph), the photo's
broad lighting is evened out on a 6×6 grid inside the face outline, and the rest
of the head is tinted by the ratio of the photo's skin tone to the default
face's, both sampled just inside the outline from cheek to cheek. Brows and
lashes are hidden (the photo has its own).

`shape.js` can also reshape the head to the photo: MediaPipe's 3D landmarks are
aligned to the default face (Horn), symmetrised, and the residual moves nearby
vertices. Selfies are perspective-distorted (a near chin looks long), so the
default strength is 0.3; `?debug=1` exposes it as “照片脸型”.
`dev/likeness.mjs` compares landmarks of a photo and a screenshot, but in the
front view the texture decides where features land, so judge likeness by eye.

## Physics

`softbody.js` integrates a damped wave equation on the 4,921-vertex head in the
head's own frame, in 1/360 s substeps:

- anchor spring `−k_a(i)·u`, stiff on bone (skull, nose, around the eyes) and
  soft on cheeks, jowls, lips and ears;
- Laplacian coupling `k_e·Σ(u_j − u_i)` so a hit travels as a wave;
- damping, and the head's rigid acceleration as a pseudo-force so the flesh lags
  when the head snaps (the main source of “duang”);
- displacement capped at 2 cm × jelly.

The head is a rigid body on a neck spring (mostly yaw; roll and pitch damped),
blended into the neck and shoulders on the GPU. Lighting is baked, so the
shader only adds the change between the deformed and rest normals, which makes
the flesh catch light as it wobbles. Debug options (`?debug=1`) expose stiffness,
coupling, damping, impulse, slow motion, a max-damage cheat and debug views.

## Assets

All characters come from the MakeHuman system asset pack (CC0) through MPFB 2
in Blender. `dev/build-assets.sh` rebuilds everything:

1. `dev/blender/build.py`: the character (phenotype, CC0 targets), expression
   units baked into a smug rest pose plus shock/sad/wince morphs, a flat
   slapping hand (finger rig pose), a buzz cut and T-shirt painted as masks,
   the head/neck/shoulders cut, a packed bake UV, Cycles lighting baked into the
   head texture, the hand's albedo, and a frontal render with per-vertex
   visibility.
2. `dev/register.mjs`: MediaPipe landmarks and skin tone of the frontal render,
   in headless Chromium with the game's own `face.js`.
3. `dev/pack.mjs`: triangulation, photo registration, mouth cavity, and the
   runtime `assets/head.*`, `assets/hand.*`.
4. `dev/images.py`: textures (head 2048², hand 512², eyes, brows, lashes).

Setup: Blender 5.2 with the MPFB 2 extension (`extensions.blender.org`), the
pack from `files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip`
linked into MPFB's user data (`~/.config/blender/5.2/extensions/.user/user_default/mpfb/data/{skins,eyes,eyebrows,eyelashes,hair,…}`),
Python 3 with Pillow, and this repository's Playwright.

First load is about 0.9 MB (head 515 KB + 215 KB texture, hand 80 KB, small
textures); MediaPipe loads only for photos, and lives under `assets/lazy/` so the
service worker doesn't precache it with the release. Its files in `assets/lazy/mediapipe/` are
`@mediapipe/tasks-vision` 1.1.1 and `face_landmarker.task` (float16), both
Apache-2.0 (`assets/lazy/mediapipe/LICENSE.txt`); the model is renamed `.bin` for the
publisher's file types.

`dev/fixtures/` holds CC0 renders of other MakeHuman characters
(`dev/blender/test-photo.py`) and a drawn smiley for testing photos; no real
person's photo is used anywhere.

## Development

```sh
PORT=8031 npm run dev -- slap                          # play at /games/slap?debug=1
node --test games/slap/dev/slap.test.mjs               # unit tests (also in npm test)
node games/slap/dev/playtest.mjs [base] [out] slap      # also combo, climax, photo, noface
SLOWMO=0.15 VIEW=cavity node games/slap/dev/playtest.mjs
node games/slap/dev/inspect-photo.mjs [photo]           # what the photo path stores
node games/slap/dev/cover.mjs /tmp/cover.jpg            # then copy to assets/cover.jpg
```

## Later

- Weapons (slipper first, then salted fish, frying pan…), unlocked by total
  slaps, each with its own impulse, sound and print.
- Hair with physics; teeth and tongue for the open mouth.
- Shaking the phone to slap (device motion).
- A small gallery of remembered faces.
