#!/bin/sh
# Rebuilds Slap's runtime assets from CC0 MakeHuman data. See ../README.md ("Assets").
# Needs Blender 5.2 with the MPFB 2 extension, the MakeHuman system asset pack linked
# into MPFB's user data directory, Python 3 with Pillow, and this repository's Playwright.
set -e
cd "$(dirname "$0")"
blender -b --addons bl_ext.user_default.mpfb -P blender/build.py > out/blender.log 2>&1 || { tail -30 out/blender.log; exit 1; }
grep -E "PHYS_VERTS|HAND_VERTS" out/blender.log
node register.mjs
node pack.mjs
python3 images.py
