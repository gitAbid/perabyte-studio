# Story Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Story-mode scenes chain via start/end frame refs (auto-derived from the previous scene or manually uploaded), run through a persistent sequential/parallel queue, and an image story converts one-click into a video story of first/last-frame clip pairs.

**Architecture:** Frames travel as content-addressed media-cache refs; the server loads bytes and hands them to providers (Sogni Buffers for `referenceImage`/`referenceImageEnd`/`startingImage`; Grok data-URIs for `image.url`/`/images/edits`). A module-level story runner (dependency-injected, unit-testable) owns the queue; the persisted story asset IS the queue. Capability flags on `ModelDescriptor` (`frameInput`, `i2vModelId`) drive auto model swap and UI gating.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, vitest (node env), existing provider layer (`lib/providers/*`), localStorage store (`lib/store.ts`).

**Spec:** `docs/superpowers/specs/2026-09-15-story-continuation-design.md`
**Provider facts:** `docs/sogni-api-guide.md`

**Branch:** work on a feature branch: `git checkout -b feature/story-continuation`

---

### Task 1: Domain + app type additions

**Files:**
- Modify: `lib/domain/models.ts`
- Modify: `lib/types.ts`

- [ ] **Step 1: Add capability and frame types to `lib/domain/models.ts`**

Add after the `ModelDescriptor` interface's existing fields and extend the request type:

```ts
/** Frame conditioning a model accepts. Absent = prompt-only. */
export interface ModelFrameInput {
  start: boolean;
  end: boolean;
}

/** A continuity frame loaded from the media cache. */
export interface FrameImage {
  bytes: Buffer;
  contentType: string;
}
```

Inside `ModelDescriptor`, add:

```ts
  /** Frame conditioning this model accepts. Absent = prompt-only. */
  frameInput?: ModelFrameInput;
  /** Model id (`<provider>:<model>`) to swap to when a start frame is present.
   *  Absent when the model itself already takes frames. */
  i2vModelId?: string;
```

Inside `NormalizedGenerationRequest`, add:

```ts
  /** Continuity frames resolved by the service layer (media-cache bytes). */
  startImage?: FrameImage;
  endImage?: FrameImage;
```

- [ ] **Step 2: Extend app contracts in `lib/types.ts`**

```ts
export interface GeneratedMedia {
  id: string;
  url: string;
  width: number;
  height: number;
  seed: number;
  /** Real content type when known — lets the UI pick a true video player. */
  mime?: string;
  /** Exact final-frame image (Seedance 2.5 `returnLastFrame`), cache-backed. */
  endFrameUrl?: string;
}

export interface GenerationResponse {
  requestId: string;
  status: "completed";
  kind: GenerationKind;
  elapsedMs: number;
  prewarmed?: boolean;
  media: GeneratedMedia[];
  /** Set when the service swapped the model for frame capability. */
  effectiveModelId?: string;
  effectiveModelLabel?: string;
  /** True when a provided start frame actually conditioned the render. */
  frameUsed?: boolean;
}

export interface StoryScene {
  id: string;
  prompt: string;
  url: string | null;
  status: JobStatus;
  kind: GenerationKind;
  error?: string;
  /** Manual reference frame uploaded by the user (media-cache ref). */
  startImageRef?: string;
  endImageRef?: string;
  /** Derived final frame of this scene, chaining to the next scene. */
  endFrameRef?: string;
  /** Model actually used when the service swapped for frame capability. */
  effectiveModelId?: string;
  frameUsed?: boolean;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors (additive optional fields).

- [ ] **Step 4: Commit**

```bash
git add lib/domain/models.ts lib/types.ts
git commit -m "feat(domain): frame-capability types (frameInput, i2vModelId, frame refs)"
```

---

### Task 2: Sogni capability rules + hidden model registry

**Files:**
- Modify: `lib/providers/sogni/catalog.ts`
- Modify: `lib/providers/types.ts`
- Modify: `lib/providers/registry.ts`
- Test: `lib/providers/sogni/catalog.test.ts`, `lib/providers/registry.test.ts`

- [ ] **Step 1: Write failing tests for capability rules (append to `lib/providers/sogni/catalog.test.ts`)**

```ts
import { frameCapability, i2vSiblingId } from "@/lib/providers/sogni/catalog";

describe("frameCapability", () => {
  it("marks ltx23 i2v as start+end (keyframe interpolation)", () => {
    expect(frameCapability("ltx23-22b-fp8_i2v_distilled")).toEqual({ start: true, end: true });
  });
  it("marks minimax h3 i2v as start+end", () => {
    expect(frameCapability("minimax-h3-fl2va-fp8_i2v")).toEqual({ start: true, end: true });
  });
  it("marks flf2v as start+end", () => {
    expect(frameCapability("minimax-h3-fl2va-fp8_flf2v")).toEqual({ start: true, end: true });
  });
  it("marks seedance 2.5 as start+end and 2.0 as start-only", () => {
    expect(frameCapability("seedance-2-5")).toEqual({ start: true, end: true });
    expect(frameCapability("seedance-2-0-mini")).toEqual({ start: true, end: false });
  });
  it("leaves t2v-only families prompt-only", () => {
    expect(frameCapability("wan_v2.2-14b-fp8_t2v_lightx2v")).toBeUndefined();
    expect(frameCapability("ltx25-22b-int8_t2v_distilled")).toBeUndefined();
    expect(frameCapability("happyhorse-1.1-t2v")).toBeUndefined();
  });
});

