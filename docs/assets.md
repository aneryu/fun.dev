# Assets and models

Status: decided on 2026-10-16 and implemented. Binary files are not in Git. This
covers two separate layers: how players receive game assets (a platform concern
that games do not see) and how this repository stores binary files (tooling for
whoever builds games here).

## Delivery: content-addressed blobs

The bundle contract is unchanged: a game is a directory of real files and calls
`asset("assets/x.glb")`. When a release is published (and in every local build),
each file under `assets/` is stored once by content, at
`games.fun.dev/blobs/<sha256>.<ext>`. The release's `files.json` maps each path to
its blob; the host reads it before `createGame` and resolves `asset()` through it.

- An unchanged file keeps its address across versions and games, so a new
  version uploads and downloads only what changed. Blobs are
  `public, max-age=31536000, immutable`.
- Code (`game.js`, other modules) stays under the versioned release path, because
  modules import each other by relative path. For the same reason, files under
  `assets/` must not import or reference each other relatively (use `.glb`, not
  `.gltf` with side files), and modules cannot import from `assets/` statically;
  load them with `import(asset(path))`. The publisher rejects both.
- The manifest `cover` is also kept under the release path, where the lobby and
  share previews link to it.
- Releases published before this change have no blob map; the host then resolves
  `asset()` to the release path as before.

### Shared vision runtime

MediaPipe Tasks Vision is a platform runtime, like Three.js: `kit/vision.js` serves
the pinned `@mediapipe/tasks-vision` library and wasm, and the platform's models
(`face_landmarker`, `hair_segmenter`, `selfie_segmenter`, from `sources/mediapipe/`),
at `/runtime/vision/<content hash>/`. Nothing downloads until a game calls it. Adding
a model means adding it to `sources/mediapipe/` and to `models` in
`site/runtime/kit/vision.js`, and deploying the website. The build disables the
library's usage reporting to Google (the player CSP would block it anyway) and
fails if a new MediaPipe version changes that code.

### Player devices

The service worker caches releases, blobs and the vision runtime in one cache of at
most 300 MB. When it is full, the least recently played game goes first; a blob
used by several games stays until none of them is cached. Installed apps
(standalone display) ask for persistent storage so the browser does not clear the
cache under storage pressure.

## Storage: locks in Git, files in a blob store

Two collections hold binary files. Their files are ignored by Git; a lock next to
them lists each file as `<sha256> <size> <path>`, one per line, sorted.

| Collection | Files | Lock | Contents |
| --- | --- | --- | --- |
| a game's runtime assets | `games/<id>/assets/` | `games/<id>/assets.lock` | what the game ships |
| the source library | `sources/` | `sources/sources.lock` | pipeline inputs shared by all games: textures, HDRIs, models, `.blend` projects (see [sources/README.md](../sources/README.md)) |

File contents live in a content-addressed cache shared by every checkout and
worktree on the machine, `~/.cache/fundev-blobs` (`FUNDEV_BLOBS` overrides it).
The coordinator backs that cache up to the private R2 bucket `fundev-sources`,
which has no public domain. Intermediate files (`dev/out/`) are not stored; they
are regenerated from sources and scripts.

```sh
npm run assets               # sync files and locks both ways (run after editing, merging or switching branches)
npm run assets -- --check    # change nothing; fail if files and locks differ (part of npm run verify)
```

`npm run assets` compares the files, the lock, and the state of its last run in this
checkout (`.assets-state.json`, ignored). A file you changed updates the lock; a
lock that changed (a merge or checkout) updates the file from the cache; a file you
deleted is removed from the lock. A file changed on both sides is a conflict:
resolve it with `--use-lock` or `--use-local`. `npm run dev` restores missing and
outdated files on start but never edits a lock. Commit the locks with the change
that needs them.

Branches only add to `sources/`: a listed file never changes; a new version gets a
new name. Its lock merges as a union (`.gitattributes`), so parallel branches that
add sources never conflict; a path listed twice after a merge is an error that
`npm run assets` reports.

### Coordinator

```sh
npm run assets -- --push     # back up every referenced blob this machine has not uploaded
npm run assets -- --pull     # fetch blobs missing from the local cache (fresh machine), then sync
```

`npm run release` backs up new blobs before anything else. Both commands use the
Wrangler login; `R2_SOURCES_BUCKET` overrides the bucket name. Game agents never
run them: on one machine the shared cache already hands files from a worktree to
the main checkout.

## Later

Deferred for future consideration, not rejected:

- Deleting blobs no release or lock references any more (public and private).
- A separate `cdn.fun.dev` domain.
- A machine-readable licence list per file, checked on release.
- An automatic compression pipeline (KTX2, Draco, WebP) and size budgets.
- A cache management view for players, and showing download sizes in the lobby.
