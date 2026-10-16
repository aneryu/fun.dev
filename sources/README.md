# Source library

Inputs of the asset pipelines (textures, HDRIs, models, `.blend` projects), shared by every
game and the platform. Files here are not in Git: `sources.lock` lists each one by SHA-256,
and `npm run assets` keeps this directory and the lock in step (see
[docs/assets.md](../docs/assets.md)). The library is backed up to the private R2 bucket
`fundev-sources`; nothing here is published.

Only add files: a file, once listed, never changes. To replace one, add the new version
under a new name. Directories are named by origin, so the licence of a file is clear
from its path:

| Directory | Origin | Licence |
| --- | --- | --- |
| `ambientcg/` | [ambientCG](https://ambientcg.com) materials, extracted | CC0 |
| `polyhaven/` | [Poly Haven](https://polyhaven.com) HDRIs | CC0 |
| `quaternius/` | [Quaternius](https://quaternius.com) Universal Animation Library | CC0 |
| `blenderkit/` | Free [BlenderKit](https://www.blenderkit.com) models (`games/muyu/dev/fetch-blenderkit.py`) | CC0 |
| `makehuman/` | [MakeHuman](https://static.makehumancommunity.org) system assets | CC0 |
| `mediapipe/` | Google MediaPipe models served by `kit/vision.js` | Apache-2.0 |
| `self/<game>/` | Made for fun.dev (including AI-generated sources) | ours |
