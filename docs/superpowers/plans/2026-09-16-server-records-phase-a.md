# Server-Side Records (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all asset/story records from browser localStorage to server-side JSON repositories behind `/api/assets` + `/api/stories`, so stories are durable, cross-browser, and addressable via `/story?id=` — with zero changes to the `lib/store` public API that pages consume.

**Architecture:** Keep `lib/store.ts`'s exported API byte-identical; re-plumb its internals from localStorage to an injectable `StoreTransport` that syncs to the new API (optimistic local cache + fire-and-forget server writes). Server side: two thin JSON-file repositories (`.studio/assets.json`, `.studio/stories.json`) following the `provider-config.repository` pattern, an `assets.service` that merges/routes rows by kind, and thin route handlers. A one-time import bridge in `StoreBootstrap` migrates legacy `perabyte.assets.v2` rows. Media binaries stay untouched (media repository formalized as the `StorageBucket`).

**Tech Stack:** Next.js 16 App Router (nodejs runtime routes), TypeScript, vitest (node env, `lib/**/*.test.ts`), thin fs-backed JSON repositories.

**Spec:** `docs/superpowers/specs/2026-09-16-durable-jobs-and-story-management-design.md` (Phase A)

**Worktree:** all work happens in `.worktrees/feat/server-records` (branch `feat/server-records`), per the always-use-worktrees convention.

---

### Task 0: Worktree bootstrap

**Files:** none (environment setup)

- [ ] **Step 1: Create the worktree from master**

```bash
cd /Users/abid/Projects/perabyte-studio
git worktree add .worktrees/feat/server-records -b feat/server-records master
```

