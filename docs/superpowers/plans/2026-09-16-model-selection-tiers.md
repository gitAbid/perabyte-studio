# Model Selection: Curated Tiers + Structured Metadata — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the model pickers around curated "Recommended" entries with honest use-case descriptions, a collapsed provider-grouped tail, and capability badges — plus fix non-drivable models leaking into the picker.

**Architecture:** Three optional metadata fields (`tier`, `useCase`, `costTier`) flow from provider catalogs through `/api/models` to the client, where a pure helper splits the catalog into a recommended section and a provider-grouped tail rendered by `PillSelect`. Sogni's curated claims live in one new table (`model-meta.ts`) that also produces the cold-start catalog; unknown live models get no claims. Spec: `docs/superpowers/specs/2026-09-16-model-selection-design.md`.

**Tech Stack:** Next.js 15 (App Router), TypeScript, Tailwind, vitest. All commands run inside the worktree `.worktrees/feature/model-selection` (branch `feature/model-selection`).

**Conventions:**
- Run tests: `npx vitest run <path>` (add `-- --watch` never; CI-style runs only).
- Typecheck: `npx tsc --noEmit`.
- Dev server for manual checks: `npx next dev -p 3100` — **never port 3000** (another app owns it).
- Commit style: `feat|fix|test|refactor(scope): message` (matches repo history).

---

### Task 1: Metadata fields on descriptors + API passthrough

Type-only groundwork so later tasks can compile.

**Files:**
- Modify: `lib/domain/models.ts` (ModelDescriptor, after `uncensored?`, ~line 51)
- Modify: `lib/model-catalog.ts` (ModelOption, after `uncensored?`, ~line 26)
- Modify: `app/api/models/route.ts` (models mapping, ~line 41-57)

- [ ] **Step 1: Add fields to `ModelDescriptor`** in `lib/domain/models.ts`, inside the interface after the `uncensored?` block:

```ts
  /** Curated placement. Set only on hand-picked models; absent = picker tail. */
  tier?: "recommended";
  /** One-line "what it's good for" — the picker entry's second row. */
  useCase?: string;
  /** Rough cost signal for a compact badge. */
  costTier?: "free" | "credits" | "key-credits";
```

- [ ] **Step 2: Mirror onto client `ModelOption`** in `lib/model-catalog.ts` after `uncensored?: boolean;`:

```ts
  /** Curated placement — pinned to the picker's Recommended section. */
  tier?: "recommended";
  /** One-line "what it's good for" — the picker entry's second row. */
  useCase?: string;
  /** Rough cost signal for a compact badge. */
  costTier?: "free" | "credits" | "key-credits";
```

- [ ] **Step 3: Pass through the API** in `app/api/models/route.ts`, adding to the `catalog.models.map` object after `uncensored: model.uncensored,`:

```ts
    tier: model.tier,
    useCase: model.useCase,
    costTier: model.costTier,
```

- [ ] **Step 4: Typecheck** — `npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/models.ts lib/model-catalog.ts app/api/models/route.ts
git commit -m "feat(models): tier/useCase/costTier metadata on descriptors + API passthrough"
```

---

### Task 2: Sogni curated meta table (`model-meta.ts`) — TDD

Single source of truth for Sogni picker claims. It owns the curated descriptors (moved from `request-maps.ts`, which re-exports them so existing imports keep working) and the `sogniModelMeta` resolver used by the dynamic catalog.

**Files:**
- Create: `lib/providers/sogni/model-meta.test.ts`
- Create: `lib/providers/sogni/model-meta.ts`
- Modify: `lib/providers/sogni/request-maps.ts` (delete the two descriptor arrays, re-export from model-meta)

