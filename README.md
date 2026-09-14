# PeraByte Studio

An AI image, video and story-generation studio — built from the PeraByte
requirements & design guide with **Next.js (App Router) + React + TypeScript +
Tailwind CSS v4** on Vercel.

## What is implemented

| Screen | Route | Notes |
| --- | --- | --- |
| Homepage | `/` | Hero preview cluster, mode cards, "Start creating" section |
| Generator — Solo Mode (Image) | `/generate/image` | Single-screen composer: prompt + settings badges, preview fills the viewport |
| Generator — Solo Mode (Video) | `/generate/video` | Same, plus a duration badge and an animated preview with transport controls |
| Generator — Story Mode | `/story` | 3-step flow, scene list, per-scene generation |
| Results — image & video preview | `/results?id=…` | Viewer, variations, metadata, actions |
| History | `/history` | Search, type filters, sort, favourites, per-row actions |
| UI elements & style guide | `/styleguide` | Colour, type, button, input, card and icon tokens |

## Generator layout

Both solo generators are a single screen that never scrolls:

- The prompt box at the bottom holds everything — the textarea plus
  **badge dropdowns** for aspect ratio, resolution, style and (video) duration.
  Selecting a badge opens a small menu above it; there is no separate settings
  panel, so there is nothing to scroll past.
- A sliders badge opens **Advanced** (variations, seed lock, negative prompt,
  prompt enhancement).
- The preview above it is `flex-1 min-h-0` and the media uses `object-contain`,
  so any aspect ratio scales to whatever space is left rather than forcing the
  page to grow. Result actions (download, save, copy, open, regenerate) float
  over the preview instead of occupying a toolbar row.
- `main` is a flex column and the generator root is `flex-1 min-h-0`, so the
  height comes from layout rather than a `calc()` — no rounding gap, no scroll.
  The footer is suppressed on `/generate/*` via `ConditionalFooter`.
- Verified at 1440×900, 1280×800 and 390×844: page overflow is 0px on every
  combination, before and after generating (`scripts/verify-generator.mjs`).

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