- [ ] **Step 2: Install deps + real env (worktrees don't share node_modules or .env.local)**

```bash
cd .worktrees/feat/server-records
cp /Users/abid/Projects/perabyte-studio/.env.local .env.local 2>/dev/null || true
npm install
npx vitest run 2>&1 | tail -5
```

Expected: all existing tests pass (green baseline before any change).

---

### Task 1: Extract server-safe demo content (`lib/demo-content.ts`)

Server repositories cannot import `lib/store.ts` ("use client", imports React). The demo seed data moves to a pure module; `lib/store.ts` re-exports it so `GeneratorScreen`'s import keeps working.

**Files:**
- Create: `lib/demo-content.ts`
- Modify: `lib/store.ts` (remove `DemoSpec`/`DEMO_SPECS`/`demoAsset`/`seedDemoContent` internals → re-export)
- Test: `lib/demo-content.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/demo-content.test.ts
import { describe, expect, it } from "vitest";
import { DEMO_SPECS, demoAsset } from "@/lib/demo-content";

describe("demo content", () => {
  it("defines the fixed example strip", () => {
    expect(DEMO_SPECS.length).toBeGreaterThanOrEqual(5);
    expect(DEMO_SPECS.every((s) => s.file.startsWith("/demo/"))).toBe(true);
  });

  it("builds story-free example assets from a spec", () => {
    const asset = demoAsset(DEMO_SPECS[0]);
    expect(asset.id).toMatch(/^demo_/);
    expect(asset.kind).toBe(DEMO_SPECS[0].kind);
    expect(asset.meta?.example).toBe(true);
    expect(asset.url).toBe(DEMO_SPECS[0].file);
    expect(asset.mode).toContain("Solo Mode");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/demo-content.test.ts`
Expected: FAIL — cannot find module `@/lib/demo-content`.

- [ ] **Step 3: Write the module — move the exact code out of `lib/store.ts` (lines from `export interface DemoSpec` through `seedDemoContent`'s body, minus the `window.localStorage` guard logic which stays out — the server repo owns seeding)**

```ts
// lib/demo-content.ts
import { DEFAULT_IMAGE_SETTINGS, DEFAULT_VIDEO_SETTINGS } from "@/lib/constants";
import type { Asset, GenerationSettings } from "@/lib/types";

const HOUR = 3_600_000;

export interface DemoSpec {
  title: string;
  prompt: string;
  kind: "image" | "video";
  aspect: "16:9" | "9:16" | "4:5" | "1:1" | "3:2";
  style: string;
  ageHours: number;
  seed: number;
  /** Pre-rendered example stored in /public/demo (see scripts/prerender_examples.py). */
  file: string;
}

/** Pre-rendered examples (see scripts/prerender_examples.py), also used by the
 * generator's "try an example" strip. Paste the existing DEMO_SPECS array here
 * verbatim from lib/store.ts (6 entries: mountain-lake … winter-village). */
export const DEMO_SPECS: DemoSpec[] = [
  /* … moved verbatim from lib/store.ts … */
];

export function demoAsset(spec: DemoSpec): Asset {
  const base = spec.kind === "video" ? DEFAULT_VIDEO_SETTINGS : DEFAULT_IMAGE_SETTINGS;
  const settings: GenerationSettings = {
    ...base,
    kind: spec.kind,
    aspect: spec.aspect,
    style: spec.style,
  };
  return {
    id: `demo_${spec.seed}`,
    kind: spec.kind,
    title: spec.title,
    prompt: spec.prompt,
    url: spec.file,
    variants: [spec.file],
    posterUrl: spec.file,
    settings,
    createdAt: Date.now() - spec.ageHours * HOUR,
    favorite: false,
    mode: spec.kind === "video" ? "Solo Mode (Video)" : "Solo Mode (Image)",
    meta: { example: true, seed: spec.seed },
  };
}

/** Merge the demo rows into an existing list, skipping known ids. */
export function withDemoRows(existing: Asset[]): Asset[] {
  const known = new Set(existing.map((a) => a.id));
  const additions = DEMO_SPECS.map(demoAsset).filter((a) => !known.has(a.id));
  if (!additions.length) return existing;
  return [...existing, ...additions].sort((a, b) => b.createdAt - a.createdAt);
}
```

- [ ] **Step 4: Rewire `lib/store.ts`** — delete the moved block, replace with:

```ts
export { DEMO_SPECS } from "./demo-content";
```

and rewrite `seedDemoContent` as a compatibility no-op (server owns seeding now; `StoreBootstrap` gets replaced in Task 8):

```ts
/**
 * Legacy hook: demo rows are now seeded server-side on first `/api/assets`
 * read. Kept as a no-op so existing imports keep working.
 */
export function seedDemoContent() {}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run lib/demo-content.test.ts lib/store.test.ts`
Expected: PASS (both).

- [ ] **Step 6: Commit**

```bash
git add lib/demo-content.ts lib/demo-content.test.ts lib/store.ts
git commit -m "refactor: extract server-safe demo content module"
```

---

### Task 2: StorageBucket formalization (`lib/storage/bucket.ts` + media repository extensions)

Formalize the existing content-addressed media cache as the disk impl of a `StorageBucket` (the spec's future cloud-bucket seam). `/api/media?f=` contract untouched.

**Files:**
- Create: `lib/storage/bucket.ts`
- Modify: `lib/repositories/media.repository.ts` (add `delete`/`stat`/`list` to interface + disk impl)
- Test: `lib/storage/bucket.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/storage/bucket.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { getBucket, type StorageBucket } from "@/lib/storage/bucket";
import { setMediaPathForTests } from "@/lib/repositories/media.repository";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bucket-"));
  setMediaPathForTests(tmp);
});

describe("storage bucket", () => {
  it("round-trips bytes and lists/stat/delete stored refs", async () => {
    const bucket: StorageBucket = getBucket();
    const stored = await bucket.put(Buffer.from("hello"), "txt");
    expect(stored.ref).toMatch(/\.txt$/);
    expect((await bucket.get(stored.ref))?.bytes.toString()).toBe("hello");
    expect(await bucket.stat(stored.ref)).toMatchObject({ size: 5 });
    expect((await bucket.list()).map((e) => e.ref)).toContain(stored.ref);
    await bucket.delete(stored.ref);
    expect(await bucket.get(stored.ref)).toBeNull();
    expect(await bucket.stat(stored.ref)).toBeNull();
  });
});
```

(Note: if `setMediaPathForTests` doesn't exist yet in media.repository, add it alongside — same `overridePath` pattern as `setAssetsPathForTests` in Task 3.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/storage/bucket.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** In `media.repository.ts`: add to the `MediaRepository` interface `stat(ref): Promise<{ ref; contentType; size } | null>`, `list(): Promise<{ ref; contentType; size }[]>`, `delete(ref): Promise<void>`; implement against the existing cache dir (fs.stat/readdir/unlink with `/*turbopackIgnore: true*/` comments on fs calls, matching the file's style; `contentTypeForRef` for content types; missing file → null/[]/noop). Add `setMediaPathForTests(p: string | null)` mirroring the provider-config override pattern.

```ts
// lib/storage/bucket.ts
import type { MediaRepository } from "@/lib/repositories/media.repository";
import { getMediaRepository } from "@/lib/repositories/media.repository";

/**
 * Storage abstraction for render binaries (the spec's "storage bucket").
 * The disk-backed media cache is the first implementation; an S3/R2 bucket
 * can replace it later without touching callers — the /api/media?f= serving
 * contract stays byte-identical.
 */
export type StorageBucket = MediaRepository;

export function getBucket(): StorageBucket {
  return getMediaRepository();
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/storage/bucket.test.ts lib/media`
Expected: PASS (new + existing media tests).

- [ ] **Step 5: Commit**

```bash
git add lib/storage/bucket.ts lib/storage/bucket.test.ts lib/repositories/media.repository.ts
git commit -m "feat(storage): StorageBucket seam over the content-addressed media cache"
```

---

### Task 3: Server assets repository (`lib/repositories/assets.repository.ts`)

Thin fs-backed JSON repo (`.studio/assets.json`) — the `provider-config.repository` pattern: in-memory cache, `overridePath` test hook, sanitize-on-load, sync writes.

**Files:**
- Create: `lib/repositories/asset-row.ts` (shared row sanitizer for both repos)
- Create: `lib/repositories/assets.repository.ts`
- Test: `lib/repositories/assets.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/repositories/assets.repository.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearAssetsRepository,
  deleteAssetsRepository,
  listAssetsRepository,
  putAssetRepository,
  setAssetsPathForTests,
} from "@/lib/repositories/assets.repository";
import type { Asset } from "@/lib/types";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";

function makeAsset(id: string, over: Partial<Asset> = {}): Asset {
  return {
    id, kind: "image", title: `Asset ${id}`, prompt: "p", url: "",
    variants: [], settings: { ...DEFAULT_IMAGE_SETTINGS },
    createdAt: 0, favorite: false, mode: "Solo Mode (Image)", ...over,
  };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "assets-repo-"));
  setAssetsPathForTests(path.join(tmp, "assets.json"));
});

describe("assets repository", () => {
  it("persists an upsert and reads it back from disk", () => {
    putAssetRepository(makeAsset("a"));
    setAssetsPathForTests(path.join(tmp, "assets.json")); // force reload from disk
    expect(listAssetsRepository().map((a) => a.id)).toEqual(["a"]);
  });

  it("seeds demo rows once on first load of a fresh store", () => {
    const rows = listAssetsRepository();
    expect(rows.some((a) => a.meta?.example === true)).toBe(true);
  });

  it("patches in place and deletes in bulk", () => {
    putAssetRepository(makeAsset("a"));
    putAssetRepository(makeAsset("b"));
    expect(patchAssetRepository("a", { favorite: true })?.favorite).toBe(true);
    expect(deleteAssetsRepository(["a", "missing"])).toBe(1);
    expect(listAssetsRepository().map((a) => a.id)).toEqual(["b"]);
  });

  it("drops malformed rows on load instead of throwing", () => {
    fs.writeFileSync(path.join(tmp, "assets.json"), JSON.stringify([makeAsset("ok"), { id: 42 }, null, "x"]));
    setAssetsPathForTests(path.join(tmp, "assets.json"));
    expect(listAssetsRepository().map((a) => a.id)).toEqual(["ok"]);
  });

  it("clears everything", () => {
    putAssetRepository(makeAsset("a"));
    clearAssetsRepository();
    expect(listAssetsRepository()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/repositories/assets.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `asset-row.ts`** — shared validator used by both repositories:

```ts
// lib/repositories/asset-row.ts
import type { Asset, StoryScene } from "@/lib/types";

/** Minimal shape check for a row coming off disk or the wire. Unknown
 * fields pass through — the app evolves faster than persisted files. */
export function parseAssetRow(raw: unknown): Asset | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (r.kind !== "image" && r.kind !== "video" && r.kind !== "story") return null;
  if (typeof r.title !== "string" || typeof r.prompt !== "string") return null;
  if (typeof r.url !== "string" || !Array.isArray(r.variants)) return null;
  if (!r.settings || typeof r.settings !== "object") return null;
  if (typeof r.createdAt !== "number" || typeof r.favorite !== "boolean") return null;
  if (typeof r.mode !== "string") return null;
  const asset = r as unknown as Asset;
  if (asset.scenes) {
    if (!Array.isArray(asset.scenes)) return null;
    const scenes = asset.scenes.filter(
      (s): s is StoryScene =>
        !!s && typeof s === "object" &&
        typeof (s as StoryScene).id === "string" &&
        typeof (s as StoryScene).prompt === "string",
    );
    if (scenes.length !== asset.scenes.length) return null;
  }
  return asset;
}

export function parseAssetRows(raw: unknown): Asset[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseAssetRow).filter((a): a is Asset => a !== null);
}
```

- [ ] **Step 4: Implement `assets.repository.ts`**

```ts
// lib/repositories/assets.repository.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { Asset } from "@/lib/types";
import { parseAssetRows } from "@/lib/repositories/asset-row";
import { withDemoRows } from "@/lib/demo-content";

/**
 * Server-side History records (`.studio/assets.json`) — thin fs-backed JSON
 * repository in the provider-config style: in-memory cache, sanitize on
 * load, sync writes. Demo rows seed once when the file is first created.
 */
let overridePath: string | null = null;
let cache: Asset[] | null = null;

function resolvePath(): string {
  if (overridePath) return overridePath;
  return path.join(process.cwd(), ".studio", "assets.json");
}

function load(): Asset[] {
  if (cache) return cache;
  const target = resolvePath();
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ target)) {
      cache = withDemoRows([]); // first boot: seed the example strip
    } else {
      cache = parseAssetRows(JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ target, "utf-8")));
    }
  } catch {
    cache = [];
  }
  return cache;
}