- [ ] **Step 1: Write the failing test** — `lib/providers/sogni/model-meta.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  SOGNI_IMAGE_MODELS,
  SOGNI_VIDEO_MODELS,
  sogniModelMeta,
} from "@/lib/providers/sogni/model-meta";

describe("sogni model meta", () => {
  it("curates a small recommended set: 4 image + 4 video models", () => {
    expect(SOGNI_IMAGE_MODELS.filter((m) => m.tier === "recommended")).toHaveLength(4);
    expect(SOGNI_VIDEO_MODELS.filter((m) => m.tier === "recommended")).toHaveLength(4);
  });

  it("resolves exact curated ids with their claims", () => {
    const meta = sogniModelMeta("krea2_turbo_fp8_scaled");
    expect(meta?.tier).toBe("recommended");
    expect(meta?.label).toBe("Krea 2 Turbo");
    expect(meta?.useCase).toBeTruthy();
    expect(meta?.costTier).toBe("credits");
  });

  it("inherits family placement for new quant/step variants via prefix", () => {
    const variant = sogniModelMeta("krea2_turbo_v2_int8");
    expect(variant?.tier).toBe("recommended");

    const seedanceFast = sogniModelMeta("seedance-2-0-fast");
    expect(seedanceFast?.tier).toBe("recommended");
    expect(seedanceFast?.stylesSupported).toBe(false);
  });

  it("prefers the longest matching prefix (mini over its family base)", () => {
    expect(sogniModelMeta("seedance-2-0-mini")?.hint).toBe("fast");
    expect(sogniModelMeta("seedance-2-0-fast")?.hint).toBe("cinematic");
  });

  it("returns null for unknown models — no guessed claims", () => {
    expect(sogniModelMeta("some_brand_new_model_fp8")).toBeNull();
    expect(sogniModelMeta("gpt-image-2.5-flare")).toBeNull();
  });

  it("curated seedance entries stay styleless (guard against curated-flag override)", () => {
    const byId = new Map(SOGNI_VIDEO_MODELS.map((m) => [m.model, m]));
    expect(byId.get("seedance-2-0")?.stylesSupported).toBe(false);
    expect(byId.get("seedance-2-0-mini")?.stylesSupported).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/providers/sogni/model-meta.test.ts`. Expected: FAIL ("Cannot find module …/model-meta").

- [ ] **Step 3: Create `lib/providers/sogni/model-meta.ts`:**

