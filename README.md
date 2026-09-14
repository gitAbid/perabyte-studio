# PeraByte Studio

An AI image, video and story-generation studio — built from the PeraByte
requirements & design guide with **Next.js (App Router) + React + TypeScript +
Tailwind CSS v4** on Vercel.

## What is implemented

| Screen | Route | Notes |
| --- | --- | --- |
| Homepage | `/` | Hero preview cluster, mode cards, "Start creating" section |
| Generator — Solo Mode (Image) | `/generate/image` | Settings, prompt composer, live preview, variations |
| Generator — Solo Mode (Video) | `/generate/video` | Adds duration, animated preview with transport controls |
| Generator — Story Mode | `/story` | 3-step flow, scene list, per-scene generation |
| Results — image & video preview | `/results?id=…` | Viewer, variations, metadata, actions |
| History | `/history` | Search, type filters, sort, favourites, per-row actions |
| UI elements & style guide | `/styleguide` | Colour, type, button, input, card and icon tokens |

## Architecture

- `app/` — App Router routes. Pages are server components; interactive screens
  use focused client components.
- `app/api/generate/route.ts` — validates the request (prompt length, aspect,
  resolution, style preset, variation count) and returns signed-off media URLs.
- `app/api/media/route.ts` — streams a render through our own origin so
  downloads work and the render provider is never linked directly. It allows
  only the configured provider host, which blocks SSRF.
- `lib/constants.ts` — aspect, resolution, style, duration presets.
- `lib/renderer.ts` — pure prompt/dimension building plus the host allow-list.
- `lib/generation.ts` — client API wrapper, job lifecycle hook, download helper.
- `lib/store.ts` — localStorage-backed asset history (URLs + metadata only, no
  blob storage) exposed through `useSyncExternalStore`.
- `components/` — design-system primitives and screen composition.
- `app/globals.css` — Tailwind v4 `@theme` tokens mirroring `DESIGN.md`.

## Honest limitations of this build

- **Renders are real; the provider is keyless.** Images come from a free
  text-to-image endpoint, so a production deployment should swap
  `lib/renderer.ts` for a paid provider with an API key held server-side.
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