function persist(rows: Asset[]): void {
  cache = rows;
  const target = resolvePath();
  const dir = path.dirname(target);
  if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(/*turbopackIgnore: true*/ target, JSON.stringify(rows, null, 2), "utf-8");
}

export function listAssetsRepository(): Asset[] {
  return load();
}

export function putAssetRepository(asset: Asset): Asset {
  persist([asset, ...load().filter((a) => a.id !== asset.id)]);
  return asset;
}

export function patchAssetRepository(id: string, patch: Partial<Asset>): Asset | null {
  let patched: Asset | null = null;
  persist(load().map((a) => (a.id === id ? (patched = { ...a, ...patch }) : a)));
  return patched;
}

export function deleteAssetsRepository(ids: string[]): number {
  const doomed = new Set(ids);
  const rows = load();
  persist(rows.filter((a) => !doomed.has(a.id)));
  return rows.length - doomed.size < 0 ? rows.length : rows.filter((a) => doomed.has(a.id)).length;
}

export function clearAssetsRepository(): void {
  persist([]);
}

export function setAssetsPathForTests(customPath: string | null): void {
  overridePath = customPath;
  cache = null;
}
```

(Note: `deleteAssetsRepository`'s return simplifies to `rows.filter((a) => doomed.has(a.id)).length` — write it that way directly. `patchAssetRepository` uses the assignment-expression style above or an explicit loop — whichever, tests define the contract.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run lib/repositories/assets.repository.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/repositories/asset-row.ts lib/repositories/assets.repository.ts lib/repositories/assets.repository.test.ts
git commit -m "feat: server-side assets repository (.studio/assets.json)"
```