```ts
import type { ModelKind, ModelDescriptor } from "@/lib/domain/models";
import { buildModelId } from "@/lib/domain/models";

/**
 * The hand-curated Sogni catalog: stable labels/order plus every picker claim
 * (tier, use case, cost). Nothing about WHERE a model sits in the picker is
 * guessed from ids — curated rows declare it here, and un-curated live models
 * resolve to `null` so they render unclaimed in the tail.
 */

export const PROVIDER_ID = "sogni";

interface CuratedModel {
  kind: ModelKind;
  model: string;
  label: string;
  hint?: string;
  tier?: "recommended";
  useCase?: string;
  costTier?: "free" | "credits" | "key-credits";
  /** Provider-workflow models that take only the raw prompt. */
  stylesSupported?: boolean;
  /** Family base id — live variants starting with it inherit this entry. */
  familyBase?: string;
}

const CURATED: CuratedModel[] = [
  {
    kind: "image",
    model: "krea2_turbo_fp8_scaled",
    label: "Krea 2 Turbo",
    hint: "premium credits",
    tier: "recommended",
    useCase: "Flagship all-rounder — crisp subjects, fast",
    costTier: "credits",
    familyBase: "krea2_turbo",
  },
  {
    kind: "image",
    model: "z_image_turbo_bf16",
    label: "Z-Image Turbo",
    hint: "sharp",
    tier: "recommended",
    useCase: "Sharp detail, strong text rendering",
    costTier: "credits",
    familyBase: "z_image_turbo",
  },
  {
    kind: "image",
    model: "flux1-schnell-fp8",
    label: "Flux Schnell",
    hint: "4-step",
    tier: "recommended",
    useCase: "Fast everyday workhorse",
    costTier: "credits",
    familyBase: "flux1-schnell",
  },
  {
    kind: "image",
    model: "chroma1-hd_fp8_scaled",
    label: "Chroma 1 HD",
    hint: "high detail",
    tier: "recommended",
    useCase: "Maximum detail on complex scenes",
    costTier: "credits",
    familyBase: "chroma1-hd",
  },
  {
    kind: "video",
    model: "wan_v2.2-14b-fp8_t2v_lightx2v",
    label: "WAN 2.2 LightX2V",
    hint: "budget",
    tier: "recommended",
    useCase: "Quick budget clips, 1–10s",
    costTier: "credits",
    familyBase: "wan_v2.2-14b-fp8_t2v",
  },
  {
    kind: "video",
    model: "ltx25-22b-int8_t2v_distilled",
    label: "LTX 2.5",
    hint: "flagship",
    tier: "recommended",
    useCase: "Flagship motion quality, 2–20s",
    costTier: "credits",
    familyBase: "ltx25-22b-int8_t2v",
  },
  {
    kind: "video",
    model: "seedance-2-0",
    label: "Seedance 2.0",
    hint: "cinematic",
    tier: "recommended",
    useCase: "Cinematic quality — start-frame capable, no style presets",
    costTier: "credits",
    stylesSupported: false,
    familyBase: "seedance-2-0",
  },
  {
    kind: "video",
    model: "seedance-2-0-mini",
    label: "Seedance 2.0 Mini",
    hint: "fast",
    tier: "recommended",
    useCase: "Fastest clips — prompt only, no style presets",
    costTier: "credits",
    stylesSupported: false,
  },
];

function toDescriptor(entry: CuratedModel): ModelDescriptor {
  return {
    id: buildModelId(PROVIDER_ID, entry.model),
    providerId: PROVIDER_ID,
    kind: entry.kind,
    model: entry.model,
    label: entry.label,
    ...(entry.hint ? { hint: entry.hint } : {}),
    ...(entry.tier ? { tier: entry.tier } : {}),
    ...(entry.useCase ? { useCase: entry.useCase } : {}),
    ...(entry.costTier ? { costTier: entry.costTier } : {}),
    ...(entry.stylesSupported === false ? { stylesSupported: false } : {}),
  };
}

/** Cold-start picker catalog; `catalog.ts` also uses these as the curated
 * overlay on the live fetch. */
export const SOGNI_IMAGE_MODELS: ModelDescriptor[] = CURATED.filter(
  (entry) => entry.kind === "image",
).map(toDescriptor);

export const SOGNI_VIDEO_MODELS: ModelDescriptor[] = CURATED.filter(
  (entry) => entry.kind === "video",
).map(toDescriptor);

const EXACT_META = new Map(CURATED.map((entry) => [entry.model, entry]));
const FAMILY_META = CURATED.filter((entry) => entry.familyBase).sort(
  (a, b) => (b.familyBase?.length ?? 0) - (a.familyBase?.length ?? 0),
);

/** Curated claims for a live model id: exact match first, then the longest
 * matching family prefix. `null` = not curated — the UI makes no claims. */
export function sogniModelMeta(modelId: string): CuratedModel | null {
  const exact = EXACT_META.get(modelId);
  if (exact) return exact;
  return FAMILY_META.find((entry) => modelId.startsWith(entry.familyBase!)) ?? null;
}
```

- [ ] **Step 4: Run** — `npx vitest run lib/providers/sogni/model-meta.test.ts`. Expected: all PASS.

- [ ] **Step 5: Deduplicate `request-maps.ts`** — delete the `SOGNI_IMAGE_MODELS` / `SOGNI_VIDEO_MODELS` array definitions (lines ~19-82) and replace with a re-export so `catalog.ts` and existing imports keep working:

```ts
import { PROVIDER_ID } from "@/lib/providers/sogni/model-meta";

export { PROVIDER_ID, SOGNI_IMAGE_MODELS, SOGNI_VIDEO_MODELS } from "@/lib/providers/sogni/model-meta";
```

(Adjust: `request-maps.ts` previously declared `PROVIDER_ID` itself — import it from `model-meta` instead and re-export. Remove the now-unused `buildModelId` import if nothing else in the file uses it.)

- [ ] **Step 6: Typecheck + full sogni suite** — `npx tsc --noEmit && npx vitest run lib/providers/sogni/`. Expected: typecheck clean; `catalog.test.ts` may FAIL on hint strings — that is Task 3's job. Only structural/module errors are failures here.

- [ ] **Step 7: Commit**

```bash
git add lib/providers/sogni/model-meta.ts lib/providers/sogni/model-meta.test.ts lib/providers/sogni/request-maps.ts
git commit -m "feat(sogni): curated model-meta table — tier/useCase/cost claims, family-prefix fallback"
```

---

### Task 3: Catalog stamping, exclusions, recommended-first sort — TDD

**Files:**
- Modify: `lib/providers/sogni/catalog.test.ts` (update hint expectations, add new tests)
- Modify: `lib/providers/sogni/catalog.ts`