describe("i2vSiblingId", () => {
  it("rewrites t2v to i2v within the family", () => {
    expect(i2vSiblingId("wan_v2.2-14b-fp8_t2v_lightx2v")).toBe("wan_v2.2-14b-fp8_i2v_lightx2v");
    expect(i2vSiblingId("ltx25-22b-int8_t2v_distilled")).toBe("ltx25-22b-int8_i2v_distilled");
  });
  it("returns null for models without a t2v workflow suffix", () => {
    expect(i2vSiblingId("seedance-2-0-mini")).toBeNull();
    expect(i2vSiblingId("ltx23-22b-fp8_i2v_dev")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/providers/sogni/catalog.test.ts`
Expected: FAIL — `frameCapability`/`i2vSiblingId` not exported.

- [ ] **Step 3: Implement the pure capability rules in `lib/providers/sogni/catalog.ts`**

```ts
import type { ModelFrameInput } from "@/lib/domain/models";

/** Frame conditioning by model family (verified against the live catalog —
 *  see docs/sogni-api-guide.md §5). Undefined = prompt-only. */
export function frameCapability(modelId: string): ModelFrameInput | undefined {
  const id = modelId.toLowerCase();
  if (id.includes("_flf2v")) return { start: true, end: true };
  if (id.includes("_i2v")) {
    return { start: true, end: id.startsWith("ltx23-") || id.startsWith("minimax-h3") };
  }
  if (id.startsWith("seedance-2-5")) return { start: true, end: true };
  if (id.startsWith("seedance-2-0")) return { start: true, end: false };
  return undefined;
}

/** The i2v sibling of a t2v workflow model, or null. */
export function i2vSiblingId(modelId: string): string | null {
  return modelId.includes("_t2v") ? modelId.replace("_t2v", "_i2v") : null;
}
```

- [ ] **Step 4: Run capability tests to verify they pass**

Run: `npx vitest run lib/providers/sogni/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `listHiddenModels` to provider contracts in `lib/providers/types.ts`**

Add to **both** `ImageProvider` and `VideoProvider` interfaces:

```ts
  /** Models that resolve but never appear in the picker — i2v siblings and
   *  flf2v keyframe models auto-selected for frame-chained renders. */
  listHiddenModels?(): ModelDescriptor[];
```

- [ ] **Step 6: Write failing registry test (append to `lib/providers/registry.test.ts`)**

```ts
it("resolves hidden models without listing them", () => {
  const hidden: ModelDescriptor = {
    id: "sogni:wan_v2.2-14b-fp8_i2v_lightx2v",
    providerId: "sogni",
    kind: "video",
    model: "wan_v2.2-14b-fp8_i2v_lightx2v",
    label: "WAN 2.2 i2v",
    frameInput: { start: true, end: false },
  };
  const provider = makeFakeProvider(); // existing helper in this file
  (provider as { listVideoModels: () => ModelDescriptor[] }).listVideoModels = () => [];
  (provider as { listHiddenModels: () => ModelDescriptor[] }).listHiddenModels = () => [hidden];
  const registry = createRegistry([provider as never]);

  expect(registry.listModels("video")).toEqual([]);
  expect(registry.listAllModels("video").map((m) => m.id)).toEqual([hidden.id]);
  expect(registry.findAnywhere(hidden.id)?.model.id).toBe(hidden.model);
});
```

(Adapt `makeFakeProvider` to whatever helper the existing test file uses; if none, inline a minimal provider object with `id`, `label`, `isConfigured: () => true`, `listImageModels: () => []`, `generateImage`/`generateVideo` stubs.)

- [ ] **Step 7: Run registry test to verify it fails**

Run: `npx vitest run lib/providers/registry.test.ts`
Expected: FAIL — `listAllModels` not defined.

- [ ] **Step 8: Implement in `lib/providers/registry.ts`**

```ts
function hiddenModelsOf(provider: AnyProvider): ModelDescriptor[] {
  return provider.listHiddenModels?.() ?? [];
}
```

In `createRegistry`, add to the returned object:

```ts
    /** Picker models plus hidden capability models (i2v siblings, flf2v). */
    listAllModels(kind: ModelKind): ModelDescriptor[] {
      return providers
        .filter((provider) => provider.isConfigured())
        .flatMap((provider) => [...modelsOf(provider, kind), ...hiddenModelsOf(provider)]);
    },
```

and change `findAnywhere`'s candidate list:

```ts
      const model = [
        ...modelsOf(provider, "image"),
        ...modelsOf(provider, "video"),
        ...hiddenModelsOf(provider),
      ].find((candidate) => candidate.id === modelId);
```

Add to the `ProviderRegistry` interface:

```ts
  /** Picker models plus hidden capability models, configured providers only. */
  listAllModels(kind: ModelKind): ModelDescriptor[];
```

- [ ] **Step 9: Run registry tests to verify they pass**

Run: `npx vitest run lib/providers/registry.test.ts`
Expected: PASS (all).

- [ ] **Step 10: Wire the Sogni catalog — hidden descriptors, sibling links, picker hygiene**

In `lib/providers/sogni/catalog.ts`:

1. Extend the catalog shape:

```ts
export interface SogniCatalog {
  images: ModelDescriptor[];
  videos: ModelDescriptor[];
  /** Registered but unpickable: i2v siblings + flf2v keyframe models. */
  hidden: ModelDescriptor[];
}
```

2. `getSogniCatalog()` fallback becomes:

```ts
export function getSogniCatalog(): SogniCatalog {
  if (cache) return cache.catalog;
  return { images: SOGNI_IMAGE_MODELS, videos: SOGNI_VIDEO_MODELS, hidden: COLD_START_HIDDEN };
}
```

3. Cold-start hidden set (verified live ids):

```ts
const COLD_START_HIDDEN: ModelDescriptor[] = [
  {
    id: buildModelId(PROVIDER_ID, "wan_v2.2-14b-fp8_i2v_lightx2v"),
    providerId: PROVIDER_ID,
    kind: "video",
    model: "wan_v2.2-14b-fp8_i2v_lightx2v",
    label: "WAN 2.2 i2v",
    hint: "Sogni · start frame",
    frameInput: { start: true, end: false },
  },
  {
    id: buildModelId(PROVIDER_ID, "ltx25-22b-int8_i2v_distilled"),
    providerId: PROVIDER_ID,
    kind: "video",
    model: "ltx25-22b-int8_i2v_distilled",
    label: "LTX 2.5 i2v",
    hint: "Sogni · start frame",
    frameInput: { start: true, end: false },
  },
];
```

4. In `toDescriptors`, when `kind === "video"`, attach `i2vModelId` and direct `frameInput`:

```ts
      const hiddenIds = new Set(models.map((m) => m.id)); // full fetched set, pre-filter
```

compute `hiddenIds` **before** the `.filter(...)` (the fetched array passed in), then inside the `.map`:

```ts
      const sibling = i2vSiblingId(model.id);
      const capability = frameCapability(model.id);
      return {
        // ...existing fields...
        ...(capability ? { frameInput: capability } : {}),
        ...(sibling && hiddenIds.has(sibling)
          ? { i2vModelId: buildModelId(PROVIDER_ID, sibling) }
          : {}),
      } satisfies ModelDescriptor;
```

Note: the existing filter drops `i2v`-matching ids from the picker list — keep that, but `seedance-2-0-mini`/`seedance-2-5` pass the filter (no excluded substring) and now carry `frameInput` directly.

5. New hidden-model builder, called from `refresh()`:

```ts
function buildHiddenModels(models: SogniAvailableModel[]): ModelDescriptor[] {
  const usable = models.filter((m) => m.media === "video" && m.workerCount > 0);
  const built: ModelDescriptor[] = [];
  for (const model of usable) {
    const capability = frameCapability(model.id);
    const isI2v = model.id.toLowerCase().includes("_i2v");
    const isFlf2v = model.id.toLowerCase().includes("_flf2v");
    if (!capability || (!isI2v && !isFlf2v)) continue; // picker models are built elsewhere
    if (isExcluded(model.id) && !isI2v && !isFlf2v) continue;
    built.push({
      id: buildModelId(PROVIDER_ID, model.id),
      providerId: PROVIDER_ID,
      kind: "video",
      model: model.id,
      label: prettifyI2vLabel(model),
      hint: isFlf2v ? "Sogni · start+end frame" : "Sogni · start frame",
      stylesSupported: supportsStyles(model.id),
      uncensored: supportsUncensored(model.id),
      frameInput: capability,
    });
  }
  return built;
}

function prettifyI2vLabel(model: SogniAvailableModel): string {
  const base = model.name?.trim() || prettifyModelId(model.id);
  return base;
}
```

and in `refresh()`:

```ts
    cache = {
      catalog: {
        images: toDescriptors(models, "image"),
        videos: toDescriptors(models, "video"),
        hidden: buildHiddenModels(models),
      },
      fetchedAt: Date.now(),
    };
```

6. Image models get start capability — in `toDescriptors` for `kind === "image"` add `frameInput: { start: true, end: false }` (Sogni image projects accept `startingImage` for img2img).

7. Provider exposes hidden models — in `lib/providers/sogni/sogni.provider.ts`:

```ts
  // The live Sogni catalog, stale-while-revalidate (curated set until the
  // first refresh lands) — see catalog.ts.
  listImageModels: () => getSogniCatalog().images,
  listVideoModels: () => getSogniCatalog().videos,
  listHiddenModels: () => getSogniCatalog().hidden,
```

- [ ] **Step 11: Write catalog wiring test (append to `lib/providers/sogni/catalog.test.ts`)**

```ts
import { setCatalogFetcherForTests, getSogniCatalog } from "@/lib/providers/sogni/catalog";
import type { SogniAvailableModel } from "@/lib/providers/sogni/client";

const FETCHED: SogniAvailableModel[] = [
  { id: "wan_v2.2-14b-fp8_t2v_lightx2v", name: "WAN 2.2", workerCount: 72, media: "video" },
  { id: "wan_v2.2-14b-fp8_i2v_lightx2v", name: "WAN 2.2 i2v", workerCount: 73, media: "video" },
  { id: "minimax-h3-fl2va-fp8_flf2v", name: "MiniMax H3 flf2v", workerCount: 125, media: "video" },
  { id: "seedance-2-5", name: "Seedance 2.5", workerCount: 9, media: "video" },
];

it("links t2v models to registered i2v siblings and hides frame models", async () => {
  setCatalogFetcherForTests(async () => FETCHED);
  await warmSogniCatalog(1_000);
  const catalog = getSogniCatalog();

  const wan = catalog.videos.find((m) => m.model === "wan_v2.2-14b-fp8_t2v_lightx2v");
  expect(wan?.i2vModelId).toBe("sogni:wan_v2.2-14b-fp8_i2v_lightx2v");

  // i2v/flf2v are registered but never listed in the picker
  expect(catalog.videos.some((m) => m.model.includes("_i2v"))).toBe(false);
  expect(catalog.videos.some((m) => m.model.includes("_flf2v"))).toBe(false);
  expect(catalog.hidden.map((m) => m.model)).toEqual(
    expect.arrayContaining(["wan_v2.2-14b-fp8_i2v_lightx2v", "minimax-h3-fl2va-fp8_flf2v"]),
  );
  expect(catalog.hidden.every((m) => m.frameInput?.start)).toBe(true);

  const seedance = catalog.videos.find((m) => m.model === "seedance-2-5");
  expect(seedance?.frameInput).toEqual({ start: true, end: true });

  setCatalogFetcherForTests(null);
});
```

(Add `warmSogniCatalog` to the import list. If a previous test in the file already set a fetcher, reset with `setCatalogFetcherForTests(null)` in an `afterEach`.)

- [ ] **Step 12: Run catalog tests**

Run: `npx vitest run lib/providers/sogni/catalog.test.ts`
Expected: PASS.

- [ ] **Step 13: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 14: Commit**

```bash
git add lib/providers/sogni/catalog.ts lib/providers/sogni/catalog.test.ts lib/providers/types.ts lib/providers/registry.ts lib/providers/registry.test.ts lib/providers/sogni/sogni.provider.ts
git commit -m "feat(capability): sogni frame-capability rules, hidden i2v/flf2v registry, sibling links"
```

---

### Task 3: apikey.fan capability flags + `/api/models` exposure

**Files:**
- Modify: `lib/providers/apikey-fan/request-maps.ts`
- Modify: `lib/services/catalog.service.ts`, `app/api/models/route.ts`
- Modify: `lib/model-catalog.ts`
- Test: `lib/providers/apikey-fan/request-maps.test.ts`

- [ ] **Step 1: Add `frameInput` to every apikey.fan model in `request-maps.ts`**

To each entry in `APIKEY_FAN_IMAGE_MODELS` and `APIKEY_FAN_VIDEO_MODELS` add (Grok takes a start frame on the same model id — video `image.url`, images via `/images/edits` — and has no end-frame capability):

```ts
    frameInput: { start: true, end: false },
```

- [ ] **Step 2: Extend the descriptor test in `request-maps.test.ts`**

```ts
it("advertises start-frame capability on every grok model", () => {
  for (const model of [...APIKEY_FAN_IMAGE_MODELS, ...APIKEY_FAN_VIDEO_MODELS]) {
    expect(model.frameInput).toEqual({ start: true, end: false });
    expect(model.i2vModelId).toBeUndefined(); // same model takes frames
  }
});
```

Run: `npx vitest run lib/providers/apikey-fan/request-maps.test.ts` — expected FAIL first, then implement, then PASS.

- [ ] **Step 3: Expose frames through the catalog service + route**

Read `lib/services/catalog.service.ts`, then extend `getModelCatalog(kind)` with an optional frame filter that merges hidden models via the new registry method:

```ts
export interface CatalogFilter {
  /** Only models with this frame capability (end-capable list powers the
   *  story-conversion picker). */
  frame?: "start" | "end";
}
```

`getModelCatalog(kind: ModelKind, filter?: CatalogFilter)` filters `catalog.models` (switch its source to `registry.listAllModels(kind)` when `filter?.frame` is set, `registry.listModels(kind)` otherwise):

```ts
  const source = filter?.frame
    ? registry.listAllModels(kind)
    : registry.listModels(kind);
  const models = source.filter((model) =>
    filter?.frame ? model.frameInput?.[filter.frame] === true : true,
  );
```

(Signature change is backward compatible — existing callers pass one arg.)

In `app/api/models/route.ts`, parse and forward the filter, and serialize the new fields:

```ts
  const frameParam = searchParams.get("frame");
  const frame = frameParam === "start" || frameParam === "end" ? frameParam : undefined;
  const catalog = getModelCatalog(kind, frame ? { frame } : undefined);
```

and in the `models` map add:

```ts
    frameInput: model.frameInput,
    i2vModelId: model.i2vModelId,
```

- [ ] **Step 4: Client catalog option type in `lib/model-catalog.ts`**

```ts
export interface ModelOption {
  // ...existing fields...
  frameInput?: { start: boolean; end: boolean };
  i2vModelId?: string;
}
```

and generalize the fetch/cache key so the conversion dialog can request the end-capable list:

```ts
function fetchCatalog(kind: GenerationKind, frame?: "start" | "end"): Promise<ModelCatalog> {
  const key = `${kind}:${frame ?? ""}`;
  let pending = catalogCache.get(key);
  if (!pending) {
    pending = fetch(`/api/models?kind=${kind}${frame ? `&frame=${frame}` : ""}`).then(
      async (response) => {
        if (!response.ok) throw new Error(`catalog ${response.status}`);
        return (await response.json()) as ModelCatalog;
      },
    );
    pending.catch(() => catalogCache.delete(key));
    catalogCache.set(key, pending);
  }
  return pending;
}

export function useModelCatalog(kind: GenerationKind, frame?: "start" | "end"): CatalogState {
  // identical to the existing hook, but the effect depends on [kind, frame]
  // and calls fetchCatalog(kind, frame)
}
```

- [ ] **Step 5: Typecheck + suite + commit**

Run: `npm run typecheck && npm test`
Expected: green.

```bash
git add lib/providers/apikey-fan/request-maps.ts lib/providers/apikey-fan/request-maps.test.ts lib/services/catalog.service.ts app/api/models/route.ts lib/model-catalog.ts
git commit -m "feat(catalog): frame-capability flags through /api/models + end-capable frame filter"
```

---

### Task 4: Frame upload endpoint (`POST /api/media`)

**Files:**
- Modify: `lib/repositories/media.repository.ts` (export the sniffer)
- Create: `lib/services/media.service.ts`
- Modify: `app/api/media/route.ts`
- Test: `lib/services/media.service.test.ts` (new)

- [ ] **Step 1: Export the sniffer from `lib/repositories/media.repository.ts`**

Change `function sniff(` to `export function sniff(` (same file, no behavior change).

- [ ] **Step 2: Write the failing service test (`lib/services/media.service.test.ts`)**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { storeImageUpload, MediaUploadError } from "@/lib/services/media.service";
import { setMediaRepositoryForTests } from "@/lib/repositories/media.repository";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from("rest-of-png"),
]);

afterEach(() => setMediaRepositoryForTests(null));

describe("storeImageUpload", () => {
  it("stores an image and returns ref + url", async () => {
    const result = await storeImageUpload(PNG);
    expect(result.ref).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(result.url).toBe(`/api/media?f=${result.ref}`);
    expect(result.contentType).toBe("image/png");
  });

  it("rejects non-images", async () => {
    await expect(storeImageUpload(Buffer.from("not an image"))).rejects.toMatchObject({
      name: "MediaUploadError",
      status: 400,
    });
  });

  it("rejects payloads over 10 MB", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);
    await expect(storeImageUpload(big)).rejects.toMatchObject({ status: 413 });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run lib/services/media.service.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `lib/services/media.service.ts`**

```ts
import { getMediaRepository, sniff } from "@/lib/repositories/media.repository";

/** Client uploads for continuity/reference frames. Images only — videos are
 *  produced by providers, never uploaded. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export class MediaUploadError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status = 400, retryable = false) {
    super(message);
    this.name = "MediaUploadError";
    this.status = status;
    this.retryable = retryable;
  }
}

export interface StoredUpload {
  ref: string;
  url: string;
  contentType: string;
}

export async function storeImageUpload(bytes: Buffer): Promise<StoredUpload> {
  if (bytes.length === 0) {
    throw new MediaUploadError("That file is empty. Choose an image and try again.");
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new MediaUploadError("Images are limited to 10 MB. Choose a smaller file.", 413);
  }
  const type = sniff(bytes);
  if (!type || !type.contentType.startsWith("image/") || type.ext === "gif") {
    throw new MediaUploadError("Only PNG, JPEG or WebP images can be used as frames.");
  }
  const stored = await getMediaRepository().put(bytes, type.ext);
  return { ref: stored.ref, url: `/api/media?f=${stored.ref}`, contentType: stored.contentType };
}
```

- [ ] **Step 5: Run the service test to verify it passes**

Run: `npx vitest run lib/services/media.service.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the POST handler to `app/api/media/route.ts`** (below the GET)

```ts
import { MediaUploadError, storeImageUpload } from "@/lib/services/media.service";

/** Accepts a raw image body as a continuity/reference frame and stores it in
 *  the content-addressed cache. Returns `{ ref, url, contentType }`. */
export async function POST(request: Request) {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await request.arrayBuffer());
  } catch {
    return NextResponse.json(
      { error: "We could not read that upload. Please try again.", retryable: true },
      { status: 400 },
    );
  }
  try {
    const stored = await storeImageUpload(bytes);
    return NextResponse.json(stored, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof MediaUploadError) {
      return NextResponse.json(
        { error: error.message, retryable: error.retryable },
        { status: error.status },
      );
    }
    log.error("frame upload failed", { error });
    return NextResponse.json(
      { error: "That image could not be stored. Please retry.", retryable: true },
      { status: 503 },
    );
  }
}
```

- [ ] **Step 7: Typecheck + suite + commit**

Run: `npm run typecheck && npm test`
Expected: green.

```bash
git add lib/repositories/media.repository.ts lib/services/media.service.ts lib/services/media.service.test.ts app/api/media/route.ts
git commit -m "feat(media): POST /api/media frame upload (image-only, content-addressed)"
```

---

### Task 5: Service layer — ref validation, model swap, frame gating

**Files:**
- Modify: `lib/services/generation.service.ts`
- Test: `lib/services/generation.service.test.ts`

- [ ] **Step 1: Write failing tests (append to `lib/services/generation.service.test.ts`)**

Follow the file's existing fake-registry pattern (it injects providers via `setRegistryForTests` / fake media repo — mirror neighbouring tests):

```ts
describe("continuity frames", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function bodyWith(refs: Record<string, string>) {
    return { kind: "video", prompt: "a fox", ...refs };
  }

  it("rejects malformed frame refs", async () => {
    await expect(
      runGeneration(bodyWith({ startImageRef: "../escape.png" })),
    ).rejects.toMatchObject({ field: "startImage", status: 400 });
  });

  it("400s when the start ref is missing from the cache", async () => {
    // fake repository returning null for get()
    await expect(
      runGeneration(bodyWith({ startImageRef: `${"a".repeat(64)}.png` })),
    ).rejects.toMatchObject({
      field: "startImage",
      message: expect.stringContaining("Continuity frame missing"),
    });
  });

  it("swaps to the i2v sibling and reports the effective model", async () => {
    // fake registry: picker model wan t2v (no frameInput, i2vModelId=sogni:…_i2v),
    // hidden sibling with frameInput.start — mirror existing fake patterns
    const response = await runGeneration(bodyWith({ startImageRef: `${"a".repeat(64)}.png` }));
    expect(response.effectiveModelId).toBe("sogni:wan_v2.2-14b-fp8_i2v_lightx2v");
    expect(response.frameUsed).toBe(true);
  });

  it("keeps the model when it already takes frames", async () => {
    const response = await runGeneration(
      bodyWith({ startImageRef: `${"a".repeat(64)}.png`, modelId: "sogni:seedance-2-0-mini" }),
    );
    expect(response.effectiveModelId).toBeUndefined();
    expect(response.frameUsed).toBe(true);
  });

  it("drops frames (frameUsed false) when no capability exists", async () => {
    const response = await runGeneration(
      bodyWith({ startImageRef: `${"a".repeat(64)}.png`, modelId: "pollinations:flux-keyframe" }),
    );
    expect(response.frameUsed).toBe(false);
  });

  it("drops the end frame when the model can't condition on it", async () => {
    // fake provider records the normalized request it received
    // assert request.endImage === undefined for a start-only model
  });
});
```

Concrete fake wiring must mirror the existing test file's helpers — read the top of `generation.service.test.ts` first and reuse its registry/repo fake builders; the assertions above are the contract.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/services/generation.service.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement in `lib/services/generation.service.ts`**

1. `ValidatedRequest` gains `startImageRef: string | null; endImageRef: string | null;` and `validateGenerationRequest` validates them:

```ts
function validateFrameRef(value: unknown, field: "startImage" | "endImage"): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (!isValidMediaRef(value) || value.endsWith(".mp4")) {
    throw new GenerationServiceError("That continuity frame reference is not valid.", { field });
  }
  return value;
}
```

(append to the return object:)

```ts
    startImageRef: validateFrameRef(body.startImageRef, "startImage"),
    endImageRef: validateFrameRef(body.endImageRef, "endImage"),
```

(import `isValidMediaRef` from `@/lib/repositories/media.repository`.)

2. Frame loading helper:

```ts
async function loadFrame(ref: string, field: "startImage" | "endImage"): Promise<FrameImage> {
  const stored = await getMediaRepository().get(ref);
  if (!stored) {
    throw new GenerationServiceError(
      field === "startImage"
        ? "Continuity frame missing. Re-generate the previous scene or turn Continuity off."
        : "That end frame is no longer cached. Upload it again.",
      { field },
    );
  }
  return { bytes: stored.bytes, contentType: stored.contentType };
}
```

3. In `runGeneration`, after `resolved` is computed, replace the fixed `normalized` construction with resolve-swap-normalize:

```ts
  const startImage = request.startImageRef ? await loadFrame(request.startImageRef, "startImage") : undefined;
  const endImageRaw = request.endImageRef ? await loadFrame(request.endImageRef, "endImage") : undefined;

  // Frame capability: keep the model, swap to its i2v sibling, or drop frames.
  let effective = resolved;
  let swapped = false;
  if (startImage && !resolved.model.frameInput?.start) {
    const swapId = resolved.model.i2vModelId;
    const swappedModel = swapId ? registry.resolve(swapId) : null;
    if (swappedModel?.model.frameInput?.start) {
      effective = swappedModel;
      swapped = true;
      log.info("frame capability swap", { from: resolved.model.id, to: effective.model.id });
    } else {
      log.warn("start frame provided but no capable model available — dropping frames", {
        model: resolved.model.id,
      });
    }
  }
  const endImage =
    endImageRaw && effective.model.frameInput?.end ? endImageRaw : undefined;
  if (endImageRaw && !endImage) {
    log.warn("end frame dropped — model cannot condition on a final frame", {
      model: effective.model.id,
    });
  }
  const framesActive = Boolean(startImage) && effective.model.frameInput?.start === true;

  const normalized: NormalizedGenerationRequest = {
    // ...existing fields, but resolved.* → effective.*:
    prompt:
      effective.model.stylesSupported === false
        ? request.rawPrompt
        : styleWithPrompt(request.rawPrompt, request.style),
    // negativePrompt/aspect/resolution/duration/count/seed as today
    safe: effective.model.uncensored === false ? true : request.safe,
    enhance: request.enhance,
    startImage: framesActive ? startImage : undefined,
    endImage,
  };
```

4. Call the provider via `effective` (both the `generateVideo`/`generateImage` dispatch and the ctx logger's provider/model fields).

5. Response surface:

```ts
    const frameUsed = framesActive && artifacts[0]?.frameDropped !== true;
    return {
      requestId,
      status: "completed",
      kind: request.kind,
      elapsedMs,
      ...(artifacts[0]?.prewarmed === undefined ? {} : { prewarmed: artifacts[0].prewarmed }),
      ...(swapped ? { effectiveModelId: effective.model.id, effectiveModelLabel: effective.model.label } : {}),
      ...(startImage ? { frameUsed } : {}),
      media,
    };
```

- [ ] **Step 4: Run service tests to verify they pass**

Run: `npx vitest run lib/services/generation.service.test.ts`
Expected: PASS (existing tests too — they send no refs, so frames are undefined and `frameUsed` is absent).

- [ ] **Step 5: Commit**

```bash
git add lib/services/generation.service.ts lib/services/generation.service.test.ts
git commit -m "feat(service): continuity frame validation, i2v auto-swap, end-frame gating, frameUsed"
```

---

### Task 6: Sogni adapter — frames in, last frame out

**Files:**
- Modify: `lib/providers/sogni/request-maps.ts`, `lib/providers/sogni/client.ts`, `lib/providers/sogni/sogni.provider.ts`, `lib/providers/types.ts`, `lib/services/generation.service.ts`
- Test: `lib/providers/sogni/request-maps.test.ts`, `lib/providers/sogni/sogni.provider.test.ts`

- [ ] **Step 1: Write failing request-map tests (append to `request-maps.test.ts`)**

```ts
import type { FrameImage } from "@/lib/domain/models";

const FRAME: FrameImage = { bytes: Buffer.from("frame-bytes"), contentType: "image/png" };

it("video params carry referenceImage and referenceImageEnd", () => {
  const params = toVideoParams("wan_v2.2-14b-fp8_i2v_lightx2v", videoRequest({
    startImage: FRAME,
    endImage: FRAME,
  }));
  expect(params.referenceImage).toBe(FRAME.bytes);
  expect(params.referenceImageEnd).toBe(FRAME.bytes);
});

it("video params omit frames when absent", () => {
  const params = toVideoParams("wan_v2.2-14b-fp8_t2v_lightx2v", videoRequest());
  expect(params.referenceImage).toBeUndefined();
  expect(params.referenceImageEnd).toBeUndefined();
  expect(params.returnLastFrame).toBeUndefined();
});

it("seedance 2.5 asks for the exact last frame", () => {
  const params = toVideoParams("seedance-2-5", videoRequest());
  expect(params.returnLastFrame).toBe(true);
});

it("image params carry startingImage", () => {
  const params = toImageParams("krea2_turbo_fp8_scaled", imageRequest({ startImage: FRAME }));
  expect(params.startingImage).toBe(FRAME.bytes);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/providers/sogni/request-maps.test.ts`
Expected: FAIL — fields don't exist.

- [ ] **Step 3: Implement in `request-maps.ts`**

Extend both param interfaces:

```ts
export interface SogniImageParams {
  // ...existing...
  /** Img2img source (Buffer → SDK presigns an upload automatically). */
  startingImage?: Buffer;
}
export interface SogniVideoParams {
  // ...existing...
  referenceImage?: Buffer;
  referenceImageEnd?: Buffer;
  /** Seedance 2.5: export the exact final frame (job.lastFrameUrl). */
  returnLastFrame?: boolean;
}
```

In `toImageParams` add `...(request.startImage ? { startingImage: request.startImage.bytes } : {})`, in `toVideoParams` add:

```ts
    ...(request.startImage ? { referenceImage: request.startImage.bytes } : {}),
    ...(request.endImage ? { referenceImageEnd: request.endImage.bytes } : {}),
    ...(model.startsWith("seedance-2-5") ? { returnLastFrame: true } : {}),
```

- [ ] **Step 4: Artifact contract in `lib/providers/types.ts`**

Add to `GeneratedArtifact`:

```ts
  /** Provider-exported companion image (e.g. Sogni's exact last frame);
   *  a hosted URL the service materializes into the media cache. */
  companionFrameUrl?: string | null;
```

- [ ] **Step 5: Client surface in `lib/providers/sogni/client.ts`**

```ts
export interface SogniProject {
  waitForCompletion(): Promise<string[]>;
  /** 0–100 as the provider-side jobs advance. */
  on(event: "progress", listener: (percent: number) => void): unknown;
  /** Per-job completion; `lastFrameUrl` is set when returnLastFrame was used. */
  on(event: "jobCompleted", listener: (job: { lastFrameUrl?: string }) => void): unknown;
}
```

(The real SDK `Project` already emits `jobCompleted: Job` with a `lastFrameUrl` getter — no SDK change needed.)

- [ ] **Step 6: Provider captures the last frame (`sogni.provider.ts`)**

In `createProject`, register the listener right after `projects.create` and return it alongside urls — change the signature to `Promise<{ urls: string[]; lastFrameUrl: string | null }>`:

```ts
  const started = Date.now();
  const project = await client.projects.create(params);
  let lastFrameUrl: string | null = null;
  project.on("jobCompleted", (job) => {
    if (job.lastFrameUrl) lastFrameUrl = job.lastFrameUrl;
  });
```

Both `generateImage`/`generateVideo` pass it through to `toArtifacts(urls, ext, request, lastFrameUrl)`:

```ts
function toArtifacts(
  urls: string[],
  ext: string,
  request: NormalizedGenerationRequest,
  companionFrameUrl: string | null = null,
): GeneratedArtifact[] {
  // ...existing...
  return urls.map((url, index) => ({
    bytes: null,
    url,
    ext,
    seed: request.count === 1 ? baseSeed : baseSeed + index,
    ...(index === 0 && companionFrameUrl ? { companionFrameUrl } : {}),
  }));
}
```

- [ ] **Step 7: Service materializes the companion frame (`generation.service.ts`)**

Extract a byte-fetch helper (reuse in `materializeArtifact` if tidy) and extend `persistArtifacts`:

```ts
    if (materialized.bytes) {
      // ...existing StoredMedia path...
    }
    // URL-only artifacts (Pollinations) keep their provider URL...
    const endFrameUrl = await materializeCompanionFrame(materialized, log);
    return {
      id: `m_${materialized.seed.toString(36)}_${index}`,
      url: materialized.url as string,
      width, height,
      seed: materialized.seed,
      mime: mimeForExt(materialized.ext),
      ...(endFrameUrl ? { endFrameUrl } : {}),
    } satisfies GeneratedMedia;
```

```ts
/** Fetch + cache a provider-exported companion image (exact last frame). */
async function materializeCompanionFrame(
  artifact: GeneratedArtifact,
  log: Logger,
): Promise<string | undefined> {
  const url = artifact.companionFrameUrl;
  if (!url) return undefined;
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const stored = await getMediaRepository().put(bytes);
    return `/api/media?f=${stored.ref}`;
  } catch (error) {
    // The clip itself is fine; chaining falls back to client-side extraction.
    log.warn("companion frame could not be cached", { error });
    return undefined;
  }
}
```

Also call it on the bytes path (the `if (materialized.bytes)` branch) so mp4-with-companion still gets `endFrameUrl`.

- [ ] **Step 8: Provider-level test (append to `sogni.provider.test.ts`)**

Mirror the file's fake-client pattern; assert that when the fake project emits `jobCompleted` with `lastFrameUrl` before `waitForCompletion` resolves, the first artifact carries `companionFrameUrl`, and that `toVideoParams` received `referenceImage` when the request has `startImage` (the fake client records its params).

- [ ] **Step 9: Run tests**

Run: `npx vitest run lib/providers/sogni lib/services/generation.service.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add lib/providers/sogni lib/providers/types.ts lib/services/generation.service.ts
git commit -m "feat(sogni): referenceImage/referenceImageEnd/startingImage + exact lastFrame export"
```

---

### Task 7: apikey.fan adapter — image.url video frames + /images/edits, Pollinations drop flag

**Files:**
- Modify: `lib/providers/apikey-fan/request-maps.ts`, `lib/providers/apikey-fan/apikey-fan.provider.ts`, `lib/providers/pollinations/pollinations.provider.ts`
- Test: `lib/providers/apikey-fan/request-maps.test.ts`, `lib/providers/apikey-fan/apikey-fan.provider.test.ts`

- [ ] **Step 1: Failing request-map tests (append)**

```ts
import { frameToDataUri, toImageEditsPayload, toVideoPayload } from "@/lib/providers/apikey-fan/request-maps";
import type { FrameImage } from "@/lib/domain/models";

const FRAME: FrameImage = { bytes: Buffer.from("abc"), contentType: "image/png" };

it("video payload embeds the start frame as a data URI", () => {
  const payload = toVideoPayload("grok-imagine-video", {
    prompt: "p", durationSeconds: 5, image: FRAME,
  });
  expect(payload.image).toEqual({ url: `data:image/png;base64,${FRAME.bytes.toString("base64")}` });
});

it("video payload omits image when absent", () => {
  expect(toVideoPayload("grok-imagine-video", { prompt: "p", durationSeconds: 5 }).image).toBeUndefined();
});

it("edits payload references the source image", () => {
  const payload = toImageEditsPayload("grok-imagine-image-2.0", { prompt: "p", image: FRAME, count: 1 });
  expect(payload.image).toEqual({
    url: `data:image/png;base64,${FRAME.bytes.toString("base64")}`,
    type: "image_url",
  });
  expect(payload.n).toBe(1);
});

it("frameToDataUri builds a mime-correct data URI", () => {
  expect(frameToDataUri({ bytes: Buffer.from("x"), contentType: "image/webp" })).toBe(
    `data:image/webp;base64,${Buffer.from("x").toString("base64")}`,
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/providers/apikey-fan/request-maps.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `request-maps.ts`**

```ts
import type { FrameImage } from "@/lib/domain/models";

export function frameToDataUri(image: FrameImage): string {
  return `data:${image.contentType};base64,${image.bytes.toString("base64")}`;
}

export interface VideoPayloadRequest {
  prompt: string;
  durationSeconds: number;
  /** Start frame (image-to-video); sent as `image: { url }`. */
  image?: FrameImage;
}

export function toVideoPayload(model: string, request: VideoPayloadRequest) {
  return {
    model,
    prompt: request.prompt,
    duration: Math.min(MAX_VIDEO_SECONDS, Math.max(1, Math.round(request.durationSeconds))),
    ...(request.image ? { image: { url: frameToDataUri(request.image) } } : {}),
  };
}

/** Grok img2img — /v1/images/edits accepts a data URI or public URL. */
export function toImageEditsPayload(
  model: string,
  request: { prompt: string; image: FrameImage; count: number },
) {
  return {
    model,
    prompt: request.prompt,
    n: Math.min(10, Math.max(1, request.count)),
    response_format: "b64_json",
    image: { url: frameToDataUri(request.image), type: "image_url" },
  };
}
```

- [ ] **Step 4: Provider changes (`apikey-fan.provider.ts`)**

`generateImage` — route to edits when a start frame is present, with the same adaptive 400 fallback (edits → plain generations without the frame):

```ts
    const prompt = foldNegativePrompt(request.prompt, request.negativePrompt);
    let data: ImageResponse;
    let frameDropped = false;
    if (request.startImage) {
      try {
        data = await client.postJson<ImageResponse>(
          "/images/edits",
          toImageEditsPayload(model.model, { prompt, image: request.startImage, count: request.count }),
          { logger: ctx.logger, signal: ctx.signal },
        );
      } catch (error) {
        if (error instanceof ProviderError && error.status === 400) {
          ctx.logger.warn("images/edits rejected the frame — retrying prompt-only");
          frameDropped = true;
          data = await generatePlain();
        } else throw error;
      }
    } else {
      data = await generatePlain();
    }
```

where `generatePlain()` is the existing `/images/generations` call (with the existing `image_config` retry kept intact). Each returned artifact gains `...(frameDropped ? { frameDropped: true } : {})`.

`generateVideo` — pass the frame and fall back adaptively:

```ts
      const image = request.startImage;
      let created: VideoCreateResponse;
      let frameDropped = false;
      try {
        created = await client.postJson<VideoCreateResponse>(
          "/videos/generations",
          toVideoPayload(model.model, {
            prompt: foldNegativePrompt(request.prompt, request.negativePrompt),
            durationSeconds: request.durationSeconds,
            ...(image ? { image } : {}),
          }),
          { logger: log, signal: ctx.signal, timeoutMs: 90_000, retries: 1 },
        );
      } catch (error) {
        if (image && error instanceof ProviderError && error.status === 400) {
          // The relay may not forward Grok's image field — degrade cleanly.
          log.warn("video create rejected the image field — retrying prompt-only");
          frameDropped = true;
          created = await client.postJson<VideoCreateResponse>(
            "/videos/generations",
            toVideoPayload(model.model, {
              prompt: foldNegativePrompt(request.prompt, request.negativePrompt),
              durationSeconds: request.durationSeconds,
            }),
            { logger: log, signal: ctx.signal, timeoutMs: 90_000, retries: 1 },
          );
        } else throw error;
      }
```

and tag the pushed artifact with `...(frameDropped ? { frameDropped: true } : {})`.

- [ ] **Step 5: Pollinations drop flag (`pollinations.provider.ts`)**

In `buildArtifacts`, each artifact gains:

```ts
      ...(request.startImage ? { frameDropped: true } : {}),
```

- [ ] **Step 6: Provider test**

Extend `apikey-fan.provider.test.ts` (mirror its fake `fetch`/client pattern): a 400 on the first `/videos/generations` POST with an image payload results in a second POST without `image`, and the artifact carries `frameDropped: true`. Same shape of test for `/images/edits` → `/images/generations`.

- [ ] **Step 7: Suite + commit**

Run: `npm run typecheck && npm test`
Expected: green.

```bash
git add lib/providers/apikey-fan lib/providers/pollinations/pollinations.provider.ts
git commit -m "feat(apikey-fan): grok image-to-video/image edits with adaptive frame fallback"
```

---

### Task 8: Client plumbing — request refs + frame utilities

**Files:**
- Modify: `lib/generation.ts`
- Create: `lib/media/frame.ts`
- Test: `lib/media/frame.test.ts` (pure parts)

- [ ] **Step 1: `lib/generation.ts` — accept refs**

`GenerateInput` gains:

```ts
  /** Media-cache refs for continuity frames (story mode). */
  startImageRef?: string;
  endImageRef?: string;
```

and the POST body gains:

```ts
        ...(startImageRef ? { startImageRef } : {}),
        ...(endImageRef ? { endImageRef } : {}),
```

(destructure them from the input object alongside `prompt`.)

- [ ] **Step 2: Create `lib/media/frame.ts`**

```ts
"use client";

/**
 * Client-side continuity-frame plumbing: derive the final frame of a video
 * in-browser (canvas seek — our media URLs are same-origin, so the canvas
 * stays untainted), upload frames to the media cache, and parse cache refs
 * back out of media URLs.
 */

export function refFromMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, "http://perabyte.invalid").searchParams.get("f");
  } catch {
    return null;
  }
}

/** Upload an image blob to the media cache; resolves to its cache ref. */
export async function uploadFrameRef(blob: Blob): Promise<string> {
  const response = await fetch("/api/media", {
    method: "POST",
    headers: { "content-type": blob.type || "image/jpeg" },
    body: blob,
  });
  const body = (await response.json().catch(() => ({}))) as { ref?: string; error?: string };
  if (!response.ok || !body.ref) {
    throw new Error(body.error ?? "That frame could not be uploaded. Please retry.");
  }
  return body.ref;
}

/** Seek a video to (just before) its end and grab the frame as a JPEG blob. */
export async function extractLastFrame(videoUrl: string): Promise<Blob> {
  const video = document.createElement("video");
  video.muted = true;
  video.src = videoUrl;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("The video could not be read for frame extraction."));
  });
  await new Promise<void>((resolve, reject) => {
    video.onseeked = () => resolve();
    video.onerror = () => reject(new Error("The video could not be read for frame extraction."));
    video.currentTime = Math.max(0, (video.duration || 0) - 0.05);
  });
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser could not capture the video frame.");
  context.drawImage(video, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((result) => resolve(result), "image/jpeg", 0.92),
  );
  if (!blob) throw new Error("Your browser could not capture the video frame.");
  return blob;
}
```

- [ ] **Step 3: Test the pure parts (`lib/media/frame.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { refFromMediaUrl } from "@/lib/media/frame";

describe("refFromMediaUrl", () => {
  it("parses cache refs from media URLs", () => {
    expect(refFromMediaUrl("/api/media?f=abc.png")).toBe("abc.png");
    expect(refFromMediaUrl("https://app.test/api/media?f=a.jpg&download=1")).toBe("a.jpg");
  });
  it("returns null for provider URLs and empties", () => {
    expect(refFromMediaUrl("https://image.pollinations.ai/prompt/x")).toBeNull();
    expect(refFromMediaUrl(null)).toBeNull();
    expect(refFromMediaUrl("")).toBeNull();
  });
});
```

Run: `npx vitest run lib/media/frame.test.ts` — expected PASS (this file is new; write test first, then the module, then run).

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`
Expected: green.

```bash
git add lib/generation.ts lib/media/frame.ts lib/media/frame.test.ts
git commit -m "feat(media): client frame utilities (ref parse, upload, canvas last-frame extraction)"
```

---

### Task 9: Story conversion core (pure)

**Files:**
- Create: `lib/story/convert.ts`
- Test: `lib/story/convert.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { buildClipScenes, resolveEndCapableModel } from "@/lib/story/convert";

describe("buildClipScenes", () => {
  const sources = [
    { sceneId: "s1", prompt: "a fox at dawn", ref: "a.png" },
    { sceneId: "s2", prompt: "the fox runs", ref: "b.png" },
    { sceneId: "s3", prompt: "sunset", ref: "c.png" },
  ];

  it("produces N-1 clips with paired start/end refs", () => {
    const clips = buildClipScenes(sources);
    expect(clips).toHaveLength(2);
    expect(clips[0].startImageRef).toBe("a.png");
    expect(clips[0].endImageRef).toBe("b.png");
    expect(clips[1].startImageRef).toBe("b.png");
    expect(clips[1].endImageRef).toBe("c.png");
    expect(clips.every((c) => c.status === "queued")).toBe(true);
    expect(clips.every((c) => c.kind === "video")).toBe(true);
  });

  it("gives fewer than two sources zero clips", () => {
    expect(buildClipScenes(sources.slice(0, 1))).toEqual([]);
  });

  it("keeps prompts short and motion-focused", () => {
    const clips = buildClipScenes(sources);
    expect(clips[0].prompt.length).toBeLessThanOrEqual(240);
    expect(clips[0].prompt).toContain("the fox runs");
  });
});

describe("resolveEndCapableModel", () => {
  const available = ["sogni:minimax-h3-fl2va-fp8_i2v_turbo", "sogni:ltx23-22b-fp8_i2v_distilled"];
  const capable = new Set(["sogni:ltx23-22b-fp8_i2v_distilled"]);

  it("keeps the user's model when it can condition on an end frame", () => {
    expect(resolveEndCapableModel("sogni:ltx23-22b-fp8_i2v_distilled", capable, available)).toBe(
      "sogni:ltx23-22b-fp8_i2v_distilled",
    );
  });

  it("falls back through the preference list", () => {
    expect(resolveEndCapableModel(undefined, capable, available)).toBe(
      "sogni:ltx23-22b-fp8_i2v_distilled",
    );
  });

  it("returns null when nothing end-capable is available", () => {
    expect(resolveEndCapableModel("pollinations:flux-keyframe", capable, [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/story/convert.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/story/convert.ts`**

```ts
import type { StoryScene } from "@/lib/types";

/**
 * Image-story → video-story conversion (spec §9): consecutive images become
 * first/last-frame pairs — clip i animates image i into image i+1.
 */

export interface ConvertSource {
  sceneId: string;
  prompt: string;
  ref: string;
}

/** End-capable preference order (Sogni-native first — see docs/sogni-api-guide.md §5). */
export const END_CAPABLE_MODEL_PREFERENCE = [
  "sogni:ltx23-22b-fp8_i2v_distilled",
  "sogni:minimax-h3-fl2va-fp8_i2v_turbo",
  "sogni:seedance-2-5",
  "sogni:minimax-h3-fl2va-fp8_flf2v_turbo",
];

let clipCounter = 0;

function clipId(): string {
  clipCounter += 1;
  return `clip_${Date.now().toString(36)}_${clipCounter.toString(36)}`;
}

function motionPrompt(from: string, to: string): string {
  const budget = 240 - to.length - 4;
  const from_ = from.slice(0, Math.max(40, budget));
  return `${from_} → ${to}`.slice(0, 240);
}

export function buildClipScenes(sources: ConvertSource[]): StoryScene[] {
  const clips: StoryScene[] = [];
  for (let i = 0; i + 1 < sources.length; i += 1) {
    clips.push({
      id: clipId(),
      prompt: motionPrompt(sources[i].prompt, sources[i + 1].prompt),
      url: null,
      status: "queued",
      kind: "video",
      startImageRef: sources[i].ref,
      endImageRef: sources[i + 1].ref,
    });
  }
  return clips;
}

/**
 * The model for a conversion: the user's pick when end-capable, else the first
 * preference present in the end-capable set, else null (button should not
 * have been offered).
 */
export function resolveEndCapableModel(
  selected: string | undefined,
  endCapableIds: Set<string>,
  availableIds: string[],
): string | null {
  if (selected && endCapableIds.has(selected)) return selected;
  for (const candidate of END_CAPABLE_MODEL_PREFERENCE) {
    if (endCapableIds.has(candidate) && availableIds.includes(candidate)) return candidate;
  }
  return null;
}
```

- [ ] **Step 4: Run to verify pass + commit**

Run: `npx vitest run lib/story/convert.test.ts`
Expected: PASS.

```bash
git add lib/story/convert.ts lib/story/convert.test.ts
git commit -m "feat(story): conversion core — clip pair derivation + end-capable model resolution"
```

---

### Task 10: Story queue runner (persistent, DI-testable)

**Files:**
- Modify: `lib/store.ts` (scene update helper)
- Create: `lib/story/runner.ts`
- Test: `lib/story/runner.test.ts`

- [ ] **Step 1: Store helper in `lib/store.ts`**

```ts
/** Functional scene update for a story asset (the queue's write path). */
export function updateStoryScenes(
  storyId: string,
  updater: (scenes: StoryScene[]) => StoryScene[],
): void {
  persist(
    read().map((asset) =>
      asset.id === storyId && asset.scenes
        ? { ...asset, scenes: updater(asset.scenes) }
        : asset,
    ),
  );
}

/** Non-functional patch passthrough for story meta/settings. */
export function updateStoryMeta(storyId: string, patch: Partial<Asset>): void {
  updateAsset(storyId, patch);
}
```

(import `StoryScene` type.)

- [ ] **Step 2: Write failing runner tests (`lib/story/runner.test.ts`)**

The runner is created through a factory with injected deps so tests never touch localStorage or the network:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStoryRunner, type StoryRunnerDeps } from "@/lib/story/runner";
import type { Asset, StoryScene } from "@/lib/types";

function scene(partial: Partial<StoryScene> & { id: string }): StoryScene {
  return { prompt: "p", url: null, status: "queued", kind: "image", ...partial };
}

function story(scenes: StoryScene[], meta: Record<string, unknown> = {}): Asset {
  return {
    id: "story1",
    kind: "image",
    title: "t",
    prompt: "p",
    url: "",
    variants: [],
    settings: {
      kind: "image", aspect: "16:9", resolution: "1080p", style: "Realistic",
      duration: "5s", count: 1, seed: "", negativePrompt: "", enhance: true, safe: true,
    },
    createdAt: 0,
    favorite: false,
    mode: "Story Mode",
    scenes,
    meta,
  } as unknown as Asset;
}

function makeDeps() {
  const assets = new Map<string, Asset>();
  const deps: StoryRunnerDeps & { assets: Map<string, Asset> } = {
    assets,
    getStory: (id) => assets.get(id),
    updateStoryScenes: (id, updater) => {
      const asset = assets.get(id);
      if (asset?.scenes) assets.set(id, { ...asset, scenes: updater(asset.scenes) });
    },
    requestGeneration: vi.fn(async ({ startImageRef }: { startImageRef?: string }) => ({
      requestId: "r", status: "completed", kind: "image", elapsedMs: 1,
      frameUsed: Boolean(startImageRef),
      media: [{ id: "m", url: "/api/media?f=new.png", width: 8, height: 8, seed: 1 }],
    })),
    uploadFrameRef: vi.fn(async () => "new.png"),
    extractLastFrame: vi.fn(async () => new Blob(["frame"], { type: "image/jpeg" })),
    refFromMediaUrl: (url: string | null | undefined) =>
      url ? (new URL(url, "http://x.invalid").searchParams.get("f")) : null,
    onNotice: vi.fn(),
  };
  return deps;
}

beforeEach(() => vi.resetModules());

describe("story runner scheduling", () => {
  it("renders continuation scenes sequentially with chained start refs", async () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([
      scene({ id: "s1", status: "completed", url: "/api/media?f=a.png", kind: "image" }),
      scene({ id: "s2" }),
      scene({ id: "s3" }),
    ], { continuity: true }));
    // s1 completed but has no endFrameRef yet (generated pre-feature) — the
    // runner derives it from the image URL on first schedule.
    runner.start("story1");
    await vi.waitFor(() => {
      expect(deps.requestGeneration).toHaveBeenCalledTimes(1);
      const scenes = deps.assets.get("story1")!.scenes!;
      expect(scenes[1].status).toBe("completed");
    });
    expect(deps.requestGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ startImageRef: "a.png" }),
    );
    await vi.waitFor(() => {
      expect(deps.requestGeneration).toHaveBeenCalledTimes(2);
      expect(deps.assets.get("story1")!.scenes![2].status).toBe("completed");
    });
  });

  it("renders independent scenes in parallel when continuity is off", async () => {
    const deps = makeDeps();
    let resolveFirst!: () => void;
    deps.requestGeneration = vi.fn(
      () => new Promise((resolve) => { resolveFirst = () => resolve({ requestId: "r", status: "completed", kind: "image", elapsedMs: 1, media: [{ id: "m", url: "/api/media?f=x.png", width: 8, height: 8, seed: 1 }] }); }),
    ) as never;
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([scene({ id: "s1" }), scene({ id: "s2" })], { continuity: false }));
    runner.start("story1");
    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(2));
    resolveFirst();
  });

  it("parallelizes conversion clips that carry explicit start refs", async () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([
      scene({ id: "c1", kind: "video", startImageRef: "a.png", endImageRef: "b.png" }),
      scene({ id: "c2", kind: "video", startImageRef: "b.png", endImageRef: "c.png" }),
    ], { continuity: true }));
    runner.start("story1");
    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(2));
  });

  it("marks dependents blocked when a predecessor fails and resumes on retry", async () => {
    const deps = makeDeps();
    deps.requestGeneration = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ requestId: "r", status: "completed", kind: "image", elapsedMs: 1, media: [{ id: "m", url: "/api/media?f=b.png", width: 8, height: 8, seed: 1 }] }) as never;
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([scene({ id: "s1" }), scene({ id: "s2" })], { continuity: true }));
    runner.start("story1");
    await vi.waitFor(() => {
      const scenes = deps.assets.get("story1")!.scenes!;
      expect(scenes[0].status).toBe("failed");
      expect(scenes[1].status).toBe("queued"); // waiting, not failed
    });
    expect(deps.onNotice).toHaveBeenCalled();
    runner.start("story1"); // user retries — s1 re-runs, then s2 chains
    await vi.waitFor(() => {
      const scenes = deps.assets.get("story1")!.scenes!;
      expect(scenes[0].status).toBe("completed");
      expect(scenes[1].status).toBe("completed");
    });
  });

  it("cancel aborts in-flight work and requeues generating scenes", async () => {
    const deps = makeDeps();
    deps.requestGeneration = vi.fn(
      (_input: never, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ) as never;
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([scene({ id: "s1" })], { continuity: true }));
    runner.start("story1");
    await vi.waitFor(() => expect(deps.assets.get("story1")!.scenes![0].status).toBe("generating"));
    runner.cancel("story1");
    await vi.waitFor(() => {
      expect(deps.assets.get("story1")!.scenes![0].status).toBe("queued");
    });
  });
});
```

(Adjust assertion details to the exact exported API you implement — the contract is: `createStoryRunner(deps)` → `{ start, cancel, rehydrate }`.)

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run lib/story/runner.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `lib/story/runner.ts`**

```ts
"use client";

import type { GenerationProgress } from "@/lib/generation";
import type { Asset, GenerationResponse, StoryScene } from "@/lib/types";

/**
 * Story queue runner (spec §5). The persisted story asset IS the queue; this
 * module owns execution. Dependency-injected for tests — the app binds the
 * real store/services in `appRunner` below.
 */

export interface StoryRunnerDeps {
  getStory(id: string): Asset | undefined;
  updateStoryScenes(id: string, updater: (scenes: StoryScene[]) => StoryScene[]): void;
  requestGeneration(input: {
    settings: Asset["settings"];
    prompt: string;
    startImageRef?: string;
    endImageRef?: string;
    signal?: AbortSignal;
  }): Promise<GenerationResponse>;
  uploadFrameRef(blob: Blob): Promise<string>;
  extractLastFrame(videoUrl: string): Promise<Blob>;
  refFromMediaUrl(url: string | null | undefined): string | null;
  onNotice?(message: string, tone?: "info" | "error"): void;
}

interface ActiveStory {
  controllers: Set<AbortController>;
}

export function createStoryRunner(deps: StoryRunnerDeps) {
  const active = new Map<string, ActiveStory>();

  function patch(storyId: string, sceneId: string, patch: Partial<StoryScene>) {
    deps.updateStoryScenes(storyId, (scenes) =>
      scenes.map((scene) => (scene.id === sceneId ? { ...scene, ...patch } : scene)),
    );
  }

  function continuityOn(story: Asset): boolean {
    return story.meta?.continuity !== false;
  }

  /** A scene runs now when it has an explicit ref, is first, or its
   *  predecessor finished with a derived frame. */
  function isRunnable(scenes: StoryScene[], index: number, chained: boolean): boolean {
    const scene = scenes[index];
    if (scene.status !== "queued") return false;
    if (scene.startImageRef) return true; // manual/converted ref: independent
    if (index === 0) return true;
    if (!chained) return true;
    const prev = scenes[index - 1];
    return prev.status === "completed" && Boolean(prev.endFrameRef);
  }

  function schedule(storyId: string) {
    const entry = active.get(storyId);
    if (!entry) return;
    const story = deps.getStory(storyId);
    if (!story || !story.scenes?.length) return;

    const chained = continuityOn(story);
    const scenes = story.scenes;
    const chainCapacity = chained ? 1 : Infinity;
    const chainInFlight = scenes.filter(
      (s) => s.status === "generating" && !s.startImageRef,
    ).length;
    let used = chainInFlight;

    for (let index = 0; index < scenes.length; index += 1) {
      if (!isRunnable(scenes, index, chained)) continue;
      const scene = scenes[index];
      const isChainScene = !scene.startImageRef;
      if (isChainScene && used >= chainCapacity) continue;
      if (isChainScene) used += 1;
      void runScene(storyId, story, scene, index, entry);
    }
  }

  async function runScene(
    storyId: string,
    story: Asset,
    scene: StoryScene,
    index: number,
    entry: ActiveStory,
  ) {
    const controller = new AbortController();
    entry.controllers.add(controller);
    patch(storyId, scene.id, { status: "generating", error: undefined });
    try {
      const scenes = deps.getStory(storyId)?.scenes ?? [];
      const predecessor = scene.startImageRef ? undefined : scenes[index - 1];
      const startRef = scene.startImageRef ?? predecessor?.endFrameRef;
      const response = await deps.requestGeneration({
        settings: { ...story.settings, kind: scene.kind },
        prompt: scene.prompt,
        ...(startRef ? { startImageRef: startRef } : {}),
        ...(scene.endImageRef ? { endImageRef: scene.endImageRef } : {}),
        signal: controller.signal,
      });

      const endFrameRef = await deriveEndFrameRef(response, scene);
      patch(storyId, scene.id, {
        url: response.media[0]?.url ?? null,
        status: "completed",
        effectiveModelId: response.effectiveModelId,
        frameUsed: response.frameUsed,
        ...(endFrameRef ? { endFrameRef } : {}),
      });
    } catch (error) {
      if ((error as Error)?.name === "AbortError" || controller.signal.aborted) {
        patch(storyId, scene.id, { status: "queued" });
        entry.controllers.delete(controller);
        return;
      }
      patch(storyId, scene.id, {
        status: "failed",
        error: (error as Error).message ?? "Scene generation failed.",
      });
      deps.onNotice?.((error as Error).message ?? "Scene generation failed.", "error");
    }
    entry.controllers.delete(controller);
    schedule(storyId); // advance the chain / fill capacity
  }

  async function deriveEndFrameRef(
    response: GenerationResponse,
    scene: StoryScene,
  ): Promise<string | undefined> {
    const media = response.media[0];
    if (!media?.url) return undefined;
    // 1) Exact frame exported by the provider (Seedance 2.5).
    const exported = deps.refFromMediaUrl(media.endFrameUrl);
    if (exported) return exported;
    // 2) Image scenes ARE their end frame.
    if (scene.kind === "image") return deps.refFromMediaUrl(media.url) ?? undefined;
    // 3) Extract the video's final frame in-browser and cache it.
    try {
      const blob = await deps.extractLastFrame(media.url);
      return await deps.uploadFrameRef(blob);
    } catch (error) {
      deps.onNotice?.("Couldn't read the last frame — continuing without it.");
      return undefined;
    }
  }

  return {
    /** Idempotent: schedule (or resume) one story's queue. */
    start(storyId: string) {
      if (!active.has(storyId)) active.set(storyId, { controllers: new Set() });
      schedule(storyId);
    },
    /** Abort in-flight requests; queued scenes stay queued, generating requeue. */
    cancel(storyId: string) {
      const entry = active.get(storyId);
      if (!entry) return;
      for (const controller of entry.controllers) controller.abort();
      entry.controllers.clear();
      const story = deps.getStory(storyId);
      if (story?.scenes) {
        deps.updateStoryScenes(storyId, (scenes) =>
          scenes.map((scene) =>
            scene.status === "generating" ? { ...scene, status: "queued" as const } : scene,
          ),
        );
      }
    },
    /** Boot-time resume: flip orphaned generating scenes back to queued. */
    rehydrate(storyIds: string[]) {
      for (const id of storyIds) {
        const story = deps.getStory(id);
        if (!story?.scenes?.some((s) => s.status === "generating" || s.status === "queued")) continue;
        if (story.scenes.some((s) => s.status === "generating")) {
          deps.updateStoryScenes(id, (scenes) =>
            scenes.map((scene) =>
              scene.status === "generating" ? { ...scene, status: "queued" as const } : scene,
            ),
          );
        }
        // Only auto-resume stories that had work in flight when we left off.
        if (story.meta?.running === true) this.start(id);
      }
    },
  };
}
```

(The app binds `appRunner` at the bottom of the same file — real store + real services — and calls `appRunner.rehydrate(...)` from `StoreBootstrap`. `meta.running` is set to `true` on start/cancel-completion by the page; simplest: page sets `meta.running` when Generate/Convert is pressed and `false` when the queue drains. If that proves fiddly, rehydrate can resume any story with queued scenes — prefer explicit `meta.running`.)

- [ ] **Step 5: Run runner tests**

Run: `npx vitest run lib/story/runner.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite + commit**

Run: `npm run typecheck && npm test`
Expected: green.

```bash
git add lib/store.ts lib/story/runner.ts lib/story/runner.test.ts
git commit -m "feat(story): persistent queue runner — chained sequential / parallel scheduling, resume"
```

---

### Task 11: Story page — store-driven state, continuity toggle, ref chips, convert dialog

**Files:**
- Modify: `app/story/page.tsx` (rework)
- Create: `components/story/SceneRefChips.tsx`, `components/story/ConvertDialog.tsx`
- Modify: `components/StoreBootstrap.tsx` (call `rehydrate`)

- [ ] **Step 1: `SceneRefChips` (`components/story/SceneRefChips.tsx`)**

Small presentational component: two thumbnail chips ("Start frame", "End frame"). Props: `scene: StoryScene`, `endSupported: boolean`, `onChange(patch: Partial<StoryScene>)`, `disabled?: boolean`. Start chip hidden-when-set shows a dashed upload tile (Icon `image` + label); when set shows the thumbnail (`/api/media?f=<ref>`) + × button (clears `startImageRef`). End chip renders **only** when `endSupported`. Uploads via `uploadFrameRef(File)` after `accept="image/*"` file input (hidden input + label). Tests: none (GUI-verified); keep it dumb.

- [ ] **Step 2: `ConvertDialog` (`components/story/ConvertDialog.tsx`)**

Props: `clipCount: number`, `models: ModelOption[]` (end-capable list), `defaultModelId: string`, `onConfirm(modelId: string)`, `onClose()`. Renders a small absolutely-positioned sheet (match the app's rounded-white card idiom — reuse classes from `SettingsDialog`/`ui.tsx`): "Animate {clipCount} clip{s} · " + a `PillSelect` of models (value = chosen id) + a `Button` "Convert" + a ghost "Cancel". `useEffect` Escape handler closes. Local state `chosen` initialised to `defaultModelId`.

- [ ] **Step 3: Rework `app/story/page.tsx`**

Key changes (keep the existing workspace layout/classes):

1. **State from the store.** Keep local `kind`, `prompt`, `settings` as today. Replace local `scenes` with:

```ts
  const { assets } = useAssets();
  const story = storyId ? assets.find((a) => a.id === storyId) : undefined;
  const scenes = story?.scenes ?? [];
```

2. **Generate creates the asset up front** so the runner and page share state:

```ts
  async function handleGenerateAll() {
    // ...existing prompt validation...
    let draft: StoryScene[] = scenes.length
      ? [...scenes]
      : [{ id: "sc_1", prompt: prompt.trim(), url: null, status: "queued", kind }];
    const id =
      storyId ??
      `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const asset: Asset = {
      id, kind: "story", title: prompt.slice(0, 40) || "Untitled story",
      prompt, url: draft[0].url ?? "", variants: [],
      settings: currentSettings(), createdAt: Date.now(), favorite: false,
      mode: "Story Mode", scenes: draft,
      meta: { continuity: continuityOn, running: true, style: currentSettings().style },
    };
    addAsset(asset);
    setStoryId(id);
    appRunner.start(id);
  }
```

(`continuityOn` is local `useState(true)`; mirrored into `meta.continuity`.)

3. **Continuity toggle** next to "Add scene":

```tsx
          <button
            type="button"
            aria-pressed={continuityOn}
            onClick={() => {
              const next = !continuityOn;
              setContinuityOn(next);
              if (storyId) {
                updateAsset(storyId, { meta: { ...story?.meta, continuity: next, running: true } });
                appRunner.start(storyId); // re-schedule under the new rule
              }
            }}
            className={...pill classes, tint when on...}
          >
            <Icon name="link" size={13} /> Continuity: {continuityOn ? "On" : "Off"}
          </button>
```

4. **Scene tiles** — keep the existing grid; add:
   - blocked note: when continuity ON and scene is `queued`, not first, no `startImageRef`, and predecessor not completed → caption "Waiting for Scene {index}" under the skeleton.
   - `i2v` badge: when `scene.effectiveModelId` and `scene.effectiveModelId !== story.settings.modelId` → small badge "i2v" (title = effectiveModelId).
   - link icon on queued successor of a completed scene when continuity feeds it (non-essential; skip if noisy).
   - `<SceneRefChips>` under the caption for each scene with `endSupported={Boolean(catalog.models.find((m) => m.id === modelId)?.frameInput?.end)}`, `onChange={(patch) => storyId && updateStoryScenes(storyId, (list) => list.map((s) => (s.id === scene.id ? { ...s, ...patch } : s)))}`.

5. **Convert flow** in the footer (visible when `kind === "image"` and completed image scenes ≥ 2):

```tsx
  const completedRefs = scenes
    .filter((s) => s.status === "completed" && s.url)
    .map((s) => ({ sceneId: s.id, prompt: s.prompt, ref: refFromMediaUrl(s.url) }))
    .filter((s): s is typeof s & { ref: string } => Boolean(s.ref));
```

Click → open `ConvertDialog` with `clipCount = Math.max(0, completedRefs.length - 1)`, models from `useModelCatalog("video", "end")`, `defaultModelId` from `resolveEndCapableModel(modelId, endCapableIds, availableIds)`. On confirm:

```ts
  async function handleConvert(chosenModelId: string) {
    if (!completedRefs.length) return;
    // Normalize refs: Pollinations scenes have provider URLs — fetch via our
    // proxy and upload to the cache first.
    const sources = await Promise.all(
      completedRefs.map(async (source) =>
        source.ref
          ? source
          : { ...source, ref: await uploadFrameRef(await (await fetch(`/api/media?u=${encodeURIComponent(urlFor(source.sceneId))}`)).blob()) },
      ),
    );
```

(Implementation note: carry the original URL alongside the ref in the map so the proxy-fetch branch is direct — build `{sceneId, prompt, url, ref}` locally and normalize the ref-less ones.)

```ts
    const clips = buildClipScenes(sources);
    const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const asset: Asset = {
      id, kind: "story", title: `${(story?.title ?? "Story")} (video)`,
      prompt: story?.prompt ?? prompt, url: clips[0]?.startImageRef ? `/api/media?f=${clips[0].startImageRef}` : "",
      variants: [],
      settings: { ...currentSettings(), kind: "video", modelId: chosenModelId },
      createdAt: Date.now(), favorite: false, mode: "Story Mode",
      scenes: clips,
      meta: { continuity: true, running: true, convertedFrom: storyId ?? "" },
    };
    addAsset(asset);
    setStoryId(id);
    setKind("video");
    appRunner.start(id);
    toast.push(`Animating ${clips.length} clip${clips.length === 1 ? "" : "s"}…`, "success");
  }
```

6. **Footer buttons**: keep Download/Results/Start-over; add the Convert button; "Start over" additionally cancels the queue: `if (storyId) { appRunner.cancel(storyId); }` and clears `storyId`.

7. **Cancel button**: `onCancel={() => { if (storyId) appRunner.cancel(storyId); }}` and update `meta.running: false`.

8. **Rehydrate** in `components/StoreBootstrap.tsx`: after hydration, call `appRunner.rehydrate(assets.filter((a) => a.kind === "story").map((a) => a.id))` once.

- [ ] **Step 4: Typecheck + suite**

Run: `npm run typecheck && npm test`
Expected: green (page is untested by vitest; correctness is GUI-verified next).

- [ ] **Step 5: Commit**

```bash
git add app/story/page.tsx components/story components/StoreBootstrap.tsx
git commit -m "feat(story): store-driven queue UI — continuity toggle, frame chips, convert dialog"
```

---

### Task 12: GUI verification + live smoke

**Files:** none (verification only)

- [ ] **Step 1: Boot the dev server and probe**

Run: `npm run typecheck && npm test` (final gate), then start `npm run dev` (or reuse the live :3100 server — probe first).

- [ ] **Step 2: GUI pass with the browser tooling (screenshots at each step)**

1. Story image mode: generate 3 scenes with continuity ON → confirm sequential rendering, chained tiles, queue survives a page reload mid-run.
2. Toggle continuity OFF mid-run → remaining scenes render in parallel.
3. Manual start ref on scene 3 → it renders independent of scene 2.
4. Image story (3 done) → Convert to video → dialog shows end-capable models → confirm → clips render in parallel; original image story untouched in History.
5. i2v badge + "Waiting for Scene N" + end-frame slot visibility (only on end-capable model) all render.

- [ ] **Step 3: Live provider smoke**

1. Sogni: convert a 2-image story with `ltx23-22b-fp8_i2v_distilled` → verify the clip honours both frames and `frameUsed: true` lands in the stored scene.
2. Grok: solo video with a manual start ref → verify relay forwards `image.url` (data URI). If it 400s, verify the adaptive fallback produced a prompt-only clip + degradation note.
3. Seedance 2.5 (credits permitting): verify `endFrameUrl` appears on the media and the next chain skips extraction (log: no `uploadFrameRef` call).

- [ ] **Step 4: Commit any fixes; final gate**

```bash
git add -A && git commit -m "fix(story): GUI verification fixes from live pass"
```

Run: `npm run typecheck && npm test` — expected green before merge/PR.

---

## Self-review notes

- **Spec coverage:** §1 capability model → Tasks 1–3; §2 API contract → Tasks 4–5; §3 providers → Tasks 6–7; §4 frame plumbing → Task 8; §5 runner → Task 10; §6 UX → Task 11; §7 errors → covered in Tasks 5 (ref 400s), 8/10 (extraction skip), 7 (adaptive fallback); §8 testing → per-task tests + Task 12; §9 conversion → Tasks 9, 11.
- **Type consistency:** `FrameImage`/`ModelFrameInput` defined in Task 1 and consumed everywhere; `companionFrameUrl` (artifact) → `endFrameUrl` (media) naming held; runner deps names match the factory signature in its own task.
- **Deliberate simplifications:** `meta.running` gates rehydrate-resume (explicit over magic); conversion prompt wording fixed to `from → to` truncation (spec allowed final wording at implementation).