---

### Task 4: Server stories repository (`lib/repositories/stories.repository.ts`)

Same pattern, `.studio/stories.json`, story-kind rows only.

**Files:**
- Create: `lib/repositories/stories.repository.ts`
- Test: `lib/repositories/stories.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/repositories/stories.repository.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  deleteStoriesRepository,
  getStoriesRepository,
  listStoriesRepository,
  putStoriesRepository,
  setStoriesPathForTests,
} from "@/lib/repositories/stories.repository";
import type { Asset } from "@/lib/types";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";

function makeStory(id: string): Asset {
  return {
    id, kind: "story", title: `Story ${id}`, prompt: "s", url: "",
    variants: [], settings: { ...DEFAULT_IMAGE_SETTINGS, kind: "image", count: 1 },
    createdAt: 0, favorite: false, mode: "Story Mode",
    scenes: [{ id: `${id}-sc1`, prompt: "sc", url: null, status: "queued", kind: "image" }],
    meta: { continuity: true, running: false },
  };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stories-repo-"));
  setStoriesPathForTests(path.join(tmp, "stories.json"));
});

describe("stories repository", () => {
  it("persists and reloads story rows with scenes", () => {
    putStoriesRepository(makeStory("s1"));
    setStoriesPathForTests(path.join(tmp, "stories.json"));
    expect(getStoriesRepository("s1")?.scenes?.length).toBe(1);
  });

  it("never seeds demo rows", () => {
    expect(listStoriesRepository()).toEqual([]);
  });

  it("deletes by id", () => {
    putStoriesRepository(makeStory("s1"));
    deleteStoriesRepository(["s1"]);
    expect(getStoriesRepository("s1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/repositories/stories.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — mirror `assets.repository.ts` exactly (path `.studio/stories.json`, no demo seed, plus `getStoriesRepository(id)` lookup). Same exports with `Stories` naming, same `setStoriesPathForTests`.

- [ ] **Step 4: Run tests + commit**

Run: `npx vitest run lib/repositories/stories.repository.test.ts` → PASS, then:

```bash
git add lib/repositories/stories.repository.ts lib/repositories/stories.repository.test.ts
git commit -m "feat: server-side stories repository (.studio/stories.json)"
```

---

### Task 5: Assets service — merge + kind routing (`lib/services/records.service.ts`)

One service mediates both repos so the API surface (and the client) sees a single list; writes route by `kind === "story"`.

**Files:**
- Create: `lib/services/records.service.ts`
- Test: `lib/services/records.service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/services/records.service.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  importLegacyRecords,
  listRecords,
  putRecord,
  removeRecords,
} from "@/lib/services/records.service";
import {
  setAssetsPathForTests,
} from "@/lib/repositories/assets.repository";
import { setStoriesPathForTests } from "@/lib/repositories/stories.repository";
import type { Asset } from "@/lib/types";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";

function row(id: string, kind: Asset["kind"]): Asset {
  return {
    id, kind, title: id, prompt: "p", url: "", variants: [],
    settings: { ...DEFAULT_IMAGE_SETTINGS, kind: kind === "video" ? "video" : "image", count: 1 },
    createdAt: 0, favorite: false,
    mode: kind === "story" ? "Story Mode" : "Solo Mode (Image)",
    ...(kind === "story" ? { scenes: [] } : {}),
  };
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "records-"));
  setAssetsPathForTests(path.join(tmp, "assets.json"));
  setStoriesPathForTests(path.join(tmp, "stories.json"));
});