- [ ] **Step 1: Update existing expectations** in `catalog.test.ts` — the "prefers curated labels and hints" test becomes:

```ts
  it("prefers curated labels and hints, else uses the API name", () => {
    const [krea, flux] = toDescriptors(LIVE_CATALOG, "image");
    expect(krea.label).toBe("Krea 2 Turbo");
    expect(krea.hint).toBe("premium credits");
    expect(krea.tier).toBe("recommended");
    expect(krea.useCase).toBeTruthy();
    expect(flux.label).toBe("Flux Dev");
    expect(flux.hint).toBeUndefined(); // no regex-guessed hints
    expect(flux.tier).toBeUndefined();
  });
```

(Expectation order still holds: krea is curated-first. If the destructure order flips after the sort change, pick by `find((m) => m.model === …)` instead.)

- [ ] **Step 2: Add new tests** to `catalog.test.ts` inside the main describe:

```ts
  it("excludes audio/reference/utility workflows the studio cannot drive", () => {
    const descriptors = toDescriptors(
      [
        model({ id: "ltx23-22b-fp8_a2v_dev", name: "LTX A2V", media: "video" }),
        model({ id: "minimax-h3-fastvideo-int8_flfa2v_turbo", name: "FLFA2V", media: "video" }),
        model({ id: "minimax-h3-ref2va-fp8_r2v", name: "MiniMax R2V", media: "video" }),
        model({ id: "happyhorse-1.1-r2v", name: "HappyHorse R2V", media: "video" }),
        model({ id: "birefnet_image_background_removal_fp16", name: "BiRefNet", media: "image" }),
        model({ id: "seedance-2-0", name: "Seedance 2.0", media: "video" }),
      ],
      "video",
    );
    const models = descriptors.map((m) => m.model);
    expect(models).toEqual(["seedance-2-0"]); // only the drivable one survives
  });

  it("stamps recommended-first ordering before alphabetical tail", () => {
    const descriptors = toDescriptors(
      [
        model({ id: "aardvark_model", name: "Aardvark", media: "image" }),
        model({ id: "krea2_turbo_fp8_scaled", name: "Krea 2 Turbo", media: "image" }),
        model({ id: "krea2_turbo_v2_int8", name: "Krea 2 Turbo v2", media: "image" }),
      ],
      "image",
    );
    const tiers = descriptors.map((m) => (m.tier === "recommended" ? "rec" : "tail"));
    expect(tiers).toEqual(["rec", "rec", "tail"]);
  });
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run lib/providers/sogni/catalog.test.ts`. Expected: FAIL (hint strings, missing exclusions, missing tier).

- [ ] **Step 4: Implement in `catalog.ts`:**

1. Extend the exclusion list:

```ts
const EXCLUDED_ID_PATTERNS = [
  "edit",
  "kontext",
  "segment",
  "sam3",
  "pixal3d",
  "upscale",
  "vsr",
  "i2v",
  "s2v",
  "v2v",
  "a2v", // audio-to-video (incl. ia2v, flfa2v) — no audio input in the studio
  "r2v", // reference-image workflows (incl. ref2va)
  "removal", // BiRefNet-style utilities
  "animate",
  "inpaint",
  "outpaint",
  "identity",
  "flf2v",
];
```

2. Import the resolver and drop `speedHint` entirely. In `toDescriptors`, replace the curated lookup + hint line:

```ts
    const meta = sogniModelMeta(model.id);
    // …
    label: meta?.label ?? (model.name?.trim() || prettifyModelId(model.id)),
    ...(meta?.hint ? { hint: meta.hint } : {}),
    ...(meta?.tier ? { tier: meta.tier } : {}),
    ...(meta?.useCase ? { useCase: meta.useCase } : {}),
    ...(meta?.costTier ? { costTier: meta.costTier } : {}),
    stylesSupported: meta ? meta.stylesSupported : supportsStyles(model.id),
    uncensored: supportsUncensored(model.id),
```

(The `CURATED` map and its import from `request-maps` go away; `supportsStyles` stays for un-curated ids. Keep the `satisfies ModelDescriptor` shape — spread conditionals are allowed.)

3. Recommended-first sort — add a tier compare ahead of the curated-rank compare in `toDescriptors`' final sort:

