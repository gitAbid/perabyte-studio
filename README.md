# PeraByte Studio

An AI image, video and story-generation studio — built from the PeraByte
requirements & design guide with **Next.js (App Router) + React + TypeScript +
Tailwind CSS v4** on Vercel.

## What is implemented

| Screen | Route | Notes |
| --- | --- | --- |
| Homepage | `/` | Product overview with direct entry points for generation, writing, scene work and reusable assets |
| Image studio | `/generate/image` | Prompt composer, model and render controls, reference frames, variations and preview |
| Video studio | `/generate/video` | Video prompt and duration controls, reference frames, and video or keyframe preview |
| Story writer | `/writer` | Draft from a premise, refine text, preview scene splits, then open Solo or Scene Studio |
| Scene studio | `/story` | Build a scene sequence, keep continuity with frame references, queue renders and convert to video preview |
| Results | `/results?id=…` | Full media viewer, variations, metadata, download and reuse actions |
| Images & video library | `/images` | Search, filter, favourite, tag, organize and reopen generated media |
| Stories library | `/stories` | Find, reopen and manage saved story sequences |
| Character library & studio | `/character`, `/character/new`, `/character/[id]/edit` | Create reusable characters, edit their reference sheets and attach them to renders |
| Locations | `/locations` | Save reference plates and world details for consistent scene settings |
| Settings | `/settings` | Configure providers, models, writer and enhancement defaults, and advanced options |
| UI style guide | `/styleguide` | Colour, type, button, input, card and icon tokens |

## Generator layout

Both solo generators are single-screen workspaces:

- The prompt box holds everything — the textarea (on a tinted surface, with an
  **Enhance prompt** action that expands the text with style-aware detail),
  **badge dropdowns** for aspect ratio, resolution, style, (video) duration and
  variation count, and a sliders badge for **More options** (seed lock,
  negative prompt). Selecting a badge opens a small menu above it; there is no
  separate settings panel. A centered Solo ⇄ Story switch sits in the header of
  both workspaces. The preview canvas is ratio-locked and top-left aligned,
  with a strip below it showing the render's variations, or the most recent
  generations from History (examples on a fresh browser).
- On desktop the composer and preview panels stretch to fill the viewport
  under the header (`main` is a flex column and the generator root is
  `flex-1 min-h-0`, so the height comes from layout rather than a `calc()`).
  The media uses contain-fit sizing (container-query units for the ratio
  boxes, `object-contain` for renders), so any aspect ratio — including the
  video default 9:16 — scales to the space available instead of overflowing.
- On small screens the panels stack (composer above preview) and the page
  scrolls naturally; the viewport-fit is only enforced from `lg` up.
- Result actions (download, save, copy, open, regenerate) float over the
  preview instead of occupying a toolbar row.
- The footer is suppressed on the workspace routes (`/generate/*` and
  `/story`) via `ConditionalFooter`.
- The landing page fits the viewport on desktop heights (≥ ~830px) and scrolls
  on shorter screens; verified at 1440×900 and 1280×800 together with the
  generators (`scripts/verify-generator.mjs`).

## Architecture

- `app/` — App Router routes. Pages are server components; interactive screens
  use focused client components.
- `app/api/generate/route.ts` — validates the request (prompt length, aspect,
  resolution, style preset, variation count), then **warms the primary render**
  before answering. The provider takes ~40s to render a URL for the first time
  and then serves it from cache in under a second, so warming means the browser
  paints the finished image immediately instead of showing another 40s of
  skeleton. Extra variations are warmed after the response with `after()`.
- `app/api/media/route.ts` — serves every render through our own origin and
  retries on the provider's rate limits (HTTP 429) with backoff. This is
  required twice over: Chrome's opaque response blocking rejects the provider's
  non-image 429 bodies for a cross-origin `<img>`, and the `download` attribute
  is ignored cross-origin. The route only proxies an allow-listed host, which
  blocks SSRF.
- `lib/constants.ts` — aspect, resolution, style, duration presets.
- `lib/renderer.ts` — prompt/dimension building, the host allow-list, and
  `displaySrc()` which routes remote renders through `/api/media`.
- `lib/generation.ts` — client API wrapper, job lifecycle hook, download helper.
- `lib/store.ts` — localStorage-backed asset history (URLs + metadata only, no
  blob storage) exposed through `useSyncExternalStore`.
- `components/` — design-system primitives and screen composition.
- `app/globals.css` — Tailwind v4 `@theme` tokens mirroring `DESIGN.md`.

## Scripts

```bash
npm run dev                # dev server
npm run build              # production build + type check
npm run typecheck          # tsc --noEmit
npm run prerender:examples # re-render the fixed /public/demo examples
npm run verify             # screenshot + end-to-end check (needs a running server)
npm run verify:generator   # viewport-fit + badge menu + live render check
```

`scripts/verify.mjs` drives a real browser over every screen, records console
errors and broken images, then performs a live generation and asserts the
result lands in History. `scripts/prerender_examples.py` pre-renders the six
fixed example assets so the landing page and seeded History paint instantly —
run it again if you change the example prompts.

## Honest limitations of this build

- **Renders are real; the provider is keyless.** Images come from a free
  text-to-image endpoint, so a production deployment should swap
  `lib/renderer.ts` for a paid provider with an API key held server-side.
- **The free provider is slow and rate-limits hard.** First render ≈ 40s, and
  parallel requests get HTTP 429, which is why variations are warmed one at a
  time and the API answers only after the primary render exists.
- **Video is a preview, not an exported file.** The provider returns stills, so
  video results are presented as animated keyframes with working transport
  controls and labelled *Preview render* in the UI. MP4 encoding is a follow-up
  (FFmpeg worker or a video-capable provider).
- **History is per-browser.** Persistence is localStorage, so nothing syncs
  across devices and clearing site data clears history. Swap `lib/store.ts` for
  the database layer when accounts land.
- **No authentication yet.** Accounts, billing and usage metering are the
  post-MVP items listed in the requirements guide.

## Local development

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build + type check
npm run typecheck  # tsc --noEmit
```

## Deploy to Vercel

The repository is deploy-ready: no environment variables are required for this
build.

```bash
npm i -g vercel
vercel link            # or: vercel --yes
vercel --prod
```

Or from the dashboard: **Add New → Project → import the Git repo** and accept
the detected Next.js settings (no build overrides needed).

When you add a paid render provider, set its key as a Vercel environment
variable and read it only inside `app/api/*` route handlers.