describe("records service", () => {
  it("lists both stores merged, newest first", () => {
    putRecord(row("old", "image"));
    putRecord({ ...row("new", "story"), createdAt: 5 });
    expect(listRecords().map((a) => a.id)).toEqual(["new", "old"]);
  });

  it("routes deletes across both stores", () => {
    putRecord(row("img", "image"));
    putRecord(row("story", "story"));
    expect(removeRecords(["img", "story"])).toBe(2);
    expect(listRecords()).toHaveLength(6); // demo rows only
  });

  it("imports legacy rows, skipping demo rows and known ids", () => {
    putRecord(row("have", "image"));
    const { imported, skipped } = importLegacyRecords([
      row("fresh", "video"),
      row("have", "image"),
      row("demo_4821", "image"),
    ]);
    expect(imported).toBe(1);
    expect(skipped).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/services/records.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/services/records.service.ts
import type { Asset } from "@/lib/types";
import {
  clearAssetsRepository,
  deleteAssetsRepository,
  listAssetsRepository,
  patchAssetsRepository,
  putAssetRepository,
} from "@/lib/repositories/assets.repository";
import {
  deleteStoriesRepository,
  getStoriesRepository,
  listStoriesRepository,
  patchStoriesRepository,
  putStoriesRepository,
} from "@/lib/repositories/stories.repository";
import { parseAssetRow } from "@/lib/repositories/asset-row";

/**
 * Single read model over the two server record stores. History wants one
 * merged list; writes route to assets.json or stories.json by row kind so
 * story scenes stay isolated from the (bulkier) History file.
 */

function isStory(asset: Asset): boolean {
  return asset.kind === "story";
}

export function listRecords(): Asset[] {
  return [...listAssetsRepository(), ...listStoriesRepository()].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
}

export function getRecord(id: string): Asset | undefined {
  return listAssetsRepository().find((a) => a.id === id) ?? getStoriesRepository(id);
}

export function putRecord(asset: Asset): Asset {
  return isStory(asset) ? putStoriesRepository(asset) : putAssetRepository(asset);
}

export function patchRecord(id: string, patch: Partial<Asset>): Asset | null {
  return patchAssetsRepository(id, patch) ?? patchStoriesRepository(id, patch);
}

export function removeRecords(ids: string[]): number {
  return deleteAssetsRepository(ids) + deleteStoriesRepository(ids);
}

export function clearAllRecords(): void {
  clearAssetsRepository();
}

export function importLegacyRecords(rows: unknown[]): { imported: number; skipped: number } {
  const known = new Set(listRecords().map((a) => a.id));
  let imported = 0;
  let skipped = 0;
  for (const raw of rows) {
    const asset = parseAssetRow(raw);
    if (!asset || known.has(asset.id)) {
      skipped += 1;
      continue;
    }
    putRecord(asset);
    known.add(asset.id);
    imported += 1;
  }
  return { imported, skipped };
}
```

- [ ] **Step 4: Run tests + commit**

Run: `npx vitest run lib/services/records.service.test.ts` → PASS, then:

```bash
git add lib/services/records.service.ts lib/services/records.service.test.ts
git commit -m "feat: records service merging assets + stories behind one read model"
```

---

### Task 6: `/api/assets` + `/api/assets/import` routes

Thin controllers over the service (pending-renders route style: `runtime = "nodejs"`, `no-store`, JSON errors).

**Files:**
- Create: `app/api/assets/route.ts`
- Create: `app/api/assets/import/route.ts`

- [ ] **Step 1: Implement the routes**

```ts
// app/api/assets/route.ts
import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import {
  clearAllRecords,
  listRecords,
  patchRecord,
  putRecord,
  removeRecords,
} from "@/lib/services/records.service";
import { parseAssetRow } from "@/lib/repositories/asset-row";

export const runtime = "nodejs";

const log = logger.child({ route: "api/assets" });

/** The merged History read model (assets + stories). Seeds demo rows once. */
export async function GET() {
  return NextResponse.json({ assets: listRecords() }, {
    headers: { "cache-control": "no-store" },
  });
}

/** Create or replace one row. */
export async function POST(request: Request) {
  const asset = parseAssetRow(await safeJson(request));
  if (!asset) {
    return NextResponse.json({ error: "That asset record is not valid.", retryable: false }, { status: 400 });
  }
  return NextResponse.json({ asset: putRecord(asset) }, { headers: { "cache-control": "no-store" } });
}

/** Patch one row (?id=). */
export async function PATCH(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  const body = (await safeJson(request)) as Record<string, unknown> | null;
  if (!id || !body || typeof body !== "object") {
    return NextResponse.json({ error: "Missing id or patch.", retryable: false }, { status: 400 });
  }
  const patched = patchRecord(id, body as Record<string, never>);
  if (!patched) {
    return NextResponse.json({ error: "Asset not found.", retryable: false }, { status: 404 });
  }
  return NextResponse.json({ asset: patched }, { headers: { "cache-control": "no-store" } });
}

/** Delete ?ids=a,b or ?all=1 (Clean library clears History assets, not stories). */
export async function DELETE(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get("all") === "1") {
    clearAllRecords();
    return new NextResponse(null, { status: 204 });
  }
  const ids = (params.get("ids") ?? "").split(",").filter(Boolean);
  if (!ids.length) {
    return NextResponse.json({ error: "Missing ids.", retryable: false }, { status: 400 });
  }
  return NextResponse.json({ removed: removeRecords(ids) }, { headers: { "cache-control": "no-store" } });
}

async function safeJson(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { return null; }
}
```

```ts
// app/api/assets/import/route.ts
import { NextResponse } from "next/server";
import { importLegacyRecords } from "@/lib/services/records.service";

export const runtime = "nodejs";

/** One-time legacy import from a browser's localStorage assets.v2. */
export async function POST(request: Request) {
  let rows: unknown;
  try { rows = (await request.json() as { rows?: unknown })?.rows; } catch { rows = null; }
  if (!Array.isArray(rows)) {
    return NextResponse.json({ error: "Expected { rows: [...] }.", retryable: false }, { status: 400 });
  }
  const result = importLegacyRecords(rows);
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
```

(Adjust `patchRecord`'s typing as the compiler demands — the patch is `Partial<Asset>` from a JSON body; validate loosely, the sanitizer on next load is the backstop.)

- [ ] **Step 2: Typecheck + tests + commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean.

```bash
git add app/api/assets
git commit -m "feat: /api/assets CRUD + one-time legacy import route"
```

---

### Task 7: `/api/stories` route

**Files:**
- Create: `app/api/stories/route.ts`

- [ ] **Step 1: Implement**

```ts
// app/api/stories/route.ts
import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import { listStoriesRepository, putStoriesRepository } from "@/lib/repositories/stories.repository";
import { getRecord, patchRecord } from "@/lib/services/records.service";
import { parseAssetRow } from "@/lib/repositories/asset-row";

export const runtime = "nodejs";

const log = logger.child({ route: "api/stories" });

/** Story rows only (?id= returns one, scenes included). */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (id) {
    const story = getRecord(id);
    if (!story || story.kind !== "story") {
      return NextResponse.json({ error: "Story not found.", retryable: false }, { status: 404 });
    }
    return NextResponse.json({ story }, { headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json({ stories: listStoriesRepository() }, { headers: { "cache-control": "no-store" } });
}

/** Create or replace a story row. */
export async function POST(request: Request) {
  const story = parseAssetRow(await safeJson(request));
  if (!story || story.kind !== "story") {
    return NextResponse.json({ error: "That story record is not valid.", retryable: false }, { status: 400 });
  }
  return NextResponse.json({ story: putStoriesRepository(story) }, { headers: { "cache-control": "no-store" } });
}

/** Patch one story (?id=) — scene edits, reorder, run-state flags. */
export async function PATCH(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  const body = await safeJson(request);
  if (!id || !body || typeof body !== "object") {
    return NextResponse.json({ error: "Missing id or patch.", retryable: false }, { status: 400 });
  }
  const patched = patchRecord(id, body as Partial<Asset>);
  if (!patched) {
    return NextResponse.json({ error: "Story not found.", retryable: false }, { status: 404 });
  }
  return NextResponse.json({ story: patched }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id.", retryable: false }, { status: 400 });
  }
  // (delegate to records service removeRecords([id]) — stories only here)
  return new NextResponse(null, { status: removeStory(id) ? 204 : 404 });
}

async function safeJson(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { return null; }
}
```

(Use `removeRecords([id])` from the service instead of a local helper; `log` is used for the delete event — keep the same logging style as `/api/renders/pending`.)

- [ ] **Step 2: Typecheck + tests + commit**

Run: `npx tsc --noEmit && npx vitest run` → clean.

```bash
git add app/api/stories
git commit -m "feat: /api/stories CRUD route"
```

---

### Task 8: Client store re-plumb (`lib/store.ts` keeps its API)

The heart of Phase A. `lib/store.ts`'s exports stay identical; internals become: in-memory cache (same as today) + async hydration from `/api/assets` + optimistic mutation mirrors to the server. A transport seam keeps node-env tests sync and window-free.

**Files:**
- Modify: `lib/store.ts`
- Create: `lib/store-transport.ts` (browser fetch transport + test hook)
- Modify: `lib/store.test.ts` (add transport tests)
- Modify: `components/StoreBootstrap.tsx` (legacy import bridge)

- [ ] **Step 1: Write failing transport tests**

```ts
// lib/store-transport.test.ts
import { afterEach, describe, expect, it } from "vitest";
import {
  browserStoreTransport,
  setStoreTransportForTests,
  storeTransport,
} from "@/lib/store-transport";
import type { Asset } from "@/lib/types";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";

const asset: Asset = {
  id: "t1", kind: "image", title: "T", prompt: "p", url: "", variants: [],
  settings: { ...DEFAULT_IMAGE_SETTINGS }, createdAt: 0, favorite: false, mode: "Solo Mode (Image)",
};

afterEach(() => setStoreTransportForTests(null));

describe("store transport", () => {
  it("mirrors mutators to the records API", async () => {
    const calls: string[] = [];
    setStoreTransportForTests({
      list: async () => { calls.push("list"); return []; },
      create: async () => { calls.push("create"); },
      patch: async () => { calls.push("patch"); },
      remove: async () => { calls.push("remove"); },
      clear: async () => { calls.push("clear"); },
      importLegacy: async () => { calls.push("import"); },
    });
    const transport = storeTransport();
    await transport.create(asset);
    await transport.patch("t1", { favorite: true });
    await transport.remove(["t1"]);
    await transport.clear();
    expect(calls).toEqual(["create", "patch", "remove", "clear"]);
  });

  it("has no transport outside the browser by default (node tests stay sync)", () => {
    expect(storeTransport()).toBeNull();
    expect(browserStoreTransport).toBeTypeOf("function");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run lib/store-transport.test.ts` → module not found.

- [ ] **Step 3: Implement `lib/store-transport.ts`**

```ts
// lib/store-transport.ts
import type { Asset } from "@/lib/types";

/**
 * How the client asset store reaches the server records. Injectable so
 * node-env tests stay synchronous; the browser transport is active only
 * when a real fetch exists.
 */
export interface StoreTransport {
  list(): Promise<Asset[]>;
  create(asset: Asset): Promise<void>;
  patch(id: string, patch: Partial<Asset>): Promise<void>;
  remove(ids: string[]): Promise<void>;
  clear(): Promise<void>;
  importLegacy(rows: Asset[]): Promise<void>;
}

let override: StoreTransport | null = null;

export function setStoreTransportForTests(transport: StoreTransport | null): void {
  override = transport;
}

export function storeTransport(): StoreTransport | null {
  if (override) return override;
  if (typeof window === "undefined" || typeof fetch === "undefined") return null;
  return browserStoreTransport();
}

export function browserStoreTransport(): StoreTransport {
  return {
    async list() {
      const res = await fetch("/api/assets", { cache: "no-store" });
      if (!res.ok) throw new Error(`assets list failed: ${res.status}`);
      const data = (await res.json()) as { assets?: Asset[] };
      return data.assets ?? [];
    },
    async create(asset) {
      await fetch("/api/assets", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(asset),
      });
    },
    async patch(id, patch) {
      await fetch(`/api/assets?id=${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
    },
    async remove(ids) {
      await fetch(`/api/assets?ids=${ids.map(encodeURIComponent).join(",")}`, { method: "DELETE" });
    },
    async clear() {
      await fetch("/api/assets?all=1", { method: "DELETE" });
    },
    async importLegacy(rows) {
      await fetch("/api/assets/import", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows }),
      });
    },
  };
}
```

- [ ] **Step 4: Re-plumb `lib/store.ts`.** Replace the localStorage `persist`/`read` with:

```ts
const LEGACY_STORAGE_KEY = "perabyte.assets.v2";
const MIGRATED_KEY = "perabyte.assets.migrated.v3";

let cache: Asset[] | null = null;
let hydrated = false;

function emit() { listeners.forEach((l) => l()); }

/** Optimistic local write + fire-and-forget server mirror. Server failure
 * never breaks the session (same resilience contract as localStorage). */
function persist(next: Asset[], sync?: (t: StoreTransport) => Promise<void>) {
  cache = next;
  const transport = storeTransport();
  if (transport && sync) void sync(transport).catch(() => { /* server unreachable — memory still works */ });
  emit();
}

function read(): Asset[] {
  return cache ?? [];
}

/** First-use hydration: import legacy localStorage rows once, then adopt the
 * server list as the cache. Runs once per page load; failures leave the
 * session working in memory. */
export async function ensureStoreHydrated(): Promise<void> {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  const transport = storeTransport();
  if (!transport) return;
  try {
    const legacy = readLegacyRows();
    if (legacy.length) {
      await transport.importLegacy(legacy);
      try { window.localStorage.setItem(MIGRATED_KEY, "1"); } catch { /* ignore */ }
    }
    cache = await transport.list();
  } catch {
    cache = cache ?? []; // offline: whatever we have is still usable
  }
  emit();
}

function readLegacyRows(): Asset[] {
  try {
    if (window.localStorage.getItem(MIGRATED_KEY)) return [];
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? parseAssetRows(JSON.parse(raw)).filter((a) => !(a.meta?.example === true)) : [];
  } catch {
    return [];
  }
}
```

Rewrite each mutator to call `persist(next, (t) => t.xxx(...))`:

```ts
export function addAsset(asset: Asset): Asset {
  persist([asset, ...read().filter((a) => a.id !== asset.id)], (t) => t.create(asset));
  return asset;
}

export function updateAsset(id: string, patch: Partial<Asset>): void {
  persist(read().map((a) => (a.id === id ? { ...a, ...patch } : a)), (t) => t.patch(id, patch));
}

export function updateStoryScenes(storyId: string, updater: (scenes: StoryScene[]) => StoryScene[]): void {
  const next = read().map((asset) =>
    asset.id === storyId && asset.scenes ? { ...asset, scenes: updater(asset.scenes) } : asset,
  );
  const story = next.find((a) => a.id === storyId);
  persist(next, (t) => (story ? t.patch(storyId, { scenes: story.scenes }) : Promise.resolve()));
}

export function toggleFavorite(id: string): void {
  const target = read().find((a) => a.id === id);
  const next = read().map((a) => (a.id === id ? { ...a, favorite: !a.favorite } : a));
  persist(next, (t) => t.patch(id, { favorite: !target?.favorite }));
}

export function removeAssets(ids: string[]): void {
  const doomed = new Set(ids);
  persist(read().filter((a) => !doomed.has(a.id)), (t) => t.remove(ids));
}

export function clearAssets(): void {
  persist([], (t) => t.clear());
}
```

Change `useAssets` to hydrate:

```ts
export function useAssets(): { assets: Asset[]; ready: boolean } {
  const assets = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const ready = useHydrated();
  useEffect(() => { void ensureStoreHydrated(); }, []);
  return { assets, ready };
}
```

Delete the old `STORAGE_KEY`/`SEED_KEY` localStorage persistence (keep only the legacy read). `getSnapshot` returns `read()`.

- [ ] **Step 5: Update `components/StoreBootstrap.tsx`** — drop the demo seed (server seeds), keep the component as the hydration trigger:

```tsx
"use client";

import { useEffect } from "react";
import { ensureStoreHydrated } from "@/lib/store";

/** Hydrates the server-backed asset store once per page load (and, on the
 * first run after upgrade, imports this browser's legacy localStorage rows). */
export function StoreBootstrap() {
  useEffect(() => { void ensureStoreHydrated(); }, []);
  return null;
}
```

(Keep it mounted wherever it is today — `app/layout.tsx`.)

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS — `store.test.ts` semantics unchanged (node env → no transport → pure in-memory).

- [ ] **Step 7: Commit**

```bash
git add lib/store.ts lib/store-transport.ts lib/store-transport.test.ts lib/store.test.ts components/StoreBootstrap.tsx
git commit -m "feat: server-backed asset store with one-time legacy import"
```

---

### Task 9: Story editor addressing + resume wiring (`app/story/page.tsx`, History, results)

- [ ] **Step 1: Gate story lookup on store hydration.** In `app/story/page.tsx`, the mount effect currently reads `?id=` immediately. Keep that, but let the story lookup wait for `ready`:

```tsx
const { assets, ready } = useAssets();
const story = ready && storyId ? assets.find((a) => a.id === storyId) : undefined;
```

(Confirm the existing `useAssets()` destructure on the page and extend it; scenes derive from `story` as today.)

- [ ] **Step 2: Resume mid-run stories on open.** After the story resolves, replay the runner's boot contract:

```tsx
const resumedRef = useRef<string | null>(null);
useEffect(() => {
  if (!ready || !story || resumedRef.current === story.id) return;
  resumedRef.current = story.id;
  if (story.meta?.running === true) {
    appRunner.rehydrate([story.id]);
  }
}, [ready, story]);
```

`rehydrate` flips orphaned `generating` scenes back to `queued` and auto-starts only when `meta.running` was true — exactly the tab-died-mid-run case.

- [ ] **Step 3: Editor entry points.**
  - `app/history/page.tsx`: in the row actions menu, after "Open in Results", add for story rows:

```tsx
{asset.kind === "story" && (
  <MenuItem icon="film" label="Open in editor" href={`/story?id=${asset.id}`} onDone={() => setOpenMenu(null)} />
)}
```

  (Use an icon that exists in `components/Icon`; `film`/`edit` — check the Icon set during implementation.)
  - `app/results/page.tsx`: in the story block next to "Play story", add:

```tsx
<Link
  href={`/story?id=${asset.id}`}
  className="inline-flex h-11 items-center gap-2 rounded-[12px] border border-border-strong px-4 text-sm font-semibold text-ink"
>
  Continue in editor
</Link>
```

- [ ] **Step 4: Typecheck + full tests + commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean.

```bash
git add app/story/page.tsx app/history/page.tsx app/results/page.tsx
git commit -m "feat: addressable story editor with mid-run resume + editor entry points"
```

---

### Task 10: Build + live smoke verification

- [ ] **Step 1: Production build**

Run: `npm run build`
Expected: compiles clean (watch for client/server boundary violations in the new modules).

- [ ] **Step 2: Live smoke (dev server on :3100, worktree env)**

```bash
npm run dev &   # or the session's standard dev-server flow
curl -s localhost:3100/api/assets | head -c 300
```

Expected: JSON `{"assets":[…]}` with the 6 demo rows on first call; `.studio/assets.json` created in the worktree.

Manual flow (browser):
1. History shows the demo rows from the server.
2. Generate a solo image → row appears in History; `.studio/assets.json` gains the row.
3. Favorite + delete → server file reflects both.
4. Legacy import: seed `perabyte.assets.v2` in a fresh profile → reload → rows appear, `perabyte.assets.migrated.v3` set, server file contains them.
5. Story: create 2-scene story, Generate → scenes render; navigate to Settings mid-run and back → story page still shows the run (client runner, tab open).
6. Close the tab mid-run, reopen `localhost:3100/story?id=<id>` → orphaned scenes reset to queued and the run resumes (rehydrate).
7. Story survives browser switch: same URL in a second browser → scenes/prompts/order intact (server truth).

- [ ] **Step 3: Merge**

```bash
cd /Users/abid/Projects/perabyte-studio
git merge feat/server-records --no-ff -m "Merge branch 'feat/server-records' — server-side records (Phase A)"
```

---

## Self-review notes

- **Spec coverage:** Phase A items 1–5 of the spec map to Tasks 2, 3/4, 6/7, 8/9, and 9-step-2 respectively. Phase B/C are separate plans.
- **Type consistency:** `Asset`/`StoryScene` come from `lib/types` unchanged; server repos persist the same shape the client already produces. `patchAssetsRepository`/`patchStoriesRepository` are referenced by the service — both defined in their tasks.
- **Known risks:** (1) `store.test.ts` must stay sync in node — the transport-null default guarantees it; (2) rapid mutations race the fire-and-forget mirror — acceptable single-user, last-write-wins; (3) `deleteAssetsRepository` counting — implement as the filter-length form noted in Task 3.