```ts
  return dynamic.sort((a, b) => {
    const recA = a.tier === "recommended";
    const recB = b.tier === "recommended";
    if (recA !== recB) return recA ? -1 : 1;
    const rankA = curatedOrder.get(a.model);
    const rankB = curatedOrder.get(b.model);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return a.label.localeCompare(b.label);
  });
```

4. Clean provider prefixes out of the hidden-model hints (`COLD_START_HIDDEN` and `buildHiddenModels`): `"Sogni · start frame"` → `"start frame"`, `"Sogni · start+end frame"` → `"start + end frame"`.

- [ ] **Step 5: Run the sogni suite** — `npx vitest run lib/providers/sogni/`. Expected: all PASS (including the pre-existing exclusion/hidden-model tests).

- [ ] **Step 6: Commit**

```bash
git add lib/providers/sogni/catalog.ts lib/providers/sogni/catalog.test.ts
git commit -m "feat(sogni): meta-stamped descriptors, a2v/r2v/removal exclusions, recommended-first picker order"
```

---

### Task 4: apikey.fan + Pollinations metadata

**Files:**
- Modify: `lib/providers/apikey-fan/request-maps.ts` (model arrays, lines ~17-66)
- Modify: `lib/providers/pollinations/pollinations.provider.ts` (FLUX_IMAGE / FLUX_VIDEO, lines ~32-52)

- [ ] **Step 1: apikey.fan** — add cost/tier/useCase to the five descriptors. Image 2.0 and Video 1.5 get `tier`; every entry gets `costTier: "key-credits"`:

```ts
    // grok-imagine-image-2.0
    hint: "flagship",
    tier: "recommended",
    useCase: "Flagship realism — uncensored-ready",
    costTier: "key-credits",
    // grok-imagine-image-quality → costTier: "key-credits" (hint stays "max detail")
    // grok-imagine-image → costTier: "key-credits" (hint stays "fast · budget")
    // grok-imagine-video-1.5
    hint: "flagship",
    tier: "recommended",
    useCase: "Flagship realism — start-frame capable",
    costTier: "key-credits",
    // grok-imagine-video → costTier: "key-credits" (hint stays "budget")
```

- [ ] **Step 2: Pollinations** — FLUX_IMAGE gains `tier: "recommended"`, `useCase: "Free fallback — no key needed"`, `costTier: "free"`; FLUX_VIDEO gains `useCase: "Free still-frame preview — not true video"`, `costTier: "free"` (no tier — it is not a real video model).

- [ ] **Step 3: Typecheck + provider tests** — `npx tsc --noEmit && npx vitest run lib/providers/`. Expected: PASS (existing tests assert labels, not hints).

- [ ] **Step 4: Commit**

```bash
git add lib/providers/apikey-fan/request-maps.ts lib/providers/pollinations/pollinations.provider.ts
git commit -m "feat(providers): recommended tier + cost metadata for apikey.fan and Pollinations catalogs"
```

---

### Task 5: Recommended-first default model — TDD

**Files:**
- Modify: `lib/providers/registry.test.ts`
- Modify: `lib/providers/registry.ts` (defaultModel, lines ~83-90)

- [ ] **Step 1: Failing test** in `registry.test.ts`, inside the main describe:

```ts
  it("picks the first recommended model as the default, else the first model", () => {
    const recommendedFlux = fakeProvider({
      id: "pollinations",
      configured: true,
      imageModels: [
        { ...flux.listImageModels()[0], tier: "recommended" as const },
      ],
    });
    // grok is registered first but carries no tier — recommended wins.
    const registry = createRegistry([grok, recommendedFlux]);
    expect(registry.defaultModel("image").id).toBe("pollinations:flux");
    // No tiers anywhere → first model (existing behaviour).
    const plain = createRegistry([grok, flux]);
    expect(plain.defaultModel("image").id).toBe("apikey-fan:grok-imagine-image-2.0");
  });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/providers/registry.test.ts`. Expected: the new test FAILS (returns the grok id).

- [ ] **Step 3: Implement** in `registry.ts`:

```ts
    defaultModel(kind) {
      const models = this.listModels(kind);
      const fallback = models.find((model) => model.tier === "recommended") ?? models[0];
      if (!fallback) {
        throw new ProviderError("No render provider is available.", { retryable: false });
      }
      return fallback;
    },
```

