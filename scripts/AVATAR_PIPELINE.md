# Avatar preview asset pipeline

The 3D character preview (`public/character/preview/avatar.glb`) is generated
from the open-source MakeHuman/MPFB2 parametric human. All generated assets are
CC0 (MakeHuman asset license; see LICENSE notes in the makehumancommunity repos).

## What the GLB contains

- `Body` — rigged skinned mesh (21.8k verts) with **37 morph targets**
  (shape keys) driving gender/age/height/weight/muscle, face shapes, eye
  shapes, expressions and body accents.
- `Body.rig` — game_engine skeleton (53 bones incl. fingers).
- `Eyes`, `Eyebrows`, `Eyelashes`, `Teeth`, `Tongue` — fitted face assets.
- `Hair__*` — 10 hair meshes (long01, bob01/02, braid01, ponytail01,
  short01–04, afro01), toggled by visibility.
- `Clothes__*` — 9 garment meshes (casual/elegant/sports/work suits, shoes,
  fedora), toggled by visibility and tinted at runtime.
- `avatar-meta.json` — object/shape-key/bone name dump consumed when writing
  the web-side mapping (`lib/avatarParams.ts`).

Eye iris textures (`public/character/preview/eyes/*.png`) are the MakeHuman
eye materials, swapped at runtime per eye colour selection.

## Regenerating

One-time setup (done 2026-09-14 on this machine):

1. `brew install --cask blender` (5.2 LTS used).
2. Install the MPFB extension into Blender:
   `blender -b --command extension install-file -r user_default mpfb-2.0.8.zip`
   (release zip from github.com/makehumancommunity/mpfb2).
3. Assemble an assets root (dirs: `hair/ clothes/ skins/ eyebrows/
   eyelashes/ teeth/ tongue/ eyes/`) from:
   - github.com/dmaugis/makehuman-py3-assets (`base/*`) — hair, clothes, skins…
   - github.com/makehumancommunity/makehuman (`makehuman/data/eyes`) — eye meshes.
4. Point `ASSETS` in the script at that root, then:

```bash
"/Applications/Blender.app/Contents/MacOS/Blender" -b \
  -P scripts/generate_avatar_assets.py -- public/character/preview
```

The script bakes macro-detail variants (gender/age/height/weight/muscle) into
shape keys via join-as-shapes, loads fine-grained modeling targets as further
shape keys, fits all hair/garment/face assets, rigs to the game_engine
skeleton and exports one GLB. Sizes ~5.4 MB.
