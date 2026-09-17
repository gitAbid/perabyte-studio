# PeraByte Studio — Go-To-Market Plan (updated Sep 2026)

## Positioning

**"The AI studio where characters stay consistent — across images, story scenes, and video."**

Not another AI generator. The moat is the **character consistency pipeline**
(reference images → multi-angle character sheets → LoRA adapters → scene-chained
story rendering), which none of the free tools offer and the vertical story apps
implement poorly.

## What's already built (asset inventory)

| Capability | Status | Notes |
| --- | --- | --- |
| Image generator (solo composer) | ✅ Shipped | badge-dropdown UX, no-scroll layout, variations, seed |
| Video generator | ✅ Shipped | duration badges, transport controls |
| Story mode | ✅ Shipped+ | scene list, **scene chaining** (SceneChainBadge), **scene reference chips**, reorder, addressable story editor |
| **Story → video conversion** | ✅ Shipped | ConvertDialog — image story converts to video |
| **Character Studio** (`/character`) | ✅ Shipped | reference images, character sheets, multi-character **casts**, LoRA adapters (Sogni), uncensored gate integration |
| **Multi-provider generation** | ✅ Shipped | Pollinations (free/keyless) + Sogni (LoRA) + apikey-fan behind a provider registry; model pill/picker in UI; detached renders |
| Server-side records (Phase A) | ✅ Shipped | `.studio/assets.json` + stories.json, `/api/assets` CRUD, `/api/stories`, legacy import |
| Settings surface | ✅ Shipped | provider keys, render timeouts, task models, content preferences (18+ gate w/ confirm) |
| Verification harness | ✅ Shipped | 45 test files / 429 tests, 6 Playwright verify scripts |
| Auth / accounts | ❌ Missing | blocks payments + cloud sync |
| Book compiler (PDF export, cover, typography) | ❌ Missing | the single highest-leverage gap |
| Payments | ❌ Missing | Stripe (needs US LLC) or Paddle (no LLC needed) |

## Competitive landscape (Sep 2026)

- **Giants** (ChatGPT/GPT-Image, Gemini/Nano Banana, Midjourney): win on model
  quality. Do not compete here.
- **Leonardo.Ai** ($12/mo, 29M users): broad studio; consistency weaker, no story chaining.
- **Ideogram**: text-in-images niche.
- **Vertical story apps** (Childbook.ai, MyStoryBot, ReadKidz, ToonyStory — $10–30/mo):
  closest competitors. None have LoRA-grade character control or story→video.
  **PeraByte's character pipeline is already stronger than this tier.**
- **NovelAI / Sudowrite**: text-only story tools; no visuals.

## GTM phases

### Phase 0 — NOW: free wedge with the built product (weeks 1–4)
- The product is already impressive: ship `/character` + `/story` as the public
  free experience (no login). Demo content + Pollinations = zero marginal cost.
- **Programmatic SEO**: landing pages per niche — "consistent character AI
  children's book", "anime character sheet generator", "storybook with your kid
  as the hero". Each page = a pre-filled composer (the app supports prefill via
  demo content module).
- Launch posts: r/SideProject, r/aivideo, X build-in-public thread with
  Character Studio screen captures.

### Phase 1 — proof + capture (weeks 4–10)
- **Book compiler**: scenes → paginated PDF with cover + typography. This turns
  "cool demo" into "thing parents/KDP authors pay for". Highest priority build.
- **Auth + generation ledger** (Phase B of server records): email magic link,
  per-user quotas. Free tier: 3 books/mo, watermarked video.
- TikTok/Reels/Shorts: auto-generate "made my kid a book in 60 seconds" demos
  using PeraByte itself. 2026 discovery = short-form social search (TikTok
  search volume +150% YoY).

### Phase 2 — monetize (month 3+)
- Payments. Paddle (merchant-of-record, pays out worldwide incl. BD, 5%+$0.50)
  to start; Stripe via US LLC later (2.9%+$0.30, unlocks subscriptions).
- Ladder (Leonardo-style tokens):
  - Free: 3 books/mo, watermarked, public gallery
  - **$9/mo Creator**: unlimited books, PDF export, no watermark, private
  - **$19/mo Pro**: story→video, commercial license, priority renders (Sogni)
- KDP self-publishers = power segment (buy tools that make them money).
- Sell finished example books as printables (ties into the Etsy/storefront
  business — same pipeline, second revenue stream).

### Phase 3 — moat widening (month 4+)
- Character marketplace: share/import character specs (the JSON spec already
  exists server-side) — network effects.
- Print fulfillment hook (Lulu API) for hardcovers.
- Public API for the character-consistency pipeline.

## Metrics

- North star: **completed books** (not generations).
- Free→paid conversion target: 2–4%.
- D7 retention of story creators before any paid spend.
- Cost per free user: ~$0.003/image on Pollinations — keep free tier generous.

## Risks

1. **Pollinations dependency** — rate limits + mid quality. Mitigated: provider
   registry already supports paid backends (Sogni, apikey-fan).
2. **Platform AI-policy shifts** — disclose AI generation; avoid brand/artist prompts.
3. **Payout friction from BD** — Paddle works day one; Stripe needs the LLC.
4. **The 90-day wall** — validate with manual/organic GTM before automating spend.