- [ ] **Step 4: Run registry suites** — `npx vitest run lib/providers/registry.test.ts lib/providers/registry.wiring.test.ts`. Expected: PASS. (If wiring tests pin a concrete default id, update the expectation to the recommended entry — same intent.)

- [ ] **Step 5: Commit**

```bash
git add lib/providers/registry.ts lib/providers/registry.test.ts
git commit -m "feat(registry): default model resolves to the first recommended entry"
```

---

### Task 6: Picker sections helper (pure, shared) — TDD

Lives in `lib/` so both React surfaces share it and vitest covers it without DOM.

**Files:**
- Create: `lib/model-picker-options.test.ts`
- Create: `lib/model-picker-options.ts`

- [ ] **Step 1: Failing test** — `lib/model-picker-options.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ModelOption } from "@/lib/model-catalog";
import { modelBadges, modelPickerSections } from "@/lib/model-picker-options";

function option(overrides: Partial<ModelOption>): ModelOption {
  return {
    id: "sogni:x",
    kind: "image",
    model: "x",
    label: "X",
    providerId: "sogni",
    providerLabel: "Sogni AI",
    ...overrides,
  };
}

describe("model picker sections", () => {
  const models: ModelOption[] = [
    option({ id: "sogni:krea2_turbo_fp8_scaled", model: "krea2_turbo_fp8_scaled", label: "Krea 2 Turbo", tier: "recommended", useCase: "Flagship", hint: "premium credits" }),
    option({ id: "pollinations:flux", providerId: "pollinations", providerLabel: "Pollinations", label: "Flux", tier: "recommended", costTier: "free" }),
    option({ id: "sogni:flux1-dev-fp8", model: "flux1-dev-fp8", label: "Flux Dev" }),
    option({ id: "sogni:gpt-image-2", model: "gpt-image-2", label: "GPT Image 2", uncensored: false }),
    option({ id: "pollinations:flux2", providerId: "pollinations", providerLabel: "Pollinations", model: "flux2", label: "Flux 2" }),
  ];

  it("splits recommended from a provider-grouped tail", () => {
    const sections = modelPickerSections(models);
    expect(sections.recommended.map((o) => o.label)).toEqual(["Krea 2 Turbo", "Flux"]);
    expect(sections.tailLabel).toBe("Show all 3 more models");
    const groups = [...new Set(sections.tail.map((o) => o.group))];
    expect(groups).toEqual(["Sogni AI", "Pollinations"]); // first-appearance order
  });

  it("carries hint/description and never duplicates the provider into the hint", () => {
    const sections = modelPickerSections(models);
    const krea = sections.recommended[0];
    expect(krea.hint).toBe("premium credits");
    expect(krea.description).toBe("Flagship");
    expect(krea.hint).not.toContain("Sogni");
  });

  it("builds capability badges", () => {
    const badges = modelBadges(option({ uncensored: false, costTier: "free", stylesSupported: false, frameInput: { start: true, end: false }, loraCapable: true }));
    expect(badges).toEqual(["Sensored", "Free", "No styles", "Start frame", "LoRA"]);
    expect(modelBadges(option({}))).toEqual([]);
  });

  it("collapses into a flat tail when nothing is recommended", () => {
    const sections = modelPickerSections([models[2]]);
    expect(sections.recommended.map((o) => o.label)).toEqual(["Flux Dev"]);
    expect(sections.tail).toEqual([]);
    expect(sections.tailLabel).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/model-picker-options.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — `lib/model-picker-options.ts`:

```ts
import type { ModelOption } from "@/lib/model-catalog";

/**
 * Picker-shaped option (structurally compatible with PillSelect's PillOption)
 * and the pure split shared by the composer pill and the conversion dialog:
 * curated "Recommended" rows pinned on top, everything else grouped by
 * provider in a collapsed tail.
 */

export interface ModelPickerOption {
  value: string;
  label: string;
  hint?: string;
  description?: string;
  badges?: string[];
  group?: string;
}

export interface ModelPickerSections {
  recommended: ModelPickerOption[];
  /** Provider-grouped tail options; empty when nothing is recommended. */
  tail: ModelPickerOption[];
  /** Disclosure label for the tail ("" when the tail renders inline). */
  tailLabel: string;
}

