Live 3D character preview — natural-looking, morph-driven (v2, "as natural as possible")

## Core change from v1
Drop the primitives/mannequin approach entirely. Use a **real parametric human mesh with full morph targets** — the same technique game character creators use — so the preview looks like a natural CG human, not a stylized figure.

## Realism strategy (three layers)
1. **A real human mesh, not built-from-code shapes.** Generate a rigged, anatomically-proportioned human via the open-source **MakeHuman/MPFB2 pipeline (CC0 licensed assets)** run headless in Blender, exported as GLB with all shape keys preserved. This base ships with morph targets that map almost 1:1 to our wizard fields.
2. **Character-creator rig driving.** In three.js we drive `morphTargetInfluences` + bone scaling live — this is exactly how AAA character creators work, and it produces continuous, natural body variation.
3. **Cinematic presentation.** PBR skin (subsurface tint + sheen), soft key/fill/rim lighting, HDRI environment (drei `Environment` studio preset), ACES filmic tone mapping, soft contact shadows, and **idle micro-motion** (subtle breathing, weight shift, occasional blink via morphs) so the figure feels alive. Parameter changes lerp smoothly (spring transitions), never pop.

## Asset pipeline (one-time, scripted, reproducible)
New `scripts/generate_avatar_assets.py` + docs. Steps:
- Install Blender headless + MPFB2 (git clone) locally; run script to build and export to `/public/character/preview/`:
  - `body.glb` — rigged skinned body with morph targets: gender, age, height, weight, muscle/build, breast, hip, shoulder proportions, face-shape targets (jaw/chin/cheek roundness), expression targets (smile, frown, brow raise…)
  - `hair-*.glb` × 9 styles (long straight/wavy, curly, bob, pixie, ponytail, braided, updo, buzz)
  - `garment-*.glb` × ~12 base shapes recolored/mapped to all 37 outfit options (tee+joggers, suit, armor, saree drape, kameez, lehenga, lingerie bands, etc.)
  - `accessory-*.glb` (glasses, hat, bangles, bindi, collar…)
- Assets are CC0 → safe to commit. Budget ≤ ~10 MB total; loaded lazily after the wizard mounts with a loading shimmer.
- **Fallback ladder if the Blender pipeline fails in this environment:** (A) MB-Lab (Blender) same approach; (B) best available CC0 rigged human base with bone-scale proportions only; (C) organic smooth figure. Each tier still keeps PBR presentation + idle motion, so naturalness degrades gracefully, never to "boxes".

## Spec → 3D mapping (`lib/avatarParams.ts`, pure)
| Field | Drive |
|---|---|
| skinTone | exact `SKIN_TONES` hex → skin material color |
| hairColor / eyeColor | hex tables |
| hairStyle (9) | swap hair GLB |
| gender, age, height, weight, build, bodyType | **native morph targets** (female/male, age, height, weight, muscle, hip/shoulder/breast) — near-perfect 1:1, this is what makes it natural |
| faceShape (6), eyeShape (5), expression (7–9) | face morph targets (jaw/chin/cheek; lid targets; smile/frown/brow combos) |
| outfit (37) | garment mesh + color + coverage (nude/lingerie = reduced coverage on smooth non-explicit body) |
| accessories | accessory meshes |
| pose (per mode) | bone-rotation presets on the shared rig |
| tattoos/piercings/facialHair | decal patches / stud meshes / facial-hair mesh |
| look preset (6) | lighting rig presets (Golden Hour warm rim, Studio softbox, Moody low-key…) |
| nsfwLevel/nudity/sexualContent | garment coverage; **body stays smooth/non-explicit always** — badge "Silhouette body in preview" when relevant |
| style (5) | material treatment (Anime → toon, 3D Render → clay-matte, else PBR) |
| non-visual fields (prompt, personality, scene notes, violence, aspect, resolution) | "Also applied" chips under the canvas |

Ethnicity morphs exist in the pipeline but are deliberately **not** wired to skin tone — tone is purely material color.

## UI integration (unchanged from v1)
- Wizard shell widens to `max-w-[1280px]` with sticky preview column visible across **all 4 steps**; OrbitControls (rotate/zoom); mobile gets a header "Preview" button → bottom sheet.
- Step 4's old image-preview aside removed (superseded); Step 2's inspiration grid stays.
- Canvas via `next/dynamic` + `ssr:false`; WebGL-failure fallback placeholder; frameloop runs while visible (idle motion), pauses when hidden.

## New/modified files
- `scripts/generate_avatar_assets.py` (+ pipeline doc), CC0 GLBs in `public/character/preview/`
- `lib/avatarParams.ts` (pure mapping, testable)
- `components/character/preview/AvatarPreview.tsx` (card shell, chips, mobile sheet)
- `components/character/preview/AvatarScene.tsx` (Canvas, lights/look presets, controls)
- `components/character/preview/AvatarFigure.tsx` (GLB loading, morph driving, garment/hair swap, idle motion)
- Modified: `CharacterStudio.tsx`, `CharacterSteps.tsx`, `package.json` (three, @react-three/fiber@9, @react-three/drei@10, @types/three)

## Honest expectation
"Natural" here = modern game character-creator realism (a living CG human with real proportions, expressions, lighting) — the most natural achievable fully in-browser with clean licensing. The photoreal output remains the AI generation itself; the preview's job is to show every configuration faithfully before you spend a generation.

## Verification
- `npm run typecheck`, `npm run build`
- Browser walkthrough: change skin tone / hair / body / outfit / pose / NSFW level / look → preview updates smoothly; rotate/zoom; mobile sheet; fallback ladder only if pipeline blocks
- Asset check: bundle budget, lazy-load behind wizard mount