export function modelBadges(model: ModelOption): string[] {
  const badges: string[] = [];
  if (model.uncensored === false) badges.push("Sensored");
  if (model.costTier === "free") badges.push("Free");
  if (model.stylesSupported === false) badges.push("No styles");
  if (model.frameInput?.start) badges.push("Start frame");
  if (model.loraCapable) badges.push("LoRA");
  return badges;
}

export function modelPickerSections(models: ModelOption[]): ModelPickerSections {
  const recommended = models
    .filter((model) => model.tier === "recommended")
    .map((model) => toOption(model));
  const tail = models.filter((model) => model.tier !== "recommended");

  if (recommended.length === 0) {
    // No curated entries configured — render everything inline, no tail.
    return { recommended: tail.map((model) => toOption(model)), tail: [], tailLabel: "" };
  }

  const byProvider = new Map<string, ModelPickerOption[]>();
  for (const model of tail) {
    const group = model.providerLabel;
    if (!byProvider.has(group)) byProvider.set(group, []);
    byProvider.get(group)!.push(toOption(model, group));
  }
  return {
    recommended,
    tail: [...byProvider.values()].flat(),
    tailLabel: `Show all ${tail.length} more model${tail.length === 1 ? "" : "s"}`,
  };
}

function toOption(model: ModelOption, group?: string): ModelPickerOption {
  const badges = modelBadges(model);
  return {
    value: model.id,
    label: model.label,
    ...(model.hint ? { hint: model.hint } : {}),
    ...(model.useCase ? { description: model.useCase } : {}),
    ...(group ? { group } : {}),
    ...(badges.length ? { badges } : {}),
  };
}
```

- [ ] **Step 4: Run** — `npx vitest run lib/model-picker-options.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/model-picker-options.ts lib/model-picker-options.test.ts
git commit -m "feat(models): shared picker-sections helper — recommended split, provider tail, badges"
```

---

### Task 7: PillSelect — two-line rows, badges, collapsible tail

No unit tests — this repo's vitest harness is node-only (`include: ["lib/**/*.test.ts"]`, no jsdom), so PillSelect is verified by typecheck, the full suite, and the Task 9 browser pass (spec deviation, noted here deliberately).

**Files:**
- Modify: `components/PillSelect.tsx`

- [ ] **Step 1: Extend `PillOption`:**

```ts
export interface PillOption {
  value: string;
  label: string;
  hint?: string;
  /** Second row under the label (e.g. a model's use case). */
  description?: string;
  /** Tiny uppercase chips after the label (Sensored, Free, LoRA…). */
  badges?: string[];
  /** When any option carries one, the dropdown renders grouped sections
   * ordered by first appearance (e.g. Sensored / Uncensored models). */
  group?: string;
}
```

- [ ] **Step 2: Add the opt-in tail prop** to the component signature:

```ts
  /** Collapsed "everything else" section (provider-grouped). */
  tail?: { label: string; options: PillOption[] };
```

Add `const [tailOpen, setTailOpen] = useState(false);` next to `open`, and reset it when the dropdown closes (`setTailOpen(false)` inside the outside-click and Escape handlers, and when an option is picked).

- [ ] **Step 3: Two-line rows + badges** — replace `renderOption`'s inner content:

```tsx
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate">{option.label}</span>
            {option.hint && (
              <span className="shrink-0 text-[11px] font-normal text-muted">{option.hint}</span>
            )}
            {option.badges?.map((badge) => (
              <span
                key={badge}
                className="shrink-0 rounded-full bg-surface-2 px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide text-muted"
              >
                {badge}
              </span>
            ))}
          </span>
          {option.description && (
            <span className="mt-0.5 block truncate text-[11px] font-normal leading-tight text-muted">
              {option.description}
            </span>
          )}
        </span>
```

- [ ] **Step 4: Parameterize section rendering** — change `renderSections` to `renderSections(options: PillOption[])` (it currently closes over `options`); the header call site becomes `{renderSections(options)}`.

- [ ] **Step 5: Tail section** — after `{renderSections(options)}` inside the dropdown, before the closing `</div>`:

```tsx
          {tail && tail.options.length > 0 && (
            <div className="mt-1 border-t border-border pt-1">
              <button
                type="button"
                onClick={() => setTailOpen((v) => !v)}
                className="flex w-full items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-left text-[12px] font-semibold text-ink-soft transition-colors hover:bg-surface-2"
              >
                <Icon
                  name="chevron-down"
                  size={12}
                  className={`opacity-70 transition-transform ${tailOpen ? "" : "-rotate-90"}`}
                />
                {tail.label}
              </button>
              {tailOpen && renderSections(tail.options)}
            </div>
          )}
```

- [ ] **Step 6: Roomier dropdown** — in the dropdown container class, `w-56` → `w-72` and `max-h-64` → `max-h-80`.

- [ ] **Step 7: Typecheck + suite** — `npx tsc --noEmit && npx vitest run`. Expected: clean (PillOption consumers pass subsets; structural typing holds).

- [ ] **Step 8: Commit**

```bash
git add components/PillSelect.tsx
git commit -m "feat(ui): PillSelect two-line rows, capability badges, collapsible tail section"
```

---

### Task 8: Wire the composer + conversion dialog

**Files:**
- Modify: `components/PromptComposer.tsx` (model pill block, lines ~335-355)
- Modify: `components/story/ConvertDialog.tsx` (PillSelect, lines ~69-83)

- [ ] **Step 1: PromptComposer** — import the helper and replace the model options mapping:

```tsx
import { modelPickerSections } from "@/lib/model-picker-options";
```

Replace the `{models && models.length > 0 && onModelChange && ( … )}` block with:

```tsx
        {models && models.length > 0 && onModelChange && (
          <PillSelect
            icon="chip"
            label="Model"
            value={modelId ?? models[0].id}
            options={(() => {
              const sections = modelPickerSections(models);
              return sections.recommended;
            })()}
            tail={(() => {
              const sections = modelPickerSections(models);
              return sections.tail.length
                ? { label: sections.tailLabel, options: sections.tail }
                : undefined;
            })()}
            onChange={onModelChange}
          />
        )}
```

(Cleaner: compute `const modelSections = models ? modelPickerSections(models) : null;` once above the return and reference it — prefer that; the IIFEs above are the fallback if a hooks-order constraint blocks it.)

- [ ] **Step 2: ConvertDialog** — same helper:

```tsx
import { modelPickerSections } from "@/lib/model-picker-options";
```

```tsx
          <PillSelect
            icon="video"
            label="Model"
            value={chosen ?? models[0]?.id ?? ""}
            onChange={setChosen}
            options={modelPickerSections(models).recommended}
            tail={(() => {
              const sections = modelPickerSections(models);
              return sections.tail.length
                ? { label: sections.tailLabel, options: sections.tail }
                : undefined;
            })()}
          />
```

(`hint: model.providerLabel` disappears — provider is the tail group now.)

- [ ] **Step 3: Typecheck + full suite + build** — `npx tsc --noEmit && npx vitest run && npx next build`. Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add components/PromptComposer.tsx components/story/ConvertDialog.tsx
git commit -m "feat(ui): model pill renders recommended tiers + collapsed provider tail"
```

---

### Task 9: End-to-end verification

- [ ] **Step 1: Full gate** — `npx vitest run && npx tsc --noEmit && npx next build`. Expected: 300+ tests pass, build succeeds.

- [ ] **Step 2: Live browser check** — `npx next dev -p 3100` (never 3000). With a Playwright-via-node script or the browser tool:
  1. Open `http://localhost:3100` (Solo image): click the Model pill → screenshot. Expected: "Recommended" section with ~6 rows showing second-line use cases + badge chips, then "Show all N more models" disclosure; expanding it reveals provider-grouped sections (Sogni AI / apikey.fan / Pollinations); **no row shows the provider name twice**.
  2. Switch to Video workspace: same shape with 4 recommended video models.
  3. Confirm no `a2v`/`r2v`/`removal` model appears anywhere in the expanded list.
  4. Story tab → open an image story → Convert dialog: picker shows the same two-section shape.
- [ ] **Step 3: Store the screenshots** under `shots/` (git-ignored) and attach the summary to the final report.

- [ ] **Step 4: Finish** — commit any strays, then `git log --oneline master..HEAD` to confirm the task-by-task history is intact.
